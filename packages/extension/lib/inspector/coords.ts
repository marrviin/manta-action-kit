/**
 * Pure coordinate math for the programmatic (agent) element capture.
 *
 * Two conversions are needed:
 *
 *  1. PAGE <-> VIEWPORT: `capture_element`'s point/box accept either space.
 *     Agents naturally read coordinates off a `capture_screenshot` image —
 *     mode=fullPage images are in PAGE coordinates (document space), while
 *     mode=visible images match the viewport. Viewport-space hit-testing
 *     (`elementFromPoint`, `getBoundingClientRect` comparisons) requires the
 *     point to be on screen, so a page-space point is first scrolled to the
 *     viewport center; a page-space box scrolls its center too (virtualized
 *     lists render nothing below the fold otherwise). No conversion can
 *     distinguish an in-viewport page coordinate from a viewport one, which
 *     is why `coordinates` is an explicit parameter and inference only ever
 *     fires for coordinates OUTSIDE the viewport (those could never be valid
 *     viewport coordinates).
 *
 *  2. PARENT -> CHILD FRAME: a point/box that lands inside an <iframe> is
 *     captured by the CHILD frame's content script, in the child's own
 *     viewport coordinates. The child viewport origin is the iframe's content
 *     box origin in the parent viewport (border + padding offset); scroll
 *     positions on either side are irrelevant — both spaces are
 *     viewport-relative.
 *
 * Kept DOM-free so it unit-tests without a browser.
 */

export type CoordinateSpace = "page" | "viewport";

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewport {
  w: number;
  h: number;
}

export interface ScrollOffset {
  x: number;
  y: number;
}

/**
 * Infer the coordinate space of a point when `coordinates` is unset. Anything
 * outside the viewport can only be a page coordinate (elementFromPoint would
 * return null for it); in-viewport points stay viewport (the common case:
 * coords read off a visible-viewport screenshot).
 */
export function inferPointSpace(p: Point, vp: Viewport): CoordinateSpace {
  return p.x < 0 || p.y < 0 || p.x > vp.w || p.y > vp.h ? "page" : "viewport";
}

/** Same inference for a box: any edge outside the viewport → page space. */
export function inferBoxSpace(b: Box, vp: Viewport): CoordinateSpace {
  return b.x < 0 || b.y < 0 || b.x + b.w > vp.w || b.y + b.h > vp.h
    ? "page"
    : "viewport";
}

/**
 * Scroll position that centers a page-space point in the viewport — the
 * center is the spot least likely to be covered by sticky headers/footers
 * after the scroll. Browser-side clamping (document bounds) happens in
 * window.scrollTo; no need to duplicate it here.
 */
export function scrollForPagePoint(p: Point, vp: Viewport): ScrollOffset {
  return { x: p.x - vp.w / 2, y: p.y - vp.h / 2 };
}

/** Scroll position that centers a page-space box in the viewport. */
export function scrollForPageBox(b: Box, vp: Viewport): ScrollOffset {
  return { x: b.x + b.w / 2 - vp.w / 2, y: b.y + b.h / 2 - vp.h / 2 };
}

/** Page-space point → viewport-space, given the (new) scroll offset. */
export function pagePointToViewport(p: Point, scroll: ScrollOffset): Point {
  return { x: p.x - scroll.x, y: p.y - scroll.y };
}

/** Page-space box → viewport-space, given the (new) scroll offset. */
export function pageBoxToViewport(b: Box, scroll: ScrollOffset): Box {
  return { x: b.x - scroll.x, y: b.y - scroll.y, w: b.w, h: b.h };
}

/**
 * Parent-viewport point → child-frame viewport point. `origin` is the
 * iframe's content box origin in the parent viewport (rect.left/top + border
 * + padding). CSS transforms/zoom on the iframe would break the linear map —
 * accepted limitation, same as every coordinate-based tool.
 */
export function pointIntoFrame(
  p: Point,
  origin: { x: number; y: number },
): Point {
  return { x: p.x - origin.x, y: p.y - origin.y };
}

/** Parent-viewport box → child-frame viewport box. */
export function boxIntoFrame(b: Box, origin: { x: number; y: number }): Box {
  return { x: b.x - origin.x, y: b.y - origin.y, w: b.w, h: b.h };
}
