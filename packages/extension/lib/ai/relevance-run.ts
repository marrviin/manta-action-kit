/**
 * Background-side orchestration of the recording-relevance analysis.
 *
 * Fired fire-and-forget from the STOP_RECORDING handler (never blocks the stop
 * response): load the just-saved recording's calls, classify each one against
 * the whole chain with the laya model (batched predict in the offscreen
 * runtime), and write the marks back into IndexedDB. The pure state-building /
 * verdict logic lives in relevance.ts (unit-tested); this module is the
 * extension-API glue.
 */
import {
  getCalls,
  getRecording,
  setRecordingRelevanceStatus,
  updateCallRelevances,
} from '@/lib/db';
import type { FieldDependency } from '@/lib/recording/types';
import { sendMessage } from '@/lib/messaging';
import { ensureLayaRuntime } from './laya-session';
import { buildRelevanceStates, mergeVerdicts, type RelevanceAnswers } from './relevance';

/** Below this many calls the chain is too small to be worth a model load. */
const MIN_CALLS = 3;

type RelevanceStatus = NonNullable<
  import('@/lib/recording/types').Recording['relevanceStatus']
>;

/** Recordings with an analysis currently in flight (guards the manual re-run
 * button against double-clicks stacking a second model pass). */
const running = new Set<string>();

/** Persist the phase AND broadcast it, so open detail views update live. */
async function reportStatus(recordingId: string, status: RelevanceStatus): Promise<void> {
  await setRecordingRelevanceStatus(recordingId, status).catch((err) =>
    console.error('[relevance] status write failed', err),
  );
  // No listener (detail closed) → the send rejects; that is the normal case.
  await sendMessage('RECORDING_RELEVANCE_STATUS', { recordingId, status }).catch(() => {});
}

/**
 * Analyze one recording's calls and persist per-call relevance marks.
 * Resolves when the marks are in IndexedDB (or throws — the caller decides how
 * to surface the failure; STOP_RECORDING logs it, this module notifies).
 */
export async function analyzeRecordingRelevance(recordingId: string): Promise<void> {
  if (running.has(recordingId)) return;
  running.add(recordingId);
  try {
    await runAnalysis(recordingId);
  } finally {
    running.delete(recordingId);
  }
}

async function runAnalysis(recordingId: string): Promise<void> {
  const [recording, calls] = await Promise.all([
    getRecording(recordingId),
    getCalls(recordingId),
  ]);
  if (!recording) return;
  if (calls.length < MIN_CALLS) return;

  // Persisted + broadcast first, so the detail view shows "analyzing" through
  // the (possibly tens-of-seconds) model load instead of dead air.
  await reportStatus(recordingId, 'analyzing');
  try {
    await ensureLayaRuntime();
    const { states, callIds, questions } = buildRelevanceStates(calls);
    // Relay into the offscreen runtime (same path as LAYA_PREDICT). Batched:
    // one shared forward pass per chunk instead of one pass per call.
    const res = (await sendMessage('LAYA_PREDICT_BATCH', { states, questions })) as {
      ok: boolean;
      results?: Array<Record<string, unknown>>;
      __error?: string;
    };
    if (!res.ok || !res.results) {
      throw new Error(res.__error || 'laya: batch predict failed');
    }
    const entries = mergeVerdicts(
      calls,
      recording.deps as FieldDependency[] | undefined,
      res.results as Array<RelevanceAnswers | null>,
    );
    await updateCallRelevances(recordingId, entries);
  } catch (err) {
    await reportStatus(recordingId, 'failed');
    notifyRelevanceFailed();
    throw err;
  }

  // Tell any open detail view to re-read its calls. No listener (detail closed)
  // → the send rejects; that is the normal case, so swallow it.
  await sendMessage('RECORDING_RELEVANCE_UPDATED', { recordingId }).catch(() => {});
}

/** Best-effort system notification when the analysis could not run. */
function notifyRelevanceFailed(): void {
  chrome.notifications
    .create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('/icon/128.png'),
      title:
        browser.i18n.getMessage('notifyRelevanceFailedTitle') ||
        'Relevance analysis failed',
      message:
        browser.i18n.getMessage('notifyRelevanceFailedMessage') ||
        'The local model could not analyze this recording',
    })
    .catch((err) => console.error('[relevance] notification failed', err));
}
