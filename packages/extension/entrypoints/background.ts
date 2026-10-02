import { initMcpBridge } from "@/lib/mcp/bridge";
import { createMessageHandler } from "@/lib/background/message-handler";
import {
  addProxyRule,
  updateProxyRuleContent,
} from "@/lib/gateway/manage-rules";
import {
  clearGatewayLogs,
  deleteGatewayProxyRule,
  listGatewayLogs,
  listGatewayProxyRules,
  saveScreenshotHistory,
  upsertGatewayProxyRule,
} from "@/lib/db";
import { handleGifOffscreenDone, initGifStateWatch } from "@/lib/gif-recording/session";
import { ensureLayaRuntime } from "@/lib/ai/laya-session";
import { analyzeRecordingRelevance } from "@/lib/ai/relevance-run";
import {
  initGatewayConfirm,
  isPendingConfirmation,
  requestGatewayConfirmation,
  resizeGatewayConfirmation,
  resolveGatewayConfirmation,
} from "@/lib/gateway/confirm";
import {
  initGifConfirm,
  isPendingGifConfirmation,
  resolveGifConfirmation,
} from "@/lib/gif-confirm";
import {
  pauseGifRecording,
  resumeGifRecording,
  startGifRecording,
  stopGifRecording,
} from "@/lib/gif-recording/session";
import { captureTabScreenshot } from "@/lib/screenshot/capture-flow";
import * as session from "@/lib/recording/session";

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

  // GIF recording confirmation popup (agent-requested tab capture): same
  // window-closed → deny listener pattern.
  initGifConfirm();

  // GIF orphan-state watch: drops a stuck "recording" state if Chrome kills
  // the offscreen document mid-recording (see lib/gif-recording/session.ts).
  initGifStateWatch();

  browser.runtime.onMessage.addListener(
    createMessageHandler({
      session,
      analyzeRecordingRelevance,
      captureTabScreenshot,
      saveScreenshotHistory,
      listGatewayLogs,
      clearGatewayLogs,
      listGatewayProxyRules,
      deleteGatewayProxyRule,
      upsertGatewayProxyRule,
      addProxyRule,
      updateProxyRuleContent,
      requestGatewayConfirmation,
      isPendingConfirmation,
      resizeGatewayConfirmation,
      resolveGatewayConfirmation,
      startGifRecording,
      stopGifRecording,
      pauseGifRecording,
      resumeGifRecording,
      handleGifOffscreenDone,
      resolveGifConfirmation,
      isPendingGifConfirmation,
      ensureLayaRuntime,
    }),
  );
});
