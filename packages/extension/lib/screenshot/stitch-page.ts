import { effectiveScale, stitchBands, stitchScale } from "./stitch-math";
import {
  hideFocusOverlayForCapture,
  playShutterOutro,
  removeFocusOverlay,
  startFocusIntro,
} from "./focus-fx";
import {
  FP_OVERLAY_ATTR,
  FULLPAGE_BEGIN,
  FULLPAGE_END,
  FULLPAGE_FX,
  FULLPAGE_SCROLL,
  FULLPAGE_STITCH,
  type FullpageMetrics,
} from "./stitch-protocol";
import { SCREENSHOT_PREVIEW_MAX_BYTES } from "./types";

/**
 * Content-script side of the scroll-and-stitch full-page capture (see
 * stitch-protocol.ts): prepares the page (neutralize everything that makes
 * screens inconsistent — fixed/sticky decorations, smooth scrolling, scroll
 * snapping, transitions, entrance animations, mid-capture font swaps),
 * scrolls on demand, waits out lazy-loaded images, then stitches the captured
 * screens into one canvas. Self-heals: a safety timer undoes every mutation
 * even if the background dies mid-capture (same orphan logic as the GIF
 * session's alarm) — a page must never keep a capture's mutated state.
 */

const HIDE_CLASS = "manta-fp-hide"; // position:fixed — out of flow, safe to drop
const STATIC_CLASS = "manta-fp-static"; // position:sticky — in flow, un-stick without reflow
const ATTR = "data-manta-fullpage";
/**
 * While we drive the page: instant scroll, no snap, and NO transitions or
 * animations. Scroll-triggered reveal animations are the #1 cause of crooked
 * seams — every screen would catch the content at a different transform
 * state. (Frameworks that set base styles via JS keep them; only keyframe/
 * transition effects are neutralized.) Scrollbars are hidden too: a classic
 * (non-overlay) scrollbar renders into captureVisibleTab, and hiding it once
 * at BEGIN keeps the content width identical across every screen.
 */
const STYLE = `
  html[${ATTR}], html[${ATTR}] *:not([${FP_OVERLAY_ATTR}], [${FP_OVERLAY_ATTR}] *) {
    scroll-behavior: auto !important;
    scroll-snap-type: none !important;
    transition: none !important;
    animation: none !important;
  }
  html[${ATTR}] { scrollbar-width: none !important; }
  html[${ATTR}]::-webkit-scrollbar { display: none !important; }
  .${HIDE_CLASS} { display: none !important; }
  .${STATIC_CLASS} { position: static !important; }
`;
/** Bounded waits; slow pages can't stall the capture. */
const IMAGE_SETTLE_MS = 800;
const FONTS_SETTLE_MS = 1_500;
/**
 * Warm pass (trigger lazy loads before the real capture): quick per-step
 * settle — the capture loop's fuller wait catches anything still in flight.
 */
const WARM_SETTLE_MS = 250;
/** Bound runaway pages during the warm pass, same cap as the capture loop. */
const MAX_WARM_STEPS = 100;
/** Orphan safety: undo page mutations if the background goes quiet. */
const SAFETY_MS = 30_000;

const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

let undo: (() => void) | null = null;
let safety: ReturnType<typeof setTimeout> | undefined;

/** Minimal structural type for the `chrome.dom` namespace (closed shadow roots). */
interface ChromeDomNs {
  openOrClosedShadowRoot?: (host: Element) => ShadowRoot;
}

function shadowRootOf(host: Element): ShadowRoot | null {
  const dom = (
    globalThis as unknown as { chrome?: { dom?: ChromeDomNs } }
  ).chrome?.dom;
  try {
    return dom?.openOrClosedShadowRoot
      ? dom.openOrClosedShadowRoot(host)
      : (host.shadowRoot ?? null);
  } catch {
    return host.shadowRoot ?? null;
  }
}

/**
 * Hide/unstick rules for shadow trees — the document-level <style> never
 * applies inside a shadow root, so each discovered root adopts this sheet.
 */
function sharedSheet(): CSSStyleSheet | null {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      `.${HIDE_CLASS}{display:none!important}.${STATIC_CLASS}{position:static!important}`,
    );
    return sheet;
  } catch {
    return null;
  }
}

/** Every element under root, piercing open AND closed shadow roots. */
function* deepElements(root: ParentNode): Generator<Element> {
  for (const el of root.querySelectorAll("*")) {
    yield el;
    const sr = shadowRootOf(el);
    if (sr) yield* deepElements(sr);
  }
}

async function begin(): Promise<unknown> {
  // A previous capture never cleaned up — start fresh.
  undo?.();
  const html = document.documentElement;
  const body = document.body;
  const style = document.createElement("style");
  style.textContent = STYLE;

  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const hidden: Element[] = [];
  const unstuck: Element[] = [];
  const adopted: { root: ShadowRoot; prev: CSSStyleSheet[] }[] = [];
  const sheet = sharedSheet();
  // Same scrolling repair as the reference mrcoles extension: a page with
  // `body { overflow-y: scroll|hidden }` can break `window.scrollTo` on the
  // document — force it visible for the capture, restore afterwards.
  const prevBodyOverflowY = body ? body.style.overflowY : "";

  const tagOne = (el: Element) => {
    // The capture overlay is ours and position:fixed by design — hiding it
    // would defeat the recording effect (the background toggles its
    // visibility around each capture instead).
    if (
      el.hasAttribute(FP_OVERLAY_ATTR) ||
      el.closest(`[${FP_OVERLAY_ATTR}]`)
    ) {
      return;
    }
    // Already neutralized — and re-adding our classes is a no-op anyway, but
    // skipping the getComputedStyle here keeps the (attribute-noisy) observer
    // cheap on busy pages.
    if (
      el.classList.contains(HIDE_CLASS) ||
      el.classList.contains(STATIC_CLASS)
    ) {
      return;
    }
    const pos = getComputedStyle(el).position;
    if (pos === "fixed") {
      el.classList.add(HIDE_CLASS);
      hidden.push(el);
    } else if (pos === "sticky") {
      el.classList.add(STATIC_CLASS);
      unstuck.push(el);
    }
    const sr = shadowRootOf(el);
    if (sr && sheet && !adopted.some((a) => a.root === sr)) {
      adopted.push({ root: sr, prev: sr.adoptedStyleSheets });
      sr.adoptedStyleSheets = [...sr.adoptedStyleSheets, sheet];
    }
  };

  html.setAttribute(ATTR, "");
  (document.head ?? html).appendChild(style);
  if (body) body.style.overflowY = "visible";
  for (const el of deepElements(document.body ?? html)) tagOne(el);

  // Frameworks rebuild nodes while we scroll (virtualized lists, re-renders)
  // — a freshly mounted header would escape the BEGIN scan and repeat on
  // every screen. Tag anything inserted from now on, shadow roots included.
  // ALSO watch class/style attribute changes: the most common sticky-header
  // pattern is JS swapping `position: fixed`/a `.sticky` class onto an
  // existing element once the page scrolls past the hero — with childList
  // alone that header escapes BEGIN's scan and stamps itself onto every
  // screen (childList-only observation is exactly the repeated-header bug).
  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "attributes") {
        tagOne(m.target as Element);
        continue;
      }
      for (const node of m.addedNodes) {
        if (!(node instanceof Element)) continue;
        tagOne(node);
        for (const el of node.querySelectorAll("*")) tagOne(el);
      }
    }
  });
  observer.observe(html, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style"],
  });

  undo = () => {
    undo = null;
    observer.disconnect();
    clearTimeout(safety);
    removeFocusOverlay();
    style.remove();
    html.removeAttribute(ATTR);
    if (body) body.style.overflowY = prevBodyOverflowY;
    for (const el of hidden) el.classList.remove(HIDE_CLASS);
    for (const el of unstuck) el.classList.remove(STATIC_CLASS);
    for (const { root, prev } of adopted) {
      try {
        root.adoptedStyleSheets = prev;
      } catch {
        /* root detached since — nothing to restore */
      }
    }
    window.scrollTo(scrollX, scrollY);
  };
  safety = setTimeout(() => undo?.(), SAFETY_MS);

  // A font swap mid-capture relayouts the whole document — every screen must
  // share the same typographic grid. Bounded; the step timeout is the backstop.
  await Promise.race([
    document.fonts?.ready ?? Promise.resolve(),
    new Promise((r) => setTimeout(r, FONTS_SETTLE_MS)),
  ]);

  window.scrollTo(0, 0);
  // Warm pass: scroll the whole document once before any capture. Lazy-loaded
  // images and late-hydrating sections load NOW instead of mid-capture, so
  // the layout is stable (same docH throughout) when the real loop runs —
  // the standard pre-scroll pass of mature scroll-stitch tools. Fast settle:
  // requests are already in flight; the capture loop's fuller image wait
  // catches stragglers.
  const vh = window.innerHeight;
  if (vh > 0) {
    for (let i = 0; i < MAX_WARM_STEPS; i++) {
      const maxScroll = Math.max(
        0,
        document.documentElement.scrollHeight - vh,
      );
      if (window.scrollY >= maxScroll) break;
      window.scrollTo(0, Math.min(window.scrollY + vh, maxScroll));
      await Promise.race([
        waitForImages(),
        new Promise((r) => setTimeout(r, WARM_SETTLE_MS)),
      ]);
    }
  }
  window.scrollTo(0, 0);
  return {
    metrics: {
      vw: window.innerWidth,
      vh: window.innerHeight,
      dpr: window.devicePixelRatio,
      docH: document.documentElement.scrollHeight,
    },
  };
}

function inView(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight;
}

/** Resolves once every in-view, still-loading image settles (load or error). */
function waitForImages(): Promise<unknown> {
  return Promise.all(
    [...document.images]
      .filter((img) => !img.complete && inView(img))
      .map(
        (img) =>
          new Promise<void>((r) => {
            img.addEventListener("load", () => r(), { once: true });
            img.addEventListener("error", () => r(), { once: true });
          }),
      ),
  );
}

async function scrollStep(y: number): Promise<unknown> {
  // The safety timer measures background silence, not total capture time —
  // a long page legitimately takes minutes, so every step renews it. Without
  // this, captures past ~30s were undone mid-flight (styles restored, page
  // scrolled away) and the stitch silently produced garbage.
  clearTimeout(safety);
  safety = setTimeout(() => undo?.(), SAFETY_MS);
  window.scrollTo(0, y);
  await raf();
  await raf();
  // Let lazy-loaded images in view finish loading, bounded by the race.
  await Promise.race([
    waitForImages(),
    new Promise<void>((r) => setTimeout(r, IMAGE_SETTLE_MS)),
  ]);
  await raf();
  return { y: window.scrollY, docH: document.documentElement.scrollHeight };
}

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("fullpage: screen decode failed"));
    img.src = src;
  });
}

async function stitch(
  parts: string[],
  offsets: number[],
  metrics: Partial<FullpageMetrics> | undefined,
  docH: number,
): Promise<unknown> {
  const images = await Promise.all(parts.map((src) => load(src)));
  if (!images.length) throw new Error("fullpage: nothing to stitch");
  // Zoom-proof geometry: measure device-px-per-CSS-px from what was actually
  // captured rather than trusting devicePixelRatio at stitch time (the page
  // has already been released via END — styles restored, sizes can differ).
  const vw = metrics?.vw && metrics.vw > 0 ? metrics.vw : window.innerWidth;
  const vh = metrics?.vh && metrics.vh > 0 ? metrics.vh : window.innerHeight;
  const cssH = Math.max(docH, vh, 1);
  const s = effectiveScale(images[0]!.naturalWidth, vw);
  const k = stitchScale(vw, cssH, s);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(vw * s * k));
  canvas.height = Math.max(1, Math.round(cssH * s * k));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("fullpage: no 2d context");
  // Opaque white base: the canvas starts transparent, and the JPEG fallback
  // below would otherwise encode that transparency as black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Exclusive bands: screen i draws only the rows between its own top and
  // the next screen's top (integer device px, from the page-reported scroll
  // offsets) — every row comes from exactly one capture, so rounding can no
  // longer open seams or ghost-duplicate content at screen boundaries.
  const bands = stitchBands(offsets, s, cssH, vh);
  bands.forEach((band, i) => {
    const img = images[i];
    if (!img || band.height <= 0) return;
    const srcH = Math.min(band.height, img.naturalHeight);
    if (srcH <= 0) return;
    ctx.drawImage(
      img,
      0,
      0,
      img.naturalWidth,
      srcH,
      0,
      Math.round(band.top * k),
      canvas.width,
      Math.max(1, Math.round(srcH * k)),
    );
  });
  // PNG first (lossless, matches the visible/fullPage CDP path); on huge
  // pages photographic content blows past the session-storage handoff cap
  // (a tall DPR-2 page can reach ~50MB), so fall back to JPEG — a 10-20x
  // saving at a quality level indistinguishable for page content.
  const png = canvas.toDataURL("image/png");
  if (png.length <= SCREENSHOT_PREVIEW_MAX_BYTES) {
    return { dataUrl: png, type: "png" as const };
  }
  const jpeg = canvas.toDataURL("image/jpeg", 0.9);
  return { dataUrl: jpeg, type: "jpg" as const };
}

/** Entry from the content-script message listener; null = not ours. */
export function handleFullpageMessage(msg: unknown): Promise<unknown> | null {
  if (!msg || typeof msg !== "object") return null;
  const { type, y, parts, offsets, metrics, docH, visible } = msg as {
    type?: unknown;
    y?: unknown;
    parts?: unknown;
    offsets?: unknown;
    metrics?: Partial<FullpageMetrics>;
    docH?: unknown;
    visible?: unknown;
  };
  switch (type) {
    case FULLPAGE_BEGIN:
      return begin();
    case FULLPAGE_SCROLL:
      return scrollStep(typeof y === "number" ? y : 0);
    case FULLPAGE_FX:
      // Hide resolves only after the intro's minimum on-screen time AND the
      // hidden state reached the compositor — the background captures the
      // whole sweep while hidden. Show is the camera-focus intro (same fx as
      // the single-shot capture); it plays over the warm pass and is instant.
      return visible === false
        ? hideFocusOverlayForCapture()
        : Promise.resolve(startFocusIntro());
    case FULLPAGE_STITCH:
      return stitch(
        Array.isArray(parts) ? (parts as string[]) : [],
        Array.isArray(offsets) ? (offsets as number[]) : [],
        metrics,
        typeof docH === "number" ? docH : document.documentElement.scrollHeight,
      );
    case FULLPAGE_END:
      // Shutter outro first (bounds ~500ms), THEN release the page. Acks land
      // after the overlay is really gone so a CDP fallback capture can never
      // race the iris onto the page.
      return playShutterOutro().then(() => {
        undo?.();
        return { ok: true };
      });
    default:
      return null;
  }
}
