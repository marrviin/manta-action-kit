/**
 * Type-safe, versioned storage definitions.
 *
 * WXT's `storage` API wraps `chrome.storage` with typed, reactive items that sync
 * automatically across popup, side panel, content scripts, and background.
 * Docs: https://wxt.dev/storage.html
 */
import { storage } from "#imports";
import {
  IDLE_RECORDING_STATE,
  type RecordingFilterRule,
  type RecordingState,
} from "./recording/types";
import type { RpcMethod } from "./mcp/protocol";
import type { Locale } from "./i18n";
import { detectLocale } from "./i18n/detect";

export const settings = {
  /**
   * UI language. Drives both react-i18next (`t(...)`) and antd's ConfigProvider
   * locale. Defaults to the browser's UI language (e.g. a zh-CN browser gets
   * zh-CN), until the user picks one explicitly in settings. Synced across
   * popup / side panel via WXT storage watchers (see lib/i18n/sync.ts +
   * components/app-providers.tsx).
   */
  locale: storage.defineItem<Locale>("sync:locale", {
    fallback: detectLocale(),
  }),

  /** Port of the local MCP WebSocket server the extension connects to. */
  mcpPort: storage.defineItem<number>("sync:mcpPort", {
    fallback: 8787,
  }),

  /**
   * Port of the local HTTP proxy the MCP server exposes for the script-driven
   * gateway entry (proxy rules). Display-only in the extension — it's the port
   * scripts point their baseURL at (http://127.0.0.1:<proxyPort><sandboxPrefix>).
   * Must match the MCP server's MANTA_PROXY_PORT.
   */
  proxyPort: storage.defineItem<number>("sync:proxyPort", {
    fallback: 8788,
  }),

  /**
   * Per-tool kill switches for the MCP tools exposed to the agent, keyed by RPC
   * method name. A method is DISABLED only when its value is explicitly `false`;
   * missing / `true` means enabled. So the default (empty object) is "everything
   * on" — the extension is useful immediately after install with no toggling, and
   * the real safety gate for the forwarding tools stays the per-call native
   * permission prompt (requiresUserInteraction), which can't be turned off.
   *
   * Managed from the MCP side-panel tab (see components/mcp/mcp-feature.tsx) and
   * enforced at the RPC entry point (see lib/mcp/handlers.ts).
   */
  mcpToolEnabled: storage.defineItem<Partial<Record<RpcMethod, boolean>>>(
    "sync:mcpToolEnabled",
    {
      fallback: {},
    },
  ),
};

/**
 * Live recording state. Stored in the `session` area so it survives the MV3
 * service worker sleeping but clears when the browser fully restarts. Readable by
 * popup and content scripts to know whether/where recording is active.
 */
export const recordingState = storage.defineItem<RecordingState>(
  "session:recordingState",
  {
    fallback: IDLE_RECORDING_STATE,
  },
);

/**
 * Recording filter rules (blacklist). Structured config, so it lives in `local`
 * storage (persists across restarts) and syncs reactively to the side panel.
 * The background session reads this to drop matching calls while recording.
 */
export const recordingFilterRules = storage.defineItem<RecordingFilterRule[]>(
  "local:recordingFilterRules",
  { fallback: [] },
);

/**
 * Live MCP bridge connection status, written by the background service worker (the
 * only context that owns the WebSocket) and read reactively by the MCP tab to show
 * a status indicator. Session-scoped so it survives SW sleep but resets on restart.
 *
 * There is no MCP master switch anymore: the bridge always tries to connect to the
 * local MCP server, and the real per-call gate is the tool's native permission
 * prompt. So this is a status readout, not a setting.
 */
export type McpConnStatus = "connecting" | "connected" | "disconnected";

export const mcpConnStatus = storage.defineItem<McpConnStatus>(
  "session:mcpConnStatus",
  {
    fallback: "connecting",
  },
);

/**
 * Which feature tab the side panel home page should select when it next opens.
 * Set by the popup (e.g. picking "MCP") right before calling `sidePanel.open`,
 * then consumed and cleared by the home page on mount. `null` means "no request —
 * keep the default tab". Session-scoped so it survives SW sleep but not restart.
 */
export type SidePanelTab = "api-recording" | "action" | "gateway" | "mcp";

export const sidePanelTab = storage.defineItem<SidePanelTab | null>(
  "session:sidePanelTab",
  {
    fallback: null,
  },
);

/**
 * The feature tab the user last viewed in the side panel home page. Persisted in
 * local storage (survives browser restart) so that, absent an explicit popup
 * request (`sidePanelTab`), reopening the side panel restores the user's last tab
 * instead of always defaulting to the first one. Updated whenever the user
 * switches feature tabs. `null` means "never chosen — fall back to the default".
 */
export const lastSidePanelTab = storage.defineItem<SidePanelTab | null>(
  "local:lastSidePanelTab",
  {
    fallback: null,
  },
);
