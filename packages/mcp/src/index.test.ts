/**
 * Tool-surface tests: the real `server` (all 31 registered tools) driven over
 * an in-memory MCP transport, with the runtime bridge swapped for a stub. This
 * exercises each tool's zod validation, params relayed to the extension, and
 * result/error shaping — the whole agent-visible contract without a socket.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { _test } from './index.js';
import type { Bridge } from './bridge.js';

let client: Client;

type CallFn = Bridge['call'];

function stubBridge(
  impl: (method: string, params: unknown) => unknown | Promise<unknown>,
): ReturnType<typeof vi.fn> {
  const call = vi.fn<CallFn>().mockImplementation((method, params) =>
    Promise.resolve(impl(method as string, params)),
  );
  _test.setBridge({
    isConnected: () => true,
    whenReady: () => Promise.resolve(),
    call: call as unknown as CallFn,
    close: () => Promise.resolve(),
    port: () => 0,
  });
  return call;
}

afterEach(async () => {
  await client?.close().catch(() => {});
  _test.clear();
});

/** Connect a fresh in-memory MCP client to the real server (once per test). */
async function connect(): Promise<Client> {
  const c = new Client({ name: 'test', version: '0.0.0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([c.connect(clientT), _test.server.connect(serverT)]);
  client = c;
  return c;
}

describe('tool surface', () => {
  it('registers the full read/action/capture/proxy tool set', async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name).sort();
    for (const expected of [
      'list_recordings', 'get_recording', 'get_call', 'get_flow', 'get_endpoints',
      'set_recording_description',
      'list_element_captures', 'get_element_capture', 'diff_element_captures',
      'proxy_fetch', 'proxy_sse', 'add_proxy_rule', 'list_proxy_rules',
      'update_proxy_rule', 'rebind_proxy',
      'list_actions', 'get_action', 'search_actions', 'create_action',
      'update_action', 'delete_action', 'execute_action',
      'capture_screenshot', 'capture_element',
      'start_gif_recording', 'stop_gif_recording', 'pause_gif_recording',
      'resume_gif_recording', 'list_gif_history', 'get_gif_recording_status',
      'health',
    ]) {
      expect(names).toContain(expected);
    }
  });
});

describe('read tools', () => {
  it('list_recordings relays nothing and returns the recordings array as JSON text', async () => {
    const call = stubBridge((_m, _p) => ({ recordings: [{ id: 'r1', name: 'x' }] }));
    const c = await connect();
    const res = await c.callTool({ name: 'list_recordings', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(call).toHaveBeenCalledWith('list_recordings', undefined, undefined);
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(JSON.parse(text)).toEqual([{ id: 'r1', name: 'x' }]);
  });

  it('get_recording relays the id and reports a missing recording as an error result', async () => {
    const call = stubBridge((_m, p) => ({ recording: (p as { id: string }).id === 'r1' ? { id: 'r1' } : null }));
    const c = await connect();
    const ok = await c.callTool({ name: 'get_recording', arguments: { id: 'r1' } });
    expect(ok.isError).toBeFalsy();
    expect(call).toHaveBeenCalledWith('get_recording', { id: 'r1' }, undefined);

    const miss = await c.callTool({ name: 'get_recording', arguments: { id: 'nope' } });
    expect(miss.isError).toBe(true);
    expect((miss.content as { text: string }[])[0]!.text).toContain('No recording found with id "nope"');
  });

  it('wraps a bridge rejection in an isError result carrying the message', async () => {
    const call = vi.fn<CallFn>().mockRejectedValue(new Error('No authenticated Chrome extension connected.'));
    _test.setBridge({
      isConnected: () => false,
      whenReady: () => Promise.resolve(),
      call: call as unknown as CallFn,
      close: () => Promise.resolve(),
      port: () => 0,
    });
    const c = await connect();
    const res = await c.callTool({ name: 'list_recordings', arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toContain('No authenticated Chrome extension');
  });
});

describe('argument validation', () => {
  it('rejects invalid arguments with an isError result', async () => {
    stubBridge(() => ({}));
    const c = await connect();
    // get_recording requires `id`; execute_action requires an `id` too.
    for (const args of [
      { name: 'get_recording', arguments: {} },
      { name: 'execute_action', arguments: {} },
    ]) {
      const res = await c.callTool(args as never);
      expect(res.isError).toBe(true);
      expect((res.content as { text: string }[])[0]!.text).toMatch(/id/i);
    }
  });
});

describe('action tools', () => {
  it('execute_action relays id and params to the extension', async () => {
    const call = stubBridge((_m, p) => ({ run: { runId: 'run1', echo: p } }));
    const c = await connect();
    const res = await c.callTool({
      name: 'execute_action',
      arguments: { id: 'a1', params: { userId: '42' } },
    });
    expect(res.isError).toBeFalsy();
    // proxy-executing tools pass the extended 130s timeout.
    expect(call).toHaveBeenCalledWith('execute_action', { id: 'a1', params: { userId: '42' } }, 130000);
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(JSON.parse(text).runId).toBe('run1');
  });

  it('create_action relays the definition and returns the created action', async () => {
    const call = stubBridge((_m, p) => ({ action: { id: 'a9', ...(p as object) } }));
    const c = await connect();
    const res = await c.callTool({
      name: 'create_action',
      arguments: { name: 'login', description: 'Log in', recordingId: 'r1', steps: [] },
    });
    expect(res.isError).toBeFalsy();
    expect(call).toHaveBeenCalledWith(
      'create_action',
      { name: 'login', description: 'Log in', recordingId: 'r1', params: undefined, steps: [] },
      undefined,
    );
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(JSON.parse(text).name).toBe('login');
  });
});
