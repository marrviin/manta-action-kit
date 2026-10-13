#!/usr/bin/env node
/**
 * manta-action-kit suite health check.
 *
 * Usage: node check-env.mjs
 * Exit code: 0 = all passed; 1 = issues found (each line prefixed ✅/❌/⚠️ with a fix suggestion).
 *
 * Works from any cwd and detects whether it runs inside the manta-action-kit
 * repo checkout:
 *   1. Repo only: packages/mcp/dist/index.js is built (skipped for an
 *      installed skill copy — the server runs from the published package)
 *   2. The manta-action-kit MCP server is registered with an MCP client —
 *      Claude Code via the `claude` CLI, other documented clients by probing
 *      their known config files
 *   3. WS bridge port (default 8787) has an MCP server process listening
 *   4. End-to-end probe: connects to the bridge as a peer and forwards
 *      list_recordings to the extension — distinguishes "bridge up but
 *      extension not connected" from "full chain working"
 *
 * Requires Node >= 18. The connection probe uses native WebSocket on Node >=
 * 22 and a minimal raw-socket WS client on 18–21 (handshake + small text
 * frames only — enough for the hello/welcome/auth/peer-rpc exchange).
 *
 * Ports can be overridden via MANTA_WS_PORT / MANTA_PROXY_PORT.
 */
import { spawnSync } from "node:child_process";
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
/** True when the skill copy sits inside the manta-action-kit repo checkout. */
const IN_REPO = existsSync(path.join(ROOT, "packages", "mcp", "package.json"));
const MCP_PORT = Number(process.env.MANTA_WS_PORT) || 8787;
/** Handshake secret shared with the extension (from its install prompt env). */
const MANTA_TOKEN = process.env.MANTA_TOKEN;

const results = [];
const report = (ok, label, detail = "") => {
  const mark = ok === "skip" ? "⚠️" : ok ? "✅" : "❌";
  results.push(ok === true);
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ""}`);
};

// ── 1. dist built (repo checkouts only) ─────────────────────────────────────
const distEntry = path.join(ROOT, "packages/mcp/dist/index.js");
if (!IN_REPO) {
  report(
    "skip",
    "Installed skill copy (no repo checkout) — MCP server runs from the published npx package, build check n/a",
  );
} else if (existsSync(distEntry)) {
  report(true, "MCP build output present (packages/mcp/dist/index.js)");
} else {
  report(false, "MCP build output missing", "run pnpm build:mcp");
}

// ── 2. MCP client registration ──────────────────────────────────────────────
checkRegistration(distEntry);

/** Probe `claude mcp list` first; fall back to known config files of the other documented clients. */
function checkRegistration(distEntry) {
  const claude = spawnSync("claude", ["mcp", "list"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (!claude.error) {
    const line = (claude.stdout + claude.stderr)
      .split("\n")
      .find((l) => l.includes("manta-action-kit"));
    if (line && line.includes("✔")) {
      report(true, "Claude Code has manta-action-kit MCP registered");
      return;
    }
    const other = findOtherClientRegistrations();
    if (line && other.length > 0) {
      report(
        "skip",
        `Registered but not connected in Claude Code (${line.trim()}); also found in: ${other.join(", ")}`,
        "use whichever client you actually run; for Claude Code run pnpm build:mcp first, then /mcp reconnect",
      );
      return;
    }
    if (line) {
      report(
        false,
        `Registered but not connected: ${line.trim()}`,
        "run pnpm build:mcp first, then /mcp reconnect",
      );
      return;
    }
    if (other.length > 0) {
      report(
        true,
        `Registered in ${other.join(", ")} (Claude Code itself has no registration)`,
      );
      return;
    }
    report(
      false,
      "manta-action-kit MCP not registered in Claude Code",
      `run claude mcp add manta-action-kit --scope local --env MANTA_TOKEN=<token from the extension's install prompt> -- npx -y @manta-action-kit/mcp${IN_REPO ? ` (or, in a repo checkout: -- node ${distEntry})` : ""}`,
    );
    return;
  }
  // claude CLI unavailable — probe the documented clients' config files.
  const other = findOtherClientRegistrations();
  if (other.length > 0) {
    report(
      true,
      `Registered in ${other.join(", ")} (claude CLI unavailable, checked known config files)`,
    );
  } else {
    report(
      "skip",
      "No client registration detected (claude CLI unavailable; known config files have no manta-action-kit entry)",
      "register the server with your MCP client — see SKILL.md section 1",
    );
  }
}

/** Config files of the other documented clients that mention manta-action-kit. */
function findOtherClientRegistrations() {
  const candidates = [
    ["WorkBuddy", ".workbuddy/mcp.json"],
    ["JoyCode", ".joycode/joycode-mcp.json"],
    ["Codex", ".codex/config.toml"],
    ["Cursor", ".cursor/mcp.json"],
  ];
  const found = [];
  for (const [client, rel] of candidates) {
    try {
      const text = readFileSync(path.join(homedir(), rel), "utf8");
      if (text.includes("manta-action-kit")) found.push(client);
    } catch {
      // File missing or unreadable — client not configured here; skip silently.
    }
  }
  return found;
}

// ── 3+4. WS bridge + end-to-end probe ───────────────────────────────────────
const bridgeFailed = await probeBridge();
// Exit 1 when ANY check reported ❌ (missing build, registration, version
// skew), not just when the end-to-end probe itself failed.
process.exitCode = bridgeFailed || results.includes(false) ? 1 : 0;

/**
 * Connect to ws://127.0.0.1:<port> and return a minimal ws-like object
 * ({ send, close, addEventListener, removeEventListener }) — native WebSocket
 * when available, a raw-socket client on Node 18–21.
 */
function connectBridge(port) {
  if (typeof WebSocket !== "undefined") {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      const onOpen = () => {
        cleanup();
        resolve(socket);
      };
      const onError = (err) => {
        cleanup();
        reject(err?.error ?? err);
      };
      const t = setTimeout(() => {
        cleanup();
        socket.close();
        reject(new Error("connect timeout"));
      }, 5_000);
      const cleanup = () => {
        clearTimeout(t);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
    });
  }
  return rawWsConnect(port);
}

/**
 * Minimal WebSocket client over a raw TCP socket (RFC 6455, client side).
 * Enough for the bridge probe: opening handshake, masked small text frames,
 * unmasking of received frames, ping→pong, close. Received messages are
 * buffered until a 'message' listener is attached (the bridge may push the
 * welcome frame immediately after the upgrade).
 */
function rawWsConnect(port) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const socket = net.connect(port, "127.0.0.1");
    const listeners = { message: [], error: [], close: [] };
    const pendingMessages = [];
    let headerBuf = Buffer.alloc(0);
    let upgraded = false;
    let frameBuf = Buffer.alloc(0);
    // Fragmented-message reassembly: { opcode, chunks } while a frame is open.
    let fragment = null;

    const emit = (ev, arg) => {
      if (ev === "message" && listeners.message.length === 0) {
        pendingMessages.push(arg);
        return;
      }
      for (const fn of listeners[ev] ?? []) fn(arg);
    };

    socket.on("connect", () => {
      // Re-arm the timeout for the HTTP-upgrade phase: a port that accepts
      // TCP but never answers the upgrade must not hang the probe. Cleared
      // once the 101 lands and normal WS frames flow.
      socket.setTimeout(5_000, () => {
        socket.destroy();
        reject(new Error("upgrade timeout"));
      });
      socket.write(
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error("connect timeout"));
    });
    socket.on("data", (chunk) => {
      if (!upgraded) {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const idx = headerBuf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const head = headerBuf.subarray(0, idx).toString("utf8");
        if (!/^HTTP\/1\.1 101/i.test(head)) {
          socket.destroy();
          reject(
            new Error(`bridge handshake rejected: ${head.split("\r\n")[0]}`),
          );
          return;
        }
        upgraded = true;
        socket.setTimeout(0); // healthy bridge: stop timing out frame traffic
        frameBuf = Buffer.from(headerBuf.subarray(idx + 4));
        processFrames();
        resolve({
          send: (text) => sendFrame(socket, text),
          close: () => socket.destroy(),
          addEventListener: (ev, fn) => {
            (listeners[ev] ??= []).push(fn);
            if (ev === "message") {
              while (pendingMessages.length > 0) fn(pendingMessages.shift());
            }
          },
          removeEventListener: (ev, fn) => {
            const arr = listeners[ev];
            const i = arr ? arr.indexOf(fn) : -1;
            if (i > -1) arr.splice(i, 1);
          },
        });
        return;
      }
      frameBuf = Buffer.concat([frameBuf, chunk]);
      processFrames();
    });
    socket.on("error", (err) => {
      if (!upgraded) reject(err);
      else emit("error", err);
    });
    socket.on("close", () => emit("close"));

    function processFrames() {
      for (;;) {
        if (frameBuf.length < 2) return;
        const fin = (frameBuf[0] & 0x80) !== 0;
        const opcode = frameBuf[0] & 0x0f;
        const masked = (frameBuf[1] & 0x80) !== 0;
        let len = frameBuf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (frameBuf.length < off + 2) return;
          len = frameBuf.readUInt16BE(off);
          off += 2;
        } else if (len === 127) {
          if (frameBuf.length < off + 8) return;
          len = Number(frameBuf.readBigUInt64BE(off));
          off += 8;
        }
        let maskKey = null;
        if (masked) {
          if (frameBuf.length < off + 4) return;
          maskKey = frameBuf.subarray(off, off + 4);
          off += 4;
        }
        if (frameBuf.length < off + len) return;
        let payload = frameBuf.subarray(off, off + len);
        if (maskKey) {
          payload = Buffer.from(payload);
          for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
        }
        frameBuf = frameBuf.subarray(off + len);

        if (opcode === 0x9) {
          // ping → pong (same payload, masked like any client frame)
          sendFrame(socket, payload.toString("utf8"), 0xa);
        } else if (opcode === 0x8) {
          socket.destroy();
          return;
        } else if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
          if (opcode !== 0x0) {
            if (fin) emit("message", { data: payload.toString("utf8") });
            else fragment = { chunks: [payload] };
          } else if (fragment) {
            fragment.chunks.push(payload);
            if (fin) {
              emit("message", {
                data: Buffer.concat(fragment.chunks).toString("utf8"),
              });
              fragment = null;
            }
          }
        }
      }
    }
  });
}

/** Send one masked text (or control) frame; client→server frames MUST be masked. */
function sendFrame(socket, text, opcode = 0x1) {
  const payload = Buffer.from(text, "utf8");
  const maskKey = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= maskKey[i % 4];
  let head;
  if (payload.length < 126) {
    head = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length < 65_536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(payload.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([head, maskKey, masked]));
}

/** Connect to ws://127.0.0.1:<MCP_PORT> and probe the extension as a peer. Returns exit code. */
async function probeBridge() {
  if (!MANTA_TOKEN) {
    report(
      false,
      "MANTA_TOKEN not set",
      "re-copy the install prompt from the extension (Action tab → Copy install prompt) and update the MCP config env, then run this script with MANTA_TOKEN=<token>",
    );
    return 1;
  }
  let ws;
  try {
    ws = await connectBridge(MCP_PORT);
  } catch {
    report(
      false,
      `WS bridge port ${MCP_PORT} has no listener`,
      "MCP server not running (no MCP client session started?), or the port was changed",
    );
    return 1;
  }
  report(true, `WS bridge port ${MCP_PORT} has an MCP server listening`);

  try {
    const welcome = await handshake(ws);
    const result = await rpcAuthed(ws, "list_recordings", {}, 10_000);
    const count = Array.isArray(result)
      ? result.length
      : (result?.recordings?.length ?? "unknown");
    report(
      true,
      "End-to-end probe passed (MCP → bridge → extension)",
      `current recording count: ${count}`,
    );
    await checkVersionSkew(ws, welcome);
    return 0;
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (msg.includes("token mismatch") || msg.includes("MANTA_TOKEN")) {
      report(
        false,
        "Handshake failed: token mismatch",
        "the MCP config env MANTA_TOKEN does not match the extension — re-copy the install prompt and update the config",
      );
    } else if (
      msg.includes("No authenticated Chrome extension") ||
      msg.includes("No Chrome extension connected")
    ) {
      report(
        false,
        "Bridge up but extension not connected",
        "confirm Chrome is running with the extension installed (the Settings tab's Connector card in its side panel shows the connection status)",
      );
    } else if (msg.includes("timed out")) {
      report(
        false,
        "Extension connected but unresponsive",
        "the extension was just reloaded or its service worker slept; wake the side panel and retry",
      );
    } else {
      report(false, "End-to-end probe failed", msg);
    }
    return 1;
  } finally {
    ws.close();
  }
}

// Declared as a function (not a const arrow) so it is hoisted: the top-level
// `await probeBridge()` above runs before any later const initializer, and a
// const here would leave `hmac` in the temporal dead zone during that await.
function hmac(token, message) {
  return createHmac("sha256", token).update(message).digest("hex");
}

/**
 * Full client handshake (mirror of packages/mcp/src/peer-client.ts):
 * hello{nonce} → verify welcome proof → auth proof → then the peer-rpc.
 * Resolves with the welcome frame (its `version` is the owner server's
 * self-declared version, used by the skew check). Rejects with a descriptive
 * error on any handshake failure.
 */
function handshake(ws) {
  return new Promise((resolve, reject) => {
    const nonce = randomUUID();
    const timer = setTimeout(
      () => reject(new Error("handshake timed out after 10s")),
      10_000,
    );
    const onMessage = (ev) => {
      let frame;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (frame.type !== "welcome") return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      const expected = hmac(MANTA_TOKEN, `manta/welcome/${nonce}`);
      const actual = Buffer.from(String(frame.proof ?? ""), "hex");
      const expectedBuf = Buffer.from(expected, "hex");
      const ok =
        actual.length === expectedBuf.length &&
        timingSafeEqual(actual, expectedBuf);
      if (!ok) {
        reject(
          new Error(
            "Handshake failed: token mismatch (MANTA_TOKEN does not match the extension)",
          ),
        );
        return;
      }
      ws.send(
        JSON.stringify({
          type: "auth",
          proof: hmac(MANTA_TOKEN, `manta/auth/${frame.nonce}`),
        }),
      );
      resolve(frame);
    };
    ws.addEventListener("message", onMessage);
    ws.send(
      JSON.stringify({ type: "hello", role: "peer", version: "0.0.0", nonce }),
    );
  });
}

/** Send a peer-rpc on an ALREADY-authenticated socket and await the result. */
function rpcAuthed(ws, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = `check-${Date.now()}`;
    const timer = setTimeout(
      () =>
        reject(
          new Error(`peer RPC "${method}" timed out after ${timeoutMs}ms`),
        ),
      timeoutMs,
    );
    const onMessage = (ev) => {
      let frame;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (frame.type === "peer-rpc-result" && frame.id === id) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        if (frame.ok) {
          resolve(frame.result);
        } else {
          reject(new Error(frame.error));
        }
      }
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ type: "peer-rpc", id, method, params }));
  });
}

/**
 * The extension and the MCP server ship in lockstep (one version number), but
 * they update independently — the extension through Chrome, the server when
 * the user's MCP config re-runs npx. A skew makes newer features silently do
 * nothing, so surface it with the fix. Unknown versions are ⚠️, not ❌: there
 * is nothing actionable beyond "update that side".
 */
async function checkVersionSkew(ws, welcome) {
  const serverVersion =
    typeof welcome?.version === "string" ? welcome.version : null;
  let extensionVersion = null;
  try {
    const info = await rpcAuthed(ws, "extension_info", {}, 5_000);
    extensionVersion = typeof info?.version === "string" ? info.version : null;
  } catch {
    // Old extension without extension_info — treated as unknown below.
  }
  const extLabel = extensionVersion
    ? `extension v${extensionVersion}`
    : "extension version unknown";
  const serverLabel = serverVersion
    ? `MCP server v${serverVersion}`
    : "MCP server version unknown";
  if (!serverVersion || !extensionVersion) {
    report(
      "skip",
      `Version check skipped (${[serverLabel, extLabel].join(", ")})`,
      "update the side missing a version: the extension via the Chrome Web Store, the MCP server by re-running the npx install command from the install prompt",
    );
    return;
  }
  if (serverVersion === extensionVersion) {
    report(true, `Versions in lockstep (${extLabel} = ${serverLabel})`);
    return;
  }
  const cmp = compareSemver(serverVersion, extensionVersion);
  if (cmp > 0) {
    report(
      false,
      `Version skew: ${serverLabel} is newer than the ${extLabel}`,
      "newer features may silently do nothing — update the extension (Chrome Web Store auto-update, or remove + re-install from the install prompt)",
    );
  } else {
    report(
      false,
      `Version skew: the ${extLabel} is newer than ${serverLabel}`,
      "newer features may be missing — update the MCP server by re-running the npx install command from the install prompt",
    );
  }
}

/** Compare `x.y.z` strings (negative = a older); missing segments count as 0. */
function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}
