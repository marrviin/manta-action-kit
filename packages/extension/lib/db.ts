/**
 * Minimal IndexedDB wrapper for manta-action-kit.
 *
 * Object stores:
 *  - `recordings`: recording metadata for the list view (keyed by id).
 *  - `calls`: individual API calls (keyed by id, indexed by recordingId + seq).
 *  - `gatewayLogs`: gateway audit-log entries (keyed by id, indexed by time).
 *  - `gatewayProxyRules`: proxy rules for the script-driven gateway entry (keyed by id).
 *  - `actions`: agent-authored replayable action sequences (v10, keyed by id,
 *     indexed by recordingId so deleting a recording cascades to its actions).
 *
 * The `cookieRules` / `cachedCookies` stores (v2) were removed in v4; the
 * `gatewayDomains` store (v3) was removed in v7 when the domain-whitelist model
 * was retired. The upgrade handler deletes them so no stale data lingers on disk.
 *
 * No third-party dependency — the native IndexedDB API is enough for our access
 * patterns (bulk insert on save, read-by-recording on detail, delete cascade).
 */
import type { ApiCall, Recording } from "./recording/types";
import type { GatewayLog, GatewayProxyRule } from "./gateway/types";
import type { Action } from "./action/types";

const DB_NAME = "manta-action-kit";
// v9: replay feature removed; drop the replayRuns store (added in v8).
// v10: action feature; new `actions` store (agent-authored replayable sequences).
const DB_VERSION = 10;
const STORE_RECORDINGS = "recordings";
const STORE_CALLS = "calls";
const STORE_COOKIE_RULES = "cookieRules";
const STORE_CACHED_COOKIES = "cachedCookies";
// Retired in v7 (domain-whitelist model). Kept only to delete the store on upgrade.
const STORE_GATEWAY_DOMAINS = "gatewayDomains";
const STORE_GATEWAY_LOGS = "gatewayLogs";
const STORE_GATEWAY_PROXY_RULES = "gatewayProxyRules";
// v10: agent-authored replayable action sequences, indexed by source recording.
const STORE_ACTIONS = "actions";
// Retired in v9 (replay feature removed). Kept only to delete the store on upgrade.
const STORE_REPLAY_RUNS = "replayRuns";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    // Safety net: if the upgrade stays blocked (e.g. an older connection in
    // another context never closes), the open request would hang with no
    // onsuccess/onerror. Reject after a grace period so callers can surface an
    // error and retry instead of pending forever.
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      dbPromise = null;
      reject(
        new Error(
          "IndexedDB open timed out (upgrade likely blocked by another tab/context). " +
            "Close or reload other extension pages and retry.",
        ),
      );
    }, 5000);
    const done = () => {
      settled = true;
      clearTimeout(timeout);
    };

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_RECORDINGS)) {
        db.createObjectStore(STORE_RECORDINGS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_CALLS)) {
        const calls = db.createObjectStore(STORE_CALLS, { keyPath: "id" });
        calls.createIndex("byRecording", "recordingId", { unique: false });
      }
      // v3: API gateway feature. New store starts empty; no data migration.
      if (!db.objectStoreNames.contains(STORE_GATEWAY_LOGS)) {
        const logs = db.createObjectStore(STORE_GATEWAY_LOGS, {
          keyPath: "id",
        });
        logs.createIndex("byTime", "at", { unique: false });
      }
      // v5: proxy rules for the script-driven gateway entry. New store starts empty.
      if (!db.objectStoreNames.contains(STORE_GATEWAY_PROXY_RULES)) {
        db.createObjectStore(STORE_GATEWAY_PROXY_RULES, { keyPath: "id" });
      }
      // v10: action feature. New store starts empty; no data migration.
      if (!db.objectStoreNames.contains(STORE_ACTIONS)) {
        const actions = db.createObjectStore(STORE_ACTIONS, { keyPath: "id" });
        actions.createIndex("byRecording", "recordingId", { unique: false });
      }
      // v4: cookie-cache feature removed. Drop its stores so any previously
      // cached cookie values (incl. HttpOnly) are erased from disk.
      if (db.objectStoreNames.contains(STORE_COOKIE_RULES)) {
        db.deleteObjectStore(STORE_COOKIE_RULES);
      }
      if (db.objectStoreNames.contains(STORE_CACHED_COOKIES)) {
        db.deleteObjectStore(STORE_CACHED_COOKIES);
      }
      // v7: domain-whitelist model retired. Drop the store so its rows are erased.
      if (db.objectStoreNames.contains(STORE_GATEWAY_DOMAINS)) {
        db.deleteObjectStore(STORE_GATEWAY_DOMAINS);
      }
      // v9: replay feature removed. Drop the replayRuns store (added in v8) so its
      // persisted runs are erased from disk.
      if (db.objectStoreNames.contains(STORE_REPLAY_RUNS)) {
        db.deleteObjectStore(STORE_REPLAY_RUNS);
      }
    };
    req.onsuccess = () => {
      if (settled) {
        // Timed out already; discard this late connection to avoid a leak.
        req.result.close();
        return;
      }
      done();
      const db = req.result;
      // If another context (e.g. a freshly reloaded page after a hot reload)
      // later tries to open a NEWER version, this connection would block that
      // upgrade and hang it forever. Close ourselves so the upgrade proceeds,
      // and drop the cached promise so the next read re-opens the new version.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      if (settled) return;
      done();
      // Reset so a later call can retry instead of reusing a rejected promise.
      dbPromise = null;
      reject(req.error);
    };
    // A version upgrade (e.g. v3 -> v4) is blocked while another context still
    // holds an older connection open — common right after a hot reload. This is
    // a *transient* state: once that context closes its connection (its own
    // onversionchange handler will), this open request resumes and onsuccess
    // still fires. So we must NOT reject here (that would turn a recoverable
    // wait into a hard error and stall every read). Just log for diagnostics.
    req.onblocked = () => {
      console.warn(
        "[manta-action-kit] IndexedDB upgrade blocked by an older connection; " +
          "waiting for it to close. If this persists, reload other extension pages.",
      );
    };
  });
  return dbPromise;
}

function tx(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
): IDBTransaction {
  return db.transaction(stores, mode);
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // A request can also fail via its transaction aborting (e.g. quota, an
    // internal error, or the connection closing mid-read). Without these the
    // promise would never settle and callers would hang forever.
    const t = req.transaction;
    if (t) {
      t.onabort = () =>
        reject(t.error ?? new Error("IndexedDB transaction aborted"));
      t.onerror = () =>
        reject(t.error ?? new Error("IndexedDB transaction error"));
    }
  });
}

/** Persist a recording plus all its calls in one transaction. */
export async function saveRecording(
  recording: Recording,
  calls: ApiCall[],
): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = tx(db, [STORE_RECORDINGS, STORE_CALLS], "readwrite");
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    t.objectStore(STORE_RECORDINGS).put(recording);
    const callStore = t.objectStore(STORE_CALLS);
    for (const call of calls) callStore.put(call);
  });
}

/** List all recordings, newest first. */
export async function listRecordings(): Promise<Recording[]> {
  const db = await openDb();
  const all = await reqToPromise(
    tx(db, [STORE_RECORDINGS], "readonly")
      .objectStore(STORE_RECORDINGS)
      .getAll() as IDBRequest<Recording[]>,
  );
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

/** Get a single recording's metadata. */
export async function getRecording(id: string): Promise<Recording | undefined> {
  const db = await openDb();
  return reqToPromise(
    tx(db, [STORE_RECORDINGS], "readonly")
      .objectStore(STORE_RECORDINGS)
      .get(id) as IDBRequest<Recording | undefined>,
  );
}

/** Get all calls for a recording, ordered by seq. */
export async function getCalls(recordingId: string): Promise<ApiCall[]> {
  const db = await openDb();
  const index = tx(db, [STORE_CALLS], "readonly")
    .objectStore(STORE_CALLS)
    .index("byRecording");
  const calls = await reqToPromise(
    index.getAll(IDBKeyRange.only(recordingId)) as IDBRequest<ApiCall[]>,
  );
  return calls.sort((a, b) => a.seq - b.seq);
}

/** Rename a recording. */
export async function renameRecording(id: string, name: string): Promise<void> {
  const db = await openDb();
  const rec = await getRecording(id);
  if (!rec) return;
  rec.name = name;
  await new Promise<void>((resolve, reject) => {
    const t = tx(db, [STORE_RECORDINGS], "readwrite");
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.objectStore(STORE_RECORDINGS).put(rec);
  });
}

/**
 * Set/overwrite a recording's agent-authored description (rides on the existing
 * recordings record, so no store bump is needed — old recordings simply read back
 * with description === undefined). Only agents write this via MCP; the UI shows it
 * read-only. Stamps descriptionUpdatedAt so callers can hint at staleness.
 */
export async function updateRecordingDescription(
  id: string,
  description: string,
): Promise<void> {
  const db = await openDb();
  const rec = await getRecording(id);
  if (!rec) return;
  rec.description = description;
  rec.descriptionUpdatedAt = Date.now();
  await new Promise<void>((resolve, reject) => {
    const t = tx(db, [STORE_RECORDINGS], "readwrite");
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.objectStore(STORE_RECORDINGS).put(rec);
  });
}

/**
 * Delete a recording, all of its calls, and every action distilled from it
 * (actions reference the recording's callIds, so they must not outlive it).
 */
export async function deleteRecording(id: string): Promise<void> {
  const db = await openDb();
  const callIds = (await getCalls(id)).map((c) => c.id);
  const actionIds = (await listActionsByRecording(id)).map((a) => a.id);
  await new Promise<void>((resolve, reject) => {
    const t = tx(
      db,
      [STORE_RECORDINGS, STORE_CALLS, STORE_ACTIONS],
      "readwrite",
    );
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.objectStore(STORE_RECORDINGS).delete(id);
    const callStore = t.objectStore(STORE_CALLS);
    for (const cid of callIds) callStore.delete(cid);
    const actionStore = t.objectStore(STORE_ACTIONS);
    for (const aid of actionIds) actionStore.delete(aid);
  });
}

/**
 * Delete a single call from a recording and update the recording's callCount.
 * The remaining calls keep their original `startedAt`, so the inter-call wait
 * times shown are unaffected.
 */
export async function deleteCall(
  recordingId: string,
  callId: string,
): Promise<void> {
  const db = await openDb();
  const rec = await getRecording(recordingId);
  await new Promise<void>((resolve, reject) => {
    const t = tx(db, [STORE_RECORDINGS, STORE_CALLS], "readwrite");
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    t.objectStore(STORE_CALLS).delete(callId);
    if (rec) {
      rec.callCount = Math.max(0, rec.callCount - 1);
      t.objectStore(STORE_RECORDINGS).put(rec);
    }
  });
}

// ---------------------------------------------------------------------------
// API gateway feature (v3)
// ---------------------------------------------------------------------------

/** List all gateway audit-log entries, newest first. */
export async function listGatewayLogs(): Promise<GatewayLog[]> {
  const db = await openDb();
  const all = await reqToPromise(
    tx(db, [STORE_GATEWAY_LOGS], "readonly")
      .objectStore(STORE_GATEWAY_LOGS)
      .getAll() as IDBRequest<GatewayLog[]>,
  );
  return all.sort((a, b) => b.at - a.at);
}

/** Append one gateway audit-log entry. */
export async function addGatewayLog(log: GatewayLog): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = tx(db, [STORE_GATEWAY_LOGS], "readwrite");
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.objectStore(STORE_GATEWAY_LOGS).put(log);
  });
}

/** Delete all gateway audit-log entries. */
export async function clearGatewayLogs(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = tx(db, [STORE_GATEWAY_LOGS], "readwrite");
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.objectStore(STORE_GATEWAY_LOGS).clear();
  });
}

// ---------------------------------------------------------------------------
// Proxy rules — script-driven gateway entry (v5)
// ---------------------------------------------------------------------------

/** List all proxy rules, newest first. */
export async function listGatewayProxyRules(): Promise<GatewayProxyRule[]> {
  const db = await openDb();
  const all = await reqToPromise(
    tx(db, [STORE_GATEWAY_PROXY_RULES], "readonly")
      .objectStore(STORE_GATEWAY_PROXY_RULES)
      .getAll() as IDBRequest<GatewayProxyRule[]>,
  );

  // Backfill `createdBy` for legacy rules created before the field existed.
  // The `/proxytest → httpbin.org` test rule was seeded by the agent; force it
  // to 'agent' even if an earlier default wrote 'user'. Any other legacy rule
  // missing the field defaults to 'user'. Migration is idempotent — rules that
  // already carry the correct value are left untouched.
  const migrated: GatewayProxyRule[] = [];
  for (const rule of all) {
    const isAgentSeed =
      rule.sandboxPrefix === "/proxytest" &&
      rule.targetBase.includes("httpbin.org");
    if (isAgentSeed) {
      if (rule.createdBy !== "agent") {
        rule.createdBy = "agent";
        migrated.push(rule);
      }
    } else if (rule.createdBy === undefined) {
      rule.createdBy = "user";
      migrated.push(rule);
    }
  }
  await Promise.all(migrated.map((rule) => upsertGatewayProxyRule(rule)));

  return all.sort((a, b) => b.createdAt - a.createdAt);
}

/** Add or overwrite (by id) a proxy rule. */
export async function upsertGatewayProxyRule(
  rule: GatewayProxyRule,
): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = tx(db, [STORE_GATEWAY_PROXY_RULES], "readwrite");
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.objectStore(STORE_GATEWAY_PROXY_RULES).put(rule);
  });
}

/** Delete a proxy rule. */
export async function deleteGatewayProxyRule(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = tx(db, [STORE_GATEWAY_PROXY_RULES], "readwrite");
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.objectStore(STORE_GATEWAY_PROXY_RULES).delete(id);
  });
}

// ---------------------------------------------------------------------------
// Actions — agent-authored replayable sequences (v10)
// ---------------------------------------------------------------------------

/** List all actions, newest first. */
export async function listActions(): Promise<Action[]> {
  const db = await openDb();
  const all = await reqToPromise(
    tx(db, [STORE_ACTIONS], "readonly")
      .objectStore(STORE_ACTIONS)
      .getAll() as IDBRequest<Action[]>,
  );
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

/** Get a single action by id. */
export async function getAction(id: string): Promise<Action | undefined> {
  const db = await openDb();
  return reqToPromise(
    tx(db, [STORE_ACTIONS], "readonly")
      .objectStore(STORE_ACTIONS)
      .get(id) as IDBRequest<Action | undefined>,
  );
}

/** List every action distilled from one recording. */
export async function listActionsByRecording(
  recordingId: string,
): Promise<Action[]> {
  const db = await openDb();
  const index = tx(db, [STORE_ACTIONS], "readonly")
    .objectStore(STORE_ACTIONS)
    .index("byRecording");
  const all = await reqToPromise(
    index.getAll(IDBKeyRange.only(recordingId)) as IDBRequest<Action[]>,
  );
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

/** Add or overwrite (by id) an action. Stamps updatedAt. */
export async function upsertAction(action: Action): Promise<void> {
  const db = await openDb();
  action.updatedAt = Date.now();
  await new Promise<void>((resolve, reject) => {
    const t = tx(db, [STORE_ACTIONS], "readwrite");
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.objectStore(STORE_ACTIONS).put(action);
  });
}

/** Delete an action. */
export async function deleteAction(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = tx(db, [STORE_ACTIONS], "readwrite");
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.objectStore(STORE_ACTIONS).delete(id);
  });
}
