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
  // Allow content scripts (untrusted contexts) to read session storage, so the
  // in-page toolbar can watch recordingState / toolbarState. Defaults to trusted-only.
  chrome.storage.session
    .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
    .catch((err) => console.error('[background] session setAccessLevel failed', err));

  // Open the side panel when the toolbar icon is clicked (Chromium only).
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: false })
      .catch((err) => console.error('[background] setPanelBehavior failed', err));
  }

  // MCP bridge: dial the local MCP WebSocket server when enabled in settings.
  initMcpBridge().catch((err) => console.error('[background] initMcpBridge failed', err));

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

          case 'STOP_RECORDING':
            sendResponse(await session.stop());
            break;

          case 'SET_PAUSED':
            sendResponse(await session.setPaused(msg.data.paused));
            break;

          case 'GET_TAB_ID':
            sendResponse({ tabId: sender.tab?.id ?? null });
            break;

          case 'API_CALL_CAPTURED': {
            const count = await session.push(msg.data, sender.tab?.id);
            sendResponse({ ok: true, count });
            break;
          }

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
