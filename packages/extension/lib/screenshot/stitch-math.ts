/**
 * Pure stitching math for the scroll-and-stitch full-page capture, kept
 * separate from the DOM-carrying modules so it can be unit-tested.
 */

/**
 * Device-px-per-CSS-px measured from an actual capture instead of trusting
 * window.devicePixelRatio — with browser zoom the two disagree, and every
 * offset in the stitcher is derived from this (same defense as the reference
 * mrcoles extension: rescale by image.width / windowWidth).
 */
export function effectiveScale(
  imageWidth: number,
  cssWidth: number,
): number {
  if (!(cssWidth > 0)) return 1;
  const s = imageWidth / cssWidth;
  return s > 0 && Number.isFinite(s) ? s : 1;
}

/** One screen's exclusive slice of the final canvas, in device px. */
export interface StitchBand {
  top: number;
  height: number;
}

/**
 * Exclusive per-screen bands: screen i owns exactly the canvas rows
 * [top, top+height), sourced from the top of its own capture. Every row of
 * the final image comes from exactly one screen — no full-screen overpaint —
 * so per-screen rounding can never open gaps or duplicate rows at a seam
 * (the failure mode of drawing whole screens at independently rounded
 * offsets, where each seam is off by up to half a device pixel).
 */
export function stitchBands(
  offsets: number[],
  scale: number,
  docHeight: number,
  viewportHeight: number,
): StitchBand[] {
  const docDev = Math.max(0, Math.round(docHeight * scale));
  const vhDev = Math.max(1, Math.round(viewportHeight * scale));
  return offsets.map((off, i) => {
    const top = Math.min(docDev, Math.max(0, Math.round(off * scale)));
    const next = offsets[i + 1];
    // Bottom is the next screen's top, except for the last screen, whose
    // band runs to the document end (or its own viewport bottom, whichever
    // is closer — scroll clamp / doc shrink mid-capture).
    const rawBottom =
      next === undefined ? top + vhDev : Math.round(next * scale);
    const bottom = Math.min(rawBottom, top + vhDev, docDev);
    return { top, height: Math.max(0, bottom - top) };
  });
}

/** Chromium renders canvas surfaces up to 16384 device px per edge. */
export const MAX_STITCH_EDGE = 16384;

/**
 * Uniform downscale factor (≤ 1) so the stitched canvas fits the renderer's
 * surface cap — the same trade-off as the CDP path's clip+scale fallback
 * (retina sharpness for completeness) on extremely tall pages.
 */
export function stitchScale(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): number {
  const widest = Math.max(cssWidth * dpr, cssHeight * dpr, 1);
  return widest > MAX_STITCH_EDGE ? MAX_STITCH_EDGE / widest : 1;
}
