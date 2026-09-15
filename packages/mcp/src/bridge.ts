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
import type { ClientFrame, PeerRpcResultFrame, RpcMethod, RpcRequestFrame } from './protocol.js';

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

export function startBridge(port: number, host = '127.0.0.1'): Bridge {
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

  wss.on('connection', (ws) => {
    sockets.add(ws);
    let role: 'extension' | 'peer' | 'unknown' = 'unknown';

    ws.on('message', (data) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(String(data)) as ClientFrame;
      } catch {
        log('dropping non-JSON frame');
        return;
      }
      if (frame.type === 'hello') {
        role = frame.role;
        if (frame.role === 'extension') {
          log(`hello from extension v${frame.version}`);
          active = ws;
        } else {
          log(`hello from peer v${frame.version}`);
        }
        return;
      }
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
      const hint = listening
        ? 'No Chrome extension connected. Open the extension (its MCP tab shows the connection status) and make sure the configured port matches.'
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
