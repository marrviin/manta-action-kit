/**
 * Settings-page data transfer: export / import of the action library and the
 * API-recording archive as a single JSON file.
 *
 * Payload shape (`TransferPayload`): three flat arrays — actions, recordings,
 * calls — with original ids preserved verbatim so an export → import roundtrip
 * is lossless and id-based foreign keys keep pointing at the same rows
 * (Action.steps[].callId → calls, ApiCall.recordingId → recordings).
 *
 * Cross-dependency: an action stores no request material of its own — every
 * step references a recorded ApiCall. So an actions-only export always carries
 * the source recordings (and their calls) along, and an actions-only import
 * restores them, otherwise the imported actions could never execute.
 *
 * Import is a plain id-upsert (no merging, no diffing): rows with the same id
 * as existing ones overwrite them. `buildTransferPayload` /
 * `parseTransferPayload` are side-effect free so they can be unit-tested and
 * the UI can show a confirmation modal with counts before anything is written.
 */
import { listActions, listRecordings, getCalls, putRecordings, putCalls, putActions } from '@/lib/db';
import type { ApiCall, Recording } from '@/lib/recording/types';
import type { Action } from '@/lib/action/types';

/** Marker written into every export; imports refuse anything else. */
export const TRANSFER_FORMAT = 'manta-action-kit/data';
/** Bump when the payload shape ever breaks backwards compatibility. */
export const TRANSFER_VERSION = 1;

/** Which data categories the user picked for export / import. */
export interface TransferSelection {
  actions: boolean;
  recordings: boolean;
}

export interface TransferPayload {
  format: typeof TRANSFER_FORMAT;
  version: typeof TRANSFER_VERSION;
  /** epoch ms when the file was created. */
  exportedAt: number;
  actions: Action[];
  recordings: Recording[];
  calls: ApiCall[];
}

/** Why a file failed to parse as a transfer payload (mapped to i18n in the UI). */
export type TransferParseErrorReason = 'parse' | 'format' | 'empty';

export class TransferParseError extends Error {
  readonly reason: TransferParseErrorReason;
  constructor(reason: TransferParseErrorReason) {
    super(`transfer payload rejected: ${reason}`);
    this.reason = reason;
  }
}

/** How many rows a file / import carries, per category — drives the confirm modal and toasts.
 *  A type alias (not an interface) so it is assignable to i18next's interpolated-options shape. */
export type TransferCounts = {
  actions: number;
  recordings: number;
  calls: number;
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

const hasId = (v: unknown): v is { id: string } =>
  isObj(v) && typeof (v as { id: unknown }).id === 'string';

const hasRecId = (v: unknown): v is { recordingId: string } =>
  isObj(v) && typeof (v as { recordingId: unknown }).recordingId === 'string';

/**
 * Gather the payload for an export: all actions and/or all recordings, with
 * the recordings each action was distilled from (plus their calls) always
 * included in an actions export. Side-effect free (reads only).
 */
export async function buildTransferPayload(
  selection: TransferSelection,
): Promise<TransferPayload> {
  const [allActions, allRecordings] = await Promise.all([
    listActions(),
    listRecordings(),
  ]);
  const byId = new Map(allRecordings.map((r) => [r.id, r]));
  const recordings = new Map<string, Recording>();
  const calls = new Map<string, ApiCall>();

  // collectRecording pulls one recording and its calls into the payload;
  // already-collected recordings are skipped so unions dedupe by id.
  const collectRecording = async (id: string) => {
    if (recordings.has(id)) return;
    const rec = byId.get(id);
    if (!rec) return; // dangling action reference — export the action anyway
    recordings.set(id, rec);
    for (const call of await getCalls(id)) calls.set(call.id, call);
  };

  if (selection.recordings) {
    for (const rec of allRecordings) await collectRecording(rec.id);
  }
  if (selection.actions) {
    for (const action of allActions) await collectRecording(action.recordingId);
  }

  return {
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION,
    exportedAt: Date.now(),
    actions: selection.actions ? allActions : [],
    recordings: [...recordings.values()],
    calls: [...calls.values()],
  };
}

/**
 * Validate a parsed-JSON export. Known-format markers are strict; row shapes
 * are checked loosely (must have the id fields the upsert needs) and invalid
 * rows are dropped so one malformed entry can't poison a whole file.
 * Throws {@link TransferParseError} on a wrong marker or an all-empty payload.
 */
export function parseTransferPayload(raw: unknown): TransferPayload {
  if (!isObj(raw)) throw new TransferParseError('format');
  if (raw.format !== TRANSFER_FORMAT || raw.version !== TRANSFER_VERSION) {
    throw new TransferParseError('format');
  }
  const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const actions = asArray(raw.actions).filter(
    (a): a is Action => hasId(a) && hasRecId(a),
  );
  const recordings = asArray(raw.recordings).filter(
    (r): r is Recording => hasId(r),
  );
  const calls = asArray(raw.calls).filter(
    (c): c is ApiCall => hasId(c) && hasRecId(c),
  );
  if (actions.length === 0 && recordings.length === 0 && calls.length === 0) {
    throw new TransferParseError('empty');
  }
  return {
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION,
    exportedAt: typeof raw.exportedAt === 'number' ? raw.exportedAt : 0,
    actions,
    recordings,
    calls,
  };
}

/** Parse a file's text content — a thin wrapper so the UI doesn't touch JSON.parse. */
export function parseTransferFile(text: string): TransferPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new TransferParseError('parse');
  }
  return parseTransferPayload(raw);
}

export function countPayload(payload: TransferPayload): TransferCounts {
  return {
    actions: payload.actions.length,
    recordings: payload.recordings.length,
    calls: payload.calls.length,
  };
}

/**
 * Write a payload into the stores. The `recordings` selection imports
 * recordings + their calls; the `actions` selection imports actions + the
 * recordings they depend on (which ride along in the file). Returns what was
 * actually written so the UI can toast real numbers.
 */
export async function applyTransferPayload(
  payload: TransferPayload,
  selection: TransferSelection,
): Promise<TransferCounts> {
  const recordingsById = new Map(payload.recordings.map((r) => [r.id, r]));
  const callsByRecording = new Map<string, ApiCall[]>();
  for (const call of payload.calls) {
    const list = callsByRecording.get(call.recordingId) ?? [];
    list.push(call);
    callsByRecording.set(call.recordingId, list);
  }

  const recs = new Map<string, Recording>();
  const calls = new Map<string, ApiCall>();
  // includeRecording pulls one recording and its calls into the write set —
  // idempotent, so action-dependency and selected recordings dedupe by id.
  const includeRecording = (id: string) => {
    const rec = recordingsById.get(id);
    if (!rec || recs.has(id)) return;
    recs.set(id, rec);
    for (const call of callsByRecording.get(id) ?? []) calls.set(call.id, call);
  };
  if (selection.recordings) {
    for (const rec of payload.recordings) includeRecording(rec.id);
  }
  if (selection.actions) {
    for (const action of payload.actions) includeRecording(action.recordingId);
  }

  await putRecordings([...recs.values()]);
  await putCalls([...calls.values()]);
  if (selection.actions && payload.actions.length > 0) {
    await putActions(payload.actions);
  }
  return {
    actions: selection.actions ? payload.actions.length : 0,
    recordings: recs.size,
    calls: calls.size,
  };
}

/** `manta-data-20260101-120000.json`-style filename stamp. */
function fileStamp(): string {
  const ts = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}` +
    `-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`
  );
}

/** Serialize the payload and trigger a browser download as a .json file. */
export function downloadTransferFile(payload: TransferPayload): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `manta-data-${fileStamp()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
