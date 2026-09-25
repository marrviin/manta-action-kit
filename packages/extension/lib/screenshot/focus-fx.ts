import { settings } from "@/lib/storage";

export const PLAY_SCREENSHOT_FX = "PLAY_SCREENSHOT_FX";

/**
 * Shutter palette — the iris cycles through one color per screenshot
 * (sequential, wrapping). Black leads as the classic shutter; the rest are
 * deep, saturated companions that read as "designed" rather than glaring
 * when they flood the whole viewport for the shutter beat. The background
 * picks the color (nextShutterColor) and passes it in the message, so the
 * sequence persists across pages and SW restarts via storage.session.
 */
export const SHUTTER_COLORS = [
  "#0a0a0a", // shutter black
  "#1d4ed8", // cobalt
  "#7c3aed", // violet
  "#e11d48", // rose
  "#0f766e", // teal
] as const;

/** Advance the round-robin cursor and return this screenshot's color. */
export async function nextShutterColor(): Promise<string> {
  try {
    const idx = await settings.screenshotFxShutterIndex.getValue();
    await settings.screenshotFxShutterIndex.setValue(
      (idx + 1) % SHUTTER_COLORS.length,
    );
    return SHUTTER_COLORS[idx % SHUTTER_COLORS.length] ?? SHUTTER_COLORS[0];
  } catch {
    return SHUTTER_COLORS[0];
  }
}

/**
 * Screenshot focus fx — a camera viewfinder performance played in the page
 * AFTER the background has already captured, right before the preview tab
 * opens (see the PLAY_SCREENSHOT_FX message).
 *
 * Why capture first: captureVisibleTab / CDP Page.captureScreenshot render
 * whatever is on screen — racing an overlay against the renderer is how
 * screenshots end up polluted (e.g. stuck on the full-black shutter frame).
 * Capturing the pristine page first makes the fx pure celebration: nothing
 * the overlay does can ever reach the shot, and the preview opening right
 * after the iris snap reads as the camera recovering from the "咔嚓".
 *
 * Same guard rails as lib/inspector/capture-fx.ts (see memory
 * content-script-animation-lessons): resolve-only never rejects, inline
 * style.cssText + WAAPI only (CSP-immune), transform/opacity on the compositor
 * path, reduced-motion / hidden tab skip, module-level playing guard,
 * try/finally teardown by node removal.
 *
 * Choreography (~1.15s), a real camera's three beats:
 *   1. Frame   — four L brackets slide in at the viewport corners (the
 *                viewfinder body) while a center AF box flies in and the page
 *                blurs up (rack focus starts defocused).
 *   2. Pull    — the page pulls from blur to sharp; the AF box "hunts".
 *   3. Lock    — the box snaps green with a pulse + expanding ring.
 *   4. Shutter — an iris closes from all edges toward the center (a disc
 *                with a huge box-shadow ring in the round-robin shutter
 *                color scales down over the frame) and holds solid color for
 *                a beat — the "咔嚓" moment. The layer is then removed in a
 *                snap cut (like a real camera's viewfinder blacking out on
 *                fire) and the preview tab opens.
 */

/** Message type background -> content script: play the focus fx, then reply. */

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
const SKY = "#7dd3fc"; // framing / hunting
const GREEN = "#34d399"; // locked

let playing = false;

/** True when the user asked the OS for reduced motion. */
function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Camera-focus performance in the page. Resolves true when it played. */
export function playScreenshotFocusFx(
  opts?: { shutterColor?: string },
): Promise<boolean> {
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
          runFx(resolve, opts?.shutterColor ?? SHUTTER_COLORS[0]);
        } catch (err) {
          console.warn("[screenshot-fx] failed", err);
          resolve(false);
        }
      }),
    );
  });
}

/** Build an L bracket (two borders of a LEG×LEG box) pinned to a corner. */
function leg(parent: HTMLElement, pos: string, borders: string, color: string, size: number) {
  const el = document.createElement("div");
  el.style.cssText = `position:absolute;width:${size}px;height:${size}px;${pos}${borders}color:${color};`;
  parent.appendChild(el);
  return el;
}

function runFx(resolve: (played: boolean) => void, shutterColor: string) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const root = document.createElement("div");
  root.dataset.mantaScreenshotFx = "";
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
    { pos: `left:${CORNER_INSET}px;top:${CORNER_INSET}px;`, borders: "border-top:2px solid;border-left:2px solid;", dx: -10, dy: -10 },
    { pos: `right:${CORNER_INSET}px;top:${CORNER_INSET}px;`, borders: "border-top:2px solid;border-right:2px solid;", dx: 10, dy: -10 },
    { pos: `right:${CORNER_INSET}px;bottom:${CORNER_INSET}px;`, borders: "border-bottom:2px solid;border-right:2px solid;", dx: 10, dy: 10 },
    { pos: `left:${CORNER_INSET}px;bottom:${CORNER_INSET}px;`, borders: "border-bottom:2px solid;border-left:2px solid;", dx: -10, dy: 10 },
  ];
  const cornerLegs = CORNERS.map((c) => ({ spec: c, el: leg(root, c.pos, c.borders, SKY, CORNER_LEG) }));

  // Center AF box: its own 4 legs; the box element's scale/pulse animations
  // drive the whole frame (one transform group per layer — lesson from the
  // inspector fx: same-property animations override, never compose).
  const box = document.createElement("div");
  box.style.cssText = `position:absolute;left:${(vw - BOX) / 2}px;top:${
    (vh - BOX) / 2
  }px;width:${BOX}px;height:${BOX}px;opacity:0;`;
  for (const l of [
    { pos: "left:0;top:0;", borders: "border-top:2px solid;border-left:2px solid;" },
    { pos: "right:0;top:0;", borders: "border-top:2px solid;border-right:2px solid;" },
    { pos: "right:0;bottom:0;", borders: "border-bottom:2px solid;border-right:2px solid;" },
    { pos: "left:0;bottom:0;", borders: "border-bottom:2px solid;border-left:2px solid;" },
  ]) {
    leg(box, l.pos, l.borders, SKY, LEG);
  }
  root.appendChild(box);

  // Expanding ring that marks the focus lock.
  const ring = document.createElement("div");
  ring.style.cssText = `position:absolute;left:${(vw - BOX) / 2}px;top:${
    (vh - BOX) / 2
  }px;width:${BOX}px;height:${BOX}px;border:2px solid ${GREEN};border-radius:10px;opacity:0;`;
  root.appendChild(ring);

  // Shutter iris: a centered transparent disc (the shrinking "hole") with a
  // huge box-shadow ring in the round-robin shutter color that floods
  // everything around it. Scaling the disc scales the whole rendered ring
  // with it; the backing layer below crossfades to solid color over the last
  // stretch so the geometry never thins out visibly near scale 0.
  const diag = Math.hypot(vw, vh);
  const irisBlack = document.createElement("div");
  irisBlack.style.cssText = `position:absolute;inset:0;background:${shutterColor};opacity:0;`;
  root.appendChild(irisBlack);
  const iris = document.createElement("div");
  iris.style.cssText = `position:absolute;left:${(vw - diag) / 2}px;top:${
    (vh - diag) / 2
  }px;width:${diag}px;height:${diag}px;border-radius:50%;box-shadow:0 0 0 4000px ${shutterColor};`;
  root.appendChild(iris);

  const done = () => {
    root.remove();
    playing = false;
    resolve(true);
  };

  const ease = "cubic-bezier(0.22,1,0.36,1)";
  const LOCK_DELAY = FRAME_MS + PULL_MS;
  const BLACK_DELAY = SHUTTER_DELAY + SHUTTER_MS - BLACK_CROSS_MS;

  // Stage 1 — frame in: corners slide in from their own edges, the AF box
  // scales 1.4→1, and the rack focus ramps the page up to full blur.
  cornerLegs.forEach(({ spec, el }) => {
    const { dx, dy } = spec;
    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px)`, opacity: 0 },
        { transform: "translate(0, 0)", opacity: 1 },
      ],
      { duration: FRAME_MS, easing: ease, fill: "forwards" },
    );
  });
  box.animate(
    [
      { transform: "scale(1.4)", opacity: 0 },
      { transform: "scale(1)", opacity: 1 },
    ],
    { duration: FRAME_MS, easing: ease, fill: "forwards" },
  );
  blur.animate([{ backdropFilter: "blur(0px)" }, { backdropFilter: `blur(${7}px)` }], {
    duration: FRAME_MS,
    easing: "ease-out",
    fill: "forwards",
  });

  // Stage 2 — focus pull: the page comes into sharp focus while the AF box
  // breathes as if hunting. No backwards fill anywhere (lesson: it would pin
  // its first keyframe over the fly-in during the delay).
  blur.animate(
    [{ backdropFilter: `blur(${7}px)` }, { backdropFilter: "blur(0px)" }],
    { duration: PULL_MS, delay: FRAME_MS, easing: "ease-in-out", fill: "forwards" },
  );
  box.animate(
    [
      { transform: "scale(1)" },
      { transform: "scale(0.96)", offset: 0.45 },
      { transform: "scale(1.01)", offset: 0.75 },
      { transform: "scale(1)" },
    ],
    { duration: PULL_MS, delay: FRAME_MS, easing: "ease-in-out", fill: "forwards" },
  );

  // Stage 3 — focus lock: the box snaps green with a quick pulse and a ring
  // expands past it. The viewfinder corners stay sky — the body doesn't lock,
  // the sensor does.
  for (const el of box.children) {
    (el as HTMLElement).animate([{ color: SKY }, { color: GREEN }], {
      duration: LOCK_MS,
      delay: LOCK_DELAY,
      fill: "forwards",
    });
  }
  box.animate(
    [
      { transform: "scale(1)" },
      { transform: "scale(1.05)", offset: 0.4 },
      { transform: "scale(1)" },
    ],
    { duration: LOCK_MS, delay: LOCK_DELAY, easing: "ease-out", fill: "forwards" },
  );
  ring.animate(
    [
      { transform: "scale(0.7)", opacity: 0.85 },
      { transform: "scale(1.5)", opacity: 0 },
    ],
    { duration: RING_MS, delay: LOCK_DELAY, easing: "ease-out", fill: "forwards" },
  );

  // Stage 4 — shutter: the iris closes from all edges (accelerating, like an
  // aperture snapping), the backing crossfades to full black, and after a
  // one-beat hold the whole layer is removed in a snap cut. The capture runs
  // right after — on a clean frame.
  iris.animate([{ transform: "scale(1)" }, { transform: "scale(0.0001)" }], {
    duration: SHUTTER_MS,
    delay: SHUTTER_DELAY,
    easing: "ease-in",
    fill: "forwards",
  });
  irisBlack.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: BLACK_CROSS_MS,
    delay: BLACK_DELAY,
    easing: "ease-in",
    fill: "forwards",
  });
  setTimeout(done, TOTAL_MS);
}
