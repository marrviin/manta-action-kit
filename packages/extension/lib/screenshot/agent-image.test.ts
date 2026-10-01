/**
 * Tests for agent-image.ts — the agent-facing copy of a captured screenshot.
 * Pure geometry/parsing run anywhere; the canvas re-encode path is guarded to
 * environments that actually have OffscreenCanvas + createImageBitmap (the
 * service worker does; plain node does not).
 */
import { describe, expect, it } from 'vitest';
import {
  fitScale,
  parseDataUrl,
  prepareAgentImage,
} from './agent-image';

describe('fitScale', () => {
  it('keeps images at or below the cap untouched', () => {
    expect(fitScale(800, 600, 1568)).toEqual({ w: 800, h: 600 });
    expect(fitScale(1568, 1568, 1568)).toEqual({ w: 1568, h: 1568 });
  });

  it('scales by the LONGEST side, preserving the ratio', () => {
    expect(fitScale(3136, 1600, 1568)).toEqual({ w: 1568, h: 800 });
    expect(fitScale(1600, 3136, 1568)).toEqual({ w: 800, h: 1568 });
  });

  it('never rounds down to zero', () => {
    const { w, h } = fitScale(20000, 3, 1568);
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
  });

  it('is a no-op for degenerate sizes', () => {
    expect(fitScale(0, 0, 1568)).toEqual({ w: 0, h: 0 });
  });
});

describe('parseDataUrl', () => {
  it('splits mime type and base64 body', () => {
    const { mimeType, base64 } = parseDataUrl('data:image/png;base64,QUJD');
    expect(mimeType).toBe('image/png');
    expect(base64).toBe('QUJD');
  });

  it('accepts jpeg data URLs', () => {
    const { mimeType } = parseDataUrl('data:image/jpeg;base64,QQ==');
    expect(mimeType).toBe('image/jpeg');
  });

  it('falls back to png/empty for malformed input', () => {
    expect(parseDataUrl('not a data url')).toEqual({
      mimeType: 'image/png',
      base64: '',
    });
  });
});

describe('prepareAgentImage (passthrough path — no canvas needed)', () => {
  it('passes small data URLs through unchanged', async () => {
    const dataUrl = 'data:image/png;base64,QUJD';
    const img = await prepareAgentImage(dataUrl);
    expect(img).toEqual({
      imageBase64: 'QUJD',
      mimeType: 'image/png',
      downscaled: false,
    });
  });

  it('degrades to the raw base64 when the canvas APIs are unavailable', async () => {
    // A data URL over the passthrough threshold forces the downscale path;
    // plain node has no createImageBitmap, so the decode fails and the raw
    // base64 must come back (a capture must never be lost to a compression
    // failure).
    const big = 'A'.repeat(1_600_000);
    const img = await prepareAgentImage(`data:image/png;base64,${big}`);
    expect(img.imageBase64).toBe(big);
    expect(img.downscaled).toBe(false);
  });
});
