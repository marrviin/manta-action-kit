/**
 * Extension-side view of the WS bridge protocol.
 *
 * The wire types, RPC map, frame definitions, and tool registry now live in the
 * shared workspace package @manta-action-kit/protocol — the single source of
 * truth consumed by BOTH this extension and packages/mcp. This module re-exports
 * them under the extension's `@/lib/mcp/protocol` import path and keeps only the
 * extension-specific piece: the i18n key builders for the MCP tab's tool list
 * (the labels are UI strings, they don't belong in the wire protocol).
 */
export * from '@manta-action-kit/protocol';

import type { ToolName } from '@manta-action-kit/protocol';

/**
 * i18n key builders for a tool's user-facing label/description in the MCP tab.
 * The catalog namespace is `mcpTools` with `<method>Label` / `<method>Desc` keys
 * (see lib/i18n/locales/*). These are what the USER sees and follow the UI
 * language; the tool definitions the AGENT sees live in packages/mcp/src/index.ts
 * and stay English.
 */
export const toolLabelKey = (method: ToolName) =>
  `mcpTools.${method}Label` as const;
export const toolDescKey = (method: ToolName) =>
  `mcpTools.${method}Desc` as const;
