/**
 * Scroll-and-stitch full-page screenshot protocol (background <-> content
 * script, chrome.tabs.sendMessage peer-to-peer — bare const types like
 * PLAY_SCREENSHOT_FX, not the runtime ProtocolMap bus).
 *
 * Why stitch instead of the CDP single render (captureBeyondViewport): CDP
 * paints the LAYOUT OVERFLOW bounds, so any decorative element poking past
 * the content inflates the image with blank edges, and lazy-loaded images
 * never scrolled into view come out grey. Scrolling viewport by viewport
 * keeps the width pinned to the viewport, triggers lazy loading naturally,
 * and renders every screen exactly as the user sees it.
 *
 * Division of labor: the background orchestrates (only it can call
 * captureVisibleTab); the page scrolls and stitches (canvas lives in the
 * renderer — MV3 service workers have none). See lib/screenshot/stitch.ts
 * (background) and lib/screenshot/stitch-page.ts (content script).
 */

export const FULLPAGE_BEGIN = "FULLPAGE_BEGIN";
export const FULLPAGE_SCROLL = "FULLPAGE_SCROLL";
export const FULLPAGE_END = "FULLPAGE_END";
export const FULLPAGE_STITCH = "FULLPAGE_STITCH";

/** The stitcher's output: a data URL plus its actual format (PNG, or JPEG
 * when the page is huge and PNG would blow the session-storage handoff cap). */
export interface FullpageStitchResult {
  dataUrl: string;
  type: "png" | "jpg";
}

/** Viewport facts the content script reports at BEGIN. */
export interface FullpageMetrics {
  /** Viewport width in CSS px — zoom-proof stitch scale derives from this. */
  vw: number;
  /** Viewport height in CSS px — screens advance by this. */
  vh: number;
  /** Device pixel ratio at capture time (browser zoom included). */
  dpr: number;
  /** Document scroll height in CSS px (re-reported on every SCROLL). */
  docH: number;
}
