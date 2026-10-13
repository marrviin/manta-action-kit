/**
 * Version-compat diagnostics.
 *
 * The extension and the MCP server ship in lockstep (one version number, synced
 * by `pnpm version:sync`), but they are INSTALLED independently: the extension
 * auto-updates through Chrome while the MCP server only moves when the user's
 * MCP config re-runs `npx` / upgrades the pip package. A skew is therefore
 * common, and its worst property is silence — the newer side's features
 * (new RPC params, new template syntax, trimmed list results) quietly do
 * nothing or behave differently on the older side.
 *
 * These helpers turn a version skew into an actionable message at the few
 * points where an agent or user is already looking (health, a suspicious
 * execute_action result, check-env). Deliberately no per-feature minimum
 * versions: with lockstep releases, "versions differ" IS the diagnosis.
 */

/**
 * Compare two `x.y.z` version strings. Returns negative if a < b, 0 if equal,
 * positive if a > b. Numeric per segment (leading "v" tolerated); missing
 * segments count as 0, so "1.2" < "1.2.1".
 */
export function semverCompare(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

export interface CompatVerdict {
  /** Versions are known and identical. */
  match: boolean;
  /** null when versions match or either side is unknown. */
  hint: string | null;
}

/**
 * Judge a server↔extension version pair and produce the fix hint when they
 * skew. An unknown version (null/undefined — old peer before the exchange,
 * or `extension_info` unsupported) yields match=false but NO hint: there is
 * nothing actionable to claim, and health still reports the raw versions.
 */
export function compatVerdict(
  serverVersion: string | null | undefined,
  extensionVersion: string | null | undefined,
): CompatVerdict {
  if (!serverVersion || !extensionVersion) return { match: false, hint: null };
  if (serverVersion === extensionVersion) return { match: true, hint: null };
  const cmp = semverCompare(serverVersion, extensionVersion);
  if (cmp > 0) {
    return {
      match: false,
      hint:
        `The MCP server (v${serverVersion}) is NEWER than the Chrome extension (v${extensionVersion}). ` +
        `Newer features may silently do nothing on the older extension. Fix: update the extension ` +
        `(Chrome Web Store auto-update, or remove + re-install from the extension's install prompt), ` +
        `then confirm with this tool.`,
    };
  }
  return {
    match: false,
    hint:
      `The Chrome extension (v${extensionVersion}) is NEWER than the MCP server (v${serverVersion}). ` +
      `Newer features may be missing or behave differently. Fix: update the MCP server — ` +
      `re-run the npx install command from the extension's install prompt in your MCP config ` +
      `(or pip install -U manta-action-kit-mcp for the Python server).`,
  };
}

/**
 * The hint attached to an execute_action result that ABORTED even though the
 * caller asked for continueOnError — on a current extension the run would have
 * ended 'completed-with-errors' instead, so this signature means the extension
 * predates the feature and silently ignored the param.
 */
export function continueOnErrorHint(): string {
  return (
    `continueOnError was requested, but the run stopped at the first failed step ` +
    `(endReason 'aborted') — the connected Chrome extension likely predates that ` +
    `parameter and silently ignored it. Run the health tool to confirm the version ` +
    `skew; fix: update the extension (Chrome Web Store auto-update, or remove + ` +
    `re-install from the extension's install prompt) and retry.`
  );
}
