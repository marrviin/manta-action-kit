/**
 * Offscreen GIF recorder — capture-side only. The recording lives HERE, not in
 * the service worker:
 *
 *  - the MV3 service worker has no DOM (no <video>/<canvas>/MediaRecorder), and
 *    it idle-terminates after ~30s; this document survives both, so a recording
 *    keeps running while the SW sleeps. No keepalive pings needed.
 *  - the tabCapture streamId is minted in the popup (user gesture) and consumed
 *    here via getUserMedia({ chromeMediaSource: 'tab' }).
 *
 * Flow: GIF_OFFSCREEN_START → MediaRecorder accumulates WebM chunks;
 * GIF_OFFSCREEN_STOP → stop the recorder and persist the WebM blob to IndexedDB
 * (first-class Blob value — zero-copy handoff), then report GIF_OFFSCREEN_DONE
 * so the background opens the preview tab and closes this document. The
 * WebM→GIF conversion happens in the VISIBLE preview tab (frame callbacks need
 * a composited page — see lib/gif-recording/encode.ts).
 */
import { sendMessage } from '@/lib/messaging';
import { saveGifDraft } from '@/lib/db';
import { fileHost, timestamp } from '@/lib/screenshot/capture';

/** Fixed id in the `gifDrafts` store — each recording replaces the last. */
const GIF_DRAFT_ID = 'latest';

let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
/** The recorded tab's URL, kept for the download filename. */
let recordedUrl = '';

type RuntimeMessage = { type?: string; data?: unknown };

browser.runtime.onMessage.addListener((raw: RuntimeMessage, _sender, sendResponse) => {
  (async () => {
    try {
      switch (raw?.type) {
        case 'GIF_OFFSCREEN_START': {
          const { streamId, url } = raw.data as { streamId: string; url: string };
          await startRecording(streamId, url);
          sendResponse({ ok: true });
          break;
        }
        case 'GIF_OFFSCREEN_STOP': {
          // Persist the draft BEFORE replying DONE — the background closes this
          // document (and opens the preview tab) once it hears back.
          const webm = await stopRecording();
          await persistDraft(webm);
          sendResponse({ ok: true });
          await sendMessage('GIF_OFFSCREEN_DONE', { ok: true, savedForPreview: true });
          break;
        }
        case 'GIF_OFFSCREEN_PAUSE': {
          if (!recorder) throw new Error('gif:not-recording');
          recorder.pause();
          sendResponse({ ok: true });
          break;
        }
        case 'GIF_OFFSCREEN_RESUME': {
          if (!recorder) throw new Error('gif:not-recording');
          recorder.resume();
          sendResponse({ ok: true });
          break;
        }
      }
    } catch (err) {
      console.error('[gif-offscreen] handler failed', raw?.type, err);
      try {
        await sendMessage('GIF_OFFSCREEN_DONE', { ok: false });
      } catch {
        // Background unreachable — nothing left to clean up on its side.
      }
      sendResponse({ __error: err instanceof Error ? err.message : String(err) });
    }
  })();
  // Keep the message channel open for the async sendResponse above.
  return true;
});

/** Begin capturing the tab stream with MediaRecorder. Throws if already running. */
async function startRecording(streamId: string, tabUrl: string): Promise<void> {
  if (recorder) throw new Error('gif:start-failed (recorder already running)');
  // chrome-specific constraint shape for consuming a tabCapture streamId —
  // not part of the standard MediaTrackConstraints types.
  const constraints = {
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  } as unknown as MediaStreamConstraints;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    throw new Error(`gif:start-failed (${String(err)})`);
  }

  chunks = [];
  // Prefer VP8: in Chrome it is always SOFTWARE-encoded (libvpx), sidestepping
  // the intermittent hardware VP9 encoder corruption (glitched blue/corrupt
  // frames — crbug.com/1473665 and siblings) that tab capture is exposed to.
  // The WebM is only an intermediate for the GIF, so VP8's larger size is fine.
  const mimeType = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'].find(
    (t) => MediaRecorder.isTypeSupported(t),
  );
  recorder = new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    // Generous bitrate: the WebM is only an intermediate — a starved source
    // frame would stay blurry no matter how well the GIF encodes.
    videoBitsPerSecond: 10_000_000,
  });
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  // Tab closed / capture revoked mid-recording → finish with what we have.
  recorder.stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    if (!recorder) return;
    void (async () => {
      try {
        const webm = await stopRecording();
        await persistDraft(webm);
        await sendMessage('GIF_OFFSCREEN_DONE', { ok: true, savedForPreview: true });
      } catch (err) {
        console.error('[gif-offscreen] auto-finalize failed', err);
        await sendMessage('GIF_OFFSCREEN_DONE', { ok: false }).catch(() => {});
      }
    })();
  });
  recorder.start(1_000); // timeslice: bound worst-case memory per chunk
  recordedUrl = tabUrl;
}

/**
 * Stop the recorder and resolve with the complete WebM blob (the final
 * dataavailable fires before `onstop`, so resolving there catches it).
 */
function stopRecording(): Promise<Blob | null> {
  const current = recorder;
  recorder = null;
  if (!current) return Promise.resolve(null);
  return new Promise((resolve) => {
    current.onstop = () => {
      current.stream.getTracks().forEach((t) => t.stop());
      const webm = new Blob(chunks, { type: 'video/webm' });
      chunks = [];
      resolve(webm);
    };
    current.stop();
  });
}

/** Persist the recording for the preview tab. Throws when there's nothing to save. */
async function persistDraft(webm: Blob | null): Promise<void> {
  if (!webm || webm.size === 0) throw new Error('gif:encode-failed (empty recording)');
  await saveGifDraft({
    id: GIF_DRAFT_ID,
    blob: webm,
    filename: `gif-${fileHost(recordedUrl)}-${timestamp()}.gif`,
    createdAt: Date.now(),
  });
}
