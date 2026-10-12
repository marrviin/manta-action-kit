"""Shared test fixtures: a fake runtime + an in-memory MCP client harness."""

import asyncio
from contextlib import asynccontextmanager

from mcp.client.session import ClientSession
from mcp.shared.memory import create_client_server_memory_streams

from manta_action_kit_mcp.server import build_server


class FakeRuntime:
    """Minimal Runtime stand-in: answers every RPC with a canned result."""

    def __init__(self, results, role="owner"):
        self.results = results
        self.calls = []
        self.role = role

    async def call(self, method, params=None, timeout_ms=10_000):
        self.calls.append((method, params, timeout_ms))
        return self.results[method]

    def health_snapshot(self):
        return {
            "role": self.role,
            "wsPort": 8787,
            "proxyPort": None,
            "proxyListening": False,
            "extensionConnected": True,
        }


@asynccontextmanager
async def drive(fake):
    """Open a real MCP client session against build_server(fake)."""
    server = build_server(fake, "0.0.0-test")
    async with create_client_server_memory_streams() as (client_streams, server_streams):
        run_task = asyncio.create_task(
            server._lowlevel_server.run(
                *server_streams,
                server._lowlevel_server.create_initialization_options(),
            )
        )
        try:
            async with ClientSession(*client_streams) as session:
                await session.initialize()
                yield session
        finally:
            run_task.cancel()
            try:
                await run_task
            except BaseException:
                pass
