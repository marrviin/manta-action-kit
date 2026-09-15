import { describe, it, expect } from 'vitest';
import { createSseParser } from './sse-parse';

/** Feed a whole stream text through a fresh parser (push + flush) and collect events. */
function parseAll(text: string) {
  const p = createSseParser();
  const out = [...p.push(text), ...p.flush()];
  return out;
}

describe('createSseParser', () => {
  it('parses a single data-only event terminated by a blank line', () => {
    expect(parseAll('data: hello\n\n')).toEqual([{ data: 'hello' }]);
  });

  it('parses event / id / data fields together', () => {
    expect(parseAll('event: message\nid: 1\ndata: hi\n\n')).toEqual([
      { event: 'message', id: '1', data: 'hi' },
    ]);
  });

  it('joins multiple data lines with a newline', () => {
    expect(parseAll('data: line1\ndata: line2\n\n')).toEqual([{ data: 'line1\nline2' }]);
  });

  it('ignores comment / heartbeat lines starting with ":"', () => {
    expect(parseAll(': ping\ndata: real\n\n')).toEqual([{ data: 'real' }]);
  });

  it('strips exactly one leading space after the colon', () => {
    // "data:  x" (two spaces) keeps one; "data:x" (none) keeps as-is.
    expect(parseAll('data:  x\n\n')).toEqual([{ data: ' x' }]);
    expect(parseAll('data:x\n\n')).toEqual([{ data: 'x' }]);
  });

  it('tolerates CRLF line endings', () => {
    expect(parseAll('event: msg\r\ndata: hi\r\n\r\n')).toEqual([{ event: 'msg', data: 'hi' }]);
  });

  it('dispatches multiple events in one stream', () => {
    expect(parseAll('data: a\n\ndata: b\n\n')).toEqual([{ data: 'a' }, { data: 'b' }]);
  });

  it('reassembles an event split across chunk boundaries', () => {
    const p = createSseParser();
    const out = [...p.push('data: hel'), ...p.push('lo\n'), ...p.push('\n'), ...p.flush()];
    expect(out).toEqual([{ data: 'hello' }]);
  });

  it('flushes a trailing frame not terminated by a blank line', () => {
    expect(parseAll('data: tail')).toEqual([{ data: 'tail' }]);
  });

  it('treats a field with no value as an empty string', () => {
    expect(parseAll('data:\n\n')).toEqual([{ data: '' }]);
  });

  it('ignores unknown fields like retry', () => {
    expect(parseAll('retry: 5000\ndata: x\n\n')).toEqual([{ data: 'x' }]);
  });

  it('emits nothing for a stream of only comments', () => {
    expect(parseAll(': keep-alive\n: keep-alive\n')).toEqual([]);
  });
});
