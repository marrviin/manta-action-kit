"""Local WebSocket bridge server — Python port of packages/mcp/src/bridge.ts.

MV3 extensions can't listen on a port, so WE host the server on
ws://127.0.0.1:<port> (loopback only — the trust boundary) and the extension
dials in. The MCP tool layer calls `call(method, params)`; we forward it as an
`rpc` frame to the connected extension and resolve when the matching
`rpc-result` (by id) comes back.

At most one extension is expected; if several connect, the most recent wins.
Authenticated PEER processes (other MCP servers that lost the port race) are
accepted too; their `peer-rpc` frames are run against the extension here.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

from websockets.asyncio.server import Server, ServerConnection, serve
from websockets.exceptions import ConnectionClosedError

from . import protocol
from .auth import new_nonce, verify_auth_proof, welcome_proof

logger = logging.getLogger("manta.mcp.bridge")

#: Heartbeat cadence — the websockets library pings each socket every interval
#: and terminates it when no pong arrives within the timeout. Bounds half-open
#: detection (sleep/wake, Wi-Fi/VPN switch) the same way the Node bridge's
#: 30s ping / next-interval termination does. Browsers and node's `ws` answer
#: protocol-level pings automatically.
HEARTBEAT_INTERVAL_S = 30
HEARTBEAT_TIMEOUT_S = 30

#: A client must complete the challenge-response within this window.
HANDSHAKE_TIMEOUT_S = 10

#: Generous budget for running a PEER's forwarded call against the extension —
#: the peer's own per-call timeout stays the authority.
PEER_RPC_TIMEOUT_MS = 140_000


class BridgeNotReady(Exception):
    """Raised by call() when no authenticated extension/owner link is up."""


class _HandshakeRejected(Exception):
    """Internal: the handshake handler already closed the socket."""


def _rejection_hint(port: int, has_token: bool) -> str:
    """The human-facing fix-it message for a call with no link up (mirrors bridge.ts)."""
    if not has_token:
        return (
            "MCP bridge has no MANTA_TOKEN configured — re-copy the install prompt "
            "from the extension (Action tab) and update your MCP config env."
        )
    return (
        f"No authenticated Chrome extension connected. Confirm Chrome is running "
        f"with the extension and the port matches; if the extension shows "
        f'"auth failed", re-copy the install prompt and update the MCP config env. '
        f"(bridge port {port})"
    )


class Bridge:
    """Async WS bridge server. One instance per process (the OWNER role)."""

    def __init__(self, port: int, token: str | None, host: str = "127.0.0.1") -> None:
        self._port = port
        self._host = host
        self._token = token
        self._server: Server | None = None
        self._bound_port = port
        # id → (future, connection that carries it) — tagged so a takeover by a
        # re-connecting extension doesn't orphan the old socket's calls.
        self._pending: dict[str, tuple[asyncio.Future[Any], ServerConnection]] = {}
        self._active: ServerConnection | None = None
        self._id = 0
        self._closed = False

    # ── lifecycle ──────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Bind and start serving. Raises OSError (e.g. EADDRINUSE) if the port
        is taken — a failed bind is useless, callers should treat it as fatal
        (or run their own election)."""
        self._server = await serve(
            self._handler,
            self._host,
            self._port,
            ping_interval=HEARTBEAT_INTERVAL_S,
            ping_timeout=HEARTBEAT_TIMEOUT_S,
            # Node's `ws` allows ~100MB payloads; recordings with bodies can
            # be large. Keep parity so neither side truncates first.
            max_size=100 * 1024 * 1024,
        )
        sockets = getattr(self._server, "sockets", None) or []
        if sockets:
            self._bound_port = sockets[0].getsockname()[1]
        logger.info("listening on ws://%s:%d", self._host, self._bound_port)

    async def close(self) -> None:
        self._closed = True
        for fut, _conn in self._pending.values():
            if not fut.done():
                fut.set_exception(BridgeNotReady("bridge closing"))
        self._pending.clear()
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    # ── introspection ──────────────────────────────────────────────────────

    def is_connected(self) -> bool:
        """Is an extension currently connected?"""
        conn = self._active
        return conn is not None and conn.state.name == "OPEN"

    def port(self) -> int:
        """The actually bound port (resolves the ephemeral port when 0)."""
        return self._bound_port

    # ── RPC relay ──────────────────────────────────────────────────────────

    async def call(
        self, method: str, params: Any = None, timeout_ms: int = 10_000
    ) -> Any:
        """Invoke an RPC on the connected extension; raises if none or on timeout."""
        conn = self._active
        if self._closed or conn is None or conn.state.name != "OPEN":
            raise BridgeNotReady(
                _rejection_hint(self._bound_port, bool(self._token))
            )
        self._id += 1
        frame_id = f"rpc-{self._id}"
        frame = {"type": protocol.RPC, "id": frame_id, "method": method, "params": params}
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[frame_id] = (fut, conn)
        # One shared deadline for the send and the reply wait.
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_ms / 1000
        try:
            await asyncio.wait_for(
                conn.send(json.dumps(frame)),
                timeout=deadline - loop.time(),
            )
            return await asyncio.wait_for(fut, timeout=deadline - loop.time())
        except asyncio.TimeoutError:
            raise TimeoutError(
                f'RPC "{method}" timed out after {timeout_ms}ms'
            ) from None
        finally:
            self._pending.pop(frame_id, None)

    # ── connection handler ─────────────────────────────────────────────────

    async def _handler(self, conn: ServerConnection) -> None:
        # Web-page guard (defense in depth behind the token handshake): browsers
        # attach an Origin to cross-origin WebSockets, so a page dialing
        # ws://127.0.0.1 from the open web announces itself. Our real clients —
        # the extension's service worker and node's `ws` — send either no Origin
        # or a chrome-extension:// one.
        request = conn.request
        origin = request.headers.get("origin") if request else None
        if origin and not origin.startswith("chrome-extension://"):
            logger.info("rejecting web-originated client (Origin: %s)", origin)
            await conn.close(1008, "web origin rejected")
            return

        logger.debug("client connected")
        try:
            authed_role = await self._handshake(conn)
        except (TimeoutError, _HandshakeRejected):
            # _handshake already logged + closed the socket.
            return
        except Exception:
            logger.exception("handshake error")
            return
        if authed_role is None:
            return  # socket closed before the handshake completed

        if authed_role == protocol.ROLE_EXTENSION:
            logger.info("extension authenticated")
            self._active = conn
        else:
            logger.info("peer authenticated")

        try:
            async for raw in conn:
                try:
                    frame = json.loads(raw)
                except (TypeError, ValueError):
                    logger.info("dropping non-JSON frame")
                    continue
                if not isinstance(frame, dict):
                    continue
                await self._on_frame(conn, authed_role, frame)
        except ConnectionClosedError as err:
            # A client that dies without a close frame (killed process, TCP
            # reset) is routine — log it, don't stack-trace.
            logger.info("socket error: %s", err)
        finally:
            if authed_role == protocol.ROLE_EXTENSION and self._active is conn:
                logger.info("extension disconnected")
                self._active = None
            # Fail every in-flight call SENT ON THIS SOCKET immediately: the
            # extension can no longer answer them. Pending entries are tagged
            # with their connection at send time.
            for fid, (fut, pending_conn) in list(self._pending.items()):
                if pending_conn is conn and not fut.done():
                    fut.set_exception(
                        BridgeNotReady(
                            "extension disconnected while the RPC was in flight"
                        )
                    )
                    self._pending.pop(fid, None)

    async def _handshake(self, conn: ServerConnection) -> str | None:
        """Pre-auth challenge-response. Returns the authenticated role, or None
        if the socket closed first. Rejects (closes 1008) on any deviation."""
        stage = "hello"
        server_nonce = ""
        declared_role = protocol.ROLE_PEER
        try:
            async with asyncio.timeout(HANDSHAKE_TIMEOUT_S):
                async for raw in conn:
                    try:
                        frame = json.loads(raw)
                    except (TypeError, ValueError):
                        logger.info("dropping non-JSON frame")
                        continue
                    if not isinstance(frame, dict):
                        continue

                    if stage == "hello" and frame.get("type") == protocol.HELLO:
                        if not self._token:
                            logger.info(
                                "rejecting client: no MANTA_TOKEN configured — "
                                "re-copy the install prompt from the extension "
                                "(Action tab) and update the MCP config env"
                            )
                            await conn.close(1008, "no token configured")
                            raise _HandshakeRejected
                        role = frame.get("role")
                        nonce = frame.get("nonce")
                        if role not in (protocol.ROLE_EXTENSION, protocol.ROLE_PEER):
                            logger.info("unknown role %r — dropping client", role)
                            await conn.close(1008, "unknown role")
                            raise _HandshakeRejected
                        if not isinstance(nonce, str) or not nonce:
                            logger.info("hello without nonce — dropping client")
                            await conn.close(1008, "missing nonce")
                            raise _HandshakeRejected
                        # Remember the declared role now; it only takes EFFECT
                        # after the auth challenge below succeeds.
                        server_nonce = new_nonce()
                        stage = "auth"
                        declared_role = role
                        await conn.send(
                            json.dumps(
                                {
                                    "type": protocol.WELCOME,
                                    "proof": welcome_proof(self._token, nonce),
                                    "nonce": server_nonce,
                                }
                            )
                        )
                        continue

                    if stage == "auth" and frame.get("type") == protocol.AUTH:
                        # token is guaranteed non-None here: the hello branch
                        # rejects clients before the stage can advance.
                        assert self._token is not None
                        if verify_auth_proof(
                            self._token, server_nonce, frame.get("proof", "")
                        ):
                            return declared_role
                        logger.info(
                            "client failed the auth challenge — token mismatch "
                            "(re-copy the install prompt)"
                        )
                        await conn.close(1008, "auth failed")
                        raise _HandshakeRejected

                    logger.info(
                        'dropping unexpected "%s" frame before auth',
                        frame.get("type"),
                    )
                    await conn.close(1008, "unexpected pre-auth frame")
                    raise _HandshakeRejected
        except TimeoutError:
            logger.info("handshake timed out — dropping client")
            await conn.close(1008, "handshake timeout")
            return None
        return None  # socket closed before authed

    async def _on_frame(
        self, conn: ServerConnection, role: str, frame: dict[str, Any]
    ) -> None:
        ftype = frame.get("type")

        if ftype == protocol.PING:
            # App-level keepalive from the extension (browsers can't send WS
            # ping control frames). Replying keeps both directions' activity
            # flowing (MV3 service-worker keepalive).
            await conn.send(json.dumps({"type": protocol.PONG}))
            return

        if ftype == protocol.RPC_RESULT:
            entry = self._pending.get(frame.get("id"))
            if entry is None:
                return
            fut = entry[0]
            if fut.done():
                return
            if frame.get("ok") is True:
                fut.set_result(frame.get("result"))
            else:
                fut.set_exception(RuntimeError(str(frame.get("error"))))
            return

        # Peer → owner: run this RPC against the extension and ship the result
        # back. Generous timeout so the PEER's own per-call timeout stays the
        # authority (mirrors the Node bridge).
        if ftype == protocol.PEER_RPC and role == protocol.ROLE_PEER:
            rpc_id = frame.get("id")
            try:
                result = await self.call(
                    frame.get("method"), frame.get("params"), PEER_RPC_TIMEOUT_MS
                )
                reply = {
                    "type": protocol.PEER_RPC_RESULT,
                    "id": rpc_id,
                    "ok": True,
                    "result": result,
                }
            except Exception as err:
                reply = {
                    "type": protocol.PEER_RPC_RESULT,
                    "id": rpc_id,
                    "ok": False,
                    "error": str(err),
                }
            await conn.send(json.dumps(reply))
            return


