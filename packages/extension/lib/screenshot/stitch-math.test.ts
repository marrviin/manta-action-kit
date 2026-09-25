import { describe, it, expect } from 'vitest';
import {
  MAX_STITCH_EDGE,
  effectiveScale,
  stitchBands,
  stitchScale,
} from './stitch-math';

describe('stitchScale', () => {
  it('returns 1 when the canvas fits the surface cap', () => {
    expect(stitchScale(1280, 800, 1)).toBe(1);
    expect(stitchScale(1280, 800, 2)).toBe(1); // 2560×1600 device px
    expect(stitchScale(1440, 7000, 2)).toBe(1); // 2880×14000 device px
  });

  it('downscales uniformly when an edge exceeds the cap', () => {
    const s = stitchScale(1280, 9000, 2); // 18000 device px tall
    expect(s).toBeCloseTo(MAX_STITCH_EDGE / 18000);
    // The scaled canvas fits the cap on every edge.
    expect(1280 * 2 * s).toBeLessThanOrEqual(MAX_STITCH_EDGE);
    expect(9000 * 2 * s).toBeLessThanOrEqual(MAX_STITCH_EDGE);
  });

  it('scales by the widest edge, not the sum', () => {
    expect(stitchScale(100, 20000, 1)).toBeCloseTo(MAX_STITCH_EDGE / 20000);
    expect(stitchScale(20000, 100, 1)).toBeCloseTo(MAX_STITCH_EDGE / 20000);
  });

  it('never divides by zero on degenerate input', () => {
    expect(stitchScale(0, 0, 0)).toBe(1);
  });
});

describe('effectiveScale', () => {
  it('derives device px per CSS px from the captured image', () => {
    expect(effectiveScale(2560, 1280)).toBe(2);
    expect(effectiveScale(1280, 1280)).toBe(1);
  });

  it('handles browser zoom (dpr disagreement)', () => {
    // At 90% zoom dpr reports 0.9 but the capture measures it directly.
    expect(effectiveScale(1152, 1280)).toBeCloseTo(0.9);
  });

  it('falls back to 1 on degenerate input', () => {
    expect(effectiveScale(0, 0)).toBe(1);
    expect(effectiveScale(100, 0)).toBe(1);
    expect(effectiveScale(0, 100)).toBe(1);
    expect(effectiveScale(100, NaN)).toBe(1);
  });
});

describe('stitchBands', () => {
  it('covers the document with contiguous, non-overlapping bands', () => {
    // 3 screens, dpr 2, doc 2400 css px, viewport 800 css px.
    const bands = stitchBands([0, 800, 1600], 2, 2400, 800);
    expect(bands).toEqual([
      { top: 0, height: 1600 },
      { top: 1600, height: 1600 },
      { top: 3200, height: 1600 },
    ]);
    // Contiguity: each band starts where the previous one ends.
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i]!.top).toBe(bands[i - 1]!.top + bands[i - 1]!.height);
    }
    expect(bands[2]!.top + bands[2]!.height).toBe(4800); // 2400 * 2
  });

  it('clamps the last band to the document end', () => {
    // Last screen lands at max scroll: its viewport bottom sits past docH.
    const bands = stitchBands([0, 1600], 1, 2000, 800);
    expect(bands[1]).toEqual({ top: 1600, height: 400 });
  });

  it('keeps every band within its own screen height', () => {
    // A scroll hijack that lands two screens on the same offset: the middle
    // screen has nothing new, so its band must be empty, not negative; the
    // last screen still owns the rows up to the document end.
    const bands = stitchBands([0, 800, 800], 1, 1600, 800);
    expect(bands[0]).toEqual({ top: 0, height: 800 });
    expect(bands[1]).toEqual({ top: 800, height: 0 });
    expect(bands[2]).toEqual({ top: 800, height: 800 });
    expect(bands.length).toBe(3);
  });

  it('snaps screen tops to integer device pixels without gaps', () => {
    // Fractional scroll offsets (zoom) round independently, but bands share
    // the same boundary value, so rows can never duplicate or go missing.
    const bands = stitchBands([0.4, 800.6, 1600.2], 2, 2400, 800);
    expect(bands[0]!.top + bands[0]!.height).toBe(bands[1]!.top);
    expect(bands[1]!.top + bands[1]!.height).toBe(bands[2]!.top);
  });

  it('handles empty and single-screen inputs', () => {
    expect(stitchBands([], 1, 1000, 800)).toEqual([]);
    expect(stitchBands([0], 1, 500, 800)).toEqual([{ top: 0, height: 500 }]);
  });
});
