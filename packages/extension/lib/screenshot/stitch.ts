import { fileHost, timestamp } from "./capture";
import { readCaptureFx } from "@/lib/storage";
import {
  FULLPAGE_BEGIN,
  FULLPAGE_END,
  FULLPAGE_FX,
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
      // Pinned to the TOP frame: the stitch protocol drives the PAGE's scroll
      // position and viewport metrics. The content script is all-frames (for
      // API recording / element capture), and an all-frames broadcast would
      // run the protocol in every iframe too — duplicate fx overlays, each
      // frame scrolling itself, and subframes racing the top frame's replies.
      chrome.tabs.sendMessage(tabId, { type, ...data }, { frameId: 0 }) as Promise<T>,
      type,
      ms,
    );

  try {
    console.info("[screenshot] fullpage: scroll-stitch capture starting");
    // Camera fx obeys the same kill switch as the single-shot iris fx; when
    // off, the fx messages are skipped entirely (no overlay, no round trips).
    const fxEnabled = await readCaptureFx();
    // Focus intro up first, so it is already on while BEGIN's warm pass
    // sweeps the page. Fire-and-forget: fx failures never block capture.
    if (fxEnabled) {
      chrome.tabs
        .sendMessage(
          tabId,
          { type: FULLPAGE_FX, visible: true },
          { frameId: 0 },
        )
        .catch(() => {});
    }
    const { metrics } = await send<{ metrics: FullpageMetrics }>(
      FULLPAGE_BEGIN,
      {},
      BEGIN_TIMEOUT_MS,
    );
    const vh = metrics.vh;
    if (!(vh > 0)) throw new Error(`fullpage: bad viewport height ${vh}`);
    // Focus intro done — hide the overlay for the ENTIRE sweep. Any overlay
    // pixel visible during a capture lands in the shot; the clean middle
    // (page just scrolling) is the point of the intro/clean/outro split.
    if (fxEnabled) {
      await send(FULLPAGE_FX, { visible: false }).catch(() => {});
    }
    // The stitcher sizes the canvas from the docH the capture loop actually
    // saw (pages can grow mid-capture) — the live scrollHeight after END is
    // not trustworthy, so thread the last reported one through to STITCH.
    let lastDocH = metrics.docH;

    // Paced per-screen capture: Chrome allows 2 captureVisibleTab calls per
    // second per tab, so each screen waits out the rate limit — and that
    // wait MUST happen while the overlay is still visible (it's the viewer-
    // facing "recording" time). Only the capture itself hides the overlay,
    // keeping the blink short (~100ms) against a mostly-visible overlay.
    let lastCaptureAt = 0;
    const pace = async (): Promise<void> => {
      const waitMs = lastCaptureAt + CAPTURE_INTERVAL_MS - Date.now();
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    };
    const captureScreen = async (): Promise<string> => {
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
      // The overlay stays hidden for the whole sweep (hidden once above) —
      // the rate-limit pacing here is pure wait, no fx choreography.
      await pace();
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
    // Always release the page: unhide fixed/sticky, tear down the camera fx
    // overlay, restore scroll — even on the failure paths (harmless no-op
    // when BEGIN never went through). Awaited briefly so the overlay is
    // really gone before a CDP fallback captures the page.
    await withTimeout(
      chrome.tabs
        .sendMessage(tabId, { type: FULLPAGE_END }, { frameId: 0 })
        .catch(() => {}),
      "fullpage-end",
      1_000,
    ).catch(() => {});
  }
}
