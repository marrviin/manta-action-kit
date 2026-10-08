/**
 * Tests for the pure user-interaction descriptor builder (interaction.ts).
 * Uses structural ElementLike fakes — no DOM, matching the node vitest env.
 */
import { describe, expect, it } from 'vitest';
import {
  attachPrecedingInteractions,
  describeInteraction,
  extractContainers,
  extractText,
  redactText,
  truncate,
  type ElementLike,
} from './interaction';
import { REDACTION_MASK, isSensitiveValue } from './redact';
import type { CapturedInteraction, PrecedingInteraction } from './types';

const el = (overrides: Partial<ElementLike> = {}): ElementLike => ({
  tagName: 'BUTTON',
  textContent: 'load',
  ...overrides,
});

const PAGE = { path: '/orders', title: 'Orders' };

function interaction(
  kind: CapturedInteraction['kind'],
  at: number,
  text: string | undefined,
): CapturedInteraction {
  return { kind, at, ...(text ? { text } : {}), page: { path: '/' } };
}

describe('truncate', () => {
  it('trims, collapses internal whitespace, and caps length', () => {
    expect(truncate('  a   b\t\nc  ', 10)).toBe('a b c');
    expect(truncate('abcdefghij', 4)).toBe('abcd');
  });
});

describe('redactText', () => {
  it('passes clean text through, capped', () => {
    expect(redactText('导出报表', 64)).toBe('导出报表');
  });

  it('masks values that look like credentials/PII', () => {
    expect(redactText('user@example.com', 64)).toBe(REDACTION_MASK);
    expect(redactText('aaaaaa.bbbbbb.cccccc', 64)).toBe(REDACTION_MASK); // JWT-shaped
    expect(isSensitiveValue('0123456789abcdef01234567')).toBe(true); // 24-hex
  });

  it('returns undefined for empty text', () => {
    expect(redactText('   ', 64)).toBeUndefined();
  });
});

describe('extractText', () => {
  it('prefers aria-label over visible text', () => {
    expect(extractText(el({ ariaLabel: 'Close dialog', textContent: 'X' }))).toBe(
      'Close dialog',
    );
  });

  it('falls back to textContent and yields undefined when empty', () => {
    expect(extractText(el({ textContent: '  Save  ' }))).toBe('Save');
    expect(extractText(el({ textContent: '', ariaLabel: undefined }))).toBeUndefined();
  });
});

describe('extractContainers', () => {
  it('collects short ancestor texts, closest first, capped at 3', () => {
    const a = el({ tagName: 'DIV', textContent: '订单详情' });
    const b = el({ tagName: 'DIV', ariaLabel: 'Order panel' });
    const c = el({ tagName: 'MAIN', textContent: '管理后台' });
    const target = el({ textContent: '确认' });
    expect(extractContainers(target, [a, b, c, el({ textContent: 'x' })])).toEqual([
      '订单详情',
      'Order panel',
      '管理后台',
    ]);
  });

  it('skips ancestors repeating the element text and giant subtree texts', () => {
    const target = el({ textContent: '确认' });
    const dup = el({ tagName: 'DIV', textContent: '确认' });
    const giant = el({ tagName: 'DIV', textContent: 'x'.repeat(500) });
    const ok = el({ tagName: 'DIALOG', ariaLabel: '删除订单' });
    expect(extractContainers(target, [dup, giant, ok])).toEqual(['删除订单']);
  });
});

describe('describeInteraction', () => {
  it('returns null for document-level targets', () => {
    for (const tag of ['HTML', 'BODY', '']) {
      expect(describeInteraction('click', el({ tagName: tag }), [], 1, PAGE)).toBeNull();
    }
    expect(describeInteraction('click', null, [], 1, PAGE)).toBeNull();
  });

  it('returns null when there is nothing to describe', () => {
    expect(
      describeInteraction('click', el({ textContent: '', ariaLabel: undefined }), [], 1, PAGE),
    ).toBeNull();
  });

  it('never captures password or credit-card autofill controls', () => {
    expect(
      describeInteraction(
        'change',
        el({
          tagName: 'INPUT',
          type: 'password',
          textContent: '',
          value: 'hunter2',
          name: 'pw',
        }),
        [],
        1,
        PAGE,
      ),
    ).toBeNull();
    expect(
      describeInteraction(
        'change',
        el({
          tagName: 'INPUT',
          type: 'text',
          textContent: '',
          value: '4111111111111111',
          name: 'card',
          autocomplete: 'cc-number',
        }),
        [],
        1,
        PAGE,
      ),
    ).toBeNull();
  });

  it('describes a click with text, containers, and page snapshot', () => {
    const d = describeInteraction(
      'click',
      el({ textContent: '确认' }),
      [el({ tagName: 'DIALOG', ariaLabel: '删除订单' })],
      1234,
      PAGE,
    );
    expect(d).toEqual({
      kind: 'click',
      at: 1234,
      text: '确认',
      containers: ['删除订单'],
      page: PAGE,
    });
  });

  it('describes a value-only change (unnamed, unlabeled control)', () => {
    const d = describeInteraction(
      'change',
      el({ tagName: 'INPUT', type: 'text', textContent: '', value: 'hello' }),
      [],
      5,
      PAGE,
    );
    expect(d).toEqual({ kind: 'change', at: 5, value: 'hello', page: PAGE });
  });

  it('masks verification-code-shaped values regardless of the control name', () => {
    // SMS/email OTPs: 4-8 pure digits, usually in an unnamed control.
    for (const code of ['791469', '1234', '12345678']) {
      const d = describeInteraction(
        'change',
        el({ tagName: 'INPUT', type: 'text', textContent: '', value: code }),
        [],
        5,
        PAGE,
      );
      expect(d).toMatchObject({ value: REDACTION_MASK });
    }
    // Longer digit runs (phone numbers, ids) and short quantities stay visible.
    const phone = describeInteraction(
      'change',
      el({ tagName: 'INPUT', type: 'text', textContent: '', value: '13800001234' }),
      [],
      5,
      PAGE,
    );
    expect(phone).toMatchObject({ value: '13800001234' });
    const qty = describeInteraction(
      'change',
      el({ tagName: 'INPUT', type: 'text', textContent: '', value: '3' }),
      [],
      5,
      PAGE,
    );
    expect(qty).toMatchObject({ value: '3' });
  });

  it('describes a change with name/value and masks sensitive names/values', () => {
    const d = describeInteraction(
      'change',
      el({
        tagName: 'INPUT',
        type: 'text',
        textContent: '',
        name: 'q',
        value: 'hello world',
      }),
      [],
      5,
      PAGE,
    );
    expect(d).toMatchObject({ kind: 'change', name: 'q', value: 'hello world' });

    const token = describeInteraction(
      'change',
      el({ tagName: 'INPUT', type: 'text', textContent: '', name: 'token', value: 'abc' }),
      [],
      5,
      PAGE,
    );
    expect(token).toMatchObject({ name: 'token', value: REDACTION_MASK });

    const pii = describeInteraction(
      'change',
      el({ tagName: 'INPUT', type: 'text', textContent: '', name: 'contact', value: 'a@b.co' }),
      [],
      5,
      PAGE,
    );
    expect(pii).toMatchObject({ value: REDACTION_MASK });
  });
});

describe('attachPrecedingInteractions', () => {
  it('attaches the nearest interaction within the window and skips out-of-window ones', () => {
    const calls = [
      { startedAt: 10_400 },
      { startedAt: 15_100 },
    ] as Array<{ startedAt: number; precedingInteraction?: PrecedingInteraction | undefined }>;
    const ints: CapturedInteraction[] = [
      interaction('click', 10_000, 'load'),
      interaction('change', 16_000, undefined),
    ];
    attachPrecedingInteractions(calls, ints);
    expect(calls[0]!.precedingInteraction).toEqual({
      kind: 'click',
      text: 'load',
      deltaMs: 400,
    });
    // 15_100 is past the 5s default window from the click (next one is after it).
    expect(calls[1]!.precedingInteraction).toBeUndefined();
  });

  it('covers the post-navigation call burst with the 5s default window', () => {
    // A navigation click routinely settles into page-load calls 2–3s later;
    // the old 2s window stripped the hint from exactly those calls.
    const calls = [{ startedAt: 12_116 }] as Array<{
      startedAt: number;
      precedingInteraction?: PrecedingInteraction | undefined;
    }>;
    attachPrecedingInteractions(calls, [interaction('click', 10_000, '管理')]);
    expect(calls[0]!.precedingInteraction).toMatchObject({ text: '管理', deltaMs: 2116 });
  });

  it('handles unsorted interaction input and a delta exactly at the window edge', () => {
    const calls = [{ startedAt: 3000 }] as Array<{
      startedAt: number;
      precedingInteraction?: PrecedingInteraction | undefined;
    }>;
    const ints: CapturedInteraction[] = [
      interaction('click', 5000, 'later'), // after the call — ignored
      interaction('click', 1000, 'exactly-2s'), // exactly at the window edge
    ];
    attachPrecedingInteractions(calls, ints);
    expect(calls[0]!.precedingInteraction).toMatchObject({
      text: 'exactly-2s',
      deltaMs: 2000,
    });
  });

  it('leaves calls untouched when there are no interactions', () => {
    const calls = [{ startedAt: 100 }] as Array<{
      startedAt: number;
      precedingInteraction?: PrecedingInteraction | undefined;
    }>;
    attachPrecedingInteractions(calls, []);
    expect(calls[0]!.precedingInteraction).toBeUndefined();
  });

  it('caps attachments per interaction at the first maxPerInteraction calls', () => {
    // One interaction, 8 calls inside the window — only the chronologically
    // first 5 carry the mark; the burst tail keeps none (a missing hint beats
    // a misleading one).
    const calls = Array.from({ length: 8 }, (_, i) => ({
      startedAt: 1000 + i * 100,
    })) as Array<{ startedAt: number; precedingInteraction?: PrecedingInteraction | undefined }>;
    attachPrecedingInteractions(calls, [interaction('click', 900, 'go')]);
    expect(calls.filter((c) => c.precedingInteraction)).toHaveLength(5);
    expect(calls[4]!.precedingInteraction).toMatchObject({ text: 'go', deltaMs: 500 });
    for (const c of calls.slice(5)) {
      expect(c.precedingInteraction).toBeUndefined();
    }
  });

  it('counts the cap in chronological order even for unsorted call input', () => {
    const calls = [
      { startedAt: 1400 },
      { startedAt: 1100 },
      { startedAt: 1600 },
    ] as Array<{ startedAt: number; precedingInteraction?: PrecedingInteraction | undefined }>;
    attachPrecedingInteractions(calls, [interaction('click', 1000, 'go')], 2000, 2);
    expect(calls[1]!.precedingInteraction).toMatchObject({ deltaMs: 100 }); // 1100, first
    expect(calls[0]!.precedingInteraction).toMatchObject({ deltaMs: 400 }); // 1400, second
    expect(calls[2]!.precedingInteraction).toBeUndefined(); // 1600, over the cap
  });
});