/** Screenshot mode: the visible viewport or the full scrollable page. */
export type ScreenshotMode = 'visible' | 'fullPage';

/**
 * Stable error codes for the screenshot flow. ScreenshotError serializes them
 * as "screenshot:<code>" messages so they survive the background catch-all
 * (which replies `{ __error: err.message }`) and the popup can map them onto
 * i18n keys.
 */
export type ScreenshotErrorCode =
  | 'unsupported-page' // chrome://, Web Store, or a non-http(s) target
  | 'debugger-conflict' // DevTools (or another client) is already attached
  | 'capture-failed'; // captureVisibleTab / CDP capture failed

/** Error whose message is a stable machine-readable code for the popup. */
export class ScreenshotError extends Error {
  constructor(
    readonly code: ScreenshotErrorCode,
    detail?: string,
  ) {
    super(`screenshot:${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'ScreenshotError';
  }
}

/**
 * One captured screenshot, handed from the background to the preview tab via
 * session storage (`session:screenshotPreview`) — a full-page PNG data URL is
 * far too large for a URL query param.
 */
export interface ScreenshotPreview {
  dataUrl: string;
  filename: string;
}
