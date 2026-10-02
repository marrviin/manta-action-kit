import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  bpeEncode,
  metaspaceEncode,
  encodeWithData,
  parseTokenizerJson,
  loadTokenizerJson,
  METASPACE_REPLACEMENT,
  CHECKPOINT_IDS,
  type TokenizerData,
} from './tokenizer';

/** Tiny hand-built BPE table. Merges let multi-char pieces resolve to single
 * vocab entries: '▁ x' -> ▁x, '▁ y' -> ▁y, a z-run -> ▁zzz (not in vocab -> unk),
 * '\n \n' -> '\n\n'. */
function tinyData(): TokenizerData {
  const vocab = new Map<string, number>([
    ['a', 1], ['b', 2], ['c', 3], ['ab', 4], ['abc', 5],
    ['▁x', 11], ['▁y', 12], ['\n\n', 20],
    ['[UNK]', 99], ['<unk>', 98],
  ]);
  const merges = new Map<string, number>([
    ['a b', 0], ['ab c', 1],
    ['▁ x', 2], ['▁ y', 3],
    ['▁ z', 4], ['▁z z', 5], ['▁zz z', 6],
    ['\n \n', 7],
  ]);
  return {
    vocab, merges,
    ids: { cls: 50281, sep: 50282, mask: 50284, pad: 50283, unk: 98 },
    kind: 'metaspace',
    maskToken: '[MASK]',
    replaces: [[' ', METASPACE_REPLACEMENT]],
  };
}

describe('bpeEncode', () => {
  it('merges greedily by rank and maps unknown pieces to [UNK]', () => {
    const vocab = new Map([['a', 1], ['b', 2], ['ab', 3], ['[UNK]', 99]]);
    const merges = new Map([['a b', 0]]);
    // 'ab' merges into one token; 'z' is unknown.
    expect(bpeEncode(vocab, merges, 'abz')).toEqual([3, 99]);
  });

  it('applies merge ranks in order across a piece', () => {
    const d = tinyData();
    // 'abc' -> merge 'a b' (rank 0) -> 'ab c' (rank 1) -> 'abc' -> id 5.
    expect(bpeEncode(d.vocab, d.merges, 'abc')).toEqual([5]);
  });

  it('splits on GPT-2 boundaries (letters vs digits)', () => {
    const d = tinyData();
    expect(bpeEncode(d.vocab, d.merges, 'ab')).toEqual([4]);
    expect(bpeEncode(d.vocab, d.merges, 'aba')).toEqual([4, 1]);
  });

  it('returns [] for empty text', () => {
    expect(bpeEncode(tinyData().vocab, tinyData().merges, '')).toEqual([]);
  });
});

describe('metaspaceEncode', () => {
  it('prefixes each word with the metaspace marker', () => {
    const d = tinyData();
    expect(metaspaceEncode(d.vocab, d.merges, 'x y')).toEqual([11, 12]);
  });

  it('falls back to unk for out-of-vocab words', () => {
    const d = tinyData();
    expect(metaspaceEncode(d.vocab, d.merges, 'x zzz')).toEqual([11, 98]);
  });

  it('emits newline runs as their own pieces', () => {
    const d = tinyData();
    const ids = metaspaceEncode(d.vocab, d.merges, 'x\n\ny');
    // '▁x' = 11, the '\n\n' run merges to its own vocab entry = 20, '▁y' = 12.
    expect(ids).toEqual([11, 20, 12]);
  });

  it('applies custom normalizer Replace rules before tokenizing', () => {
    const d = tinyData();
    // Custom replaces REPLACE the default space rule entirely, so a full list
    // must re-state it: 'x x' -> 'y y' -> '▁y ▁y' -> two ▁y tokens.
    const ids = metaspaceEncode(d.vocab, d.merges, 'x x', 98, [
      ['x', 'y'],
      [' ', METASPACE_REPLACEMENT],
    ]);
    expect(ids).toEqual([12, 12]);
  });

  it('byte-fallback maps unknown pieces to <0xNN> UTF-8 byte tokens', () => {
    // Byte fallback is per BPE TOKEN: the marker '▁' is out of vocab -> unk,
    // the token 'A' expands to its UTF-8 bytes -> <0x41>.
    const vocab = new Map<string, number>([['<0x41>', 4]]);
    const ids = metaspaceEncode(vocab, new Map(), 'A', 98, [], true);
    expect(ids).toEqual([98, 4]);
  });

  it('returns [] for empty text', () => {
    expect(metaspaceEncode(tinyData().vocab, new Map(), '')).toEqual([]);
  });
});

describe('parseTokenizerJson', () => {
  const raw = {
    model: {
      vocab: { '[CLS]': 1, '[SEP]': 2, '[PAD]': 3, '[MASK]': 4, '[UNK]': 5, '▁hello': 6 },
      merges: ['a b', ['ab', 'c']],
      byte_fallback: true,
    },
    normalizer: { type: 'Sequence', normalizers: [{ type: 'Replace', pattern: { String: ' ' }, content: '▁' }] },
    pre_tokenizer: { type: 'Metaspace' },
    added_tokens: [
      { id: 1, content: '[CLS]', normalized: false },
      { id: 2, content: '[SEP]', normalized: false },
      { id: 3, content: '[PAD]', normalized: false },
      { id: 4, content: '[MASK]', normalized: false },
      { id: 5, content: '[UNK]', normalized: false },
    ],
  };

  it('extracts vocab, merges (both string and pair forms), ids and kind', () => {
    const d = parseTokenizerJson(raw);
    expect(d).not.toBeNull();
    expect(d!.kind).toBe('metaspace');
    expect(d!.ids).toEqual({ cls: 1, sep: 2, mask: 4, pad: 3, unk: 5 });
    expect(d!.maskToken).toBe('[MASK]');
    expect(d!.merges.get('a b')).toBe(0);
    expect(d!.merges.get('ab c')).toBe(1);
    expect(d!.byteFallback).toBe(true);
  });

  it('collects normalizer Replace rules and keeps them in order', () => {
    const d = parseTokenizerJson(raw)!;
    expect(d.replaces).toEqual([[' ', '▁']]);
  });

  it('defaults to a space->metaspace rule for metaspace tokenizers without one', () => {
    const d = parseTokenizerJson({ ...raw, normalizer: undefined })!;
    expect(d.replaces).toEqual([[' ', METASPACE_REPLACEMENT]]);
  });

  it('detects bytelevel when there is no Metaspace pre-tokenizer', () => {
    // Replace rules are collected regardless of kind; only the DEFAULT
    // space->metaspace rule is exclusive to metaspace tokenizers.
    const d = parseTokenizerJson({ ...raw, pre_tokenizer: { type: 'ByteLevel' } })!;
    expect(d.kind).toBe('bytelevel');
    expect(d.replaces).toEqual([[' ', '▁']]);
  });

  it('falls back to checkpoint ids when specials are absent', () => {
    const d = parseTokenizerJson({ model: { vocab: { a: 1 } } })!;
    expect(d.ids).toEqual({ ...CHECKPOINT_IDS });
  });

  it('returns null for garbage input instead of throwing', () => {
    expect(parseTokenizerJson(null)).toBeNull();
    expect(parseTokenizerJson({})).toBeNull();
    expect(parseTokenizerJson({ model: {} })).toBeNull();
  });
});

describe('encodeWithData', () => {
  it('cuts added tokens out and emits their ids before encoding the rest', () => {
    const d = tinyData();
    d.added = [{ content: '[CLS]', id: 500, normalized: false, lstrip: false, rstrip: false }];
    const ids = encodeWithData(d, `[CLS]${METASPACE_REPLACEMENT}x`);
    // [CLS] -> 500, then '▁x' -> 11.
    expect(ids).toEqual([500, 11]);
  });

  it('handles lstrip/rstrip whitespace trimming like HF', () => {
    const d = tinyData();
    d.added = [{ content: 'X', id: 501, normalized: false, lstrip: true, rstrip: true }];
    const ids = encodeWithData(d, `x  X  y`);
    // 'x' (marker-prefixed -> ▁x = 11), added X -> 501 (surrounding ws trimmed), 'y' -> '▁y' = 12.
    expect(ids).toEqual([11, 501, 12]);
  });

  it('dispatches to bytelevel encoding for kind=bytelevel', () => {
    const d = { ...tinyData(), kind: 'bytelevel' as const, replaces: [] };
    // 'a b' -> pieces ['a', ' b'] via GPT2 split; with merges 'a b', ' b' stays unmergeable.
    const ids = encodeWithData(d, 'a b');
    expect(ids.length).toBeGreaterThan(0);
  });
});

describe('loadTokenizerJson', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches http(s) URLs and parses the payload', async () => {
    const raw = { model: { vocab: { '[CLS]': 1 } } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => raw }));
    const d = await loadTokenizerJson('https://example.com/tk.json');
    expect(d!.ids.cls).toBe(1);
  });

  it('returns null on a non-ok fetch response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    expect(await loadTokenizerJson('https://example.com/tk.json')).toBeNull();
  });
});
