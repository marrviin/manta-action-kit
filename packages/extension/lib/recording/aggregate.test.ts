import { describe, it, expect } from 'vitest';
import { aggregateEndpoints, attachDependencies } from './aggregate';
import type { ApiCall, FieldDependency } from './types';

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

describe('aggregateEndpoints', () => {
  it('collapses calls that differ only by a numeric id', () => {
    const eps = aggregateEndpoints([
      call({ seq: 0, url: 'https://api.x.com/orders/1' }),
      call({ seq: 1, url: 'https://api.x.com/orders/2' }),
      call({ seq: 2, url: 'https://api.x.com/orders/3' }),
    ]);
    expect(eps).toHaveLength(1);
    expect(eps[0]!.pathKey).toBe('/orders/:id');
    expect(eps[0]!.callCount).toBe(3);
  });

  it('normalizes uuid segments to :id', () => {
    const eps = aggregateEndpoints([
      call({ seq: 0, url: 'https://api.x.com/u/550e8400-e29b-41d4-a716-446655440000/profile' }),
    ]);
    expect(eps[0]!.pathKey).toBe('/u/:id/profile');
  });

  it('keeps distinct methods on the same path separate', () => {
    const eps = aggregateEndpoints([
      call({ seq: 0, url: 'https://api.x.com/orders', method: 'GET' }),
      call({ seq: 1, url: 'https://api.x.com/orders', method: 'POST' }),
    ]);
    expect(eps).toHaveLength(2);
    expect(eps.map((e) => e.method).sort()).toEqual(['GET', 'POST']);
  });

  it('collects distinct status codes and query keys', () => {
    const eps = aggregateEndpoints([
      call({ seq: 0, url: 'https://api.x.com/s?q=a&page=1', status: 200 }),
      call({ seq: 1, url: 'https://api.x.com/s?q=b', status: 404 }),
    ]);
    expect(eps[0]!.statuses).toEqual([200, 404]);
    expect(eps[0]!.queryKeys).toEqual(['page', 'q']);
  });

  it('orders endpoints by first appearance (lowest seq)', () => {
    const eps = aggregateEndpoints([
      call({ seq: 2, url: 'https://api.x.com/b' }),
      call({ seq: 0, url: 'https://api.x.com/a' }),
      call({ seq: 1, url: 'https://api.x.com/c' }),
    ]);
    expect(eps.map((e) => e.pathKey)).toEqual(['/a', '/c', '/b']);
  });

  it('uses the earliest call as the sample URL', () => {
    const eps = aggregateEndpoints([
      call({ seq: 5, url: 'https://api.x.com/orders/99' }),
      call({ seq: 1, url: 'https://api.x.com/orders/1' }),
    ]);
    expect(eps[0]!.sampleUrl).toBe('https://api.x.com/orders/1');
  });

  it('infers a response schema from JSON bodies', () => {
    const eps = aggregateEndpoints([
      call({ seq: 0, url: 'https://api.x.com/o/1', resBody: '{"id":1,"name":"a"}', resIsJson: true }),
      call({ seq: 1, url: 'https://api.x.com/o/2', resBody: '{"id":2,"name":"b"}', resIsJson: true }),
    ]);
    expect(eps[0]!.responseSchema?.kind).toBe('object');
    expect(Object.keys(eps[0]!.responseSchema?.properties ?? {}).sort()).toEqual(['id', 'name']);
  });

  it('skips streaming responses in schema inference', () => {
    const eps = aggregateEndpoints([
      call({ seq: 0, url: 'https://api.x.com/chat', streaming: true, resBody: null }),
    ]);
    expect(eps[0]!.responseSchema).toBeNull();
  });
});

describe('attachDependencies', () => {
  const calls = [
    call({ seq: 0, url: 'https://api.x.com/orders', method: 'GET' }),
    call({ seq: 1, url: 'https://api.x.com/orders/42/pay', method: 'POST' }),
  ];

  function dep(partial: Partial<FieldDependency>): FieldDependency {
    return {
      id: 'd1',
      fromSeq: 0,
      fromPath: 'data[].id',
      toSeq: 1,
      toLocation: 'body',
      toPath: 'orderId',
      value: '42',
      origin: 'inferred',
      ...partial,
    };
  }

  it('re-keys a flow dependency onto the consuming endpoint', () => {
    const eps = aggregateEndpoints(calls);
    const withInputs = attachDependencies(eps, calls, [dep({})]);
    const payEp = withInputs.find((e) => e.pathKey === '/orders/:id/pay');
    expect(payEp?.inputsFrom).toHaveLength(1);
    expect(payEp?.inputsFrom?.[0]).toMatchObject({
      toLocation: 'body',
      toPath: 'orderId',
      fromEndpointKey: 'GET /orders',
      fromPath: 'data[].id',
    });
  });

  it('returns endpoints unchanged when there are no deps', () => {
    const eps = aggregateEndpoints(calls);
    expect(attachDependencies(eps, calls, [])).toBe(eps);
  });

  it('drops self-referential deps once collapsed to the same endpoint', () => {
    // Two calls to the same route, one feeding the other → same endpoint key.
    const sameRoute = [
      call({ seq: 0, url: 'https://api.x.com/items/1', method: 'GET' }),
      call({ seq: 1, url: 'https://api.x.com/items/2', method: 'GET' }),
    ];
    const eps = aggregateEndpoints(sameRoute);
    const withInputs = attachDependencies(eps, sameRoute, [dep({ fromSeq: 0, toSeq: 1 })]);
    expect(withInputs[0]!.inputsFrom).toBeUndefined();
  });

  it('de-dupes identical (target, source) edges', () => {
    const eps = aggregateEndpoints(calls);
    const withInputs = attachDependencies(eps, calls, [
      dep({ id: 'd1' }),
      dep({ id: 'd2' }),
    ]);
    const payEp = withInputs.find((e) => e.pathKey === '/orders/:id/pay');
    expect(payEp?.inputsFrom).toHaveLength(1);
  });
});
