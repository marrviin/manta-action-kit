/**
 * WebM → GIF transcode. Runs in a VISIBLE extension page (the preview tab),
 * not the offscreen document (hidden documents never composite video frames,
 * which starved frame callbacks and hung the first iteration of this pipeline).
 *
 * Sampling is SEEK-based: currentTime is stepped through the resolved duration
 * and each `seeked` event guarantees a fully decoded frame before drawImage —
 * deterministic, no playback/compositing races (playback-based sampling produced
 * intermittent torn/corrupt GIF frames).
 *
 * Quality: ONE GLOBAL palette, computed from a mosaic of frames spread densely
 * across the clip (ffmpeg palettegen/paletteuse style), plus 8×8 Bayer ordered
 * dithering at palette-grid amplitude. Bayer was chosen over Floyd–Steinberg:
 * its regular fine pattern dissolves the banding steps that survive the global
 * palette without the worm-like speckle FS produced on UI captures, and colors
 * already on a palette entry stay perfectly flat (the ±half-step offset still
 * maps back to the same nearest entry).
 */
import { applyPalette, GIFEncoder, prequantize, quantize } from 'gifenc';

/** GIF frame sampling rate. 10 fps is the sweet spot for file size vs motion. */
const SAMPLE_INTERVAL_S = 0.1;
/** GIF width cap — clarity vs file size; GIF size grows ~quadratically. */
const MAX_WIDTH = 1280;
/**
 * Global-palette mosaic: cells are packed into an 8×8 canvas, sampled at ~one
 * frame per 0.5s of clip (capped at 64) so even briefly-visible colors land in
 * the palette. Unused cells duplicate earlier samples — harmless for stats.
 */
const MOSAIC_GRID = 8;
const MOSAIC_CELL = 192;
const MOSAIC_SAMPLE_STRIDE_S = 0.5;
/** Palette grid from prequantize — Bayer amplitude is matched to it. */
const PALETTE_ROUND_RGB = 8;

/** 8×8 Bayer threshold matrix (0–63). */
const BAYER_8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

/**
 * Ordered (Bayer) dithering, in place: shifts each pixel by ±half a palette
 * grid step in a fixed 8×8 pattern, so a gradient crossing palette entries
 * renders as a uniform fine texture instead of hard banding bars. Flat colors
 * already on a palette entry are unaffected (the offset never crosses over).
 */
function applyBayerDither(data: Uint8ClampedArray, width: number, height: number): void {
  for (let y = 0; y < height; y++) {
    const row = BAYER_8[y & 7]!;
    for (let x = 0; x < width; x++) {
      const offset = ((row[x & 7]! + 0.5) / 64 - 0.5) * PALETTE_ROUND_RGB;
      const i = (y * width + x) * 4;
      data[i] = data[i]! + offset;
      data[i + 1] = data[i + 1]! + offset;
      data[i + 2] = data[i + 2]! + offset;
    }
  }
}

/** Encode a recorded WebM blob into a GIF blob. `onProgress` reports 0–100. */
export async function encodeGif(
  webm: Blob,
  onProgress?: (percent: number) => void,
): Promise<Blob> {
  const url = URL.createObjectURL(webm);
  const video = document.createElement('video');
  video.muted = true;
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('failed to decode recorded WebM'));
    });

    // MediaRecorder blobs report duration: Infinity — force Chrome to resolve
    // the real duration by seeking far past the end, then rewind to 0.
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      await new Promise<void>((resolve) => {
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          resolve();
        };
        video.addEventListener('seeked', onSeeked);
        video.currentTime = 1e101;
      });
      video.currentTime = 0;
    }
    const total = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (!total) throw new Error('could not resolve recording duration');

    const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
    const w = Math.max(2, Math.round((video.videoWidth * scale) / 2) * 2);
    const h = Math.max(2, Math.round((video.videoHeight * scale) / 2) * 2);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('canvas 2d context unavailable');
    // High-quality resampling — the default 'low' leaves downscaled text mushy.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    /**
     * Sampling by SEEKING, not playing: position `currentTime` at each sample
     * point and wait for `seeked`, which guarantees the frame is fully decoded
     * before drawImage. Playback + requestVideoFrameCallback was tried here
     * first and produced intermittent torn/corrupt frames in the GIF (the
     * composited-frame readback races the encode work blocking the main
     * thread); seek-based sampling is deterministic — slower than realtime,
     * but every frame is exact.
     */
    const seekTo = (time: number) =>
      new Promise<void>((resolve) => {
        video.onseeked = () => {
          video.onseeked = null;
          resolve();
        };
        video.currentTime = time;
      });

    // Pass 1 — global palette: mosaic of frames sampled densely across the
    // whole clip (~1 per 0.5s, capped by the 8×8 canvas), quantized once.
    // Colors then map identically on every frame.
    const grid = MOSAIC_GRID;
    const cell = MOSAIC_CELL;
    const mosaic = document.createElement('canvas');
    mosaic.width = grid * cell;
    mosaic.height = grid * cell;
    const mctx = mosaic.getContext('2d', { willReadFrequently: true });
    if (!mctx) throw new Error('canvas 2d context unavailable');
    const sampleCount = Math.min(
      grid * grid,
      Math.max(9, Math.ceil(total / MOSAIC_SAMPLE_STRIDE_S)),
    );
    for (let s = 0; s < grid * grid; s++) {
      const t = (((s % sampleCount) + 0.5) / sampleCount) * total;
      await seekTo(Math.min(t, total - 0.001));
      mctx.drawImage(
        video,
        (s % grid) * cell,
        Math.floor(s / grid) * cell,
        cell,
        cell,
      );
      // Pass 1 is real work (dozens of seeks) — report it as 0–20% so the
      // button doesn't sit at 0% through the whole palette build.
      onProgress?.(Math.round((s / (grid * grid)) * 20));
    }
    const mosaicData = mctx.getImageData(0, 0, mosaic.width, mosaic.height);
    // Round colors to the palette grid before quantizing: VP8 leaves ±2-3
    // levels of compression noise in near-flat regions (gray menus etc.), and
    // without this those noise shades map to DIFFERENT palette entries —
    // visible colored bars in the GIF. On a coarse grid every noise shade
    // snaps to the same entry and the region renders as solid color.
    prequantize(mosaicData.data, { roundRGB: PALETTE_ROUND_RGB });
    const palette = quantize(mosaicData.data, 256);

    const encoder = GIFEncoder();
    const stepS = SAMPLE_INTERVAL_S;
    const delayMs = Math.round(stepS * 1000);
    let frameCount = 0;
    for (let t = 0; t < total; t += stepS) {
      // Never seek to/past the very end — the final seek may never resolve.
      await seekTo(Math.min(t, total - 0.001));
      ctx.drawImage(video, 0, 0, w, h);
      const frame = ctx.getImageData(0, 0, w, h);
      applyBayerDither(frame.data, w, h);
      const index = applyPalette(frame.data, palette);
      // First frame carries the global color table; later frames omit their
      // palette so gifenc references the shared global one.
      encoder.writeFrame(
        index,
        w,
        h,
        frameCount === 0 ? { palette, delay: delayMs } : { delay: delayMs },
      );
      frameCount++;
      onProgress?.(20 + Math.min(79, Math.round((t / total) * 79)));
    }
    onProgress?.(100);
    if (!frameCount) throw new Error('no frames sampled');

    encoder.finish();
    return new Blob([encoder.bytes() as BlobPart], { type: 'image/gif' });
  } finally {
    URL.revokeObjectURL(url);
  }
}
