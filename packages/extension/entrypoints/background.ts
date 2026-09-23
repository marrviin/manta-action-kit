import type { Message } from '@/lib/messaging';
import * as session from '@/lib/recording/session';
import { initMcpBridge } from '@/lib/mcp/bridge';
import {
  clearGatewayLogs,
  deleteGatewayProxyRule,
  listGatewayLogs,
  listGatewayProxyRules,
  upsertGatewayProxyRule,
} from '@/lib/db';
import { addProxyRule, updateProxyRuleContent } from '@/lib/gateway/manage-rules';
import { captureScreenshot } from '@/lib/screenshot/capture';
import { ScreenshotError } from '@/lib/screenshot/types';
import { screenshotPreview } from '@/lib/storage';
import {
  handleGifOffscreenDone,
  pauseGifRecording,
  resumeGifRecording,
  startGifRecording,
  stopGifRecording,
} from '@/lib/gif-recording/session';
import {
  initGatewayConfirm,
  isPendingConfirmation,
  requestGatewayConfirmation,
  resizeGatewayConfirmation,
  resolveGatewayConfirmation,
} from '@/lib/gateway/confirm';

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
      .catch((err) => console.error('[background] setPanelBehavior failed', err));
  }

  // MCP bridge: dial the local MCP WebSocket server when enabled in settings.
  initMcpBridge().catch((err) => console.error('[background] initMcpBridge failed', err));

  // Sandbox confirmation popup: register the window-closed → deny listener.
  initGatewayConfirm();

  browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const msg = raw as Message;

    (async () => {
      try {
        switch (msg.type) {
          case 'GET_RECORDING_STATE':
            sendResponse(await session.getState());
            break;

          case 'START_RECORDING':
            sendResponse(await session.start(msg.data));
            break;

          case 'STOP_RECORDING': {
            const result = await session.stop();
            // System-level completion nudge (macOS Notification Center via
            // chrome.notifications) — non-blocking, purely informational.
            if (result.recordingId) {
              chrome.notifications
                .create({
                  type: 'basic',
                  iconUrl: chrome.runtime.getURL('/icon/128.png'),
                  title: browser.i18n.getMessage('notifyRecordDoneTitle') || 'Recording saved',
                  message:
                    browser.i18n.getMessage(
                      'notifyRecordDoneMessage',
                      String(result.state.count),
                    ) || `Captured API calls · ${result.state.count}`,
                })
                .catch((err) =>
                  console.error('[background] notification failed', err),
                );
            }
            sendResponse(result);
            break;
          }

          case 'SET_PAUSED':
            sendResponse(await session.setPaused(msg.data.paused));
            break;

          case 'API_CALL_CAPTURED': {
            const count = await session.push(msg.data, sender.tab?.id);
            sendResponse({ ok: true, count });
            break;
          }

          case 'CAPTURE_SCREENSHOT': {
            // Re-query the active tab here so the handler is self-contained;
            // ScreenshotError messages ("screenshot:<code>") flow through the
            // shared catch-all below and are mapped to i18n by the popup.
            const [tab] = await chrome.tabs.query({
              active: true,
              currentWindow: true,
            });
            if (!tab?.id) {
              throw new ScreenshotError('unsupported-page', 'no active tab');
            }
            const shot = await captureScreenshot(tab, msg.data.mode);
            // Hand the capture to the preview tab via session storage (a
            // full-page data URL is far too large for a query param), then
            // open it. Copy/download happen there — nothing is saved yet.
            await screenshotPreview.setValue(shot);
            await chrome.tabs.create({
              url: browser.runtime.getURL('/preview.html'),
            });
            sendResponse({ ok: true });
            break;
          }

          case 'START_GIF_RECORDING':
            sendResponse(await startGifRecording(msg.data.streamId));
            break;

          case 'STOP_GIF_RECORDING':
            sendResponse(await stopGifRecording());
            break;

          case 'PAUSE_GIF_RECORDING':
            sendResponse(await pauseGifRecording());
            break;

          case 'RESUME_GIF_RECORDING':
            sendResponse(await resumeGifRecording());
            break;

          case 'GIF_OFFSCREEN_DONE':
            // Completion report from the offscreen recorder. Cleanup must run
            // even if the notification path misbehaves — catch here, and the
            // reply is just an ack.
            await handleGifOffscreenDone(msg.data).catch((err) =>
              console.error('[background] gif cleanup failed', err),
            );
            sendResponse({ ok: true });
            break;

          case 'PING':
            sendResponse({ type: 'PONG', at: Date.now() });
            break;

          case 'LIST_GATEWAY_LOGS': {
            sendResponse({ logs: await listGatewayLogs() });
            break;
          }

          case 'CLEAR_GATEWAY_LOGS': {
            await clearGatewayLogs();
            sendResponse({ ok: true });
            break;
          }

          case 'LIST_GATEWAY_PROXY_RULES': {
            sendResponse({ rules: await listGatewayProxyRules() });
            break;
          }

          case 'ADD_GATEWAY_PROXY_RULE': {
            try {
              // UI-created rules are enabled immediately (the user just authored them).
              const rule = await addProxyRule(msg.data, true, 'user');
              sendResponse({ rule });
            } catch (err) {
              sendResponse({ __error: err instanceof Error ? err.message : String(err) });
            }
            break;
          }

          case 'UPDATE_GATEWAY_PROXY_RULE': {
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
              sendResponse({ __error: err instanceof Error ? err.message : String(err) });
            }
            break;
          }

          case 'DELETE_GATEWAY_PROXY_RULE': {
            await deleteGatewayProxyRule(msg.data.id);
            sendResponse({ ok: true });
            break;
          }

          case 'GATEWAY_CONFIRM_DECISION': {
            const { id, approved } = msg.data;
            sendResponse({ ok: resolveGatewayConfirmation(id, approved) });
            break;
          }

          case 'GATEWAY_CONFIRM_PING': {
            // Keepalive only — also tells the page when its request is gone.
            sendResponse({ ok: isPendingConfirmation(msg.data.id) });
            break;
          }

          case 'GATEWAY_CONFIRM_TEST': {
            // Debug-only: exercise the confirmation gate with a fake request.
            // Nothing is forwarded and no audit log is written.
            const approved = await requestGatewayConfirmation({
              method: 'GET',
              url: 'https://example.com/api/test-confirmation',
              bodyPreview: JSON.stringify({ debug: true, source: 'settings-test' }, null, 2),
              via: 'agent',
            });
            sendResponse({ approved });
            break;
          }

          case 'GATEWAY_CONFIRM_RESIZE': {
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
        console.error('[background] message handler failed', msg.type, err);
        sendResponse({
          __error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    // Keep the message channel open for the async sendResponse above.
    return true;
  });
});
