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
export async function ensureLayaRuntime(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: 'Run the bundled laya decision model locally (ONNX + WebGPU)',
  });
}
