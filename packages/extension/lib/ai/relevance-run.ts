/**
 * Background-side orchestration of the post-save laya analysis. Fired
 * fire-and-forget from the STOP_RECORDING handler (never blocks the stop
 * response), it runs three passes in order over one loaded model:
 *
 *   0. stats dynamism    — deterministic, NO model needed (field-dynamism.ts);
 *                          lands first so it survives a failed runtime load.
 *   1. dep-confidence    — per-edge real-vs-coincidence marks (dep-confidence.ts);
 *                          runs BEFORE relevance so mergeVerdicts can consult
 *                          the edge verdicts when applying data-flow anchors.
 *   2. relevance         — per-call noise marks; the headline result. Its
 *                          failure fails the run (status 'failed' + notify).
 *   3. dynamism (model)  — single-observation leaves the stats could not classify.
 *
 * Degradation: laya is an ENHANCEMENT, never a gate. When the model is not
 * ready (still downloading on first install), passes 1–3 are SKIPPED — the
 * run completes with the stats-only marks and status 'skipped', and the
 * recording is queued for an automatic rerun once the model reports ready
 * (LAYA_MODEL_READY → rerunPendingAnalyses). Once the model IS ready, every
 * pass after relevance degrades independently — a failure leaves its marks
 * absent, which every consumer (UI, MCP tools) already reads as "unanalyzed"
 * and renders neutrally. Refinement failures are logged, never fail the run.
 * Pure state-building / verdict logic lives in the sibling modules
 * (unit-tested); this file is the extension-API glue.
 */
import {
  getCalls,
  getRecording,
  setRecordingRelevanceStatus,
  updateCallRelevances,
  updateDepChecks,
  updateFieldDynamism,
} from '@/lib/db';
import type { FieldDependency } from '@/lib/recording/types';
import { sendMessage } from '@/lib/messaging';
import { ensureLayaRuntime } from './laya-session';
import {
  buildDepStates,
  mergeDepChecks,
  type DepAnswers,
} from './dep-confidence';
import {
  buildDynamismBatch,
  computeDynamism,
  mergeDynamismResults,
  type DynamismAnswers,
} from './field-dynamism';
import { buildRelevanceStates, mergeVerdicts, type RelevanceAnswers } from './relevance';

/** Below this many calls the chain is too small to be worth a model load. */
const MIN_CALLS = 3;

type RelevanceStatus = NonNullable<
  import('@/lib/recording/types').Recording['relevanceStatus']
>;

/** Recordings with an analysis currently in flight (guards the manual re-run
 * button against double-clicks stacking a second model pass). */
const running = new Set<string>();

/** Recordings whose analysis was skipped because the model was still
 * downloading; re-run automatically when the model reports ready. In-memory
 * on purpose — a dead SW loses the queue, and the manual re-run button stays
 * as the fallback for anything lost. */
const pendingModelRerun = new Set<string>();

/** True when the offscreen runtime reports a loaded agent. A missing runtime
 * document answers "not ready" without spawning one — probing must not
 * create work. */
async function isModelReady(): Promise<boolean> {
  try {
    const s = await sendMessage('LAYA_GET_STATUS', {});
    return s.ready;
  } catch {
    return false;
  }
}

/** Persist the phase AND broadcast it, so open detail views update live. */
async function reportStatus(recordingId: string, status: RelevanceStatus): Promise<void> {
  await setRecordingRelevanceStatus(recordingId, status).catch((err) =>
    console.error('[relevance] status write failed', err),
  );
  // No listener (detail closed) → the send rejects; that is the normal case.
  await sendMessage('RECORDING_RELEVANCE_STATUS', { recordingId, status }).catch(() => {});
}

/** Relay one batch into the offscreen runtime; results align with `states` by index. */
async function layaBatch(
  states: Array<Record<string, string>>,
  questions: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const res = (await sendMessage('LAYA_PREDICT_BATCH', { states, questions })) as {
    ok: boolean;
    results?: Array<Record<string, unknown>>;
    __error?: string;
  };
  if (!res.ok || !res.results) {
    throw new Error(res.__error || 'laya: batch predict failed');
  }
  return res.results;
}

/**
 * Analyze one recording: stats dynamism, then the relevance + refinement
 * passes. Resolves when the marks are in IndexedDB (or throws on a
 * relevance-level failure — the caller decides how to surface it).
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

  // Pass 0 — stats-only dynamism. Needs no model, so run it before touching
  // laya: even a completely failed runtime load still leaves the recording
  // with the cheap, deterministic half of the signal.
  const dynamism = computeDynamism(calls);
  if (Object.keys(dynamism.statsMarks).length > 0) {
    await updateFieldDynamism(recordingId, dynamism.statsMarks).catch((err) =>
      console.error('[relevance] stats dynamism write failed', err),
    );
  }

  // Model gate — skip, never wait. laya is an enhancement to this flow: while
  // the model is still downloading (first install), finish with the
  // stats-only marks and queue an automatic rerun for when it reports ready.
  // (The recording keeps its 'skipped' status until that rerun lands.)
  if (!(await isModelReady())) {
    pendingModelRerun.add(recordingId);
    await reportStatus(recordingId, 'skipped');
    return;
  }

  // The runtime load gates the model passes. Its failure is the run's failure
  // (the headline relevance result can never exist without it).
  try {
    await ensureLayaRuntime();
  } catch (err) {
    await reportStatus(recordingId, 'failed');
    notifyRelevanceFailed();
    throw err;
  }

  // Pass 1 — dep-confidence. Runs BEFORE relevance on purpose: mergeVerdicts
  // consults each edge's depCheck to decide whether it may anchor its calls as
  // 'relevant' (see mergeVerdicts), so a fresh recording needs its edge marks
  // in place first. Degraded by design: a failure here leaves edges without
  // depCheck — mergeVerdicts then falls back to anchoring every edge (the old,
  // unconditional behavior), never the other way around.
  if (recording.deps?.length) {
    try {
      const { states, edges, questions } = buildDepStates(calls, recording.deps);
      if (states.length > 0) {
        const results = (await layaBatch(states, questions)) as Array<DepAnswers | null>;
        const entries = mergeDepChecks(edges, results);
        if (entries.length > 0) await updateDepChecks(recordingId, entries);
      }
    } catch (err) {
      console.error('[relevance] dep-confidence pass failed', err);
    }
  }

  // Pass 2 — relevance. Its failure is the run's failure (existing semantics).
  try {
    // Interactions were persisted at stop, before this analysis fires — the
    // model gets the user-intent context alongside each call (see
    // buildRelevanceStates; absent interactions simply omit the `intent` key).
    const { states, callIds, questions } = buildRelevanceStates(
      calls,
      recording.interactions,
    );
    // Batched: one shared forward pass per chunk instead of one pass per call.
    const results = await layaBatch(states, questions);
    const entries = mergeVerdicts(
      calls,
      recording.deps as FieldDependency[] | undefined,
      results as Array<RelevanceAnswers | null>,
    );
    await updateCallRelevances(recordingId, entries);
  } catch (err) {
    await reportStatus(recordingId, 'failed');
    notifyRelevanceFailed();
    throw err;
  }

  // Pass 3 — dynamism for the single-observation leaves. Stats marks are
  // already persisted (pass 0); a failure here just leaves those leaves
  // without a model mark.
  if (dynamism.queue.length > 0) {
    try {
      const { states, leaves, questions } = buildDynamismBatch(dynamism.queue);
      const results = (await layaBatch(states, questions)) as Array<DynamismAnswers | null>;
      await updateFieldDynamism(recordingId, mergeDynamismResults(leaves, results));
    } catch (err) {
      console.error('[relevance] field-dynamism pass failed', err);
    }
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

/**
 * Re-run the analyses that were skipped while the model was still
 * downloading. Fired from the LAYA_MODEL_READY notification (the offscreen
 * runtime sends it on every successful model load). One attempt per queued
 * recording — a failure this time drops it from the queue (the manual re-run
 * button in the detail view stays as the fallback); entries already skipped
 * again (model ready flipped back to false) simply re-queue themselves via
 * the normal skip path.
 */
export async function rerunPendingAnalyses(): Promise<void> {
  if (pendingModelRerun.size === 0) return;
  const ids = [...pendingModelRerun];
  pendingModelRerun.clear();
  for (const id of ids) {
    await analyzeRecordingRelevance(id).catch((err) =>
      console.error('[relevance] queued rerun failed', id, err),
    );
  }
}
