import { ScreenshotError, type ScreenshotMode } from './types';

/**
 * Screenshot capture only — no saving, no clipboard. Runs in the background
 * service worker. The result is handed to the preview tab by the
 * CAPTURE_SCREENSHOT handler (storage.session + chrome.tabs.create), which
 * then owns the copy/download interactions with the image in front of the
 * user. Nothing is written to disk automatically.
 */

/** Compact timestamp for filenames, e.g. "20260922-143005". */
export function timestamp(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** Hostname sanitized for a filename ("page" when nothing usable remains). */
export function fileHost(url: string): string {
  try {
    return (
      new URL(url).hostname
        .replace(/^www\./, '')
        .replace(/[^a-zA-Z0-9.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'page'
    );
  } catch {
    return 'page';
  }
}

/**
 * Attach the debugger, run one async step with the target handle, always
 * detach afterwards (even on failure). Attach failures map onto stable codes:
 * DevTools (or another client) already attached → debugger-conflict; a
 * Chrome-protected target (Web Store etc. refuses attach) → protected-page.
 */
async function withDebugger<T>(
  tabId: number,
  run: (target: { tabId: number }) => Promise<T>,
): Promise<T> {
  if (!chrome.debugger) {
    throw new ScreenshotError('capture-failed', 'debugger API unavailable');
  }
  const target = { tabId: tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (err) {
    if (/another debugger/i.test(String(err))) {
      throw new ScreenshotError('debugger-conflict', String(err));
    }
    if (/cannot attach|not allowed/i.test(String(err))) {
      throw new ScreenshotError('protected-page', String(err));
    }
    throw new ScreenshotError('capture-failed', String(err));
  }
  try {
    // The attach infobar resizes the web contents and triggers a reflow; give
    // it a beat so the capture doesn't race the relayout (both modes attach).
    await new Promise((r) => setTimeout(r, 250));
    return await run(target);
  } catch (err) {
    if (err instanceof ScreenshotError) throw err;
    // "Another debugger is already attached" ⇒ DevTools is open on this tab.
    if (/another debugger/i.test(String(err))) {
      throw new ScreenshotError('debugger-conflict', String(err));
    }
    throw new ScreenshotError('capture-failed', String(err));
  } finally {
    // Detach must always run, even when the capture failed.
    await chrome.debugger.detach(target).catch(() => {});
  }
}

/** One CDP Page.captureScreenshot → data URL (CDP returns RAW base64). */
async function cdpCapture(
  target: { tabId: number },
  params: Record<string, unknown>,
): Promise<string> {
  const res = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', params);
  const raw = (res as { data?: string }).data ?? '';
  // Prefix it so CDP output matches captureVisibleTab's data-URL shape.
  return raw ? `data:image/png;base64,${raw}` : '';
}

export async function captureScreenshot(
  tab: chrome.tabs.Tab,
  mode: ScreenshotMode,
): Promise<{ dataUrl: string; filename: string }> {
  if (!tab.id) {
    throw new ScreenshotError('unsupported-page', 'no active tab');
  }
  const filename = `screenshot-${fileHost(tab.url ?? '')}-${timestamp()}.png`;

  let dataUrl = '';
  if (mode === 'visible') {
    try {
      // Needs only host access to the tab (covered by <all_urls>), no extra
      // permission.
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: 'png',
      });
    } catch {
      // Host patterns never match browser-internal pages (chrome:// …), so
      // captureVisibleTab refuses them even with <all_urls>. Fall back to a
      // CDP viewport render (fromSurface, no captureBeyondViewport) — the
      // debugger attach works on most of those pages.
      dataUrl = await withDebugger(tab.id, (target) =>
        cdpCapture(target, { format: 'png', fromSurface: true }),
      );
    }
  } else {
    // Full page: one-shot CDP attach — the "being debugged" infobar shows
    // only for the duration of the attach; cleanup + detach always run in
    // withDebugger.
    dataUrl = await withDebugger(tab.id, async (target) => {
      // Measure the content size (read-only — the DOM is NOT touched; any
      // fixed/sticky element is rendered by the renderer itself, exactly
      // like DevTools' Capture full size screenshot).
      const metrics = (await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        returnByValue: true,
        expression:
          'JSON.stringify({w: document.documentElement.scrollWidth, ' +
          'h: document.documentElement.scrollHeight, dpr: window.devicePixelRatio})',
      })) as { result?: { value?: string } };
      const size = JSON.parse(metrics.result?.value ?? '{}') as {
        w?: number;
        h?: number;
        dpr?: number;
      };

      // Same params as DevTools' Capture full size screenshot
      // (ScreenCaptureModel, ScreenshotMode.FULLPAGE): fromSurface +
      // captureBeyondViewport, single-shot render, no scrolling, no DOM
      // mutation. The ONLY deviation: Chromium's capture surface caps at
      // 16384 device px — pages beyond that tile with seams/truncation
      // (DPR 2 retina displays hit the cap at just ~8k CSS px). When the
      // measured size would exceed it, drop to scale 1 so the surface fits
      // (up to 16384 CSS px) and the file halves, at the cost of retina
      // sharpness.
      const params: Record<string, unknown> = {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
      };
      if (size.w && size.h) {
        const dpr = size.dpr || 1;
        if (size.w * dpr > 16384 || size.h * dpr > 16384) {
          params.clip = { x: 0, y: 0, width: size.w, height: size.h, scale: 1 };
        }
      }
      return cdpCapture(target, params);
    });
  }
  if (!dataUrl) throw new ScreenshotError('capture-failed', 'empty capture');

  return { dataUrl, filename };
}
