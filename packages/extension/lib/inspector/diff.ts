import type { ElementDescription, InspectorCapturePayload } from "./types";

/**
 * Structural + computed-style comparison of two element captures.
 *
 * The trees are aligned with a greedy same-tag matcher (order-preserving,
 * matching each A node to the first unused B node with the same tag), which
 * handles the common "same component, different state" captures well: nodes
 * move or get inserted between captures but siblings of the same kind stay in
 * order. Unmatched nodes surface as `only-a` / `only-b`.
 *
 * Styles are compared on the full computed map (`fullStyles`, falling back to
 * the trimmed `styles` for pre-snapshot payloads), so every property change —
 * inherited values included — shows up.
 */

/** One CSS property that differs between the two captures. */
export interface StyleChange {
  prop: string;
  /** Value in A; undefined when the property is absent there. */
  a?: string;
  /** Value in B; undefined when the property is absent there. */
  b?: string;
}

export interface PseudoChange {
  pseudo: "before" | "after";
  changes: StyleChange[];
}

/** Comparison result for one node (or a node that exists on one side only). */
export interface NodeDiff {
  /** CSS-selector-like trace from the forest root to this node. */
  path: string;
  tag: string;
  kind: "changed" | "only-a" | "only-b";
  styleChanges: StyleChange[];
  pseudoChanges: PseudoChange[];
  textChange?: { a?: string; b?: string };
  /**
   * Structural index paths (child positions from the forest root) for the
   * rebuilt DOM in the A / B preview panes — used by the diff view to
   * highlight the corresponding node on hover. Null when the node doesn't
   * exist on that side.
   */
  aIdx: number[] | null;
  bIdx: number[] | null;
}

export interface PayloadDiff {
  nodes: NodeDiff[];
  /** True when the two captures are visually identical. */
  identical: boolean;
}

export function diffPayloads(
  a: InspectorCapturePayload,
  b: InspectorCapturePayload,
): PayloadDiff {
  const nodes: NodeDiff[] = [];
  alignChildren(a.elements, b.elements, "", [], [], nodes);
  return { nodes, identical: nodes.length === 0 };
}

/** Short selector-ish label: `tag#id.class1.class2`. */
function label(e: ElementDescription): string {
  let s = e.tag;
  if (e.id) s += `#${e.id}`;
  for (const c of e.classes ?? []) s += `.${c}`;
  return s;
}

function alignChildren(
  aList: ElementDescription[],
  bList: ElementDescription[],
  parentPath: string,
  parentAIdx: number[],
  parentBIdx: number[],
  out: NodeDiff[],
): void {
  // Tag-count for nth disambiguation: only decorate the path when a tag
  // actually repeats among the (matched) siblings — `div > span:nth(2)` reads
  // worse than `div > span` when there's only one span.
  const aTags = new Map<string, number>();
  for (const a of aList) aTags.set(a.tag, (aTags.get(a.tag) ?? 0) + 1);

  const usedB = new Set<number>();
  // Pair each A node with the first unused same-tag B node (greedy,
  // order-preserving). Map from A-list index to B-list index.
  const pairOf = new Map<number, number>();
  for (const [i, a] of aList.entries()) {
    const idx = bList.findIndex((b, j) => !usedB.has(j) && b.tag === a.tag);
    if (idx === -1) continue;
    usedB.add(idx);
    pairOf.set(i, idx);
  }

  // Sequential occurrence counter per tag, so paths stay unique and stable.
  const seen = new Map<string, number>();
  for (const [i, a] of aList.entries()) {
    const n = (seen.get(a.tag) ?? 0) + 1;
    seen.set(a.tag, n);
    const repeated = (aTags.get(a.tag) ?? 0) > 1;
    const path = joinPath(
      parentPath,
      label(a) + (repeated ? `:nth(${n})` : ""),
    );
    const aIdx = [...parentAIdx, i];
    const j = pairOf.get(i);
    if (j === undefined) {
      // Unmatched A node: its whole subtree is absent from B, and the
      // matcher never descends into it. The subtree's full text is still
      // carried so the copied report states what disappeared (the diff view
      // itself reveals these via the pane hover spotlight, not the card).
      const text = a.textFull ?? a.text ?? "";
      out.push({
        path,
        tag: a.tag,
        kind: "only-a",
        styleChanges: [],
        pseudoChanges: [],
        textChange: text ? { a: text } : undefined,
        aIdx,
        bIdx: null,
      });
      continue;
    }
    const b = bList[j];
    if (!b) continue;
    const bIdx = [...parentBIdx, j];
    const node = compareNodes(a, b, path, aIdx, bIdx);
    if (node) out.push(node);
    // Recurse regardless: a subtree can differ even when this node matches.
    alignChildren(a.children ?? [], b.children ?? [], path, aIdx, bIdx, out);
  }
  for (const [i, b] of bList.entries()) {
    if (usedB.has(i)) continue;
    // Mirror of the only-a case above: the B-only subtree's full text
    // (report payload).
    const text = b.textFull ?? b.text ?? "";
    out.push({
      path: joinPath(parentPath, label(b)),
      tag: b.tag,
      kind: "only-b",
      styleChanges: [],
      pseudoChanges: [],
      textChange: text ? { b: text } : undefined,
      aIdx: null,
      bIdx: [...parentBIdx, i],
    });
  }
}

function joinPath(parent: string, child: string): string {
  return parent ? `${parent} > ${child}` : child;
}

/** Full node comparison; returns undefined when nothing differs. */
function compareNodes(
  a: ElementDescription,
  b: ElementDescription,
  path: string,
  aIdx: number[],
  bIdx: number[],
): NodeDiff | undefined {
  const styleChanges = compareMaps(
    a.fullStyles ?? a.styles ?? {},
    b.fullStyles ?? b.styles ?? {},
  );
  const pseudoChanges: PseudoChange[] = [];
  for (const which of ["before", "after"] as const) {
    const changes = compareMaps(
      a.pseudo?.[which] ?? {},
      b.pseudo?.[which] ?? {},
    );
    if (changes.length) pseudoChanges.push({ pseudo: which, changes });
  }
  const textA = a.textFull ?? a.text ?? "";
  const textB = b.textFull ?? b.text ?? "";
  const textChange = textA !== textB ? { a: textA, b: textB } : undefined;

  if (!styleChanges.length && !pseudoChanges.length && !textChange) {
    return undefined;
  }

  return {
    path,
    tag: a.tag,
    kind: "changed",
    styleChanges,
    pseudoChanges,
    textChange,
    aIdx,
    bIdx,
  };
}

function compareMaps(
  a: Record<string, string>,
  b: Record<string, string>,
): StyleChange[] {
  const out: StyleChange[] = [];
  const props = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const prop of props) {
    const va = a[prop];
    const vb = b[prop];
    if (va === vb) continue;
    out.push(va === undefined ? { prop, b: vb } : { prop, a: va, b: vb });
  }
  return out;
}

/**
 * Render a diff as a compact, agent-friendly report (also the copy target of
 * the diff view toolbar).
 */
export function formatDiffReport(
  a: InspectorCapturePayload,
  b: InspectorCapturePayload,
  diff: PayloadDiff,
): string {
  const head = [
    "Element diff",
    `A: ${a.page.title} — ${a.capturedAt} — ${a.page.url}`,
    `B: ${b.page.title} — ${b.capturedAt} — ${b.page.url}`,
    "",
  ];
  if (diff.identical) {
    return [...head, "No differences found."].join("\n");
  }
  const lines: string[] = head;
  for (const node of diff.nodes) {
    lines.push(`[${node.kind}] ${node.path}`);
    for (const c of node.styleChanges) {
      if (c.a === undefined) lines.push(`  + ${c.prop}: ${c.b}`);
      else if (c.b === undefined) lines.push(`  - ${c.prop}: ${c.a}`);
      else lines.push(`  ${c.prop}: ${c.a} → ${c.b}`);
    }
    for (const p of node.pseudoChanges) {
      lines.push(`  ::${p.pseudo}`);
      for (const c of p.changes) {
        if (c.a === undefined) lines.push(`    + ${c.prop}: ${c.b}`);
        else if (c.b === undefined) lines.push(`    - ${c.prop}: ${c.a}`);
        else lines.push(`    ${c.prop}: ${c.a} → ${c.b}`);
      }
    }
    if (node.textChange) {
      if (node.textChange.a === undefined) {
        lines.push(`  + text: ${JSON.stringify(node.textChange.b)}`);
      } else if (node.textChange.b === undefined) {
        lines.push(`  - text: ${JSON.stringify(node.textChange.a)}`);
      } else {
        lines.push(
          `  text: ${JSON.stringify(node.textChange.a)} → ${JSON.stringify(node.textChange.b)}`,
        );
      }
    }
  }
  return lines.join("\n");
}
