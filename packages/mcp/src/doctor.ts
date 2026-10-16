/**
 * `doctor` — environment check for the Manta Action Kit MCP setup.
 *
 * Runs a series of read-only checks (Node version, agent MCP config coverage,
 * WS bridge probe with token handshake, extension connection + version skew,
 * HTTP proxy) and reports each one:
 *   - OK        healthy, nothing to do.
 *   - WARNING   degraded but the product still works (no server running yet,
 *               version skew) — printed with a solution, does NOT fail the
 *               exit code.
 *   - FIXABLE   the CLI can repair it (missing config entries, stale token) —
 *               asks the user for confirmation first.
 *   - FAIL      needs human action (port squatted, extension offline) —
 *               printed with concrete solutions.
 *
 * Exit code: 0 when no FAILs remain after optional fixes; 1 otherwise
 * (mirrors the extension's check-env convention: warnings are not failures).
 *
 * The bridge probe reuses the peer handshake (peer-client.ts): a successful
 * handshake proves a manta OWNER is listening AND that our token matches the
 * extension's — far more specific than a bare TCP check. Settings (ports +
 * token) resolve from env first, then from whatever is already deployed in
 * the installed agent configs, then package defaults.
 */
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import * as clack from "@clack/prompts";
import {
  AGENTS,
  MCP_PACKAGE,
  showBanner,
  SERVER_KEY,
  buildServerEntry,
  extractInstallFields,
  upsertCodexServer,
  upsertJsonServer,
} from "./cli.js";
import { DEFAULT_MCP_PORT, DEFAULT_PROXY_PORT } from "./protocol.js";
import { compatVerdict } from "./compat.js";
import { startPeerClient, type PeerClient } from "./peer-client.js";

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("../package.json") as { version: string };

type CheckStatus = "ok" | "warn" | "fail";

// --- Environment resolution -------------------------------------------------

/** The effective server settings, resolved the way the server itself would. */
export type DoctorEnv = {
  wsPort: number;
  proxyPort: number;
  token?: string;
  /** Where each value came from — shown to the user so the resolution is auditable. */
  sources: { wsPort: string; proxyPort: string; token: string };
};

/** Values found in the env block of an installed manta-action-kit config entry. */
export type InstalledEnv = { wsPort?: string; proxyPort?: string; token?: string };

/**
 * Read the MANTA_* values OUT of the installed agent configs (any agent whose
 * config carries a manta-action-kit entry). This is how doctor finds the token
 * without the extension running — the config env IS the deployed config.
 */
export async function readInstalledEnv(): Promise<InstalledEnv> {
  const out: InstalledEnv = {};
  for (const agent of AGENTS) {
    let text: string;
    try {
      text = await readFile(agent.configPath(), "utf8");
    } catch {
      continue; // no config for this agent — not a source
    }
    try {
      const config = JSON.parse(text) as Record<string, unknown>;
      const servers = config[agent.rootKey] as
        | Record<string, { env?: Record<string, string> }>
        | undefined;
      const entry = servers?.[SERVER_KEY];
      if (!entry?.env) continue;
      out.wsPort ??= entry.env.MANTA_WS_PORT;
      out.proxyPort ??= entry.env.MANTA_PROXY_PORT;
      out.token ??= entry.env.MANTA_TOKEN;
    } catch {
      // Not JSON — Codex TOML: scrape the values from the manta section only.
      const env = scrapeTomlEnv(text);
      if (!env) continue;
      out.wsPort ??= env.MANTA_WS_PORT;
      out.proxyPort ??= env.MANTA_PROXY_PORT;
      out.token ??= env.MANTA_TOKEN;
    }
  }
  return out;
}

/**
 * Extract the manta section's KEY = "value" pairs from a Codex config.toml.
 * Scoped to the `[mcp_servers.manta-action-kit]` section so another server's
 * env can never leak in. Returns null when the section is absent.
 */
export function scrapeTomlEnv(
  text: string,
): Record<string, string> | null {
  const header = `[mcp_servers.${SERVER_KEY}]`;
  const start = text.indexOf(header);
  if (start === -1) return null;
  const rest = text.slice(start);
  const nextHeader = rest.slice(1).search(/^\[/m);
  const section = nextHeader === -1 ? rest : rest.slice(0, nextHeader + 1);
  const env: Record<string, string> = {};
  const unquote = (s: string) =>
    s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
  for (const m of section.matchAll(/^\s*(command|args)\s*=\s*(.+)$/gm)) {
    // Top-level scalars: command = "npx", args = ["-y", "…"] (raw inner text).
    env[m[1]] = unquote(m[2].trim());
  }
  // The env inline table's entries: env = { KEY = "value", ... }
  const inline = section.match(/env\s*=\s*\{([^}]*)\}/);
  if (inline) {
    for (const m of inline[1].matchAll(/([\w]+)\s*=\s*"([^"]*)"/g)) {
      env[m[1]] = m[2];
    }
  }
  return env;
}

/** Resolve the effective ports/token: env var > installed config > default. */
export async function resolveDoctorEnv(envToken?: string): Promise<DoctorEnv> {
  const installed = await readInstalledEnv();
  const envWs = Number(process.env.MANTA_WS_PORT) || undefined;
  const envProxy = Number(process.env.MANTA_PROXY_PORT) || undefined;
  // The explicit param (tests) outranks the env var, which outranks what is
  // already deployed in the agent configs.
  const token =
    envToken ?? (process.env.MANTA_TOKEN || undefined) ?? installed.token ?? undefined;
  return {
    wsPort: envWs ?? (Number(installed.wsPort) || DEFAULT_MCP_PORT),
    proxyPort: envProxy ?? (Number(installed.proxyPort) || DEFAULT_PROXY_PORT),
    token,
    sources: {
      wsPort: envWs
        ? "env"
        : installed.wsPort
          ? "installed config"
          : "default",
      proxyPort: envProxy
        ? "env"
        : installed.proxyPort
          ? "installed config"
          : "default",
      token:
        envToken || process.env.MANTA_TOKEN
          ? "env"
          : installed.token
            ? "installed config"
            : "not found",
    },
  };
}

/** The engines floor from package.json (>= 18), checked numerically. */
export function nodeVersionOk(version = process.versions.node): boolean {
  const major = Number(version.split(".")[0]);
  return major >= 18;
}

// --- Bridge probing ---------------------------------------------------------

export type BridgeProbe =
  | { outcome: "running"; peer: PeerClient }
  | { outcome: "not-running" }
  | { outcome: "occupied"; detail: string };

/** True when something accepts TCP on 127.0.0.1:<port>. */
export function isTcpOpen(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Probe the WS bridge: TCP first (to distinguish "nothing there" from
 * "something else there"), then the token handshake. The peer is returned
 * live on success — the caller must close it when done.
 */
export async function probeBridge(
  port: number,
  token: string,
): Promise<BridgeProbe> {
  if (!(await isTcpOpen(port))) return { outcome: "not-running" };
  const peer = startPeerClient(port, "127.0.0.1", {
    version: PKG_VERSION,
    token,
    quiet: true, // doctor renders its own report; [peer] stderr noise would break the layout
  });
  const err = await Promise.race([
    peer.whenReady().then(() => null, (e) => e),
    sleep(4000).then(() => new Error("handshake timed out after 4s")),
  ]);
  if (!err) return { outcome: "running", peer };
  await peer.close().catch(() => {});
  const detail = err instanceof Error ? err.message : String(err);
  return { outcome: "occupied", detail };
}

/**
 * Ask the OWNER for the extension connection + version. `extension_info` is a
 * real bridge RPC (the owner forwards it); it rejects when no extension is
 * connected or the extension predates version exchange. The MCP-layer `health`
 * result is deliberately NOT queried — it is computed in-process by the owner
 * (ports, compat), not a forwardable RPC.
 */
async function queryExtensionInfo(
  peer: PeerClient,
): Promise<{ version: string | null } | null> {
  try {
    const res = (await peer.call("extension_info", {}, 8000)) as {
      version?: string;
    };
    return { version: res?.version ?? null };
  } catch {
    return null;
  }
}

// --- Fixes ------------------------------------------------------------------

/**
 * Rewrite the MANTA_TOKEN in every installed config, preserving each entry's
 * command/args/ports. Returns the paths actually updated.
 */
export async function updateInstalledToken(token: string): Promise<string[]> {
  const updated: string[] = [];
  for (const agent of AGENTS) {
    const path = agent.configPath();
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue; // no config — nothing to update
    }
    try {
      const config = JSON.parse(text) as Record<string, unknown>;
      const servers = config[agent.rootKey] as
        | Record<
            string,
            { command?: string; args?: string[]; env?: Record<string, string> }
          >
        | undefined;
      const entry = servers?.[SERVER_KEY];
      if (!entry) continue;
      await upsertJsonServer(path, agent.rootKey, {
        command: entry.command ?? "npx",
        args: entry.args ?? ["-y", `${MCP_PACKAGE}@latest`],
        env: { ...entry.env, MANTA_TOKEN: token },
      });
      updated.push(path);
    } catch {
      // Not JSON — Codex TOML: rebuild the section with the same env + new token.
      const env = scrapeTomlEnv(text);
      if (!env) continue;
      await upsertCodexServer(path, {
        command: env.command ?? "npx",
        args:
          env.args
            ?.replace(/^\[|\]$/g, "")
            .split(",")
            .map((a) => a.trim().replace(/^"|"$/g, ""))
            .filter(Boolean) ?? ["-y", `${MCP_PACKAGE}@latest`],
        env: {
          ...(env.MANTA_WS_PORT ? { MANTA_WS_PORT: env.MANTA_WS_PORT } : {}),
          ...(env.MANTA_PROXY_PORT
            ? { MANTA_PROXY_PORT: env.MANTA_PROXY_PORT }
            : {}),
          MANTA_TOKEN: token,
        },
      });
      updated.push(path);
    }
  }
  return updated;
}

// --- Interactive flow -------------------------------------------------------

const SECTION_TITLES = {
  env: "Environment",
  agents: "Agent MCP configs",
  bridge: "Bridge & extension",
} as const;

type SectionId = keyof typeof SECTION_TITLES;

/** A check result, tagged with the section it renders under. */
type Check = {
  id: string;
  section: SectionId;
  title: string;
  status: CheckStatus;
  detail: string;
  /** Present on FIXABLE items — runs after user confirmation. */
  fix?: () => Promise<string>;
  /** The confirm question for a fix (defaults to a generic one). */
  fixPrompt?: string;
  /** For unfixable problems: the human-actionable solution. */
  solution?: string;
};

const ICON = { ok: "\u2713", warn: "\u26a0", fail: "\u2717" } as const;

type CheckSink = (c: Check) => void;

/** Node version check. */
async function collectNodeChecks(push: CheckSink): Promise<Check> {
  const nodeOk = nodeVersionOk();
  const check: Check = {
    id: "node",
    section: "env",
    title: "Node",
    status: nodeOk ? "ok" : "fail",
    detail: nodeOk
      ? `v${process.versions.node} (>= 18 required)`
      : `v${process.versions.node} is too old (>= 18 required)`,
    solution:
      "Upgrade Node to 18 or newer (e.g. `nvm install 18`), then relaunch your agents.",
  };
  push(check);
  return check;
}

/** Agent config coverage (only agents that are actually installed). */
async function collectAgentChecks(env: DoctorEnv, push: CheckSink): Promise<Check[]> {
  const checks: Check[] = [];
  const detected = AGENTS.filter((a) => a.detect());
  if (detected.length === 0) {
    checks.push({
      id: "agents",
      section: "agents",
      title: "Detected agents",
      status: "warn",
      detail: "none of the supported agents were found on this machine",
      solution:
        "Install an agent (Claude Code / Cursor / …), or wire the MCP server manually " +
        "(see packages/mcp/README.md → Wiring into an agent).",
    });
    push(checks[0]);
    return checks;
  }
  const missing: typeof detected = [];
  for (const agent of detected) {
    let text: string | null = null;
    try {
      text = await readFile(agent.configPath(), "utf8");
    } catch {
      /* missing config */
    }
    const hasEntry =
      text !== null &&
      (text.includes(`"${SERVER_KEY}"`) ||
        text.includes(`[mcp_servers.${SERVER_KEY}]`));
    if (!hasEntry) missing.push(agent);
  }
  const installed = detected.filter((a) => !missing.includes(a));
  if (installed.length > 0) {
    checks.push({
      id: "agents-installed",
      section: "agents",
      title: "Installed",
      status: "ok",
      detail: installed.map((a) => a.label).join(", "),
    });
  }
  if (missing.length > 0) {
    const labels = missing.map((a) => a.label).join(", ");
    checks.push({
      id: "agents",
      section: "agents",
      title: "Missing entry",
      status: "fail",
      detail: labels,
      fixPrompt: `Install manta-action-kit into ${labels}?`,
      fix: async () => {
        let token = env.token;
        if (!token) {
          const pasted = await clack.text({
            message:
              "No token found yet. Paste the extension's install prompt (or just the MANTA_TOKEN value):",
            validate: (v) =>
              v && v.trim()
                ? undefined
                : "Paste the prompt or the token (Ctrl-C to cancel)",
          });
          if (clack.isCancel(pasted))
            throw new Error("cancelled — no token provided");
          const fields = extractInstallFields(pasted);
          if (!fields.token)
            throw new Error("no MANTA_TOKEN found in the input");
          token = fields.token;
          if (fields.wsPort) env.wsPort = fields.wsPort;
          if (fields.proxyPort) env.proxyPort = fields.proxyPort;
        }
        const entry = buildServerEntry(env.wsPort, env.proxyPort, token);
        const written: string[] = [];
        for (const agent of missing) {
          const outcome =
            agent.id === "codex"
              ? await upsertCodexServer(agent.configPath(), entry)
              : await upsertJsonServer(
                  agent.configPath(),
                  agent.rootKey,
                  entry,
                );
          written.push(`${agent.label} (${outcome})`);
        }
        return written.join(", ");
      },
      solution:
        "Run `npx @manta-action-kit/mcp@latest init` to install manually.",
    });
  }
  checks.forEach(push);
  return checks;
}

/**
 * Bridge probe + extension connection + version skew. Returns whether the
 * bridge is up (the proxy check is only meaningful then).
 */
async function collectBridgeChecks(
  env: DoctorEnv,
  push: CheckSink,
): Promise<{ bridgeOk: boolean; bridge: Check }> {
  let bridge: Check;
  let bridgeOk = false;
  if (await isTcpOpen(env.wsPort)) {
    if (!env.token) {
      bridge = {
        id: "bridge",
        section: "bridge",
        title: "WS bridge",
        status: "warn",
        detail: `something is listening on port ${env.wsPort}, but no MANTA_TOKEN was found to verify it`,
        solution:
          "Re-copy the install prompt from the extension (Action tab → Copy install " +
          "prompt) and update the MCP config env, or set MANTA_TOKEN.",
      };
    } else {
      const probe = await probeBridge(env.wsPort, env.token);
      if (probe.outcome === "running") {
        bridgeOk = true;
        const info = await queryExtensionInfo(probe.peer);
        const extensionVersion = info ? info.version : null;
        await probe.peer.close().catch(() => {});
        bridge = {
          id: "bridge",
          section: "bridge",
          title: "WS bridge",
          status: "ok",
          detail: "owner running, token valid",
        };
        push(bridge);
        // Extension + version skew — only meaningful with a live bridge.
        if (extensionVersion !== null) {
          push({
            id: "extension",
            section: "bridge",
            title: "Chrome extension",
            status: "ok",
            detail: `connected${extensionVersion ? `, v${extensionVersion}` : ""}`,
          });
          const { match, hint } = compatVerdict(PKG_VERSION, extensionVersion);
          if (!match && hint) {
            push({
              id: "versions",
              section: "bridge",
              title: "Version skew",
              status: "warn",
              detail: `server ${PKG_VERSION} vs extension ${extensionVersion}`,
              solution: hint,
            });
          }
        } else {
          push({
            id: "extension",
            section: "bridge",
            title: "Chrome extension",
            status: "fail",
            detail: "the owner is running but no extension is connected",
            solution:
              "Open Chrome and make sure the Manta Action Kit extension is enabled — it dials " +
              `ws://127.0.0.1:${env.wsPort} automatically. Check the extension's bridge port ` +
              "setting matches MANTA_WS_PORT.",
          });
        }
      } else if (probe.outcome === "not-running") {
        // Raced out — the listener went away between the TCP check and now.
        bridge = {
          id: "bridge",
          section: "bridge",
          title: "WS bridge",
          status: "warn",
          detail: `nothing is listening on port ${env.wsPort}`,
          solution:
            "Agents launch the server from their MCP config on startup; prewarm with " +
            "`npx -y @manta-action-kit/mcp@latest --version`.",
        };
      } else {
        const mismatch = /token mismatch/i.test(probe.detail);
        bridge = {
          id: "bridge",
          section: "bridge",
          title: "WS bridge",
          status: "fail",
          detail: mismatch
            ? "a manta owner is running, but the token does not match the extension's"
            : "the port is occupied by an unrecognized process",
          fixPrompt: mismatch
            ? "Update MANTA_TOKEN in the installed agent configs?"
            : undefined,
          fix: mismatch
            ? async () => {
                const pasted = await clack.text({
                  message:
                    "Paste the extension's install prompt (or just the MANTA_TOKEN value):",
                  validate: (v) =>
                    v && v.trim()
                      ? undefined
                      : "Paste the prompt or the token (Ctrl-C to cancel)",
                });
                if (clack.isCancel(pasted))
                  throw new Error("cancelled — token unchanged");
                const fields = extractInstallFields(pasted);
                if (!fields.token)
                  throw new Error("no MANTA_TOKEN found in the input");
                const updated = await updateInstalledToken(fields.token);
                if (updated.length === 0)
                  throw new Error("no installed config was updated");
                return updated.join(", ");
              }
            : undefined,
          solution: mismatch
            ? "Or update MANTA_TOKEN manually in each agent's MCP config env (re-copy the install prompt from the extension)."
            : `Identify the squatter with \`lsof -nP -iTCP:${env.wsPort} -sTCP:LISTEN\` and free the port, or set MANTA_WS_PORT in the MCP config env to a free port (the extension discovers the relocation by scanning).`,
        };
      }
    }
  } else {
    bridge = {
      id: "bridge",
      section: "bridge",
      title: "WS bridge",
      status: "warn",
      detail: `nothing is listening on port ${env.wsPort}`,
      solution:
        "Normal if no agent session is open — agents launch the server from their MCP " +
        "config on startup. To prewarm the npx cache run: " +
        "`npx -y @manta-action-kit/mcp@latest --version`.",
    };
  }
  if (bridge !== undefined && !bridgeOk) push(bridge);
  return { bridgeOk, bridge };
}

/** HTTP proxy — only observable signal from outside is whether the port answers. */
async function collectProxyCheck(
  env: DoctorEnv,
  bridgeOk: boolean,
  push: CheckSink,
): Promise<Check | null> {
  if (!bridgeOk || (await isTcpOpen(env.proxyPort))) return null;
  const check: Check = {
    id: "proxy",
    section: "bridge",
    title: "HTTP proxy",
    status: "warn",
    detail: `not listening on port ${env.proxyPort} — script-driven proxy rules are unavailable`,
    solution:
      "Free the port or set MANTA_PROXY_PORT to a free port and restart; or ask an " +
      "agent session to call the rebind_proxy tool (self-heals without a restart).",
  };
  push(check);
  return check;
}

/** Run every check and collect the results (no output, no prompts). */
async function collectChecks(env: DoctorEnv): Promise<Check[]> {
  const checks: Check[] = [];
  const push: CheckSink = (c) => checks.push(c);
  await collectNodeChecks(push);
  await collectAgentChecks(env, push);
  const { bridgeOk } = await collectBridgeChecks(env, push);
  await collectProxyCheck(env, bridgeOk, push);
  return checks;
}

/** Render the collected checks as a boxed report card (clack note). */
function renderNote(checks: Check[], env: DoctorEnv): string {
  const lines: string[] = [];
  for (const sectionId of Object.keys(SECTION_TITLES) as SectionId[]) {
    const sectionChecks = checks.filter((c) => c.section === sectionId);
    if (sectionChecks.length === 0) continue;
    lines.push(SECTION_TITLES[sectionId]);
    if (sectionId === "env") {
      lines.push(
        "\u00b7 bridge 127.0.0.1:" + env.wsPort + ` (${env.sources.wsPort}) \u00b7 ` +
          "proxy 127.0.0.1:" + env.proxyPort + ` (${env.sources.proxyPort}) \u00b7 ` +
          "token: " + env.sources.token,
      );
    }
    for (const c of sectionChecks) {
      lines.push(
        ICON[c.status] + " " + c.title + (c.detail ? ` — ${c.detail}` : "") +
          (c.fix && c.status === "fail" ? " (auto-fixable)" : ""),
      );
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** Plain-text report for non-interactive runs, with solutions inline. */
function renderPlain(checks: Check[], env: DoctorEnv): string {
  const out: string[] = [];
  for (const sectionId of Object.keys(SECTION_TITLES) as SectionId[]) {
    const sectionChecks = checks.filter((c) => c.section === sectionId);
    if (sectionChecks.length === 0) continue;
    out.push(`\n— ${SECTION_TITLES[sectionId]} —`);
    if (sectionId === "env") {
      out.push(
        "[INFO] bridge 127.0.0.1:" + env.wsPort + ` (${env.sources.wsPort}) · ` +
          "proxy 127.0.0.1:" + env.proxyPort + ` (${env.sources.proxyPort}) · ` +
          "token: " + env.sources.token,
      );
    }
    for (const c of sectionChecks) {
      out.push("[" + c.status.toUpperCase() + "] " + c.title + ": " + c.detail);
      if (c.status !== "ok" && c.solution)
        out.push("  ↳ fix: " + c.solution);
    }
  }
  return out.join("\n");
}

/**
 * `doctor`: check silently → render one report card → offer fixes → re-check
 * → updated report + solutions for whatever remains. Returns the process exit
 * code (0 healthy/fixed, 1 when failures remain). Warnings never fail the
 * exit code (check-env convention).
 */
export async function runDoctor(): Promise<number> {
  const interactive = !!process.stdin.isTTY;
  if (interactive) showBanner("doctor");
  else console.log("manta-action-kit doctor (v" + PKG_VERSION + ")\n");

  const env = await resolveDoctorEnv();

  // Phase 1 — checks with per-step loading (clack tasks: spinner → ✓ per
  // group), then ONE uninterrupted report card.
  let checks: Check[];
  if (interactive) {
    const results: Check[] = [];
    const push: CheckSink = (c) => results.push(c);
    let bridgeOk = false;
    clack.log.step("Checking environment…");
    // Checks usually finish in single-digit milliseconds — the spinner would
    // never render a frame. Hold each step on screen for a beat so the
    // loading is actually visible (total ~1s, not a fake progress bar).
    const visible = async (work: Promise<string>): Promise<string> => {
      const [r] = await Promise.all([work, sleep(260)]);
      return r;
    };
    await clack.tasks([
      {
        title: "Node",
        task: async () =>
          visible(
            collectNodeChecks(push).then((c) => `Node — ${c.detail}`),
          ),
      },
      {
        title: "Agents",
        task: async () =>
          visible(
            collectAgentChecks(env, push).then((cs) => {
              const missing = cs.find((c) => c.id === "agents");
              if (missing) return `Agents — missing entry: ${missing.detail}`;
              const installed = cs.find((c) => c.id === "agents-installed");
              return installed
                ? `Agents — ${installed.detail}`
                : "Agents — none of the supported agents detected";
            }),
          ),
      },
      {
        title: "Bridge",
        task: async () =>
          visible(
            collectBridgeChecks(env, push).then((r) => {
              bridgeOk = r.bridgeOk;
              return `Bridge — ${r.bridge.detail}`;
            }),
          ),
      },
      {
        title: "Proxy",
        task: async () =>
          visible(
            (async () => {
              if (!bridgeOk) return "Proxy — skipped (bridge is down)";
              const c = await collectProxyCheck(env, bridgeOk, push);
              return c
                ? `Proxy — ${c.detail}`
                : `Proxy — listening on port ${env.proxyPort}`;
            })(),
          ),
      },
    ]);
    checks = results;
  } else {
    checks = await collectChecks(env);
  }

  if (interactive) {
    clack.note(renderNote(checks, env), "doctor report");
  } else {
    console.log(renderPlain(checks, env));
  }

  // Phase 2 — apply fixes (each confirmed), then re-check to show the result.
  const fixable = checks.filter((c) => c.fix);
  let anyFixed = false;
  if (interactive) {
    for (const check of fixable) {
      const go = await clack.confirm({
        message: check.fixPrompt ?? "Fix automatically?",
        initialValue: true,
      });
      if (clack.isCancel(go) || !go) continue;
      const s = clack.spinner();
      s.start("Fixing…");
      try {
        const what = await check.fix!();
        s.stop("Fixed — " + what);
        anyFixed = true;
      } catch (err) {
        s.stop("Fix failed");
        clack.log.error(err instanceof Error ? err.message : String(err));
      }
    }
    if (anyFixed) {
      // Re-collect so the final report reflects reality, not intent.
      const fresh = await resolveDoctorEnv();
      const spin2 = clack.spinner();
      spin2.start("Re-checking…");
      checks = await collectChecks(fresh);
      spin2.stop("Re-checked");
      clack.note(renderNote(checks, fresh), "updated report");
    }
  }

  // Phase 3 — solutions for whatever the (final) report still flags. The
  // plain report already embeds them inline; only the note card needs them
  // printed separately.
  if (interactive) {
    for (const c of checks) {
      if (c.status === "ok" || !c.solution) continue;
      clack.log.info("↳ " + c.title + " — " + c.solution);
    }
  }

  // Summary + exit code: warnings are not failures (check-env convention);
  // only remaining FAILs (including declined/failed fixes) count.
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const summary =
    failed > 0
      ? failed + " failure(s), " + warned + " warning(s) — fix the failures above and re-run"
      : warned > 0
        ? warned + " warning(s), no failures — warnings don't block anything"
        : "all checks passed";
  if (interactive) clack.outro(summary);
  else console.log("\n" + summary);
  return failed > 0 ? 1 : 0;
}
