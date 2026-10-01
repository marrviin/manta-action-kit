/**
 * Offscreen laya runtime — the model lives HERE, not in the side panel or the
 * service worker:
 *
 *  - the MV3 service worker has no WebGPU and idle-terminates after ~30s, so it
 *    cannot host an ONNX session; this document survives both.
 *  - the side panel dies the moment the user closes it — a 1.6 GB fp32 model load
 *    must not be repeated (or interrupted) on every panel toggle.
 *
 * The model bundle (fp16 encoder.onnx + int8 head.onnx, ~800 MB total, plus
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

/** In-flight load, so concurrent first calls share one load (not two 1.6GB fp32 reads). */
let loading: Promise<Agent> | null = null;

/** Ensures an Agent exists; concurrent callers await the same load. */
export function getAgent(): Promise<Agent> {
  if (agent) return Promise.resolve(agent);
  if (!loading) {
    loading = Agent.load(MODEL_URL).finally(() => {
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
export async function layaPredict(
  state: unknown,
  questions: Record<string, unknown>,
): Promise<{ result: SystemOneResult; elapsedMs: number }> {
  const a = await getAgent();
  const t0 = performance.now();
  const result = await a.predict(state, questions as never);
  return { result, elapsedMs: Math.round(performance.now() - t0) };
}

/** Drop the loaded model (frees the WASM/WebGPU memory). Next call reloads. */
export function unloadAgent(): void {
  agent = null;
}
