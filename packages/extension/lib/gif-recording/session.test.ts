/**
 * GIF session state-machine tests (chrome.* / browser.* / messaging mocked):
 * start reservation + rollback on offscreen refusal, stop/pause/resume
 * transitions, the orphan-watch reconcile (stuck state healed + alarm cleared),
 * and the DONE report ordering (lastResult written before state cleared).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/messaging', () => ({
  sendMessage: vi.fn(async () => undefined as unknown),
}));
vi.mock('@/lib/ai/laya-session', () => ({
  closeLayaOffscreenDocument: vi.fn(async () => undefined as unknown),
}));

import {
  handleGifOffscreenDone,
  initGifStateWatch,
  pauseGifRecording,
  resumeGifRecording,
  startGifRecording,
  stopGifRecording,
} from '@/lib/gif-recording/session';
import { GifRecordingError } from '@/lib/gif-recording/types';
import { sendMessage } from '@/lib/messaging';
import { closeLayaOffscreenDocument } from '@/lib/ai/laya-session';

const send = sendMessage as unknown as ReturnType<typeof vi.fn>;
const closeDoc = vi.mocked(closeLayaOffscreenDocument);

// -- chrome / browser stubs ---------------------------------------------------

const stateStore = {
  value: null as unknown,
  getValue: vi.fn(async () => stateStore.value),
  setValue: vi.fn(async (v: unknown) => {
    stateStore.value = v;
  }),
};
const lastResultStore = {
  value: null as unknown,
  getValue: vi.fn(async () => lastResultStore.value),
  setValue: vi.fn(async (v: unknown) => {
    lastResultStore.value = v;
  }),
};

vi.mock('@/lib/storage', () => ({
  gifRecordingState: {
    getValue: (...a: unknown[]) => stateStore.getValue(...(a as [])),
    setValue: (...a: [unknown]) => stateStore.setValue(...a),
  },
  gifLastResult: {
    getValue: (...a: unknown[]) => lastResultStore.getValue(...(a as [])),
    setValue: (...a: [unknown]) => lastResultStore.setValue(...a),
  },
}));

const getContexts = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const createDocument = vi.fn(async () => {});
const alarmsCreate = vi.fn();
const alarmsClear = vi.fn(async () => {});
const notificationsCreate = vi.fn(async () => 'n1');
const tabsQuery = vi.fn(async () => [{ id: 1, url: 'https://x' }]);
const tabsCreate = vi.fn(async () => {});

let alarmListener: ((alarm: { name: string }) => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  stateStore.value = null;
  lastResultStore.value = null;
  getContexts.mockResolvedValue([]);
  send.mockResolvedValue(undefined as unknown);
  vi.stubGlobal('chrome', {
    alarms: { onAlarm: { addListener: (f: typeof alarmListener) => (alarmListener = f) }, create: alarmsCreate, clear: alarmsClear },
    runtime: {
      getContexts,
      getURL: (p: string) => `chrome-extension://test${p}`,
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
    },
    offscreen: { createDocument, Reason: { DISPLAY_MEDIA: 'DISPLAY_MEDIA' } },
    notifications: { create: notificationsCreate },
    tabs: { query: tabsQuery, create: tabsCreate },
  });
  vi.stubGlobal('browser', {
    runtime: { getURL: (p: string) => `chrome-extension://test${p}` },
    i18n: { getMessage: () => '' },
  });
});

const recording = (over: Record<string, unknown> = {}) => ({
  status: 'recording',
  startedAt: 1,
  tabId: 1,
  ...over,
});

describe('startGifRecording', () => {
  it('rejects a second recording while one is in progress', async () => {
    stateStore.value = recording();
    await expect(startGifRecording('s1')).rejects.toThrow(GifRecordingError);
    expect(createDocument).not.toHaveBeenCalled();
  });

  it('reserves state BEFORE creating the document, and rolls back on refusal', async () => {
    // simulate the streamId having expired offscreen
    send.mockRejectedValueOnce(new Error('streamId expired'));
    await expect(startGifRecording('s1', { tabId: 7, url: 'https://x' })).rejects.toThrow(
      /start-failed|streamId expired/,
    );
    // rollback: popup returns to idle instead of showing REC forever
    expect(stateStore.value).toBeNull();

    // happy path: state was written before the document creation
    stateStore.value = null;
    await startGifRecording('s1', { tabId: 7, url: 'https://x', silent: true });
    const reserveOrder = stateStore.setValue.mock.invocationCallOrder[0]!;
    const createOrder = createDocument.mock.invocationCallOrder[0]!;
    expect(reserveOrder).toBeLessThan(createOrder);
    expect(stateStore.value).toMatchObject({ status: 'recording', tabId: 7, silent: true });
    expect(alarmsCreate).toHaveBeenCalledWith('gif-state-watch', { periodInMinutes: 1 });
    expect(send).toHaveBeenCalledWith('GIF_OFFSCREEN_START', { streamId: 's1', url: 'https://x' });
  });

  it('derives the tab from the active window on the popup path', async () => {
    await startGifRecording('s1');
    expect(tabsQuery).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(stateStore.value).toMatchObject({ tabId: 1 });
  });
});

describe('stop / pause / resume', () => {
  it('stop throws not-recording from an idle state', async () => {
    await expect(stopGifRecording()).rejects.toThrow(GifRecordingError);
  });

  it('stop resets to idle when offscreen is unreachable', async () => {
    stateStore.value = recording();
    send.mockRejectedValueOnce(new Error('no listener'));
    await expect(stopGifRecording()).rejects.toThrow(/no listener/);
    expect(stateStore.value).toBeNull();
  });

  it('stop acks offscreen then clears state + the watch alarm', async () => {
    stateStore.value = recording();
    await expect(stopGifRecording()).resolves.toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith('GIF_OFFSCREEN_STOP', undefined);
    expect(stateStore.value).toBeNull();
    expect(alarmsClear).toHaveBeenCalledWith('gif-state-watch');
  });

  it('pause/resume are idempotent and forward to offscreen otherwise', async () => {
    stateStore.value = recording();
    await expect(pauseGifRecording()).resolves.toEqual({ ok: true });
    expect(stateStore.value).toMatchObject({ status: 'paused' });
    // already paused → no second offscreen round-trip
    await pauseGifRecording();
    expect(send).toHaveBeenCalledTimes(1);

    // paused → resume forwards and flips the phase back
    await resumeGifRecording();
    expect(send).toHaveBeenLastCalledWith('GIF_OFFSCREEN_RESUME', undefined);
    expect(stateStore.value).toMatchObject({ status: 'recording' });
    // already recording → resume again is a no-op
    await resumeGifRecording();
    expect(send).toHaveBeenCalledTimes(2);

    stateStore.value = null;
    await expect(pauseGifRecording()).rejects.toThrow(GifRecordingError);
  });
});

describe('orphan watch (reconcile)', () => {
  it('registers a listener that only reacts to the gif-state-watch alarm', async () => {
    initGifStateWatch();
    expect(alarmListener).toBeDefined();
    // a foreign alarm must not even read state
    await alarmListener!({ name: 'other-alarm' });
    expect(stateStore.getValue).not.toHaveBeenCalled();
  });

  it('heals a stuck recording state when the offscreen document is gone', async () => {
    stateStore.value = recording();
    getContexts.mockResolvedValue([]); // no offscreen document
    initGifStateWatch();
    // the listener fires reconcile void-ed — invoke it, then flush the chain
    await alarmListener!({ name: 'gif-state-watch' });
    await vi.waitFor(() => expect(stateStore.value).toBeNull());
    expect(alarmsClear).toHaveBeenCalledWith('gif-state-watch');
    expect(notificationsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(/failed/i) }),
    );
  });

  it('leaves a healthy recording alone', async () => {
    stateStore.value = recording();
    getContexts.mockResolvedValue([{ contextType: 'OFFSCREEN_DOCUMENT' }]);
    initGifStateWatch();
    await alarmListener!({ name: 'gif-state-watch' });
    await new Promise((r) => setTimeout(r, 5));
    expect(stateStore.value).toMatchObject({ status: 'recording' });
    expect(alarmsClear).not.toHaveBeenCalled();
    expect(notificationsCreate).not.toHaveBeenCalled();
  });
});

describe('handleGifOffscreenDone', () => {
  it('records lastResult BEFORE clearing state (SW-sleep-proof)', async () => {
    stateStore.value = recording({ silent: true });
    await handleGifOffscreenDone({ ok: true, savedForPreview: true, draftId: 'd1' });
    const lastOrder = lastResultStore.setValue.mock.invocationCallOrder[0]!;
    const clearOrder = stateStore.setValue.mock.invocationCallOrder[0]!;
    expect(lastOrder).toBeLessThan(clearOrder);
    expect(lastResultStore.value).toMatchObject({ draftId: 'd1', ok: true });
    expect(stateStore.value).toBeNull();
  });

  it('silent mode: teardown only — no preview tab, no success notification', async () => {
    stateStore.value = recording({ silent: true });
    await handleGifOffscreenDone({ ok: true, savedForPreview: true, draftId: 'd1' });
    expect(tabsCreate).not.toHaveBeenCalled();
    expect(notificationsCreate).not.toHaveBeenCalled();
    expect(closeDoc).toHaveBeenCalled();
  });

  it('interactive success opens the preview tab addressed by draftId', async () => {
    stateStore.value = recording();
    await handleGifOffscreenDone({ ok: true, savedForPreview: true, draftId: 'd1' });
    expect(tabsCreate).toHaveBeenCalledWith({
      url: 'chrome-extension://test/preview.html?mode=gif&id=d1',
    });
    expect(notificationsCreate).not.toHaveBeenCalled(); // no time limit hit
  });

  it('a time-limit hit tells the user why (non-silent only)', async () => {
    stateStore.value = recording();
    await handleGifOffscreenDone({ ok: true, savedForPreview: true, hitTimeLimit: true });
    expect(notificationsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(/time limit/i) }),
    );

    stateStore.value = recording({ silent: true });
    notificationsCreate.mockClear();
    await handleGifOffscreenDone({ ok: true, savedForPreview: true, hitTimeLimit: true });
    expect(notificationsCreate).not.toHaveBeenCalled();
  });

  it('a failed report notifies even in silent mode (no caller left waiting)', async () => {
    stateStore.value = recording({ silent: true });
    await handleGifOffscreenDone({ ok: false });
    expect(notificationsCreate).toHaveBeenCalled();
    expect(closeDoc).toHaveBeenCalled();
  });
});
