/**
 * Shared types for the in-page element capture ("inspector capture").
 *
 * `ElementDescription` is the JSON shape produced by the content script
 * (lib/inspector/capture.ts), copied to the clipboard and handed to the
 * preview tab (`?mode=element`) via IndexedDB (`inspectorCaptures` store).
 * The preview rebuilds the DOM from it; the clipboard JSON doubles as an
 * LLM-ready description of the element.
 *
 * The wire types themselves live in @manta-action-kit/protocol (the shared
 * workspace package — the MCP `get_element_capture` / `diff_element_captures`
 * tools consume the same shape), re-exported here so the extension's existing
 * `@/lib/inspector/types` imports stay unchanged. `ATTR_WHITELIST` is a
 * capture-side policy constant, not a wire type, so it stays here.
 */

export type {
  ElementDescription,
  InspectorCapturePayload,
} from "@manta-action-kit/protocol";

/**
 * Attribute whitelist captured per element: small, high-signal attributes that
 * styles alone cannot express (form state, links, image sources, a11y hints).
 * `src`/`href` are resolved to absolute URLs at capture time.
 */
export const ATTR_WHITELIST = [
  "src",
  "href",
  "alt",
  "title",
  "placeholder",
  "value",
  "type",
  "name",
  "target",
  "colspan",
  "rowspan",
  "disabled",
  "checked",
  "readonly",
  "role",
  "aria-label",
  "contenteditable",
  "width",
  "height",
] as const;
