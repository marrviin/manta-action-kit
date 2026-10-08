/**
 * Offscreen laya runtime — the model lives HERE, not in the side panel or the
 * service worker:
 *
 *  - the MV3 service worker has no WebGPU and idle-terminates after ~30s, so it
 *    cannot host an ONNX session; this document survives both.
 *  - the side panel dies the moment the user closes it — a ~790 MB fp16 model
 *    load must not be repeated (or interrupted) on every panel toggle.
 *
 * The model bundle (fp16 encoder.onnx + head.onnx, ~850 MB of weights, plus
 * tokenizer.json and rl_agent_config.json) is NOT shipped in the extension
 * package. It is downloaded once from the HuggingFace artifacts repo (see
 * MODEL_REPO below) into CacheStorage — the weights are data, not code, so
 * fetching them at runtime is MV3-compliant; the ort runtime itself is
 * bundled locally under public/ort/. `forceCache` routes the weight fetches
 * through CacheStorage (cache-first), so the download happens exactly once
 * and later loads work offline. preloadAgent warms that cache right after
 * install/upgrade (see background.ts) — in dev too, so the download path is
 * exercised on every machine exactly as it will run in production.
 *
 * laya-ts (vendored alongside this file) lazily imports "onnxruntime-web" —
 * which must be a real dependency of the extension package, never a remote
 * load (MV3 forbids remote code; the .wasm assets are bundled by Vite).
 */
import { Agent, type SystemOneResult } from "./index";
import { PINNED_REVISIONS, warmWebCache } from "./providers";
import { sendMessage } from "@/lib/messaging";

/**
 * HuggingFace repo holding the converted (fp16) artifacts the runtime loads.
 * The bundle is the output of scripts/convert-encoder-fp16.py — publish it
 * with scripts/publish-laya-model.sh, then pin the returned commit SHA by
 * adding the repo to PINNED_REVISIONS (lib/ai/providers.ts). Until an entry
 * exists there, `main` is loaded.
 */
const MODEL_REPO = "marrviin/laya-en-fp16";
/** Pinned artifact commit; null loads the repo default (main). */
const MODEL_REVISION = PINNED_REVISIONS[MODEL_REPO] ?? null;

/** The loaded agent — created on first use, then reused for every predict. */
let agent: Agent | null = null;

/** In-flight load, so concurrent first calls share one load (not two ~790MB fp16 reads). */
let loading: Promise<Agent> | null = null;

/** Ensures an Agent exists; concurrent callers await the same load. */
export function getAgent(): Promise<Agent> {
  if (agent) return Promise.resolve(agent);
  if (!loading) {
    loading = (async () => {
      // An install/upgrade warm-up may hold the preloading slot: let it
      // finish first, so this load reads the warm cache instead of racing it
      // with a second parallel download of the same ~850 MB (the first
      // predict to arrive during a download — card warmup, relevance
      // analysis — would otherwise double the transfer). A failed warm-up is
      // not fatal: this load downloads on demand just the same.
      if (preloading) await preloading.catch(() => {});
      const loaded = await Agent.load(MODEL_REPO, {
        revision: MODEL_REVISION,
        // Artifacts come from the network: route the weights through
        // CacheStorage (cache-first), or ort-web would re-fetch ~850 MB on
        // every load — its own sidecar fetches bypass the cache.
        forceCache: true,
      });
      // Cache the loaded agent — without this, isAgentReady() stays false
      // forever and every single predict reloads the ~800 MB bundle.
      agent = loaded;
      // Tell the background: analyses skipped while the artifacts were
      // downloading can run now. Fire-and-forget; no listener (e.g. in unit
      // tests) is fine. Failed loads retry, so this may fire more than once —
      // the handler is a cheap no-op when nothing is queued.
      void sendMessage('LAYA_MODEL_READY', {}).catch(() => {});
      return loaded;
    })().finally(() => {
      loading = null; // a failed load must be retryable
    });
  }
  return loading;
}

/** Whether the model has finished loading at least once (for status display). */
export function isAgentReady(): boolean {
  return agent !== null;
}

/** Whether a load is currently in flight (for status display across contexts). */
export function isAgentLoading(): boolean {
  return loading !== null;
}

/**
 * Cache warm-up, in flight or null. Distinct from `loading`: this only pulls
 * the artifacts into CacheStorage and creates no session.
 */
let preloading: Promise<void> | null = null;

/** Whether an artifact pre-fetch (install/upgrade warm-up) is in flight. */
export function isAgentPreloading(): boolean {
  return preloading !== null;
}

/** Latest warm-up progress snapshot; null before it starts reporting. */
let preloadProgress: { loaded: number; total: number } | null = null;

/** Warm-up download progress, for status display (LAYA_GET_STATUS). */
export function getPreloadProgress(): { loaded: number; total: number } | null {
  return preloadProgress;
}

/**
 * Download the model artifacts into CacheStorage (progress goes to
 * getPreloadProgress for the status UI) — WITHOUT creating a session. No
 * guard of its own: callers own the `preloading` flag (a nested guard would
 * have an inner finally clear an outer in-flight marker).
 */
async function warmArtifacts(): Promise<void> {
  // Best-effort: mark the origin's storage persistent so the browser's
  // disk-pressure eviction is far less likely to drop the ~850 MB cache.
  await navigator.storage?.persist?.()?.catch(() => {});
  await warmWebCache(MODEL_REPO, {
    revision: MODEL_REVISION,
    onProgress: (loaded, total) => {
      preloadProgress = { loaded, total };
    },
  });
}

/**
 * Download the model artifacts into CacheStorage — used by
 * runtime.onStartup to resume a download interrupted by the browser closing
 * mid-way, and by preloadAgent as its first phase. Cache-first: a complete
 * cache makes this a no-op, so no model memory is taken on normal startups.
 *
 * The `preloading` slot holds a WARM-ONLY promise: it must never chain into
 * getAgent. getAgent awaits an in-flight warm-up (to avoid racing its
 * download), so a warm-up that awaited getAgent back would be a deadlock —
 * getAgent waiting on preloading waiting on getAgent (observed live: the
 * settings card's warmup predict during a download spun forever).
 */
export async function warmLayaArtifacts(): Promise<void> {
  if (agent || loading || preloading) return;
  preloading = warmArtifacts().finally(() => {
    preloading = null;
    preloadProgress = null;
  });
  return preloading;
}

/**
 * Warm the artifact cache, then create the session — the full download →
 * load pipeline with no user action (the settings card only displays it).
 * Fired by background.ts on install/upgrade so the model is simply ready by
 * the time anyone needs it. Failures are non-fatal — the lazy load path
 * retries on demand.
 */
export async function preloadAgent(): Promise<void> {
  if (agent) return;
  // Join an already-running warm-up (e.g. a startup resume) instead of
  // starting a second one; nothing to join and no load in flight → start one.
  if (!preloading && !loading) {
    preloading = warmArtifacts().finally(() => {
      preloading = null;
      preloadProgress = null;
    });
  }
  if (preloading) await preloading.catch(() => {});
  // The warm-up released the slot before resolving, and a load that raced us
  // meanwhile makes this a no-op — getAgent dedupes regardless.
  if (agent || loading) return;
  // Session creation runs with no progress reporting (bytes are all in the
  // cache by now) — status shows it as an indeterminate load.
  await getAgent();
}

/**
 * Run one prediction. Loads the model on first call (the UI shows that as a
 * long-running state). Returns the raw laya-ts result plus a wall-clock
 * elapsedMs measured around agent.predict only (excludes model load).
 */
/**
 * Serialize predictions: two concurrent OrtRuns (e.g. the settings card's
 * warmup racing the relevance analysis) would multiply peak GPU/wasm memory in
 * the offscreen document — the process OOMs long before either finishes.
 */
let predictChain: Promise<unknown> = Promise.resolve();
function enqueuePredict<T>(fn: () => Promise<T>): Promise<T> {
  const run = predictChain.then(fn, fn);
  predictChain = run.catch(() => {});
  return run.catch((err) => {
    // An OrtRun OOM can leave the session corrupt — drop it so the next
    // predict reloads a fresh model instead of failing forever.
    if (String((err as Error)?.message ?? err).includes('bad_alloc')) unloadAgent();
    throw err;
  });
}

/**
 * States per shared forward pass. predictBatch packs ALL states into one pass
 * by default — every state carries the chain summary, so a whole recording in
 * one batch is a batch-size × maxLen memory spike that OOMs OrtRun
 * (std::bad_alloc). Small chunks keep the spike bounded; results still align
 * with `states` by index.
 */
const PREDICT_BATCH_SIZE = 8;

export async function layaPredict(
  state: unknown,
  questions: Record<string, unknown>,
): Promise<{ result: SystemOneResult; elapsedMs: number }> {
  return enqueuePredict(async () => {
    const a = await getAgent();
    const t0 = performance.now();
    const result = await a.predict(state, questions as never);
    return { result, elapsedMs: Math.round(performance.now() - t0) };
  });
}

/**
 * Run one prediction per state, packed into shared forward passes
 * (Agent.predictBatch, chunked by PREDICT_BATCH_SIZE). Results align with
 * `states` by index. Used by the recording-relevance analysis, which
 * classifies every captured call in one go.
 */
export async function layaPredictBatch(
  states: unknown[],
  questions: Record<string, unknown>,
): Promise<{ results: SystemOneResult[]; elapsedMs: number }> {
  return enqueuePredict(async () => {
    const a = await getAgent();
    const t0 = performance.now();
    const results = await a.predictBatch(states, questions as never, {
      batchSize: PREDICT_BATCH_SIZE,
    });
    return { results, elapsedMs: Math.round(performance.now() - t0) };
  });
}

/** Drop the loaded model (frees the WASM/WebGPU memory). Next call reloads. */
export function unloadAgent(): void {
  agent = null;
}
