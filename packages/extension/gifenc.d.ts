// Ambient types for `gifenc` (no official .d.ts shipped). Only the surface the
// GIF recorder uses: GIFEncoder / quantize / applyPalette.
declare module 'gifenc' {
  export interface GIFEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: {
        palette?: number[][]; // [[r,g,b], ...]
        delay?: number; // ms this frame is shown
        transparent?: boolean;
        repeat?: number; // 0 = loop forever
        first?: boolean;
      },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    reset(): void;
  }

  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): GIFEncoderInstance;

  /** Quantize RGBA pixels (length = w*h*4) into a palette of at most `maxColors`. */
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: { format?: 'rgb565' | 'rgb444' | 'rgba4444'; oneBitAlpha?: boolean; clearAlpha?: boolean },
  ): number[][];

  /**
   * Coarsen RGBA pixels in place (rounding channels to `roundRGB` steps) so
   * near-identical shades — e.g. compression noise on flat colors — collapse
   * before quantization. Mutates the underlying buffer.
   */
  export function prequantize(
    rgba: Uint8Array | Uint8ClampedArray,
    opts?: { roundRGB?: number; roundAlpha?: number; oneBitAlpha?: boolean | number },
  ): void;

  /** Map RGBA pixels onto the nearest palette entry, returning an index bitmap. */
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: 'rgb565' | 'rgb444' | 'rgba4444',
  ): Uint8Array;
}
