/**
 * Shared types for the in-page element capture ("inspector capture").
 *
 * `ElementDescription` is the JSON shape produced by the content script
 * (lib/inspector/capture.ts), copied to the clipboard and handed to the
 * preview tab (`?mode=element`) via IndexedDB (`inspectorCaptures` store,
 * id "preview" — full snapshots can exceed any session-storage quota).
 * The preview rebuilds the DOM from it; the clipboard JSON doubles as an
 * LLM-ready description of the element.
 */

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

export interface ElementDescription {
  tag: string;
  id?: string;
  classes?: string[];
  text?: string;
  /** Whitelisted attributes (see ATTR_WHITELIST); only present when non-empty. */
  attrs?: Record<string, string>;
  source?: { file: string; line?: number; column?: number };
  rect: { x: number; y: number; w: number; h: number };
  /** Only entries that differ from the CSS initial value / tree parent. */
  styles?: Record<string, string>;
  cssVars?: Record<string, string>;
  /**
   * Full computed styles (every non-empty property, resolved values) for
   * pixel-fidelity preview rebuilding. Present only in the payload handed to
   * the preview tab — stripped from the clipboard/lean JSON copies.
   */
  fullStyles?: Record<string, string>;
  /**
   * Computed styles of ::before / ::after decorations that actually render
   * content, so icon/decoration pseudos survive the rebuild. Stripped from
   * the lean JSON like `fullStyles`.
   */
  pseudo?: { before?: Record<string, string>; after?: Record<string, string> };
  /** Untruncated own text, present when `text` was clipped at 80 chars. */
  textFull?: string;
  children?: ElementDescription[];
}

/** Full clipboard / preview payload for one capture run. */
export interface InspectorCapturePayload {
  type: "inspector-capture";
  page: { url: string; title: string };
  capturedAt: string;
  /** Box-selection rect, or "click" for a click-pick. */
  selection: { x: number; y: number; w: number; h: number } | "click";
  elementCount: number;
  elements: ElementDescription[];
}

/** A complete comparison: pinned baseline (A) + the next capture (B). */
export interface InspectorDiffPair {
  a: InspectorCapturePayload;
  b: InspectorCapturePayload;
}
