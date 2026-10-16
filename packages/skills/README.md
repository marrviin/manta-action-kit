# @manta-action-kit/skills

Agent skills (Claude Code Skill format) — teaches agents to set up, use and
debug the Manta Action Kit suite (Chrome extension + MCP server,
`packages/mcp`).

## Included skills

| Directory          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `manta-action-kit` | Setup & usage guide: first-time install and MCP registration for any client (via the `mcp init` CLI or manual configs), environment check & connection troubleshooting (the `mcp doctor` CLI, or `scripts/check-env.mjs` non-interactively), reading recordings, distilling and executing actions, recording filter rules, proxy rules, page capture. Dev-only guidance (builds, wire-compat checklist) lives in `references/dev-setup.md` |

## How it takes effect in this repo

`.claude/` is gitignored, so the symlink is not shipped — create it once after
cloning to let Claude Code discover the skill inside this repo (or invoke it
manually via `/manta-action-kit`):

```bash
mkdir -p .claude/skills && ln -sfn ../../skills/manta-action-kit .claude/skills/manta-action-kit
```

## Install into other projects

```bash
npx skills add marrviin/manta-action-kit -g -a claude-code -y   # global, Claude Code
# Or interactive: npx skills add marrviin/manta-action-kit      # pick agent + scope
```

Update later by re-running the same command, or `npx skills update -g`.

## Publishing

`npm publish` from this directory is an optional alternative distribution
channel; the supported install path is `npx skills add` above (it reads this
repo directly, so no publishing step is required).
