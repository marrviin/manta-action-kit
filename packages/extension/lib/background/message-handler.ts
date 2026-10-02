import type { Message } from "@/lib/messaging";
import type * as session from "@/lib/recording/session";
import type {
  addProxyRule,
  updateProxyRuleContent,
} from "@/lib/gateway/manage-rules";
import type { captureTabScreenshot } from "@/lib/screenshot/capture-flow";
import type {
  clearGatewayLogs,
  deleteGatewayProxyRule,
  listGatewayLogs,
  listGatewayProxyRules,
  saveScreenshotHistory,
  upsertGatewayProxyRule,
} from "@/lib/db";
import type {
  handleGifOffscreenDone,
  pauseGifRecording,
  resumeGifRecording,
  startGifRecording,
  stopGifRecording,
} from "@/lib/gif-recording/session";
import type { ensureLayaRuntime } from "@/lib/ai/laya-session";
import type { analyzeRecordingRelevance } from "@/lib/ai/relevance-run";
import type {
  isPendingConfirmation,
  requestGatewayConfirmation,
  resizeGatewayConfirmation,
  resolveGatewayConfirmation,
} from "@/lib/gateway/confirm";
import type {
  isPendingGifConfirmation,
  resolveGifConfirmation,
} from "@/lib/gif-confirm";
// Runtime deps only: the message-type constant, the screenshot error shape,
// and the two storage singletons the switch itself talks to. Everything else
// is injected via MessageHandlerDeps (typed with the `import type`s above).
import { PLAY_SCREENSHOT_FX } from "@/lib/screenshot/stitch-protocol";
import {
  ScreenshotError,
  SCREENSHOT_PREVIEW_MAX_BYTES,
} from "@/lib/screenshot/types";
import { readCaptureFx, screenshotPreview } from "@/lib/storage";

/**
 * Screenshot failures notify instead of toasting: the popup closes itself as
 * soon as the request is sent (it must not cover the page during the focus
 * fx), so nobody is left to display the mapped error — same idiom as the GIF
 * failure notification.
 */
function notifyScreenshotFailed(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  // "screenshot:debugger-conflict" — DevTools (or another client) is attached
  // to the tab; the fix is user-actionable, so call it out specifically.
  const conflict = message.includes("debugger-conflict");
  chrome.notifications
    .create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("/icon/128.png"),
      title:
        browser.i18n.getMessage("notifyScreenshotFailedTitle") ||
        "Screenshot failed",
      message:
        browser.i18n.getMessage(
          conflict
            ? "notifyScreenshotConflictMessage"
            : "notifyScreenshotFailedMessage",
        ) ||
        (conflict
          ? "Close DevTools on this tab and try again"
          : "This page could not be captured"),
    })
    .catch((e) => console.error("[background] notification failed", e));
}

/**
 * Every external function the message switch talks to, injected by the
 * background entrypoint. Tests pass vi.fn()s and drive the full dispatch
 * (routing, error shaping, ack-before-cleanup ordering) without any module
 * mocks.
 */
export interface MessageHandlerDeps {
  session: typeof session;
  analyzeRecordingRelevance: typeof analyzeRecordingRelevance;
  captureTabScreenshot: typeof captureTabScreenshot;
  saveScreenshotHistory: typeof saveScreenshotHistory;
  listGatewayLogs: typeof listGatewayLogs;
  clearGatewayLogs: typeof clearGatewayLogs;
  listGatewayProxyRules: typeof listGatewayProxyRules;
  deleteGatewayProxyRule: typeof deleteGatewayProxyRule;
  upsertGatewayProxyRule: typeof upsertGatewayProxyRule;
  addProxyRule: typeof addProxyRule;
  updateProxyRuleContent: typeof updateProxyRuleContent;
  requestGatewayConfirmation: typeof requestGatewayConfirmation;
  isPendingConfirmation: typeof isPendingConfirmation;
  resizeGatewayConfirmation: typeof resizeGatewayConfirmation;
  resolveGatewayConfirmation: typeof resolveGatewayConfirmation;
  startGifRecording: typeof startGifRecording;
  stopGifRecording: typeof stopGifRecording;
  pauseGifRecording: typeof pauseGifRecording;
  resumeGifRecording: typeof resumeGifRecording;
  handleGifOffscreenDone: typeof handleGifOffscreenDone;
  resolveGifConfirmation: typeof resolveGifConfirmation;
  isPendingGifConfirmation: typeof isPendingGifConfirmation;
  ensureLayaRuntime: typeof ensureLayaRuntime;
}

/**
 * Builds the runtime.onMessage listener for the background service worker.
 * Returns `true` on every call: the async sendResponse below needs the
 * message channel kept open.
 */
export function createMessageHandler(deps: MessageHandlerDeps) {
  // One-shot tokens authorizing inspector-bridge capture handoffs (mint ->
  // postMessage -> verify; page scripts cannot reach runtime.sendMessage, so
  // they can't mint or brute-force one). Module-scope state is fine here: a
  // dead service worker forgets every outstanding token — which is exactly
  // the fail-secure outcome for an unused token.
  const bridgeTokens = new Set<string>();

  return (raw: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void): boolean => {
    const msg = raw as Message;

    void (async () => {
      try {
        switch (msg.type) {
          case "INSPECTOR_BRIDGE_MINT_TOKEN": {
            const token = crypto.randomUUID();
            bridgeTokens.add(token);
            sendResponse({ token });
            break;
          }

          case "INSPECTOR_BRIDGE_USE_TOKEN": {
            // One-shot: a consumed token can never be replayed.
            const ok = bridgeTokens.delete(msg.data.token);
            if (!ok) sendResponse({ ok: false });
            else sendResponse({ ok: true });
            break;
          }
          case "GET_RECORDING_STATE":
            sendResponse(await deps.session.getState());
            break;

          case "START_RECORDING":
            sendResponse(await deps.session.start(msg.data));
            break;

          case "STOP_RECORDING": {
            const result = await deps.session.stop();
            // System-level completion nudge (macOS Notification Center via
            // chrome.notifications) — non-blocking, purely informational.
            if (result.recordingId) {
              chrome.notifications
                .create({
                  type: "basic",
                  iconUrl: chrome.runtime.getURL("/icon/128.png"),
                  title:
                    browser.i18n.getMessage("notifyRecordDoneTitle") ||
                    "Recording saved",
                  message:
                    browser.i18n.getMessage(
                      "notifyRecordDoneMessage",
                      String(result.state.count),
                    ) || `Captured API calls · ${result.state.count}`,
                })
                .catch((err) =>
                  console.error("[background] notification failed", err),
                );
              // Auto-run the laya relevance analysis in the background —
              // fire-and-forget so the stop response (and the notification
              // above) are never delayed by a model load.
              void deps
                .analyzeRecordingRelevance(result.recordingId)
                .catch((err) =>
                  console.error("[background] relevance analysis failed", err),
                );
            }
            sendResponse(result);
            break;
          }

          case "SET_PAUSED":
            sendResponse(await deps.session.setPaused(msg.data.paused));
            break;

          case "API_CALL_CAPTURED": {
            const count = await deps.session.push(msg.data, sender.tab?.id);
            sendResponse({ ok: true, count });
            break;
          }

          case "CAPTURE_SCREENSHOT": {
            // Re-query the active tab here so the handler is self-contained;
            // ScreenshotError messages ("screenshot:<code>") flow through the
            // shared catch-all below and are mapped to i18n by the popup.
            const [tab] = await chrome.tabs.query({
              active: true,
              currentWindow: true,
            });
            if (!tab?.id) {
              throw new ScreenshotError("unsupported-page", "no active tab");
            }
            // Capture FIRST, while the page is still pristine — the shot can
            // never contain the fx overlay, and a failed capture skips the
            // show entirely instead of playing it for nothing.
            // captureTabScreenshot: fullPage prefers scroll-and-stitch (width
            // pinned to the viewport — no blank-edge inflation — and lazy
            // images load on the way down); anything that goes wrong falls
            // back to the DevTools-equivalent CDP single render. Which path
            // won matters for the fx below: the stitched sweep already played
            // the same camera (focus intro + shutter outro), so a second
            // iris here would be a duplicate flourish. Shared with the agent
            // RPC (capture_screenshot), which calls it without any of the
            // surrounding fx/preview choreography.
            const shot = await deps.captureTabScreenshot(tab, msg.data.mode);
            const stitched = shot.stitched;
            // Hand the capture to the preview tab via session storage (a
            // full-page data URL is far too large for a query param), then
            // open it. Copy/download happen there — nothing is saved yet.
            // Reject oversized payloads with a dedicated code instead of
            // letting the quota error surface as a generic capture failure.
            if (shot.dataUrl.length > SCREENSHOT_PREVIEW_MAX_BYTES) {
              throw new ScreenshotError(
                "preview-too-large",
                `${shot.dataUrl.length} bytes`,
              );
            }
            try {
              await screenshotPreview.setValue(shot);
            } catch (err) {
              throw new ScreenshotError("preview-too-large", String(err));
            }
            // Now play the camera-focus fx as a pure celebration. Fire it
            // right away (the page sits idle otherwise) and let it run
            // concurrently with the history write; both must finish before
            // the preview tab opens, so the jump reads as the iris snap's
            // recovery. No content script / setting off / timeout → straight
            // to the preview, i.e. the old behavior.
            // fullPage mode just dragged the renderer through a surface
            // resize (CDP captureBeyondViewport) plus the debugger infobar's
            // attach/detach; give it a beat to settle so the fx opens on a
            // calm, correctly-sized viewport.
            if (msg.data.mode === "fullPage" && !stitched) {
              await new Promise((r) => setTimeout(r, 200));
            }
            let fxSettled: Promise<unknown> = Promise.resolve();
            if (!stitched && (await readCaptureFx())) {
              // 2.5s hard timeout: the fx itself runs ~1.15s, plus the
              // content script waits for its next real paint before starting
              // (double rAF) and fullPage adds a 200ms settle — the reply can
              // legitimately arrive past 1.5s without anything being wrong.
              fxSettled = Promise.race([
                chrome.tabs.sendMessage(tab.id, {
                  type: PLAY_SCREENSHOT_FX,
                }),
                new Promise((r) => setTimeout(r, 2_500)),
              ]).catch(() => {
                /* no content script on this tab — straight to the preview */
              });
            }
            // Persist to history BEFORE opening the preview so the tab can
            // address this exact record by id (re-openable from the side-panel
            // capture tab). Best-effort: a failed save must not lose the
            // capture — the session handoff still works.
            let historyId: string | undefined;
            try {
              historyId = await deps.saveScreenshotHistory(
                shot.dataUrl,
                shot.filename,
              );
            } catch (err) {
              console.error("[background] screenshot history save failed", err);
            }
            // A recovery beat before the jump: the snap back to the clean
            // page is part of the camera metaphor (shutter black → viewfinder
            // returns → you look at the photo). Only when the fx actually
            // played — skip paths open the preview straight away.
            const fxResult = await fxSettled;
            if (
              fxResult &&
              typeof fxResult === "object" &&
              (fxResult as { played?: boolean }).played
            ) {
              await new Promise((r) => setTimeout(r, 600));
            }
            await chrome.tabs.create({
              url: browser.runtime.getURL(
                historyId
                  ? `/preview.html?mode=screenshot&id=${historyId}`
                  : "/preview.html",
              ),
            });
            sendResponse({ ok: true });
            break;
          }

          case "INSPECTOR_CAPTURE_PREVIEW_READY": {
            // The capture payload is already in IndexedDB as its own history
            // record (`msg.data.captureId`): it was written by the
            // inspector-bridge iframe in the EXTENSION origin, because a
            // content script only sees the PAGE's IDB, and the old
            // runtime.sendMessage handoff capped at ~64MB structured clone —
            // full snapshots with per-node computed styles can blow past that
            // on large pages. Here we only consume the id and open the
            // element preview at it (comparisons are launched from there via
            // the history dropdown).
            const { captureId, preview } = msg.data;
            // Agent-driven captures (preview === false) stay silent: the RPC
            // result already carries the data, so no preview tab opens.
            if (preview !== false) {
              await chrome.tabs.create({
                url: browser.runtime.getURL(
                  `/preview.html?mode=element&id=${captureId}`,
                ),
              });
            }
            sendResponse({ ok: true });
            break;
          }

          case "START_GIF_RECORDING":
            // streamId from the popup (popup-minted, no opts) or from the GIF
            // confirm window (agent-requested, with tabId/url/silent).
            sendResponse(
              await deps.startGifRecording(msg.data.streamId, {
                tabId: msg.data.tabId,
                url: msg.data.url,
                silent: msg.data.silent,
              }),
            );
            break;

          case "GIF_CONFIRM_DECISION": {
            const settled = deps.resolveGifConfirmation(
              msg.data.id,
              msg.data.approved,
              msg.data.streamId,
              msg.data.error,
            );
            sendResponse({ ok: settled });
            break;
          }

          case "GIF_CONFIRM_PING": {
            // Keepalive: this inbound message resets the SW idle timer; the
            // ok flag tells the page whether its request is still live.
            sendResponse({ ok: deps.isPendingGifConfirmation(msg.data.id) });
            break;
          }

          case "STOP_GIF_RECORDING":
            sendResponse(await deps.stopGifRecording());
            break;

          case "PAUSE_GIF_RECORDING":
            sendResponse(await deps.pauseGifRecording());
            break;

          case "RESUME_GIF_RECORDING":
            sendResponse(await deps.resumeGifRecording());
            break;

          case "GIF_OFFSCREEN_DONE":
            // Completion report from the offscreen recorder. Ack FIRST, then
            // clean up: the offscreen sender's sendMessage() promise resolves
            // only when this reply arrives, and the cleanup below destroys the
            // document — replying afterwards would make that promise reject
            // ("message port closed") and re-report a (false) failure.
            sendResponse({ ok: true });
            await deps.handleGifOffscreenDone(msg.data).catch((err) =>
              console.error("[background] gif cleanup failed", err),
            );
            break;

          case "LAYA_ENSURE_RUNTIME":
            // Create the shared offscreen document on demand (reused with the
            // GIF recorder — see lib/ai/laya-session.ts). The model itself
            // loads lazily on the first LAYA_PREDICT.
            await deps.ensureLayaRuntime();
            sendResponse({ ok: true });
            break;

          case "LAYA_PREDICT": {
            // Relay into the offscreen runtime. The service worker cannot host
            // the ONNX session itself (no WebGPU, ~30s idle lifetime), so this
            // is a pure pass-through with document-ensure on the front. While
            // the prediction runs, the offscreen side pings LAYA_KEEPALIVE to
            // keep THIS worker alive — a killed SW would drop the pending
            // sendResponse and the caller would see "message channel closed".
            await deps.ensureLayaRuntime();
            sendResponse(await browser.runtime.sendMessage(raw));
            break;
          }

          case "LAYA_PREDICT_BATCH": {
            // Same relay as LAYA_PREDICT, batched: one shared forward pass per
            // chunk of states instead of one pass per state.
            await deps.ensureLayaRuntime();
            sendResponse(await browser.runtime.sendMessage(raw));
            break;
          }

          case "RUN_RECORDING_RELEVANCE": {
            // Manual (re-)run from the detail view — fire-and-forget exactly
            // like the auto pass at STOP_RECORDING; completion arrives via
            // RECORDING_RELEVANCE_UPDATED.
            void deps
              .analyzeRecordingRelevance(msg.data.recordingId)
              .catch((err) =>
                console.error("[background] relevance analysis failed", err),
              );
            sendResponse({ started: true });
            break;
          }

          case "LAYA_KEEPALIVE":
            // No-op: the receipt alone resets the SW idle timer (see the
            // LAYA_PREDICT relay above and lib/messaging.ts).
            sendResponse({ ok: true });
            break;

          case "LAYA_GET_STATUS": {
            // Relay, but do NOT ensure the document first: a status probe from
            // a freshly opened panel must not spawn the runtime. A missing
            // offscreen document simply means "not loaded".
            try {
              sendResponse(await browser.runtime.sendMessage(raw));
            } catch {
              sendResponse({ ready: false, loading: false });
            }
            break;
          }

          case "PING":
            sendResponse({ type: "PONG", at: Date.now() });
            break;

          case "LIST_GATEWAY_LOGS": {
            sendResponse({ logs: await deps.listGatewayLogs() });
            break;
          }

          case "CLEAR_GATEWAY_LOGS": {
            await deps.clearGatewayLogs();
            sendResponse({ ok: true });
            break;
          }

          case "LIST_GATEWAY_PROXY_RULES": {
            sendResponse({ rules: await deps.listGatewayProxyRules() });
            break;
          }

          case "ADD_GATEWAY_PROXY_RULE": {
            try {
              // UI-created rules are enabled immediately (the user just authored them).
              const rule = await deps.addProxyRule(msg.data, true, "user");
              sendResponse({ rule });
            } catch (err) {
              sendResponse({
                __error: err instanceof Error ? err.message : String(err),
              });
            }
            break;
          }

          case "UPDATE_GATEWAY_PROXY_RULE": {
            try {
              const { enabled, ...content } = msg.data.patch;
              // Apply the content patch (name/prefix/target/methods) via the shared
              // validator, then the enabled toggle separately — the UI is allowed to
              // flip enabled (it's the human's kill switch), unlike the agent path.
              let rule = await deps.updateProxyRuleContent(
                msg.data.id,
                content,
              );
              if (enabled !== undefined && enabled !== rule.enabled) {
                rule = { ...rule, enabled };
                await deps.upsertGatewayProxyRule(rule);
              }
              sendResponse({ rule });
            } catch (err) {
              sendResponse({
                __error: err instanceof Error ? err.message : String(err),
              });
            }
            break;
          }

          case "DELETE_GATEWAY_PROXY_RULE": {
            await deps.deleteGatewayProxyRule(msg.data.id);
            sendResponse({ ok: true });
            break;
          }

          case "GATEWAY_CONFIRM_DECISION": {
            const { id, approved } = msg.data;
            sendResponse({
              ok: deps.resolveGatewayConfirmation(id, approved),
            });
            break;
          }

          case "GATEWAY_CONFIRM_PING": {
            // Keepalive only — also tells the page when its request is gone.
            sendResponse({ ok: deps.isPendingConfirmation(msg.data.id) });
            break;
          }

          case "GATEWAY_CONFIRM_TEST": {
            // Debug-only: exercise the confirmation gate with a fake request.
            // Nothing is forwarded and no audit log is written.
            const approved = await deps.requestGatewayConfirmation({
              method: "GET",
              url: "https://example.com/api/test-confirmation",
              bodyPreview: JSON.stringify(
                { debug: true, source: "settings-test" },
                null,
                2,
              ),
              via: "agent",
            });
            sendResponse({ approved });
            break;
          }

          case "GATEWAY_CONFIRM_RESIZE": {
            sendResponse({
              ok: deps.resizeGatewayConfirmation(
                msg.data.id,
                msg.data.height,
              ),
            });
            break;
          }
        }
      } catch (err) {
        // A handler that throws must still answer, or the caller's sendMessage
        // promise never settles and its UI hangs (spinner forever). Reply with a
        // shaped error so the channel closes.
        console.error("[background] message handler failed", msg.type, err);
        if (msg.type === "CAPTURE_SCREENSHOT") notifyScreenshotFailed(err);
        sendResponse({
          __error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    // Keep the message channel open for the async sendResponse above.
    return true;
  };
}
