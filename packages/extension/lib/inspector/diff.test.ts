import { describe, it, expect } from 'vitest';
import { diffPayloads, formatDiffReport } from './diff';
import type { ElementDescription, InspectorCapturePayload } from './types';

function element(partial: Partial<ElementDescription> = {}): ElementDescription {
  return {
    tag: 'div',
    rect: { x: 0, y: 0, w: 10, h: 10 },
    ...partial,
  };
}

function payload(elements: ElementDescription[], title = 'Page A'): InspectorCapturePayload {
  return {
    type: 'inspector-capture',
    page: { url: 'https://a.com', title },
    capturedAt: '2026-01-01T00:00:00Z',
    selection: 'click',
    elementCount: elements.length,
    elements,
  };
}

describe('diffPayloads', () => {
  it('reports identical for equal trees', () => {
    const p = payload([element({ tag: 'button', text: 'ok' })]);
    const d = diffPayloads(p, payload([element({ tag: 'button', text: 'ok' })], 'Page B'));
    expect(d.identical).toBe(true);
    expect(d.nodes).toHaveLength(0);
  });

  it('detects style changes (including property added/removed)', () => {
    const a = payload([element({ styles: { color: 'red', margin: '0' } })]);
    const b = payload([element({ styles: { color: 'blue', padding: '1px' } })]);
    const d = diffPayloads(a, b);
    expect(d.identical).toBe(false);
    const node = d.nodes[0]!;
    expect(node.kind).toBe('changed');
    expect(node.styleChanges).toContainEqual({ prop: 'color', a: 'red', b: 'blue' });
    expect(node.styleChanges).toContainEqual({ prop: 'margin', a: '0' }); // removed in B
    expect(node.styleChanges).toContainEqual({ prop: 'padding', b: '1px' }); // added in B
  });

  it('detects text changes with both sides', () => {
    const d = diffPayloads(
      payload([element({ text: 'Save' })]),
      payload([element({ text: 'Saved' })]),
    );
    expect(d.nodes[0]!.textChange).toEqual({ a: 'Save', b: 'Saved' });
  });

  it('detects pseudo-element changes', () => {
    const d = diffPayloads(
      payload([element({ pseudo: { before: { content: '"•"' } } })]),
      payload([element({ pseudo: { before: { content: '"–"' } } })]),
    );
    expect(d.nodes[0]!.pseudoChanges).toEqual([
      { pseudo: 'before', changes: [{ prop: 'content', a: '"•"', b: '"–"' }] },
    ]);
  });

  it('reports an A-only node as only-a (no descent into it)', () => {
    const d = diffPayloads(
      payload([element({ tag: 'h1' }), element({ tag: 'p', text: 'gone' })]),
      payload([element({ tag: 'h1' })]),
    );
    expect(d.nodes).toHaveLength(1);
    expect(d.nodes[0]).toMatchObject({ kind: 'only-a', tag: 'p', textChange: { a: 'gone' } });
    expect(d.nodes[0]!.bIdx).toBeNull();
  });

  it('reports a B-only node as only-b', () => {
    const d = diffPayloads(
      payload([element({ tag: 'h1' })]),
      payload([element({ tag: 'h1' }), element({ tag: 'p', text: 'new' })]),
    );
    expect(d.nodes).toHaveLength(1);
    expect(d.nodes[0]).toMatchObject({ kind: 'only-b', tag: 'p', textChange: { b: 'new' } });
    expect(d.nodes[0]!.aIdx).toBeNull();
  });

  it('greedily pairs same-tag siblings in order and recurses into matched nodes', () => {
    const d = diffPayloads(
      payload([
        element({ tag: 'li', text: 'one' }),
        element({ tag: 'li', text: 'two' }),
      ]),
      payload([
        element({ tag: 'li', text: 'ONE' }),
        element({ tag: 'li', text: 'two' }),
      ]),
    );
    // First li changed, second identical; nth-suffix because the tag repeats.
    expect(d.nodes).toHaveLength(1);
    expect(d.nodes[0]).toMatchObject({ kind: 'changed', path: 'li:nth(1)' });
  });

  it('does not pair across different tags', () => {
    const d = diffPayloads(
      payload([element({ tag: 'span' })]),
      payload([element({ tag: 'b' })]),
    );
    expect(d.nodes.map((n) => n.kind)).toEqual(['only-a', 'only-b']);
  });

  it('decorates nth only when the tag actually repeats', () => {
    const d = diffPayloads(
      payload([element({ tag: 'span' }), element({ tag: 'p' })]),
      payload([element({ tag: 'span', styles: { color: 'red' } }), element({ tag: 'p' })]),
    );
    expect(d.nodes[0]!.path).toBe('span');
  });

  it('compares fullStyles when present, falling back to styles', () => {
    const d = diffPayloads(
      payload([element({ styles: { color: 'red' }, fullStyles: { color: 'red', display: 'block' } })]),
      payload([element({ styles: { color: 'red' }, fullStyles: { color: 'red', display: 'flex' } })]),
    );
    expect(d.nodes[0]!.styleChanges).toEqual([{ prop: 'display', a: 'block', b: 'flex' }]);
  });

  it('finds deep changes nested in matched subtrees with a joined path', () => {
    const d = diffPayloads(
      payload([element({ tag: 'nav', children: [element({ tag: 'a', text: 'Home' })] })]),
      payload([element({ tag: 'nav', children: [element({ tag: 'a', text: 'Away' })] })]),
    );
    expect(d.nodes[0]).toMatchObject({ kind: 'changed', path: 'nav > a' });
    expect(d.nodes[0]!.aIdx).toEqual([0, 0]);
    expect(d.nodes[0]!.bIdx).toEqual([0, 0]);
  });

  it('reports id/class in the node path label', () => {
    const d = diffPayloads(
      payload([element({ id: 'x', classes: ['a', 'b'], text: '1' })]),
      payload([element({ id: 'x', classes: ['a', 'b'], text: '2' })]),
    );
    expect(d.nodes[0]!.path).toBe('div#x.a.b');
  });
});

describe('formatDiffReport', () => {
  it('renders a header and no differences when identical', () => {
    const p = payload([element({ tag: 'b' })]);
    const report = formatDiffReport(p, p, diffPayloads(p, p));
    expect(report).toContain('Element diff');
    expect(report).toContain('No differences found.');
  });

  it('renders style/text/pseudo changes with + / - / → markers', () => {
    const a = payload([element({ styles: { color: 'red', margin: '0' } })], 'A');
    const b = payload([element({ styles: { color: 'blue', padding: '1px' }, pseudo: { after: { content: '"!"' } }, text: 'hi' })], 'B');
    const report = formatDiffReport(a, b, diffPayloads(a, b));
    expect(report).toContain('[changed] div');
    expect(report).toContain('color: red → blue');
    expect(report).toContain('- margin: 0');
    expect(report).toContain('+ padding: 1px');
    expect(report).toContain('::after');
    expect(report).toContain('+ content: "!"');
    expect(report).toContain('text: "" → "hi"');
  });

  it('renders only-a removals with the disappeared text', () => {
    const a = payload([element({ tag: 'p', text: 'gone' })]);
    const b = payload([]);
    const report = formatDiffReport(a, b, diffPayloads(a, b));
    expect(report).toContain('[only-a] p');
    expect(report).toContain('- text: "gone"');
  });
});
