/**
 * The agent-facing image fields of capture_screenshot's result (subset of the
 * wire shape in packages/protocol — the caller adds the metadata fields).
 */
export interface AgentImage {
  imageBase64: string;
  mimeType: 'image/png' | 'image/jpeg';
  downscaled: boolean;
}

/**
 * Prepare a captured screenshot's data URL for the agent RPC response.
 *
 * The full-resolution original stays in screenshotHistory for the user to
 * preview; the agent gets a token-bounded copy: small shots pass through
 * as-is, larger ones are downscaled to the vision sweet spot (longest side
 * ≤ 1568 px) and re-encoded as JPEG q0.8 via OffscreenCanvas in the service
 * worker (createImageBitmap + OffscreenCanvas + FileReaderSync are all
 * worker-available). A pathological shot that is still huge after the first
 * pass gets one harder retry (q0.6 / 1024 px); whichever is smaller wins.
 * Decode failure degrades to the raw base64 rather than failing a successful
 * capture.
 */

/** Pass-through threshold on the dataUrl string length (≈1.1 MB decoded). */
const PASSTHROUGH_MAX_CHARS = 1_500_000;
/** Longest side (px) of the agent copy. */
const AGENT_MAX_SIDE = 1568;
/** First-pass JPEG quality. */
const AGENT_JPEG_QUALITY = 0.8;
/** Base64 length ceiling (~3 MB decoded) that triggers the harder retry. */
const AGENT_BASE64_CEILING = 4_000_000;
const RETRY_MAX_SIDE = 1024;
const RETRY_JPEG_QUALITY = 0.6;

/** Split a data URL into mime type + raw base64 (exported for tests). */
export function parseDataUrl(dataUrl: string): {
  mimeType: string;
  base64: string;
} {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  // Group 1/2 always exist when the regex matches (both are greedy/required).
  if (!match?.[1] || !match[2]) return { mimeType: 'image/png', base64: '' };
  return { mimeType: match[1], base64: match[2] };
}

/** Decode a data URL into a bitmap (worker-safe). */
async function decode(dataUrl: string): Promise<ImageBitmap> {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

/** Scale `size` so the longest side is `maxSide`, preserving the ratio (≥1). */
export function fitScale(w: number, h: number, maxSide: number): {
  w: number;
  h: number;
} {
  const longest = Math.max(w, h);
  if (longest <= maxSide || longest === 0) return { w, h };
  const k = maxSide / longest;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

async function blobToBase64(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    // FileReader (async) is worker-available; FileReaderSync is NOT in the DOM
    // lib this project compiles against, so it can't be typed here.
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

async function reencodeJpeg(
  bitmap: ImageBitmap,
  maxSide: number,
  quality: number,
): Promise<string> {
  const { w, h } = fitScale(bitmap.width, bitmap.height, maxSide);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return parseDataUrl(await blobToBase64(blob)).base64;
}

export async function prepareAgentImage(dataUrl: string): Promise<AgentImage> {
  const { mimeType, base64 } = parseDataUrl(dataUrl);
  const wireType: AgentImage['mimeType'] =
    mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  // Small already: pass through untouched (keeps PNG crispness + alpha).
  if (dataUrl.length <= PASSTHROUGH_MAX_CHARS) {
    return { imageBase64: base64, mimeType: wireType, downscaled: false };
  }
  try {
    const bitmap = await decode(dataUrl);
    const first = await reencodeJpeg(bitmap, AGENT_MAX_SIDE, AGENT_JPEG_QUALITY);
    if (first.length <= AGENT_BASE64_CEILING) {
      return { imageBase64: first, mimeType: 'image/jpeg', downscaled: true };
    }
    const second = await reencodeJpeg(bitmap, RETRY_MAX_SIDE, RETRY_JPEG_QUALITY);
    const best = second.length < first.length ? second : first;
    return { imageBase64: best, mimeType: 'image/jpeg', downscaled: true };
  } catch {
    // Decode/re-encode failed: return the raw base64 (bounded upstream by the
    // capture path) instead of failing a successful capture.
    return { imageBase64: base64, mimeType: wireType, downscaled: false };
  }
}
