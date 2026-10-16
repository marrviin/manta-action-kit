/**
 * CLI subcommands for the manta-action-kit-mcp bin, handled BEFORE server
 * startup (see index.ts):
 *
 *   manta-action-kit-mcp init (i)   Detect locally installed agent hosts
 *                                   (Claude Code, Claude Desktop, Cursor,
 *                                   Windsurf, VS Code, Codex CLI), let the
 *                                   user multi-select them, and upsert the
 *                                   manta-action-kit server entry into each
 *                                   one's MCP config.
 *   manta-action-kit-mcp doctor (d) Check the environment (Node, agent configs,
 *                                   bridge, extension) — auto-fix what it can
 *                                   with user confirmation, print solutions
 *                                   for the rest.
 *   manta-action-kit-mcp -v         Print the package version and exit.
 *   manta-action-kit-mcp -h         Usage.
 *
 * The written entry mirrors the extension's install prompt (buildInstallPrompt
 * in the extension): `npx -y @manta-action-kit/mcp@latest` + the port/token
 * env. The handshake token is NOT readable from here (it lives in the
 * extension's IndexedDB), so init asks the user to paste the install prompt
 * (or just the token) and extracts it — without a matching token the bridge
 * rejects every client (fail closed).
 *
 * Interactive prompts (multi-select, paste input) use @clack/prompts.
 */
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as clack from "@clack/prompts";
import { DEFAULT_MCP_PORT, DEFAULT_PROXY_PORT } from "./protocol.js";
import { runDoctor } from "./doctor.js";

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("../package.json") as {
  version: string;
};

/** The MCP server entry name written into every agent config. */
export const SERVER_KEY = "manta-action-kit";

/** The published package name run via `npx -y <pkg>@latest` (matches the extension's install prompt). */
export const MCP_PACKAGE = "@manta-action-kit/mcp";

/** Shape of one agent's MCP server entry (JSON configs; Codex is serialized from the same shape). */
export type ServerEntry = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

/** Build the server entry exactly as the extension's install prompt describes it. */
export function buildServerEntry(
  wsPort: number,
  proxyPort: number,
  token?: string,
): ServerEntry {
  const env: Record<string, string> = {
    MANTA_WS_PORT: String(wsPort),
    MANTA_PROXY_PORT: String(proxyPort),
  };
  if (token) env.MANTA_TOKEN = token;
  return { command: "npx", args: ["-y", `${MCP_PACKAGE}@latest`], env };
}

// --- Agent registry ---------------------------------------------------------

/** One supported agent host: where its MCP config lives and how to detect it. */
export type AgentSpec = {
  id: string;
  label: string;
  /** Absolute path of the MCP config file for the current platform. */
  configPath: () => string;
  /** Root key holding server entries ("mcpServers" everywhere except VS Code's "servers"). */
  rootKey: "mcpServers" | "servers";
  /** Cheap local check that this agent is (probably) installed. */
  detect: () => boolean;
};

/** The user's VS Code user-config dir, or null if not a supported platform shape. */
function vscodeUserDir(): string {
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Code", "User");
    case "win32":
      return join(process.env.APPDATA ?? "", "Code", "User");
    default:
      return join(homedir(), ".config", "Code", "User");
  }
}

/** Claude Desktop's config dir, or "" when it can't exist on this platform. */
function claudeDesktopDir(): string {
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Claude");
    case "win32":
      return join(process.env.APPDATA ?? "", "Claude");
    default:
      return join(homedir(), ".config", "Claude");
  }
}

export /** True when `cmd` resolves somewhere on PATH (cheap sync check). */
function onPath(cmd: string): boolean {
  const dirs = (process.env.PATH ?? "").split(/[:;]/).filter(Boolean);
  const exts = platform() === "win32" ? ["", ".exe", ".cmd"] : [""];
  return dirs.some((dir) =>
    exts.some((ext) => existsSync(join(dir, `${cmd}${ext}`))),
  );
}

/** True when a macOS app bundle exists in /Applications (no-op elsewhere). */
function hasAppBundle(name: string): boolean {
  return platform() === "darwin" && existsSync(join("/Applications", name));
}

/**
 * True when the agent's config already carries a manta-action-kit entry —
 * proof the agent existed and was WIRED UP, even if the binary/app is now
 * gone. Distinguishes "configured once" from leftover config files (which
 * survive uninstalls and would otherwise read as installed agents).
 */
function configHasManta(configPath: string): boolean {
  try {
    return readFileSync(configPath, "utf8").includes(SERVER_KEY);
  } catch {
    return false;
  }
}

export const AGENTS: AgentSpec[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    configPath: () => join(homedir(), ".claude.json"),
    rootKey: "mcpServers",
    // ~/.claude / ~/.claude.json exist for anyone who has launched the CLI once.
    detect: () =>
      onPath("claude") || existsSync(join(homedir(), ".claude.json")),
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    configPath: () => join(claudeDesktopDir(), "claude_desktop_config.json"),
    rootKey: "mcpServers",
    // The support dir AND its config file both survive uninstalls — on macOS
    // require the app bundle (or a config that actually has manta wired in).
    detect: () =>
      hasAppBundle("Claude.app") ||
      configHasManta(join(claudeDesktopDir(), "claude_desktop_config.json")) ||
      (platform() !== "darwin" &&
        existsSync(join(claudeDesktopDir(), "claude_desktop_config.json"))),
  },
  {
    id: "cursor",
    label: "Cursor",
    configPath: () => join(homedir(), ".cursor", "mcp.json"),
    rootKey: "mcpServers",
    // A bare ~/.cursor dir (or its mcp.json) can outlive an uninstall.
    detect: () =>
      onPath("cursor") ||
      hasAppBundle("Cursor.app") ||
      configHasManta(join(homedir(), ".cursor", "mcp.json")),
  },
  {
    id: "windsurf",
    label: "Windsurf",
    configPath: () =>
      join(homedir(), ".codeium", "windsurf", "mcp_config.json"),
    rootKey: "mcpServers",
    detect: () =>
      onPath("windsurf") ||
      hasAppBundle("Windsurf.app") ||
      configHasManta(
        join(homedir(), ".codeium", "windsurf", "mcp_config.json"),
      ),
  },
  {
    id: "vscode",
    label: "VS Code",
    configPath: () => join(vscodeUserDir(), "mcp.json"),
    rootKey: "servers",
    detect: () =>
      onPath("code") ||
      hasAppBundle("Visual Studio Code.app") ||
      configHasManta(join(vscodeUserDir(), "mcp.json")),
  },
  {
    id: "codex",
    label: "Codex CLI",
    configPath: () => join(homedir(), ".codex", "config.toml"),
    rootKey: "mcpServers", // unused — Codex config is TOML, see upsertCodexServer
    // ~/.codex can hold leftovers (auth, sessions, config.toml) from a removed
    // install — only the binary on PATH or a wired-in manta entry proves use.
    detect: () =>
      onPath("codex") ||
      configHasManta(join(homedir(), ".codex", "config.toml")),
  },
];

// --- Config upserts ---------------------------------------------------------

/**
 * Upsert the server entry into a JSON MCP config (Claude/Cursor/Windsurf/VS Code).
 * Rewrites the file as 2-space JSON — same as those editors do — preserving every
 * other key. `created`/`updated` lets the caller report what happened.
 */
export async function upsertJsonServer(
  configPath: string,
  rootKey: "mcpServers" | "servers",
  entry: ServerEntry,
): Promise<"created" | "updated"> {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (err) {
    // Missing file → start fresh. A CORRUPTED file must not be silently
    // truncated (it may hold the user's other servers) — surface it instead.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `${configPath} exists but is not valid JSON — fix or remove it first.`,
        { cause: err },
      );
    }
  }
  const servers = (config[rootKey] ??= {});
  if (
    typeof servers !== "object" ||
    servers === null ||
    Array.isArray(servers)
  ) {
    throw new Error(
      `${configPath}: "${rootKey}" is not an object — fix it manually first.`,
    );
  }
  const existed = SERVER_KEY in (servers as Record<string, unknown>);
  (servers as Record<string, unknown>)[SERVER_KEY] = entry;
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  return existed ? "updated" : "created";
}

/** Render one Codex config.toml section for the server entry. */
export function codexSection(entry: ServerEntry): string[] {
  const env = Object.entries(entry.env)
    .map(([k, v]) => `${k} = "${v}"`)
    .join(", ");
  return [
    `[mcp_servers.${SERVER_KEY}]`,
    `command = "${entry.command}"`,
    `args = [${entry.args.map((a) => `"${a}"`).join(", ")}]`,
    `env = { ${env} }`,
  ];
}

/**
 * Upsert the server entry into Codex's config.toml. TOML is edited as TEXT (no
 * toml dep): an existing `[mcp_servers.manta-action-kit]` section is replaced
 * in place (up to the next section header), otherwise the section is appended.
 */
export async function upsertCodexServer(
  configPath: string,
  entry: ServerEntry,
): Promise<"created" | "updated"> {
  const section = codexSection(entry);
  const header = `[mcp_servers.${SERVER_KEY}]`;
  let text = "";
  try {
    text = await readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === header);
  if (start >= 0) {
    // Replace through the end of the section (next header or EOF).
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].trim().startsWith("[")) {
        end = i;
        break;
      }
    }
    lines.splice(start, end - start, ...section);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, lines.join("\n"));
    return "updated";
  }
  const base = text.trimEnd();
  const next = base
    ? `${base}\n\n${section.join("\n")}\n`
    : `${section.join("\n")}\n`;
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, next);
  return "created";
}

// --- Install-prompt parsing -------------------------------------------------

/** Fields extractable from a pasted install prompt / env JSON line. */
export type InstallFields = {
  token?: string;
  wsPort?: number;
  proxyPort?: number;
};

/**
 * Extract the token and ports from pasted text (the extension's install prompt,
 * just its `env: { ... }` line, or a bare token UUID). Everything is optional —
 * the caller decides what was missing.
 */
export function extractInstallFields(text: string): InstallFields {
  const out: InstallFields = {};
  const str = (key: string) =>
    text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`))?.[1];
  const token = str("MANTA_TOKEN");
  if (token) out.token = token;
  const wsPort = Number(str("MANTA_WS_PORT"));
  if (wsPort > 0) out.wsPort = wsPort;
  const proxyPort = Number(str("MANTA_PROXY_PORT"));
  if (proxyPort > 0) out.proxyPort = proxyPort;
  // Bare token: a lone line that is just a UUID (v4-shaped, like the extension
  // generates) — only when the JSON extraction found nothing.
  if (!out.token) {
    const bare = text
      .trim()
      .match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    if (bare) out.token = bare[0];
  }
  return out;
}

// --- Commands ---------------------------------------------------------------

function printUsage(): void {
  console.log(`manta-action-kit-mcp <command>

Commands:
  init, i       Install the MCP server entry into local agent hosts (interactive)
  doctor, d     Check the environment; offers to auto-fix what it can
  -v, --version
                Print the version
  -h, --help    This help

Without arguments the process runs as the MCP stdio server (that is what agent
configs launch — don't add arguments there).`);
}

/**
 * Brand banner shared by the CLI subcommands — the MANTA wordmark in ANSI
 * Shadow glyphs (cyan) plus a one-line tagline, versioned in the title.
 */
const MANTA_LOGO = [
  "███╗   ███╗ █████╗ ███╗   ██╗████████╗ █████╗",
  "████╗ ████║██╔══██╗████╗  ██║╚══██╔══╝██╔══██╗",
  "██╔████╔██║███████║██╔██╗ ██║   ██║   ███████║",
  "██║╚██╔╝██║██╔══██║██║╚██╗██║   ██║   ██╔══██║",
  "██║ ╚═╝ ██║██║  ██║██║ ╚████║   ██║   ██║  ██║",
  "╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝",
];

export function showBanner(sub: string): void {
  const logo = MANTA_LOGO.map((l) => `\x1b[36m${l}\x1b[0m`).join("\n");
  clack.note(
    `${logo}\n\n` +
      `\x1b[2m  record API flows \u2192 distill into actions \u2192 replay with your login state\x1b[0m`,
    `${sub} \u00b7 v${PKG_VERSION}`,
  );
}

/**
 * `init`: detect agents → multi-select → resolve token/ports → write configs.
 * Returns the number of configs written (0 on cancel / nothing suitable).
 */
export async function runInit(): Promise<number> {
  if (!process.stdin.isTTY) {
    console.error(
      "init needs an interactive terminal (piped stdin detected). " +
        "Run it directly: npx -y @manta-action-kit/mcp@latest init",
    );
    return 0;
  }

  showBanner("init");

  const items = AGENTS.map((a) => {
    const detected = a.detect();
    return { spec: a, detected };
  });
  const selected = await clack.multiselect({
    message: "Install the manta-action-kit MCP server into:",
    options: items.map(({ spec, detected }) => ({
      value: spec.id,
      label: spec.label,
      hint: detected ? "detected" : "not detected",
    })),
    initialValues: items
      .filter(({ detected }) => detected)
      .map(({ spec }) => spec.id),
    required: true,
  });
  if (clack.isCancel(selected)) {
    clack.cancel("Cancelled — nothing written.");
    return 0;
  }

  // Ports: env override (same vars the server itself reads), else the values
  // pasted from the install prompt, else the package defaults.
  // Token: env first, else ask for the extension's install prompt. Paste-safe:
  // accept the whole prompt, the `env: {...}` line, or a bare token UUID.
  let token = process.env.MANTA_TOKEN || undefined;
  let fields: InstallFields = {};
  if (!token) {
    const pasted = await clack.text({
      message:
        "Paste the install prompt from the Chrome extension " +
        "(side panel → Action tab → Copy install prompt), or just the MANTA_TOKEN value:",
      placeholder: "Install this MCP service… / 3f2504e0-4f89-…",
      validate: (v) =>
        v && v.trim()
          ? undefined
          : "Paste the prompt or the token (Ctrl-C to cancel)",
    });
    if (clack.isCancel(pasted)) {
      clack.cancel("Cancelled — nothing written.");
      return 0;
    }
    fields = extractInstallFields(pasted);
    token = fields.token;
    if (!token) {
      clack.log.warn(
        "No token found in the input — the config will be written WITHOUT MANTA_TOKEN " +
          "and the extension will reject every connection until you add it " +
          "(re-copy the install prompt and fix the env block).",
      );
    }
  }
  const wsPort =
    Number(process.env.MANTA_WS_PORT) || fields.wsPort || DEFAULT_MCP_PORT;
  const proxyPort =
    Number(process.env.MANTA_PROXY_PORT) ||
    fields.proxyPort ||
    DEFAULT_PROXY_PORT;

  const entry = buildServerEntry(wsPort, proxyPort, token);
  let written = 0;
  for (const id of selected) {
    const spec = items.find(({ spec }) => spec.id === id)!.spec;
    try {
      const outcome =
        spec.id === "codex"
          ? await upsertCodexServer(spec.configPath(), entry)
          : await upsertJsonServer(spec.configPath(), spec.rootKey, entry);
      clack.log.success(`${spec.label}: ${outcome} ${spec.configPath()}`);
      written++;
    } catch (err) {
      clack.log.error(
        `${spec.label}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (written > 0) {
    clack.outro(
      `Restart the selected agents (or reload their MCP config) to pick up the server. ` +
        `Make sure the Manta Action Kit extension is running and its bridge port matches ` +
        `(MANTA_WS_PORT=${wsPort}).`,
    );
  } else {
    clack.cancel("No config was written.");
  }
  return written;
}

/**
 * Route CLI args. Returns true when a subcommand was handled (caller must NOT
 * start the MCP server); false means "no CLI args — run the server".
 */
export async function handleCli(args: string[]): Promise<boolean> {
  if (args.length === 0) return false;
  const [first] = args;
  if (first === "-v" || first === "--version" || first === "version") {
    console.log(`manta-action-kit-mcp ${PKG_VERSION}`);
    return true;
  }
  if (first === "-h" || first === "--help" || first === "help") {
    printUsage();
    return true;
  }
  if (first === "i" || first === "init") {
    await runInit();
    return true;
  }
  if (first === "d" || first === "doctor") {
    const code = await runDoctor();
    process.exitCode = code;
    return true;
  }
  console.error(
    `[manta-action-kit-mcp] unknown argument "${first}" — run with --help for usage.`,
  );
  return true;
}
