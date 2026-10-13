"""Peer client — the non-owner side of single-instance election.

Python port of packages/mcp/src/peer-client.ts.

Only ONE MCP server process can bind the WS bridge port and talk to the Chrome
extension directly (the "owner"). When a second process starts, it loses the
port race and becomes a "peer": instead of talking to the extension, it dials
the owner's WS bridge as a CLIENT and forwards every agent tool call as a
`peer-rpc` frame, awaiting the matching `peer-rpc-result` (correlated by id).
This mirrors Bridge.call() so the tool layer can use an owner bridge or a peer
client interchangeably.

If the owner goes away, the socket closes and `on_owner_lost` fires so the
caller can re-run the election (and become the new owner).
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed

from . import protocol
from .auth import auth_proof, new_nonce, verify_welcome_proof

logger = logging.getLogger("manta.mcp.peer")

#: Budget for the hello/welcome/auth exchange.
HANDSHAKE_TIMEOUT_S = 10

#: Node's `ws` allows ~100MB payloads; recordings with bodies can be large.
MAX_FRAME_BYTES = 100 * 1024 * 1024


class PeerLinkDown(Exception):
    """Raised by call() when the peer link to the owner is not usable."""


class PeerClient:
    """Async peer link to the owner's bridge."""

    def __init__(
        self,
        port: int,
        token: str,
        version: str = "0.0.0",
        host: str = "127.0.0.1",
        on_owner_lost: Callable[[], None] | None = None,
    ) -> None:
        self._port = port
        self._host = host
        self._token = token
        self._version = version
        self._on_owner_lost = on_owner_lost
        self._ws: ClientConnection | None = None
        self._pending: dict[str, asyncio.Future[Any]] = {}
        self._id = 0
        self._closing = False
        self._owner_lost_notified = False
        self._recv_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        """Dial the owner and complete the handshake. Raises on failure —
        a peer that can't handshake is useless, callers should re-elect."""
        url = f"ws://{self._host}:{self._port}"
        self._ws = await asyncio.wait_for(
            connect(url, max_size=MAX_FRAME_BYTES), HANDSHAKE_TIMEOUT_S
        )
        try:
            hello_nonce = new_nonce()
            await self._ws.send(
                json.dumps(
                    {
                        "type": protocol.HELLO,
                        "role": protocol.ROLE_PEER,
                        "version": self._version,
                        "nonce": hello_nonce,
                    }
                )
            )
            welcome = json.loads(await asyncio.wait_for(self._ws.recv(), HANDSHAKE_TIMEOUT_S))
            if (
                not isinstance(welcome, dict)
                or welcome.get("type") != protocol.WELCOME
                or not verify_welcome_proof(self._token, hello_nonce, welcome.get("proof", ""))
            ):
                raise RuntimeError(
                    "Owner failed the handshake: token mismatch. Re-copy the install "
                    "prompt from the extension and update the MCP config env."
                )
            # The owner's self-declared version (WelcomeFrame.version).
            # Diagnostic only — log the skew so the log shows a lead: a peer
            # forwards to the owner, so the OWNER's version is what counts.
            owner_version = welcome.get("version")
            if (
                isinstance(owner_version, str)
                and self._version
                and owner_version != self._version
            ):
                logger.info(
                    "version skew: owner %s vs this server %s — the owner's "
                    "version is what counts",
                    owner_version,
                    self._version,
                )
            await self._ws.send(
                json.dumps(
                    {"type": protocol.AUTH, "proof": auth_proof(self._token, welcome["nonce"])}
                )
            )
        except Exception:
            await self.close()
            raise
        logger.info("handshake ok — connected to owner at %s", url)
        self._recv_task = asyncio.create_task(self._recv_loop())

    async def _recv_loop(self) -> None:
        try:
            assert self._ws is not None
            async for raw in self._ws:
                try:
                    frame = json.loads(raw)
                except (TypeError, ValueError):
                    logger.info("dropping non-JSON frame")
                    continue
                if not isinstance(frame, dict):
                    continue
                # `rpc` frames are meaningless to a peer (only the extension
                # answers those); the only business frame here is the result.
                if frame.get("type") == protocol.PEER_RPC_RESULT:
                    fut = self._pending.pop(frame.get("id"), None)
                    if fut is None or fut.done():
                        continue
                    if frame.get("ok") is True:
                        fut.set_result(frame.get("result"))
                    else:
                        fut.set_exception(RuntimeError(str(frame.get("error"))))
        except ConnectionClosed:
            pass
        except Exception:
            logger.exception("peer link error")
        finally:
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(PeerLinkDown("owner connection lost"))
            self._pending.clear()
            if not self._closing and not self._owner_lost_notified:
                self._owner_lost_notified = True
                logger.info("owner connection closed")
                if self._on_owner_lost is not None:
                    self._on_owner_lost()

    async def call(
        self, method: str, params: Any = None, timeout_ms: int = 10_000
    ) -> Any:
        """Forward an RPC to the owner (which runs it against the extension)."""
        ws = self._ws
        if ws is None or self._closing or ws.state.name != "OPEN":
            raise PeerLinkDown("Not connected to the MCP owner process (peer link is down).")
        self._id += 1
        frame_id = f"peer-{self._id}"
        frame = {
            "type": protocol.PEER_RPC,
            "id": frame_id,
            "method": method,
            "params": params,
        }
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[frame_id] = fut
        # One shared deadline for the send and the reply wait.
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_ms / 1000
        try:
            await asyncio.wait_for(ws.send(json.dumps(frame)), timeout=deadline - loop.time())
            return await asyncio.wait_for(fut, timeout=deadline - loop.time())
        except asyncio.TimeoutError:
            raise TimeoutError(
                f'peer RPC "{method}" timed out after {timeout_ms}ms'
            ) from None
        finally:
            self._pending.pop(frame_id, None)

    def is_connected(self) -> bool:
        ws = self._ws
        return ws is not None and not self._closing and ws.state.name == "OPEN"

    async def close(self) -> None:
        self._closing = True
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(PeerLinkDown("peer client closing"))
        self._pending.clear()
        if self._recv_task is not None:
            self._recv_task.cancel()
            try:
                await self._recv_task
            except (asyncio.CancelledError, Exception):
                pass
            self._recv_task = None
        if self._ws is not None:
            await self._ws.close()
            self._ws = None
