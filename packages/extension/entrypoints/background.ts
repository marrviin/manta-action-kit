import type { Message } from "@/lib/messaging";
import * as session from "@/lib/recording/session";
import { initMcpBridge } from "@/lib/mcp/bridge";
import {
  clearGatewayLogs,
  deleteGatewayProxyRule,
  deleteInspectorCapture,
  getInspectorCapture,
  listGatewayLogs,
  listGatewayProxyRules,
  saveInspectorCapture,
  saveInspectorDiffPair,
  upsertGatewayProxyRule,
} from "@/lib/db";
import {
  addProxyRule,
  updateProxyRuleContent,
} from "@/lib/gateway/manage-rules";
import { captureScreenshot } from "@/lib/screenshot/capture";
import {
  ScreenshotError,
  SCREENSHOT_PREVIEW_MAX_BYTES,
} from "@/lib/screenshot/types";
import { screenshotPreview } from "@/lib/storage";
import {
  handleGifOffscreenDone,
  initGifStateWatch,
  pauseGifRecording,
  resumeGifRecording,
  startGifRecording,
  stopGifRecording,
} from "@/lib/gif-recording/session";
import {
  initGatewayConfirm,
  isPendingConfirmation,
  requestGatewayConfirmation,
  resizeGatewayConfirmation,
  resolveGatewayConfirmation,
} from "@/lib/gateway/confirm";

/**
 * Background service worker (Manifest V3).
 *
 * Central hub for the API recording feature:
 *  - owns the recording session state machine (start/stop/buffer -> IndexedDB)
 *  - receives captured calls relayed from content scripts
 *
 * MV3 service workers are event-driven and terminate when idle; durable state
 * lives in storage.session / IndexedDB, not in module scope.
 */
export default defineBackground(() => {
  // Open the side panel when the toolbar icon is clicked (Chromium only).
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: false })
      .catch((err) =>
        console.error("[background] setPanelBehavior failed", err),
      );
  }

  // MCP bridge: dial the local MCP WebSocket server when enabled in settings.
  initMcpBridge().catch((err) =>
    console.error("[background] initMcpBridge failed", err),
  );

  // Sandbox confirmation popup: register the window-closed → deny listener.
  initGatewayConfirm();

  // GIF orphan-state watch: drops a stuck "recording" state if Chrome kills
  // the offscreen document mid-recording (see lib/gif-recording/session.ts).
  initGifStateWatch();

  // One-shot tokens authorizing inspector-bridge capture handoffs (mint ->
  // postMessage -> verify; page scripts cannot reach runtime.sendMessage, so
  // they can't mint or brute-force one). Module-scope state is fine here: a
  // dead service worker forgets every outstanding token — which is exactly
  // the fail-secure outcome for an unused token.
  const bridgeTokens = new Set<string>();

  browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const msg = raw as Message;

    (async () => {
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
            sendResponse(await session.getState());
            break;

          case "START_RECORDING":
            sendResponse(await session.start(msg.data));
            break;

          case "STOP_RECORDING": {
            const result = await session.stop();
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
            }
            sendResponse(result);
            break;
          }

          case "SET_PAUSED":
            sendResponse(await session.setPaused(msg.data.paused));
            break;

          case "API_CALL_CAPTURED": {
            const count = await session.push(msg.data, sender.tab?.id);
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
            const shot = await captureScreenshot(tab, msg.data.mode);
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
            await chrome.tabs.create({
              url: browser.runtime.getURL("/preview.html"),
            });
            sendResponse({ ok: true });
            break;
          }

          case "INSPECTOR_CAPTURE_PREVIEW_READY": {
            // The capture payload is already in IndexedDB (id "preview"): it
            // was written by the inspector-bridge iframe in the EXTENSION
            // origin, because a content script only sees the PAGE's IDB, and
            // the old runtime.sendMessage handoff capped at ~64MB structured
            // clone — full snapshots with per-node computed styles can blow
            // past that on large pages. Here we only consume what's on disk.
            const capture = await getInspectorCapture("preview");
            if (!capture) {
              // The bridge said READY but the record is gone — report instead
              // of opening a tab that would land on the not-found view.
              sendResponse({ ok: false });
              break;
            }
            // Comparison flow: if the user pinned a baseline from the preview
            // toolbar, this new capture becomes snapshot B. The pair (A+B) is
            // written as ONE item and left in storage — the diff view never
            // deletes it, so refreshing the tab restores the same diff. The
            // pin itself is one-shot: cleared right here, after pairing (as
            // is the now-paired preview record).
            const baseline = await getInspectorCapture("baseline");
            if (baseline) {
              await saveInspectorDiffPair({ a: baseline, b: capture });
              await deleteInspectorCapture("baseline");
              await deleteInspectorCapture("preview");
              await chrome.tabs.create({
                url: browser.runtime.getURL("/preview.html?mode=diff"),
              });
              sendResponse({ ok: true });
              break;
            }
            await chrome.tabs.create({
              url: browser.runtime.getURL("/preview.html?mode=element"),
            });
            sendResponse({ ok: true });
            break;
          }

          case "START_GIF_RECORDING":
            sendResponse(await startGifRecording(msg.data.streamId));
            break;

          case "STOP_GIF_RECORDING":
            sendResponse(await stopGifRecording());
            break;

          case "PAUSE_GIF_RECORDING":
            sendResponse(await pauseGifRecording());
            break;

          case "RESUME_GIF_RECORDING":
            sendResponse(await resumeGifRecording());
            break;

          case "GIF_OFFSCREEN_DONE":
            // Completion report from the offscreen recorder. Ack FIRST, then
            // clean up: the offscreen sender's sendMessage() promise resolves
            // only when this reply arrives, and the cleanup below destroys the
            // document — replying afterwards would make that promise reject
            // ("message port closed") and re-report a (false) failure.
            sendResponse({ ok: true });
            await handleGifOffscreenDone(msg.data).catch((err) =>
              console.error("[background] gif cleanup failed", err),
            );
            break;

          case "PING":
            sendResponse({ type: "PONG", at: Date.now() });
            break;

          case "LIST_GATEWAY_LOGS": {
            sendResponse({ logs: await listGatewayLogs() });
            break;
          }

          case "CLEAR_GATEWAY_LOGS": {
            await clearGatewayLogs();
            sendResponse({ ok: true });
            break;
          }

          case "LIST_GATEWAY_PROXY_RULES": {
            sendResponse({ rules: await listGatewayProxyRules() });
            break;
          }

          case "ADD_GATEWAY_PROXY_RULE": {
            try {
              // UI-created rules are enabled immediately (the user just authored them).
              const rule = await addProxyRule(msg.data, true, "user");
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
              let rule = await updateProxyRuleContent(msg.data.id, content);
              if (enabled !== undefined && enabled !== rule.enabled) {
                rule = { ...rule, enabled };
                await upsertGatewayProxyRule(rule);
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
            await deleteGatewayProxyRule(msg.data.id);
            sendResponse({ ok: true });
            break;
          }

          case "GATEWAY_CONFIRM_DECISION": {
            const { id, approved } = msg.data;
            sendResponse({ ok: resolveGatewayConfirmation(id, approved) });
            break;
          }

          case "GATEWAY_CONFIRM_PING": {
            // Keepalive only — also tells the page when its request is gone.
            sendResponse({ ok: isPendingConfirmation(msg.data.id) });
            break;
          }

          case "GATEWAY_CONFIRM_TEST": {
            // Debug-only: exercise the confirmation gate with a fake request.
            // Nothing is forwarded and no audit log is written.
            const approved = await requestGatewayConfirmation({
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
              ok: resizeGatewayConfirmation(msg.data.id, msg.data.height),
            });
            break;
          }
        }
      } catch (err) {
        // A handler that throws must still answer, or the caller's sendMessage
        // promise never settles and its UI hangs (spinner forever). Reply with a
        // shaped error so the channel closes.
        console.error("[background] message handler failed", msg.type, err);
        sendResponse({
          __error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    // Keep the message channel open for the async sendResponse above.
    return true;
  });
});
