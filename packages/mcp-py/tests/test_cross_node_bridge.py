"""Cross-implementation handshake conformance — Python ⇄ real Node code.

Direction 1 (the important one): a Python client dials the REAL Node bridge
(packages/mcp/dist/bridge.js, built from packages/mcp/src/bridge.ts) — our
auth proofs must satisfy the TS server and vice versa. Skipped unless the
Node package is built: run `pnpm --filter @manta-action-kit/mcp build` first.

Direction 2: an independent node client (tests/helpers/node_client.mjs,
mirroring packages/extension/lib/mcp/auth.ts) dials the Python bridge — the
Python server must accept a client the extension would produce.
"""

import asyncio
import json
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from websockets.asyncio.client import connect

from manta_action_kit_mcp.auth import auth_proof, new_nonce, verify_welcome_proof
from manta_action_kit_mcp.bridge import Bridge
from manta_action_kit_mcp.peer_client import PeerClient
from manta_action_kit_mcp.protocol import DEFAULT_MCP_PORT

HELPERS = Path(__file__).parent / "helpers"
NODE_DIST_BRIDGE = Path(__file__).parents[2] / "mcp" / "dist" / "bridge.js"
TOKEN = "cross-test-token"


def _kill(proc: subprocess.Popen) -> None:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.mark.skipif(
    not NODE_DIST_BRIDGE.exists(),
    reason="packages/mcp/dist/bridge.js not built — run: pnpm --filter @manta-action-kit/mcp build",
)
async def test_python_client_completes_handshake_with_real_node_bridge():
    proc = subprocess.Popen(
        ["node", str(HELPERS / "node_bridge.mjs"), "0", TOKEN],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    try:
        info = json.loads(proc.stdout.readline())
        assert info["ready"]
        async with connect(f"ws://127.0.0.1:{info['port']}") as ws:
            nonce = new_nonce()
            await ws.send(
                json.dumps(
                    {"type": "hello", "role": "extension", "version": "0.0.0", "nonce": nonce}
                )
            )
            welcome = json.loads(await asyncio.wait_for(ws.recv(), 5))
            assert welcome["type"] == "welcome"
            # Their proof, verified by our code.
            assert verify_welcome_proof(TOKEN, nonce, welcome["proof"])
            # Our proof, accepted by their server (a mismatch closes the socket).
            await ws.send(
                json.dumps({"type": "auth", "proof": auth_proof(TOKEN, welcome["nonce"])})
            )
            await ws.send(json.dumps({"type": "ping"}))
            pong = json.loads(await asyncio.wait_for(ws.recv(), 5))
            assert pong == {"type": "pong"}
    finally:
        _kill(proc)


@pytest.mark.skipif(
    not NODE_DIST_BRIDGE.exists(),
    reason="packages/mcp/dist/bridge.js not built — run: pnpm --filter @manta-action-kit/mcp build",
)
async def test_python_peer_completes_handshake_with_real_node_bridge():
    """A Python process that loses the port race dials the (possibly Node)
    owner as a peer — our peer handshake must satisfy the real TS server."""
    proc = subprocess.Popen(
        ["node", str(HELPERS / "node_bridge.mjs"), "0", TOKEN],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    try:
        info = json.loads(proc.stdout.readline())
        assert info["ready"]
        peer = PeerClient(info["port"], TOKEN, version="0.0.0-py-test")
        try:
            await peer.start()
            assert peer.is_connected()
        finally:
            await peer.close()
    finally:
        _kill(proc)


async def test_node_client_completes_handshake_with_python_bridge():
    bridge = Bridge(0, TOKEN)
    await bridge.start()
    try:
        # Async subprocess — a blocking run() would freeze the event loop the
        # bridge handler lives on and the node client would time out.
        proc = await asyncio.create_subprocess_exec(
            "node",
            str(HELPERS / "node_client.mjs"),
            f"ws://127.0.0.1:{bridge.port()}",
            TOKEN,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), 15)
        except TimeoutError:
            proc.kill()
            raise AssertionError("node client timed out")
        assert proc.returncode == 0, f"node client failed: {stderr.decode()}"
        assert stdout.decode().strip().endswith("OK")
    finally:
        await bridge.close()
