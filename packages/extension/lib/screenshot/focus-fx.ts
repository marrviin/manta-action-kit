import { FP_OVERLAY_ATTR } from "./stitch-protocol";

export const PLAY_SCREENSHOT_FX = "PLAY_SCREENSHOT_FX";

/** The shutter iris color — classic black, always. */
export const SHUTTER_COLOR = "#0a0a0a";

/**
 * Screenshot focus fx — a camera viewfinder performance played in the page,
 * in two forms:
 *
 *  - `playScreenshotFocusFx` — the full four-beat performance for single-shot
 *    captures (visible viewport, and the CDP fullpage fallback), played AFTER
 *    the background has already captured, right before the preview tab opens
 *    (see the PLAY_SCREENSHOT_FX message).
 *  - the staged API (`startFocusIntro` / `hideFocusOverlayForCapture` /
 *    `playShutterOutro`) — the same camera split around the scroll-and-stitch
 *    sweep (see stitch.ts): the focus beats play as the recording intro over
 *    the warm pass, the layer hides for the ENTIRE sweep (any overlay pixel
 *    visible during a capture lands in the shot), and the shutter iris fires
 *    as the stop-recording outro.
 *
 * Why capture first (single-shot) / hide first (stitch): captureVisibleTab /
 * CDP render whatever is on screen — racing an overlay against the renderer
 * is how screenshots end up polluted (e.g. stuck on the full-black shutter
 * frame). Keeping the overlay out of every capture makes the fx pure
 * celebration: nothing it does can ever reach the shot.
 *
 * Same guard rails as lib/inspector/capture-fx.ts (see memory
 * content-script-animation-lessons): resolve-only never rejects, inline
 * style.cssText + WAAPI only (CSP-immune), transform/opacity on the compositor
 * path, reduced-motion / hidden tab skip, try/finally teardown by node removal.
 *
 * Choreography (~1.15s), a real camera's three beats:
 *   1. Frame   — four L brackets slide in at the viewport corners (the
 *                viewfinder body) while a center AF box flies in and the page
 *                blurs up (rack focus starts defocused).
 *   2. Pull    — the page pulls from blur to sharp; the AF box "hunts".
 *   3. Lock    — the green AF box pulses + an expanding ring.
 *   4. Shutter — an iris closes from all edges toward the center (a disc
 *                with a huge box-shadow ring in the shutter black scales
 *                down over the frame) and holds solid color for a beat —
 *                the "咔嚓" moment. The layer is then removed in a snap cut
 *                (like a real camera's viewfinder blacking out on fire) and
 *                the preview tab opens.
 */

// Timeline (ms), chained delays — each phase starts where the previous ends.
const FRAME_MS = 220; // corner brackets + AF box in, blur ramps up
const PULL_MS = 380; // blur → sharp, AF hunting
const LOCK_MS = 150; // focus-lock pulse + color shift
const RING_MS = 300; // lock ring expands past the box
/** The iris starts closing just after the lock settles. */
const SHUTTER_DELAY = FRAME_MS + PULL_MS + 140;
const SHUTTER_MS = 280; // iris scale 1 → 0
const HOLD_MS = 130; // full-black hold — the snap
/** Backing black crossfades in over the last stretch of the iris close. */
const BLACK_CROSS_MS = 120;
const TOTAL_MS = SHUTTER_DELAY + SHUTTER_MS + HOLD_MS;

/** Viewfinder corner geometry: inset from the viewport edges, leg length. */
const CORNER_INSET = 26;
const CORNER_LEG = 26;
/** Center AF box size and corner-leg length. */
const BOX = 112;
const LEG = 20;
const LEG_BORDER = 3;
/** Viewfinder body: shutter black, one step bolder than the AF box legs. */
const CORNER_COLOR = "#0a0a0a";
const CORNER_BORDER = 4;
const GREEN = "#34d399"; // AF box — always locked green

/**
 * Minimum on-screen time before the stitch sweep hides the overlay. The warm
 * pass (inside FULLPAGE_BEGIN) can finish in well under the focus beats on a
 * fast page — fonts ready, images cached — and hiding then would blink the
 * intro away mid-pull. Holding the difference here guarantees the intro is
 * actually seen, without slowing long pages down (their warm pass already
 * exceeds this).
 */
const MIN_VISIBLE_MS = 1_150;

/** True when the user asked the OS for reduced motion. */
function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

let playing = false;

/**
 * The overlay pieces both forms share. The iris is built lazily by the
 * shutter stage — in the staged form it only exists at outro time.
 */
interface Overlay {
  root: HTMLElement;
  blur: HTMLElement;
  corners: HTMLElement[];
  box: HTMLElement;
  ring: HTMLElement;
}

const ease = "cubic-bezier(0.22,1,0.36,1)";
const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** Build an L bracket (two borders of a LEG×LEG box) pinned to a corner. */
function leg(parent: HTMLElement, pos: string, borders: string, color: string, size: number) {
  const el = document.createElement("div");
  el.style.cssText = `position:absolute;width:${size}px;height:${size}px;${pos}${borders}color:${color};`;
  parent.appendChild(el);
  return el;
}

function buildOverlay(): Overlay {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const root = document.createElement("div");
  root.setAttribute(FP_OVERLAY_ATTR, "");
  root.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden;";
  document.documentElement.appendChild(root);

  // Rack-focus layer: blurs the PAGE behind this overlay (backdrop-filter),
  // animating blur up on frame-in and back to 0 through the pull.
  const blur = document.createElement("div");
  blur.style.cssText = "position:absolute;inset:0;backdrop-filter:blur(0px);";
  root.appendChild(blur);

  // Viewfinder body: four L brackets inset from the viewport corners. Each
  // leg owns its own slide-in transform (they come from their own corners).
  const CORNERS = [
    { pos: `left:${CORNER_INSET}px;top:${CORNER_INSET}px;`, borders: `border-top:${CORNER_BORDER}px solid;border-left:${CORNER_BORDER}px solid;`, dx: -10, dy: -10 },
    { pos: `right:${CORNER_INSET}px;top:${CORNER_INSET}px;`, borders: `border-top:${CORNER_BORDER}px solid;border-right:${CORNER_BORDER}px solid;`, dx: 10, dy: -10 },
    { pos: `right:${CORNER_INSET}px;bottom:${CORNER_INSET}px;`, borders: `border-bottom:${CORNER_BORDER}px solid;border-right:${CORNER_BORDER}px solid;`, dx: 10, dy: 10 },
    { pos: `left:${CORNER_INSET}px;bottom:${CORNER_INSET}px;`, borders: `border-bottom:${CORNER_BORDER}px solid;border-left:${CORNER_BORDER}px solid;`, dx: -10, dy: 10 },
  ];
  const cornerLegs = CORNERS.map((c) => ({ spec: c, el: leg(root, c.pos, c.borders, CORNER_COLOR, CORNER_LEG) }));

  // Center AF box: its own 4 legs; the box element's scale/pulse animations
  // drive the whole frame (one transform group per layer — lesson from the
  // inspector fx: same-property animations override, never compose).
  const box = document.createElement("div");
  box.style.cssText = `position:absolute;left:${(vw - BOX) / 2}px;top:${
    (vh - BOX) / 2
  }px;width:${BOX}px;height:${BOX}px;opacity:0;`;
  for (const l of [
    { pos: "left:0;top:0;", borders: `border-top:${LEG_BORDER}px solid;border-left:${LEG_BORDER}px solid;` },
    { pos: "right:0;top:0;", borders: `border-top:${LEG_BORDER}px solid;border-right:${LEG_BORDER}px solid;` },
    { pos: "right:0;bottom:0;", borders: `border-bottom:${LEG_BORDER}px solid;border-right:${LEG_BORDER}px solid;` },
    { pos: "left:0;bottom:0;", borders: `border-bottom:${LEG_BORDER}px solid;border-left:${LEG_BORDER}px solid;` },
  ]) {
    leg(box, l.pos, l.borders, GREEN, LEG);
  }
  root.appendChild(box);

  // Expanding ring that marks the focus lock.
  const ring = document.createElement("div");
  ring.style.cssText = `position:absolute;left:${(vw - BOX) / 2}px;top:${
    (vh - BOX) / 2
  }px;width:${BOX}px;height:${BOX}px;border:2px solid ${GREEN};border-radius:10px;opacity:0;`;
  root.appendChild(ring);

  return { root, blur, corners: cornerLegs.map(({ el }) => el), box, ring };
}

/** Stages 1–3: frame in, focus pull, lock. Leaves the viewfinder on screen. */
function runFocusStages(o: Overlay): void {
  const LOCK_DELAY = FRAME_MS + PULL_MS;

  // Stage 1 — frame in: corners slide in from their own edges, the AF box
  // scales 1.4→1, and the rack focus ramps the page up to full blur.
  o.corners.forEach((el, i) => {
    const { dx, dy } = [
      { dx: -10, dy: -10 },
      { dx: 10, dy: -10 },
      { dx: 10, dy: 10 },
      { dx: -10, dy: 10 },
    ][i]!;
    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px)`, opacity: 0 },
        { transform: "translate(0, 0)", opacity: 1 },
      ],
      { duration: FRAME_MS, easing: ease, fill: "forwards" },
    );
  });
  o.box.animate(
    [
      { transform: "scale(1.4)", opacity: 0 },
      { transform: "scale(1)", opacity: 1 },
    ],
    { duration: FRAME_MS, easing: ease, fill: "forwards" },
  );
  o.blur.animate([{ backdropFilter: "blur(0px)" }, { backdropFilter: `blur(${7}px)` }], {
    duration: FRAME_MS,
    easing: "ease-out",
    fill: "forwards",
  });

  // Stage 2 — focus pull: the page comes into sharp focus while the AF box
  // breathes as if hunting. No backwards fill anywhere (lesson: it would pin
  // its first keyframe over the fly-in during the delay).
  o.blur.animate(
    [{ backdropFilter: `blur(${7}px)` }, { backdropFilter: "blur(0px)" }],
    { duration: PULL_MS, delay: FRAME_MS, easing: "ease-in-out", fill: "forwards" },
  );
  o.box.animate(
    [
      { transform: "scale(1)" },
      { transform: "scale(0.96)", offset: 0.45 },
      { transform: "scale(1.01)", offset: 0.75 },
      { transform: "scale(1)" },
    ],
    { duration: PULL_MS, delay: FRAME_MS, easing: "ease-in-out", fill: "forwards" },
  );

  // Stage 3 — focus lock: the (already green) AF box pulses and a ring
  // expands past it. The viewfinder corners stay black — the body doesn't
  // lock, the sensor does.
  o.box.animate(
    [
      { transform: "scale(1)" },
      { transform: "scale(1.05)", offset: 0.4 },
      { transform: "scale(1)" },
    ],
    { duration: LOCK_MS, delay: LOCK_DELAY, easing: "ease-out", fill: "forwards" },
  );
  o.ring.animate(
    [
      { transform: "scale(0.7)", opacity: 0.85 },
      { transform: "scale(1.5)", opacity: 0 },
    ],
    { duration: RING_MS, delay: LOCK_DELAY, easing: "ease-out", fill: "forwards" },
  );
}

/**
 * Stage 4 — shutter: the iris closes from all edges (accelerating, like an
 * aperture snapping) while the backing crossfades to the full shutter color
 * over the last stretch, then holds solid for a beat. The viewfinder frame
 * (corners + AF box + ring) fades away as the iris starts — a real shutter
 * fires over the clean scene, not over its own furniture. `delayMs` spaces
 * the close after whatever precedes it (the lock in the single-shot form,
 * the sweep's END in the staged form).
 */
function runShutterStage(o: Overlay, delayMs: number): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const diag = Math.hypot(vw, vh);
  const irisBlack = document.createElement("div");
  irisBlack.style.cssText = `position:absolute;inset:0;background:${SHUTTER_COLOR};opacity:0;`;
  o.root.appendChild(irisBlack);
  const iris = document.createElement("div");
  iris.style.cssText = `position:absolute;left:${(vw - diag) / 2}px;top:${
    (vh - diag) / 2
  }px;width:${diag}px;height:${diag}px;border-radius:50%;box-shadow:0 0 0 4000px ${SHUTTER_COLOR};`;
  o.root.appendChild(iris);

  // Frame out: a quick fade as the iris begins (WAAPI same-property override
  // retires the intro's fill:forwards opacity — no compose conflicts).
  const FRAME_OUT_MS = 160;
  for (const el of [...o.corners, o.box, o.ring]) {
    el.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: FRAME_OUT_MS,
      delay: delayMs,
      easing: "ease-out",
      fill: "forwards",
    });
  }

  iris.animate([{ transform: "scale(1)" }, { transform: "scale(0.0001)" }], {
    duration: SHUTTER_MS,
    delay: delayMs,
    easing: "ease-in",
    fill: "forwards",
  });
  irisBlack.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: BLACK_CROSS_MS,
    delay: delayMs + SHUTTER_MS - BLACK_CROSS_MS,
    easing: "ease-in",
    fill: "forwards",
  });
}

/** Camera-focus performance in the page. Resolves true when it played. */
export function playScreenshotFocusFx(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // Skip (and let the background capture immediately) whenever a show
    // would be invisible or redundant — there is no state to preserve here,
    // unlike the inspector fx's white freeze.
    if (playing || document.hidden || prefersReducedMotion()) {
      resolve(false);
      return;
    }
    playing = true;
    // Start on a freshly painted, settled frame: a fullPage capture has just
    // dragged the renderer through a surface resize (CDP captureBeyondViewport
    // expands it to content height, then restores it) plus the debugger
    // infobar's attach/detach — measuring vw/vh or painting mid-settle yields
    // misplaced brackets and dropped frames. Double rAF = the next real paint.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        try {
          const o = buildOverlay();
          runFocusStages(o);
          runShutterStage(o, SHUTTER_DELAY);
          setTimeout(() => {
            o.root.remove();
            playing = false;
            resolve(true);
          }, TOTAL_MS);
        } catch (err) {
          console.warn("[screenshot-fx] failed", err);
          playing = false;
          resolve(false);
        }
      }),
    );
  });
}

/* ---------------------------------------------------------------------- */
/* Staged form — the scroll-and-stitch capture's intro/clean/outro.        */
/* ---------------------------------------------------------------------- */

let stage: Overlay | null = null;
let stageShownAt = 0;

/**
 * Recording intro: build the viewfinder and play the focus beats (frame in →
 * pull → lock) while the stitch warm pass sweeps the page. The layer stays
 * attached afterwards — the sweep hides it, the outro brings it back for the
 * shutter. Reduced motion gets a static viewfinder, no animations.
 */
export function startFocusIntro(): void {
  if (stage || document.hidden) return;
  stage = buildOverlay();
  stageShownAt = performance.now();
  if (prefersReducedMotion()) return;
  runFocusStages(stage);
}

/**
 * Hide for the capture sweep and wait until the hidden state has actually
 * reached the compositor (double rAF + a beat) — the background captures
 * every screen while hidden. Called ONCE per capture: the sweep itself stays
 * clean. Holds the intro's minimum on-screen time first so a fast warm pass
 * can't blink it away mid-animation.
 */
export async function hideFocusOverlayForCapture(): Promise<void> {
  if (!stage) return;
  const remaining = MIN_VISIBLE_MS - (performance.now() - stageShownAt);
  if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
  if (!stage) return; // torn down while holding (undo / new capture)
  stage.root.style.visibility = "hidden";
  await raf();
  await raf();
  await new Promise((r) => setTimeout(r, 25));
}

/**
 * Stop-recording outro: bring the viewfinder back and fire the shutter iris.
 * Resolves after the layer is removed — the background's END acks on this,
 * so a CDP fallback capture can never race the shutter onto the page. (Safe
 * to show again: every capture already happened by END.)
 */
export function playShutterOutro(): Promise<void> {
  const o = stage;
  if (!o) return Promise.resolve();
  stage = null;
  o.root.style.visibility = "";
  const OUTRO_DELAY = 80;
  const finish = () => {
    o.root.remove();
  };
  if (prefersReducedMotion()) {
    finish();
    return Promise.resolve();
  }
  runShutterStage(o, OUTRO_DELAY);
  return new Promise((resolve) =>
    setTimeout(() => {
      finish();
      resolve();
    }, OUTRO_DELAY + SHUTTER_MS + HOLD_MS + 30),
  );
}

/** Instant teardown — orphan safety: the stitch session's undo calls this. */
export function removeFocusOverlay(): void {
  stage?.root.remove();
  stage = null;
}
