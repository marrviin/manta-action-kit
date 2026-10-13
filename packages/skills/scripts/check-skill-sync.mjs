#!/usr/bin/env node
/**
 * Skill ↔ tool-contract sync check.
 *
 * The skill (packages/skills/manta-action-kit/SKILL.md) hand-maintains the tool
 * surface; the contract fixture (packages/mcp-py/tests/fixtures/tool-contract.json)
 * is exported from the REAL Node registration. This script fails CI when they
 * drift:
 *
 *   1. frontmatter has name + description, description ≤ 1024 chars (the
 *      Claude Code skill description limit)
 *   2. every tool registered by the MCP server is mentioned in SKILL.md
 *      (catches "added a tool, forgot the skill")
 *   3. every lowercase snake_case token in SKILL.md backticks is a real tool
 *      (catches "renamed/removed a tool, stale skill")
 *   4. local files the SKILL.md links to exist (references/*, scripts/*)
 *
 * Run: pnpm sync:skill   (root package.json)
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SKILL_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "manta-action-kit",
);
const SKILL_MD = path.join(SKILL_DIR, "SKILL.md");
const CONTRACT = path.resolve(
  SKILL_DIR,
  "../../mcp-py/tests/fixtures/tool-contract.json",
);

/** snake_case backtick tokens that are NOT tool names (escape hatch, keep small). */
const NON_TOOL_TOKENS = new Set();

const failures = [];
const fail = (msg) => failures.push(msg);

if (!existsSync(SKILL_MD)) {
  console.error(`❌ ${path.relative(process.cwd(), SKILL_MD)} not found`);
  process.exit(1);
}
if (!existsSync(CONTRACT)) {
  console.error(
    `❌ ${path.relative(process.cwd(), CONTRACT)} not found — run \`pnpm --filter @manta-action-kit/mcp contract:export\` first`,
  );
  process.exit(1);
}

const skill = readFileSync(SKILL_MD, "utf8");
const tools = JSON.parse(readFileSync(CONTRACT, "utf8")).map((t) => t.name);

// ── frontmatter ──────────────────────────────────────────────────────────────
const fmMatch = skill.match(/^---\n([\s\S]*?)\n---/);
if (!fmMatch) {
  fail("SKILL.md has no YAML frontmatter");
} else {
  const fm = fmMatch[1];
  const name = fm.match(/^name:\s*(\S+)/m)?.[1];
  if (name !== "manta-action-kit")
    fail(`frontmatter name is "${name}", expected "manta-action-kit"`);

  const descMatch = fm.match(/^description:\s*>-\n((?: {2}.*\n?)+)/m);
  if (!descMatch) {
    fail("frontmatter description missing or not a folded block (>-)");
  } else {
    const desc = descMatch[1]
      .split("\n")
      .map((l) => l.replace(/^ {2}/, ""))
      .join(" ")
      .trim();
    if (desc.length > 1024) {
      fail(
        `description is ${desc.length} chars — the Claude Code skill description limit is 1024; trim it`,
      );
    }
  }
}

// ── 2. every registered tool is mentioned in SKILL.md ────────────────────────
const missing = tools.filter((t) => !skill.includes(t));
if (missing.length > 0) {
  fail(
    `tools registered by the MCP server but never mentioned in SKILL.md: ${missing.join(", ")} — document them (section 3) or remove them from the server`,
  );
}

// ── 3. no stale tool names in SKILL.md ───────────────────────────────────────
const mentioned = [...skill.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map(
  (m) => m[1],
);
const stale = [...new Set(mentioned)].filter(
  (t) => !NON_TOOL_TOKENS.has(t) && !tools.includes(t),
);
if (stale.length > 0) {
  fail(
    `SKILL.md mentions snake_case tools the server does not register: ${stale.join(", ")} — stale name after a rename? (add to NON_TOOL_TOKENS in check-skill-sync.mjs if it is not a tool)`,
  );
}

// ── 4. linked local files exist ──────────────────────────────────────────────
for (const [, rel] of skill.matchAll(
  /\]\((references\/[^)#]+|scripts\/[^)#]+)\)/g,
)) {
  if (!existsSync(path.join(SKILL_DIR, rel))) {
    fail(`SKILL.md links to "${rel}" which does not exist`);
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(`❌ ${f}`);
  console.error(
    `\nskill/contract sync FAILED (${failures.length} issue${failures.length > 1 ? "s" : ""}, ${tools.length} registered tools)`,
  );
  process.exit(1);
}
console.log(
  `✅ skill ↔ contract in sync (${tools.length} registered tools, all documented; description within 1024 chars)`,
);
