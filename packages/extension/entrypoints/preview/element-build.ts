import type {
  ElementDescription,
  InspectorCapturePayload,
} from "@/lib/inspector/types";

/**
 * Shared DOM-rebuild helpers for the element preview (?mode=element) and the
 * comparison view (?mode=diff): both rebuild captured element forests inside
 * Shadow DOMs, so the building rules (full computed styles inlined node by
 * node, pseudo rules re-attached via generated `[data-pe]` selectors) must not
 * drift apart.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** Pseudo-element rules accumulated while the DOM forest is rebuilt. */
export interface BuildContext {
  rules: string[];
}

/**
 * Rebuild the DOM forest. Real `createElement`/`setAttribute` calls (not
 * innerHTML) — the payload is untrusted page data, and attrs like `src` must
 * never smuggle markup in.
 */
export function buildDom(elements: ElementDescription[]): {
  root: HTMLElement;
  pseudoCss: string;
} {
  const ctx: BuildContext = { rules: [] };
  const wrapper = document.createElement("div");
  // `all: initial` in the reset makes the unwrapped wrapper inline — restore
  // block so the forest lays out as a plain container.
  wrapper.style.display = "block";
  elements.forEach((desc, i) =>
    wrapper.append(buildNode(desc, false, ctx, [i])),
  );
  return { root: wrapper, pseudoCss: ctx.rules.join("\n") };
}

function buildNode(
  desc: ElementDescription,
  svg: boolean,
  ctx: BuildContext,
  idx: number[],
): HTMLElement {
  const inSvg = svg || desc.tag === "svg";
  const el = inSvg
    ? document.createElementNS(SVG_NS, desc.tag)
    : document.createElement(desc.tag);
  if (desc.id) el.id = desc.id;
  if (desc.classes?.length) el.setAttribute("class", desc.classes.join(" "));
  // Structural index path (child positions from the forest root): the diff
  // view uses it to find this node inside the shadow root on hover.
  el.setAttribute("data-ip", idx.join("/"));
  for (const [name, value] of Object.entries(desc.attrs ?? {})) {
    try {
      el.setAttribute(name, value);
    } catch {
      /* invalid attribute name in hand-built JSON: skip */
    }
  }
  const style = el.style;
  // Preview fidelity path: inline the full computed-style map recorded on the
  // page. Older payloads without `fullStyles` fall back to the trimmed
  // `styles` and lean on the reset stylesheet below.
  const styleMap = desc.fullStyles ?? desc.styles ?? {};
  for (const [name, value] of Object.entries(styleMap)) {
    try {
      style.setProperty(name, value);
    } catch {
      /* unknown property: skip */
    }
  }
  for (const [name, value] of Object.entries(desc.cssVars ?? {})) {
    style.setProperty(name, value);
  }
  // Pseudo-elements can't be inlined — tag the node and emit matching
  // `[data-pe]::before/::after` rules so decorations survive the rebuild.
  if (desc.pseudo) {
    const idx = ctx.rules.length;
    el.setAttribute("data-pe", String(idx));
    for (const which of ["before", "after"] as const) {
      const props = desc.pseudo[which];
      if (!props) continue;
      const body = Object.entries(props)
        .map(([k, v]) => `${k}: ${v};`)
        .join(" ");
      ctx.rules.push(`[data-pe="${idx}"]::${which} { ${body} }`);
    }
  }
  const text = desc.textFull ?? desc.text;
  if (text) el.append(document.createTextNode(text));
  (desc.children ?? []).forEach((child, ci) =>
    el.append(buildNode(child, inSvg, ctx, [...idx, ci])),
  );
  return el as HTMLElement;
}

/**
 * Lean copy of the payload for the "Copy JSON" entry point — the full
 * snapshot (fullStyles / pseudo / textFull) is preview-only, so strip it the
 * same way the capture side does before writing to the clipboard.
 */
export function leanPayload(
  p: InspectorCapturePayload,
): InspectorCapturePayload {
  const strip = (e: ElementDescription): ElementDescription => {
    const out: ElementDescription = { ...e };
    delete out.fullStyles;
    delete out.pseudo;
    delete out.textFull;
    if (out.children) out.children = out.children.map(strip);
    return out;
  };
  return { ...p, elements: p.elements.map(strip) };
}

/**
 * Fallback baseline for payloads without `fullStyles` and safety net for
 * anything the inline styles don't cover. Scoped to the shadow root — the
 * page's own styles are untouched. A fresh element each call: a style node
 * can only live in one shadow root.
 */
export function createResetStyle(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    style { display: none !important; }
    * {
      all: initial;
      margin: 0;
      padding: 0;
      border: 0 none rgb(0, 0, 0);
      border-radius: 0;
      box-shadow: none;
      box-sizing: content-box;
      position: static;
      inset: auto;
      z-index: auto;
      flex: 0 1 auto;
      flex-wrap: nowrap;
      justify-content: normal;
      align-items: normal;
      align-self: auto;
      gap: normal;
      grid-template-columns: none;
      grid-template-rows: none;
      grid-area: auto;
      overflow: visible;
      opacity: 1;
      transform: none;
      text-align: start;
      text-transform: none;
      white-space: normal;
      font-weight: 400;
      line-height: normal;
      letter-spacing: normal;
      background-color: rgba(0, 0, 0, 0);
      background-image: none;
      cursor: auto;
    }
  `;
  return style;
}

/**
 * Display width for the host wrapper: the capture-time width of the first
 * root element (the rect the user actually saw), or auto for a forest with no
 * single obvious root.
 */
export function rootWidth(elements: ElementDescription[]): string | undefined {
  const first = elements[0];
  if (elements.length === 1 && first && first.rect.w > 0) {
    return `${first.rect.w}px`;
  }
  return undefined;
}
