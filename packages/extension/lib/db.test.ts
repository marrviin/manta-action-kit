/**
 * IndexedDB layer tests on fake-indexeddb: recording lifecycle (incl. the
 * delete cascade to calls + actions), the dedicated description write path,
 * the three capped histories' cursor eviction (gif 10 / inspector 20 /
 * screenshot 20, oldest first, same transaction as the put), and gateway logs.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  saveRecording,
  listRecordings,
  getRecording,
  getCalls,
  renameRecording,
  updateRecordingDescription,
  deleteRecording,
  setRecordingRelevanceStatus,
  addGatewayLog,
  listGatewayLogs,
  clearGatewayLogs,
  upsertGatewayProxyRule,
  listGatewayProxyRules,
  deleteGatewayProxyRule,
  upsertAction,
  listActions,
  listActionsByRecording,
  getAction,
  deleteAction,
  saveGifHistory,
  listGifHistory,
  getGifDraft,
  deleteGifDraft,
  saveInspectorHistoryCapture,
  listInspectorCaptures,
  getInspectorCapture,
  saveScreenshotHistory,
  listScreenshotHistory,
} from '@/lib/db';
import type { Recording, ApiCall } from '@/lib/recording/types';
import type { Action } from '@/lib/action/types';

const rec = (over: Partial<Recording> = {}): Recording =>
  ({
    id: 'r1',
    name: 'Login flow',
    createdAt: 1000,
    ...over,
  }) as Recording;

const call = (over: Partial<ApiCall> = {}): ApiCall =>
  ({
    id: 'c1',
    recordingId: 'r1',
    seq: 1,
    method: 'GET',
    url: 'https://api.example.com/x',
    status: 200,
    startedAt: 1,
    durationMs: 5,
    ...over,
  }) as ApiCall;

const DB_NAME = 'manta-action-kit';

beforeEach(async () => {
  // Fresh database per test. The previous test's connection is closed by its
  // own onversionchange handler (which also drops the module's cached
  // connection), so the next open re-creates an empty DB at v13.
  await new Promise<void>((resolve) => {
    const del = indexedDB.deleteDatabase(DB_NAME);
    del.onsuccess = () => resolve();
    del.onerror = () => resolve();
    del.onblocked = () => resolve();
  });
});

/** Set equality — same-ms createdAt makes list order unstable. */
function sorted<T>(xs: T[]): T[] {
  return [...xs].sort();
}

describe('recordings', () => {
  it('saves, lists newest first, and reads back a recording with its calls', async () => {
    await saveRecording(rec({ id: 'r2', createdAt: 2000 }), []);
    await saveRecording(rec({ id: 'r1', createdAt: 1000 }), [
      call({ seq: 2, id: 'c2' }),
      call({ seq: 1, id: 'c1' }),
    ]);
    const listed = await listRecordings();
    expect(listed.map((r) => r.id)).toEqual(['r2', 'r1']);
    expect((await getRecording('r1'))!.name).toBe('Login flow');
    const calls = await getCalls('r1');
    expect(calls.map((c) => c.seq)).toEqual([1, 2]); // ordered by seq
    expect(await getCalls('r2')).toEqual([]);
  });

  it('renames and stamps the description via the dedicated write path only', async () => {
    await saveRecording(rec(), [call()]);
    await renameRecording('r1', 'Renamed');
    expect((await getRecording('r1'))!.name).toBe('Renamed');

    await updateRecordingDescription('r1', 'A login flow');
    const after = (await getRecording('r1'))!;
    expect(after.description).toBe('A login flow');
    expect(after.descriptionUpdatedAt).toBeGreaterThan(0);
    expect(after.name).toBe('Renamed'); // untouched

    await updateRecordingDescription('missing', 'x'); // no-op, no throw
  });

  it('stamps the relevance lifecycle status', async () => {
    await saveRecording(rec(), []);
    await setRecordingRelevanceStatus('r1', 'analyzing');
    expect((await getRecording('r1'))!.relevanceStatus).toBe('analyzing');
    await setRecordingRelevanceStatus('r1', 'done');
    expect((await getRecording('r1'))!.relevanceStatus).toBe('done');
  });

  it('deleting a recording cascades to its calls and distilled actions', async () => {
    await saveRecording(rec(), [call({ id: 'c1' }), call({ id: 'c2', seq: 2 })]);
    await upsertAction({
      id: 'a1',
      name: 'A',
      description: 'd',
      recordingId: 'r1',
      params: [],
      steps: [{ callId: 'c1', kind: 'fetch' }],
      createdAt: 1,
      updatedAt: 1,
    } as Action);
    await deleteRecording('r1');
    expect(await getRecording('r1')).toBeUndefined();
    expect(await getCalls('r1')).toEqual([]);
    expect(await getAction('a1')).toBeUndefined();
  });
});

describe('gateway logs + proxy rules', () => {
  it('stores and clears audit logs (cookie names only ever reach the row)', async () => {
    await addGatewayLog({
      id: 'l1',
      at: 1,
      kind: 'fetch',
      method: 'GET',
      url: 'https://x/',
      origin: 'https://x',
      host: 'x',
      decision: 'auto',
      authSource: 'allowlist',
      via: 'agent',
      injectedCookieNames: ['sid'],
      cookieDomain: 'x',
      reqHeaders: {},
      reqBodyPreview: null,
      status: 200,
      statusText: 'OK',
      resHeadersSafe: {},
      resBodyPreview: 'ok',
      durationMs: 3,
      errored: false,
    });
    const logs = await listGatewayLogs();
    expect(logs).toHaveLength(1);
    await clearGatewayLogs();
    expect(await listGatewayLogs()).toEqual([]);
  });

  it('upserts and deletes proxy rules', async () => {
    await upsertGatewayProxyRule({
      id: 'p1',
      sandboxPrefix: '/api',
      targetBase: 'https://api.example.com',
      enabled: true,
      createdBy: 'user',
      createdAt: 1,
    } as never);
    expect((await listGatewayProxyRules()).map((r) => r.id)).toEqual(['p1']);
    await upsertGatewayProxyRule({
      id: 'p1',
      sandboxPrefix: '/api',
      targetBase: 'https://other.example.com',
      enabled: false,
      createdBy: 'user',
      createdAt: 1,
    } as never);
    const updated = (await listGatewayProxyRules())[0]!;
    expect(updated.targetBase).toBe('https://other.example.com');
    expect(updated.enabled).toBe(false);
    await deleteGatewayProxyRule('p1');
    expect(await listGatewayProxyRules()).toEqual([]);
  });
});

describe('actions', () => {
  const action = (over: Partial<Action> = {}): Action =>
    ({
      id: 'a1',
      name: 'Login',
      description: 'd',
      recordingId: 'r1',
      params: [],
      steps: [],
      createdAt: 1,
      updatedAt: 1,
      ...over,
    }) as Action;

  it('CRUDs actions and scopes the by-recording listing', async () => {
    await upsertAction(action());
    await upsertAction(action({ id: 'a2', recordingId: 'r2', name: 'Other' }));
    expect((await listActions()).map((a) => a.id).sort()).toEqual(['a1', 'a2']);
    expect((await listActionsByRecording('r1')).map((a) => a.id)).toEqual(['a1']);
    expect((await getAction('a2'))!.name).toBe('Other');

    await upsertAction(action({ name: 'Renamed' })); // upsert = update
    expect((await getAction('a1'))!.name).toBe('Renamed');
    await deleteAction('a1');
    expect(await getAction('a1')).toBeUndefined();
  });
});

describe('capped histories (cursor eviction)', () => {
  /**
   * Distinct createdAt per save: ties are broken by random uuid key order, so
   * without this the "oldest" eviction target among same-ms saves is random.
   * A Date.now spy (not fake timers — fake-indexeddb schedules via timers).
   */
  function staggerTime(): () => void {
    let t = 1_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => (t += 10));
    return () => spy.mockRestore();
  }

  it('gif drafts cap at 10, evicting oldest first, blobs intact', async () => {
    const restore = staggerTime();
    try {
      for (let i = 1; i <= 12; i++) {
        await saveGifHistory(new Blob([`webm-${i}`]), `g${i}.webm`);
      }
    } finally {
      restore();
    }
    const meta = await listGifHistory();
    expect(meta).toHaveLength(10);
    // g1, g2 evicted (distinct createdAt via setSystemTime, oldest first).
    expect(sorted(meta.map((m) => m.filename))).toEqual(
      sorted(Array.from({ length: 10 }, (_, i) => `g${i + 3}.webm`)),
    );
    const draft = await getGifDraft(meta[0]!.id);
    expect(draft!.blob).toBeInstanceOf(Blob);
    await expect(draft!.blob.text()).resolves.toBe('webm-12');
    await deleteGifDraft(meta[0]!.id);
    expect((await listGifHistory()).length).toBe(9);
  });

  it('inspector captures cap at 20, oldest evicted first', { timeout: 15000 }, async () => {
    const restore = staggerTime();
    try {
      for (let i = 1; i <= 22; i++) {
        await saveInspectorHistoryCapture({
          page: { url: `https://x/${i}`, title: `p${i}` },
          capturedAt: String(i).padStart(4, '0'), // string field (localeCompare order)
          elementCount: 1,
          elements: [],
        } as never);
      }
    } finally {
      restore();
    }
    const listed = await listInspectorCaptures();
    expect(listed).toHaveLength(20);
    // p1, p2 evicted (distinct createdAt via setSystemTime, oldest first).
    const urls = listed.map((c) => c.payload.page.url);
    expect(sorted(urls)).toEqual(
      sorted(Array.from({ length: 20 }, (_, i) => `https://x/${i + 3}`)),
    );
    expect(urls[0]).toBe('https://x/22');
    const id = listed[0]!.id;
    expect(await getInspectorCapture(id)).toMatchObject({
      capturedAt: '0022',
    });
  });

  it('screenshot history caps at 20, oldest evicted first', async () => {
    const restore = staggerTime();
    try {
      for (let i = 1; i <= 25; i++) {
        await saveScreenshotHistory(`data:image/png;base64,${i}`, `s${i}.png`);
      }
    } finally {
      restore();
    }
    const listed = await listScreenshotHistory();
    expect(listed).toHaveLength(20);
    // s1..s5 evicted (distinct createdAt via setSystemTime, oldest first).
    expect(sorted(listed.map((s) => s.filename))).toEqual(
      sorted(Array.from({ length: 20 }, (_, i) => `s${i + 6}.png`)),
    );
  });
});
