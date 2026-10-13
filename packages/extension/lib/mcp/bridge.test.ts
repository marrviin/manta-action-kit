/**
 * MCP bridge (extension side) tests: the WS handshake state machine and rpc
 * serving, driven through a fake WebSocket global — no real sockets, no
 * extension APIs. Module state (generation, socket, backoff) lives at module
 * scope, so every test loads a fresh instance via vi.resetModules + dynamic
 * import. Fake timers drive the ping loop and the reconnect backoff.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before the dynamic import below.
// ---------------------------------------------------------------------------

vi.mock("@/lib/storage", () => ({
  settings: {
    mcpPort: {
      getValue: vi.fn(async () => 8787 as unknown),
      watch: vi.fn(() => () => {}),
    },
  },
  mcpConnStatus: { setValue: vi.fn(async () => undefined as unknown) },
  mcpServerVersion: { setValue: vi.fn(async () => undefined as unknown) },
}));

vi.mock("@/lib/mcp/handlers", () => ({ handleRpc: vi.fn() }));

vi.mock("@/lib/mcp/auth", () => ({
  newNonce: vi.fn(() => "nonce-x"),
  verifyWelcomeProof: vi.fn(async () => true),
  authProof: vi.fn(async () => "proof-y"),
}));

vi.mock("@/lib/mcp/install-prompt", () => ({
  ensureMcpAuthToken: vi.fn(async () => "tok-1"),
}));

// The real module re-exports @manta-action-kit/protocol (dist build) — keep
// the unit suite hermetic on a cold checkout by stubbing the one constant
// the bridge reads. Frame shapes below are plain literals.
vi.mock("@/lib/mcp/protocol", () => ({
  DEFAULT_MCP_PORT: 8787,
  BRIDGE_SCAN_RANGE: 32,
}));

import { settings, mcpConnStatus, mcpServerVersion } from "@/lib/storage";
import { handleRpc } from "@/lib/mcp/handlers";
import { authProof, verifyWelcomeProof } from "@/lib/mcp/auth";
import { ensureMcpAuthToken } from "@/lib/mcp/install-prompt";

const mcpPortStore = settings.mcpPort as unknown as {
  getValue: Mock;
  watch: Mock;
};
const connStatusStore = mcpConnStatus as unknown as { setValue: Mock };
const serverVersionStore = mcpServerVersion as unknown as { setValue: Mock };

// ---------------------------------------------------------------------------
// Fake WebSocket — records sends, lets tests drive open/message/close.
// ---------------------------------------------------------------------------

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    // The bridge nulls handlers before tearing down its own sockets — only
    // then does this fire (mirrors a remote-initiated close).
    this.onclose?.({});
  }

  /** Test hook: the server accepted the TCP connection. */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  /** Test hook: a JSON frame arrives from the server. */
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** Test hook: non-JSON garbage arrives. */
  receiveRaw(data: string) {
    this.onmessage?.({ data });
  }

  sentFrames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let bridge: typeof import("@/lib/mcp/bridge");

/** Flush the publishStatus write chain and pending async handshake steps. */
const settle = () => vi.advanceTimersByTimeAsync(1);

/** Start the bridge with the given stored port. */
async function startBridge(port = 8787) {
  mcpPortStore.getValue.mockResolvedValue(port);
  await bridge.initMcpBridge();
}

function lastSocket(): FakeWebSocket {
  const ws = FakeWebSocket.instances.at(-1);
  if (!ws) throw new Error("no WebSocket was dialed");
  return ws;
}

/** Drive socket open + successful welcome handshake. */
async function handshake(ws: FakeWebSocket = lastSocket()) {
  ws.open();
  await settle();
  ws.receive({
    type: "welcome",
    proof: "good",
    nonce: "srv-nonce",
    version: "1.2.3",
  });
  await settle();
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("browser", {
    runtime: { getManifest: () => ({ version: "0.0.0-test" }) },
  });
  vi.stubGlobal("chrome", {
    runtime: { getURL: (p: string) => `chrome-extension://test${p}` },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
  });
  mcpPortStore.getValue.mockResolvedValue(8787);
  mcpPortStore.watch.mockReturnValue(() => {});
  (verifyWelcomeProof as Mock).mockResolvedValue(true);
  (authProof as Mock).mockResolvedValue("proof-y");
  (ensureMcpAuthToken as Mock).mockResolvedValue("tok-1");
  (handleRpc as Mock).mockReset();
  bridge = await import("@/lib/mcp/bridge");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("initMcpBridge (handshake)", () => {
  it("dials the configured port and completes hello → welcome → auth", async () => {
    await startBridge(9001);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(lastSocket().url).toBe("ws://127.0.0.1:9001");
    // Unauthenticated socket: 'connecting' only, nothing else sent yet.
    expect(connStatusStore.setValue.mock.calls).toEqual([["connecting"]]);

    await handshake();
    const frames = lastSocket().sentFrames();
    expect(frames[0]).toMatchObject({
      type: "hello",
      role: "extension",
      version: "0.0.0-test",
      nonce: "nonce-x",
    });
    // The auth answer proves the token over the SERVER's challenge nonce.
    expect(frames[1]).toEqual({ type: "auth", proof: "proof-y" });
    expect(authProof).toHaveBeenCalledWith("tok-1", "srv-nonce");
    expect(verifyWelcomeProof).toHaveBeenCalledWith("tok-1", "nonce-x", "good");
    expect(connStatusStore.setValue.mock.calls).toEqual([
      ["connecting"],
      ["connected"],
    ]);
    // Server version lands in settings for the UI's skew hint.
    expect(serverVersionStore.setValue).toHaveBeenCalledWith("1.2.3");
  });

  it("never dials without a token — reports unauthorized instead", async () => {
    (ensureMcpAuthToken as Mock).mockResolvedValue("");
    await startBridge();
    await settle(); // let the serialized status writes flush
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(connStatusStore.setValue.mock.calls).toEqual([
      ["connecting"],
      ["unauthorized"],
    ]);
  });

  it("drops the socket and reports unauthorized when the welcome proof fails", async () => {
    (verifyWelcomeProof as Mock).mockResolvedValue(false);
    await startBridge();
    await handshake();
    // Two reports: the failed proof AND the socket close it triggers.
    expect(connStatusStore.setValue.mock.calls).toEqual([
      ["connecting"],
      ["unauthorized"],
      ["unauthorized"],
    ]);
    expect(lastSocket().readyState).toBe(FakeWebSocket.CLOSED);
    // Only the hello went out — no auth frame leaked to an unproven server.
    expect(
      lastSocket()
        .sentFrames()
        .map((f) => f.type),
    ).toEqual(["hello"]);
  });

  it("drops an rpc frame that arrives before the handshake", async () => {
    await startBridge();
    lastSocket().open();
    await settle();
    lastSocket().receive({
      type: "rpc",
      id: "r1",
      method: "health",
      params: {},
    });
    await settle();
    expect(handleRpc).not.toHaveBeenCalled();
    // Only the handshake hello — no rpc-result ever leaves the socket.
    expect(
      lastSocket()
        .sentFrames()
        .map((f) => f.type),
    ).toEqual(["hello"]);
  });

  it("ignores non-JSON frames without crashing", async () => {
    await startBridge();
    await handshake();
    lastSocket().receiveRaw("not json at all");
    await settle();
    expect(handleRpc).not.toHaveBeenCalled();
    expect(connStatusStore.setValue.mock.calls).toEqual([
      ["connecting"],
      ["connected"],
    ]);
  });
});

describe("rpc serving", () => {
  it("answers a post-handshake rpc with ok:true and the handler result", async () => {
    (handleRpc as Mock).mockResolvedValue({ echo: true });
    await startBridge();
    await handshake();
    lastSocket().receive({
      type: "rpc",
      id: "r-7",
      method: "health",
      params: {},
    });
    await settle();
    expect(handleRpc).toHaveBeenCalledWith("health", {});
    expect(lastSocket().sentFrames().at(-1)).toEqual({
      type: "rpc-result",
      id: "r-7",
      ok: true,
      result: { echo: true },
    });
  });

  it("maps handler throws to ok:false with the error message", async () => {
    (handleRpc as Mock).mockRejectedValue(new Error("boom"));
    await startBridge();
    await handshake();
    lastSocket().receive({
      type: "rpc",
      id: "r-8",
      method: "health",
      params: {},
    });
    await settle();
    expect(lastSocket().sentFrames().at(-1)).toEqual({
      type: "rpc-result",
      id: "r-8",
      ok: false,
      error: "boom",
    });
  });
});

describe("ping keepalive + reconnect", () => {
  it("sends a ping every 20s while connected and stops on close", async () => {
    await startBridge();
    await handshake();
    const ws = lastSocket();
    const pingsAfterHandshake = ws
      .sentFrames()
      .filter((f) => f.type === "ping").length;
    await vi.advanceTimersByTimeAsync(60_000);
    const pings = ws.sentFrames().filter((f) => f.type === "ping");
    expect(pings.length - pingsAfterHandshake).toBe(3); // 20s cadence

    ws.close();
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ws.sentFrames().filter((f) => f.type === "ping").length).toBe(
      pings.length,
    );
  });

  it("reconnects with growing backoff after a close", async () => {
    await startBridge();
    await handshake();
    lastSocket().close(); // remote dropped us
    await settle();
    expect(connStatusStore.setValue.mock.calls.at(-1)).toEqual([
      "disconnected",
    ]);

    // First retry lands after ~1s of backoff.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Second failure → backoff doubled to 2s: 1.5s is too early, 2.5s dials.
    FakeWebSocket.instances[1]!.close();
    await settle();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("ensureConnected dials immediately when idle and no-ops when open", async () => {
    await startBridge();
    await handshake();
    bridge.ensureConnected();
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Simulate the SW waking with a dropped socket: dial right away, without
    // waiting out the reconnect backoff.
    lastSocket().close();
    await settle();
    FakeWebSocket.instances.length = 0;
    bridge.ensureConnected();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe("port reconfiguration", () => {
  it("re-dials the new port when the mcpPort setting changes", async () => {
    await startBridge(8787);
    await handshake();
    const oldSocket = lastSocket();

    const watchCb = mcpPortStore.watch.mock.calls[0]![0] as (
      v: unknown,
    ) => void;
    watchCb(9002);
    await settle();

    // The stale socket is torn down silently (handlers detached — no
    // 'disconnected' publish, no reconnect for the old generation); the new
    // dial publishes 'connecting' and stays there until ITS handshake lands.
    expect(oldSocket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(connStatusStore.setValue.mock.calls.at(-1)).toEqual(["connecting"]);
    expect(lastSocket().url).toBe("ws://127.0.0.1:9002");
  });
});

describe("fallback port discovery", () => {
  it("keeps the plain backoff loop scan-free for the first few failures", async () => {
    await startBridge();
    // Three quick dial failures (server not running yet) must NOT open any
    // probe sockets — the backoff loop alone handles that case.
    for (let i = 0; i < 2; i++) {
      lastSocket().close(); // close before any handshake = failed dial
      await settle();
      await vi.advanceTimersByTimeAsync(2_000); // outwait the backoff, re-dial
    }
    expect(
      FakeWebSocket.instances.filter((ws) => ws.url !== "ws://127.0.0.1:8787"),
    ).toHaveLength(0);
  });

  it("scans upward after repeated dial failures and adopts a verified bridge", async () => {
    await startBridge();
    // Burn two dial failures: each close (pre-handshake) is a failed dial,
    // the backoff re-dial follows. No probes yet.
    for (let i = 0; i < 2; i++) {
      lastSocket().close();
      await settle();
      await vi.advanceTimersByTimeAsync(4_000);
    }
    // The third failure arms the scan; the sweep's first probe (the port
    // above the configured one) is created synchronously on the close.
    lastSocket().close();
    const probe = lastSocket();
    expect(probe.url).toBe("ws://127.0.0.1:8788");
    // A manta bridge answers: it proves the token over our hello nonce.
    probe.open();
    await settle();
    probe.receive({ type: "welcome", proof: "good", nonce: "srv-nonce" });
    await settle();
    // Only the hello ever goes to the probed server — no auth frame leaks to
    // an unproven one (here it IS proven, so the real dial adopts the port).
    expect(
      probe
        .sentFrames()
        .map((f) => (f as { type: string }).type),
    ).toEqual(["hello"]);
    expect(lastSocket().url).toBe("ws://127.0.0.1:8788");
    // The discovered port completes a normal handshake like any other.
    await handshake(lastSocket());
    expect(connStatusStore.setValue.mock.calls.at(-1)).toEqual(["connected"]);
  });

  it("never scans while unauthorized — a token mismatch is a config error", async () => {
    (verifyWelcomeProof as Mock).mockResolvedValue(false);
    await startBridge();
    // Each round: dial → welcome arrives → proof fails → 'unauthorized' →
    // socket closes. Repeat past the failure threshold that would normally
    // arm a scan; none must fire.
    for (let i = 0; i < 4; i++) {
      await handshake(); // open + welcome with a failing proof
      await vi.advanceTimersByTimeAsync(16_000); // outwait the backoff, re-dial
    }
    expect(
      FakeWebSocket.instances.filter((ws) => ws.url !== "ws://127.0.0.1:8787"),
    ).toHaveLength(0);
  });
});
