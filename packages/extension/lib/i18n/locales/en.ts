/**
 * English translation catalog. This file is the AUTHORITATIVE key structure —
 * `zh-CN.ts` must mirror its shape, and the type augmentation in `i18n.d.ts` binds
 * autocompletion/validation to `typeof en`. Keys are grouped by feature/surface.
 *
 * Interpolation uses i18next's `{{name}}` syntax; count-bearing strings pass
 * `{ count }` (and `{ total }` where two numbers appear).
 */
export const en = {
  common: {
    delete: "Delete",
    cancel: "Cancel",
    add: "Add",
    save: "Save",
    retry: "Retry",
    empty: "(empty)",
    updateFailed: "Update failed",
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Copy failed, please check clipboard permission",
    deleted: "Deleted",
    deleteFailed: "Delete failed",
    none: "None",
    copyUrl: "Copy URL",
    rename: "Rename",
  },
  popup: {
    paused: "Paused",
    recording: "Recording",
    apiRecording: "API Recording",
    actions: "Actions",
    settings: "Settings",
    noActiveTab: "Unable to get the current tab",
    unsupportedPage:
      "This page does not support recording; use a regular web page",
  },
  home: {
    apiRecording: "API Recording",
    actions: "Actions",
    gateway: "Secure Sandbox",
    mcp: "MCP",
    settings: "Settings",
  },
  recording: {
    tabRecords: "Recordings",
    tabRules: "Filter Rules",
    startRecording: "Record",
    statusRecording: "Recording · {{count}}",
    statusPaused: "Paused · {{count}}",
    pause: "Pause",
    resume: "Resume",
    stop: "Stop",
    pauseRecording: "Pause recording",
    resumeRecording: "Resume recording",
    stopAndSave: "Stop and save",
    addFilterRule: "Add filter rule",
    urlPattern: "URL pattern",
    urlPatternTip:
      "Use the wildcard * to match any characters. Requests matching this pattern are dropped while recording. e.g. */track* or https://a.com/api/*",
    urlPatternRequired: "Please enter a URL pattern",
    urlPatternPlaceholder: "e.g. */analytics*",
    ruleAdded: "Filter rule added",
    deleteRuleTitle: "Delete this filter rule",
    deleteRuleConfirm: 'Delete "{{pattern}}"?',
    searchRule: "Search filter rule",
    noMatchRule: "No matching filter rule found",
    blacklist: "Blacklist",
    loadFailed: "Failed to load recordings",
    searchPlaceholder: "Search recording name or API URL",
    noMatch: "No matching recording found",
    callCount: "{{count}} calls",
    deleteRecordingTitle: "Delete this recording",
    deleteRecordingConfirm: 'Delete "{{name}}"?',
  },
  action: {
    loadFailed: "Failed to load actions",
    searchPlaceholder: "Search action name or description",
    noMatch: "No matching action found",
    empty:
      "No actions yet. Ask your Agent to create one from a recording via the create_action MCP tool.",
    deleteTitle: "Delete this action",
    deleteConfirm: 'Delete the action "{{name}}"?',
    stepCount: "{{count}} steps",
    paramCount: "{{count}} params",
    noParams: "No params",
    paramOptional: "optional",
    paramsLabel: "Params",
    stepsLabel: "Steps",
    descriptionLabel: "Description",
    stepOverrides: "{{count}} overrides",
    stepWait: "wait {{ms}}ms",
  },
  flow: {
    locBody: "Request Body",
    locQuery: "Query Param",
    locHeader: "Request Header",
    locUrl: "URL",
    valueTooltip: "Value: {{value}}",
    response: "response",
    // "{{target}} ← step #{{fromSeq}} {{fromField}}"
    consumes: "{{target}} ← step #{{fromSeq}} {{fromField}}",
    // "response {{fromPath}} → step #{{toSeq}} {{target}}"
    produces: "response {{fromPath}} → step #{{toSeq}} {{target}}",
  },
  detail: {
    titleWithCount: "{{name}} ({{count}} calls)",
    tabResult: "Recorded Result",
    tabEndpoints: "Endpoints",
    callChainTitle: "Call Chain",
    descExpand: "Expand",
    descCollapse: "Collapse",
    waitGap: "Wait {{gap}}",
    deleteCallTitle: "Delete this call",
    deleteCallConfirm:
      'Delete "{{url}}"? Removing it does not affect the other calls\' wait times.',
    reqHeaders: "Request Headers",
    reqBody: "Request Body",
    response: "Response · {{status}} {{statusText}}",
    error: "Error",
    streamResponse:
      "Stream Response · {{status}} {{statusText}} · {{count}} events",
    noEvents: "(no events captured)",
  },
  endpoints: {
    statuses: "Statuses",
    query: "Query Params",
    request: "Request Body",
    response: "Response Body",
    noSchema: "(no schema)",
    optional: "optional",
    nullable: "nullable",
    items: "items",
    inputsFrom: "Value sources",
    inputFromLabel: "{{to}} ← {{from}} {{fromPath}}",
  },
  gateway: {
    tabLogs: "Audit Logs",
    tabProxy: "Sandbox Rules",
    decisionAuto: "Auto allowed",
    decisionAllowed: "Confirmed",
    decisionBlocked: "Blocked",
    decisionUnknown: "Unknown",
    authAgent: "MCP Call",
    authRule: "Proxy Rule",
    authNone: "None",
    entryMcp: "MCP",
    entryProxy: "Proxy",
    searchUrl: "Search request URL",
    noMatchRequest: "No matching request found",
    loadFailed: "Load failed: {{error}}",
    noLogsToExport: "No audit logs to export",
    exported: "Exported {{count}} audit logs",
    exportFailed: "Export failed",
    copyResponse: "Copy Response",
    copyCurl: "Copy cURL",
    export: "Export",
    exportLogs: "Export audit logs",
    summary: "Summary",
    injectedCookie: "Injected Cookie",
    injectedCookieValue: "{{names}} ({{domain}}, names only)",
    reqHeaders: "Request Headers",
    reqBody: "Request Body",
    resHeaders: "Response Headers",
    response: "Response · {{status}} {{statusText}}",
    streamResponse:
      "Stream Response · {{status}} {{statusText}} · {{count}} events",
    error: "Error",
    createdByAgent: "AI",
    createdByUser: "User",
    addProxyRule: "Add proxy rule",
    editProxyRule: "Edit proxy rule",
    deleteProxyRuleTitle: "Delete this proxy rule",
    deleteProxyRuleConfirm: 'Delete "{{prefix}} → {{target}}"?',
    searchRule: "Search prefix or target",
    noMatchRule: "No matching proxy rule found",
    pathPrefix: "Path Prefix",
    pathPrefixRequired: "Please enter a path prefix",
    pathPrefixPlaceholder: "e.g. /api",
    targetAddress: "Target Address",
    targetAddressRequired: "Please enter a target address",
    ruleSaved: "Proxy rule saved",
    ruleAdded: "Proxy rule added",
    saveFailed: "Save failed",
    addFailed: "Add failed",
    editRule: "Edit rule",
    // Plain-text export file labels.
    exportHeaderTitle: "Secure Sandbox Audit Log Export",
    exportHeaderTime: "Exported at",
    exportHeaderCount: "Records",
    logDecision: "Decision",
    logStatus: "Status",
    logKind: "Kind",
    logDuration: "Duration",
    logAuthSource: "Auth source",
    logInjectedCookie: "Injected Cookie",
    logReqHeaders: "Request headers",
    logReqBody: "Request body",
    logResHeaders: "Response headers",
    logResBody: "Response body",
    logSseCount: "SSE event count",
    logError: "Error",
    curlCookieComment:
      "Injected cookies (values not stored, names only): {{names}} ({{domain}})",
  },
  mcp: {
    connected: "Connected",
    connecting: "Connecting",
    disconnected: "Disconnected",
    introTitle: "Connect your AI Agent via the MCP protocol",
    introDesc:
      "Manta Action Kit MCP opens the Chrome extension's capabilities to your Agent:",
    introBullet1:
      "Query and inspect locally recorded API data (list / call chain detail / single request & response)",
    introBullet2:
      'Forward authorized APIs reusing your browser login via the "Secure Sandbox" — cookies are never exposed to the Agent',
    introFooter:
      "Copy the install prompt below and send it to your Agent to auto-write the MCP config and connect.",
    copyInstallPrompt: "Copy install prompt",
    installPromptCopied:
      "Install instructions copied — paste them to your Agent",
    status: "Status",
    port: "Bridge Port",
    proxyPort: "Secure Sandbox Port",
    tools: "Tools",
    toolEnabled: 'Enabled "{{label}}"',
    toolDisabled: 'Disabled "{{label}}"',
  },
  // Labels/descriptions of MCP tools AS SHOWN IN THE MCP TAB (user-facing, follows
  // the UI language). This is separate from the tool definitions the agent sees
  // inside the MCP process (packages/mcp/src/index.ts), which stay English.
  mcpTools: {
    list_recordingsLabel: "List API recordings",
    list_recordingsDesc:
      "Get an overview of locally recorded API sets (name, origin, call count); recordings are source material for creating actions",
    get_recordingLabel: "Get recording detail",
    get_recordingDesc:
      "Get a recording's full call chain, including each API's request and response; source material for creating actions",
    set_recording_descriptionLabel: "Set recording description",
    set_recording_descriptionDesc:
      "Write an agent-authored, business-level summary of the whole flow — its purpose, what it can do, and caveats for reuse (not a per-endpoint field dump). Dedicated write path; shown read-only on the detail page",
    get_flowLabel: "Get API call dependency flow",
    get_flowDesc:
      "Get a recording's call flow: an ordered step summary plus the field dependencies between APIs (an earlier response feeding a later request)",
    get_endpointsLabel: "Get API contracts",
    get_endpointsDesc:
      "Get the deduplicated endpoint list for a recording: aggregated by method + normalized path, with an inferred and sanitized request/response schema (no real data)",
    get_callLabel: "Get a single API call",
    get_callDesc:
      "Get one API call's request and response detail by its call ID",
    proxy_fetchLabel: "Credentialed proxy request",
    proxy_fetchDesc:
      "Send an API request through the extension proxy; the extension injects login credentials, which are never exposed to the AI",
    proxy_sseLabel: "Credentialed proxy request (streaming)",
    proxy_sseDesc:
      "Send an SSE streaming API request through the extension proxy, injecting login credentials and aggregating the returned events",
    proxy_ruleLabel: "Script-driven proxy tunnel",
    proxy_ruleDesc:
      "Internal tunnel that forwards a script-driven proxy request to a matching rule (not an agent-facing tool)",
    list_proxy_rulesLabel: "List proxy rules",
    list_proxy_rulesDesc:
      "Get the sandbox proxy rule list (prefix, target address, methods, enabled state)",
    add_proxy_ruleLabel: "Add proxy rule",
    add_proxy_ruleDesc:
      "Add a sandbox proxy rule (without the enable switch — the enabled state stays under the user's control)",
    update_proxy_ruleLabel: "Update proxy rule",
    update_proxy_ruleDesc:
      "Update a proxy rule's prefix / target address / methods (cannot change the enable switch)",
    list_actionsLabel: "List actions",
    list_actionsDesc:
      "Get locally created actions (name, description, parameter and step counts)",
    get_actionLabel: "Get action detail",
    get_actionDesc:
      "Get an action's full definition: description, params, and the recorded steps (with URL/query/header/body overrides) it replays",
    search_actionsLabel: "Search actions",
    search_actionsDesc:
      "Full-text search actions by name and description for the Agent to pick a reusable one",
    create_actionLabel: "Create action",
    create_actionDesc:
      "Turn a recording into a reusable action: name it, describe it, declare params, and map {{param}} placeholders onto the recorded steps",
    update_actionLabel: "Update action",
    update_actionDesc:
      "Update an action's name, description, params, or step overrides (steps must still reference the same recording)",
    delete_actionLabel: "Delete action",
    delete_actionDesc: "Delete a locally created action",
    execute_actionLabel: "Execute action",
    execute_actionDesc:
      "Replay an action against real endpoints through the sandbox proxy with your login credentials, filling params and chaining step outputs; requires explicit user confirmation",
    set_proxy_portLabel: "Set proxy port",
    set_proxy_portDesc:
      "Internal capability that updates the local proxy port the extension talks to (not an agent-facing tool)",
    healthLabel: "Service health check",
    healthDesc:
      "Check the MCP service's port usage and connection status (built-in capability, not affected by the switches)",
    rebind_proxyLabel: "Proxy port self-heal",
    rebind_proxyDesc:
      "On a port conflict, automatically move the local proxy to a free port and sync it to the extension (built-in capability, not affected by the switches)",
  },
  settings: {
    title: "Settings",
    language: "Language",
    languageChinese: "中文",
    languageEnglish: "English",
  },
} as const;

/**
 * The authoritative message shape derived from `en`, but with every leaf string
 * literal widened to `string`. Other locales (e.g. `zh-CN`) must mirror `en`'s
 * key structure while supplying their own translated values, so they annotate
 * against this type instead of `typeof en` (which would force values to equal
 * the English literals).
 */
export type Messages = {
  [K in keyof typeof en]: {
    [P in keyof (typeof en)[K]]: string;
  };
};
