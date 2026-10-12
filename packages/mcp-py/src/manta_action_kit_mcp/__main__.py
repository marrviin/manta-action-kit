"""Entry point: `manta-action-kit-mcp` (or `python -m manta_action_kit_mcp`).

Single-instance election mirrors the Node server: the first process binds the
WS bridge (owner) and later ones dial it as peers, so multiple concurrent
agent sessions share one bridge. Unlike the Node server, this process hosts
no script-driven HTTP proxy — proxy-rule scripts need the Node server.
"""

from __future__ import annotations

import logging
import os
import sys

import anyio

from . import __version__
from .protocol import DEFAULT_MCP_PORT
from .runtime import Runtime
from .server import build_server


async def _run() -> None:
    logging.basicConfig(
        stream=sys.stderr,
        level=os.environ.get("MANTA_LOG_LEVEL", "INFO").upper(),
        format="[manta-action-kit-mcp-py] %(name)s: %(message)s",
    )
    log = logging.getLogger("manta.mcp")

    port = int(os.environ.get("MANTA_WS_PORT") or DEFAULT_MCP_PORT)
    token = os.environ.get("MANTA_TOKEN")

    if not token:
        log.warning(
            "MANTA_TOKEN is not set. The bridge will reject every client (the "
            "extension's handshake requires it) and this process cannot become "
            "a peer. Re-copy the install prompt from the extension (Action tab "
            "→ Copy install prompt) and update your MCP config env."
        )

    rt = Runtime(port, token, __version__())
    await rt.elect()

    mcp = build_server(rt, __version__())
    log.info("ready (v%s, role=%s); MCP on stdio.", __version__(), rt.role)
    await mcp.run_stdio_async()


def main() -> None:
    anyio.run(_run)


if __name__ == "__main__":
    main()
