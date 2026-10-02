import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { startProxyHttp, type ProxyHttpServer } from './proxy-http.js';
import type { Bridge } from './bridge.js';

type CallFn = Bridge['call'];

let servers: ProxyHttpServer[] = [];

afterEach(async () => {
  for (const s of servers) await s.close().catch(() => {});
  servers = [];
});

/** Grab a free TCP port from the OS (bind 0, read it, release). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

/** A Bridge stub whose call() is a vi.fn returning a canned proxy_rule result. */
function fakeBridge(result: unknown): { bridge: Bridge; call: ReturnType<typeof vi.fn> } {
  const call = vi.fn<CallFn>().mockResolvedValue(result);
  return {
    bridge: {
      isConnected: () => true,
      whenReady: () => Promise.resolve(),
      call: call as unknown as CallFn,
      close: () => Promise.resolve(),
      port: () => 0,
    },
    call,
  };
}

const MATCHED = {
  matched: true,
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"ok":true}',
};

async function start(bridge: Bridge): Promise<ProxyHttpServer> {
  // startProxyHttp validates 1-65535 (no port 0), so probe a free port first.
  const server = startProxyHttp(bridge, await freePort());
  servers.push(server);
  await server.whenReady();
  return server;
}

function urlOf(server: ProxyHttpServer, path: string): string {
  return `http://127.0.0.1:${server.currentPort()}${path}`;
}

describe('proxy-http', () => {
  it('forwards the local request through the bridge and relays the response', async () => {
    const { bridge, call } = fakeBridge(MATCHED);
    const server = await start(bridge);
    const res = await fetch(urlOf(server, '/api/v1/orders?x=1'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-custom': 'yes' },
      body: '{"a":1}',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    await expect(res.text()).resolves.toBe('{"ok":true}');

    expect(call).toHaveBeenCalledTimes(1);
    const [method, params] = call.mock.calls[0] as [string, { req: Record<string, unknown> }, number];
    expect(method).toBe('proxy_rule');
    expect(params.req).toMatchObject({
      method: 'POST',
      rawPath: '/api/v1/orders?x=1',
      headers: { 'content-type': 'application/json', 'x-custom': 'yes' },
      body: '{"a":1}',
    });
  });

  it('strips hop-by-hop and credential headers before relaying', async () => {
    const { bridge, call } = fakeBridge(MATCHED);
    const server = await start(bridge);
    // node:http (not fetch) — undici refuses to send hop-by-hop headers itself.
    await new Promise<void>((resolve) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: server.currentPort(),
          path: '/x',
          headers: {
            connection: 'keep-alive',
            'keep-alive': 'timeout=5',
            'transfer-encoding': 'chunked',
            cookie: 'a=b',
            authorization: 'Bearer t',
            'x-app': 'kept',
          },
        },
        () => resolve(),
      );
      req.end();
    });
    const [, params] = call.mock.calls[0] as [string, { req: { headers: Record<string, string> } }, number];
    expect(params.req.headers['x-app']).toBe('kept');
    expect(params.req.headers['connection']).toBeUndefined();
    expect(params.req.headers['keep-alive']).toBeUndefined();
    expect(params.req.headers['transfer-encoding']).toBeUndefined();
    expect(params.req.headers['cookie']).toBeUndefined();
    expect(params.req.headers['authorization']).toBeUndefined();
  });

  it('omits the body for GET and HEAD requests', async () => {
    const { bridge, call } = fakeBridge(MATCHED);
    const server = await start(bridge);
    await fetch(urlOf(server, '/x?only=query'));
    const [, params] = call.mock.calls[0] as [string, { req: { body?: string } }, number];
    expect(params.req.body).toBeUndefined();

    await fetch(urlOf(server, '/y'), { method: 'HEAD' });
    const [, params2] = call.mock.calls[1] as [string, { req: { body?: string } }, number];
    expect(params2.req.body).toBeUndefined();
  });

  it('answers 404 with the rule error when nothing matched', async () => {
    const { bridge } = fakeBridge({ matched: false, status: 404, error: 'No matching proxy rule' });
    const server = await start(bridge);
    const res = await fetch(urlOf(server, '/none'));
    expect(res.status).toBe(404);
    await expect(res.text()).resolves.toContain('No matching proxy rule');
  });

  it('answers 503 when the bridge has no connected extension', async () => {
    const { bridge, call } = fakeBridge(MATCHED);
    (call as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('No authenticated Chrome extension connected.'));
    const server = await start(bridge);
    const res = await fetch(urlOf(server, '/x'));
    expect(res.status).toBe(503);
    await expect(res.text()).resolves.toContain('Sandbox proxy unavailable');
  });

  it('rebind moves the listener: the old port closes, the new one serves', async () => {
    const { bridge } = fakeBridge(MATCHED);
    const server = await start(bridge);
    const oldPort = server.currentPort();
    const newPort = await server.rebind(await freePort());
    expect(newPort).not.toBe(oldPort);
    expect(server.currentPort()).toBe(newPort);
    expect(server.isListening()).toBe(true);

    await expect(fetch(`http://127.0.0.1:${oldPort}/x`)).rejects.toThrow();
    const res = await fetch(urlOf(server, '/x'));
    expect(res.status).toBe(200);
  });

  it('keeps the old binding when a rebind fails (port in use)', async () => {
    const { bridge } = fakeBridge(MATCHED);
    const server = await start(bridge);
    const blocker = startProxyHttp(bridge, 0);
    servers.push(blocker);
    await blocker.whenReady();

    const port = server.currentPort();
    await expect(server.rebind(blocker.currentPort())).rejects.toThrow();
    expect(server.currentPort()).toBe(port);
    expect(server.isListening()).toBe(true);
  });
});
