/**
 * Test helpers for the WS-based suites: dial the bridge as the extension would
 * (hello -> welcome verify -> auth) and return the raw socket plus a helper to
 * read parsed frames.
 */
import { WebSocket } from 'ws';
import { authProof, verifyWelcomeProof } from './auth.js';

export interface DialedSocket {
  ws: WebSocket;
  /** Resolves once the full handshake has completed (server treats us as authed). */
  authed: Promise<void>;
  /** Queue of every frame the server sends after the handshake. */
  frames: Promise<any>[];
  nextFrame(): Promise<any>;
  close(): Promise<void>;
}

/**
 * Perform the client half of the handshake against a running bridge.
 * Fails the returned promise if the server terminates us (bad token etc.).
 */
export function dialAsExtension(port: number, token: string | undefined): DialedSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames: Promise<any>[] = [];
  let frameIndex = 0;
  const waiters: ((f: any) => void)[] = [];
  // Frames received before the handshake completes (the welcome challenge)
  // belong to the handshake, not to test assertions — skip them.
  let handshakeDone = false;

  ws.on('message', (data) => {
    if (!handshakeDone) return;
    const frame = JSON.parse(String(data));
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(Promise.resolve(frame));
  });

  const nextFrame = (): Promise<any> => {
    if (frameIndex < frames.length) return frames[frameIndex++]!;
    return new Promise((resolve) => waiters.push(resolve));
  };

  const authed = new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role: 'extension', nonce: 'test-hello-nonce' }));
    });
    ws.once('close', () => reject(new Error('socket closed during/before handshake')));
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === 'welcome') {
        if (token && !verifyWelcomeProof(token, 'test-hello-nonce', frame.proof)) {
          reject(new Error('server failed the welcome proof'));
          ws.terminate();
          return;
        }
        ws.send(
          JSON.stringify({
            type: 'auth',
            proof: authProof(token ?? '', frame.nonce),
          }),
        );
        // The server does not ack the auth; being kept open + later traffic is
        // the ack. Resolve on next tick after the auth frame is out.
        handshakeDone = true;
        ws.once('message', () => resolve());
        setTimeout(resolve, 50);
      }
    });
  });

  return {
    ws,
    authed,
    frames,
    nextFrame,
    close: () =>
      new Promise((resolve) => {
        if (ws.readyState === ws.CLOSED) return resolve();
        ws.once('close', resolve);
        ws.terminate();
      }),
  };
}
