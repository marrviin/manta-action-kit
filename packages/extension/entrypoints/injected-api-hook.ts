/**
 * MAIN-world API hook (injected via injectScript from the content script).
 *
 * Runs in the page's JS context so it can override the page's own `fetch` and
 * `XMLHttpRequest`. Native behavior is always preserved — we tap the data and
 * forward it; failures here never break the page.
 *
 * Captured calls are dispatched as CustomEvents on this script's own element. The
 * ISOLATED-world content script listens and relays them to the background. We emit
 * ALL fetch/XHR here; the "record only when active" and "API-only" filtering happen
 * downstream in the content script / background so this hook stays dumb and cheap.
 */
import {
  API_CALL_EVENT,
  type CapturedCall,
  type HeaderMap,
} from "@/lib/recording/types";
import { createSseParser, type SseEvent } from "@/lib/sse-parse";

export default defineUnlistedScript(() => {
  const self = document.currentScript as HTMLScriptElement | null;

  /** Caps so a runaway stream can't grow capture unbounded. */
  const SSE_MAX_EVENTS = 5000;
  const SSE_MAX_BYTES = 2_000_000;
  /**
   * Idle cap: many SSE streams don't close server-side — the page reads until a
   * terminal event then aborts its OWN response, which leaves our res.clone()
   * reader hanging forever (never gets `done`). If no bytes arrive for this long,
   * stop reading the clone and emit what we have.
   */
  const SSE_IDLE_MS = 3000;
  /** Overall cap on how long we'll drain one stream. */
  const SSE_MAX_MS = 120_000;

  const emit = (call: CapturedCall) => {
    try {
      const target: EventTarget = self ?? window;
      target.dispatchEvent(new CustomEvent(API_CALL_EVENT, { detail: call }));
    } catch {
      /* never let capture break the page */
    }
  };

  const now = () =>
    typeof performance !== "undefined" ? performance.now() : Date.now();
  const epoch = () => Date.now();

  /**
   * Resolve a request URL to its absolute form. Pages routinely call
   * fetch('/api/x') or xhr.open('GET', '/api/x') with relative URLs — captured
   * as-is they lose the domain, making recordings unreplayable and endpoint
   * samples host-less. Absolute inputs pass through unchanged.
   */
  function toAbsoluteUrl(url: string): string {
    try {
      return new URL(url, location.href).href;
    } catch {
      return url;
    }
  }

  function headersToMap(
    h: HeadersInit | Headers | null | undefined,
  ): HeaderMap {
    const map: HeaderMap = {};
    if (!h) return map;
    try {
      if (h instanceof Headers) {
        h.forEach((v, k) => (map[k] = v));
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) map[k] = String(v);
      } else {
        for (const k of Object.keys(h))
          map[k] = String((h as Record<string, unknown>)[k]);
      }
    } catch {
      /* ignore */
    }
    return map;
  }

  function parseRawHeaders(raw: string): HeaderMap {
    const map: HeaderMap = {};
    for (const line of raw.trim().split(/[\r\n]+/)) {
      const idx = line.indexOf(":");
      if (idx > 0)
        map[line.slice(0, idx).trim().toLowerCase()] = line
          .slice(idx + 1)
          .trim();
    }
    return map;
  }

  function looksJson(headers: HeaderMap, body: string | null): boolean {
    const ct = headers["content-type"] || "";
    if (ct.includes("application/json")) return true;
    if (!body) return false;
    const t = body.trim();
    return (
      (t.startsWith("{") && t.endsWith("}")) ||
      (t.startsWith("[") && t.endsWith("]"))
    );
  }

  /** Does this response look like a Server-Sent Events stream? */
  function isEventStream(headers: HeaderMap): boolean {
    return (headers["content-type"] || "").includes("text/event-stream");
  }

  /**
   * Rebuild a Response around a (tee'd) body stream, restoring the read-only
   * properties the Response constructor drops (url/redirected/type/ok) so the
   * page can't tell it apart from the original. Prefers Object.defineProperty;
   * falls back to a Proxy if the engine marks those getters non-configurable.
   */
  function rebuildResponse(
    original: Response,
    body: ReadableStream<Uint8Array>,
  ): Response {
    const rebuilt = new Response(body, {
      status: original.status,
      statusText: original.statusText,
      headers: original.headers,
    });
    const carry = {
      url: original.url,
      redirected: original.redirected,
      type: original.type,
      ok: original.ok,
    };
    try {
      Object.defineProperties(rebuilt, {
        url: { value: carry.url, enumerable: true },
        redirected: { value: carry.redirected, enumerable: true },
        type: { value: carry.type, enumerable: true },
        ok: { value: carry.ok, enumerable: true },
      });
      return rebuilt;
    } catch {
      // Non-configurable getters — proxy the carried props, pass everything else
      // through (binding methods so they run against the real Response).
      return new Proxy(rebuilt, {
        get(target, prop, recv) {
          if (prop === "url") return carry.url;
          if (prop === "redirected") return carry.redirected;
          if (prop === "type") return carry.type;
          if (prop === "ok") return carry.ok;
          const v = Reflect.get(target, prop, recv);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    }
  }

  /**
   * Read a streamed (SSE) body to the end (or a cap), parse it into events, and
   * emit ONE captured call. Consumes the given stream branch (a tee'd copy, so the
   * page's own branch is unaffected). Never throws into the page.
   */
  async function drainStreamAndEmit(
    stream: ReadableStream<Uint8Array>,
    base: Omit<
      CapturedCall,
      "resBody" | "resIsJson" | "streaming" | "sseEvents" | "durationMs"
    >,
    t0: number,
  ): Promise<void> {
    const events: SseEvent[] = [];
    let bytes = 0;
    try {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();
      const deadline = now() + SSE_MAX_MS;

      // Race each read() against idle + overall deadlines, so a stream the page
      // aborts on its own (or one that never closes) still terminates.
      const readNext = (): Promise<
        { kind: "chunk"; value: Uint8Array } | { kind: "end" }
      > => {
        const msLeft = deadline - now();
        const wait = Math.max(0, Math.min(SSE_IDLE_MS, msLeft));
        return new Promise((resolve) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve({ kind: "end" });
          }, wait);
          reader.read().then(
            ({ done, value }) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (done) resolve({ kind: "end" });
              else resolve({ kind: "chunk", value: value as Uint8Array });
            },
            () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve({ kind: "end" });
            },
          );
        });
      };

      readLoop: for (;;) {
        const r = await readNext();
        if (r.kind === "end") break;
        bytes += r.value?.byteLength ?? 0;
        for (const ev of parser.push(
          decoder.decode(r.value, { stream: true }),
        )) {
          events.push(ev);
          if (events.length >= SSE_MAX_EVENTS) break readLoop;
        }
        if (bytes >= SSE_MAX_BYTES) break;
      }
      for (const ev of parser.flush()) events.push(ev);
      reader.cancel().catch(() => {});
    } catch {
      /* stream read failed — emit whatever we collected */
    }
    emit({
      ...base,
      resBody: null,
      resIsJson: false,
      streaming: true,
      sseEvents: events,
      durationMs: Math.round(now() - t0),
    });
  }

  async function bodyInitToText(
    body: BodyInit | null | undefined,
  ): Promise<string | null> {
    if (body == null) return null;
    try {
      if (typeof body === "string") return body;
      if (body instanceof URLSearchParams) return body.toString();
      if (body instanceof Blob) return await body.text();
      if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
      if (ArrayBuffer.isView(body))
        return new TextDecoder().decode(body as Uint8Array);
      if (body instanceof FormData) {
        const parts: string[] = [];
        body.forEach((v, k) =>
          parts.push(`${k}=${typeof v === "string" ? v : "[file]"}`),
        );
        return parts.join("&");
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  // ---- fetch hook ---------------------------------------------------------
  const originalFetch = window.fetch;
  window.fetch = async function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const startedAt = epoch();
    const t0 = now();
    const req = input instanceof Request ? input : null;
    const url = toAbsoluteUrl(req ? req.url : String(input));
    const method = (init?.method || req?.method || "GET").toUpperCase();
    const reqHeaders = headersToMap(init?.headers ?? req?.headers ?? undefined);
    let reqBody: string | null = null;
    try {
      if (init?.body != null) reqBody = await bodyInitToText(init.body);
      else if (req)
        reqBody = await req
          .clone()
          .text()
          .catch(() => null);
    } catch {
      /* ignore */
    }

    try {
      const res = await originalFetch.call(this, input as RequestInfo, init);
      const resHeaders = headersToMap(res.headers);

      // Streaming (SSE) response: tee the body into two independent branches —
      // give the page a rebuilt Response around one branch, drain the other
      // ourselves. Unlike res.clone(), the page aborting its branch doesn't kill
      // ours, so we capture the whole stream (message + terminal events). If tee
      // or rebuild fails for any reason, fall through to returning the original
      // response untouched — never break the page.
      if (isEventStream(resHeaders) && res.body) {
        try {
          const [forPage, forUs] = res.body.tee();
          void drainStreamAndEmit(
            forUs,
            {
              source: "fetch",
              method,
              url,
              reqHeaders,
              reqBody,
              status: res.status,
              statusText: res.statusText,
              resHeaders,
              startedAt,
              errored: false,
            },
            t0,
          );
          return rebuildResponse(res, forPage);
        } catch {
          // tee()/rebuild unsupported or failed — pass the original through so
          // the page still works; we simply don't capture this stream.
          return res;
        }
      }

      let resBody: string | null = null;
      try {
        resBody = await res.clone().text();
      } catch {
        /* body may be opaque/streamed */
      }
      emit({
        source: "fetch",
        method,
        url,
        reqHeaders,
        reqBody,
        status: res.status,
        statusText: res.statusText,
        resHeaders,
        resBody,
        resIsJson: looksJson(resHeaders, resBody),
        startedAt,
        durationMs: Math.round(now() - t0),
        errored: false,
      });
      return res;
    } catch (err) {
      emit({
        source: "fetch",
        method,
        url,
        reqHeaders,
        reqBody,
        status: 0,
        statusText: "",
        resHeaders: {},
        resBody: null,
        resIsJson: false,
        startedAt,
        durationMs: Math.round(now() - t0),
        errored: true,
        errorText: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  } as typeof window.fetch;

  // ---- XMLHttpRequest hook ------------------------------------------------
  const XHR = XMLHttpRequest.prototype;
  const originalOpen = XHR.open;
  const originalSend = XHR.send;
  const originalSetHeader = XHR.setRequestHeader;

  interface Tapped {
    _dnd?: {
      method: string;
      url: string;
      reqHeaders: HeaderMap;
      startedAt: number;
      t0: number;
    };
  }

  XHR.open = function (
    this: XMLHttpRequest & Tapped,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    this._dnd = {
      method: (method || "GET").toUpperCase(),
      url: toAbsoluteUrl(String(url)),
      reqHeaders: {},
      startedAt: 0,
      t0: 0,
    };
    // @ts-expect-error passthrough of variadic args
    return originalOpen.call(this, method, url, ...rest);
  };

  XHR.setRequestHeader = function (
    this: XMLHttpRequest & Tapped,
    name: string,
    value: string,
  ) {
    if (this._dnd) this._dnd.reqHeaders[name.toLowerCase()] = value;
    return originalSetHeader.call(this, name, value);
  };

  XHR.send = function (
    this: XMLHttpRequest & Tapped,
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const tap = this._dnd;
    if (tap) {
      tap.startedAt = epoch();
      tap.t0 = now();
      let reqBody: string | null = null;
      try {
        if (typeof body === "string") reqBody = body;
        else if (body instanceof URLSearchParams) reqBody = body.toString();
        else if (body != null && "toString" in body) reqBody = null;
      } catch {
        /* ignore */
      }

      this.addEventListener("loadend", () => {
        try {
          const resHeaders = parseRawHeaders(
            this.getAllResponseHeaders?.() || "",
          );
          let resBody: string | null = null;
          try {
            // responseText throws for some responseTypes (blob/arraybuffer).
            resBody =
              this.responseType === "" || this.responseType === "text"
                ? this.responseText
                : this.response != null
                  ? String(this.response)
                  : null;
          } catch {
            resBody = null;
          }
          emit({
            source: "xhr",
            method: tap.method,
            url: tap.url,
            reqHeaders: tap.reqHeaders,
            reqBody,
            status: this.status,
            statusText: this.statusText,
            resHeaders,
            resBody,
            resIsJson: looksJson(resHeaders, resBody),
            startedAt: tap.startedAt,
            durationMs: Math.round(now() - tap.t0),
            errored: this.status === 0,
            errorText: this.status === 0 ? "network error" : undefined,
          });
        } catch {
          /* ignore */
        }
      });
    }
    return originalSend.call(this, body ?? null);
  };
});
