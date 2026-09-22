# @manta-action-kit/skills

Agent skills (Claude Code Skill format) — teaches agents to use and debug the
Manta Action Kit MCP server (`packages/mcp`).

## Included skills

| Directory | Description |
| --- | --- |
| `manta-action-kit` | Suite usage guide: environment check & init, extension/MCP/connection troubleshooting, reading recordings, proxy forwarding, debug workflows. Ships with `scripts/check-env.mjs` for a one-shot health check |

## How it takes effect in this repo

`.claude/skills/manta-action-kit` at the repo root is a **symlink** to this
package, so Claude Code discovers and loads it on demand (or manually via
`/manta-action-kit`). No setup needed after cloning.

## Install into other projects

```bash
npx degit marrviin/manta-action-kit/packages/skills/manta-action-kit ~/.claude/skills/manta-action-kit
# Or after publishing:
# npm i @manta-action-kit/skills && cp -r node_modules/@manta-action-kit/skills/manta-action-kit ~/.claude/skills/
```

## Publishing

```bash
cd packages/skills && npm publish
```

To add a new skill, create `packages/skills/<kebab-case-name>/SKILL.md` (the
frontmatter must contain `name` and `description`; make `description` spell out
its trigger phrases — agents rely on it to decide whether to load).
