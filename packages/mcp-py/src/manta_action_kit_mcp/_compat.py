"""Version-compat diagnostics — Python mirror of packages/mcp/src/compat.ts.

The extension and the MCP server ship in lockstep (one version number, synced
by `pnpm version:sync`), but they are INSTALLED independently: the extension
auto-updates through Chrome while the MCP server only moves when the user's
MCP config re-runs `npx` / upgrades the pip package. A skew is therefore
common, and its worst property is silence — the newer side's features quietly
do nothing or behave differently on the older side.

These helpers turn a version skew into an actionable message at the few points
where an agent or user is already looking (health, a suspicious execute_action
result, check-env). Deliberately no per-feature minimum versions: with
lockstep releases, "versions differ" IS the diagnosis.
"""

from __future__ import annotations

import re

_SEMVER_RE = re.compile(r"^v?(\d+)\.(\d+)(?:\.(\d+))?")


def semver_compare(a: str, b: str) -> int:
    """Compare two `x.y.z` version strings (mirrors compat.ts's semverCompare).
    Negative when a < b, 0 when equal, positive when a > b. Missing segments
    count as 0, so "1.2" < "1.2.1"."""
    ma = _SEMVER_RE.match(a)
    mb = _SEMVER_RE.match(b)
    pa = [int(g) for g in ma.groups()] if ma else [0, 0, 0]
    pb = [int(g) for g in mb.groups()] if mb else [0, 0, 0]
    pa += [0] * (3 - len(pa))
    pb += [0] * (3 - len(pb))
    for da, db in zip(pa, pb):
        if da != db:
            return da - db
    return 0


def compat_verdict(
    server_version: str | None, extension_version: str | None
) -> dict[str, object]:
    """Judge a server↔extension version pair (mirrors compat.ts's compatVerdict).
    Returns {"match": bool, "hint": str | None} — hint is null when versions
    match or either side is unknown (nothing actionable to claim)."""
    if not server_version or not extension_version:
        return {"match": False, "hint": None}
    if server_version == extension_version:
        return {"match": True, "hint": None}
    interpolation = {"server": server_version, "extension": extension_version}
    if semver_compare(server_version, extension_version) > 0:
        return {
            "match": False,
            "hint": (
                "The MCP server (v%(server)s) is NEWER than the Chrome extension "
                "(v%(extension)s). Newer features may silently do nothing on the "
                "older extension. Fix: update the extension (Chrome Web Store "
                "auto-update, or remove + re-install from the extension's install "
                "prompt), then confirm with this tool." % interpolation
            ),
        }
    return {
        "match": False,
        "hint": (
            "The Chrome extension (v%(extension)s) is NEWER than the MCP server "
            "(v%(server)s). Newer features may be missing or behave differently. "
            "Fix: update the MCP server — re-run the npx install command from the "
            "extension's install prompt in your MCP config (or pip install -U "
            "manta-action-kit-mcp for the Python server)." % interpolation
        ),
    }


def continue_on_error_hint() -> str:
    """The hint attached to an execute_action result that ABORTED even though
    the caller asked for continueOnError (mirrors compat.ts's
    continueOnErrorHint) — on a current extension the run would have ended
    'completed-with-errors' instead, so this signature means the extension
    predates the feature and silently ignored the param."""
    return (
        "continueOnError was requested, but the run stopped at the first failed "
        "step (endReason 'aborted') — the connected Chrome extension likely "
        "predates that parameter and silently ignored it. Run the health tool to "
        "confirm the version skew; fix: update the extension (Chrome Web Store "
        "auto-update, or remove + re-install from the extension's install "
        "prompt) and retry."
    )
