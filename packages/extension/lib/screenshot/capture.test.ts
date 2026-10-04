import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureScreenshot } from './capture';
import { ScreenshotError } from './types';

/**
 * The relaxed page-type policy: visible mode no longer dies on
 * browser-internal pages — captureVisibleTab failure falls back to a CDP
 * viewport render, and attach refusals map onto protected-page /
 * debugger-conflict instead of a generic failure.
 */

type FakeDebugger = {
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  sendCommand: ReturnType<typeof vi.fn>;
};

const tab = (id: number, url = 'https://x.test/a') =>
  ({ id, url, windowId: 7 }) as chrome.tabs.Tab;

describe('captureScreenshot', () => {
  let debuggerApi: FakeDebugger;

  beforeEach(() => {
    vi.stubGlobal('chrome', {
      tabs: {
        captureVisibleTab: vi.fn().mockResolvedValue('data:image/png;base64,VIS'),
      },
      debugger: (debuggerApi = {
        attach: vi.fn().mockResolvedValue(undefined),
        detach: vi.fn().mockResolvedValue(undefined),
        sendCommand: vi.fn().mockResolvedValue({ data: 'RAW' }),
      }) satisfies FakeDebugger,
    } as unknown as typeof chrome);
    // No fake timers: withDebugger's 250ms post-attach settle uses a real
    // setTimeout that fake timers would never release.
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('visible on a normal page: captureVisibleTab wins, no debugger attach', async () => {
    const shot = await captureScreenshot(tab(1), 'visible');
    expect(shot.dataUrl).toBe('data:image/png;base64,VIS');
    expect(debuggerApi.attach).not.toHaveBeenCalled();
  });

  it('visible falls back to a CDP viewport render when captureVisibleTab refuses', async () => {
    (chrome.tabs.captureVisibleTab as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Cannot access contents of url "chrome://settings/".'),
    );
    const shot = await captureScreenshot(tab(1, 'chrome://settings'), 'visible');
    // CDP raw base64 gets prefixed into the same data-URL shape.
    expect(shot.dataUrl).toBe('data:image/png;base64,RAW');
    expect(debuggerApi.attach).toHaveBeenCalledWith({ tabId: 1 }, '1.3');
    const [, , params] = debuggerApi.sendCommand.mock.calls[0];
    // Viewport render: fromSurface WITHOUT captureBeyondViewport.
    expect(params).toEqual({ format: 'png', fromSurface: true });
    expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: 1 });
  });

  it('fullPage keeps the beyondViewport single render', async () => {
    debuggerApi.sendCommand
      .mockResolvedValueOnce({
        result: { value: '{"w":1000,"h":5000,"dpr":2}' },
      })
      .mockResolvedValueOnce({ data: 'RAW' });
    const shot = await captureScreenshot(tab(1), 'fullPage');
    expect(shot.dataUrl).toBe('data:image/png;base64,RAW');
    const [, , params] = debuggerApi.sendCommand.mock.calls[1];
    expect(params.captureBeyondViewport).toBe(true);
    // 1000*2 / 5000*2 ≤ 16384 — no clip downscale.
    expect(params.clip).toBeUndefined();
  });

  it('a Chrome-protected target maps to protected-page', async () => {
    (chrome.tabs.captureVisibleTab as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('no host access'),
    );
    debuggerApi.attach.mockRejectedValue(new Error('Cannot attach to this target'));
    await expect(captureScreenshot(tab(1, 'https://chrome.google.com'), 'visible'))
      .rejects.toThrow(ScreenshotError);
    await expect(
      captureScreenshot(tab(1, 'https://chrome.google.com'), 'visible'),
    ).rejects.toThrow(/screenshot:protected-page/);
  });

  it('DevTools already attached maps to debugger-conflict (nothing to detach)', async () => {
    (chrome.tabs.captureVisibleTab as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('no host access'),
    );
    debuggerApi.attach.mockRejectedValue(
      new Error('Another debugger is already attached'),
    );
    await expect(captureScreenshot(tab(1), 'visible')).rejects.toThrow(
      /screenshot:debugger-conflict/,
    );
    // Attach never succeeded, so there is no debugger session to detach from.
    expect(debuggerApi.detach).not.toHaveBeenCalled();
  });
});
