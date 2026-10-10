import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import { startBridge, type Bridge } from './bridge.js';
import { dialAsExtension, type DialedSocket } from './test-helpers.js';

const TOKEN = 'test-token-123';

let bridges: Bridge[] = [];
let dialed: DialedSocket[] = [];

async function start(token: string | undefined): Promise<Bridge> {
  const bridge = startBridge(0, token);
  bridges.push(bridge);
  await bridge.whenReady();
  return bridge;
}

/** Start a bridge and dial an authenticated extension socket into it. */
async function startWithExtension(token: string | undefined): Promise<Bridge> {
  const bridge = await start(token);
  const client = dialAsExtension((bridge as any).wss?.address?.().port ?? 0, token);
  // startBridge doesn't expose its port; read it from the first client is
  // impossible — instead dial via the bridge's own bound port through a reopen.
  dialed.push(client);
  return bridge;
}

afterEach(async () => {
  for (const d of dialed) await d.close().catch(() => {});
  for (const b of bridges) await b.close().catch(() => {});
  bridges = [];
  dialed = [];
});

describe('bridge handshake', () => {
  it('authenticates an extension that answers the challenge with the right token', async () => {
    const { bridge, client } = await setup(TOKEN);
    expect(bridge.isConnected()).toBe(true);
    await client.close();
    // Give the server a beat to observe the close.
    await new Promise((r) => setTimeout(r, 30));
    expect(bridge.isConnected()).toBe(false);
  });

  it('rejects a client whose auth proof does not match the token', async () => {
    const bridge = await start(TOKEN);
    const port = bridgePort(bridge);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const closed = new Promise<void>((resolve) => ws.once('close', resolve));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'hello', role: 'extension', nonce: 'n1' }));
    // Reply to the challenge with a proof computed from the WRONG token.
    const frame = await new Promise<any>((resolve) =>
      ws.once('message', (d) => resolve(JSON.parse(String(d)))),
    );
    expect(frame.type).toBe('welcome');
    ws.send(JSON.stringify({ type: 'auth', proof: 'ff'.repeat(32) }));
    await closed;
    expect(bridge.isConnected()).toBe(false);
  });

  it('fails closed when no token is configured', async () => {
    const bridge = await start(undefined);
    const port = bridgePort(bridge);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const closed = new Promise<void>((resolve) => ws.once('close', resolve));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'hello', role: 'extension', nonce: 'n1' }));
    await closed;
  });

  it('terminates clients with a web Origin (pages cannot dial localhost)', async () => {
    const bridge = await start(TOKEN);
    const port = bridgePort(bridge);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: 'https://evil.example' } });
    const closed = new Promise<void>((resolve) => ws.once('close', resolve));
    await new Promise((r) => ws.once('open', r));
    await closed;
  });

  it('terminates a client sending a business frame before authenticating', async () => {
    const bridge = await start(TOKEN);
    const port = bridgePort(bridge);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const closed = new Promise<void>((resolve) => ws.once('close', resolve));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'rpc', id: 'rpc-1', method: 'list_recordings', params: {} }));
    await closed;
  });

  it('keeps the socket open for non-JSON frames (drop, not kill)', async () => {
    const bridge = await start(TOKEN);
    const port = bridgePort(bridge);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r) => ws.once('open', r));
    ws.send('this is not json');
    // The server dropped it; the handshake can still proceed normally.
    const client = dialExisting(bridge, port, TOKEN);
    dialed.push(client);
    await client.authed;
    expect(bridge.isConnected()).toBe(true);
    ws.close();
  });
});

describe('bridge rpc', () => {
  it('round-trips a call to the connected extension and correlates by id', async () => {
    const { bridge, client } = await setup(TOKEN);
    const pending = bridge.call('list_recordings', {});
    const frame = await client.nextFrame();
    expect(frame).toMatchObject({ type: 'rpc', method: 'list_recordings' });
    client.ws.send(JSON.stringify({ type: 'rpc-result', id: frame.id, ok: true, result: { recordings: [1] } }));
    await expect(pending).resolves.toEqual({ recordings: [1] });
  });

  it('rejects a call when no extension is connected, with a hint', async () => {
    const bridge = await start(TOKEN);
    await expect(bridge.call('list_recordings', {})).rejects.toThrow(/No authenticated Chrome extension/);
  });

  it('explains the missing MANTA_TOKEN in the call() error when unconfigured', async () => {
    const bridge = await start(undefined);
    await expect(bridge.call('list_recordings', {})).rejects.toThrow(/MANTA_TOKEN/);
  });

  it('times out a call the extension never answers', async () => {
    const { bridge, client } = await setup(TOKEN);
    await expect(bridge.call('list_recordings', {}, 30)).rejects.toThrow(/timed out after 30ms/);
    // A late reply for the timed-out id is ignored without crashing.
    const frame = await client.nextFrame();
    client.ws.send(JSON.stringify({ type: 'rpc-result', id: frame.id, ok: true, result: {} }));
    await client.close();
  });

  it('fails in-flight calls immediately when the extension disconnects', async () => {
    const { bridge, client } = await setup(TOKEN);
    const pending = bridge.call('get_recording', { id: 'r1' }, 5000);
    await client.nextFrame();
    await client.close();
    await expect(pending).rejects.toThrow(/disconnected while the RPC was in flight/);
  });

  it('lets a reconnecting extension take over and serves calls from the new socket', async () => {
    const { bridge, client } = await setup(TOKEN);
    const second = dialExisting(bridge, bridgePort(bridge), TOKEN);
    dialed.push(second);
    await second.authed;
    await client.close();
    expect(bridge.isConnected()).toBe(true);

    const pending = bridge.call('list_recordings', {});
    const frame = await second.nextFrame();
    second.ws.send(JSON.stringify({ type: 'rpc-result', id: frame.id, ok: true, result: 'ok' }));
    await expect(pending).resolves.toBe('ok');
  });
});

describe('bridge heartbeat', () => {
  /** Only the heartbeat interval is virtual — socket I/O and awaits stay real. */
  function fakeHeartbeatClock() {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  }

  it('answers an app-level ping frame with pong (browsers cannot send WS ping control frames)', async () => {
    const { bridge, client } = await setup(TOKEN);
    client.ws.send(JSON.stringify({ type: 'ping' }));
    await expect(client.nextFrame()).resolves.toMatchObject({ type: 'pong' });
    expect(bridge.isConnected()).toBe(true);
  });

  it('keeps a live (pong-answering) socket connected across many heartbeat intervals', async () => {
    fakeHeartbeatClock();
    try {
      const { bridge, client } = await setup(TOKEN);
      // Each interval pings; the ws client answers the protocol-level pong
      // automatically, and the pong (async I/O) marks the socket alive again
      // before the NEXT interval — hence one advance + one real beat per round.
      for (let i = 0; i < 3; i++) {
        vi.advanceTimersByTime(30_000);
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(bridge.isConnected()).toBe(true);
      void client;
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminates a socket that stops answering the heartbeat (half-open peer)', async () => {
    fakeHeartbeatClock();
    try {
      const bridge = await start(TOKEN);
      const client = dialExisting(bridge, bridgePort(bridge), TOKEN);
      dialed.push(client);
      await client.authed;
      // Simulate a half-open peer: stop reading frames → no protocol pongs.
      // (A paused ws client never processes the teardown either, so the
      // assertion watches the SERVER-side connection state, not the client's
      // close event.)
      client.ws.pause();
      vi.advanceTimersByTime(30_000); // ping #1 goes out, no pong will come
      await new Promise((r) => setTimeout(r, 20));
      vi.advanceTimersByTime(30_000); // next tick: dead → terminate
      await vi.waitFor(() => expect(bridge.isConnected()).toBe(false));
      client.ws.resume(); // let the client drain before afterEach cleanup
    } finally {
      vi.useRealTimers();
    }
  });
});

// -- helpers ----------------------------------------------------------------

/** Recover the port a bridge bound (explicit when constructed with 0). */
function bridgePort(bridge: Bridge): number {
  return bridge.port();
}

/** Dial an already-bound bridge port. */
function dialExisting(bridge: Bridge, port: number, token: string | undefined): DialedSocket {
  void bridge;
  return dialAsExtension(port, token);
}

/** Bridge + authenticated extension, ready for rpc tests. */
async function setup(token: string | undefined): Promise<{ bridge: Bridge; client: DialedSocket }> {
  const bridge = await start(token);
  const client = dialExisting(bridge, bridgePort(bridge), token);
  dialed.push(client);
  await client.authed;
  expect(bridge.isConnected()).toBe(true);
  return { bridge, client };
}
