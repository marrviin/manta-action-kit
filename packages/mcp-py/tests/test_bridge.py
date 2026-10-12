"""Bridge integration tests — a fake extension client over a real socket.

Drives the full wire contract the way packages/mcp/src/bridge.ts's clients
(the extension service worker and node peer clients) do: hello → welcome
(verify the server's proof) → auth (answer the challenge) → business frames.
"""

import asyncio
import json

import pytest
import websockets
from websockets.asyncio.client import connect

from manta_action_kit_mcp.auth import auth_proof, new_nonce, verify_welcome_proof
from manta_action_kit_mcp.bridge import Bridge, BridgeNotReady

TOKEN = "test-token"


async def handshake(ws, token=TOKEN, role="extension", auth_with=None, sync=True):
    """Run the client side of the handshake on an open socket, then (unless
    `sync=False`) sync with the server via an app-level ping/pong — the server
    has no auth-ack frame, so pong is the only way to know the authed stage was
    processed. `auth_with` overrides the token for the auth proof (mismatches)."""
    nonce = new_nonce()
    await ws.send(
        json.dumps({"type": "hello", "role": role, "version": "0.0.0", "nonce": nonce})
    )
    welcome = json.loads(await asyncio.wait_for(ws.recv(), 5))
    assert welcome["type"] == "welcome"
    # The server must prove it knows the token before we trust it.
    assert verify_welcome_proof(token, nonce, welcome["proof"])
    proof = auth_proof(auth_with if auth_with is not None else token, welcome["nonce"])
    await ws.send(json.dumps({"type": "auth", "proof": proof}))
    if sync:
        await ws.send(json.dumps({"type": "ping"}))
        pong = json.loads(await asyncio.wait_for(ws.recv(), 5))
        assert pong == {"type": "pong"}


async def expect_closed(ws, code=1008):
    """The server should terminate the socket with the given close code."""
    with pytest.raises(websockets.ConnectionClosed) as exc_info:
        while True:
            await asyncio.wait_for(ws.recv(), 5)
    assert exc_info.value.rcvd.code == code


async def start_bridge(token=TOKEN):
    bridge = Bridge(0, token)
    await bridge.start()
    return bridge


async def test_handshake_ping_pong_and_rpc_roundtrip():
    bridge = await start_bridge()
    try:
        async with connect(f"ws://127.0.0.1:{bridge.port()}") as ws:
            await handshake(ws)
            # App-level keepalive (browsers can't send WS control pings).
            await ws.send(json.dumps({"type": "ping"}))
            pong = json.loads(await asyncio.wait_for(ws.recv(), 5))
            assert pong == {"type": "pong"}
            assert bridge.is_connected()

            # Full rpc round trip: server asks, fake extension answers.
            call_task = asyncio.create_task(bridge.call("list_recordings", None, 5000))
            req = json.loads(await asyncio.wait_for(ws.recv(), 5))
            assert req["type"] == "rpc"
            assert req["method"] == "list_recordings"
            assert req["params"] is None
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
            assert await asyncio.wait_for(call_task, 5) == {"recordings": [{"id": "r1"}]}
    finally:
        await bridge.close()


async def test_rpc_error_result_raises():
    bridge = await start_bridge()
    try:
        async with connect(f"ws://127.0.0.1:{bridge.port()}") as ws:
            await handshake(ws)
            call_task = asyncio.create_task(bridge.call("get_recording", {"id": "x"}, 5000))
            req = json.loads(await asyncio.wait_for(ws.recv(), 5))
            await ws.send(
                json.dumps(
                    {
                        "type": "rpc-result",
                        "id": req["id"],
                        "ok": False,
                        "error": "boom",
                    }
                )
            )
            with pytest.raises(RuntimeError, match="boom"):
                await asyncio.wait_for(call_task, 5)
    finally:
        await bridge.close()


async def test_wrong_auth_token_is_rejected():
    bridge = await start_bridge()
    try:
        async with connect(f"ws://127.0.0.1:{bridge.port()}") as ws:
            await handshake(ws, auth_with="WRONG-TOKEN", sync=False)
            await expect_closed(ws, 1008)
        await asyncio.sleep(0.1)
        assert not bridge.is_connected()
    finally:
        await bridge.close()


async def test_no_token_rejects_every_client():
    bridge = await start_bridge(token=None)
    try:
        async with connect(f"ws://127.0.0.1:{bridge.port()}") as ws:
            nonce = new_nonce()
            await ws.send(
                json.dumps({"type": "hello", "role": "extension", "version": "0", "nonce": nonce})
            )
            await expect_closed(ws, 1008)
    finally:
        await bridge.close()


async def test_web_origin_is_rejected():
    bridge = await start_bridge()
    try:
        async with connect(
            f"ws://127.0.0.1:{bridge.port()}", origin="https://evil.example"
        ) as ws:
            await expect_closed(ws, 1008)
    finally:
        await bridge.close()


async def test_extension_origin_is_accepted():
    bridge = await start_bridge()
    try:
        async with connect(
            f"ws://127.0.0.1:{bridge.port()}",
            origin="chrome-extension://abcdefghijklmnop",
        ) as ws:
            await handshake(ws)
            await ws.send(json.dumps({"type": "ping"}))
            pong = json.loads(await asyncio.wait_for(ws.recv(), 5))
            assert pong == {"type": "pong"}
    finally:
        await bridge.close()


async def test_unexpected_preauth_frame_is_rejected():
    bridge = await start_bridge()
    try:
        async with connect(f"ws://127.0.0.1:{bridge.port()}") as ws:
            # A business frame before hello: not playing our protocol — drop it.
            await ws.send(json.dumps({"type": "rpc-result", "id": "rpc-1", "ok": True, "result": {}}))
            await expect_closed(ws, 1008)
    finally:
        await bridge.close()


async def test_disconnected_extension_fails_in_flight_calls():
    bridge = await start_bridge()
    try:
        ws = await connect(f"ws://127.0.0.1:{bridge.port()}")
        await handshake(ws)
        await ws.send(json.dumps({"type": "ping"}))
        await asyncio.wait_for(ws.recv(), 5)  # pong — handshake settled server-side

        call_task = asyncio.create_task(bridge.call("list_recordings", None, 30_000))
        # Let the server actually send the rpc frame before dropping the socket.
        req = json.loads(await asyncio.wait_for(ws.recv(), 5))
        assert req["type"] == "rpc"
        await ws.close()
        with pytest.raises(BridgeNotReady, match="disconnected"):
            await asyncio.wait_for(call_task, 5)

        # And calls with no extension connected fail fast with the fix-it hint.
        with pytest.raises(BridgeNotReady, match="No authenticated Chrome extension"):
            await bridge.call("list_recordings", None, 1000)
    finally:
        await bridge.close()


async def test_rpc_timeout():
    bridge = await start_bridge()
    try:
        async with connect(f"ws://127.0.0.1:{bridge.port()}") as ws:
            await handshake(ws)
            await ws.send(json.dumps({"type": "ping"}))
            await asyncio.wait_for(ws.recv(), 5)
            with pytest.raises(TimeoutError, match='timed out after 50ms'):
                await bridge.call("list_recordings", None, 50)
    finally:
        await bridge.close()


async def test_peer_can_forward_rpc_through_owner_bridge():
    """A peer process (role=peer) delegates calls via peer-rpc; the owner runs
    them against the extension and ships the result back."""
    bridge = await start_bridge()
    try:
        async with connect(f"ws://127.0.0.1:{bridge.port()}") as extension:
            await handshake(extension, role="extension")
            async with connect(f"ws://127.0.0.1:{bridge.port()}") as peer:
                await handshake(peer, role="peer")
                await peer.send(
                    json.dumps(
                        {"type": "peer-rpc", "id": "peer-1", "method": "list_actions", "params": None}
                    )
                )
                # The owner relays to the extension as a plain rpc frame...
                req = json.loads(await asyncio.wait_for(extension.recv(), 5))
                assert req["type"] == "rpc"
                assert req["method"] == "list_actions"
                await extension.send(
                    json.dumps(
                        {
                            "type": "rpc-result",
                            "id": req["id"],
                            "ok": True,
                            "result": {"actions": []},
                        }
                    )
                )
                # ...and ships the result back to the peer.
                reply = json.loads(await asyncio.wait_for(peer.recv(), 5))
                assert reply == {
                    "type": "peer-rpc-result",
                    "id": "peer-1",
                    "ok": True,
                    "result": {"actions": []},
                }
    finally:
        await bridge.close()


async def test_second_bind_on_same_port_fails():
    bridge = await start_bridge()
    try:
        other = Bridge(bridge.port(), TOKEN)
        with pytest.raises(OSError):
            await other.start()
    finally:
        await bridge.close()


async def test_ephemeral_port_is_reported():
    bridge = await start_bridge()
    try:
        assert 1024 <= bridge.port() <= 65535
    finally:
        await bridge.close()
