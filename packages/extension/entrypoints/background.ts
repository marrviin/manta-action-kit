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
import { ensureLayaRuntime, preloadLayaModel, resumeLayaModelDownload } from "@/lib/ai/laya-session";
import {
  analyzeRecordingRelevance,
  rerunPendingAnalyses,
} from "@/lib/ai/relevance-run";
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

  // Lay a warm cache for the laya decision model: the ~850 MB weights are NOT
  // shipped in the package — they are downloaded from the artifacts repo on
  // first use (see lib/ai/runtime.ts). Start that download right after
  // install/upgrade so the first real predict doesn't wait for it. Dev runs
  // this too, deliberately: the download path is what production exercises,
  // and the cache-first warm-up makes repeat reloads cheap.
  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason !== "install" && details.reason !== "update") return;
    preloadLayaModel().catch((err) =>
      console.error("[background] laya model preload failed", err),
    );
  });

  // Browser startup: resume an artifact download that a browser shutdown
  // killed mid-way. Warm-only — a complete cache makes this a no-op, so no
  // model memory is spent on normal startups.
  browser.runtime.onStartup.addListener(() => {
    resumeLayaModelDownload().catch((err) =>
      console.error("[background] laya download resume failed", err),
    );
  });

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
      rerunPendingAnalyses,
    }),
  );
});
