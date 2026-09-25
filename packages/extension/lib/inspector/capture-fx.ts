/**
 * UFO capture animation ("capture fx"), played after an element capture is
 * confirmed and before the preview tab opens (see `runCapture` in capture.ts).
 *
 * Choreography (~4.3s + hold): a UFO flies in from the bottom-right off-screen
 * and hovers beside the selection -> a slanted beam shoots down from the
 * craft onto the selection while a blue grid + scan line lock onto it -> a
 * white sweep covers it ("beamed up") -> the beam retracts up into the craft
 * and the UFO speeds away toward the top-right, while the full-white freeze
 * STAYS on the selection. The
 * caller opens the preview tab and then calls `releaseCaptureFxHold`, which
 * lingers the freeze a moment longer before fading it. The freeze also
 * self-releases on scroll / page hide, with a 15s safety cap — it can never
 * stick on the page.
 *
 * Design constraints:
 *  - Resolve-only: every path (throw, skip condition, superseded, early scroll)
 *    resolves — the capture flow must never wait on the fx. `runCapture` still
 *    races a 6s hard timeout on top as a second belt.
 *  - prefers-reduced-motion gets a motion-free degraded variant: a quick white
 *    blink on the selection (feedback preserved, choreography dropped) — see
 *    `runReducedFx`.
 *  - All inline styles + Web Animations API (`element.animate`): the animation
 *    parameters derive from the selection rect, which CSS keyframes can't take
 *    as input without injecting a per-capture <style>; WAAPI also makes cleanup
 *    trivial (removing the nodes cancels every animation) and is unaffected by
 *    page CSP.
 *  - Every injected node carries UI_MARKER so element picking ignores it, and
 *    the root hangs off documentElement so page shadow roots can neither
 *    contain nor hide it.
 */

import { UI_MARKER } from "./capture";
// The craft is a standalone PNG (ufo.png — keep the hi-res source there) and
// ships as a 240px-wide 2x copy inlined at build time via ?inline: no
// web_accessible_resources, no runtime fetch, works under any page CSP.
// Regenerate ufo-small.png after editing the source: sips -Z 240 ufo.png --out ufo-small.png
import ufoPng from "./ufo-small.png?inline";

export interface CaptureFxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CaptureFxOptions {
  /** Selection rect in viewport coordinates; null/empty skips the fx. */
  rect: CaptureFxRect | null;
  /** Master switch (settings.inspectorCaptureFx), read by the caller. */
  enabled: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const UFO_W = 120;
/** ufo-small.png aspect: 240x166. */
const UFO_H = 83;
/**
 * Y offset (within the wrapper) where the beam should start: the disc's
 * underside in ufo-small.png sits ~72px down — above the wrapper's bottom
 * edge (83) so the beam tucks under the craft.
 */
const UFO_BEAM_TOP = 72;

// ---------- timeline (total ~4.3s + freeze) ----------
// 0–1100       fly in along an arc from the bottom-right (scale .2→1, settle)
// 1100–end     organic hover: dual-frequency drift (3.7s × 2.6s, Lissajous)
// 1150–1600    beam expands with elastic overshoot; craft "strains" (img pulse)
// ~1600        impact ring where the beam meets the selection's top edge
// 1350–1850    grid locks in (fade + 1.03→1 scale)
// 1500–2400    scan line sweeps down fast, returns slow
// 1600–end     organic beam flicker (slow wave + occasional deep dip)
// 2050–2850    white sweep covers the selection (bar leads, base follows late)
// 2850–3050    full-white hold
// 3050–3430    beam retracts up into the craft, grid dims behind it
// 3430–4290    anticipation crouch + arcing climb away to the top-right
//              (scale 1.12→.22), THEN the white freeze stays on screen until
//              released (see releaseCaptureFxHold)
const FLY_MS = 1100;
const BEAM_DELAY = 1150;
const BEAM_MS = 450;
const GRID_DELAY = 1350;
const GRID_MS = 500;
const SCAN_DELAY = 1500;
const SCAN_MS = 900;
const FLICKER_DELAY = 1600;
const SWEEP_DELAY = 2050;
const SWEEP_MS = 800;
/** Hold time before the exit stage (fly-in + beam + grid + white sweep). */
const HOLD_MS = 3050;
/** The beam sucks back up into the craft before the UFO departs. */
const BEAM_RETRACT_MS = 380;
/** Exit stage after the retract: anticipation + arc away + finished-stage
 * cleanup. Slightly longer than EXIT_FLY_MS so the last frame lands. */
const EXIT_MS = 860;
const EXIT_FLY_MS = 820;
/** How long the white freeze lingers after the release trigger before fading. */
const RELEASE_DELAY_MS = 800;
/** The white freeze fade-out duration. */
const RELEASE_FADE_MS = 450;
/** Safety cap: the white freeze never stays longer than this, even if the
 * caller never releases it (e.g. the preview handoff failed). */
const FREEZE_CAP_MS = 15_000;
/** Scrolling beyond this distance fast-forwards the fx — the user moved on. */
const SCROLL_ABORT_PX = 8;

interface FxState {
  root: HTMLDivElement;
  /** The full-white layer; stays on screen during the freeze. Created in
   * stage 3, so null until then (holding can only be true after it exists). */
  white: HTMLDivElement | null;
  aborted: boolean;
  /** True while the white freeze is on screen awaiting release. */
  holding: boolean;
  stopHoldWatchers?: () => void;
}

let fxState: FxState | null = null;

/** Tear the animation layer (freeze included) down immediately. */
export function cancelCaptureFx() {
  if (!fxState) return;
  fxState.aborted = true;
  fxState.stopHoldWatchers?.();
  fxState.root.remove();
  fxState = null;
}

/**
 * Release the full-white freeze left on screen by a finished fx: after
 * `delayMs` it fades out and the layer is removed. Called by the capture flow
 * once the preview tab has opened (the "jump away"); the freeze also
 * self-releases on scroll / page hide / the 15s cap. No-op when nothing holds.
 */
export function releaseCaptureFxHold(delayMs = RELEASE_DELAY_MS) {
  const state = fxState;
  if (!state?.holding) return;
  releaseHold(state, delayMs);
}

/** Fade the freeze out and drop the whole layer. */
function releaseHold(state: FxState, delayMs: number) {
  if (!state.holding || !state.white) return;
  state.holding = false;
  state.stopHoldWatchers?.();
  const drop = () => {
    state.white!.style.transition = `opacity ${RELEASE_FADE_MS}ms ease`;
    state.white!.style.opacity = "0";
    setTimeout(() => {
      if (fxState === state) fxState = null;
      state.root.remove();
    }, RELEASE_FADE_MS + 50);
  };
  if (delayMs > 0) setTimeout(drop, delayMs);
  else drop();
}

/**
 * Expand a tiny rect to a 24px visual floor (the grid/scan need something to
 * draw on), pad the whole scan zone out a few px beyond the selection, and
 * clip to the viewport. Returns null when nothing is visible.
 */
function visRect(rect: CaptureFxRect, vw: number, vh: number) {
  let { x, y, w, h } = rect;
  if (w < 24) {
    x -= (24 - w) / 2;
    w = 24;
  }
  if (h < 24) {
    y -= (24 - h) / 2;
    h = 24;
  }
  // The rect is viewport-relative already; clip defensively anyway.
  const gx = Math.max(0, x);
  const gy = Math.max(0, y);
  const gw = Math.min(w, vw - gx);
  const gh = Math.min(h, vh - gy);
  if (gw <= 0 || gh <= 0) return null;
  // The whole scan zone breathes a few px beyond the selection so the grid /
  // sweep / freeze never end cramped exactly at the element's edge.
  const pad = 6;
  const px = Math.max(0, gx - pad);
  const py = Math.max(0, gy - pad);
  const pw = Math.min(vw, gx + gw + pad) - px;
  const ph = Math.min(vh, gy + gh + pad) - py;
  return { gx: px, gy: py, gw: pw, gh: ph };
}

/**
 * Leave only the white freeze on screen and arm its self-release watchers:
 * scroll → instant, page hide → instant (bfcache), hidden tab → lingered, plus
 * the FREEZE_CAP_MS safety timeout. Resolves the fx promise as `true`.
 */
function armHoldWatchers(state: FxState, resolve: (value: boolean) => void) {
  state.holding = true;
  const onHoldScroll = () => releaseHold(state, 0);
  const onHide = () => {
    if (document.hidden) releaseHold(state, RELEASE_DELAY_MS);
  };
  // bfcache restores would otherwise resurrect a stale freeze.
  const onLeave = () => {
    state.stopHoldWatchers?.();
    if (fxState === state) fxState = null;
    state.root.remove();
  };
  const cap = setTimeout(() => releaseHold(state, 0), FREEZE_CAP_MS);
  state.stopHoldWatchers = () => {
    window.removeEventListener("scroll", onHoldScroll, true);
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", onLeave);
    window.clearTimeout(cap);
  };
  window.addEventListener("scroll", onHoldScroll, {
    capture: true,
    passive: true,
  });
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", onLeave);
  resolve(true);
}

/**
 * Degraded variant for prefers-reduced-motion: no choreography, just a quick
 * white blink on the selection so the "captured" feedback survives, then the
 * same freeze/release lifecycle as the full fx.
 */
function runReducedFx(rect: CaptureFxRect): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const vis = visRect(rect, vw, vh);
    if (!vis) {
      resolve(false);
      return;
    }
    const root = document.createElement("div");
    root.setAttribute(UI_MARKER, "1");
    root.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden;";
    document.documentElement.appendChild(root);
    const state: FxState = { root, white: null, aborted: false, holding: false };
    fxState = state;
    const white = document.createElement("div");
    state.white = white;
    white.style.cssText = `position:absolute;left:${vis.gx}px;top:${vis.gy}px;width:${vis.gw}px;height:${vis.gh}px;border-radius:4px;background:#fff;opacity:0;`;
    root.appendChild(white);
    white.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 250,
      easing: "ease-out",
      fill: "forwards",
    });
    setTimeout(() => {
      if (state.aborted) {
        resolve(false);
        return;
      }
      armHoldWatchers(state, resolve);
    }, 320);
  });
}

/**
 * Play the capture animation. Resolves `true` when fully played, `false` when
 * skipped or interrupted. Never rejects.
 */
export function playCaptureFx(opts: CaptureFxOptions): Promise<boolean> {
  // At most one fx at a time: a fresh capture supersedes a running one.
  cancelCaptureFx();
  const { rect, enabled } = opts;
  if (!enabled || document.hidden || !rect || rect.w <= 0 || rect.h <= 0) {
    return Promise.resolve(false);
  }
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return runReducedFx(rect);
  }
  return runFx(rect).catch((err) => {
    console.warn("[inspector-capture] fx failed", err);
    cancelCaptureFx();
    return false;
  });
}

function runFx(rect: CaptureFxRect): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Visual floor + viewport clip (tiny elements get a 24px visualization).
    const vis = visRect(rect, vw, vh);
    if (!vis) {
      resolve(false);
      return;
    }
    const { gx, gy, gw, gh } = vis;

    // Hover point: above the selection but deliberately offset LEFT of its
    // center (20% from the left edge — reads better next to the caption
    // bubble), clamped so the UFO never leaves the viewport even for
    // full-screen selections.
    const hoverGap = Math.min(110, Math.max(72, gy - 8));
    const hoverCx = gx + gw * 0.2;
    const hx =
      Math.min(vw - UFO_W / 2 - 8, Math.max(UFO_W / 2 + 8, hoverCx)) -
      UFO_W / 2;
    const hy = Math.max(
      8,
      Math.min(vh - UFO_H - 8, gy - hoverGap - UFO_H),
    );

    const root = document.createElement("div");
    root.setAttribute(UI_MARKER, "1");
    root.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden;";
    document.documentElement.appendChild(root);
    const state: FxState = { root, white: null, aborted: false, holding: false };
    fxState = state;

    let done = false;
    const sx = window.scrollX;
    const sy = window.scrollY;
    const onScroll = () => {
      const dist =
        Math.abs(window.scrollX - sx) + Math.abs(window.scrollY - sy);
      if (dist > SCROLL_ABORT_PX) finish(false, true);
    };
    window.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });

    function finish(value: boolean, fade = false) {
      if (done) return;
      done = true;
      window.removeEventListener("scroll", onScroll, true);
      if (fade) {
        root.style.transition = "opacity .15s linear";
        root.style.opacity = "0";
        setTimeout(() => {
          root.remove();
          if (fxState === state) fxState = null;
        }, 160);
      } else {
        root.remove();
        if (fxState === state) fxState = null;
      }
      resolve(value);
    }

    // ---------- stage 1: fly in (0-1100ms), then dual-frequency hover ----------

    // The craft is three nested wrappers + the artwork, each owning exactly one
    // transform group (WAAPI animations on the same property fully override
    // each other, so layers must not share): the OUTER wrapper flies (fly-in /
    // exit), two INNER wrappers split the idle drift into independent x (3.7s)
    // and y (2.6s) oscillations — coprime periods make the combined Lissajous
    // path never visibly repeat — and the artwork itself carries the tiny
    // "strain" pulses that sync the craft with its beam (cause & effect).
    const ufo = document.createElement("div");
    ufo.style.cssText = `position:absolute;left:0;top:0;width:${UFO_W}px;height:${UFO_H}px;z-index:3;will-change:transform;filter:drop-shadow(0 6px 14px rgba(96,140,248,.55));`;
    const sway = document.createElement("div");
    sway.style.cssText = "position:absolute;inset:0;will-change:transform;";
    const bob = document.createElement("div");
    bob.style.cssText = "position:absolute;inset:0;will-change:transform;";
    // The artwork is a static PNG (ufo-small.png, see import); all motion is
    // compositor-only transforms on the wrappers.
    const img = document.createElement("img");
    img.src = ufoPng;
    img.alt = "";
    img.style.cssText = "width:100%;height:100%;display:block;";
    bob.appendChild(img);
    sway.appendChild(bob);
    ufo.appendChild(sway);
    root.appendChild(ufo);

    // Arc in from the bottom-right: the straight line start/target would read
    // as a stiff rocket path, so the keyframes lag BELOW the line (swoop under,
    // then climb into the hover point) while scale grows .2→1 across the whole
    // path — with a small low-and-right overshoot that settles into place, so
    // the growth AND the landing are both clearly visible. fill:forwards keeps
    // holding the landing transform through the idle phase (the inner drift
    // layers add their offsets on top).
    const sx0 = vw + 140;
    const sy0 = vh + 120;
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    ufo.animate(
      [
        {
          transform: `translate(${sx0}px, ${sy0}px) scale(0.2) rotate(-18deg)`,
          easing: "cubic-bezier(0.35, 0.1, 0.6, 0.9)", // accelerate out of the corner
        },
        {
          transform: `translate(${lerp(sx0, hx, 0.45)}px, ${lerp(sy0, hy, 0.5) + 70}px) scale(0.48) rotate(-9deg)`,
          offset: 0.45,
          easing: "cubic-bezier(0.25, 0.6, 0.35, 1)", // climb & decelerate
        },
        {
          transform: `translate(${hx + 34}px, ${hy + 58}px) scale(0.9) rotate(3deg)`,
          offset: 0.84,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)", // drift into the landing spot
        },
        { transform: `translate(${hx}px, ${hy}px) scale(1) rotate(0deg)` },
      ],
      { duration: FLY_MS, fill: "forwards" },
    );
    // Idle drift: two independent closed loops (no fill — during their delay
    // the fly-in's forwards fill holds the pose; a backwards fill would pin
    // the craft at its first keyframe from t=0 and hide the whole fly-in).
    sway.animate(
      [
        { transform: "translateX(0)" },
        { transform: "translateX(9px)" },
        { transform: "translateX(-6px)" },
        { transform: "translateX(0)" },
      ],
      { duration: 3700, iterations: Infinity, easing: "ease-in-out", delay: FLY_MS },
    );
    bob.animate(
      [
        { transform: "translateY(0) rotate(0deg)" },
        { transform: "translateY(7px) rotate(1.4deg)" },
        { transform: "translateY(12px) rotate(-1.2deg)" },
        { transform: "translateY(0) rotate(0deg)" },
      ],
      { duration: 2600, iterations: Infinity, easing: "ease-in-out", delay: FLY_MS },
    );

    // ---------- stage 2: beam + grid + scan line ----------

    const beamTop = hy + UFO_BEAM_TOP;
    // The beam ends at the selection's TOP edge (its corners), not the bottom
    // — the grid/white sweep light the selection body from there.
    const beamH = gy - beamTop;
    let beam: HTMLDivElement | null = null;
    if (beamH >= 16) {
      // Slanted beam: a narrow mouth right under the craft, fanning down onto
      // the selection's top edge. The UFO deliberately hovers left of the
      // selection center, so one box spans BOTH the mouth and that edge and a
      // 4-point polygon connects them — the beam always starts at the craft
      // (top-left) and slants toward the selection (bottom-right), and the
      // polygon math handles the mirrored case for free.
      const ufoCx = hx + UFO_W / 2;
      const mouth = 16; // half-width of the beam mouth, in px
      const beamLeft = Math.min(ufoCx - mouth, gx);
      const beamRight = Math.max(ufoCx + mouth, gx + gw);
      const bw = beamRight - beamLeft;
      const p = (v: number) => (((v - beamLeft) / bw) * 100).toFixed(2);
      beam = document.createElement("div");
      beam.style.cssText = `position:absolute;left:${beamLeft}px;top:${beamTop}px;width:${bw}px;height:${beamH}px;z-index:1;transform-origin:50% 0;background:linear-gradient(to bottom, rgba(186,230,253,.95), rgba(56,189,248,.12));clip-path:polygon(${p(ufoCx - mouth)}% 0, ${p(ufoCx + mouth)}% 0, ${p(gx + gw)}% 100%, ${p(gx)}% 100%);`;
      root.appendChild(beam);
      beam.animate(
        [
          { transform: "scaleY(0)", opacity: 0.4 },
          { transform: "scaleY(1.05)", opacity: 1, offset: 0.82 },
          { transform: "scaleY(1)", opacity: 1 },
        ],
        {
          duration: BEAM_MS,
          delay: BEAM_DELAY,
          easing: "cubic-bezier(0.33, 1, 0.68, 1)",
          fill: "both",
        },
      );
      // Cause & effect: emitting the beam visibly "costs" the craft a small
      // strain pulse (on the artwork layer, so it composes with the wrappers).
      img.animate(
        [
          { transform: "scale(1)", easing: "ease-in-out" },
          { transform: "scale(1.035)", offset: 0.7, easing: "ease-out" },
          { transform: "scale(1)" },
        ],
        { duration: BEAM_MS + 120, delay: BEAM_DELAY },
      );
      // Organic flicker: a slow shallow wave with one occasional deep dip —
      // a uniform metronome blink reads mechanical.
      beam.animate(
        [
          { opacity: 1, easing: "ease-in-out" },
          { opacity: 0.9, offset: 0.3, easing: "ease-in-out" },
          { opacity: 0.62, offset: 0.55, easing: "ease-in" },
          { opacity: 0.96, offset: 0.78, easing: "ease-out" },
          { opacity: 1 },
        ],
        { duration: 1500, iterations: Infinity, delay: FLICKER_DELAY },
      );
      // Impact accent: where the beam lands on the selection's top edge, a
      // flattened ring expands and dies — the "hit" gets a beat of its own.
      const ring = document.createElement("div");
      ring.style.cssText = `position:absolute;left:${gx + gw / 2}px;top:${gy}px;width:56px;height:18px;margin:-9px 0 0 -28px;border:2px solid rgba(186,230,253,.9);border-radius:50%;z-index:2;`;
      root.appendChild(ring);
      ring.animate(
        [
          { transform: "scale(.3)", opacity: 0.9 },
          { transform: "scale(1.7)", opacity: 0 },
        ],
        {
          duration: 340,
          delay: BEAM_DELAY + BEAM_MS - 80,
          easing: "ease-out",
          fill: "both",
        },
      );
    }

    const grid = document.createElement("div");
    grid.style.cssText = `position:absolute;left:${gx}px;top:${gy}px;width:${gw}px;height:${gh}px;border:1px solid rgba(147,197,253,.45);border-radius:4px;background:repeating-linear-gradient(0deg, rgba(147,197,253,.3) 0 1px, transparent 1px 24px),repeating-linear-gradient(90deg, rgba(147,197,253,.3) 0 1px, transparent 1px 24px);box-shadow:0 0 10px rgba(96,165,250,.3), inset 0 0 18px rgba(96,165,250,.15);`;
    root.appendChild(grid);
    // Lock-on: the fade rides a tiny settle (1.03→1) so the grid reads as
    // snapping into place, not just appearing.
    grid.animate(
      [
        { opacity: 0, transform: "scale(1.03)" },
        { opacity: 1, transform: "scale(1)" },
      ],
      { duration: GRID_MS, delay: GRID_DELAY, easing: "ease-out", fill: "both" },
    );
    const scan = document.createElement("div");
    scan.style.cssText =
      "position:absolute;left:0;top:0;width:100%;height:2px;background:linear-gradient(90deg, transparent, #dbeeff, transparent);";
    grid.appendChild(scan);
    // Double pass: a quick scan down, then a slower, deliberate return —
    // "checked and confirmed", and it hands the eye over to the white sweep.
    scan.animate(
      [
        { transform: "translateY(0)", easing: "ease-in" },
        { transform: `translateY(${gh - 2}px)`, offset: 0.4, easing: "ease-out" },
        { transform: "translateY(0)" },
      ],
      { duration: SCAN_MS, delay: SCAN_DELAY, fill: "both" },
    );

    // ---------- stage 3: white sweep ----------

    const white = document.createElement("div");
    state.white = white; // remembered for the post-exit freeze release
    white.style.cssText = `position:absolute;left:${gx}px;top:${gy}px;width:${gw}px;height:${gh}px;border-radius:4px;background:#fff;overflow:hidden;`;
    root.appendChild(white);
    // The base guarantees the selection ends fully white, but it HOLDS BACK
    // until the bar has mostly crossed (opacity 0 for the first 55%) — if the
    // base fades in alongside the sweep, the uniform whitening drowns the
    // sweep's direction and the wipe reads as nothing.
    white.animate(
      [
        { opacity: 0, easing: "ease-in" },
        { opacity: 0, offset: 0.55 },
        { opacity: 1 },
      ],
      { duration: SWEEP_MS, delay: SWEEP_DELAY, fill: "both" },
    );
    const d = Math.sqrt(gw * gw + gh * gh);
    const bar = document.createElement("div");
    // Mostly solid with a short trailing feather — a tight "blade" edge so the
    // wipe has a visible cutting line (the old 40%-long feather was too soft).
    bar.style.cssText = `position:absolute;left:50%;top:50%;width:${d}px;height:${d * 1.6}px;margin-left:${-d / 2}px;margin-top:${-d * 0.8}px;background:linear-gradient(to bottom, #fff 0%, #fff 60%, rgba(255,255,255,0) 100%);`;
    white.appendChild(bar);
    // rotate(45deg) points the bar's local -Y axis at the top-right corner, so
    // a translateY(66% -> -66%) sweep runs bottom-left -> top-right regardless
    // of the selection's aspect ratio — why this beats a clip-path tween.
    // Ease-in: the wipe accelerates, like the content is being sucked up.
    bar.animate(
      [
        { transform: "rotate(45deg) translateY(66%)" },
        { transform: "rotate(45deg) translateY(-66%)" },
      ],
      { duration: SWEEP_MS, delay: SWEEP_DELAY, easing: "ease-in", fill: "both" },
    );

    // ---------- stage 4: beam retract + exit, then the white freeze ----------

    void (async () => {
      await sleep(HOLD_MS);
      if (done || state.aborted) return;
      // ---------- stage 4a: switch off the tractor beam ----------
      // The beam sucks back UP into the craft (scaleY → 0, origin at the top
      // mouth) and the grid dims behind it — the UFO leaves only after its
      // beam is fully retracted.
      if (beam) {
        // Start from the flicker's LIVE opacity — a hardcoded first frame
        // would jump-cut whenever the flicker happens to sit in a dip. The
        // beam then brightens to full while it sucks in: a final burst before
        // shutdown. The craft answers with a matching ease-back pulse.
        const beamOpacity = getComputedStyle(beam).opacity;
        beam.animate(
          [
            { transform: "scaleY(1)", opacity: beamOpacity },
            { transform: "scaleY(0)", opacity: 1 },
          ],
          {
            duration: BEAM_RETRACT_MS,
            easing: "cubic-bezier(0.6, 0, 0.8, 0.4)", // accelerating suck-back
            fill: "forwards",
          },
        );
        img.animate(
          [
            { transform: "scale(1)", easing: "ease-in-out" },
            { transform: "scale(0.965)", offset: 0.7, easing: "ease-out" },
            { transform: "scale(1)" },
          ],
          { duration: BEAM_RETRACT_MS + 120 },
        );
      }
      grid.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: BEAM_RETRACT_MS,
        delay: 80,
        easing: "ease-out",
        fill: "forwards",
      });
      await sleep(BEAM_RETRACT_MS + 60);
      if (done || state.aborted) return;
      // ---------- stage 4b: the craft departs ----------
      // The outer wrapper starts from the landing pose (the fly-in's forwards
      // fill holds it); the idle-drift inner layers keep running and wobble
      // the craft as it leaves — organic, and no drift-to-landing snap since
      // they compose instead of competing for the same transform.
      // Classic anticipation first: DIP down + squash (opposite the launch
      // direction) so the climb-away springs; then arc up-right (y lags x so
      // the path bows below the straight line and bends upward), shrinking
      // hard so the getaway is unmistakable.
      const ex = vw + 160;
      const ey = -hy - 260;
      ufo.animate(
        [
          {
            transform: `translate(${hx}px, ${hy}px) scale(1) rotate(0deg)`,
            easing: "ease-out",
          },
          {
            transform: `translate(${hx - 4}px, ${hy + 10}px) scale(1.08, 0.93) rotate(-3deg)`,
            offset: 0.22,
            easing: "cubic-bezier(0.6, 0, 0.8, 0.4)", // charge, then launch
          },
          {
            transform: `translate(${lerp(hx, ex, 0.5)}px, ${lerp(hy, ey, 0.34)}px) scale(0.68) rotate(12deg)`,
            offset: 0.58,
            easing: "cubic-bezier(0.5, 0, 0.9, 0.6)", // keep accelerating upward
          },
          { transform: `translate(${ex}px, ${ey}px) scale(0.22) rotate(24deg)` },
        ],
        { duration: EXIT_FLY_MS, fill: "forwards" },
      );
      // The white layer deliberately keeps its opacity — the freeze stays.
      await sleep(EXIT_MS);
      if (done || state.aborted) return;
      // Drop the finished stages; only the full-white freeze remains on the
      // selection, awaiting release (caller / scroll / hide / safety cap).
      ufo.remove();
      grid.remove();
      beam?.remove();
      armHoldWatchers(state, () => resolve(true));
    })();
  });
}
