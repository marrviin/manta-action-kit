# Contributing

Thanks for helping improve Manta Action Kit. This guide covers the local
workflow and conventions.

## Prerequisites

- Node >= 20 (developed on Node 24)
- pnpm >= 9 (developed on pnpm 11)

This is a pnpm workspace (monorepo) with two packages: `packages/extension`
(WXT + React Chrome extension) and `packages/mcp` (Node MCP server).

## Setup

```bash
pnpm install          # installs deps + runs `wxt prepare`
```

## Development

```bash
pnpm dev              # start dev server with HMR (Chrome)
pnpm dev:firefox      # dev for Firefox
```

`pnpm dev` launches a browser with the extension auto-loaded. Popup/side panel
get full HMR; content scripts and background auto-reload.

## Pre-submit checks

Run all of these before opening a change; they must pass:

```bash
pnpm compile          # type-check the whole workspace (tsc --noEmit)
pnpm test             # unit suite (vitest)
pnpm lint             # eslint .
pnpm format:check     # prettier check
pnpm build            # production build of the extension
```

## Project layout

Architecture, data flow, and the rationale behind key decisions live in
[`CLAUDE.md`](CLAUDE.md) and [`README.md`](README.md). Read those before making
non-trivial changes.

## Commit conventions

The repo uses [Conventional Commits](https://www.conventionalcommits.org/).
Common prefixes: `feat:`, `fix:`, `refactor:`, `chore:`, `style:`. A `!` after
the type marks a breaking change (e.g. `refactor(UI)!:`). Scopes and subjects
may be written in Chinese, matching the existing history.

## File naming

- Files: lowercase kebab-case (e.g. `app-providers.tsx`, `use-recordings.ts`).
- React components: PascalCase identifiers (`AppProviders`).
- Hooks: camelCase identifiers (`useRecordings`).

Only file names are normalized to lowercase; exported identifiers keep their
conventional casing.

## Adding an extension entrypoint

Create a file or folder under `packages/extension/entrypoints/`; WXT wires it
into the manifest automatically — do not hand-edit the manifest.

## Adding a side-panel feature tab

Add an entry to the `FEATURES` array in
`packages/extension/entrypoints/sidepanel/app.tsx` plus its content component.
The settings gear logic is fixed and needs no changes.

## Other conventions

- **Cross-context messaging:** add message types to the `ProtocolMap` in
  `lib/messaging.ts`, then use `sendMessage(type, data)`.
- **Storage:** structured prefs/toggles go in `lib/storage.ts` items (reactive,
  cross-context); bulk recording data goes in IndexedDB (`lib/db.ts`).
- **Domain types:** the single source of truth is `lib/recording/types.ts`.
- **MAIN-world injection:** `injected-api-hook.ts` may only import pure
  types/constants (no extension APIs) and must stay registered in
  `web_accessible_resources`.
- **Path alias:** `@/` maps to the extension package root.
