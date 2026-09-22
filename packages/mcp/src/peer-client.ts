/**
 * Peer client — the non-owner side of single-instance election.
 *
 * Only ONE MCP server process can bind the WS bridge port and talk to the Chrome
 * extension directly (the "owner"). When a second process starts (e.g. a second
 * agent session via `npx`), it loses the port race and becomes a "peer": instead
 * of talking to the extension, it dials the owner's WS bridge as a CLIENT and
 * forwards every agent tool call to the owner as a `peer-rpc` frame, awaiting the
 * matching `peer-rpc-result` (correlated by id).
 *
 * This mirrors the shape of Bridge.call() so the MCP tool layer in index.ts can
 * use an owner bridge or a peer client interchangeably.
 *
 * If the owner goes away (its process exits), the socket closes and we invoke
 * `onOwnerLost` so index.ts can re-run the election (try to become the new owner).
 */
import { WebSocket } from 'ws';
import { authProof, newNonce, verifyWelcomeProof } from './auth.js';
import type {
  AuthFrame,
  HelloFrame,
  PeerRpcRequestFrame,
  PeerServerFrame,
  RpcMethod,
} from './protocol.js';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface PeerClient {
  /** Resolves once the handshake with the owner completed; rejects on failure. */
  whenReady(): Promise<void>;
  /** Forward an RPC to the owner (which runs it against the extension). */
  call(method: RpcMethod, params: unknown, timeoutMs?: number): Promise<unknown>;
  /** Is the owner socket currently open? */
  isConnected(): boolean;
  close(): Promise<void>;
}

/** Monotonic id generator for correlating peer requests with results. */
function makeIdGen() {
  let n = 0;
  return () => `peer-${++n}`;
}

export interface PeerClientOptions {
  /** Called once when the owner connection is lost (so the caller can re-elect). */
  onOwnerLost?: () => void;
  /** Version string sent in the hello frame. */
  version?: string;
  /**
   * Shared handshake secret (MANTA_TOKEN) — REQUIRED. The owner only speaks to
   * clients that answer its auth challenge, and we only trust an owner that
   * proves it knows the token (see auth.ts).
   */
  token: string;
}

export function startPeerClient(
  port: number,
  host = '127.0.0.1',
  opts: PeerClientOptions,
): PeerClient {
  const url = `ws://${host}:${port}`;
  const pending = new Map<string, Pending>();
  const nextId = makeIdGen();
  let ownerLost = false;

  // Log to stderr — stdout is reserved for the MCP stdio transport.
  const log = (...a: unknown[]) => console.error('[peer]', ...a);

  const ws = new WebSocket(url);

  // Handshake: hello (with our nonce) → verify the owner's welcome proof →
  // answer its challenge with an auth proof. `ready` settles only after the
  // full exchange; a token mismatch (either direction) rejects it. The settle
  // fn is hoisted so the message handler below can resolve on handshake done.
  let settleReady: (err?: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    settleReady = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    ws.once('error', (err) => settleReady(err instanceof Error ? err : new Error(String(err))));
    ws.once('close', () =>
      settleReady(new Error('owner closed the connection before the handshake completed')),
    );
  });
  ready.catch(() => {});

  let helloNonce = '';
  let handshakeDone = false;

  ws.once('open', () => {
    helloNonce = newNonce();
    const hello: HelloFrame = {
      type: 'hello',
      role: 'peer',
      version: opts.version ?? '0.0.0',
      nonce: helloNonce,
    };
    ws.send(JSON.stringify(hello));
    log(`dialed owner at ${url} — awaiting handshake`);
  });

  ws.on('message', (data) => {
    let frame: PeerServerFrame;
    try {
      frame = JSON.parse(String(data)) as PeerServerFrame;
    } catch {
      log('dropping non-JSON frame');
      return;
    }
    if (!handshakeDone) {
      if (frame.type === 'welcome') {
        if (!verifyWelcomeProof(opts.token, helloNonce, frame.proof)) {
          log('owner failed the welcome proof — token mismatch (re-copy the install prompt)');
          settleReady(new Error('Owner failed the handshake: token mismatch. Re-copy the install prompt from the extension and update the MCP config env.'));
          ws.terminate();
          return;
        }
        const auth: AuthFrame = {
          type: 'auth',
          proof: authProof(opts.token, frame.nonce),
        };
        ws.send(JSON.stringify(auth));
        handshakeDone = true;
        log(`handshake ok — connected to owner at ${url}`);
        settleReady();
        return;
      }
      settleReady(new Error(`unexpected "${(frame as { type: string }).type}" frame during handshake`));
      ws.terminate();
      return;
    }
    if (frame.type === 'peer-rpc-result') {
      const p = pending.get(frame.id);
      if (!p) return;
      pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.ok) p.resolve(frame.result);
      else p.reject(new Error(frame.error));
    }
    // `rpc` frames are meaningless to a peer (only the extension answers those).
  });

  ws.on('close', () => {
    // Fail every in-flight call: the owner can no longer answer them.
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error('owner connection lost'));
    }
    pending.clear();
    if (!ownerLost) {
      ownerLost = true;
      log('owner connection closed');
      opts.onOwnerLost?.();
    }
  });

  ws.on('error', (err) => log('socket error', err));

  function call(method: RpcMethod, params: unknown, timeoutMs = 10000): Promise<unknown> {
    if (ws.readyState !== ws.OPEN) {
      return Promise.reject(
        new Error('Not connected to the MCP owner process (peer link is down).'),
      );
    }
    const id = nextId();
    const frame: PeerRpcRequestFrame = { type: 'peer-rpc', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`peer RPC "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify(frame), (err) => {
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
      p.reject(new Error('peer client closing'));
    }
    pending.clear();
    return new Promise((resolve) => {
      ws.once('close', () => resolve());
      ws.close();
    });
  }

  return {
    whenReady: () => ready,
    call,
    isConnected: () => ws.readyState === ws.OPEN,
    close,
  };
}
