/**
 * Local HTTP proxy — the script-driven gateway entry.
 *
 * A skill's script (e.g. Python) points its baseURL at
 * http://127.0.0.1:<port><sandboxPrefix> instead of the real API. We accept that
 * request here and TUNNEL it to the extension as a `proxy_rule` RPC over the same WS
 * bridge the MCP tools use. The extension owns the rules (which prefix maps to which
 * real target) and the cookies, so this server is a dumb pipe: it knows nothing about
 * routing, matching, or credentials.
 *
 * Loopback-only (127.0.0.1) is the trust boundary — same as the WS bridge. There is
 * no per-call prompt on this path; authorization is that the user created and enabled
 * a matching proxy rule in the extension.
 *
 * Responses:
 *   - matched rule    → the target's sanitized status/headers/body (Set-Cookie stripped)
 *   - no enabled rule → 404 (matched:false)
 *   - extension down  → 503 (bridge.call rejects)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Bridge } from './bridge.js';
import type { ProxyRuleRequest, RpcResults } from './protocol.js';

/** Hop-by-hop / connection headers we must not forward to the target. */
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // Content-length is recomputed by fetch from the body; forwarding a stale one breaks.
  'content-length',
  // Credentials must come from the extension's cookie injection, never the script.
  'cookie',
  'authorization',
]);

export interface ProxyHttpServer {
  /** Resolves once listening; rejects if the port can't be bound. */
  whenReady(): Promise<void>;
  close(): Promise<void>;
  /** Is the HTTP proxy currently bound and accepting connections? */
  isListening(): boolean;
  /** The port the proxy is currently bound to (or last attempted). */
  currentPort(): number;
  /**
   * Rebind the proxy to a new port at runtime (close the old listener, listen on
   * the new one). Resolves with the port on success; rejects (and keeps the old
   * state) if the new port can't be bound. Used by the `rebind_proxy` tool so an
   * agent can recover from a port conflict without restarting the process.
   */
  rebind(port: number): Promise<number>;
}

/**
 * Max accepted local request body. An unbounded local POST would otherwise buffer
 * without limit and OOM the process; over the cap we abort and the caller replies 413.
 */
const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25MB

/** Marker error so the caller can map an oversized body to HTTP 413. */
class BodyTooLargeError extends Error {
  constructor() {
    super('request body too large');
    this.name = 'BodyTooLargeError';
  }
}

/** Read a request body fully into a string (utf-8). Empty for bodyless methods. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Collect forwardable headers (drop hop-by-hop / credential headers). */
function collectHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

export function startProxyHttp(bridge: Bridge, port: number, host = '127.0.0.1'): ProxyHttpServer {
  const log = (...a: unknown[]) => console.error('[proxy-http]', ...a);

  // Current bound port (updated on rebind) and live listening state, so callers
  // (e.g. the `health` tool) can report accurate status.
  let currentPort = port;
  let listening = false;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const method = (req.method ?? 'GET').toUpperCase();
    const rawPath = req.url ?? '/';
    try {
      const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
      const proxyReq: ProxyRuleRequest = {
        method,
        rawPath,
        headers: collectHeaders(req),
        body,
      };
      const result = (await bridge.call(
        'proxy_rule',
        { req: proxyReq },
        130000,
      )) as RpcResults['proxy_rule'];

      if (!result.matched) {
        writeText(res, result.status || 404, result.error || 'No matching proxy rule');
        return;
      }
      // Forward the sanitized response verbatim.
      const headers: Record<string, string> = { ...result.headers };
      // Body is a string; let Node set content-length. Drop any content-encoding the
      // target set — the body has already been decoded to text by the extension.
      delete headers['content-encoding'];
      delete headers['Content-Encoding'];
      delete headers['transfer-encoding'];
      delete headers['Transfer-Encoding'];
      res.writeHead(result.status || 200, headers);
      res.end(result.body ?? '');
    } catch (err) {
      // An oversized local body is rejected before we ever hit the bridge → 413.
      if (err instanceof BodyTooLargeError) {
        log('proxy error', err.message);
        writeText(res, 413, `Payload too large: max ${MAX_BODY_BYTES} bytes`);
        return;
      }
      // bridge.call rejects when no extension is connected or on RPC timeout.
      const msg = err instanceof Error ? err.message : String(err);
      log('proxy error', msg);
      writeText(res, 503, `Sandbox proxy unavailable: ${msg}`);
    }
  }

  function writeText(res: ServerResponse, status: number, text: string) {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(text);
  }

  // Bind (or re-bind) `server` to `p`. Resolves once listening; rejects on bind
  // failure (e.g. EADDRINUSE) WITHOUT flipping `listening` to true, so a failed
  // rebind leaves the previous state observable via isListening().
  function listenOn(p: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onListening = () => {
        listening = true;
        currentPort = p;
        server.removeListener('error', onError);
        log(`listening on http://${host}:${p}`);
        resolve();
      };
      const onError = (err: Error) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      server.once('listening', onListening);
      server.once('error', onError);
      server.listen(p, host);
    });
  }

  const ready = listenOn(port);
  ready.catch(() => {});
  // Non-fatal runtime errors after the initial bind (e.g. a transient socket error).
  server.on('error', (err) => log('server error', err));

  async function rebind(p: number): Promise<number> {
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new Error(`Invalid proxy port: ${p} (must be an integer 1-65535).`);
    }
    if (p === currentPort && listening) return currentPort;
    // Close the current listener (if any) before re-listening on the new port.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    listening = false;
    await listenOn(p); // rejects (keeping listening=false) if the new port is taken
    return currentPort;
  }

  return {
    whenReady: () => ready,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    isListening: () => listening,
    currentPort: () => currentPort,
    rebind,
  };
}
