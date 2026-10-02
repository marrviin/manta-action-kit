/**
 * Background-side orchestration for the laya decision-model runtime.
 *
 * The model itself lives in the offscreen document (see lib/ai/runtime.ts) —
 * this module only:
 *  - makes sure that document exists (shared with the GIF recorder: Chrome
 *    allows exactly one offscreen document per extension, so it is created
 *    with whichever reason the first feature needs and simply reused),
 *  - relays LAYA_PREDICT from any UI context into it. The MV3 service worker
 *    cannot host the ONNX session itself (no WebGPU, ~30s idle lifetime).
 */
import { sendMessage } from '@/lib/messaging';

/** Whether the shared offscreen document (GIF recorder + laya runtime) exists. */
async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  return contexts.length > 0;
}

/**
 * Create the shared offscreen document if missing. WORKERS covers "silent
 * computation" (the ONNX runtime spawns wasm workers for the laya session);
 * DISPLAY_MEDIA covers the GIF recorder. Both are valid for the same
 * document — whichever feature gets here first wins, the other reuses it.
 */
/** In-flight createDocument, so concurrent callers don't race Chrome's
 * "Only a single offscreen document may be created" (STOP_RECORDING's
 * auto-analysis and the settings card's auto-load can fire together). */
let ensuring: Promise<void> | null = null;

export async function ensureLayaRuntime(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  if (!ensuring) {
    ensuring = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Run the bundled laya decision model locally (ONNX + WebGPU)',
      })
      .finally(() => {
        ensuring = null;
      });
  }
  try {
    await ensuring;
  } catch (err) {
    // Lost the race against another creator (e.g. the GIF recorder or a
    // concurrent ensure) — the document existing now is still success.
    if (!(await hasOffscreenDocument())) throw err;
  }
}

/**
 * Tear the shared offscreen document (GIF recorder + laya runtime) down after
 * a GIF recording — but only when the laya runtime does not need it anymore.
 * A loaded model is ~800 MB of fetches plus GPU/wasm residency; evicting it
 * just because a recording finished would force the next predict to reload
 * everything. Probes the runtime status straight from the service worker (a
 * runtime message reaches every context except the sender, so the LAYA_*
 * relay handlers below don't intercept it); no answer means the document is
 * already gone and there is nothing to close.
 */
export async function closeLayaOffscreenDocument(): Promise<void> {
  try {
    const status = await sendMessage('LAYA_GET_STATUS', {});
    if (status.ready || status.loading) return;
  } catch {
    return; // no offscreen document answered — already gone
  }
  await chrome.offscreen.closeDocument().catch(() => {});
}
