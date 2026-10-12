"""Peer client + single-instance election tests.

Exercises the Runtime election against real sockets: owner binds the bridge,
the loser becomes a peer and forwards calls through it, and the peer takes
over when the owner exits.
"""

import asyncio
import json

import pytest
import websockets
from websockets.asyncio.client import connect

from manta_action_kit_mcp.auth import auth_proof
from manta_action_kit_mcp.bridge import Bridge
from manta_action_kit_mcp.peer_client import PeerClient, PeerLinkDown
from manta_action_kit_mcp.runtime import Runtime

TOKEN = "peer-test-token"
VERSION = "0.0.0-test"


async def start_bridge(token=TOKEN):
    bridge = Bridge(0, token)
    await bridge.start()
    return bridge


async def dial_extension(port, answer=True):
    """Connect a fake extension that completes the handshake and, if
    `answer`, replies to the FIRST rpc frame with a canned result. Any other
    inbound frames (e.g. the owner relaying a peer's call) land on the
    returned queue so tests can observe them without racing the reader task."""
    ws = await connect(f"ws://127.0.0.1:{port}")
    frames: asyncio.Queue[dict] = asyncio.Queue()
    ready = asyncio.Event()

    async def run():
        await ws.send(
            json.dumps(
                {"type": "hello", "role": "extension", "version": "0", "nonce": "fixed-nonce"}
            )
        )
        welcome = json.loads(await asyncio.wait_for(ws.recv(), 5))
        await ws.send(json.dumps({"type": "auth", "proof": auth_proof(TOKEN, welcome["nonce"])}))
        # Sync on pong: the server processes frames in order, so a pong proves
        # the authed stage (and `active = conn`) was applied.
        await ws.send(json.dumps({"type": "ping"}))
        pong = json.loads(await asyncio.wait_for(ws.recv(), 5))
        assert pong == {"type": "pong"}
        ready.set()
        if answer:
            req = json.loads(await asyncio.wait_for(ws.recv(), 5))
            await ws.send(
                json.dumps(
                    {
                        "type": "rpc-result",
                        "id": req["id"],
                        "ok": True,
                        "result": {"recordings": [{"id": "r1"}]},
                    }
                )
            )
        try:
            async for raw in ws:
                frames.put_nowait(json.loads(raw))
        except websockets.ConnectionClosed:
            pass

    task = asyncio.create_task(run())
    await asyncio.wait_for(ready.wait(), 5)
    return ws, task, frames


async def test_peer_forwards_calls_through_owner_bridge():
    bridge = await start_bridge()
    try:
        ws, ext_task, _frames = await dial_extension(bridge.port())
        peer = PeerClient(bridge.port(), TOKEN, version=VERSION)
        try:
            await peer.start()
            assert peer.is_connected()

            # The tool layer uses the same signature as Bridge.call().
            res = await peer.call("list_recordings", None, 5000)
            assert res == {"recordings": [{"id": "r1"}]}

            with pytest.raises(TimeoutError, match="timed out after 50ms"):
                await peer.call("get_recording", {"id": "x"}, 50)
        finally:
            await peer.close()
            await ws.close()
            await asyncio.wait_for(ext_task, 5)
    finally:
        await bridge.close()


async def test_peer_rejects_wrong_token_owner():
    bridge = await start_bridge()
    try:
        peer = PeerClient(bridge.port(), "WRONG-TOKEN", version=VERSION)
        with pytest.raises(RuntimeError, match="token mismatch"):
            await peer.start()
        assert not peer.is_connected()
    finally:
        await bridge.close()


async def test_owner_lost_fails_pending_calls_and_fires_callback():
    """A peer call in flight when the owner dies must fail fast, not hang —
    and the runtime gets the owner-lost callback."""
    bridge = await start_bridge()
    try:
        ws, ext_task, frames = await dial_extension(bridge.port(), answer=False)
        lost = asyncio.Event()
        peer = PeerClient(bridge.port(), TOKEN, version=VERSION, on_owner_lost=lost.set)
        try:
            await peer.start()

            call_task = asyncio.create_task(peer.call("list_recordings", None, 30_000))
            req = await asyncio.wait_for(frames.get(), 5)
            assert req["type"] == "rpc"  # owner relayed the peer's call to the extension

            await bridge.close()  # owner exits mid-call
            # Fail-fast either way: the owner's relay dies with the bridge
            # ("bridge closing") or the peer link drops (PeerLinkDown).
            with pytest.raises((PeerLinkDown, RuntimeError)):
                await asyncio.wait_for(call_task, 5)
            await asyncio.wait_for(lost.wait(), 5)
            assert not peer.is_connected()
        finally:
            await peer.close()
            await ws.close()
            ext_task.cancel()
            await asyncio.gather(ext_task, return_exceptions=True)
    finally:
        await bridge.close()


async def test_election_owner_then_peer_takeover():
    """The full single-instance lifecycle: owner binds, loser becomes a peer,
    owner exits, peer re-elects itself into ownership."""
    rt_owner = Runtime(0, TOKEN, VERSION)
    await rt_owner.elect()
    assert rt_owner.role == "owner"
    assert rt_owner.bridge is not None
    port = rt_owner.bridge.port()

    rt_peer = Runtime(port, TOKEN, VERSION)
    await rt_peer.elect()
    assert rt_peer.role == "peer"
    assert rt_peer.peer is not None

    # The peer routes calls through the owner's bridge to the extension.
    ws, ext_task, _frames = await dial_extension(port)
    try:
        res = await asyncio.wait_for(rt_peer.call("list_recordings", None, 5000), 5)
        assert res == {"recordings": [{"id": "r1"}]}

        # Owner exits → the peer re-elects and becomes the new owner.
        await rt_owner.close()
        for _ in range(100):
            if rt_peer.role == "owner":
                break
            await asyncio.sleep(0.05)
        assert rt_peer.role == "owner"
        assert rt_peer.bridge is not None
        assert rt_peer.bridge.port() == port  # rebound the same bridge port
        assert not rt_peer.extension_connected()  # extension has not re-dialed yet
    finally:
        await ws.close()
        ext_task.cancel()
        await asyncio.gather(ext_task, return_exceptions=True)
        await rt_owner.close()
        await rt_peer.close()


async def test_election_without_token_becomes_rejecting_owner():
    """No token → the bridge still binds (matching the Node server) but every
    client is rejected, so the runtime reports a connected-less owner."""
    rt = Runtime(0, None, VERSION)
    await rt.elect()
    assert rt.role == "owner"
    assert not rt.extension_connected()
    with pytest.raises(Exception, match="no MANTA_TOKEN configured"):
        await rt.call("list_recordings", None, 1000)
