/**
 * Local WebSocket bridge server.
 *
 * MV3 extensions can't listen on a port, so WE host the server on
 * ws://127.0.0.1:<port> (loopback only — the trust boundary) and the extension
 * dials in. The MCP tool layer calls `call(method, params)`; we forward it as an
 * `rpc` frame to the connected extension and resolve when the matching
 * `rpc-result` (by id) comes back.
 *
 * At most one extension is expected; if several connect, the most recent wins.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { newNonce, verifyAuthProof, welcomeProof } from './auth.js';
import type {
  AuthFrame,
  ClientFrame,
  HelloFrame,
  PeerRpcResultFrame,
  RpcMethod,
  RpcRequestFrame,
} from './protocol.js';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface Bridge {
  /** Is an extension currently connected? */
  isConnected(): boolean;
  /**
   * Resolves once the WS server is listening; rejects if the port can't be bound
   * (e.g. EADDRINUSE — another server instance is already running). A rejected
   * bridge is useless, so callers should treat this as fatal.
   */
  whenReady(): Promise<void>;
  /** Invoke an RPC on the connected extension; rejects if none or on timeout. */
  call(method: RpcMethod, params: unknown, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

/** Monotonic id generator for correlating requests with results. */
function makeIdGen() {
  let n = 0;
  return () => `rpc-${++n}`;
}

/**
 * @param token Shared handshake secret (the MANTA_TOKEN env the user's MCP
 *   config injects). Clients prove knowledge of it during the handshake (see
 *   auth.ts) — the token itself never crosses the wire. `undefined` (env not
 *   set) means every client is rejected; `call()` then explains the fix.
 */
export function startBridge(port: number, token: string | undefined, host = '127.0.0.1'): Bridge {
  const wss = new WebSocketServer({ port, host });
  const pending = new Map<string, Pending>();
  const nextId = makeIdGen();
  let active: WebSocket | null = null;
  let listening = false;

  // Log to stderr — stdout is reserved for the MCP stdio transport.
  const log = (...a: unknown[]) => console.error('[bridge]', ...a);

  // Settle exactly once: listening → resolve, first error before listening →
  // reject (fatal, e.g. EADDRINUSE). Errors after listening are non-fatal.
  const ready = new Promise<void>((resolve, reject) => {
    wss.once('listening', () => {
      listening = true;
      log(`listening on ws://${host}:${port}`);
      resolve();
    });
    wss.once('error', (err) => {
      if (!listening) reject(err);
    });
  });
  // Avoid an unhandled-rejection crash if no one awaits whenReady() promptly.
  ready.catch(() => {});

  wss.on('error', (err) => log('server error', err));

  // Track every live socket so close() can proactively drop them. Otherwise
  // wss.close() waits for all clients to disconnect on their own and never
  // resolves while a peer/extension is still attached.
  const sockets = new Set<WebSocket>();

  wss.on('connection', (ws, req: IncomingMessage) => {
    // Web-page guard (defense in depth behind the token handshake): browsers
    // attach an Origin to cross-origin WebSockets, so a page dialing
    // ws://127.0.0.1 from the open web announces itself. Our real clients — the
    // extension's service worker and node's `ws` — send either no Origin or a
    // chrome-extension:// one (dev builds have their own id, so any extension
    // origin passes; the token handshake still gates them).
    const origin = req.headers.origin;
    if (origin && !origin.startsWith('chrome-extension://')) {
      log(`rejecting web-originated client (Origin: ${origin})`);
      ws.terminate();
      return;
    }

    sockets.add(ws);
    let role: 'extension' | 'peer' | 'unknown' = 'unknown';
    // Handshake stages: awaiting hello → awaiting the auth challenge answer →
    // authenticated. Only 'authed' sockets may speak the business frames below.
    let stage: 'hello' | 'auth' | 'authed' = 'hello';
    let serverNonce = '';
    const stageTimer = setTimeout(() => {
      if (stage !== 'authed') {
        log('handshake timed out — dropping client');
        ws.terminate();
      }
    }, 10_000);
    ws.on('close', () => clearTimeout(stageTimer));

    ws.on('message', (data) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(String(data)) as ClientFrame;
      } catch {
        log('dropping non-JSON frame');
        return;
      }

      // ── pre-auth: challenge-response, token never on the wire (see auth.ts) ──
      if (stage !== 'authed') {
        if (frame.type === 'hello' && stage === 'hello') {
          if (!token) {
            log(
              'rejecting client: no MANTA_TOKEN configured — re-copy the install prompt from the extension (Action tab) and update the MCP config env',
            );
            ws.terminate();
            return;
          }
          const hello = frame as HelloFrame;
          // Remember the declared role now; it only takes EFFECT after the
          // auth challenge below succeeds.
          role = hello.role;
          if (typeof hello.nonce !== 'string' || hello.nonce.length === 0) {
            log('hello without nonce — dropping client');
            ws.terminate();
            return;
          }
          serverNonce = newNonce();
          stage = 'auth';
          ws.send(
            JSON.stringify({
              type: 'welcome',
              proof: welcomeProof(token, hello.nonce),
              nonce: serverNonce,
            }),
          );
          return;
        }
        if (frame.type === 'auth' && stage === 'auth') {
          const auth = frame as AuthFrame;
          // token is guaranteed non-undefined here: the hello branch rejects
          // clients before the stage can advance when it isn't configured.
          if (token && verifyAuthProof(token, serverNonce, auth.proof)) {
            clearTimeout(stageTimer);
            stage = 'authed';
            if (role === 'extension') {
              log('extension authenticated');
              active = ws;
            } else {
              log('peer authenticated');
            }
            return;
          }
          log('client failed the auth challenge — token mismatch (re-copy the install prompt)');
          ws.terminate();
          return;
        }
        // Any other frame before/at the wrong stage: the peer isn't playing our
        // protocol — drop it instead of processing untrusted input.
        log(`dropping unexpected "${(frame as { type: string }).type}" frame before auth`);
        ws.terminate();
        return;
      }

      // ── authenticated business frames ──
      if (frame.type === 'rpc-result') {
        const p = pending.get(frame.id);
        if (!p) return;
        pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.ok) p.resolve(frame.result);
        else p.reject(new Error(frame.error));
        return;
      }

      // Peer → owner: run this RPC against the extension and ship the result back.
      // Use a generous timeout here so the PEER's own per-call timeout stays the
      // authority — otherwise long calls (proxy_fetch/proxy_sse use 130s) would be
      // cut short by this hop's default.
      if (frame.type === 'peer-rpc') {
        call(frame.method, frame.params, 140000)
          .then((result) => {
            const reply: PeerRpcResultFrame = {
              type: 'peer-rpc-result',
              id: frame.id,
              ok: true,
              result,
            };
            ws.send(JSON.stringify(reply));
          })
          .catch((err: unknown) => {
            const reply: PeerRpcResultFrame = {
              type: 'peer-rpc-result',
              id: frame.id,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
            ws.send(JSON.stringify(reply));
          });
        return;
      }
    });

    ws.on('close', () => {
      sockets.delete(ws);
      if (role === 'extension') {
        log('extension disconnected');
        if (active === ws) active = null;
      } else if (role === 'peer') {
        log('peer disconnected');
      }
    });
    ws.on('error', (err) => log('socket error', err));
  });

  function call(method: RpcMethod, params: unknown, timeoutMs = 10000): Promise<unknown> {
    if (!active || active.readyState !== active.OPEN) {
      const hint = !token
        ? 'MCP bridge has no MANTA_TOKEN configured — re-copy the install prompt from the extension (Action tab) and update your MCP config env.'
        : listening
          ? 'No authenticated Chrome extension connected. Confirm Chrome is running with the extension and the port matches; if the extension shows "auth failed", re-copy the install prompt and update the MCP config env.'
          : `MCP bridge not listening on port ${port} (failed to bind — is another instance running?).`;
      return Promise.reject(new Error(hint));
    }
    const id = nextId();
    const frame: RpcRequestFrame = { type: 'rpc', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      active!.send(JSON.stringify(frame), (err) => {
        if (err) {
          pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  function close(): Promise<void> {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error('bridge closing'));
    }
    pending.clear();
    // Proactively drop live clients so peers/extension see the disconnect (and
    // re-elect) and wss.close() can actually settle.
    for (const ws of sockets) {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }
    sockets.clear();
    return new Promise((resolve) => wss.close(() => resolve()));
  }

  return {
    isConnected: () => !!active && active.readyState === active.OPEN,
    whenReady: () => ready,
    call,
    close,
  };
}
