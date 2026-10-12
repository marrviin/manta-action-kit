"""Parity checks against the Node server beyond the tool surface.

Cheap guards for the things that silently drift when one side changes:
the published version (the two servers ship in lockstep), the protocol's
default ports, and the RPC method set implied by the Node tool contract.
"""

import json
from pathlib import Path

import pytest

from manta_action_kit_mcp import __version__
from manta_action_kit_mcp import protocol

REPO = Path(__file__).parents[2]
NODE_PACKAGE_JSON = REPO / "mcp" / "package.json"
PROTOCOL_SRC = REPO / "protocol" / "src" / "index.ts"
FIXTURE = Path(__file__).parent / "fixtures" / "tool-contract.json"

pytestmark = [
    pytest.mark.skipif(
        not NODE_PACKAGE_JSON.exists(),
        reason="packages/mcp/package.json not found (running outside the monorepo?)",
    ),
    pytest.mark.skipif(
        not FIXTURE.exists(),
        reason="tool-contract.json missing — run: pnpm --filter @manta-action-kit/mcp contract:export",
    ),
]


async def test_version_matches_node_server():
    node_version = json.loads(NODE_PACKAGE_JSON.read_text())["version"]
    assert __version__() == node_version, (
        f"pyproject.toml version ({__version__()}) drifted from "
        f"packages/mcp/package.json ({node_version}) — the two servers ship in "
        f"lockstep; bump both (uv.toml/pyproject + package.json)."
    )


async def test_default_ports_match_protocol_package():
    """Import the REAL protocol package (pure types + constants) with node's
    native TS stripping and compare the Python mirror."""
    if not PROTOCOL_SRC.exists():
        pytest.skip("packages/protocol/src/index.ts not found")
    script = (
        "const { pathToFileURL } = require('node:url');"
        "import(pathToFileURL(process.argv[1]).href).then("
        "p => console.log(JSON.stringify({mcp: p.DEFAULT_MCP_PORT, proxy: p.DEFAULT_PROXY_PORT})));"
    )
    import subprocess

    proc = await asyncio_create_subprocess_json(script)
    assert proc == {"mcp": protocol.DEFAULT_MCP_PORT, "proxy": protocol.DEFAULT_PROXY_PORT}, (
        "default ports drifted from packages/protocol/src/index.ts — sync "
        "src/manta_action_kit_mcp/protocol.py"
    )


async def asyncio_create_subprocess_json(script: str) -> dict:
    import asyncio

    proc = await asyncio.create_subprocess_exec(
        "node",
        "-e",
        script,
        str(PROTOCOL_SRC.resolve()),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    assert proc.returncode == 0, f"node failed: {stderr.decode()}"
    return json.loads(stdout.decode().strip().splitlines()[-1])


async def test_rpc_methods_cover_the_node_tool_contract():
    """Every agent-facing tool in the Node contract maps to an RPC method we
    know how to forward; health/rebind_proxy are process-side ops, and
    proxy_rule/set_proxy_port are internal methods with no MCP tool."""
    contract = {t["name"] for t in json.loads(FIXTURE.read_text())}
    expected = (contract - {"health", "rebind_proxy"}) | {"proxy_rule", "set_proxy_port"}
    assert protocol.RPC_METHODS == expected, (
        "RPC method set drifted — sync src/manta_action_kit_mcp/protocol.py "
        "with packages/protocol/src/index.ts"
    )
