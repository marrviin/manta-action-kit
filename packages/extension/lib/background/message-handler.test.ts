/**
 * Message-dispatch integration tests for the background handler. Everything
 * the switch talks to is injected (vi.fn()s) — no module mocks except the
 * storage singletons (readCaptureFx / screenshotPreview) — so routing, the
 * shared __error shaping, the screenshot choreography and the ack-before-
 * cleanup ordering are all exercised end to end.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock(import('@/lib/storage'), async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage')>();
  return {
    ...actual,
    readCaptureFx: vi.fn(async (): Promise<boolean> => false),
    screenshotPreview: {
      setValue: vi.fn(async () => undefined as unknown),
    } as unknown as typeof actual.screenshotPreview,
  };
});

import { createMessageHandler, type MessageHandlerDeps } from '@/lib/background/message-handler';
import { PLAY_SCREENSHOT_FX } from '@/lib/screenshot/focus-fx';
import { SCREENSHOT_PREVIEW_MAX_BYTES } from '@/lib/screenshot/types';
import { readCaptureFx, screenshotPreview } from '@/lib/storage';

const readFx = vi.mocked(readCaptureFx);
const previewSetValue = vi.mocked(screenshotPreview.setValue);

// -- chrome / browser stubs ---------------------------------------------------

const tabsQuery = vi.fn(
  async (..._a: unknown[]) => [{ id: 7, url: 'https://x' }] as unknown as chrome.tabs.Tab[],
);
const tabsCreate = vi.fn(async () => {});
const tabsSendMessage = vi.fn(async () => ({ played: true }));
const notificationsCreate = vi.fn(async () => 'n1');
const browserRelay = vi.fn(async () => ({ relayed: true }));

beforeEach(() => {
  vi.clearAllMocks();
  tabsQuery.mockResolvedValue([{ id: 7, url: 'https://x' }] as unknown as chrome.tabs.Tab[]);
  tabsSendMessage.mockResolvedValue({ played: true });
  browserRelay.mockResolvedValue({ relayed: true });
  readFx.mockResolvedValue(false);
  vi.stubGlobal('chrome', {
    tabs: { query: tabsQuery, create: tabsCreate, sendMessage: tabsSendMessage },
    notifications: { create: notificationsCreate },
    runtime: { getURL: (p: string) => `chrome-extension://test${p}` },
  });
  vi.stubGlobal('browser', {
    runtime: {
      getURL: (p: string) => `chrome-extension://test${p}`,
      sendMessage: browserRelay,
    },
    i18n: { getMessage: () => '' },
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// -- deps + dispatch helpers --------------------------------------------------

const defaults = (): MessageHandlerDeps =>
  ({
    session: {
      getState: vi.fn(async () => ({ status: 'idle' })),
      start: vi.fn(async () => ({ status: 'recording' })),
      stop: vi.fn(async () => ({ recordingId: 'r1', state: { count: 3 } })),
      setPaused: vi.fn(async () => ({ status: 'paused' })),
      push: vi.fn(async () => 42),
    },
    analyzeRecordingRelevance: vi.fn(async () => undefined),
    captureTabScreenshot: vi.fn(async () => ({
      dataUrl: 'data:image/png;base64,AAAA',
      filename: 'shot.png',
      stitched: true,
    })),
    saveScreenshotHistory: vi.fn(async () => 'h1'),
    listGatewayLogs: vi.fn(async () => []),
    clearGatewayLogs: vi.fn(async () => {}),
    listGatewayProxyRules: vi.fn(async () => []),
    deleteGatewayProxyRule: vi.fn(async () => {}),
    upsertGatewayProxyRule: vi.fn(async () => {}),
    addProxyRule: vi.fn(async () => ({ id: 'p1' })),
    updateProxyRuleContent: vi.fn(async () => ({ id: 'p1', enabled: false })),
    requestGatewayConfirmation: vi.fn(async () => true),
    isPendingConfirmation: vi.fn(() => true),
    resizeGatewayConfirmation: vi.fn(() => true),
    resolveGatewayConfirmation: vi.fn(() => true),
    startGifRecording: vi.fn(async () => ({ ok: true })),
    stopGifRecording: vi.fn(async () => ({ ok: true })),
    pauseGifRecording: vi.fn(async () => ({ ok: true })),
    resumeGifRecording: vi.fn(async () => ({ ok: true })),
    handleGifOffscreenDone: vi.fn(async () => undefined),
    resolveGifConfirmation: vi.fn(() => true),
    isPendingGifConfirmation: vi.fn(() => true),
    ensureLayaRuntime: vi.fn(async () => undefined),
  }) as unknown as MessageHandlerDeps;

const fn = (f: unknown): ReturnType<typeof vi.fn> => f as ReturnType<typeof vi.fn>;

function makeHandler(deps = defaults()) {
  const handler = createMessageHandler(deps);
  const dispatch = (msg: unknown, sender: chrome.runtime.MessageSender = {}) =>
    new Promise<any>((resolve) => {
      handler(msg, sender, resolve);
    });
  return { handler, dispatch, deps };
}

const anyDeps = defaults; // fresh per test

describe('routing + ack shapes', () => {
  it('PING answers PONG without touching any dep', async () => {
    const { dispatch, deps } = makeHandler();
    await expect(dispatch({ type: 'PING' })).resolves.toMatchObject({
      type: 'PONG',
    });
    expect(fn(deps.session.getState)).not.toHaveBeenCalled();
  });

  it('relays recording session calls with their payloads', async () => {
    const { dispatch, deps } = makeHandler();
    await expect(dispatch({ type: 'GET_RECORDING_STATE' })).resolves.toEqual({
      status: 'idle',
    });
    await expect(
      dispatch({ type: 'START_RECORDING', data: { tabId: 1 } }),
    ).resolves.toEqual({ status: 'recording' });
    expect(fn(deps.session.start)).toHaveBeenCalledWith({ tabId: 1 });
    await expect(
      dispatch({ type: 'SET_PAUSED', data: { paused: true } }),
    ).resolves.toEqual({ status: 'paused' });
    await expect(
      dispatch(
        { type: 'API_CALL_CAPTURED', data: { call: {} } },
        { tab: { id: 9 } } as unknown as chrome.runtime.MessageSender,
      ),
    ).resolves.toEqual({ ok: true, count: 42 });
    expect(fn(deps.session.push)).toHaveBeenCalledWith({ call: {} }, 9);
  });

  it('LAYA relays go through browser.runtime with the raw message', async () => {
    const { dispatch, deps } = makeHandler();
    const raw = { type: 'LAYA_PREDICT', data: { states: [1] } };
    await expect(dispatch(raw)).resolves.toEqual({ relayed: true });
    expect(fn(deps.ensureLayaRuntime)).toHaveBeenCalledTimes(1);
    expect(fn(browserRelay)).toHaveBeenCalledWith(raw);

    // batch uses the same relay
    await dispatch({ type: 'LAYA_PREDICT_BATCH', data: { states: [] } });
    expect(fn(deps.ensureLayaRuntime)).toHaveBeenCalledTimes(2);

    // keepalive is a no-op receipt
    await expect(dispatch({ type: 'LAYA_KEEPALIVE' })).resolves.toEqual({
      ok: true,
    });
    expect(fn(deps.ensureLayaRuntime)).toHaveBeenCalledTimes(2);
  });

  it('LAYA_GET_STATUS relays but never spawns the runtime; a dead relay means "not loaded"', async () => {
    const { dispatch, deps } = makeHandler();
    await dispatch({ type: 'LAYA_GET_STATUS' });
    expect(fn(deps.ensureLayaRuntime)).not.toHaveBeenCalled();
    expect(fn(browserRelay)).toHaveBeenCalledTimes(1);

    browserRelay.mockRejectedValue(new Error('no listener'));
    await expect(dispatch({ type: 'LAYA_GET_STATUS' })).resolves.toEqual({
      ready: false,
      loading: false,
    });
  });

  it('gateway confirm lifecycle: decision, ping, resize and the debug test gate', async () => {
    const { dispatch, deps } = makeHandler();
    await expect(
      dispatch({
        type: 'GATEWAY_CONFIRM_DECISION',
        data: { id: 'g1', approved: true },
      }),
    ).resolves.toEqual({ ok: true });
    expect(fn(deps.resolveGatewayConfirmation)).toHaveBeenCalledWith('g1', true);

    await expect(
      dispatch({ type: 'GATEWAY_CONFIRM_PING', data: { id: 'g1' } }),
    ).resolves.toEqual({ ok: true });

    await expect(
      dispatch({ type: 'GATEWAY_CONFIRM_RESIZE', data: { id: 'g1', height: 400 } }),
    ).resolves.toEqual({ ok: true });

    await expect(dispatch({ type: 'GATEWAY_CONFIRM_TEST' })).resolves.toEqual({
      approved: true,
    });
    expect(fn(deps.requestGatewayConfirmation)).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'https://example.com/api/test-confirmation',
        via: 'agent',
      }),
    );
  });

  it('gif confirm decision + ping', async () => {
    const { dispatch, deps } = makeHandler();
    await expect(
      dispatch({
        type: 'GIF_CONFIRM_DECISION',
        data: { id: 'c1', approved: true, streamId: 's1' },
      }),
    ).resolves.toEqual({ ok: true });
    expect(fn(deps.resolveGifConfirmation)).toHaveBeenCalledWith(
      'c1',
      true,
      's1',
      undefined,
    );
    await expect(
      dispatch({ type: 'GIF_CONFIRM_PING', data: { id: 'c1' } }),
    ).resolves.toEqual({ ok: true });
  });

  it('gif start/stop/pause/resume forward to the session module', async () => {
    const { dispatch, deps } = makeHandler();
    await dispatch({
      type: 'START_GIF_RECORDING',
      data: { streamId: 's1', tabId: 3, url: 'https://x', silent: true },
    });
    expect(fn(deps.startGifRecording)).toHaveBeenCalledWith('s1', {
      tabId: 3,
      url: 'https://x',
      silent: true,
    });
    await dispatch({ type: 'STOP_GIF_RECORDING' });
    await dispatch({ type: 'PAUSE_GIF_RECORDING' });
    await dispatch({ type: 'RESUME_GIF_RECORDING' });
    expect(fn(deps.stopGifRecording)).toHaveBeenCalledTimes(1);
    expect(fn(deps.pauseGifRecording)).toHaveBeenCalledTimes(1);
    expect(fn(deps.resumeGifRecording)).toHaveBeenCalledTimes(1);
  });

  it('gateway log/rule reads and deletes', async () => {
    const { dispatch, deps } = makeHandler();
    await expect(dispatch({ type: 'LIST_GATEWAY_LOGS' })).resolves.toEqual({
      logs: [],
    });
    await expect(dispatch({ type: 'CLEAR_GATEWAY_LOGS' })).resolves.toEqual({
      ok: true,
    });
    await expect(
      dispatch({ type: 'LIST_GATEWAY_PROXY_RULES' }),
    ).resolves.toEqual({ rules: [] });
    await expect(
      dispatch({ type: 'DELETE_GATEWAY_PROXY_RULE', data: { id: 'p1' } }),
    ).resolves.toEqual({ ok: true });
    expect(fn(deps.deleteGatewayProxyRule)).toHaveBeenCalledWith('p1');
  });

  it('ADD_GATEWAY_PROXY_RULE succeeds as a user rule and shapes validation errors', async () => {
    const { dispatch, deps } = makeHandler();
    await expect(
      dispatch({
        type: 'ADD_GATEWAY_PROXY_RULE',
        data: { sandboxPrefix: '/api', targetBase: 'https://api.example.com' },
      }),
    ).resolves.toEqual({ rule: { id: 'p1' } });
    expect(fn(deps.addProxyRule)).toHaveBeenCalledWith(
      { sandboxPrefix: '/api', targetBase: 'https://api.example.com' },
      true,
      'user',
    );

    fn(deps.addProxyRule).mockRejectedValueOnce(new Error('/api is already used'));
    await expect(
      dispatch({
        type: 'ADD_GATEWAY_PROXY_RULE',
        data: { sandboxPrefix: '/api', targetBase: 'https://x' },
      }),
    ).resolves.toEqual({ __error: '/api is already used' });
  });

  it('UPDATE_GATEWAY_PROXY_RULE applies the content patch, then the enabled toggle', async () => {
    const { dispatch, deps } = makeHandler();
    const dep = fn(deps.updateProxyRuleContent);
    dep.mockResolvedValue({ id: 'p1', enabled: false });

    // enabled flip → extra upsert with the toggled rule
    await expect(
      dispatch({
        type: 'UPDATE_GATEWAY_PROXY_RULE',
        data: { id: 'p1', patch: { targetBase: 'https://new', enabled: true } },
      }),
    ).resolves.toEqual({ rule: { id: 'p1', enabled: true } });
    expect(dep).toHaveBeenCalledWith('p1', { targetBase: 'https://new' });
    expect(fn(deps.upsertGatewayProxyRule)).toHaveBeenCalledWith({
      id: 'p1',
      enabled: true,
    });

    // no enabled in patch → no upsert
    fn(deps.upsertGatewayProxyRule).mockClear();
    await dispatch({
      type: 'UPDATE_GATEWAY_PROXY_RULE',
      data: { id: 'p1', patch: { targetBase: 'https://new2' } },
    });
    expect(fn(deps.upsertGatewayProxyRule)).not.toHaveBeenCalled();

    // validator failure → shaped __error
    dep.mockRejectedValueOnce(new Error('Prefix is already used'));
    await expect(
      dispatch({
        type: 'UPDATE_GATEWAY_PROXY_RULE',
        data: { id: 'p1', patch: {} },
      }),
    ).resolves.toEqual({ __error: 'Prefix is already used' });
  });

  it('one-shot inspector bridge tokens: mint → use → replay is refused', async () => {
    const { handler } = makeHandler();
    const token = await new Promise<string>((resolve) => {
      handler({ type: 'INSPECTOR_BRIDGE_MINT_TOKEN' }, {}, (r: any) =>
        resolve(r.token),
      );
    });
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    // first use consumes it
    await expect(
      new Promise<any>((r) =>
        handler(
          { type: 'INSPECTOR_BRIDGE_USE_TOKEN', data: { token } },
          {},
          r,
        ),
      ),
    ).resolves.toEqual({ ok: true });
    // replay of the same token fails
    await expect(
      new Promise<any>((r) =>
        handler(
          { type: 'INSPECTOR_BRIDGE_USE_TOKEN', data: { token } },
          {},
          r,
        ),
      ),
    ).resolves.toEqual({ ok: false });
    // unknown token also refused
    await expect(
      new Promise<any>((r) =>
        handler(
          { type: 'INSPECTOR_BRIDGE_USE_TOKEN', data: { token: 'nope' } },
          {},
          r,
        ),
      ),
    ).resolves.toEqual({ ok: false });
  });
});

describe('INSPECTOR_CAPTURE_RELAY_* (child-frame capture relay)', () => {
  const tab = (id: number) => ({ tab: { id } }) as chrome.runtime.MessageSender;

  it('mint → use consumes the token once; replays and foreign tabs are refused', async () => {
    const { dispatch } = makeHandler();
    const sender = tab(5);
    const mint = () =>
      dispatch({
        type: 'INSPECTOR_CAPTURE_RELAY_MINT',
        data: { req: { point: { x: 1, y: 2 } } },
      }, sender);
    const token = (await mint()).token;
    expect(token).toMatch(/^[0-9a-f-]{36}$/);

    // first use hands the bound request to the same tab
    await expect(
      dispatch({ type: 'INSPECTOR_CAPTURE_RELAY_USE', data: { token } }, sender),
    ).resolves.toEqual({ ok: true, req: { point: { x: 1, y: 2 } } });
    // replay of the same token is refused
    await expect(
      dispatch({ type: 'INSPECTOR_CAPTURE_RELAY_USE', data: { token } }, sender),
    ).resolves.toEqual({ ok: false });

    // a fresh token minted for tab 5 cannot be used by tab 6 …
    const token2 = (await mint()).token;
    await expect(
      dispatch({ type: 'INSPECTOR_CAPTURE_RELAY_USE', data: { token: token2 } }, tab(6)),
    ).resolves.toEqual({ ok: false });
    // … but is still intact for tab 5
    await expect(
      dispatch({ type: 'INSPECTOR_CAPTURE_RELAY_USE', data: { token: token2 } }, sender),
    ).resolves.toMatchObject({ ok: true });

    // unknown token refused
    await expect(
      dispatch({ type: 'INSPECTOR_CAPTURE_RELAY_USE', data: { token: 'nope' } }, sender),
    ).resolves.toEqual({ ok: false });
  });

  it('mint without a sender tab yields an empty token (nothing to relay into)', async () => {
    const { dispatch } = makeHandler();
    await expect(
      dispatch({ type: 'INSPECTOR_CAPTURE_RELAY_MINT', data: { req: {} } }),
    ).resolves.toEqual({ token: '' });
  });

  it('RESULT from the minting tab resolves a parked AWAIT exactly once', async () => {
    const { dispatch } = makeHandler();
    const sender = tab(5);
    const { token } = await dispatch(
      { type: 'INSPECTOR_CAPTURE_RELAY_MINT', data: { req: { all: true } } },
      sender,
    );
    const awaited = dispatch(
      { type: 'INSPECTOR_CAPTURE_RELAY_AWAIT', data: { token } },
      sender,
    );
    // no result yet → the AWAIT parks (does not settle on its own)
    await expect(
      Promise.race([
        awaited.then(() => 'settled' as const),
        new Promise((r) => setTimeout(() => r('parked' as const), 20)),
      ]),
    ).resolves.toBe('parked');

    const result = { ok: true as const, captureId: 'e1', elementCount: 3 };
    await expect(
      dispatch({ type: 'INSPECTOR_CAPTURE_RELAY_RESULT', data: { token, result } }, sender),
    ).resolves.toEqual({ ok: true });
    await expect(awaited).resolves.toEqual(result);

    // a late duplicate RESULT never settles the already-resolved channel again…
    await expect(
      dispatch(
        { type: 'INSPECTOR_CAPTURE_RELAY_RESULT', data: { token, result: { ok: false } } },
        sender,
      ),
    ).resolves.toEqual({ ok: true });
    // … and AWAIT now answers immediately from the stored result
    await expect(
      dispatch({ type: 'INSPECTOR_CAPTURE_RELAY_AWAIT', data: { token } }, sender),
    ).resolves.toEqual(result);
  });

  it('RESULT from a foreign tab is acked but never stored, so the AWAIT keeps waiting', async () => {
    const { dispatch } = makeHandler();
    const sender = tab(5);
    const { token } = await dispatch(
      { type: 'INSPECTOR_CAPTURE_RELAY_MINT', data: { req: {} } },
      sender,
    );
    const awaited = dispatch(
      { type: 'INSPECTOR_CAPTURE_RELAY_AWAIT', data: { token } },
      sender,
    );
    await expect(
      dispatch(
        { type: 'INSPECTOR_CAPTURE_RELAY_RESULT', data: { token, result: { ok: true } } },
        tab(6),
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      Promise.race([
        awaited.then(() => 'settled' as const),
        new Promise((r) => setTimeout(() => r('parked' as const), 20)),
      ]),
    ).resolves.toBe('parked');
  });

  it('an unanswered relay times the AWAIT out and the token is gone afterwards', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { dispatch } = makeHandler();
      const sender = tab(5);
      const { token } = await dispatch(
        { type: 'INSPECTOR_CAPTURE_RELAY_MINT', data: { req: { selector: 'x' } } },
        sender,
      );
      const awaited = dispatch(
        { type: 'INSPECTOR_CAPTURE_RELAY_AWAIT', data: { token } },
        sender,
      );
      vi.advanceTimersByTime(20_000);
      await expect(awaited).resolves.toEqual({
        ok: false,
        error: 'capture relay timed out',
      });
      // the TTL deleted the token: the child's late RESULT is refused …
      await expect(
        dispatch(
          { type: 'INSPECTOR_CAPTURE_RELAY_RESULT', data: { token, result: { ok: true } } },
          sender,
        ),
      ).resolves.toEqual({ ok: false });
      // … and a new AWAIT reports expiry instead of parking
      await expect(
        dispatch({ type: 'INSPECTOR_CAPTURE_RELAY_AWAIT', data: { token } }, sender),
      ).resolves.toEqual({ ok: false, error: 'capture relay expired' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('STOP_RECORDING side effects', () => {
  it('notifies + fires the relevance analysis when a recording was saved', async () => {
    const { dispatch, deps } = makeHandler();
    const res = await dispatch({ type: 'STOP_RECORDING' });
    expect(res).toMatchObject({ recordingId: 'r1', state: { count: 3 } });
    expect(notificationsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.any(String) }),
    );
    await vi.waitFor(() =>
      expect(fn(deps.analyzeRecordingRelevance)).toHaveBeenCalledWith('r1'),
    );
  });

  it('no notification / analysis when nothing was recorded', async () => {
    const { dispatch, deps } = makeHandler();
    fn(deps.session.stop).mockResolvedValue({
      recordingId: null,
      state: { count: 0 },
    });
    await dispatch({ type: 'STOP_RECORDING' });
    expect(notificationsCreate).not.toHaveBeenCalled();
    expect(fn(deps.analyzeRecordingRelevance)).not.toHaveBeenCalled();
  });

  it('RUN_RECORDING_RELEVANCE answers immediately and swallows analysis errors', async () => {
    const { dispatch, deps } = makeHandler();
    fn(deps.analyzeRecordingRelevance).mockRejectedValue(new Error('model OOM'));
    await expect(
      dispatch({
        type: 'RUN_RECORDING_RELEVANCE',
        data: { recordingId: 'r2' },
      }),
    ).resolves.toEqual({ started: true });
    await vi.waitFor(() =>
      expect(fn(deps.analyzeRecordingRelevance)).toHaveBeenCalledWith('r2'),
    );
  });
});

describe('CAPTURE_SCREENSHOT choreography', () => {
  const shot = (over: Record<string, unknown> = {}) => ({
    dataUrl: 'data:image/png;base64,AAAA',
    filename: 'shot.png',
    stitched: true,
    ...over,
  });

  it('full happy path: preview handoff → history → preview tab addressed by id', async () => {
    const { dispatch, deps } = makeHandler();
    fn(deps.captureTabScreenshot).mockResolvedValue(shot());
    await expect(
      dispatch({ type: 'CAPTURE_SCREENSHOT', data: { mode: 'visible' } }),
    ).resolves.toEqual({ ok: true });
    expect(previewSetValue).toHaveBeenCalledWith(shot());
    expect(fn(deps.saveScreenshotHistory)).toHaveBeenCalledWith(
      'data:image/png;base64,AAAA',
      'shot.png',
    );
    expect(tabsCreate).toHaveBeenCalledWith({
      url: 'chrome-extension://test/preview.html?mode=screenshot&id=h1',
    });
  });

  it('no active tab → ScreenshotError + a failure notification (popup is gone)', async () => {
    const { dispatch } = makeHandler();
    tabsQuery.mockResolvedValue([]);
    const res = await dispatch({
      type: 'CAPTURE_SCREENSHOT',
      data: { mode: 'visible' },
    });
    expect(res.__error).toMatch(/screenshot:unsupported-page/);
    expect(notificationsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.any(String) }),
    );
  });

  it('an oversized capture is rejected with preview-too-large before any handoff', async () => {
    const { dispatch, deps } = makeHandler();
    fn(deps.captureTabScreenshot).mockResolvedValue(
      shot({ dataUrl: 'x'.repeat(SCREENSHOT_PREVIEW_MAX_BYTES + 1) }),
    );
    const res = await dispatch({
      type: 'CAPTURE_SCREENSHOT',
      data: { mode: 'fullPage' },
    });
    expect(res.__error).toMatch(/screenshot:preview-too-large/);
    expect(previewSetValue).not.toHaveBeenCalled();
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it('a failed history save still opens the preview (session handoff survives)', async () => {
    const { dispatch, deps } = makeHandler();
    fn(deps.saveScreenshotHistory).mockRejectedValue(new Error('idb full'));
    await dispatch({ type: 'CAPTURE_SCREENSHOT', data: { mode: 'visible' } });
    expect(tabsCreate).toHaveBeenCalledWith({
      url: 'chrome-extension://test/preview.html',
    });
  });

  it('non-stitched capture with fx enabled plays the fx and waits for it', async () => {
    const { dispatch, deps } = makeHandler();
    fn(deps.captureTabScreenshot).mockResolvedValue(shot({ stitched: false }));
    readFx.mockResolvedValue(true);
    await dispatch({ type: 'CAPTURE_SCREENSHOT', data: { mode: 'visible' } });
    expect(tabsSendMessage).toHaveBeenCalledWith(
      7,
      { type: PLAY_SCREENSHOT_FX },
      // fx is a viewport-level visual — top frame only.
      { frameId: 0 },
    );
    // fx reported played → the preview still opens (after the recovery beat)
    expect(tabsCreate).toHaveBeenCalledTimes(1);
  });

  it('fx disabled → no content-script ping at all', async () => {
    const { dispatch, deps } = makeHandler();
    fn(deps.captureTabScreenshot).mockResolvedValue(shot({ stitched: false }));
    await dispatch({ type: 'CAPTURE_SCREENSHOT', data: { mode: 'visible' } });
    expect(tabsSendMessage).not.toHaveBeenCalled();
    expect(tabsCreate).toHaveBeenCalledTimes(1);
  });
});

describe('INSPECTOR_CAPTURE_PREVIEW_READY', () => {
  it('opens the element preview addressed by captureId', async () => {
    const { dispatch } = makeHandler();
    await dispatch({
      type: 'INSPECTOR_CAPTURE_PREVIEW_READY',
      data: { captureId: 'e1', preview: true },
    });
    expect(tabsCreate).toHaveBeenCalledWith({
      url: 'chrome-extension://test/preview.html?mode=element&id=e1',
    });
  });

  it('agent captures (preview:false) stay silent', async () => {
    const { dispatch } = makeHandler();
    await dispatch({
      type: 'INSPECTOR_CAPTURE_PREVIEW_READY',
      data: { captureId: 'e1', preview: false },
    });
    expect(tabsCreate).not.toHaveBeenCalled();
  });
});

describe('GIF_OFFSCREEN_DONE + error shaping', () => {
  it('acks the offscreen sender BEFORE running the cleanup', async () => {
    const { handler, deps } = makeHandler();
    let release!: () => void;
    fn(deps.handleGifOffscreenDone).mockReturnValue(
      new Promise((r) => (release = () => r(undefined))),
    );
    const responses: unknown[] = [];
    handler(
      { type: 'GIF_OFFSCREEN_DONE', data: { ok: true, draftId: 'd1' } },
      {},
      (r) => responses.push(r),
    );
    // the ack is synchronous — before the cleanup even starts
    expect(responses).toEqual([{ ok: true }]);
    release();
    await vi.waitFor(() =>
      expect(fn(deps.handleGifOffscreenDone)).toHaveBeenCalledWith({
        ok: true,
        draftId: 'd1',
      }),
    );
  });

  it('a throwing handler still answers with __error so the caller never hangs', async () => {
    const { dispatch, deps } = makeHandler();
    fn(deps.stopGifRecording).mockRejectedValue(new Error('boom'));
    await expect(dispatch({ type: 'STOP_GIF_RECORDING' })).resolves.toEqual({
      __error: 'boom',
    });
  });

  it('a non-Error rejection is stringified into __error', async () => {
    const { dispatch, deps } = makeHandler();
    fn(deps.session.start).mockRejectedValue('plain string');
    await expect(dispatch({ type: 'START_RECORDING', data: {} })).resolves.toEqual({
      __error: 'plain string',
    });
  });
});
