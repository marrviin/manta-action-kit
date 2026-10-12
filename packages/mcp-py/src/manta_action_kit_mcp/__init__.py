"""Manta Action Kit MCP server (Python port).

Exposes the Chrome extension's recorded API calls to an agent as MCP tools,
over stdio. Data lives in the extension's IndexedDB, so every tool forwards to
the extension via the local WebSocket bridge (see bridge.py).

This is the minimal-useful subset of the Node server (packages/mcp):
recordings/actions discovery + execute_action + health. Config:
  MANTA_WS_PORT — local bridge port (must match the extension setting).
  MANTA_TOKEN   — handshake secret shared with the extension (from its install prompt).
"""

from .bridge import Bridge, BridgeNotReady
from .server import build_server


def __version__() -> str:
    """Package version, resolved from the installed distribution."""
    try:
        from importlib.metadata import version

        return version("manta-action-kit-mcp")
    except Exception:
        return "0.0.0"


__all__ = ["Bridge", "BridgeNotReady", "build_server", "__version__"]
