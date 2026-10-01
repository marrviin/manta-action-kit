import { captureFullPageStitched } from './stitch';
import { captureScreenshot, fileHost, timestamp } from './capture';
import type { ScreenshotMode } from './types';

/**
 * Shared "capture the tab" pipeline used by BOTH the manual popup flow
 * (CAPTURE_SCREENSHOT message) and the agent RPC (capture_screenshot):
 * fullPage prefers the scroll-and-stitch path (returns null on any failure →
 * CDP single-render fallback), visible goes straight to captureVisibleTab.
 * Capture only — no fx, no session handoff, no history write, no preview tab;
 * each caller owns its own UX around the shot.
 */
export interface CapturedShot {
  dataUrl: string;
  filename: string;
  /** true when the scroll-and-stitch path produced the shot. */
  stitched: boolean;
}

export async function captureTabScreenshot(
  tab: chrome.tabs.Tab,
  mode: ScreenshotMode,
): Promise<CapturedShot> {
  let stitched = false;
  if (mode === 'fullPage') {
    const result = await captureFullPageStitched(tab);
    if (result) {
      stitched = true;
      return { ...result, stitched };
    }
  }
  const shot = await captureScreenshot(tab, mode);
  return { ...shot, stitched };
}

/** "screenshot-<host>-<timestamp>.png"-style filename for a captured tab. */
export function shotFilename(url: string): string {
  return `screenshot-${fileHost(url ?? '')}-${timestamp()}.png`;
}
