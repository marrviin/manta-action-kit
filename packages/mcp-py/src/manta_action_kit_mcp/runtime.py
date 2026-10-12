"""Single-instance runtime: owner/peer election + role-agnostic RPC.

Python port of the election scaffolding in packages/mcp/src/index.ts.

Every MCP process starts identically, then races for the WS bridge port:
  - OWNER: won the port. Hosts the WS bridge (extension dials in). Tool calls
    go straight to the extension. (The Node owner also hosts the script-driven
    HTTP proxy; the Python port does not implement that yet.)
  - PEER : lost the port. Dials the owner's bridge as a client and forwards
    every tool call to it. When the owner exits, re-runs the election, so one
    of the peers takes over without a manual restart.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .bridge import Bridge, BridgeNotReady
from .peer_client import PeerClient

logger = logging.getLogger("manta.mcp")

#: Election retry window — covers the race where the previous owner is exiting
#: (its port still looks busy while its listener won't accept us as a peer yet).
ELECT_ATTEMPTS = 10
ELECT_BACKOFF_S = 0.15


class Runtime:
    """Holds the current role and link; every tool call routes through here."""

    def __init__(self, ws_port: int, token: str | None, version: str) -> None:
        self.ws_port = ws_port
        self.token = token
        self.version = version
        self.role: str = "none"
        self.bridge: Bridge | None = None
        self.peer: PeerClient | None = None
        self._electing = False

    # ── role-agnostic RPC ──────────────────────────────────────────────────

    async def call(
        self, method: str, params: Any = None, timeout_ms: int = 10_000
    ) -> Any:
        if self.role == "owner" and self.bridge is not None:
            return await self.bridge.call(method, params, timeout_ms)
        if self.role == "peer" and self.peer is not None:
            return await self.peer.call(method, params, timeout_ms)
        raise BridgeNotReady("MCP bridge not ready (no owner or peer link).")

    def extension_connected(self) -> bool:
        if self.role == "owner":
            return self.bridge is not None and self.bridge.is_connected()
        if self.role == "peer":
            return self.peer is not None and self.peer.is_connected()
        return False

    def health_snapshot(self) -> dict[str, Any]:
        # The Python port hosts no script-driven HTTP proxy (yet), so
        # proxyListening is always false regardless of role.
        return {
            "role": self.role,
            "wsPort": self.ws_port,
            "proxyPort": None,
            "proxyListening": False,
            "extensionConnected": self.extension_connected(),
        }

    # ── election ───────────────────────────────────────────────────────────

    async def elect(self) -> None:
        """Try to become owner, else peer, with a small retry window. On
        owner loss later, the peer client triggers re-election."""
        if self._electing:
            return
        self._electing = True
        try:
            for _attempt in range(ELECT_ATTEMPTS):
                if await self._try_become_owner():
                    return
                if await self._try_become_peer():
                    return
                await asyncio.sleep(ELECT_BACKOFF_S)
            logger.warning(
                "could not become owner or peer on port %d after retries. Tool "
                "calls will fail until an instance owns the bridge. Check for a "
                "stuck process or set MANTA_WS_PORT to a free port.",
                self.ws_port,
            )
        finally:
            self._electing = False

    async def _try_become_owner(self) -> bool:
        bridge = Bridge(self.ws_port, self.token)
        try:
            await bridge.start()
        except OSError:
            # Port busy — abandon this bridge and go peer.
            await bridge.close()
            return False
        self.role = "owner"
        self.bridge = bridge
        self.peer = None
        logger.info(
            "role=owner. Bridge on ws://127.0.0.1:%d (no local HTTP proxy in the "
            "Python port — script-driven proxy rules are unavailable).",
            bridge.port(),
        )
        return True

    async def _try_become_peer(self) -> bool:
        if not self.token:
            # The owner's handshake requires the token; don't even dial.
            return False
        peer = PeerClient(
            self.ws_port,
            self.token,
            version=self.version,
            on_owner_lost=self._on_owner_lost,
        )
        try:
            await peer.start()
        except (OSError, TimeoutError, RuntimeError, asyncio.TimeoutError):
            await peer.close()
            return False
        self.role = "peer"
        self.peer = peer
        self.bridge = None
        logger.info(
            "role=peer. Forwarding to owner at ws://127.0.0.1:%d.", self.ws_port
        )
        return True

    def _on_owner_lost(self) -> None:
        logger.warning("owner lost — re-electing.")
        # Re-run the election on the loop. Any error just leaves us
        # disconnected; tool calls then fail with a clear message until an
        # owner is available again.
        asyncio.get_running_loop().create_task(self._reelect())

    async def _reelect(self) -> None:
        self.role = "none"
        self.peer = None
        self.bridge = None
        await self.elect()

    async def close(self) -> None:
        for link in (self.bridge, self.peer):
            if link is not None:
                await link.close()
        self.role = "none"
        self.bridge = None
        self.peer = None
