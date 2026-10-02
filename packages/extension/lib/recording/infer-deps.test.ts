import { describe, it, expect } from 'vitest';
import { inferDependencies } from './infer-deps';
import type { ApiCall } from './types';

/** Build an ApiCall with defaults; override the fields a test exercises. */
function call(partial: Partial<ApiCall> & Pick<ApiCall, 'seq' | 'url'>): ApiCall {
  return {
    id: `c${partial.seq}`,
    recordingId: 'r1',
    source: 'fetch',
    method: 'GET',
    reqHeaders: {},
    reqBody: null,
    status: 200,
    statusText: 'OK',
    resHeaders: {},
    resBody: null,
    resIsJson: false,
    startedAt: 0,
    durationMs: 0,
    errored: false,
    ...partial,
  } as ApiCall;
}

describe('inferDependencies', () => {
  it('links a response-produced value to a later request body path', () => {
    const deps = inferDependencies([
      call({
        seq: 0,
        url: 'https://a.com/orders',
        resIsJson: true,
        resBody: JSON.stringify({ data: { orderId: 'ord_123456' } }),
      }),
      call({
        seq: 1,
        url: 'https://a.com/pay',
        method: 'POST',
        reqBody: JSON.stringify({ orderId: 'ord_123456' }),
      }),
    ]);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({
      fromSeq: 0,
      fromPath: 'data.orderId',
      toSeq: 1,
      toLocation: 'body',
      toPath: 'orderId',
      value: 'ord_123456',
      origin: 'inferred',
    });
  });

  it('links a value consumed as a query param', () => {
    const deps = inferDependencies([
      call({ seq: 0, url: 'https://a.com/session', resIsJson: true, resBody: '{"token":"tok_abc123"}' }),
      call({ seq: 1, url: 'https://a.com/data?token=tok_abc123' }),
    ]);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ toLocation: 'query', toPath: 'token' });
  });

  it('links a value echoed back as a request header', () => {
    const deps = inferDependencies([
      call({ seq: 0, url: 'https://a.com/login', resIsJson: true, resBody: '{"access":"tok_long_enough"}' }),
      call({
        seq: 1,
        url: 'https://a.com/me',
        reqHeaders: { Authorization: 'Bearer tok_long_enough' },
      }),
    ]);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ toLocation: 'header', toPath: 'Authorization' });
  });

  it('falls back to a raw url substring match for path ids', () => {
    const deps = inferDependencies([
      call({ seq: 0, url: 'https://a.com/orders', resIsJson: true, resBody: '{"id":"ord_99"}' }),
      call({ seq: 1, url: 'https://a.com/orders/ord_99/items' }),
    ]);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ toLocation: 'url', toPath: '' });
  });

  it('ignores values shorter than the ambiguity threshold', () => {
    const deps = inferDependencies([
      call({ seq: 0, url: 'https://a.com/a', resIsJson: true, resBody: '{"id":"12345"}' }),
      call({ seq: 1, url: 'https://a.com/b?id=12345' }),
    ]);
    expect(deps).toHaveLength(0);
  });

  it('never links a call to itself (produce then register)', () => {
    const deps = inferDependencies([
      call({ seq: 0, url: 'https://a.com/echo?id=ord_123456', resIsJson: true, resBody: '{"id":"ord_123456"}' }),
    ]);
    expect(deps).toHaveLength(0);
  });

  it('ignores non-JSON responses and unparseable bodies', () => {
    const deps = inferDependencies([
      call({ seq: 0, url: 'https://a.com/a', resIsJson: false, resBody: '<html>ord_123456</html>' }),
      call({ seq: 1, url: 'https://a.com/b', reqBody: 'x=ord_123456' }),
    ]);
    expect(deps).toHaveLength(0);
  });

  it('sorts defensively by seq before matching', () => {
    const deps = inferDependencies([
      call({ seq: 1, url: 'https://a.com/pay', reqBody: JSON.stringify({ orderId: 'ord_123456' }) }),
      call({ seq: 0, url: 'https://a.com/orders', resIsJson: true, resBody: '{"orderId":"ord_123456"}' }),
    ]);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ fromSeq: 0, toSeq: 1 });
  });

  it('dedupes multiple produced values landing on the same target slot', () => {
    const deps = inferDependencies([
      call({
        seq: 0,
        url: 'https://a.com/a',
        resIsJson: true,
        resBody: JSON.stringify({ x: 'value_1', y: 'value_2' }),
      }),
      call({ seq: 1, url: 'https://a.com/b', reqBody: JSON.stringify({ x: 'value_1', y: 'value_2' }) }),
    ]);
    // One edge per (toSeq, toLocation, toPath): body.x and body.y.
    expect(deps).toHaveLength(2);
    expect(new Set(deps.map((d) => d.toPath))).toEqual(new Set(['x', 'y']));
  });

  it('keeps the earliest producer when the same value is produced twice', () => {
    const deps = inferDependencies([
      call({ seq: 0, url: 'https://a.com/a', resIsJson: true, resBody: '{"v":"val_000001"}' }),
      call({ seq: 1, url: 'https://a.com/b', resIsJson: true, resBody: '{"v":"val_000001"}' }),
      call({ seq: 2, url: 'https://a.com/c', reqBody: '{"v":"val_000001"}' }),
    ]);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.fromSeq).toBe(0);
  });

  it('prefers a structured body path over a raw url substring', () => {
    const deps = inferDependencies([
      call({ seq: 0, url: 'https://a.com/a', resIsJson: true, resBody: '{"v":"val_000001"}' }),
      call({ seq: 1, url: 'https://a.com/b', reqBody: '{"v":"val_000001"}' }),
    ]);
    expect(deps[0]!.toLocation).toBe('body');
  });
});
