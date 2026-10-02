/**
 * Tests for the GIF recording session orchestration (session.ts) — the
 * background-side state machine. The extension/storage/messaging surfaces are
 * mocked in-memory; the assertions cover the agent-driven `silent` mode and
 * the `gifLastResult` write-through (both added for the capture RPC tools).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory fake of the two session-scoped storage items.
const stateData = { current: null as unknown };
const lastResultData = { current: null as unknown };
vi.mock('@/lib/storage', () => ({
  gifRecordingState: {
    getValue: async () => stateData.current,
    setValue: async (v: unknown) => {
      stateData.current = v;
    },
  },
  gifLastResult: {
    getValue: async () => lastResultData.current,
    setValue: async (v: unknown) => {
      lastResultData.current = v;
    },
  },
}));

const sendMessageMock = vi.fn();
vi.mock('@/lib/messaging', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));

// Minimal chrome/browser stubs: only the members session.ts touches.
const createdNotifications: unknown[] = [];
const createdTabs: string[] = [];
const alarmNames: string[] = [];
let offscreenOpen = false;

vi.stubGlobal('chrome', {
  runtime: {
    ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
    getContexts: vi.fn(async () =>
      offscreenOpen ? [{}] : [],
    ),
    getURL: (p: string) => `chrome-extension://test${p}`,
  },
  offscreen: {
    Reason: { DISPLAY_MEDIA: 'DISPLAY_MEDIA' },
    createDocument: vi.fn(async () => {
      offscreenOpen = true;
    }),
    closeDocument: vi.fn(async () => {
      offscreenOpen = false;
    }),
  },
  tabs: {
    query: vi.fn(async () => [{ id: 7, url: 'https://example.com/' }]),
    create: vi.fn(async (opts: { url: string }) => {
      createdTabs.push(opts.url);
    }),
  },
  alarms: {
    create: vi.fn(async (_n: string) => {
      alarmNames.push(_n);
    }),
    clear: vi.fn(async (n: string) => {
      const i = alarmNames.indexOf(n);
      if (i >= 0) alarmNames.splice(i, 1);
    }),
    onAlarm: { addListener: vi.fn() },
  },
  notifications: {
    create: vi.fn(async (n: unknown) => {
      createdNotifications.push(n);
    }),
  },
});
vi.stubGlobal('browser', {
  i18n: { getMessage: () => undefined },
  runtime: { getURL: (p: string) => `chrome-extension://test${p}` },
});

import {
  handleGifOffscreenDone,
  startGifRecording,
  stopGifRecording,
} from './session';
import { GifRecordingError } from './types';

beforeEach(() => {
  stateData.current = null;
  lastResultData.current = null;
  createdNotifications.length = 0;
  createdTabs.length = 0;
  alarmNames.length = 0;
  offscreenOpen = false;
  sendMessageMock.mockReset();
  sendMessageMock.mockResolvedValue({ ok: true });
});

describe('startGifRecording', () => {
  it('uses the explicit opts.tabId/url (agent path) instead of querying the active tab', async () => {
    await startGifRecording('stream-1', {
      tabId: 42,
      url: 'https://target.test/',
      silent: true,
    });
    expect(chrome.tabs.query).not.toHaveBeenCalled();
    expect(stateData.current).toMatchObject({
      status: 'recording',
      tabId: 42,
      silent: true,
    });
    expect(sendMessageMock).toHaveBeenCalledWith('GIF_OFFSCREEN_START', {
      streamId: 'stream-1',
      url: 'https://target.test/',
    });
  });

  it('persists silent:true only when requested (popup path stays non-silent)', async () => {
    await startGifRecording('stream-2');
    expect(stateData.current).toEqual({
      status: 'recording',
      startedAt: expect.any(Number),
      tabId: 7,
    });
  });

  it('rolls the state reservation back when the offscreen start fails', async () => {
    sendMessageMock.mockRejectedValue(new Error('stream expired'));
    await expect(startGifRecording('stream-3')).rejects.toThrow(GifRecordingError);
    expect(stateData.current).toBeNull();
  });
});

describe('stopGifRecording', () => {
  it('throws not-recording when idle', async () => {
    await expect(stopGifRecording()).rejects.toMatchObject({ code: 'not-recording' });
  });

  it('clears the state and the watch alarm after the offscreen ack', async () => {
    await startGifRecording('stream-4');
    await stopGifRecording();
    expect(stateData.current).toBeNull();
    expect(alarmNames).toHaveLength(0);
  });
});

describe('handleGifOffscreenDone', () => {
  it('always writes gifLastResult (survives SW sleep for get_gif_recording_status)', async () => {
    await handleGifOffscreenDone({ ok: true, draftId: 'd1', savedForPreview: true });
    expect(lastResultData.current).toMatchObject({
      ok: true,
      draftId: 'd1',
      endedAt: expect.any(Number),
    });
  });

  it('silent success: no preview tab, no notification — teardown only', async () => {
    stateData.current = { status: 'recording', startedAt: 1, tabId: 7, silent: true };
    await handleGifOffscreenDone({ ok: true, draftId: 'd2', savedForPreview: true });
    expect(createdTabs).toHaveLength(0);
    expect(createdNotifications).toHaveLength(0);
    expect(stateData.current).toBeNull();
  });

  it('silent + hitTimeLimit also stays silent', async () => {
    stateData.current = { status: 'recording', startedAt: 1, tabId: 7, silent: true };
    await handleGifOffscreenDone({
      ok: true,
      draftId: 'd3',
      savedForPreview: true,
      hitTimeLimit: true,
    });
    expect(createdTabs).toHaveLength(0);
    expect(createdNotifications).toHaveLength(0);
  });

  it('teardown closes the shared offscreen document when the laya runtime is idle', async () => {
    stateData.current = { status: 'recording', startedAt: 1, tabId: 7, silent: true };
    offscreenOpen = true;
    sendMessageMock.mockImplementation(async (type: string) =>
      type === 'LAYA_GET_STATUS' ? { ready: false, loading: false } : { ok: true },
    );
    await handleGifOffscreenDone({ ok: true, draftId: 'd5', savedForPreview: true });
    expect(offscreenOpen).toBe(false);
  });

  it('teardown keeps the shared offscreen document while the laya model is loaded', async () => {
    stateData.current = { status: 'recording', startedAt: 1, tabId: 7, silent: true };
    offscreenOpen = true;
    sendMessageMock.mockImplementation(async (type: string) =>
      type === 'LAYA_GET_STATUS' ? { ready: true, loading: false } : { ok: true },
    );
    await handleGifOffscreenDone({ ok: true, draftId: 'd6', savedForPreview: true });
    expect(offscreenOpen).toBe(true);
  });

  it('non-silent success opens the preview tab addressed by draftId', async () => {
    stateData.current = { status: 'recording', startedAt: 1, tabId: 7 };
    await handleGifOffscreenDone({ ok: true, draftId: 'd4', savedForPreview: true });
    expect(createdTabs).toEqual([
      'chrome-extension://test/preview.html?mode=gif&id=d4',
    ]);
  });

  it('failure notifies even in silent mode (no rpc caller left to tell)', async () => {
    stateData.current = { status: 'recording', startedAt: 1, tabId: 7, silent: true };
    await handleGifOffscreenDone({ ok: false });
    expect(createdNotifications.length).toBe(1);
    expect(createdTabs).toHaveLength(0);
  });
});
