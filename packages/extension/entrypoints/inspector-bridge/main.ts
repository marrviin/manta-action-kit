/**
 * Bridge page logic — runs in the EXTENSION origin inside a hidden iframe the
 * inspector content script injects (see lib/inspector/capture.ts,
 * `handoffToBridge`). Two postMessage hops, in order:
 *
 *  1. `inspector-bridge-ready`  (this page -> parent content script): the
 *     payload can be posted. Sent on load because module scripts run before
 *     the frame's `load` event is observable cross-origin.
 *  2. `inspector-bridge-saved`  (this page -> parent): the IDB write and the
 *     background ping are done (`ok:true`) or failed (`ok:false, error`).
 *
 * The parent is the ONLY party we accept messages from (`e.source` check);
 * anything else (other frames, the page itself) is ignored.
 */
import { saveInspectorHistoryCapture } from "@/lib/db";
import { sendMessage } from "@/lib/messaging";
import type { InspectorCapturePayload } from "@/lib/inspector/types";

const READY = "inspector-bridge-ready";
const SAVED = "inspector-bridge-saved";

function reply(ok: boolean, error?: string, captureId?: string) {
  // `captureId` rides along for the agent-driven flow (which needs the
  // history id in its RPC reply); the manual flow ignores the extra field.
  parent.postMessage(
    { type: SAVED, ok, error, captureId },
    document.referrer || "*",
  );
}

window.addEventListener("message", async (e: MessageEvent) => {
  if (e.source !== parent) return;
  const msg = e.data as {
    type?: string;
    payload?: InspectorCapturePayload;
    token?: string;
    preview?: boolean;
  };
  if (msg?.type !== "inspector-bridge-save" || !msg.payload || !msg.token)
    return;
  const { payload, token } = msg;
  try {
    // 0. Consume the one-shot token minted by the content script (over
    //    runtime.sendMessage, which page scripts cannot use). ANY web page can
    //    embed this frame as its child and post a fake payload — the token is
    //    the only thing separating a real capture from that forgery. `ok:false`
    //    = unknown/expired/used token: refuse to touch IndexedDB.
    const { ok } = await sendMessage("INSPECTOR_BRIDGE_USE_TOKEN", {
      token,
    });
    if (!ok) {
      reply(false, "bridge token rejected");
      return;
    }
    // 1. Stash the full snapshot in the extension's own IndexedDB as its own
    //    history record — this is the hop that used to blow past the ~64MB
    //    runtime.sendMessage limit. The generated id comes back so the
    //    preview/diff tabs can address the record via URL params.
    const captureId = await saveInspectorHistoryCapture(payload);
    // 2. Tell the background the data is on disk (with its id); it opens the
    //    element preview at it — unless the caller opted out (agent captures
    //    are silent: the RPC result already carries the data). Its `ok` covers
    //    the whole chain, so the content script toasts once on it.
    await sendMessage("INSPECTOR_CAPTURE_PREVIEW_READY", {
      captureId,
      preview: msg.preview !== false,
    });
    reply(true, undefined, captureId);
  } catch (err) {
    console.error("[inspector-bridge] handoff failed", err);
    reply(false, String(err));
  }
});

parent.postMessage({ type: READY }, document.referrer || "*");
