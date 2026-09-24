import type { ElementDescription, InspectorCapturePayload } from "./types";

/**
 * Strip the preview-only bulk from one element: `fullStyles` (every resolved
 * property), `pseudo` decorations and the unclipped `textFull` make a payload
 * hundreds of KB; the lean form keeps the trimmed `styles` /
 * inheritance-reconstructable view. Shared by the content script (clipboard
 * JSON + agent copies stay lean) and the background (oversized captures
 * degrade to a lean preview instead of failing to open one at all).
 */
export function leanElement(e: ElementDescription): ElementDescription {
  const out: ElementDescription = { ...e };
  delete out.fullStyles;
  delete out.pseudo;
  delete out.textFull;
  if (out.children) out.children = out.children.map(leanElement);
  return out;
}

/** Whole-payload variant: the lean copy of every captured root element. */
export function leanInspectorPayload(
  payload: InspectorCapturePayload,
): InspectorCapturePayload {
  return { ...payload, elements: payload.elements.map(leanElement) };
}
