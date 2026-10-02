/**
 * RPC dispatch tests for lib/mcp/handlers.ts. Every heavy dependency (db,
 * gateway, replay, gif session, screenshot capture, chrome.*) is mocked; the
 * tests cover each method's param validation, result shaping, the per-tool
 * kill switch choke point, and the internal-method bypass.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  listRecordings: vi.fn(),
  getRecording: vi.fn(),
  getCalls: vi.fn(),
  getInspectorCapture: vi.fn(),
  listInspectorCaptures: vi.fn(),
  listGifHistory: vi.fn(),
  saveScreenshotHistory: vi.fn(),
  listActions: vi.fn(),
  listActionsByRecording: vi.fn(),
  listGatewayProxyRules: vi.fn(),
  upsertAction: vi.fn(),
  deleteAction: vi.fn(),
  getAction: vi.fn(),
  updateRecordingDescription: vi.fn(),
  addGatewayLog: vi.fn(),
}));

vi.mock('@/lib/storage', () => ({
  settings: {
    mcpToolEnabled: { getValue: vi.fn(async () => ({}) as unknown) },
    proxyPort: { setValue: vi.fn(async () => undefined as unknown) },
  },
  gifLastResult: { getValue: vi.fn(async () => null as unknown) },
  gifRecordingState: { getValue: vi.fn(async () => null as unknown) },
}));

vi.mock('@/lib/gateway/run', () => ({
  runGatewayFetch: vi.fn(),
  runGatewaySse: vi.fn(),
}));
vi.mock('@/lib/gateway/proxy-rule', () => ({
  resolveProxyRule: vi.fn(),
}));
vi.mock('@/lib/gateway/manage-rules', () => ({
  addProxyRule: vi.fn(),
  updateProxyRuleContent: vi.fn(),
}));
vi.mock('@/lib/inspector/capture', () => ({
  AGENT_CAPTURE_ELEMENTS: 'AGENT_CAPTURE_ELEMENTS',
}));
vi.mock('@/lib/action/replay', () => ({
  runAction: vi.fn(),
}));
vi.mock('@/lib/gif-recording/session', () => ({
  startGifRecording: vi.fn(),
  stopGifRecording: vi.fn(),
  pauseGifRecording: vi.fn(),
  resumeGifRecording: vi.fn(),
}));
vi.mock('@/lib/gif-confirm', () => ({
  requestGifConfirmation: vi.fn(),
}));
vi.mock('@/lib/screenshot/capture-flow', () => ({
  captureTabScreenshot: vi.fn(),
  shotFilename: vi.fn(() => 'shot.png'),
}));
vi.mock('@/lib/screenshot/agent-image', () => ({
  prepareAgentImage: vi.fn(),
}));

import { handleRpc } from '@/lib/mcp/handlers';

/**
 * Loose dispatch wrapper: the union-typed `RpcMap` params make every call site
 * fight the checker ({} vs the exact param shape), and the result is a big
 * union — the tests pin runtime behavior, not TS types.
 */
const rpc = (method: string, params: unknown = {}): Promise<any> =>
  handleRpc(method as never, params as never) as Promise<any>;

/** Strip the strict mock typing — mockResolvedValue(any) everywhere. */
const mock = (f: unknown): ReturnType<typeof vi.fn> => f as ReturnType<typeof vi.fn>;
import {
  listRecordings,
  getRecording,
  getCalls,
  getInspectorCapture,
  listInspectorCaptures,
  listGifHistory,
  saveScreenshotHistory,
  listActions,
  listActionsByRecording,
  listGatewayProxyRules,
  upsertAction,
  deleteAction,
  getAction,
  updateRecordingDescription,
} from '@/lib/db';
import { settings, gifLastResult } from '@/lib/storage';
import { runGatewayFetch, runGatewaySse } from '@/lib/gateway/run';
import { resolveProxyRule } from '@/lib/gateway/proxy-rule';
import { addProxyRule, updateProxyRuleContent } from '@/lib/gateway/manage-rules';
import { runAction } from '@/lib/action/replay';
import {
  startGifRecording,
  stopGifRecording,
  pauseGifRecording,
  resumeGifRecording,
} from '@/lib/gif-recording/session';
import { requestGifConfirmation } from '@/lib/gif-confirm';
import { captureTabScreenshot } from '@/lib/screenshot/capture-flow';
import { prepareAgentImage } from '@/lib/screenshot/agent-image';
import type { Action } from '@/lib/action/types';

const mocked = {
  listRecordings: mock(listRecordings),
  getRecording: mock(getRecording),
  getCalls: mock(getCalls),
  getInspectorCapture: mock(getInspectorCapture),
  listInspectorCaptures: mock(listInspectorCaptures),
  listGifHistory: mock(listGifHistory),
  saveScreenshotHistory: mock(saveScreenshotHistory),
  listActions: mock(listActions),
  listActionsByRecording: mock(listActionsByRecording),
  listGatewayProxyRules: mock(listGatewayProxyRules),
  upsertAction: mock(upsertAction),
  deleteAction: mock(deleteAction),
  getAction: mock(getAction),
  updateRecordingDescription: mock(updateRecordingDescription),
  runGatewayFetch: mock(runGatewayFetch),
  runGatewaySse: mock(runGatewaySse),
  resolveProxyRule: mock(resolveProxyRule),
  addProxyRule: mock(addProxyRule),
  updateProxyRuleContent: mock(updateProxyRuleContent),
  runAction: mock(runAction),
  startGifRecording: mock(startGifRecording),
  stopGifRecording: mock(stopGifRecording),
  pauseGifRecording: mock(pauseGifRecording),
  resumeGifRecording: mock(resumeGifRecording),
  requestGifConfirmation: mock(requestGifConfirmation),
  captureTabScreenshot: mock(captureTabScreenshot),
  prepareAgentImage: mock(prepareAgentImage),
};

const tabsQuery = vi.fn();
const tabsGet = vi.fn();
const tabsSendMessage = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('chrome', {
    tabs: { query: tabsQuery, get: tabsGet, sendMessage: tabsSendMessage },
    runtime: { getURL: (p: string) => `chrome-extension://test/${p}` },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('kill switch', () => {
  it('rejects a tool the user disabled in the extension', async () => {
    mock(settings.mcpToolEnabled.getValue).mockResolvedValue({
      list_recordings: false,
    });
    await expect(rpc('list_recordings', {})).rejects.toThrow(
      /has been disabled by the user/,
    );
    expect(mocked.listRecordings).not.toHaveBeenCalled();
  });

  it('lets internal methods bypass the per-tool switch', async () => {
    mock(settings.mcpToolEnabled.getValue).mockResolvedValue({
      proxy_rule: false,
      set_proxy_port: false,
    });
    mocked.listGatewayProxyRules.mockResolvedValue([]);
    mocked.resolveProxyRule.mockReturnValue({
      ok: false,
      error: 'No matching proxy rule',
      status: 404,
    });
    const res = await rpc('proxy_rule', {
      req: { method: 'GET', rawPath: '/x', headers: {}, body: undefined },
    });
    expect(res).toMatchObject({ matched: false, status: 404 });

    const res2 = await rpc('set_proxy_port', { proxyPort: 59999 });
    expect(res2).toEqual({ proxyPort: 59999 });
  });
});

describe('recording reads', () => {
  it('list_recordings relays the db list', async () => {
    mocked.listRecordings.mockResolvedValue([{ id: 'r1', name: 'Login' } as never]);
    await expect(rpc('list_recordings', {})).resolves.toEqual({
      recordings: [{ id: 'r1', name: 'Login' }],
    });
  });

  it('get_recording validates id and nudges the agent when no description', async () => {
    await expect(rpc('get_recording', {})).rejects.toThrow(/missing "id"/);

    mocked.getRecording.mockResolvedValue(null);
    await expect(rpc('get_recording', { id: 'nope' })).resolves.toEqual({
      recording: null,
      calls: [],
      descriptionHint: undefined,
    });
    expect(mocked.getCalls).not.toHaveBeenCalled();

    mocked.getRecording.mockResolvedValue({ id: 'r1', name: 'x' } as never);
    mocked.getCalls.mockResolvedValue([{ id: 'c1' } as never]);
    const noDesc = await rpc('get_recording', { id: 'r1' });
    expect(noDesc.descriptionHint).toMatch(/set_recording_description/);

    mocked.getRecording.mockResolvedValue({ id: 'r1', description: 'Flow' } as never);
    const withDesc = await rpc('get_recording', { id: 'r1' });
    expect(withDesc.descriptionHint).toBeUndefined();
  });

  it('set_recording_description validates and writes through the dedicated path', async () => {
    await expect(
      rpc('set_recording_description', { id: 'r1', description: '  ' }),
    ).rejects.toThrow(/non-empty string/);

    mocked.getRecording.mockResolvedValue(null);
    await expect(
      rpc('set_recording_description', { id: 'r9', description: 'd' }),
    ).rejects.toThrow(/no recording with id "r9"/);

    mocked.getRecording
      .mockResolvedValueOnce({ id: 'r1' } as never)
      .mockResolvedValueOnce({ id: 'r1', description: 'd' } as never);
    const res = await rpc('set_recording_description', {
      id: 'r1',
      description: '  d  ',
    });
    expect(mocked.updateRecordingDescription).toHaveBeenCalledWith('r1', '  d  ');
    expect(res.recording).toEqual({ id: 'r1', description: 'd' });
  });
});

describe('element captures', () => {
  it('list_element_captures projects metadata only', async () => {
    mocked.listInspectorCaptures.mockResolvedValue([
      {
        id: 'e1',
        payload: {
          page: { url: 'https://x', title: 'T' },
          capturedAt: 5,
          elementCount: 2,
        },
      } as never,
    ]);
    await expect(rpc('list_element_captures', {})).resolves.toEqual({
      captures: [{ id: 'e1', url: 'https://x', title: 'T', capturedAt: 5, elementCount: 2 }],
    });
  });

  it('get_element_capture requires an id and returns null when missing', async () => {
    await expect(rpc('get_element_capture', {})).rejects.toThrow(/missing "id"/);
    mocked.getInspectorCapture.mockResolvedValue(null);
    await expect(rpc('get_element_capture', { id: 'e1' })).resolves.toEqual({
      capture: null,
    });
  });

  it('capture_element enforces exactly one selector and strips the lean bulk', async () => {
    await expect(rpc('capture_element', {})).rejects.toThrow(/exactly one/);
    await expect(
      rpc('capture_element', { selector: '.a', box: { x: 0, y: 0, w: 1, h: 1 } }),
    ).rejects.toThrow(/exactly one/);

    tabsQuery.mockResolvedValue([{ id: 3, url: 'https://x' }]);
    tabsSendMessage.mockResolvedValue({ ok: true, captureId: 'cap1' });
    mocked.getInspectorCapture.mockResolvedValue({
      page: { url: 'https://x', title: 'T' },
      capturedAt: 1,
      elementCount: 1,
      elements: [{ tag: 'div', fullStyles: [1, 2], pseudo: [3], textFull: 'long', styles: { color: 'red' } }],
    } as never);
    const res = await rpc('capture_element', { selector: '.a' });
    expect(tabsSendMessage).toHaveBeenCalledWith(3, {
      type: 'AGENT_CAPTURE_ELEMENTS',
      data: { selector: '.a' },
    });
    expect(res.captureId).toBe('cap1');
    expect(res.elements[0]).toEqual({ tag: 'div', styles: { color: 'red' } });
  });

  it('capture_element wraps a missing content script and a failed reply', async () => {
    tabsQuery.mockResolvedValue([{ id: 3, url: 'chrome://settings' }]);
    tabsSendMessage.mockRejectedValue(new Error('no receiver'));
    await expect(rpc('capture_element', { selector: '.a' })).rejects.toThrow(
      /no content script on this tab/,
    );

    tabsSendMessage.mockResolvedValue({ ok: false, error: 'selector not found' });
    await expect(rpc('capture_element', { selector: '.a' })).rejects.toThrow(
      /capture_element failed: selector not found/,
    );
  });
});

describe('screenshot', () => {
  it('capture_screenshot validates mode and the active tab', async () => {
    await expect(
      rpc('capture_screenshot', { mode: 'weird' } as never),
    ).rejects.toThrow(/must be "visible" or "fullPage"/);

    tabsQuery.mockResolvedValue([]);
    await expect(
      rpc('capture_screenshot', { mode: 'visible' }),
    ).rejects.toThrow(/no active tab/);
  });

  it('capture_screenshot saves history and returns the compressed agent copy', async () => {
    tabsQuery.mockResolvedValue([{ id: 1, url: 'https://x' }]);
    mocked.captureTabScreenshot.mockResolvedValue({
      dataUrl: 'data:image/png;base64,orig',
      stitched: true,
    } as never);
    mocked.saveScreenshotHistory.mockResolvedValue('h1');
    mocked.prepareAgentImage.mockResolvedValue({
      dataUrl: 'small',
      width: 100,
      height: 50,
      format: 'jpeg',
    } as never);
    const res = await rpc('capture_screenshot', { mode: 'fullPage' });
    expect(mocked.saveScreenshotHistory).toHaveBeenCalledWith(
      'data:image/png;base64,orig',
      'shot.png',
    );
    expect(res).toMatchObject({
      historyId: 'h1',
      filename: 'shot.png',
      originalBytes: 'data:image/png;base64,orig'.length,
      fullPageStitched: true,
      dataUrl: 'small',
    });
  });

  it('capture_screenshot maps a history-save failure to capture-failed', async () => {
    tabsQuery.mockResolvedValue([{ id: 1, url: 'https://x' }]);
    mocked.captureTabScreenshot.mockResolvedValue({ dataUrl: 'd', stitched: false } as never);
    mocked.saveScreenshotHistory.mockRejectedValue(new Error('quota'));
    await expect(rpc('capture_screenshot', { mode: 'visible' })).rejects.toThrow(
      /history save failed/,
    );
  });
});

describe('gif tools', () => {
  it('start_gif_recording resolves the explicit tab and requires a capturable url', async () => {
    tabsGet.mockRejectedValue(new Error('no tab'));
    await expect(rpc('start_gif_recording', { tabId: 99 })).rejects.toThrow(
      /no such tab/,
    );

    tabsGet.mockResolvedValue({ id: 7, url: 'chrome://settings' });
    await expect(rpc('start_gif_recording', { tabId: 7 })).rejects.toThrow(
      /unsupported-page/,
    );
  });

  it('start_gif_recording fails closed on a declined confirmation', async () => {
    tabsGet.mockResolvedValue({ id: 7, url: 'https://x', title: 'X' });
    mocked.requestGifConfirmation.mockResolvedValue({ approved: false });
    await expect(rpc('start_gif_recording', { tabId: 7 })).rejects.toThrow(
      /declined or confirmation timed out/,
    );
    expect(mocked.startGifRecording).not.toHaveBeenCalled();
  });

  it('start_gif_recording starts silently when approved', async () => {
    tabsGet.mockResolvedValue({ id: 7, url: 'https://x', title: 'X' });
    mocked.requestGifConfirmation.mockResolvedValue({ approved: true, streamId: 's1' });
    const res = await rpc('start_gif_recording', { tabId: 7 });
    expect(mocked.startGifRecording).toHaveBeenCalledWith('s1', {
      tabId: 7,
      url: 'https://x',
      silent: true,
    });
    expect(res).toMatchObject({ ok: true, tabId: 7 });
  });

  it('stop_gif_recording returns the draftId when the DONE report already landed', async () => {
    mock(gifLastResult.getValue).mockResolvedValue({
      endedAt: Date.now() + 1e9,
      draftId: 'd1',
    } as never);
    const res = await rpc('stop_gif_recording', {});
    expect(res).toEqual({ ok: true, draftId: 'd1' });
  });

  it('stop_gif_recording eventually returns plain ok when nothing lands', async () => {
    mock(gifLastResult.getValue).mockResolvedValue(null);
    vi.useFakeTimers();
    try {
      const p = rpc('stop_gif_recording', {});
      const assertion = expect(p).resolves.toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(75 * 200);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('pause / resume / history round-trip', async () => {
    await expect(rpc('pause_gif_recording', {})).resolves.toEqual({ ok: true });
    expect(mocked.pauseGifRecording).toHaveBeenCalled();
    await expect(rpc('resume_gif_recording', {})).resolves.toEqual({ ok: true });
    mocked.listGifHistory.mockResolvedValue([{ id: 'g1' }] as never);
    await expect(rpc('list_gif_history', {})).resolves.toEqual({
      drafts: [{ id: 'g1' }],
    });
  });
});

describe('flow reads', () => {
  it('get_call scans recordings for the call id', async () => {
    await expect(rpc('get_call', {})).rejects.toThrow(/missing "callId"/);
    mocked.listRecordings.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }] as never);
    mocked.getCalls.mockImplementation(async (rid: string) =>
      rid === 'r2' ? [{ id: 'target', seq: 1 } as never] : [],
    );
    await expect(rpc('get_call', { callId: 'target' })).resolves.toEqual({
      call: { id: 'target', seq: 1 },
    });
    await expect(rpc('get_call', { callId: 'nope' })).resolves.toEqual({
      call: null,
    });
  });

  it('get_flow prefers stored deps, sorts by seq and passes through relevance', async () => {
    await expect(rpc('get_flow', {})).rejects.toThrow(/missing "id"/);
    mocked.getRecording.mockResolvedValue(null);
    await expect(rpc('get_flow', { id: 'r1' })).resolves.toEqual({ flow: null });

    mocked.getRecording.mockResolvedValue({
      id: 'r1',
      name: 'Flow',
      deps: [{ fromSeq: 1, toSeq: 2 }],
    } as never);
    mocked.getCalls.mockResolvedValue([
      { seq: 2, method: 'POST', url: 'https://a/2', status: 200 },
      { seq: 1, method: 'GET', url: 'https://a/1', status: 200, relevance: { verdict: 'irrelevant', role: 'telemetry' } },
    ] as never);
    const res = await rpc('get_flow', { id: 'r1' });
    expect(res.flow.steps.map((s: { seq: number }) => s.seq)).toEqual([1, 2]);
    expect(res.flow.steps[0]).toMatchObject({ relevance: { verdict: 'irrelevant' } });
    expect(res.flow.steps[1]).not.toHaveProperty('relevance');
    expect(res.flow.deps).toEqual([{ fromSeq: 1, toSeq: 2 }]);
    expect(mocked.getCalls).toHaveBeenCalledTimes(1); // no on-the-fly inference
  });

  it('get_endpoints falls back to on-the-fly inference when deps are missing', async () => {
    mocked.getRecording.mockResolvedValue({ id: 'r1', name: 'Flow' } as never);
    mocked.getCalls.mockResolvedValue([
      { seq: 1, method: 'POST', url: 'https://a/login', status: 200, reqBody: '{"user":"u"}' },
      { seq: 2, method: 'GET', url: 'https://a/me', status: 200 },
    ] as never);
    const res = await rpc('get_endpoints', { id: 'r1' });
    expect(Array.isArray(res.endpoints)).toBe(true);
    expect(res.endpoints.length).toBeGreaterThan(0);
  });
});

describe('gateway relay', () => {
  it('proxy_fetch / proxy_sse validate and relay to the gateway', async () => {
    await expect(rpc('proxy_fetch', { req: { method: 'GET' } } as never)).rejects.toThrow(
      /missing "url"/,
    );
    await expect(rpc('proxy_sse', { req: { url: 'https://x' } } as never)).rejects.toThrow(
      /missing "method"/,
    );
    mocked.runGatewayFetch.mockResolvedValue({ status: 200 } as never);
    mocked.runGatewaySse.mockResolvedValue({ events: [], endReason: 'complete' } as never);
    await rpc('proxy_fetch', {
      req: { method: 'GET', url: 'https://x' },
    } as never);
    expect(mocked.runGatewayFetch).toHaveBeenCalledWith({
      method: 'GET',
      url: 'https://x',
    });
    await rpc('proxy_sse', {
      req: { method: 'POST', url: 'https://x', stopOnData: '[DONE]' },
    } as never);
    expect(mocked.runGatewaySse).toHaveBeenCalledWith({
      method: 'POST',
      url: 'https://x',
      stopOnData: '[DONE]',
    });
  });

  it('proxy_rule returns the unmatched shape and forwards matched calls via "rule"', async () => {
    mocked.listGatewayProxyRules.mockResolvedValue([]);
    mocked.resolveProxyRule.mockReturnValue({
      ok: false,
      error: 'No matching proxy rule',
      status: 404,
    });
    const miss = await rpc('proxy_rule', {
      req: { method: 'GET', rawPath: '/x', headers: {}, body: null },
    } as never);
    expect(miss).toEqual({
      matched: false,
      error: 'No matching proxy rule',
      status: 404,
      statusText: '',
      headers: {},
      body: null,
      truncated: false,
    });
    expect(mocked.runGatewayFetch).not.toHaveBeenCalled();

    mocked.resolveProxyRule.mockReturnValue({
      ok: true,
      url: 'https://api.example.com/x',
      ruleId: 'p1',
    });
    mocked.runGatewayFetch.mockResolvedValue({ status: 200, body: 'hi' } as never);
    const hit = await rpc('proxy_rule', {
      req: { method: 'POST', rawPath: '/x', headers: { a: 'b' }, body: '{"q":1}' },
    } as never);
    expect(mocked.runGatewayFetch).toHaveBeenCalledWith(
      { method: 'POST', url: 'https://api.example.com/x', headers: { a: 'b' }, body: '{"q":1}' },
      { via: 'rule' },
    );
    expect(hit).toMatchObject({ matched: true, status: 200 });
  });

  it('add_proxy_rule validates and always creates enabled with authSource agent', async () => {
    await expect(
      rpc('add_proxy_rule', { targetBase: 'https://x' } as never),
    ).rejects.toThrow(/missing "sandboxPrefix"/);
    await expect(
      rpc('add_proxy_rule', { sandboxPrefix: '/api' } as never),
    ).rejects.toThrow(/missing "targetBase"/);

    mocked.addProxyRule.mockResolvedValue({ id: 'p1' } as never);
    await rpc('add_proxy_rule', {
      sandboxPrefix: '/api',
      targetBase: 'https://x',
      enabled: false,
    } as never);
    expect(mocked.addProxyRule).toHaveBeenCalledWith(
      { sandboxPrefix: '/api', targetBase: 'https://x', enabled: false },
      true,
      'agent',
    );
  });

  it('update_proxy_rule relays content patches only', async () => {
    await expect(rpc('update_proxy_rule', {} as never)).rejects.toThrow(/missing "id"/);
    mocked.updateProxyRuleContent.mockResolvedValue({ id: 'p1' } as never);
    await rpc('update_proxy_rule', { id: 'p1', patch: { targetBase: 'https://y' } });
    expect(mocked.updateProxyRuleContent).toHaveBeenCalledWith('p1', {
      targetBase: 'https://y',
    });
    await rpc('update_proxy_rule', { id: 'p1' });
    expect(mocked.updateProxyRuleContent).toHaveBeenLastCalledWith('p1', {});
  });

  it('set_proxy_port validates the range and persists', async () => {
    await expect(rpc('set_proxy_port', { proxyPort: 0 })).rejects.toThrow(
      /integer 1-65535/,
    );
    await expect(rpc('set_proxy_port', { proxyPort: 70000 })).rejects.toThrow(
      /integer 1-65535/,
    );
    await rpc('set_proxy_port', { proxyPort: 8080 });
    expect(mock(settings.proxyPort.setValue)).toHaveBeenCalledWith(8080);
  });
});

describe('actions', () => {
  const action = (over: Partial<Action> = {}): Action => ({
    id: 'a1',
    name: 'Login',
    description: 'Logs in',
    recordingId: 'r1',
    params: [],
    steps: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });

  it('list/search/get/delete summaries and misses', async () => {
    mocked.listActions.mockResolvedValue([
      action({ params: [{ name: 'u', type: 'string', required: true, description: 'd' }] }),
    ]);
    const listed = await rpc('list_actions', {});
    expect(listed.actions).toEqual([
      {
        id: 'a1',
        name: 'Login',
        description: 'Logs in',
        recordingId: 'r1',
        params: [{ name: 'u', type: 'string', required: true }],
        stepCount: 0,
        updatedAt: 1,
      },
    ]);

    await expect(rpc('get_action', {})).rejects.toThrow(/missing "id"/);
    mocked.getAction.mockResolvedValue(null);
    await expect(rpc('get_action', { id: 'a1' })).resolves.toEqual({ action: null });

    await expect(rpc('search_actions', { query: '  ' })).rejects.toThrow(
      /non-empty string/,
    );
    mocked.getAction.mockResolvedValue(null);
    const none = await rpc('search_actions', { query: 'zzz' });
    expect(none.actions).toEqual([]);
    mocked.listActionsByRecording.mockResolvedValue([action({ name: 'signup flow' })]);
    const scoped = await rpc('search_actions', {
      query: 'FLOW',
      recordingId: 'r1',
    });
    expect(mocked.listActionsByRecording).toHaveBeenCalledWith('r1');
    expect(scoped.actions[0]!.name).toBe('signup flow');

    mocked.getAction.mockResolvedValueOnce(action());
    await expect(rpc('delete_action', { id: 'a1' })).resolves.toEqual({ deleted: true });
    expect(mocked.deleteAction).toHaveBeenCalledWith('a1');
    mocked.getAction.mockResolvedValueOnce(null);
    await expect(rpc('delete_action', { id: 'a1' })).resolves.toEqual({ deleted: false });
  });

  it('create_action validates inputs, the recording, params and steps', async () => {
    await expect(
      rpc('create_action', { name: ' ', description: 'd', recordingId: 'r1' } as never),
    ).rejects.toThrow(/"name" must be a non-empty string/);
    await expect(
      rpc('create_action', { name: 'n', description: '', recordingId: 'r1' } as never),
    ).rejects.toThrow(/"description" must be a non-empty string/);
    await expect(
      rpc('create_action', { name: 'n', description: 'd' } as never),
    ).rejects.toThrow(/missing "recordingId"/);
    mocked.getRecording.mockResolvedValue(null);
    await expect(
      rpc('create_action', {
        name: 'n',
        description: 'd',
        recordingId: 'r9',
        steps: [{ callId: 'c1', kind: 'fetch' }],
      } as never),
    ).rejects.toThrow(/no recording with id "r9"/);
    mocked.getRecording.mockResolvedValue({ id: 'r1' } as never);
    mocked.getCalls.mockResolvedValue([]);
    await expect(
      rpc('create_action', {
        name: 'n',
        description: 'd',
        recordingId: 'r1',
        params: [{ name: 'u', type: 'weird' }],
      } as never),
    ).rejects.toThrow(/invalid type "weird"/);
    await expect(
      rpc('create_action', {
        name: 'n',
        description: 'd',
        recordingId: 'r1',
        steps: [{ callId: 'cX', kind: 'fetch' }],
      } as never),
    ).rejects.toThrow(/callId "cX" not found in recording "r1"/);
  });

  it('create_action stores a rebuilt action and strips smuggled param fields', async () => {
    mocked.getRecording.mockResolvedValue({ id: 'r1' } as never);
    mocked.getCalls.mockResolvedValue([{ id: 'c1' } as never]);
    const res = await rpc('create_action', {
      name: '  Login  ',
      description: '  do it  ',
      recordingId: 'r1',
      params: [
        {
          name: 'user',
          type: 'string',
          required: true,
          default: 'me',
          extra: 'smuggled',
        },
      ],
      steps: [{ callId: 'c1', kind: 'sse', waitMs: 100, outputs: { t: 'data[0].id' } }],
    });
    expect(mocked.upsertAction).toHaveBeenCalledTimes(1);
    const stored = mocked.upsertAction.mock.calls[0]![0] as unknown as Action;
    expect(stored.name).toBe('Login');
    expect(stored.description).toBe('do it');
    expect(stored.params).toEqual([
      { name: 'user', description: undefined, type: 'string', required: true, default: 'me' },
    ]);
    expect(stored.steps).toEqual([
      {
        callId: 'c1',
        kind: 'sse',
        overrides: undefined,
        waitMs: 100,
        outputs: { t: 'data[0].id' },
      },
    ]);
    expect(res.action.id).toBe(stored.id);
  });

  it('update_action patches content fields only and reports misses', async () => {
    await expect(rpc('update_action', {} as never)).rejects.toThrow(/missing "id"/);
    mocked.getAction.mockResolvedValue(null);
    await expect(
      rpc('update_action', { id: 'aX', patch: { name: 'x' } } as never),
    ).resolves.toEqual({ action: null });

    mocked.getCalls.mockResolvedValue([{ id: 'c1' }] as never);
    mocked.getAction.mockResolvedValue(action({ id: 'a1', recordingId: 'r1' }));
    mocked.upsertAction.mockImplementation(async (a) => a as never);
    await expect(
      rpc('update_action', { id: 'a1', patch: { name: '  ' } } as never),
    ).rejects.toThrow(/"name" must be a non-empty string/);
    await expect(
      rpc('update_action', { id: 'a1', patch: { steps: [{ callId: 'cX', kind: 'fetch' }] } } as never),
    ).rejects.toThrow(/not found in recording "r1"/);

    await rpc('update_action', {
      id: 'a1',
      patch: { name: '  Renamed ', description: 'new', steps: [{ callId: 'c1', kind: 'fetch' }] },
    });
    const stored = mocked.upsertAction.mock.calls[0]![0] as unknown as Action;
    expect(stored.name).toBe('Renamed');
    expect(stored.description).toBe('new');
    expect(stored.steps).toEqual([{ callId: 'c1', kind: 'fetch', overrides: undefined }]);
    expect(stored.recordingId).toBe('r1'); // never patchable
  });

  it('execute_action relays to the replay engine', async () => {
    await expect(rpc('execute_action', {} as never)).rejects.toThrow(/missing "id"/);
    mocked.getAction.mockResolvedValue(null);
    await expect(rpc('execute_action', { id: 'aX' } as never)).rejects.toThrow(
      /no action with id "aX"/,
    );
    mocked.getAction.mockResolvedValue(action());
    mocked.runAction.mockResolvedValue({ runId: 'run1' } as never);
    await expect(
      rpc('execute_action', { id: 'a1', params: { user: 'me' } } as never),
    ).resolves.toEqual({ run: { runId: 'run1' } });
    expect(mocked.runAction).toHaveBeenCalledWith(action(), { user: 'me' });
  });
});

describe('misc', () => {
  it('rejects an unknown method', async () => {
    await expect(rpc('nope' as never, {})).rejects.toThrow(/Unknown RPC method/);
  });
});
