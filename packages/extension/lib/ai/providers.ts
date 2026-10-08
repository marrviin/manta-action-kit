/** ONNX session shim: Node (onnxruntime-node) + browser (onnxruntime-web).
 * Lazy imports only — unit tests with a fake provider never touch onnxruntime. */

/** Opt-in reviewed commit SHAs of the published checkpoints (mirror of laya/revisions.py).
 * They are not applied implicitly, so existing Hub/offline caches keep working. */
export const PINNED_REVISIONS: Record<string, string> = {
  "convaiinnovations/laya": "55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851",
  "convaiinnovations/laya-multilingual": "e4e9ddf21a7b1903b7acffd8814ad4307bf63a67",
  "convaiinnovations/laya-typed-decisions": "1a793eb568e6718f15941d08f85432581df534e3",
  // Converted (fp16) browser artifacts published by
  // scripts/publish-laya-model.sh — see lib/ai/runtime.ts.
  "marrviin/laya-en-fp16": "5615e039c15498b42ba2d32b57472bfe7b0bfb8b",
};

/** Return an explicit revision unchanged; otherwise preserve the Hub default and cache. */
export function resolveRevision(_repoOrId: string, revision?: string | null): string | null {
  return revision || null;
}

/** SHA-256 hex via Web Crypto (browsers and modern Node expose globalThis.crypto). */
async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: any } }).crypto?.subtle;
  if (!subtle) {
    throw new Error("laya-ts: SHA-256 verification requires Web Crypto (globalThis.crypto.subtle)");
  }
  const digest = await subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest as ArrayBuffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reject absolute or escaping digest paths before they ever reach the filesystem. */
function normaliseDigestPath(rel: string): string {
  const raw = String(rel).replace(/\\/g, "/");
  if (/^(?:[A-Za-z]:|\/)/.test(raw)) {
    throw new Error(`laya-ts: unsafe absolute path in expectedSha256: ${JSON.stringify(rel)}`);
  }
  const norm = raw;
  if (!norm || norm === ".." || norm.startsWith("../") || norm.includes("/../")) {
    throw new Error(`laya-ts: unsafe path in expectedSha256: ${JSON.stringify(rel)}`);
  }
  return norm;
}

/** Verify `data` against expectedSha256[rel]; artifacts not listed are left unchecked. */
async function expectDigest(
  rel: string,
  data: ArrayBuffer | Uint8Array,
  expected: Record<string, string>,
): Promise<void> {
  const want = expected[rel] ?? expected[normaliseDigestPath(rel)];
  if (want === undefined) return;
  const got = await sha256Hex(data);
  if (got.toLowerCase() !== String(want).trim().toLowerCase()) {
    throw new Error(
      `laya-ts: SHA-256 mismatch for ${rel}: expected ${want}, got ${got}. Refusing to load the artifact.`,
    );
  }
}

export interface Batch {
  inputIds: number[][];
  attentionMask: number[][];
  markerPos: number[][];
  markerMask: boolean[][];
  qtype: number[];
}

export interface SessionProvider {
  runEncoder(batch: Batch): Promise<{ lastHidden: number[][][] }>;
  runHead(hidden: number[][][] | unknown, batch: Batch): Promise<{ logits: number[][]; act: number[][] }>;
}

function toNested(data: ArrayLike<number | bigint | boolean>, dims: number[]): any {
  // Single-pass copy + precomputed steps; no per-node slice/reduce.
  let total = 1;
  for (const d of dims) total *= d;
  const flat = new Array(total);
  for (let i = 0; i < total; i++) {
    const v = (data as any)[i];
    flat[i] = typeof v === "bigint" ? Number(v) : v;
  }
  if (dims.length === 0) return flat[0];
  const steps: number[] = new Array(dims.length);
  for (let d = 0; d < dims.length; d++) {
    let s = 1;
    for (let k = d + 1; k < dims.length; k++) s *= dims[k];
    steps[d] = s;
  }
  const rec = (d: number, off: number): any => {
    if (d === dims.length - 1) return flat.slice(off, off + dims[d]);
    const out: any[] = new Array(dims[d]);
    for (let i = 0; i < dims[d]; i++) out[i] = rec(d + 1, off + i * steps[d]);
    return out;
  };
  return rec(0, 0);
}

function i64(ort: any, arr: number[] | number[][], dims: number[]): any {
  // Rank <= 2 by construction; direct loop avoids flat(Infinity) intermediates.
  const out = new BigInt64Array(dims.reduce((a, b) => a * b, 1));
  let p = 0;
  if (Array.isArray((arr as any)[0])) {
    for (const row of arr as number[][]) for (const v of row) out[p++] = BigInt(Math.trunc(v));
  } else {
    for (const v of arr as number[]) out[p++] = BigInt(Math.trunc(v));
  }
  return new ort.Tensor("int64", out, dims);
}

/** Encoder feeds: input_ids + attention_mask (int64). */
export function feed(ort: any, b: Batch): Record<string, any> {
  const n = b.inputIds.length;
  let L = 1;
  for (const r of b.inputIds) if (r.length > L) L = r.length;
  return {
    input_ids: i64(ort, b.inputIds, [n, L]),
    attention_mask: i64(ort, b.attentionMask, [n, L]),
  };
}

/** Head feeds: encoder hidden + marker_pos/mask + qtype. */
export function feedHead(ort: any, hidden: number[][][] | any, b: Batch): Record<string, any> {
  const n = b.markerPos.length;
  let k = 1;
  for (const r of b.markerPos) if (r.length > k) k = r.length;
  // Direct flatten into typed arrays; no flat(Infinity)+map intermediates.
  const nH = (hidden as any).length ?? n;
  const S = (hidden as any)[0]?.length ?? 1;
  const Hd = (hidden as any)[0]?.[0]?.length ?? 1;
  const flatH = new Float32Array(nH * S * Hd);
  let p = 0;
  for (let i = 0; i < nH; i++) {
    const bi = (hidden as any)[i] ?? [];
    for (let j = 0; j < S; j++) {
      const hj = bi[j] ?? [];
      for (let h = 0; h < Hd; h++) flatH[p++] = Number(hj[h] ?? 0);
    }
  }
  const H = new ort.Tensor("float32", flatH, [nH, S, Hd]);
  // Pad/trim mask rows to S so the mask always matches hidden_states even
  // if a caller passes unpadded rows.
  const maskRows = b.attentionMask.map((r) => {
    const row = r.slice(0, S);
    while (row.length < S) row.push(0);
    return row;
  });
  return {
    hidden_states: H,
    marker_pos: i64(ort, b.markerPos, [n, k]),
    marker_mask: new ort.Tensor("bool", (() => {
      const out = new Uint8Array(n * k);
      let q = 0;
      for (const row of b.markerMask as unknown as boolean[][])
        for (let j = 0; j < k; j++) out[q++] = row[j] ? 1 : 0;
      return out;
    })(), [n, k]),
    qtype: i64(ort, b.qtype.map((v) => [v]), [n, 1]),
    // Padding mask for the head transformer (py DecisionModel.forward).
    // Without it, batch mates of unequal length corrupt each other's markers.
    attention_mask: i64(ort, maskRows, [n, S]),
  };
}

function pickOutput(out: Record<string, any>, names: string[]): any {
  for (const n of names) if (out[n] !== undefined) return out[n];
  const vals = Object.values(out);
  return vals[0];
}

export interface ProviderOptions {
  device?: string;
  numThreads?: number;
  /** Opt-in {artifact name: SHA-256 hexdigest} check for fetched ONNX files (web). */
  expectedSha256?: Record<string, string>;
  signal?: AbortSignal | null;
  onProgress?: ((done: number, total: number, file: string) => void) | null;
  /**
   * Web only: fetch the ONNX artifacts through the CacheStorage-backed path
   * (cache-first) and create the sessions from the buffered bytes, instead of
   * handing ort-web the raw URLs. Required when the artifacts come from the
   * network (HuggingFace) — ort-web's own sidecar fetches bypass CacheStorage,
   * so without this every load would re-download the ~850 MB from the CDN.
   */
  forceCache?: boolean;
}

function applyNumThreads(ort: any, numThreads?: number): void {
  try {
    const raw =
      numThreads ??
      (typeof process !== "undefined" ? Number((process as any).env?.["LAYA_THREADS"]) : NaN);
    if (!Number.isFinite(raw) || (raw as number) <= 0 || !ort?.env) return;
    // The knob lives on env.wasm (env.numThreads does not exist) — setting the
    // wrong path silently left the runtime at its default.
    ort.env.wasm.numThreads = Math.trunc(raw as number);
  } catch {
    /* best-effort only */
  }
}

function isOomError(e: unknown): boolean {
  const m = String((e as any)?.message ?? e).toLowerCase();
  return m.includes("memory") || m.includes("cuda") || m.includes("out of memory") || m.includes("oom");
}

const CACHE_KEY = "laya-ts";
const TOKENIZER_CANDIDATES = ["tokenizer.json", "tokenizer/tokenizer.json"];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** fetch with 2 retries on network errors + 429/5xx; 404s fail fast. */
async function fetchWithRetry(url: string, init?: RequestInit, retries = 2): Promise<Response> {
  let last: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(100 * (attempt + 1));
        continue;
      }
      return res;
    } catch (e) {
      last = e;
      if ((e as any)?.name === "AbortError") throw e;
      if (attempt < retries) {
        await sleep(100 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw last instanceof Error ? last : new Error(`fetch failed for ${url}`);
}

/**
 * Online-first fetch: try network, cache on success, fall back to CacheStorage.
 * `preferCache` inverts this for the huge model weights: a cached copy is
 * returned WITHOUT touching the network, so an already-downloaded checkpoint
 * (~850 MB) survives extension updates and offline use; only a cache miss
 * goes online (and is then cached).
 */
async function fetchArrayBuffer(
  url: string,
  opts?: {
    signal?: AbortSignal | null;
    onHeaders?: (response: Response) => void;
    preferCache?: boolean;
  },
): Promise<ArrayBuffer> {
  const g = globalThis as unknown as { caches?: any };
  let cache: any = null;
  let hit: any = null;
  try {
    if (g.caches && typeof g.caches.open === "function") {
      try {
        cache = await g.caches.open(CACHE_KEY);
        try {
          hit = await cache.match(url);
        } catch {
          hit = null;
        }
      } catch {
        cache = null;
      }
    }
  } catch {
    cache = null;
  }
  if (cache) {
    if (hit && opts?.preferCache) {
      try {
        return await hit.arrayBuffer();
      } catch {
        /* stale/blocked entry — fall through to the network path */
      }
    }
    try {
      const res = await fetchWithRetry(url, { signal: opts?.signal ?? undefined });
      opts?.onHeaders?.(res);
      if (res.ok) {
        try {
          await cache.put(url, res.clone());
        } catch {
          /* cache full/blocked: still return network bytes */
        }
        return await res.arrayBuffer();
      }
    } catch (e) {
      if (hit) {
        try {
          return await hit.arrayBuffer();
        } catch {
          /* fall through to throw original */
        }
      }
      throw e;
    }
    if (hit) {
      try {
        return await hit.arrayBuffer();
      } catch {
        /* fall through to direct error below */
      }
    }
    throw new Error(`fetch failed for ${url}`);
  }
  const res = await fetchWithRetry(url, { signal: opts?.signal ?? undefined });
  opts?.onHeaders?.(res);
  if (!res.ok) throw new Error(`fetch failed for ${url}: ${res.status}`);
  return await res.arrayBuffer();
}

export interface NodeBundle {
  dir: string;
  cfg: any;
  tokenizerJson: unknown | null;
  /** Commit SHA the artifacts came from (pinned/requested, or the hub's `x-repo-commit`); null for local dirs. */
  revision: string | null;
}

export async function loadNodeBundle(
  modelDirOrRepo: string,
  opts?: {
    subfolder?: string | null;
    localDir?: string;
    token?: string | null;
    revision?: string | null;
    expectedSha256?: Record<string, string>;
    signal?: AbortSignal | null;
    onProgress?: ((done: number, total: number, file: string) => void) | null;
  },
): Promise<NodeBundle> {
  const fs: typeof import("node:fs/promises") = await import("node:fs/promises");
  const path: typeof import("node:path") = await import("node:path");
  const os: typeof import("node:os") = await import("node:os");
  const sub = opts?.subfolder ?? null;
  let dir = opts?.localDir ?? modelDirOrRepo;
  let resolvedRevision: string | null = null;
  try {
    const st = await fs.stat(sub ? path.join(dir, sub) : dir);
    if (st.isDirectory()) dir = sub ? path.join(dir, sub) : dir;
    else dir = path.dirname(dir);
  } catch {
    // An explicit revision joins the cache key so differently-pinned artifacts never collide;
    // otherwise the existing Hub-default cache is reused.
    const revision = resolveRevision(modelDirOrRepo, opts?.revision);
    resolvedRevision = revision;
    const cache = path.join(
      os.homedir(),
      ".cache",
      "laya-ts",
      "hf",
      modelDirOrRepo.replace(/\//g, "__"),
      sub ?? "root",
      ...(revision && revision !== "main" ? [revision] : []),
    );
    await fs.mkdir(cache, { recursive: true });
    const token =
      opts?.token ?? (typeof process !== "undefined" ? (process as any).env?.["HF_TOKEN"] : undefined);
    const files = ["rl_agent_config.json", "tokenizer.json", "tokenizer/tokenizer.json", "encoder.onnx", "head.onnx"];
    let done = 0;
    for (const f of files) {
      try {
        await fs.stat(path.join(cache, f));
      } catch {
        const url = `https://huggingface.co/${modelDirOrRepo}/resolve/${revision ?? "main"}/${sub ? sub + "/" : ""}${f}`;
        const res = await fetchWithRetry(
          url,
          {
            ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
            signal: opts?.signal ?? undefined,
          },
        );
        const commit = res.headers?.get?.("x-repo-commit");
        if (commit) resolvedRevision = commit;
        if (!res.ok) {
          if (f === "rl_agent_config.json") {
            throw new Error(
              `Incompatible model: ${JSON.stringify(modelDirOrRepo)} does not contain 'rl_agent_config.json'.`,
            );
          }
          continue;
        }
        const target = path.join(cache, f);
        await fs.mkdir(path.dirname(target), { recursive: true });
        // Write-then-rename so an interrupted download never leaves a truncated
        // artifact that later loads treat as complete.
        const tmp = `${target}.tmp-${typeof process !== "undefined" ? process.pid : 0}`;
        await fs.writeFile(tmp, new Uint8Array(await res.arrayBuffer()));
        await fs.rename(tmp, target);
      }
      done++;
      opts?.onProgress?.(done, files.length, f);
    }
    dir = cache;
  }
  // Opt-in integrity check over the resolved directory (covers local dirs, warm cache,
  // and fresh downloads alike) before any artifact is parsed or executed.
  if (opts?.expectedSha256) {
    const { createHash } = await import("node:crypto");
    for (const [rel, want] of Object.entries(opts.expectedSha256)) {
      const norm = normaliseDigestPath(rel);
      let buf: Uint8Array;
      try {
        buf = new Uint8Array(await fs.readFile(path.join(dir, norm)));
      } catch {
        throw new Error(`laya-ts: cannot verify ${JSON.stringify(rel)}: not found under ${dir}`);
      }
      const got = createHash("sha256").update(buf).digest("hex");
      if (got.toLowerCase() !== String(want).trim().toLowerCase()) {
        throw new Error(
          `laya-ts: SHA-256 mismatch for ${rel}: expected ${want}, got ${got}. Refusing to load the artifact.`,
        );
      }
    }
  }
  let cfg: any = {};
  try {
    cfg = JSON.parse(await fs.readFile(path.join(dir, "rl_agent_config.json"), "utf8"));
  } catch {
    throw new Error(
      `Incompatible model: ${JSON.stringify(modelDirOrRepo)} does not contain 'rl_agent_config.json'.`,
    );
  }
  let tokenizerJson: unknown | null = null;
  for (const candidate of TOKENIZER_CANDIDATES) {
    try {
      tokenizerJson = JSON.parse(await fs.readFile(path.join(dir, candidate), "utf8"));
      break;
    } catch {
      // Try the next supported Hugging Face layout.
    }
  }
  return { dir, cfg, tokenizerJson, revision: resolvedRevision };
}

export interface WebBundle {
  dir: string;
  cfg: any;
  tokenizerJson: unknown | null;
  /** Pinned/requested commit SHA, if any (full-URL sources have no implicit revision). */
  revision: string | null;
}

function baseUrlFor(repoOrUrl: string, subfolder?: string | null, revision?: string | null): string {
  const sub = subfolder ? `/${subfolder.replace(/^\/+|\/+$/g, "")}` : "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(repoOrUrl)) {
    return `${repoOrUrl.replace(/\/+$/, "")}${sub}`;
  }
  return `https://huggingface.co/${repoOrUrl}/resolve/${revision ?? "main"}${sub}`;
}

export async function loadWebBundle(
  repoOrUrl: string,
  opts?: {
    subfolder?: string | null;
    revision?: string | null;
    expectedSha256?: Record<string, string>;
    signal?: AbortSignal | null;
    onProgress?: ((done: number, total: number, file: string) => void) | null;
  },
): Promise<WebBundle> {
  const revision = resolveRevision(repoOrUrl, opts?.revision);
  const base = baseUrlFor(repoOrUrl, opts?.subfolder ?? null, revision);
  let reportedRevision = revision;
  const fetchVerifiedJson = async (rel: string): Promise<unknown> => {
    const buf = await fetchArrayBuffer(`${base}/${rel}`, {
      signal: opts?.signal ?? undefined,
      onHeaders: (response) => {
        const commit = response.headers?.get?.("x-repo-commit");
        if (commit) reportedRevision = commit;
      },
    });
    if (opts?.expectedSha256) await expectDigest(rel, buf, opts.expectedSha256);
    return JSON.parse(new TextDecoder().decode(buf));
  };
  let cfg: any;
  try {
    cfg = await fetchVerifiedJson("rl_agent_config.json");
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("laya-ts: SHA-256 mismatch")) throw e;
    if ((e as Error)?.name === "AbortError") throw e;
    throw new Error(`Incompatible model: ${JSON.stringify(repoOrUrl)} does not contain 'rl_agent_config.json'.`);
  }
  opts?.onProgress?.(1, 2, "rl_agent_config.json");
  let tokenizerJson: unknown | null = null;
  for (const candidate of TOKENIZER_CANDIDATES) {
    try {
      tokenizerJson = await fetchVerifiedJson(candidate);
      break;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("laya-ts: SHA-256 mismatch")) throw e;
      // Try the next supported Hugging Face layout.
    }
  }
  opts?.onProgress?.(2, 2, "tokenizer.json");
  return { dir: base, cfg, tokenizerJson, revision: reportedRevision };
}

/**
 * Streaming, cache-first download used by warmWebCache: reports received
 * bytes (for progress UI) and lands the file in CacheStorage. A cache hit
 * reports the entry's full size once and skips the network entirely.
 *
 * Single-consumer read: the body is read to completion while counting bytes,
 * THEN committed to the cache in one shot. Interleaving two consumers of the
 * same network stream (tee/clone — one into cache.put, one counting) deadlocks
 * on large responses in Chrome, stalling the download forever.
 *
 * A watchdog aborts when no bytes arrive for STALL_TIMEOUT_MS — a silent
 * mid-body network stall would otherwise hang the warm-up indefinitely.
 */
const STALL_TIMEOUT_MS = 30_000;

/** Attempts per file within fetchIntoCacheWithProgress (range-resumed). */
const MAX_FILE_ATTEMPTS = 5;

/**
 * Streaming, cache-first download with byte-accurate progress AND resumable
 * retries: a failed attempt (watchdog stall, proxy reset) resumes from the
 * offset it died at via `Range: bytes=<offset>-` — HF's CDN supports ranges,
 * so a restart never re-downloads bytes that already arrived. Only a server
 * that ignores the Range request (200 instead of 206) falls back to a full
 * restart. On completion the file is committed to CacheStorage in one shot.
 *
 * Single-consumer read: the body is read to completion while counting bytes.
 * Interleaving two consumers of the same network stream (tee/clone) deadlocks
 * on large responses in Chrome.
 */
async function fetchIntoCacheWithProgress(
  url: string,
  onBytes: (n: number) => void,
  signal?: AbortSignal | null,
): Promise<void> {
  const g = globalThis as unknown as { caches?: any };
  let cache: any = null;
  try {
    cache = g.caches && typeof g.caches.open === "function" ? await g.caches.open(CACHE_KEY) : null;
  } catch {
    cache = null;
  }
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) {
        try {
          onBytes(Number((await hit.blob())?.size) || 0);
          return;
        } catch {
          /* stale entry — fall through to the network path */
        }
      }
    } catch {
      /* fall through */
    }
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (let attempt = 0; ; attempt++) {
    if (attempt >= MAX_FILE_ATTEMPTS) {
      throw new Error(`fetch failed for ${url} after ${attempt} attempts`);
    }
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    // Merge the caller's signal with the stall watchdog's. Armed BEFORE the
    // fetch too: a connection that hangs waiting for response headers (proxy/
    // CDN black hole) must not stall outside the read loop unprotected.
    const ctrl = new AbortController();
    const onOuterAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    let stall: ReturnType<typeof setTimeout> | null = null;
    const armStall = () => {
      if (stall) clearTimeout(stall);
      stall = setTimeout(() => ctrl.abort(), STALL_TIMEOUT_MS);
    };
    try {
      armStall();
      const headers = new Headers();
      if (received > 0) headers.set("Range", `bytes=${received}-`);
      const res = await fetchWithRetry(url, { signal: ctrl.signal, headers });
      if (received > 0 && res.status === 200) {
        // Server ignored the Range request and restarted the file — drop what
        // we had so the byte counts line up again.
        chunks.length = 0;
        received = 0;
        onBytes(0);
      }
      if (!res.ok && res.status !== 206) {
        throw new Error(`fetch failed for ${url}: ${res.status}`);
      }
      // What a complete body should total: a 206 carries only the remaining
      // bytes, a 200 the whole file. A short body (server closed "cleanly"
      // mid-range) must NOT be cached as if it were the full file.
      const rangeLen = Number(res.headers?.get?.("content-length")) || 0;
      const expectTotal = res.status === 206 ? received + rangeLen : rangeLen;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          armStall();
          chunks.push(value);
          received += value.byteLength;
          // Cumulative for THIS file — the caller adds the already-completed
          // files' sizes.
          onBytes(received);
        }
      } else {
        const buf = await res.arrayBuffer();
        chunks.push(new Uint8Array(buf));
        received += buf.byteLength;
        onBytes(received);
      }
      if (expectTotal > 0 && received < expectTotal) {
        throw new Error(`short body for ${url}: ${received}/${expectTotal}`);
      }
      if (cache) {
        try {
          // Rebuild with just the content-type: carrying the original
          // content-length/encoding headers into a re-wrapped body can make
          // later reads of the entry fail validation.
          const putHeaders = new Headers();
          const type = res.headers?.get?.("content-type");
          if (type) putHeaders.set("content-type", type);
          await cache.put(
            url,
            new Response(new Blob(chunks as unknown as BlobPart[]), {
              status: 200,
              headers: putHeaders,
            }),
          );
        } catch {
          /* cache full/blocked — the download itself still succeeded */
        }
      }
      return;
    } catch (e) {
      // Keep `chunks`/`received`: the next attempt resumes from this offset.
      if (signal?.aborted) throw e;
      await sleep(1000 * Math.min(attempt, 3));
    } finally {
      if (stall) clearTimeout(stall);
      if (signal) signal.removeEventListener("abort", onOuterAbort);
    }
  }
}

/**
 * Download every artifact of a web checkpoint into the CacheStorage cache
 * (cache-first: an entry already present is reused, never re-downloaded)
 * WITHOUT creating any ONNX session — used by the extension to pre-fetch the
 * ~850 MB laya weights on install/upgrade, so the first real predict skips the
 * download. The artifacts and URLs match what `loadWebBundle` +
 * `createWebProvider({ forceCache: true })` read later, so a warmed cache makes
 * those loads fully offline.
 *
 * `onProgress` reports cumulative (loadedBytes, totalBytes) across all files,
 * plus the file currently being downloaded. Sizes come from HEAD requests
 * before the downloads start; a file whose size cannot be determined just
 * contributes 0 to the total. Tokenizer candidates are tolerated to 404 (repo
 * layout varies); the config and weight files are required — the first
 * failure rejects.
 */
export async function warmWebCache(
  repoOrUrl: string,
  opts?: {
    subfolder?: string | null;
    revision?: string | null;
    signal?: AbortSignal | null;
    onProgress?: ((loadedBytes: number, totalBytes: number, file: string) => void) | null;
  },
): Promise<void> {
  const revision = resolveRevision(repoOrUrl, opts?.revision);
  const base = baseUrlFor(repoOrUrl, opts?.subfolder ?? null, revision);
  const progress = opts?.onProgress ?? null;
  const headSize = async (rel: string): Promise<number> => {
    try {
      const res = await fetchWithRetry(`${base}/${rel}`, { method: "HEAD", signal: opts?.signal ?? undefined });
      return Number(res.headers?.get?.("content-length")) || 0;
    } catch {
      return 0;
    }
  };
  // Resolve the tokenizer candidate (repo layouts vary), then size every file
  // with a HEAD pass so the progress UI gets a real total before downloading.
  let tokenizerRel: string | null = null;
  for (const candidate of TOKENIZER_CANDIDATES) {
    try {
      const res = await fetchWithRetry(`${base}/${candidate}`, { method: "HEAD", signal: opts?.signal ?? undefined });
      if (res.ok) {
        tokenizerRel = candidate;
        break;
      }
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
    }
  }
  if (!tokenizerRel) {
    throw new Error(`warmWebCache: no tokenizer found under ${base}`);
  }
  const files = [tokenizerRel, "rl_agent_config.json", "encoder.onnx", "encoder.onnx.data", "head.onnx", "head.onnx.data"];
  const sized = await Promise.all(
    files.map(async (rel) => ({ rel, total: await headSize(rel) })),
  );
  const totalBytes = sized.reduce((a, f) => a + f.total, 0);
  let loadedBytes = 0;
  for (const { rel, total } of sized) {
    // fetchIntoCacheWithProgress owns the retries — range-resumed, so a
    // mid-file failure continues where it died instead of restarting.
    await fetchIntoCacheWithProgress(
      `${base}/${rel}`,
      (n) => progress?.(loadedBytes + n, totalBytes, rel),
      opts?.signal ?? undefined,
    );
    loadedBytes += total;
    progress?.(loadedBytes, totalBytes, rel);
  }
}

export async function createNodeProvider(
  modelDir: string,
  opts?: ProviderOptions,
): Promise<SessionProvider> {
  const spec = "onnxruntime-" + "node";
  const ort: any = await import(/* @vite-ignore */ spec);
  applyNumThreads(ort, opts?.numThreads);
  const fs: typeof import("node:fs/promises") = await import("node:fs/promises");
  const path: typeof import("node:path") = await import("node:path");
  for (const f of ["encoder.onnx", "head.onnx"]) {
    const p = path.join(modelDir, f);
    try {
      await fs.stat(p);
    } catch {
      throw new Error(`Incompatible model: '${f}' not found in ${JSON.stringify(modelDir)} (expected ${p}).`);
    }
    if (opts?.expectedSha256) await expectDigest(f, await fs.readFile(p), opts.expectedSha256);
  }
  const dev = String(opts?.device ?? "cpu").toLowerCase();
  const want = dev === "cuda" ? "cuda" : dev === "dml" ? "dml" : "cpu";
  const make = async (ep: string) => {
    const e = await ort.InferenceSession.create(`${modelDir}/encoder.onnx`, {
      executionProviders: [ep],
    });
    const h = await ort.InferenceSession.create(`${modelDir}/head.onnx`, {
      executionProviders: ["cpu"],
    });
    return { e, h };
  };
  let enc: any;
  let head: any;
  let activeEP = want;
  try {
    ({ e: enc, h: head } = await make(want));
  } catch (e) {
    if (want !== "cpu") {
      console.warn(`Warning: ${want.toUpperCase()} requested but not available. Falling back to CPU.`);
      ({ e: enc, h: head } = await make("cpu"));
      activeEP = "cpu";
    } else {
      throw e;
    }
  }
  let cpuEnc: any = null;
  let cpuHead: any = null;
  const ensureCpu = async () => {
    if (!cpuEnc) {
      cpuEnc = await ort.InferenceSession.create(`${modelDir}/encoder.onnx`, {
        executionProviders: ["cpu"],
      });
      cpuHead = await ort.InferenceSession.create(`${modelDir}/head.onnx`, {
        executionProviders: ["cpu"],
      });
    }
    return { cpuEnc, cpuHead };
  };
  const runWithCpuFallback = async <T>(fn: (e: any, h: any) => Promise<T>): Promise<T> => {
    try {
      return await fn(enc, head);
    } catch (e) {
      if (activeEP !== "cpu" && isOomError(e)) {
        console.warn("Warning: GPU memory exceeded during inference. Falling back to CPU...");
        const { cpuEnc: ce, cpuHead: ch } = await ensureCpu();
        enc = ce;
        head = ch;
        activeEP = "cpu";
        return await fn(enc, head);
      }
      if (isOomError(e)) {
        throw new Error(`${(e as Error).message} (GPU out of memory; try device: "cpu")`);
      }
      throw e;
    }
  };
  return {
    runEncoder: async (b) =>
      runWithCpuFallback(async (e) => {
        const out = await e.run(feed(ort, b));
        const t = pickOutput(out, ["last_hidden_state", "lastHidden", "hidden_states"]);
        return { lastHidden: toNested(t.data, t.dims) };
      }),
    runHead: async (h, b) =>
      runWithCpuFallback(async (_e, hd) => {
        const out = await hd.run(feedHead(ort, h, b));
        const vals = Object.values(out) as any[];
        const lt = pickOutput(out, ["logits"]);
        const at = pickOutput(out, ["act_logits", "act"]) ?? vals[1] ?? vals[0];
        return { logits: toNested(lt.data, lt.dims), act: toNested(at.data, at.dims) };
      }),
  };
}

/** Best-effort fetch of a `<model>.data` sidecar; null when the model is single-file. */
async function fetchSidecar(
  url: string,
  opts?: { signal?: AbortSignal | null; preferCache?: boolean },
): Promise<{ path: string; data: Uint8Array } | null> {
  const name = `${url.split("/").pop()}.data`;
  const sidecarUrl = `${url.replace(/\/+$/, "").split("/").slice(0, -1).join("/")}/${name}`;
  try {
    const buf = await fetchArrayBuffer(sidecarUrl, {
      signal: opts?.signal ?? undefined,
      preferCache: opts?.preferCache,
    });
    return { path: name, data: new Uint8Array(buf) };
  } catch {
    return null;
  }
}

export async function createWebProvider(
  modelUrl: string,
  opts?: ProviderOptions,
): Promise<SessionProvider> {
  // Static (non-templated) import so the bundler can resolve it — the
  // upstream `import("onnxruntime-" + "web")` with @vite-ignore stays a bare
  // runtime import, which cannot resolve inside the extension package.
  const ort: any = await import(
    /* webpackIgnore: false */ "onnxruntime-web"
  );
  applyNumThreads(ort, opts?.numThreads);
  if (opts?.numThreads == null) {
    // No explicit choice: use half the cores (capped) instead of ort-web's
    // conservative default — inference on wasm scales with threads.
    const cores = (globalThis as any).navigator?.hardwareConcurrency ?? 4;
    ort.env.wasm.numThreads = Math.max(1, Math.min(8, Math.floor(cores / 2)));
  }
  const base = modelUrl.replace(/\/+$/, "");
  const encUrl = `${base}/encoder.onnx`;
  const headUrl = `${base}/head.onnx`;
  // MV3 CSP (`script-src 'self'`) forbids script imports from blob:, which is
  // exactly what ort-web falls back to when its wasm-loader .mjs is
  // cross-origin — and multithreaded wasm ALWAYS preloads cross-origin .mjs
  // via a blob (dev server) → "Failed to fetch dynamically imported module:
  // blob:chrome-extension://…". Serve the loader + binary from the extension's
  // own public/ort/ so the import is same-origin ('self' → allowed) in both
  // dev and build. Node (tests) has no runtime origin and skips this.
  const runtimeOrigin =
    (globalThis as any).browser?.runtime?.getURL ??
    (globalThis as any).chrome?.runtime?.getURL;
  if (runtimeOrigin) {
    ort.env.wasm.wasmPaths = {
      mjs: new URL("ort/ort-wasm-simd-threaded.jsep.mjs", runtimeOrigin("/")).href,
    };
  }
  // "Buffered" mode needs the raw bytes: to verify them (expectedSha256) or to
  // route them through CacheStorage (forceCache) — see ProviderOptions. In both
  // cases the model is mounted from bytes and its `.onnx.data` sidecar
  // explicitly. Without it, create straight from the URL. NOTE: even in URL
  // mode the sidecar must be declared via the `externalData` option — ort-web
  // (≥1.2x) only fetches external data when it is listed there; otherwise the
  // wasm falls back to its legacy Module.MountedFiles mechanism and creation
  // fails with "Module.MountedFiles is not available". `path` must match the
  // location recorded inside the ONNX proto (a bare filename); `data` is what
  // ort fetches (the absolute URL).
  const verify = opts?.expectedSha256 != null;
  const buffered = verify || opts?.forceCache === true;
  const preferCache = opts?.forceCache === true;
  type SessionSource = { source: string | Uint8Array; extra: Record<string, unknown> };
  const urlSidecar = (modelUrl: string) => ({
    path: `${modelUrl.split("/").pop()}.data`,
    data: `${modelUrl}.data`,
  });
  const encParts = async (): Promise<SessionSource> => {
    if (!buffered) return { source: encUrl, extra: { externalData: [urlSidecar(encUrl)] } };
    const buf = await fetchArrayBuffer(encUrl, { signal: opts?.signal ?? undefined, preferCache });
    const sidecar = await fetchSidecar(encUrl, { signal: opts?.signal ?? undefined, preferCache });
    return { source: new Uint8Array(buf), extra: sidecar ? { externalData: [sidecar] } : {} };
  };
  const headParts = async (): Promise<SessionSource> => {
    if (!buffered) return { source: headUrl, extra: { externalData: [urlSidecar(headUrl)] } };
    const buf = await fetchArrayBuffer(headUrl, { signal: opts?.signal ?? undefined, preferCache });
    const sidecar = await fetchSidecar(headUrl, { signal: opts?.signal ?? undefined, preferCache });
    return { source: new Uint8Array(buf), extra: sidecar ? { externalData: [sidecar] } : {} };
  };
  let enc: any;
  const createEnc = async (eps: string[], basic: boolean) => {
    const p = await encParts();
    return ort.InferenceSession.create(p.source, {
      executionProviders: eps,
      // "basic" skips the Skip+LayerNorm fusion whose fused Beta shape the
      // WebGPU kernel rejects; unfused LayerNormalization runs fine on GPU.
      ...(basic ? { graphOptimizationLevel: "basic" } : {}),
      ...p.extra,
    });
  };
  let encBackend = "webgpu";
  try {
    enc = await createEnc(["webgpu", "wasm"], true);
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    // WebGPU session creation failed (or the artifact 404'd) — retry on WASM.
    encBackend = "wasm";
    try {
      enc = await createEnc(["wasm"], false);
    } catch {
      throw new Error(
        `Incompatible model: 'encoder.onnx' could not be loaded from ${encUrl}: ${String((e as Error)?.message ?? e)}`,
      );
    }
  }
  console.info(
    `[laya] encoder session on ${encBackend}, ${ort.env.wasm.numThreads} wasm thread(s)`,
  );
  opts?.onProgress?.(1, 2, "encoder.onnx");
  let head: any;
  try {
    const p = await headParts();
    head = await ort.InferenceSession.create(p.source, {
      executionProviders: ["wasm"],
      ...p.extra,
    });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new Error(
      `Incompatible model: 'head.onnx' could not be loaded from ${headUrl}: ${String((e as Error)?.message ?? e)}`,
    );
  }
  opts?.onProgress?.(2, 2, "head.onnx");
  // Lazy WASM encoder: some graphs pass WebGPU session creation but hit an
  // unsupported kernel at run time (e.g. SkipLayerNormalization shape gaps).
  // On the first such failure we build a WASM session and stick with it.
  let encWasm: any = null;
  const runEncoderOn = async (session: any, b: Batch) => {
    const out = await session.run(feed(ort, b));
    const t = pickOutput(out, ["last_hidden_state", "lastHidden", "hidden_states"]);
    return { lastHidden: toNested(t.data, t.dims) };
  };
  return {
    runEncoder: async (b) => {
      if (encWasm) {
        try {
          return await runEncoderOn(encWasm, b);
        } catch (e) {
          if (isOomError(e)) throw new Error(`${(e as Error).message} (out of memory; try fewer questions per call)`);
          throw e;
        }
      }
      try {
        return await runEncoderOn(enc, b);
      } catch (e) {
        if (isOomError(e)) throw new Error(`${(e as Error).message} (WebGPU out of memory; WASM fallback already active)`);
        if (/\[webgpu\]/i.test(String((e as Error)?.message ?? e))) {
          console.warn(
            `laya: WebGPU encoder run failed (${String((e as Error)?.message ?? e)}); falling back to WASM.`,
          );
          if (!encWasm) {
            // URL mode re-fetches from the (disk-backed) extension origin;
            // verify mode re-reads through CacheStorage — either way nothing
            // is pinned in JS memory for the agent's life.
            try {
              const p = await encParts();
              encWasm = await ort.InferenceSession.create(p.source, {
                executionProviders: ["wasm"],
                ...p.extra,
              });
              console.info("[laya] WebGPU encoder run failed at runtime; switched to WASM session");
            } catch {
              throw e;
            }
          }
          try {
            return await runEncoderOn(encWasm, b);
          } catch (e2) {
            if (isOomError(e2)) throw new Error(`${(e2 as Error).message} (out of memory; try fewer questions per call)`);
            throw e2;
          }
        }
        throw e;
      }
    },
    runHead: async (h, b) => {
      try {
        const out = await head.run(feedHead(ort, h, b));
        const vals = Object.values(out) as any[];
        const lt = pickOutput(out, ["logits"]);
        const at = pickOutput(out, ["act_logits", "act"]) ?? vals[1] ?? vals[0];
        return { logits: toNested(lt.data, lt.dims), act: toNested(at.data, at.dims) };
      } catch (e) {
        if (isOomError(e)) throw new Error(`${(e as Error).message} (out of memory; try fewer questions per call)`);
        throw e;
      }
    },
  };
}
