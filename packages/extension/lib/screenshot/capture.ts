import { isCapturableUrl } from '@/lib/utils';
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

export async function captureScreenshot(
  tab: chrome.tabs.Tab,
  mode: ScreenshotMode,
): Promise<{ dataUrl: string; filename: string }> {
  if (!tab.id || !isCapturableUrl(tab.url)) {
    throw new ScreenshotError('unsupported-page');
  }
  const filename = `screenshot-${fileHost(tab.url ?? '')}-${timestamp()}.png`;

  let dataUrl = '';
  try {
    if (mode === 'visible') {
      // Needs only host access to the tab (covered by <all_urls>), no extra
      // permission.
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: 'png',
      });
    } else {
      // Full page: one-shot CDP attach — the "being debugged" infobar shows
      // only for the duration of the attach; cleanup + detach always run
      // (finally).
      if (!chrome.debugger) {
        throw new ScreenshotError('capture-failed', 'debugger API unavailable');
      }
      await chrome.debugger.attach({ tabId: tab.id }, '1.3');
      try {
        const target = { tabId: tab.id };
        // The attach infobar resizes the web contents and triggers a reflow;
        // give it a beat so the capture doesn't race the relayout.
        await new Promise((r) => setTimeout(r, 250));
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

        const res = await chrome.debugger.sendCommand(
          target,
          'Page.captureScreenshot',
          params,
        );
        // CDP returns RAW base64 (no data: prefix) — unlike captureVisibleTab,
        // which returns a full data URL. Prefix it so both modes yield the
        // same shape (usable by fetch and the <img> in the preview page).
        const raw = (res as { data?: string }).data ?? '';
        if (raw) dataUrl = `data:image/png;base64,${raw}`;
      } finally {
        // Detach must always run, even when the capture failed.
        await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
      }
    }
  } catch (err) {
    if (err instanceof ScreenshotError) throw err;
    // "Another debugger is already attached" ⇒ DevTools is open on this tab.
    if (/another debugger/i.test(String(err))) {
      throw new ScreenshotError('debugger-conflict', String(err));
    }
    throw new ScreenshotError('capture-failed', String(err));
  }
  if (!dataUrl) throw new ScreenshotError('capture-failed', 'empty capture');

  return { dataUrl, filename };
}
