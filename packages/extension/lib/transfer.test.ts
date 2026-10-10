/**
 * Data-transfer tests on fake-indexeddb: the export payload shape (actions
 * carry their source recordings + calls; unrelated recordings are excluded),
 * the import roundtrip (ids preserved, original updatedAt stamps intact), the
 * selection semantics (unchecked categories stay untouched), and the parser's
 * rejection paths (bad JSON / wrong marker / all-empty, invalid rows dropped).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach } from 'vitest';
import { saveRecording, listRecordings, getCalls, listActions, upsertAction } from '@/lib/db';
import {
  TRANSFER_FORMAT,
  TRANSFER_VERSION,
  buildTransferPayload,
  applyTransferPayload,
  parseTransferPayload,
  parseTransferFile,
  TransferParseError,
  type TransferSelection,
} from '@/lib/transfer';
import type { Recording, ApiCall } from '@/lib/recording/types';
import type { Action } from '@/lib/action/types';

const rec = (over: Partial<Recording> = {}): Recording =>
  ({ id: 'r1', name: 'Login flow', createdAt: 1000, ...over }) as Recording;

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

const action = (over: Partial<Action> = {}): Action =>
  ({
    id: 'a1',
    name: 'track shipment',
    description: 'desc',
    recordingId: 'r1',
    params: [],
    steps: [{ callId: 'c1', kind: 'fetch' }],
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  }) as Action;

const SEL_ALL: TransferSelection = { actions: true, recordings: true };

const DB_NAME = 'manta-action-kit';

beforeEach(async () => {
  // Fresh database per test — same mechanism as db.test.ts: the previous
  // connection closes via its own onversionchange handler, so the next open
  // re-creates an empty DB.
  await new Promise<void>((resolve) => {
    const del = indexedDB.deleteDatabase(DB_NAME);
    del.onsuccess = () => resolve();
    del.onerror = () => resolve();
    del.onblocked = () => resolve();
  });
});

describe('buildTransferPayload', () => {
  it('exports selected recordings with their calls', async () => {
    await saveRecording(rec({ id: 'r1' }), [call({ id: 'c1' })]);
    await saveRecording(rec({ id: 'r2', createdAt: 2000 }), [call({ id: 'c2', recordingId: 'r2' })]);
    const payload = await buildTransferPayload({ actions: false, recordings: true });
    expect(payload.format).toBe(TRANSFER_FORMAT);
    expect(payload.version).toBe(TRANSFER_VERSION);
    expect(sortedIds(payload.recordings)).toEqual(['r1', 'r2']);
    expect(sortedIds(payload.calls)).toEqual(['c1', 'c2']);
    expect(payload.actions).toEqual([]);
  });

  it('carries the source recordings and calls of exported actions, not unrelated ones', async () => {
    await saveRecording(rec({ id: 'r1' }), [call({ id: 'c1' })]);
    await saveRecording(rec({ id: 'r2', createdAt: 2000 }), [call({ id: 'c2', recordingId: 'r2' })]);
    await saveRecording(rec({ id: 'r3', createdAt: 3000 }), []);
    await upsertAction(action()); // distilled from r1
    const payload = await buildTransferPayload({ actions: true, recordings: false });
    expect(sortedIds(payload.actions)).toEqual(['a1']);
    // r1 rides along (the action's source), r2/r3 stay out (no actions reference them).
    expect(sortedIds(payload.recordings)).toEqual(['r1']);
    expect(sortedIds(payload.calls)).toEqual(['c1']);
  });

  it('returns an all-empty payload when the selected categories have no data', async () => {
    const payload = await buildTransferPayload(SEL_ALL);
    expect(payload.actions).toEqual([]);
    expect(payload.recordings).toEqual([]);
    expect(payload.calls).toEqual([]);
  });
});

describe('applyTransferPayload', () => {
  it('roundtrips a full export into an empty database with ids and stamps intact', async () => {
    await saveRecording(rec({ id: 'r1' }), [call({ id: 'c1' }), call({ id: 'c2', seq: 2 })]);
    await saveRecording(rec({ id: 'r2', createdAt: 2000 }), []);
    const payload = await buildTransferPayload(SEL_ALL);

    // Wipe and re-import into the fresh database.
    await resetDb();
    const written = await applyTransferPayload(payload, SEL_ALL);
    expect(written).toEqual({ actions: 0, recordings: 2, calls: 2 });

    expect(sortedIds(await listRecordings())).toEqual(['r1', 'r2']);
    expect((await getCalls('r1')).map((c) => c.id)).toEqual(['c1', 'c2']); // ordered by seq
  });

  it('imports actions with their source recordings and preserves updatedAt', async () => {
    await saveRecording(rec({ id: 'r1' }), [call({ id: 'c1' })]);
    await upsertAction(action()); // re-stamps updatedAt to "now" (the real save path)
    const payload = await buildTransferPayload({ actions: true, recordings: false });
    const exportedStamp = payload.actions[0]!.updatedAt;

    await resetDb();
    const written = await applyTransferPayload(payload, SEL_ALL);
    expect(written).toEqual({ actions: 1, recordings: 1, calls: 1 });

    const actions = await listActions();
    expect(actions.map((a) => a.id)).toEqual(['a1']);
    // Import must not re-stamp: the exported stamp survives the roundtrip.
    expect(actions[0].updatedAt).toBe(exportedStamp);
    // The source recording must be present or the action can never execute.
    expect((await listRecordings()).map((r) => r.id)).toEqual(['r1']);
  });

  it('skips unchecked categories: recordings unchecked leaves local recordings untouched', async () => {
    await saveRecording(rec({ id: 'r1' }), [call({ id: 'c1' })]);
    await upsertAction(action()); // distilled from r1
    await saveRecording(rec({ id: 'r-local', createdAt: 2000 }), []);
    const payload = await buildTransferPayload(SEL_ALL);

    await resetDb();
    await saveRecording(rec({ id: 'r-local', createdAt: 2000 }), []);
    const written = await applyTransferPayload(payload, { actions: true, recordings: false });
    // Only the action's source recording (r1) is restored.
    expect(written).toEqual({ actions: 1, recordings: 1, calls: 1 });
    expect(sortedIds(await listRecordings())).toEqual(['r-local', 'r1']);
  });
});

describe('parseTransferPayload / parseTransferFile', () => {
  it('rejects non-JSON text with the parse reason', () => {
    expect(() => parseTransferFile('not json')).toThrowError(TransferParseError);
    try {
      parseTransferFile('not json');
    } catch (err) {
      expect((err as TransferParseError).reason).toBe('parse');
    }
  });

  it('rejects unknown markers and versions with the format reason', () => {
    expect(() => parseTransferPayload({ format: 'other', version: 1 })).toThrowError(
      TransferParseError,
    );
    expect(() => parseTransferPayload({ format: TRANSFER_FORMAT, version: 99 })).toThrowError(
      TransferParseError,
    );
    try {
      parseTransferPayload({ format: 'other', version: 1 });
    } catch (err) {
      expect((err as TransferParseError).reason).toBe('format');
    }
  });

  it('rejects an all-empty payload with the empty reason', () => {
    expect(() =>
      parseTransferPayload({ format: TRANSFER_FORMAT, version: TRANSFER_VERSION }),
    ).toThrowError(TransferParseError);
    try {
      parseTransferPayload({ format: TRANSFER_FORMAT, version: TRANSFER_VERSION });
    } catch (err) {
      expect((err as TransferParseError).reason).toBe('empty');
    }
  });

  it('drops rows missing the id fields the upsert needs', () => {
    const payload = parseTransferPayload({
      format: TRANSFER_FORMAT,
      version: TRANSFER_VERSION,
      exportedAt: 1,
      actions: [{ name: 'no id' }, action()],
      recordings: [rec()],
      calls: [call(), { recordingId: 'r1' }], // no id
    });
    expect(payload.actions.map((a) => a.id)).toEqual(['a1']);
    expect(payload.recordings.map((r) => r.id)).toEqual(['r1']);
    expect(payload.calls.map((c) => c.id)).toEqual(['c1']);
  });
});

/** Set equality — same-ms timestamps make list order unstable. */
function sortedIds<T extends { id: string }>(xs: T[]): string[] {
  return xs.map((x) => x.id).sort();
}

async function resetDb(): Promise<void> {
  await new Promise<void>((resolve) => {
    const del = indexedDB.deleteDatabase(DB_NAME);
    del.onsuccess = () => resolve();
    del.onerror = () => resolve();
    del.onblocked = () => resolve();
  });
}
