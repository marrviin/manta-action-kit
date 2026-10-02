import { describe, it, expect } from 'vitest';
import { leanElement, leanInspectorPayload } from './lean';
import type { ElementDescription, InspectorCapturePayload } from './types';

function element(partial: Partial<ElementDescription> = {}): ElementDescription {
  return {
    tag: 'div',
    rect: { x: 0, y: 0, w: 10, h: 10 },
    text: 'hello',
    textFull: 'hello full text that is long',
    fullStyles: { color: 'rgb(0, 0, 0)', display: 'block' },
    pseudo: { before: { content: '"•"' } },
    ...partial,
  };
}

describe('leanElement', () => {
  it('strips fullStyles, pseudo and textFull, keeps the rest', () => {
    const lean = leanElement(element({ id: 'root', styles: { color: 'rgb(0, 0, 0)' } }));
    expect(lean).toEqual({
      tag: 'div',
      id: 'root',
      rect: { x: 0, y: 0, w: 10, h: 10 },
      text: 'hello',
      styles: { color: 'rgb(0, 0, 0)' },
    });
  });

  it('recurses into children', () => {
    const lean = leanElement(element({ children: [element({ tag: 'span' })] }));
    expect(lean.children).toHaveLength(1);
    expect(lean.children![0]).not.toHaveProperty('fullStyles');
    expect(lean.children![0]).not.toHaveProperty('pseudo');
    expect(lean.children![0]!.tag).toBe('span');
  });

  it('does not mutate the input element', () => {
    const e = element({ children: [element()] });
    leanElement(e);
    expect(e.fullStyles).toBeDefined();
    expect(e.pseudo).toBeDefined();
    expect(e.children![0]!.fullStyles).toBeDefined();
  });

  it('handles elements without the bulk fields', () => {
    expect(leanElement({ tag: 'p', rect: { x: 0, y: 0, w: 1, h: 1 } })).toEqual({
      tag: 'p',
      rect: { x: 0, y: 0, w: 1, h: 1 },
    });
  });
});

describe('leanInspectorPayload', () => {
  it('leans every root element and preserves payload metadata', () => {
    const payload: InspectorCapturePayload = {
      type: 'inspector-capture',
      page: { url: 'https://a.com', title: 'Page' },
      capturedAt: '2026-01-01T00:00:00Z',
      selection: 'click',
      elementCount: 1,
      elements: [element()],
    };
    const lean = leanInspectorPayload(payload);
    expect(lean.page).toBe(payload.page);
    expect(lean.capturedAt).toBe(payload.capturedAt);
    expect(lean.elements[0]).not.toHaveProperty('fullStyles');
  });
});
