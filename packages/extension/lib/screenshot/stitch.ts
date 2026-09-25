import { fileHost, timestamp } from "./capture";
import {
  FULLPAGE_BEGIN,
  FULLPAGE_END,
  FULLPAGE_SCROLL,
  FULLPAGE_STITCH,
  type FullpageMetrics,
} from "./stitch-protocol";

/**
 * Background-side orchestrator for the scroll-and-stitch full-page capture
 * (see stitch-protocol.ts for why it replaces the CDP single render as the
 * primary path). Any failure — no content script, a step timing out, a bad
 * stitch output — resolves null so the caller falls back to the CDP path
 * (lib/screenshot/capture.ts), which stays the engine of last resort.
 */

/** Per-step hard timeout; a stuck step falls back to CDP. */
const STEP_TIMEOUT_MS = 5_000;
/**
 * BEGIN includes the warm pass (scroll the whole document once to trigger
 * lazy loads — up to 100 quick steps) plus the fonts settle, so it gets a
 * much larger budget than the other per-step messages.
 */
const BEGIN_TIMEOUT_MS = 45_000;
/**
 * Stitching legitimately takes a while on huge pages — decode every screen,
 * draw, then encode a potentially 50MB PNG (plus the JPEG fallback on top).
 * This step gets its own, much larger budget before we give up and fall
 * back to CDP.
 */
const STITCH_TIMEOUT_MS = 30_000;
/** Bound runaway pages (infinite scroll); ~100 viewports is already huge. */
const MAX_SCREENS = 100;
/**
 * Chrome throttles captureVisibleTab to 2 calls/second per tab
 * (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND) — pace the per-screen captures
 * just under it, or the whole stitch dies on the third screen.
 */
const CAPTURE_INTERVAL_MS = 550;
const QUOTA_BACKOFF_MS = 1_000;
const QUOTA_RE = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/;

type Capture = { dataUrl: string; filename: string };

function withTimeout<T>(p: Promise<T>, label: string, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`fullpage: ${label} timed out`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function captureFullPageStitched(
  tab: chrome.tabs.Tab,
): Promise<Capture | null> {
  if (!tab.id) return null;
  const tabId = tab.id;
  const send = <T>(
    type: string,
    data: Record<string, unknown> = {},
    ms: number = STEP_TIMEOUT_MS,
  ): Promise<T> =>
    withTimeout(
      chrome.tabs.sendMessage(tabId, { type, ...data }) as Promise<T>,
      type,
      ms,
    );

  try {
    console.info("[screenshot] fullpage: scroll-stitch capture starting");
    const { metrics } = await send<{ metrics: FullpageMetrics }>(
      FULLPAGE_BEGIN,
      {},
      BEGIN_TIMEOUT_MS,
    );
    const vh = metrics.vh;
    if (!(vh > 0)) throw new Error(`fullpage: bad viewport height ${vh}`);
    // The stitcher sizes the canvas from the docH the capture loop actually
    // saw (pages can grow mid-capture) — the live scrollHeight after END is
    // not trustworthy, so thread the last reported one through to STITCH.
    let lastDocH = metrics.docH;

    // Paced per-screen capture: wait out the rate limit before each call, and
    // back off + retry once if the quota still trips (the allowance is shared
    // across everything capturing this window, other extensions included).
    let lastCaptureAt = 0;
    const captureScreen = async (): Promise<string> => {
      const waitMs = lastCaptureAt + CAPTURE_INTERVAL_MS - Date.now();
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      const attempt = () =>
        withTimeout(
          chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }),
          "captureVisibleTab",
          STEP_TIMEOUT_MS,
        );
      lastCaptureAt = Date.now();
      try {
        return await attempt();
      } catch (err) {
        if (!QUOTA_RE.test(String(err))) throw err;
        await new Promise((r) => setTimeout(r, QUOTA_BACKOFF_MS));
        lastCaptureAt = Date.now();
        return attempt();
      }
    };

    const parts: string[] = [];
    const offsets: number[] = [];
    let target = 0;
    let prev = -1;
    for (let i = 0; i < MAX_SCREENS; i++) {
      // The page scrolls instantly (its own injected style) and answers with
      // where it actually landed (max scroll / scroll hijacks) plus a fresh
      // scrollHeight — infinite-scroll pages can grow mid-capture.
      const { y: actual, docH } = await send<{ y: number; docH: number }>(
        FULLPAGE_SCROLL,
        { y: target },
      );
      parts.push(await captureScreen());
      offsets.push(actual);
      lastDocH = Math.max(lastDocH, docH);
      // Bottom reached — or the page refused to advance (scroll hijack /
      // already at max scroll): either way there is nothing new to capture.
      if (actual + vh >= docH || actual <= prev) break;
      prev = actual;
      target = actual + vh;
    }

    // Release the page right away — stitching composes the already-captured
    // frames, the live page is irrelevant now. The finally below is just the
    // error-path safety net (a second END is a no-op on the page side).
    await send(FULLPAGE_END, {}, STEP_TIMEOUT_MS).catch(() => {});

    const { dataUrl, type } = await send<{ dataUrl: string; type: "png" | "jpg" }>(
      FULLPAGE_STITCH,
      { parts, offsets, metrics, docH: lastDocH },
      STITCH_TIMEOUT_MS,
    );
    if (!dataUrl.startsWith("data:image/")) {
      throw new Error("fullpage: bad stitch output");
    }
    console.info(
      `[screenshot] fullpage: stitched ${parts.length} screens as ${type}`,
    );
    // The stitcher falls back to JPEG when the page is huge and PNG would
    // blow the preview handoff cap — the filename follows the real format.
    return {
      dataUrl,
      filename: `screenshot-${fileHost(tab.url ?? "")}-${timestamp()}.${type}`,
    };
  } catch (err) {
    console.warn("[screenshot] stitch capture failed, falling back to CDP", err);
    return null;
  } finally {
    // Always release the page: unhide fixed/sticky, restore scroll — even on
    // the failure paths (harmless no-op when BEGIN never went through).
    chrome.tabs
      .sendMessage(tabId, { type: FULLPAGE_END })
      .catch(() => {});
  }
}
