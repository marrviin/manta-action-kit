/**
 * Action replay engine tests. The template/override/outputs machinery is all
 * module-private, so it is exercised end to end through runAction() with the
 * persistence + gateway layers mocked (@/lib/db, @/lib/gateway/run,
 * @/lib/gateway/confirm): mocked gateway fns capture the request the engine
 * would forward and answer with a canned response. resolveActionParams() is
 * exported and tested directly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Action,
  ActionParam,
  ActionOverride,
  ActionStep,
} from "./types";
import { ACTION_MAX_WAIT_MS } from "./types";
import type { ApiCall } from "@/lib/recording/types";
import type {
  GatewayResponse,
  GatewaySseResponse,
} from "@/lib/gateway/types";

const h = vi.hoisted(() => ({
  getCalls: vi.fn(),
  runGatewayFetch: vi.fn(),
  runGatewaySse: vi.fn(),
  requestGatewayConfirmation: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getCalls: h.getCalls }));

vi.mock("@/lib/gateway/run", () => {
  class GatewayRefusedError extends Error {
    constructor(
      message: string,
      readonly decision?: string,
    ) {
      super(message);
      this.name = "GatewayRefusedError";
    }
  }
  return {
    runGatewayFetch: h.runGatewayFetch,
    runGatewaySse: h.runGatewaySse,
    GatewayRefusedError,
  };
});

vi.mock("@/lib/gateway/confirm", () => ({
  requestGatewayConfirmation: h.requestGatewayConfirmation,
}));

import { runAction, resolveActionParams } from "./replay";
import type { GatewayRequest } from "@/lib/gateway/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let calls: ApiCall[];

function makeCall(id: string, overrides: Partial<ApiCall> = {}): ApiCall {
  return {
    id,
    recordingId: "rec-1",
    seq: 0,
    source: "fetch",
    method: "POST",
    url: `https://api.example.com/${id}`,
    reqHeaders: {},
    reqBody: null,
    status: 200,
    statusText: "OK",
    resHeaders: {},
    resBody: null,
    resIsJson: true,
    startedAt: 0,
    durationMs: 10,
    errored: false,
    ...overrides,
  };
}

function makeStep(callId: string, overrides: Partial<ActionStep> = {}): ActionStep {
  return { callId, kind: "fetch", ...overrides };
}

function makeAction(
  steps: ActionStep[],
  params: ActionParam[] = [],
  overrides: Partial<Action> = {},
): Action {
  return {
    id: "action-1",
    name: "test action",
    description: "",
    recordingId: "rec-1",
    params,
    steps,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const gwRes = (body: unknown, status = 200): GatewayResponse => ({
  status,
  statusText: "OK",
  headers: {},
  body: JSON.stringify(body),
  truncated: false,
  injectedCookieCount: 1,
});

const sseRes = (events: Array<{ event?: string; data: string }>): GatewaySseResponse => ({
  status: 200,
  statusText: "OK",
  headers: {},
  events: events.map((e) => ({ ...e })),
  endReason: "complete",
  eventCount: events.length,
  injectedCookieCount: 1,
});

/** The GatewayRequest the engine forwarded on the Nth (0-based) gateway call. */
function forwardedReq(n = 0): GatewayRequest {
  return h.runGatewayFetch.mock.calls[n]![0] as GatewayRequest;
}

const ov = (
  toLocation: ActionOverride["toLocation"],
  toPath: string,
  value: string,
): ActionOverride => ({ toLocation, toPath, value });

beforeEach(() => {
  vi.clearAllMocks();
  h.runGatewayFetch.mockResolvedValue(gwRes({ ok: true }));
  h.runGatewaySse.mockResolvedValue(sseRes([{ data: "{}" }]));
  h.requestGatewayConfirmation.mockResolvedValue(true);
  calls = [];
  h.getCalls.mockImplementation(async () => calls);
});

// ---------------------------------------------------------------------------
// resolveActionParams
// ---------------------------------------------------------------------------

describe("resolveActionParams", () => {
  const action = makeAction([], [
    { name: "orderId", type: "string", required: true },
    { name: "page", type: "number", required: false, default: "1" },
    { name: "verbose", type: "boolean", required: false },
  ]);

  it("applies defaults and normalizes scalar runtime values to strings", () => {
    const out = resolveActionParams(action, { orderId: "o-1", page: 3, verbose: true });
    expect(out).toEqual({ orderId: "o-1", page: "3", verbose: "true" });
  });

  it("missing required param throws; empty string counts as missing", () => {
    expect(() => resolveActionParams(action, { page: "2" })).toThrow(/orderId/);
    expect(() => resolveActionParams(action, { orderId: "" })).toThrow(/orderId/);
  });

  it("optional param omitted (and without default) is skipped, not rejected", () => {
    const out = resolveActionParams(
      makeAction([], [{ name: "opt", type: "string", required: false }]),
      undefined,
    );
    expect(out).toEqual({});
  });

  it("type mismatches fail loudly", () => {
    expect(() =>
      resolveActionParams(action, { orderId: "x", page: "abc" }),
    ).toThrow(/page/);
    expect(() =>
      resolveActionParams(action, { orderId: "x", verbose: "yes" }),
    ).toThrow(/verbose/);
  });
});

// ---------------------------------------------------------------------------
// runAction — template resolution & override application
// ---------------------------------------------------------------------------

describe("runAction: cloning", () => {
  it("clones the recorded call and drops transport headers", async () => {
    calls = [
      makeCall("c1", {
        method: "PUT",
        reqHeaders: {
          "Content-Length": "5",
          Host: "api.example.com",
          Connection: "keep-alive",
          "X-Trace": "t1",
        },
        reqBody: '{"a":1}',
      }),
    ];
    const run = await runAction(makeAction([makeStep("c1")]), undefined);
    expect(run.endReason).toBe("complete");
    const req = forwardedReq(0);
    expect(req.method).toBe("PUT");
    expect(req.url).toBe("https://api.example.com/c1");
    expect(req.headers).toEqual({ "X-Trace": "t1" });
    expect(req.body).toBe('{"a":1}');
  });
});

describe("runAction: template resolution", () => {
  it("resolves {{param}} into header/query/body overrides", async () => {
    calls = [makeCall("c1", { reqBody: '{"orderId":"old"}' })];
    const action = makeAction(
      [
        makeStep("c1", {
          overrides: [
            ov("header", "X-Order", "{{orderId}}"),
            ov("query", "q", "{{orderId}}"),
            ov("body", "orderId", "{{orderId}}"),
          ],
        }),
      ],
      [{ name: "orderId", type: "string", required: true }],
    );
    const run = await runAction(action, { orderId: "42" });
    expect(run.endReason).toBe("complete");
    const req = forwardedReq(0);
    expect(req.headers).toEqual({ "X-Order": "42" });
    expect(req.url).toContain("q=42");
    // Recorded field was a string, so the coerced value stays a string.
    expect(JSON.parse(req.body!)).toEqual({ orderId: "42" });
  });

  it("passes step outputs to later steps' templates", async () => {
    calls = [makeCall("c1"), makeCall("c2")];
    h.runGatewayFetch
      .mockResolvedValueOnce(gwRes({ data: { id: "abc" } }))
      .mockResolvedValueOnce(gwRes({ done: true }));
    const action = makeAction([
      makeStep("c1", { outputs: { id: "data.id" } }),
      makeStep("c2", {
        overrides: [
          ov("url", "", "https://api.example.com/items/{{steps[0].outputs[id]}}"),
          ov("body", "prevId", "{{steps[0].outputs[id]}}"),
        ],
      }),
    ]);
    const run = await runAction(action, undefined);
    expect(run.endReason).toBe("complete");
    expect(run.steps[0]!.outputs).toEqual({ id: "abc" });
    const req = forwardedReq(1);
    expect(req.url).toBe("https://api.example.com/items/abc");
    expect(JSON.parse(req.body!)).toEqual({ prevId: "abc" });
  });

  it("object outputs are stringified JSON; SSE outputs read first matching event", async () => {
    calls = [makeCall("c1"), makeCall("c2")];
    h.runGatewayFetch.mockResolvedValueOnce(gwRes({ data: { x: 1 } }));
    h.runGatewaySse.mockResolvedValueOnce(
      sseRes([
        { event: "delta", data: '{"unrelated":true}' },
        { event: "delta", data: '{"v":"2"}' },
        { event: "done", data: '{"v":"3"}' },
      ]),
    );
    const action = makeAction([
      makeStep("c1", { outputs: { obj: "data" } }),
      makeStep("c2", { kind: "sse", outputs: { v: "v" } }),
    ]);
    const run = await runAction(action, undefined);
    expect(run.steps[0]!.outputs.obj).toBe('{"x":1}');
    // First event that yields the path wins.
    expect(run.steps[1]!.outputs.v).toBe("2");
    expect(run.steps[1]!.eventCount).toBe(3);
    expect(run.steps[1]!.bodyPreview).toBe(
      '{"unrelated":true}\n{"v":"2"}\n{"v":"3"}',
    );
  });

  it("unknown parameter aborts the step before any network call", async () => {
    calls = [makeCall("c1"), makeCall("c2")];
    const action = makeAction([
      makeStep("c1", { overrides: [ov("header", "X-A", "{{nope}}")] }),
      makeStep("c2"),
    ]);
    const run = await runAction(action, undefined);
    expect(run.endReason).toBe("aborted");
    expect(run.failedStep).toBe(1);
    expect(run.steps[0]!.outcome).toBe("error");
    expect(run.steps[0]!.errorText).toMatch(/unknown parameter "nope"/);
    expect(h.runGatewayFetch).not.toHaveBeenCalled();
    expect(run.steps).toHaveLength(1);
  });

  it("referencing an output that produced no value aborts with a precise error", async () => {
    calls = [makeCall("c1"), makeCall("c2")];
    h.runGatewayFetch
      .mockResolvedValueOnce(gwRes({ other: 1 }))
      .mockResolvedValueOnce(gwRes({}));
    const action = makeAction([
      makeStep("c1", { outputs: { id: "data.id" } }),
      makeStep("c2", { overrides: [ov("query", "id", "{{steps[0].outputs[id]}}")] }),
    ]);
    const run = await runAction(action, undefined);
    expect(run.failedStep).toBe(2);
    expect(run.steps[1]!.errorText).toMatch(/steps\[0\]\.outputs\[id\], which produced no value/);
  });

  it("an output that is missing does NOT abort its own step", async () => {
    calls = [makeCall("c1")];
    h.runGatewayFetch.mockResolvedValueOnce(gwRes({ nope: 1 }));
    const action = makeAction([makeStep("c1", { outputs: { id: "data.id" } })]);
    const run = await runAction(action, undefined);
    expect(run.endReason).toBe("complete");
    expect(run.steps[0]!.outputs).toEqual({});
  });
});

describe("runAction: body overrides & coercion", () => {
  const bodyStep = (toPath: string, value: string, reqBody?: string | null) =>
    makeStep("c1", { overrides: [ov("body", toPath, value)] });

  it("coerces to the recorded field's number type", async () => {
    calls = [makeCall("c1", { reqBody: '{"page":1}' })];
    const action = makeAction(
      [makeStep("c1", { overrides: [ov("body", "page", "{{p}}")] })],
      [{ name: "p", type: "string", required: true }],
    );
    await runAction(action, { p: "3" });
    expect(JSON.parse(forwardedReq(0).body!)).toEqual({ page: 3 });
  });

  it("non-numeric text for a recorded number field fails loudly", async () => {
    calls = [makeCall("c1", { reqBody: '{"page":1}' })];
    const action = makeAction(
      [makeStep("c1", { overrides: [ov("body", "page", "{{p}}")] })],
      [{ name: "p", type: "string", required: true }],
    );
    const run = await runAction(action, { p: "abc" });
    expect(run.steps[0]!.errorText).toMatch(/recorded field is a number/);
  });

  it("coerces booleans strictly and rejects other text", async () => {
    calls = [makeCall("c1", { reqBody: '{"flag":false}' })];
    const ok = makeAction([makeStep("c1", { overrides: [ov("body", "flag", "true")] })]);
    const run = await runAction(ok, undefined);
    expect(JSON.parse(forwardedReq(0).body!)).toEqual({ flag: true });

    const bad = makeAction([makeStep("c1", { overrides: [ov("body", "flag", "yes")] })]);
    const run2 = await runAction(bad, undefined);
    expect(run2.steps[0]!.errorText).toMatch(/recorded field is a boolean/);
  });

  it("parses JSON container text into new/nested paths, creating parents", async () => {
    calls = [makeCall("c1", { reqBody: '{"q":1}' })];
    const action = makeAction([
      makeStep("c1", {
        overrides: [ov("body", "filter.tags[1]", '["a","b"]')],
      }),
    ]);
    await runAction(action, undefined);
    // A hole created before an array index serializes to JSON as null.
    expect(JSON.parse(forwardedReq(0).body!)).toEqual({
      q: 1,
      filter: { tags: [null, ["a", "b"]] },
    });
  });

  it("keeps plain strings verbatim on new paths", async () => {
    calls = [makeCall("c1", { reqBody: "{}" })];
    const action = makeAction([makeStep("c1", { overrides: [ov("body", "note", "[not json")] })]);
    await runAction(action, undefined);
    expect(JSON.parse(forwardedReq(0).body!)).toEqual({ note: "[not json" });
  });

  it("non-JSON recorded body rejects a body override", async () => {
    calls = [makeCall("c1", { reqBody: "hello world" })];
    const action = makeAction([makeStep("c1", { overrides: [ov("body", "x", "1")] })]);
    const run = await runAction(action, undefined);
    expect(run.steps[0]!.errorText).toMatch(/not JSON/);
  });

  it("path mismatch (array parent for a key) fails loudly", async () => {
    calls = [makeCall("c1", { reqBody: '{"list":[1]}' })];
    const action = makeAction([makeStep("c1", { overrides: [ov("body", "list.x", "1")] })]);
    const run = await runAction(action, undefined);
    expect(run.steps[0]!.outcome).toBe("error");
    expect(run.steps[0]!.errorText).toMatch(/Path mismatch/);
  });

  it("later body overrides see earlier ones' effects on the same clone", async () => {
    calls = [makeCall("c1", { reqBody: "{}" })];
    const action = makeAction([
      makeStep("c1", {
        overrides: [ov("body", "a", "1"), ov("body", "b", "2")],
      }),
    ]);
    await runAction(action, undefined);
    // New paths keep plain strings verbatim (no type to coerce to).
    expect(JSON.parse(forwardedReq(0).body!)).toEqual({ a: "1", b: "2" });
  });
});

describe("runAction: other override locations", () => {
  it("query override adds to the recorded URL's search params", async () => {
    calls = [makeCall("c1", { url: "https://api.example.com/x?a=1" })];
    const action = makeAction([makeStep("c1", { overrides: [ov("query", "b", "2")] })]);
    await runAction(action, undefined);
    expect(forwardedReq(0).url).toBe("https://api.example.com/x?a=1&b=2");
  });

  it("url override must not carry a toPath; whole-url rewrite wins", async () => {
    calls = [makeCall("c1")];
    const bad = makeAction([makeStep("c1", { overrides: [ov("url", "oops", "https://x.com")] })]);
    const run = await runAction(bad, undefined);
    expect(run.steps[0]!.errorText).toMatch(/empty toPath/);

    const good = makeAction([makeStep("c1", { overrides: [ov("url", "", "https://other.example.com/y")] })]);
    await runAction(good, undefined);
    expect(forwardedReq(0).url).toBe("https://other.example.com/y");
  });

  it("header override requires a header name", async () => {
    calls = [makeCall("c1")];
    const action = makeAction([makeStep("c1", { overrides: [ov("header", "", "v")] })]);
    const run = await runAction(action, undefined);
    expect(run.steps[0]!.errorText).toMatch(/non-empty toPath/);
  });

  it("query override requires a key name", async () => {
    calls = [makeCall("c1")];
    const action = makeAction([makeStep("c1", { overrides: [ov("query", "", "v")] })]);
    const run = await runAction(action, undefined);
    expect(run.steps[0]!.errorText).toMatch(/non-empty toPath/);
  });
});

// ---------------------------------------------------------------------------
// runAction — run semantics
// ---------------------------------------------------------------------------

describe("runAction: run semantics", () => {
  it("preflight: no steps or unknown callId throws to the caller", async () => {
    await expect(runAction(makeAction([]), undefined)).rejects.toThrow(/no steps/);
    calls = [makeCall("c1")];
    await expect(
      runAction(makeAction([makeStep("ghost")]), undefined),
    ).rejects.toThrow(/unknown callId "ghost"/);
    expect(h.runGatewayFetch).not.toHaveBeenCalled();
  });

  it("a refused step aborts the run with failure=refused", async () => {
    const { GatewayRefusedError } = await import("@/lib/gateway/run");
    calls = [makeCall("c1"), makeCall("c2")];
    h.runGatewayFetch.mockRejectedValueOnce(new GatewayRefusedError("blocked", "blocked"));
    const run = await runAction(makeAction([makeStep("c1"), makeStep("c2")]), undefined);
    expect(run.endReason).toBe("aborted");
    expect(run.failedStep).toBe(1);
    expect(run.failure).toBe("refused");
    expect(run.steps[0]!.outcome).toBe("refused");
    expect(h.runGatewayFetch).toHaveBeenCalledTimes(1);
  });

  it("a transport error aborts with failure=error", async () => {
    calls = [makeCall("c1")];
    h.runGatewayFetch.mockRejectedValueOnce(new Error("socket hung up"));
    const run = await runAction(makeAction([makeStep("c1")]), undefined);
    expect(run.failure).toBe("error");
    expect(run.steps[0]!.outcome).toBe("error");
    expect(run.steps[0]!.errorText).toBe("socket hung up");
  });

  it("HTTP 4xx/5xx is still ok and the run continues", async () => {
    calls = [makeCall("c1"), makeCall("c2")];
    h.runGatewayFetch
      .mockResolvedValueOnce(gwRes({ err: "nope" }, 404))
      .mockResolvedValueOnce(gwRes({ ok: true }));
    const run = await runAction(makeAction([makeStep("c1"), makeStep("c2")]), undefined);
    expect(run.endReason).toBe("complete");
    expect(run.steps[0]!.status).toBe(404);
    expect(run.steps[0]!.outcome).toBe("ok");
    expect(h.runGatewayFetch).toHaveBeenCalledTimes(2);
  });

  it("caps waitMs at ACTION_MAX_WAIT_MS", async () => {
    vi.useFakeTimers();
    try {
      calls = [makeCall("c1")];
      const action = makeAction([makeStep("c1", { waitMs: 999_999 })]);
      const p = runAction(action, undefined);
      await vi.advanceTimersByTimeAsync(ACTION_MAX_WAIT_MS + 1);
      const run = await p;
      expect(run.endReason).toBe("complete");
    } finally {
      vi.useRealTimers();
    }
  });

  it("one confirmation per distinct host per run", async () => {
    calls = [makeCall("c1"), makeCall("c2"), makeCall("c3")];
    calls[2] = makeCall("c3", { url: "https://other.example.com/c3" });
    // The real gateway consults confirmHost before forwarding; mirror that in
    // the mock so the engine's confirmHost hook is actually exercised.
    h.runGatewayFetch.mockImplementation(async (req: GatewayRequest, opts: { confirmHost: (host: string, req: GatewayRequest) => Promise<boolean> }) => {
      const ok = await opts.confirmHost(new URL(req.url).host, req);
      if (!ok) throw new Error("confirm denied");
      return gwRes({ ok: true });
    });
    const run = await runAction(
      makeAction([makeStep("c1"), makeStep("c2"), makeStep("c3")]),
      undefined,
    );
    expect(run.endReason).toBe("complete");
    expect(h.requestGatewayConfirmation).toHaveBeenCalledTimes(2);
  });

  it("denied confirmation aborts the step as an error", async () => {
    calls = [makeCall("c1")];
    h.runGatewayFetch.mockImplementation(async (req: GatewayRequest, opts: { confirmHost: (host: string, req: GatewayRequest) => Promise<boolean> }) => {
      const ok = await opts.confirmHost(new URL(req.url).host, req);
      if (!ok) throw new Error("confirm denied");
      return gwRes({ ok: true });
    });
    h.requestGatewayConfirmation.mockResolvedValue(false);
    const run = await runAction(makeAction([makeStep("c1")]), undefined);
    expect(run.steps[0]!.outcome).toBe("error");
    expect(run.steps[0]!.errorText).toBe("confirm denied");
  });

  it("truncates long response previews at ACTION_RESULT_PREVIEW_CAP", async () => {
    calls = [makeCall("c1")];
    const long = "x".repeat(2500);
    h.runGatewayFetch.mockResolvedValueOnce({
      ...gwRes({}),
      body: long,
    });
    const run = await runAction(makeAction([makeStep("c1")]), undefined);
    expect(run.steps[0]!.truncated).toBe(true);
    expect(run.steps[0]!.bodyPreview).toHaveLength(2000);
  });
});
