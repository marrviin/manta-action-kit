/**
 * Tab → GIF recording: record the active tab with `chrome.tabCapture` inside an
 * offscreen document (MediaRecorder → WebM), hand the WebM to the preview tab
 * (via IndexedDB — blobs are first-class IDB values), where the user watches it
 * and converts it to a GIF on demand (canvas frame sampling + gifenc).
 *
 * The recording lives in the offscreen document (survives MV3 service-worker
 * sleeps); the background only tracks coarse state in `session:gifRecordingState`
 * for the popup UI.
 */

/**
 * Coarse recording state as seen by the popup. `null` = idle; after the stop
 * request the preview tab takes over and the popup is back to idle. The
 * recorder itself lives in the offscreen document — this only mirrors its
 * phase for the UI.
 */
export type GifRecordingStatus = 'recording' | 'paused';

export interface GifRecordingState {
  status: GifRecordingStatus;
  startedAt: number;
  tabId: number;
}

/**
 * A recorded WebM waiting for GIF conversion in the preview tab. Stored in the
 * `gifDrafts` IndexedDB store under the fixed id "latest" (each recording
 * replaces the last — drafts are transient, not a library).
 */
export interface GifDraft {
  id: string;
  blob: Blob;
  /** Download filename for the eventual GIF (e.g. "gif-example.com-20260923.gif"). */
  filename: string;
  createdAt: number;
}

/**
 * Stable error codes for the GIF recording flow. GifRecordingError serializes
 * them as "gif:<code>" messages so they survive the background catch-all
 * (which replies `{ __error: err.message }`) and the popup can map them onto
 * i18n keys.
 */
export type GifRecordingErrorCode =
  | 'unsupported-page' // chrome://, Web Store, or a non-http(s) target
  | 'start-failed' // streamId expired, tab capture refused, offscreen start failed
  | 'not-recording' // stop requested with no recording in flight
  | 'encode-failed'; // saving the recording / GIF conversion failed

/** Error whose message is a stable machine-readable code for the popup. */
export class GifRecordingError extends Error {
  constructor(
    readonly code: GifRecordingErrorCode,
    detail?: string,
  ) {
    super(`gif:${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'GifRecordingError';
  }
}
