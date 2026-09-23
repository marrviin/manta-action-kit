/**
 * Background-side orchestration for the GIF recording feature.
 *
 * The offscreen document owns the actual recorder (see
 * entrypoints/offscreen/main.ts) — this module only:
 *  - makes sure the offscreen document exists,
 *  - forwards the popup-minted tabCapture streamId to it,
 *  - tracks coarse state in `session:gifRecordingState` for the popup UI,
 *  - handles completion: clear state, close the document, fire the system
 *    notification.
 *
 * No keepalive is needed: the recording survives service-worker sleeps, and a
 * stop request from the popup wakes the SW again.
 */
import { sendMessage } from '@/lib/messaging';
import { gifRecordingState } from '@/lib/storage';
import { GifRecordingError } from './types';

async function ensureOffscreenDocument(): Promise<void> {
  // offscreen.html is this extension's only offscreen document — presence is
  // enough, no need to match URLs.
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [chrome.offscreen.Reason.DISPLAY_MEDIA],
    justification: 'Record the active tab and encode the recording as a GIF',
  });
}

/** Validate + forward the streamId to offscreen, then record the state. */
export async function startGifRecording(streamId: string): Promise<{ ok: boolean }> {
  const current = await gifRecordingState.getValue();
  if (current) {
    throw new GifRecordingError('start-failed', 'a recording is already in progress');
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await ensureOffscreenDocument();
  try {
    await sendMessage('GIF_OFFSCREEN_START', { streamId, url: tab?.url ?? '' });
  } catch (err) {
    // Offscreen refused (streamId expired, capture rejected, …) — bubble a
    // coded error; no state was written so the popup stays idle.
    throw new GifRecordingError('start-failed', String(err));
  }
  await gifRecordingState.setValue({
    status: 'recording',
    startedAt: Date.now(),
    tabId: tab?.id ?? -1,
  });
  return { ok: true };
}

/**
 * Stop the recorder. Resolves on the offscreen ack — the recording is then
 * persisted for the preview tab, which reports via handleGifOffscreenDone.
 */
export async function stopGifRecording(): Promise<{ ok: boolean }> {
  const current = await gifRecordingState.getValue();
  if (!current) {
    throw new GifRecordingError('not-recording');
  }
  try {
    await sendMessage('GIF_OFFSCREEN_STOP', undefined);
  } catch (err) {
    // Offscreen unreachable — nothing will report done; reset to idle.
    await gifRecordingState.setValue(null);
    throw new GifRecordingError('not-recording', String(err));
  }
  // The popup is idle again the moment the recorder stopped; the preview tab
  // takes over from here.
  await gifRecordingState.setValue(null);
  return { ok: true };
}

/** Toggle pause on the offscreen recorder and mirror the phase to the UI. */
async function setGifPaused(paused: boolean): Promise<{ ok: boolean }> {
  const current = await gifRecordingState.getValue();
  if (!current) {
    throw new GifRecordingError('not-recording');
  }
  if (current.status === (paused ? 'paused' : 'recording')) {
    return { ok: true }; // already in the requested phase — idempotent
  }
  try {
    await sendMessage(paused ? 'GIF_OFFSCREEN_PAUSE' : 'GIF_OFFSCREEN_RESUME', undefined);
  } catch (err) {
    throw new GifRecordingError('not-recording', String(err));
  }
  await gifRecordingState.setValue({ ...current, status: paused ? 'paused' : 'recording' });
  return { ok: true };
}

export const pauseGifRecording = () => setGifPaused(true);
export const resumeGifRecording = () => setGifPaused(false);

/** Completion report from offscreen: open the preview tab, or notify on failure. */
export async function handleGifOffscreenDone(result: {
  ok: boolean;
  savedForPreview?: boolean;
}): Promise<void> {
  await gifRecordingState.setValue(null);
  if (result.ok && result.savedForPreview) {
    // Same handoff pattern as screenshots: open the preview tab, THEN tear the
    // offscreen document down (the draft already sits in IndexedDB).
    await chrome.tabs.create({
      url: browser.runtime.getURL('/preview.html?mode=gif'),
    });
    await chrome.offscreen.closeDocument().catch(() => {});
    return;
  }
  // The document has nothing left to do either way — teardown is best-effort.
  await chrome.offscreen.closeDocument().catch(() => {});
  chrome.notifications
    .create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('/icon/128.png'),
      title:
        browser.i18n.getMessage('notifyGifFailedTitle') || 'GIF recording failed',
      message:
        browser.i18n.getMessage('notifyGifFailedMessage') ||
        'The recording could not be saved',
    })
    .catch((err) => console.error('[gif-recording] notification failed', err));
}
