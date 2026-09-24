/**
 * In-page element capture ("inspector capture").
 *
 * Lets the user box-select (drag) or click-pick elements on the current page,
 * and copies a JSON description of them to the clipboard. A click captures the
 * picked element plus its entire visible subtree (nested `children`); a drag
 * captures the elements intersecting the box, nested by DOM hierarchy. Each
 * entry carries tag / id / classes / text / source coordinates (from
 * `data-inspector-*` attributes injected at build time) / viewport rect /
 * ~40 computed styles / CSS custom properties (only those the element
 * defines/overrides or actually references). To keep the payload token-lean,
 * style entries equal to the CSS initial value are omitted, inherited
 * properties equal to the captured tree parent are omitted, and the clipboard
 * JSON is minified (the console still logs the pretty object).
 *
 * Runs inside the ISOLATED-world content script. Activated from the popup via
 * `TOGGLE_INSPECTOR_CAPTURE` (tabs.sendMessage) or the Alt+Shift+I hotkey.
 *
 * The page language for the in-page hint/toast strings follows
 * `navigator.language` — the content script has no React tree, so react-i18next
 * is not wired here; strings are few and inline.
 */

import {
  ATTR_WHITELIST,
  type ElementDescription,
  type InspectorCapturePayload,
} from "./types";
import { leanElement } from "./lean";
import { sendMessage } from "@/lib/messaging";

/** Message type that toggles capture mode (popup -> content script, per-tab). */
export const TOGGLE_INSPECTOR_CAPTURE = "TOGGLE_INSPECTOR_CAPTURE";

/** Source-locator attributes injected into built React output (compiler step). */
const ATTR_PATH = "data-inspector-relative-path";
const ATTR_LINE = "data-inspector-line";
const ATTR_COLUMN = "data-inspector-column";

/** Marker attribute for all DOM nodes this module injects (overlay / toast). */
const UI_MARKER = "data-inspector-capture-ui";

const STYLE_PROPS = [
  "display",
  "position",
  "inset",
  "top",
  "right",
  "bottom",
  "left",
  "width",
  "height",
  "margin",
  "padding",
  "border",
  "border-radius",
  "box-shadow",
  "box-sizing",
  "flex-direction",
  "flex-wrap",
  "justify-content",
  "align-items",
  "align-self",
  "gap",
  "flex",
  "grid-template-columns",
  "grid-template-rows",
  "grid-area",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "color",
  "background-color",
  "background-image",
  "text-align",
  "text-transform",
  "white-space",
  "overflow",
  "z-index",
  "opacity",
  "transform",
  "cursor",
];

/**
 * Chrome computed values for the CSS initial state of the whitelisted props.
 * Entries equal to these are dropped from `styles` — they carry no signal
 * (nothing was authored / inherited to produce them) and are trivially
 * reconstructable.
 */
const STYLE_DEFAULTS: Record<string, string> = {
  position: "static",
  inset: "auto",
  top: "auto",
  right: "auto",
  bottom: "auto",
  left: "auto",
  margin: "0px",
  padding: "0px",
  border: "0px none rgb(0, 0, 0)",
  "border-radius": "0px",
  "box-shadow": "none",
  "box-sizing": "content-box",
  "flex-wrap": "nowrap",
  "justify-content": "normal",
  "align-items": "normal",
  "align-self": "auto",
  gap: "normal",
  flex: "0 1 auto",
  "grid-template-columns": "none",
  "grid-template-rows": "none",
  "grid-area": "auto",
  "font-weight": "400",
  "line-height": "normal",
  "letter-spacing": "normal",
  "text-align": "start",
  "text-transform": "none",
  "white-space": "normal",
  "background-color": "rgba(0, 0, 0, 0)",
  "background-image": "none",
  overflow: "visible",
  "z-index": "auto",
  opacity: "1",
  transform: "none",
  cursor: "auto",
};

/**
 * Inherited props among the whitelist: when the value equals the captured tree
 * parent's computed value, it is redundant (inheritance reproduces it exactly)
 * and is omitted. Only valid against a real DOM ancestor, which both
 * `describeSubtree` and `nestAsForest` guarantee.
 */
const INHERITED_PROPS = new Set([
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "white-space",
  "cursor",
]);

// Caps the captured subtree size. Every node carries its full computed-style
// map (~300-400 properties), so this drives payload size roughly linearly:
// 1000 nodes ≈ 20-100MB of JSON. The payload no longer travels through
// runtime.sendMessage (its ~64MB structured-clone cap is what used to cap
// this constant): it goes postMessage -> inspector-bridge iframe ->
// IndexedDB, neither of which has that ceiling. The clipboard copy stays
// lean (fullStyles/pseudo/textFull stripped), so it remains small.
const MAX_ELEMENTS = 1000;
const DRAG_THRESHOLD = 4;

const L = navigator.language.startsWith("zh")
  ? {
      hint: "选择要捕获的元素，结果复制到剪贴板并打开预览",
      exit: "点击任意处或按 Esc 退出",
      none: "未捕获到任何元素",
      copyFailed: "复制失败，JSON 已打印到控制台",
      previewFailed: "预览打开失败，捕获结果已复制到剪贴板",
    }
  : {
      hint: "Select an element to capture; the result is copied to the clipboard and opened in a preview tab",
      exit: "Click anywhere or press Esc to exit",
      none: "No elements captured",
      copyFailed: "Copy failed; JSON printed to the console",
      previewFailed:
        "Failed to open the preview; the capture is on the clipboard",
    };

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Ui {
  root: HTMLDivElement;
  sel: HTMLDivElement;
  badge: HTMLDivElement;
  /** Chrome DevTools-style element highlight, drawn as rings: */
  marginStrips: HTMLDivElement[];
  borderStrips: HTMLDivElement[];
  paddingStrips: HTMLDivElement[];
  contentFill: HTMLDivElement;
  gapLayer: HTMLDivElement;
  /** Top hint bar; doubles as the visible exit button. */
  hint: HTMLDivElement;
}

/** Minimal rect used to position overlay boxes. */
interface SimpleRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

let active = false;
let dragging = false;
let startX = 0;
let startY = 0;
let curX = 0;
let curY = 0;
let ui: Ui | null = null;
let styleEl: HTMLStyleElement | null = null;

// ---------- UI ----------

function buildUi(): Ui {
  const root = document.createElement("div");
  root.setAttribute(UI_MARKER, "1");
  root.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
  const hint = document.createElement("div");
  // A Google Lens-style pill: lens icon + label. It keeps pointer-events so it
  // doubles as an exit button — Chrome DevTools swallows Escape when it holds
  // focus, so a page-level keydown listener can never see it and clicking the
  // bar must remain a reliable way out (exit hint lives on its title).
  hint.style.cssText =
    "position:fixed;top:16px;left:50%;transform:translateX(-50%);" +
    "display:flex;align-items:center;gap:10px;" +
    "background:#202124;color:#e8eaed;" +
    "font:14px/1.4 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;" +
    "padding:10px 18px;border-radius:999px;white-space:nowrap;" +
    "box-shadow:0 2px 10px rgba(0,0,0,.35);" +
    "pointer-events:auto;cursor:pointer;user-select:none;";
  // Lens/camera glyph (matches the reference screenshot's leading icon).
  const lens = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  lens.setAttribute("viewBox", "0 0 24 24");
  lens.setAttribute("width", "20");
  lens.setAttribute("height", "20");
  lens.setAttribute("fill", "currentColor");
  lens.style.cssText = "flex:0 0 auto;";
  lens.innerHTML =
    '<path d="M9 3 7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9Zm3 5.5A4.5 4.5 0 1 1 7.5 13 4.5 4.5 0 0 1 12 8.5Zm0 2A2.5 2.5 0 1 0 14.5 13 2.5 2.5 0 0 0 12 10.5Z"/>';
  const label = document.createElement("span");
  label.textContent = L.hint;
  hint.title = L.exit;
  hint.append(lens, label);
  // Chrome DevTools element-highlight palette: content blue, padding green,
  // border yellow, margin orange, gap purple. Flat semi-transparent fills with
  // no borders, drawn as position:fixed strips so page layout is untouched.
  const fill = (bg: string) => {
    const d = document.createElement("div");
    d.style.cssText = `position:fixed;display:none;background:${bg};`;
    return d;
  };
  const marginStrips = [0, 1, 2, 3].map(() => fill("rgba(246,178,107,.66)"));
  const borderStrips = [0, 1, 2, 3].map(() => fill("rgba(255,229,153,.66)"));
  const paddingStrips = [0, 1, 2, 3].map(() => fill("rgba(147,196,125,.55)"));
  const contentFill = fill("rgba(111,168,220,.66)");
  const gapLayer = document.createElement("div");
  gapLayer.style.cssText = "position:fixed;inset:0;pointer-events:none;";
  const sel = document.createElement("div");
  sel.style.cssText =
    "position:fixed;border:1px solid #6a9ee6;background:rgba(111,168,220,.25);display:none;";
  const badge = document.createElement("div");
  badge.style.cssText =
    "position:fixed;display:none;padding:2px 6px;border-radius:2px;" +
    "background:rgba(255,255,255,.85);color:#374151;white-space:nowrap;" +
    "font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;";
  root.append(
    ...marginStrips,
    ...borderStrips,
    ...paddingStrips,
    contentFill,
    gapLayer,
    sel,
    badge,
    hint,
  );
  document.documentElement.appendChild(root);
  return {
    root,
    sel,
    badge,
    hint,
    marginStrips,
    borderStrips,
    paddingStrips,
    contentFill,
    gapLayer,
  };
}

let hoverBox: SimpleRect | null = null;
let selBox: SimpleRect | null = null;

/** Position a single overlay box; hide it when degenerate. */
function setBox(el: HTMLElement, x: number, y: number, w: number, h: number) {
  if (w < 1 || h < 1) {
    el.style.display = "none";
    return;
  }
  el.style.display = "block";
  el.style.left = x + "px";
  el.style.top = y + "px";
  el.style.width = w + "px";
  el.style.height = h + "px";
}

/** Draw the ring between `outer` and `inner` as 4 strips: top/right/bottom/left. */
function setRing(
  strips: HTMLDivElement[],
  outer: SimpleRect,
  inner: SimpleRect,
) {
  const iR = inner.x + inner.width;
  const iB = inner.y + inner.height;
  const oR = outer.x + outer.width;
  const oB = outer.y + outer.height;
  const quads = [
    { x: outer.x, y: outer.y, w: outer.width, h: inner.y - outer.y },
    { x: iR, y: inner.y, w: oR - iR, h: inner.height },
    { x: outer.x, y: iB, w: outer.width, h: oB - iB },
    { x: outer.x, y: inner.y, w: inner.x - outer.x, h: inner.height },
  ];
  for (let i = 0; i < 4; i++) {
    const q = quads[i];
    const s = strips[i];
    if (!q || !s) continue;
    setBox(s, q.x, q.y, q.w, q.h);
  }
}

/**
 * Highlight `el` the Chrome DevTools way: margin ring orange, border ring
 * yellow, padding ring green, content box blue, plus purple gap overlays for
 * flex/grid containers.
 */
function setHover(el: Element) {
  if (!ui) return;
  ui.gapLayer.replaceChildren(); // clear the previous element's gap strips
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const num = (v: string) => parseFloat(v) || 0;
  const mt = num(cs.marginTop);
  const mr = num(cs.marginRight);
  const mb = num(cs.marginBottom);
  const ml = num(cs.marginLeft);
  const bt = num(cs.borderTopWidth);
  const br = num(cs.borderRightWidth);
  const bb = num(cs.borderBottomWidth);
  const bl = num(cs.borderLeftWidth);
  const pt = num(cs.paddingTop);
  const pr = num(cs.paddingRight);
  const pb = num(cs.paddingBottom);
  const pl = num(cs.paddingLeft);
  const marginBox: SimpleRect = {
    x: r.x - ml,
    y: r.y - mt,
    width: r.width + ml + mr,
    height: r.height + mt + mb,
  };
  const borderBox: SimpleRect = {
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
  };
  const paddingBox: SimpleRect = {
    x: r.x + bl,
    y: r.y + bt,
    width: r.width - bl - br,
    height: r.height - bt - bb,
  };
  const contentBox: SimpleRect = {
    x: paddingBox.x + pl,
    y: paddingBox.y + pt,
    width: paddingBox.width - pl - pr,
    height: paddingBox.height - pt - pb,
  };
  setRing(ui.marginStrips, marginBox, borderBox);
  setRing(ui.borderStrips, borderBox, paddingBox);
  setRing(ui.paddingStrips, paddingBox, contentBox);
  setBox(
    ui.contentFill,
    contentBox.x,
    contentBox.y,
    contentBox.width,
    contentBox.height,
  );
  hoverBox = borderBox;
  drawGap(el, cs, contentBox);
}

/** Hide the hover highlight (all rings, content fill and gap overlays). */
function clearHover() {
  if (!ui) return;
  for (const d of [
    ...ui.marginStrips,
    ...ui.borderStrips,
    ...ui.paddingStrips,
    ui.contentFill,
  ]) {
    d.style.display = "none";
  }
  ui.gapLayer.replaceChildren();
  hoverBox = null;
}

/**
 * Purple gap overlay for flex/grid containers: fills the uncovered intervals
 * between children inside the content box — column gaps as vertical strips,
 * row gaps as horizontal strips.
 */
function drawGap(el: Element, cs: CSSStyleDeclaration, content: SimpleRect) {
  if (!ui) return;
  const containerish = /^(inline-)?(flex|grid)$/.test(cs.display);
  const colGap = parseFloat(cs.columnGap) || 0;
  const rowGap = parseFloat(cs.rowGap) || 0;
  if (!containerish || (colGap < 1 && rowGap < 1)) return;
  const layer = ui.gapLayer;
  const rects: SimpleRect[] = [];
  for (const child of el.children) {
    if (child.hasAttribute(UI_MARKER)) continue;
    const cr = child.getBoundingClientRect();
    if (cr.width < 1 && cr.height < 1) continue;
    rects.push({ x: cr.x, y: cr.y, width: cr.width, height: cr.height });
  }
  if (rects.length < 2) return;
  const gapDiv = (x: number, y: number, w: number, h: number) => {
    const d = document.createElement("div");
    d.style.cssText = "position:fixed;background:rgba(127,32,210,.3);";
    d.style.left = x + "px";
    d.style.top = y + "px";
    d.style.width = w + "px";
    d.style.height = h + "px";
    layer.appendChild(d);
  };
  // Intervals not covered by any child, along one axis.
  const uncovered = (intervals: [number, number][]): [number, number][] => {
    intervals.sort((a, b) => a[0] - b[0]);
    const out: [number, number][] = [];
    let end = intervals[0]?.[1] ?? 0;
    for (let i = 1; i < intervals.length; i++) {
      const cur = intervals[i];
      if (!cur) continue;
      if (cur[0] > end) out.push([end, cur[0]]);
      end = Math.max(end, cur[1]);
    }
    return out;
  };
  if (colGap >= 1) {
    const gaps = uncovered(
      rects.map((r) => [r.x, r.x + r.width] as [number, number]),
    );
    for (const [a, b] of gaps) gapDiv(a, content.y, b - a, content.height);
  }
  if (rowGap >= 1) {
    const gaps = uncovered(
      rects.map((r) => [r.y, r.y + r.height] as [number, number]),
    );
    for (const [a, b] of gaps) gapDiv(content.x, a, content.width, b - a);
  }
}

/**
 * Position the "width × height" badge (Chrome DevTools style) next to the
 * currently active overlay: the drag selection while dragging, otherwise the
 * hovered element's border box. Hidden when neither exists.
 */
function syncBadge() {
  if (!ui) return;
  const box = selBox ?? hoverBox;
  if (!box || box.width < 1) {
    ui.badge.style.display = "none";
    return;
  }
  const { x, y, width: w, height: h } = box;
  ui.badge.textContent = `${Math.round(w)} × ${Math.round(h)}`;
  ui.badge.style.display = "block";
  const bw = ui.badge.offsetWidth;
  const bh = ui.badge.offsetHeight;
  const bx = Math.max(x, Math.min(x + w - bw, window.innerWidth - bw - 4));
  let by = y - bh - 4;
  if (by < 4) by = y + h + 4;
  ui.badge.style.left = bx + "px";
  ui.badge.style.top = by + "px";
}

function setRect(
  el: HTMLElement,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  el.style.left = left + "px";
  el.style.top = top + "px";
  el.style.width = Math.max(1, Math.abs(x2 - x1)) + "px";
  el.style.height = Math.max(1, Math.abs(y2 - y1)) + "px";
}

function normRect(x1: number, y1: number, x2: number, y2: number): Box {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  return {
    x,
    y,
    width,
    height,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
  };
}

function intersects(r: DOMRect, box: Box) {
  return !(
    r.right < box.left ||
    r.left > box.right ||
    r.bottom < box.top ||
    r.top > box.bottom
  );
}

function elementAt(x: number, y: number): Element | null {
  const el = document.elementFromPoint(x, y);
  if (!el || el.closest(`[${UI_MARKER}]`)) return null;
  return el;
}

// ---------- capture ----------

function isVisible(el: Element): boolean {
  const cs = getComputedStyle(el);
  return cs.display !== "none" && cs.visibility !== "hidden";
}

/**
 * Describe `el` plus its entire visible subtree as a nested tree, so a click
 * captures everything inside the picked element. Total nodes are capped at
 * MAX_ELEMENTS; returns null once the budget is exhausted.
 */
function describeSubtree(
  el: Element,
  budget: { left: number },
  parentCs: CSSStyleDeclaration | null = null,
): ElementDescription | null {
  if (budget.left <= 0) return null;
  budget.left--;
  const cs = getComputedStyle(el);
  const entry = describeElement(el, parentCs, cs);
  const children: ElementDescription[] = [];
  for (const child of el.children) {
    if (child.hasAttribute(UI_MARKER)) continue;
    if (!isVisible(child)) continue;
    const r = child.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) continue;
    const c = describeSubtree(child, budget, cs);
    if (c) children.push(c);
  }
  if (children.length) entry.children = children;
  return entry;
}

/**
 * Nest a flat, document-ordered element list into a forest: an element becomes
 * a child of its nearest ancestor within the list. Same element set, but the
 * JSON keeps the DOM hierarchy.
 */
function nestAsForest(els: Element[]): ElementDescription[] {
  const roots: ElementDescription[] = [];
  const stack: {
    el: Element;
    desc: ElementDescription;
    cs: CSSStyleDeclaration;
  }[] = [];
  for (const el of els) {
    while (stack.length && !stack[stack.length - 1]!.el.contains(el))
      stack.pop();
    const parent = stack[stack.length - 1];
    const cs = getComputedStyle(el);
    const desc = describeElement(el, parent?.cs ?? null, cs);
    if (parent) (parent.desc.children ??= []).push(desc);
    else roots.push(desc);
    stack.push({ el, desc, cs });
  }
  return roots;
}

/** Total node count of a forest (roots plus all nested children). */
function countNodes(elements: ElementDescription[]): number {
  let n = 0;
  for (const d of elements) {
    n += 1 + (d.children ? countNodes(d.children) : 0);
  }
  return n;
}

function collectIntersecting(box: Box): Element[] {
  const tagged: Element[] = [];
  const leaves: Element[] = [];
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest(`[${UI_MARKER}]`)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) continue;
    if (!intersects(r, box)) continue;
    if (el.hasAttribute(ATTR_PATH)) tagged.push(el);
    else if (el.children.length === 0) leaves.push(el);
  }
  return (tagged.length ? tagged : leaves).slice(0, MAX_ELEMENTS);
}

// Keep CSS custom properties with a high signal-to-noise ratio:
// A) only those defined or overridden on this element (differ from the
//    parent's computed value, so inherited :root tokens are dropped), plus
// B) those actually referenced by rules that apply to this element (inline
//    style attribute and matching stylesheet rules).
function collectCssVars(
  el: Element,
  cs: CSSStyleDeclaration,
): Record<string, string> {
  const vars: Record<string, string> = {};
  const parent = el.parentElement ? getComputedStyle(el.parentElement) : null;
  for (let i = 0; i < cs.length; i++) {
    const prop = cs.item(i);
    if (!prop?.startsWith("--")) continue;
    const v = cs.getPropertyValue(prop).trim();
    if (!v) continue;
    if (!parent || parent.getPropertyValue(prop).trim() !== v) vars[prop] = v;
  }
  for (const ref of collectReferencedVars(el)) {
    const v = cs.getPropertyValue(ref).trim();
    if (v && !(ref in vars)) vars[ref] = v;
  }
  return vars;
}

const VAR_REF_RE = /var\(\s*(--[\w-]+)/g;

/**
 * Every non-empty computed property (resolved values, no trimming) — the
 * preview inlines these per node so the rebuild needs neither inheritance
 * nor the capture-time dedup and still matches the original pixel-for-pixel.
 */
function fullStyleMap(cs: CSSStyleDeclaration): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < cs.length; i++) {
    const prop = cs.item(i);
    if (!prop || prop.startsWith("--")) continue;
    const v = cs.getPropertyValue(prop).trim();
    if (v) out[prop] = v;
  }
  return out;
}

/**
 * Computed styles of ::before / ::after when they actually render content
 * (icon glyphs, decorations). Without them, pseudo-driven visuals would be
 * silently missing from the preview.
 */
function collectPseudoStyles(el: Element): ElementDescription["pseudo"] {
  const before = getComputedStyle(el, "::before");
  const after = getComputedStyle(el, "::after");
  const bc = before.getPropertyValue("content").trim();
  const ac = after.getPropertyValue("content").trim();
  const hasBefore = !!bc && bc !== "none" && bc !== "normal";
  const hasAfter = !!ac && ac !== "none" && ac !== "normal";
  if (!hasBefore && !hasAfter) return undefined;
  const out: NonNullable<ElementDescription["pseudo"]> = {};
  if (hasBefore) out.before = fullStyleMap(before);
  if (hasAfter) out.after = fullStyleMap(after);
  return out;
}

function extractVarRefs(text: string, out: Set<string>): void {
  VAR_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VAR_REF_RE.exec(text))) out.add(m[1] ?? "");
}

function collectReferencedVars(el: Element): Set<string> {
  const refs = new Set<string>();
  const inline = el.getAttribute("style");
  if (inline) extractVarRefs(inline, refs);
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin stylesheet: cssRules access throws
    }
    collectRuleVarRefs(el, rules, refs);
  }
  return refs;
}

function collectRuleVarRefs(
  el: Element,
  rules: CSSRuleList,
  refs: Set<string>,
): void {
  for (const rule of rules) {
    if (rule instanceof CSSMediaRule) {
      if (window.matchMedia(rule.conditionText).matches) {
        collectRuleVarRefs(el, rule.cssRules, refs);
      }
    } else if ("cssRules" in rule) {
      // supports / layer / container groupings
      collectRuleVarRefs(
        el,
        (rule as { cssRules: CSSRuleList }).cssRules,
        refs,
      );
    } else if (rule instanceof CSSStyleRule) {
      let matches = false;
      try {
        matches = el.matches(rule.selectorText);
      } catch {
        // invalid selector: ignore
      }
      if (matches) {
        for (let i = 0; i < rule.style.length; i++) {
          const prop = rule.style.item(i) ?? "";
          extractVarRefs(rule.style.getPropertyValue(prop), refs);
        }
      }
    }
  }
}

/**
 * Describe a single element. `parentCs` (computed style of its nearest captured
 * DOM ancestor) and `cs` (its own, usually already computed by the caller) let
 * us deduplicate: default/initial values and inherited values identical to the
 * tree parent are omitted, keeping the payload token-lean without losing
 * information — inheritance and CSS initial values reconstruct them exactly.
 */
function describeElement(
  el: Element,
  parentCs: CSSStyleDeclaration | null = null,
  cs: CSSStyleDeclaration | null = null,
): ElementDescription {
  const r = el.getBoundingClientRect();
  cs ??= getComputedStyle(el);
  const styles: Record<string, string> = {};
  for (const prop of STYLE_PROPS) {
    const v = cs.getPropertyValue(prop).trim();
    if (!v) continue;
    if (STYLE_DEFAULTS[prop] === v) continue;
    if (
      parentCs &&
      INHERITED_PROPS.has(prop) &&
      parentCs.getPropertyValue(prop).trim() === v
    ) {
      continue;
    }
    styles[prop] = v;
  }
  const cssVars = collectCssVars(el, cs);
  const ownTextFull = [...el.childNodes]
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent?.trim() ?? "")
    .join(" ")
    .replace(/\s+/g, " ");
  const ownText = ownTextFull.slice(0, 80);
  const file = el.getAttribute(ATTR_PATH);
  const entry: ElementDescription = {
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    classes: el.classList.length ? [...el.classList] : undefined,
    text: ownText || undefined,
    source: file
      ? {
          file,
          line: Number(el.getAttribute(ATTR_LINE)) || undefined,
          column: Number(el.getAttribute(ATTR_COLUMN)) || undefined,
        }
      : undefined,
    rect: {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    },
  };
  const attrs: Record<string, string> = {};
  // SVG elements (icons, shapes) are attribute-driven — `d`, `viewBox`,
  // `fill`… are not covered by the whitelist, so capture ALL of them, or the
  // preview renders empty graphics.
  if (el instanceof SVGElement) {
    for (const attr of el.attributes) {
      attrs[attr.name] = attr.value;
    }
  } else {
    for (const name of ATTR_WHITELIST) {
      const v = el.getAttribute(name);
      if (v == null || v === "") continue;
      attrs[name] = v;
    }
  }
  // Relative src/href would break outside the original page — resolve them
  // to absolute URLs so the preview (and the clipboard JSON) are portable.
  for (const name of ["src", "href", "xlink:href"]) {
    const v = attrs[name];
    if (v && !/^(data:|blob:|[a-z+]+:)/i.test(v)) {
      try {
        attrs[name] = new URL(v, location.href).href;
      } catch {
        /* keep the raw value */
      }
    }
  }
  if (Object.keys(attrs).length) entry.attrs = attrs;
  if (Object.keys(styles).length) entry.styles = styles;
  if (Object.keys(cssVars).length) entry.cssVars = cssVars;
  // Preview-only bulk: the full resolved styles + pseudo decorations + the
  // unclipped text. Stripped from the clipboard/lean copies by `leanElement`.
  entry.fullStyles = fullStyleMap(cs);
  const pseudo = collectPseudoStyles(el);
  if (pseudo) entry.pseudo = pseudo;
  if (ownTextFull.length > 80) entry.textFull = ownTextFull;
  return entry;
}

function runCapture(elements: ElementDescription[], box: Box | null) {
  deactivate();
  if (!elements.length) {
    toast(L.none);
    return;
  }
  const payload: InspectorCapturePayload = {
    type: "inspector-capture",
    page: { url: location.href, title: document.title },
    capturedAt: new Date().toISOString(),
    selection: box
      ? { x: box.x, y: box.y, w: box.width, h: box.height }
      : "click",
    elementCount: countNodes(elements),
    elements,
  };
  // Minified lean JSON for the clipboard (token-lean); the console logs the
  // same lean object, which DevTools pretty-prints for human debugging.
  const lean = { ...payload, elements: payload.elements.map(leanElement) };
  const json = JSON.stringify(lean);
  console.log("[inspector-capture]", lean);
  // Success is silent (no toast) — the overlay is already gone; only surface a
  // toast when the copy actually fails so the user is not left guessing.
  copyText(json).then((ok) => {
    if (!ok) toast(L.copyFailed);
  });
  // Fire-and-forget: the payload travels to the extension's IndexedDB via the
  // inspector-bridge iframe (see handoffToBridge below), which then pings the
  // background to open the preview tab. A failure here must never disturb the
  // capture itself — it only toasts (the clipboard copy already succeeded).
  void handoffToBridge(payload);
}

/**
 * Hand the full capture payload to the extension's IndexedDB through a hidden
 * extension-origin iframe (entrypoints/inspector-bridge). Two reasons this
 * hop exists at all:
 *
 *  - A content script's `indexedDB` is scoped to the PAGE's origin — it
 *    cannot reach the extension's own database.
 *  - `runtime.sendMessage` clones one message with a ~64MB ceiling, which a
 *    large capture can exceed. `postMessage` to the bridge has no such cap;
 *    the bridge writes the record itself and pings the background
 *    (INSPECTOR_CAPTURE_PREVIEW_READY) to open the preview tab.
 *
 * Strictly fire-and-forget: resolves (never rejects) once the chain is
 * settled, and toasts `L.previewFailed` on failure or on a 15s timeout (e.g.
 * the bridge failed to load), so the user is never left guessing.
 */
async function handoffToBridge(
  payload: InspectorCapturePayload,
): Promise<void> {
  // Mint a one-shot token first: the bridge is embeddable by any web page,
  // so it cannot trust postMessage alone. A token minted over
  // runtime.sendMessage (page scripts can't send those) and verified by the
  // background before the IDB write is what proves this is a real capture.
  let token: string | undefined;
  try {
    ({ token } = await sendMessage("INSPECTOR_BRIDGE_MINT_TOKEN", undefined));
  } catch (err) {
    console.warn("[inspector-capture] bridge token mint failed", err);
  }
  if (!token) {
    toast(L.previewFailed);
    return;
  }
  const bridgeUrl = browser.runtime.getURL("/inspector-bridge.html");
  return new Promise<void>((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute(UI_MARKER, "1");
    iframe.src = bridgeUrl;
    iframe.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;border:0;visibility:hidden;";
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      iframe.remove();
      if (!ok) toast(L.previewFailed);
      resolve();
    };
    const timer = window.setTimeout(() => finish(false), 15_000);
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframe.contentWindow) return;
      const msg = e.data as { type?: string; ok?: boolean };
      if (msg?.type === "inspector-bridge-ready") {
        // targetOrigin = the bridge's own origin; nothing else can read it.
        iframe.contentWindow?.postMessage(
          { type: "inspector-bridge-save", payload, token },
          bridgeUrl,
        );
      } else if (msg?.type === "inspector-bridge-saved") {
        finish(msg.ok === true);
      }
    };
    window.addEventListener("message", onMessage);
    document.documentElement.appendChild(iframe);
  });
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through to the execCommand fallback */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function toast(msg: string) {
  const t = document.createElement("div");
  t.setAttribute(UI_MARKER, "1");
  t.style.cssText =
    "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);" +
    "background:rgba(17,24,39,.92);color:#fff;font:13px/1.6 system-ui,sans-serif;" +
    "padding:8px 18px;border-radius:999px;z-index:2147483647;";
  t.textContent = msg;
  document.documentElement.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ---------- events ----------

function onMouseDown(e: MouseEvent) {
  if (!active) return;
  e.preventDefault();
  e.stopPropagation();
  dragging = true;
  startX = e.clientX;
  startY = e.clientY;
  curX = startX;
  curY = startY;
  if (!ui) return;
  ui.sel.style.display = "block";
  selBox = { x: startX, y: startY, width: 1, height: 1 };
  setRect(ui.sel, startX, startY, curX, curY);
  syncBadge();
}

function onMouseMove(e: MouseEvent) {
  if (!active || !ui) return;
  e.stopPropagation();
  curX = e.clientX;
  curY = e.clientY;
  if (dragging) {
    setRect(ui.sel, startX, startY, curX, curY);
    selBox = {
      x: Math.min(startX, curX),
      y: Math.min(startY, curY),
      width: Math.abs(curX - startX),
      height: Math.abs(curY - startY),
    };
    clearHover();
    syncBadge();
    return;
  }
  const el = elementAt(curX, curY);
  if (el) setHover(el);
  else clearHover();
  syncBadge();
}

function onMouseUp(e: MouseEvent) {
  if (!active || !dragging) return;
  e.preventDefault();
  e.stopPropagation();
  dragging = false;
  if (ui) {
    ui.sel.style.display = "none";
    ui.badge.style.display = "none";
  }
  selBox = null;
  if (
    Math.abs(curX - startX) < DRAG_THRESHOLD &&
    Math.abs(curY - startY) < DRAG_THRESHOLD
  ) {
    const el = elementAt(e.clientX, e.clientY);
    if (el) {
      // Click = pick this element plus its entire visible subtree.
      const budget = { left: MAX_ELEMENTS };
      const desc = describeSubtree(el, budget);
      if (desc) runCapture([desc], null);
    }
    return;
  }
  const box = normRect(startX, startY, curX, curY);
  const els = collectIntersecting(box);
  if (els.length) runCapture(nestAsForest(els), box);
}

function swallowClick(e: Event) {
  if (!active) return;
  e.preventDefault();
  e.stopPropagation();
  if (ui?.hint.contains(e.target as Node)) deactivate();
}

function onKeydown(e: KeyboardEvent) {
  if (e.code === "KeyI" && e.altKey && e.shiftKey) {
    e.preventDefault();
    if (active) deactivate();
    else activate();
  } else if (e.key === "Escape" && active) {
    deactivate();
  }
}

// ---------- activate / deactivate ----------

function activate() {
  if (active) return;
  active = true;
  ui = buildUi();
  styleEl = document.createElement("style");
  styleEl.setAttribute(UI_MARKER, "1");
  styleEl.textContent = "* { cursor: crosshair !important; }";
  document.documentElement.appendChild(styleEl);
  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("click", swallowClick, true);
}

function deactivate() {
  if (!active) return;
  active = false;
  dragging = false;
  document.removeEventListener("mousedown", onMouseDown, true);
  document.removeEventListener("mousemove", onMouseMove, true);
  document.removeEventListener("mouseup", onMouseUp, true);
  document.removeEventListener("click", swallowClick, true);
  ui?.root.remove();
  styleEl?.remove();
  ui = null;
  styleEl = null;
}

// ---------- init ----------

/**
 * Wire the capture module into the content script. `registerInvalidated` lets
 * the caller pass the WXT ContentScriptContext's hook so a page reload /
 * script re-injection can never leak a stale active state.
 */
export function initInspectorCapture(
  registerInvalidated?: (cb: () => void) => void,
) {
  registerInvalidated?.(() => {
    document.removeEventListener("keydown", onKeydown, true);
    deactivate();
  });

  document.addEventListener("keydown", onKeydown, true);

  browser.runtime.onMessage.addListener((msg: unknown) => {
    if (
      msg &&
      typeof msg === "object" &&
      (msg as { type?: unknown }).type === TOGGLE_INSPECTOR_CAPTURE
    ) {
      if (active) deactivate();
      else activate();
      return { ok: true, active };
    }
  });
}

/**
 * Popup-side helper: toggle capture mode on the given tab. Resolves with the
 * resulting active state; rejects when the tab has no content script (e.g. a
 * chrome:// page the script cannot inject into).
 */
export async function toggleInspectorCaptureOnTab(
  tabId: number,
): Promise<{ ok: boolean; active: boolean }> {
  return chrome.tabs.sendMessage(tabId, { type: TOGGLE_INSPECTOR_CAPTURE });
}
