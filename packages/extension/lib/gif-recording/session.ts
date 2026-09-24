/**
 * Background-side orchestration for the GIF recording feature.
 *
 * The offscreen document owns the actual recorder (see
 * entrypoints/offscreen/main.ts) — this module only:
 *  - makes sure the offscreen document exists,
 *  - forwards the popup-minted tabCapture streamId to it,
 *  - tracks coarse state in `session:gifRecordingState` for the popup UI,
 *  - handles completion: clear state, close the document, fire the system
 *    notification,
 *  - watches for orphaned state: if Chrome kills the offscreen document
 *    mid-recording, a periodic alarm drops the stuck "recording" state back to
 *    idle (see initGifStateWatch).
 *
 * No keepalive is needed: the recording survives service-worker sleeps, and a
 * stop request from the popup wakes the SW again.
 */
import { sendMessage } from '@/lib/messaging';
import { gifRecordingState } from '@/lib/storage';
import { GifRecordingError } from './types';

/**
 * Periodic reconcile alarm, active only while a recording is in progress. If
 * Chrome kills the offscreen document (crash / memory pressure) the state item
 * still says "recording" — the popup shows REC forever and stopping fails with
 * `not-recording`, with no way out short of a browser restart. The alarm
 * checks state vs. reality once a minute and self-heals.
 */
const STATE_WATCH_ALARM = 'gif-state-watch';

/** Register the reconcile listener — call once from the background entry. */
export function initGifStateWatch(): void {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== STATE_WATCH_ALARM) return;
    void reconcileGifRecordingState().catch((err) =>
      console.error('[gif-recording] state watch failed', err),
    );
  });
}

/** Drop a stuck "recording" state when the offscreen document is gone. */
async function reconcileGifRecordingState(): Promise<void> {
  const current = await gifRecordingState.getValue();
  if (!current) return;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length > 0) return; // document alive — nothing to heal
  await gifRecordingState.setValue(null);
  await chrome.alarms.clear(STATE_WATCH_ALARM);
  await notifyGifFailed();
}

/** Best-effort "the recording could not be saved" system notification. */
async function notifyGifFailed(): Promise<void> {
  await chrome.notifications
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
  // Reserve the state BEFORE creating the document. Writing it only after the
  // offscreen ack left a long unguarded window (createDocument + getUserMedia):
  // a double-click's second call read `current === null` too and its
  // createDocument blew up with "Only a single offscreen document…" — a
  // misleading failure while the first click was actually recording fine. The
  // reservation is rolled back below if setup fails.
  await gifRecordingState.setValue({
    status: 'recording',
    startedAt: Date.now(),
    tabId: tab?.id ?? -1,
  });
  try {
    await ensureOffscreenDocument();
    await sendMessage('GIF_OFFSCREEN_START', { streamId, url: tab?.url ?? '' });
  } catch (err) {
    // Offscreen refused (streamId expired, capture rejected, …) — roll the
    // reservation back so the popup returns to idle, then bubble a coded error.
    await gifRecordingState.setValue(null);
    throw new GifRecordingError('start-failed', String(err));
  }
  // Arm the orphan watch: state present but no offscreen document → stuck.
  void chrome.alarms.create(STATE_WATCH_ALARM, { periodInMinutes: 1 });
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
  void chrome.alarms.clear(STATE_WATCH_ALARM);
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
  hitTimeLimit?: boolean;
}): Promise<void> {
  await gifRecordingState.setValue(null);
  void chrome.alarms.clear(STATE_WATCH_ALARM); // recording over either way
  if (result.ok && result.savedForPreview) {
    // Same handoff pattern as screenshots: open the preview tab, THEN tear the
    // offscreen document down (the draft already sits in IndexedDB).
    await chrome.tabs.create({
      url: browser.runtime.getURL('/preview.html?mode=gif'),
    });
    // The recording ended on its own (max duration) — tell the user why;
    // purely informational, the preview tab is already up.
    if (result.hitTimeLimit) {
      chrome.notifications
        .create({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('/icon/128.png'),
          title:
            browser.i18n.getMessage('notifyGifTimeLimitTitle') ||
            'GIF recording reached the time limit',
          message:
            browser.i18n.getMessage('notifyGifTimeLimitMessage') ||
            'The recording was saved automatically and is ready in the preview tab',
        })
        .catch((err) => console.error('[gif-recording] notification failed', err));
    }
    await chrome.offscreen.closeDocument().catch(() => {});
    return;
  }
  // The document has nothing left to do either way — teardown is best-effort.
  await chrome.offscreen.closeDocument().catch(() => {});
  await notifyGifFailed();
}
