/**
 * Offscreen laya runtime — the model lives HERE, not in the side panel or the
 * service worker:
 *
 *  - the MV3 service worker has no WebGPU and idle-terminates after ~30s, so it
 *    cannot host an ONNX session; this document survives both.
 *  - the side panel dies the moment the user closes it — a ~790 MB fp16 model
 *    load must not be repeated (or interrupted) on every panel toggle.
 *
 * The model bundle (fp16 encoder.onnx + head.onnx, ~900 MB total, plus
 * tokenizer.json and rl_agent_config.json) ships inside the extension package
 * under
 * public/models/laya-en, so `loadWebBundle` fetches it from the extension's own
 * origin (chrome-extension://<id>/models/laya-en) — same-origin, no CORS, and
 * the HTTP cache makes repeat loads cheap.
 *
 * laya-ts (vendored alongside this file) lazily imports "onnxruntime-web" —
 * which must be a real dependency of the extension package, never a remote
 * load (MV3 forbids remote code; the .wasm assets are bundled by Vite).
 */
import { Agent, type SystemOneResult } from "./index";

/** Base URL of the bundled English checkpoint (folder with the 6 model files).
 * WXT copies `public/` to the package root in both dev and build, so the
 * extension-origin URL (`chrome-extension://<id>/models/laya-en/`) is stable —
 * unlike `new URL(..., import.meta.url)`, which under the Vite dev server
 * resolves against `http://localhost:<port>/@fs/...` and 404s. */
const MODEL_URL = new URL('models/laya-en/', browser.runtime.getURL('/')).href;

/** The loaded agent — created on first use, then reused for every predict. */
let agent: Agent | null = null;

/** In-flight load, so concurrent first calls share one load (not two ~790MB fp16 reads). */
let loading: Promise<Agent> | null = null;

/** Ensures an Agent exists; concurrent callers await the same load. */
export function getAgent(): Promise<Agent> {
  if (agent) return Promise.resolve(agent);
  if (!loading) {
    loading = Agent.load(MODEL_URL)
      .then((loaded) => {
        // Cache the loaded agent — without this, isAgentReady() stays false
        // forever and every single predict reloads the ~800 MB bundle.
        agent = loaded;
        return loaded;
      })
      .finally(() => {
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
