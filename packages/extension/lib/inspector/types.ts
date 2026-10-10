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

import type { CoordinateSpace } from "./coords";

export type { CoordinateSpace };

/**
 * Programmatic capture request — the AGENT_CAPTURE_ELEMENTS message payload
 * and the capture_element RPC params (mirrored in
 * @manta-action-kit/protocol's RpcMap). Exactly one of selector / point / box.
 */
export interface AgentCaptureRequest {
  selector?: string;
  point?: { x: number; y: number };
  box?: { x: number; y: number; w: number; h: number };
  all?: boolean;
  maxElements?: number;
  /**
   * Which space point/box are expressed in. Default (and the value used when
   * unset) is "viewport"; "page" is document space (e.g. coordinates read off
   * a full-page screenshot). When unset, coordinates that fall outside the
   * viewport are automatically treated as page coordinates.
   */
  coordinates?: CoordinateSpace;
  /**
   * Internal: how many child-frame relays this request has already crossed.
   * Caps the recursion into nested iframes; never set by callers.
   */
  relayDepth?: number;
}

/**
 * Reply shape of the programmatic (agent) element capture, shared by the
 * AGENT_CAPTURE_ELEMENTS message, the capture-relay handshake (a child frame
 * reports its capture back through the background) and the capture_element
 * RPC's internal steps.
 */
export interface AgentCaptureResult {
  ok: boolean;
  captureId?: string;
  elementCount?: number;
  page?: { url: string; title: string };
  capturedAt?: string;
  error?: string;
}

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
