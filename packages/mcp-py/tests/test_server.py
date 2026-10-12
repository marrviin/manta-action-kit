"""MCP tool-layer tests — drives build_server() through a real MCP client
session over in-memory streams, with a fake runtime answering the RPCs.

Pins the agent-facing surface: tool inventory, per-tool param → RPC mapping
(camelCase wire payloads, {req:...} gateway envelopes), per-call timeouts,
JSON/image content shapes, and the not-found error path.
"""

import asyncio
import base64
import json
from contextlib import asynccontextmanager

import pytest
from mcp.client.session import ClientSession
from mcp.shared.memory import create_client_server_memory_streams

from manta_action_kit_mcp.server import build_server

EXPECTED_TOOLS = {
    "health",
    # recordings
    "list_recordings",
    "get_recording",
    "set_recording_description",
    "get_flow",
    "get_endpoints",
    "get_call",
    # element captures
    "list_element_captures",
    "get_element_capture",
    "diff_element_captures",
    # gateway
    "proxy_fetch",
    "proxy_sse",
    "list_proxy_rules",
    "add_proxy_rule",
    "update_proxy_rule",
    # actions
    "list_actions",
    "get_action",
    "search_actions",
    "create_action",
    "update_action",
    "delete_action",
    "execute_action",
    # capture
    "capture_screenshot",
    "capture_element",
    "start_gif_recording",
    "stop_gif_recording",
    "pause_gif_recording",
    "resume_gif_recording",
    "get_gif_recording_status",
    "list_gif_history",
}


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


async def test_tool_inventory():
    fake = FakeRuntime({})
    async with drive(fake) as session:
        tools = await session.list_tools()
        assert {t.name for t in tools.tools} == EXPECTED_TOOLS


async def test_health_reports_runtime_state():
    fake = FakeRuntime({}, role="peer")
    async with drive(fake) as session:
        res = await session.call_tool("health", {})
        assert not res.is_error
        assert json.loads(res.content[0].text) == {
            "role": "peer",
            "wsPort": 8787,
            "proxyPort": None,
            "proxyListening": False,
            "extensionConnected": True,
        }


async def test_recordings_params_map_to_rpc():
    fake = FakeRuntime(
        {
            "list_recordings": {"recordings": [{"id": "r1", "name": "flow"}]},
            "get_recording": {"recording": {"id": "r1"}, "calls": []},
            "set_recording_description": {"recording": {"id": "r1", "description": "d"}},
            "get_flow": {"flow": {"recordingId": "r1", "steps": [], "deps": []}},
            "get_endpoints": {"endpoints": []},
            "get_call": {"call": {"id": "c1"}},
        }
    )
    async with drive(fake) as session:
        res = await session.call_tool("list_recordings", {})
        assert json.loads(res.content[0].text) == [{"id": "r1", "name": "flow"}]

        await session.call_tool("get_recording", {"id": "r1"})
        await session.call_tool(
            "set_recording_description", {"id": "r1", "description": "d"}
        )
        await session.call_tool("get_flow", {"id": "r1"})
        await session.call_tool("get_endpoints", {"id": "r1"})
        await session.call_tool("get_call", {"callId": "c1"})

        assert [c[0] for c in fake.calls] == [
            "list_recordings",
            "get_recording",
            "set_recording_description",
            "get_flow",
            "get_endpoints",
            "get_call",
        ]
        assert fake.calls[1][1] == {"id": "r1"}
        assert fake.calls[2][1] == {"id": "r1", "description": "d"}
        assert fake.calls[5][1] == {"callId": "c1"}


async def test_element_capture_tools():
    fake = FakeRuntime(
        {
            "list_element_captures": {"captures": [{"id": "e1"}]},
            "get_element_capture": {"capture": {"type": "inspector-capture"}},
            "diff_element_captures": {"report": "- text: a → b", "identical": False},
        }
    )
    async with drive(fake) as session:
        res = await session.call_tool("list_element_captures", {})
        assert json.loads(res.content[0].text) == [{"id": "e1"}]

        await session.call_tool("get_element_capture", {"id": "e1"})
        assert fake.calls[1][1] == {"id": "e1"}

        res = await session.call_tool("diff_element_captures", {"a": "e1", "b": "e2"})
        texts = [c.text for c in res.content]
        assert texts == ["- text: a → b", "identical: False"]
        assert fake.calls[2][1] == {"a": "e1", "b": "e2"}


async def test_gateway_envelope_and_timeout():
    fake = FakeRuntime(
        {
            "proxy_fetch": {"status": 200, "injectedCookieCount": 2},
            "proxy_sse": {"events": [], "endReason": "complete", "eventCount": 0},
        }
    )
    async with drive(fake) as session:
        res = await session.call_tool(
            "proxy_fetch",
            {
                "method": "POST",
                "url": "https://api.example.com/orders",
                "headers": {"X-Trace": "t"},
                "body": '{"a":1}',
            },
        )
        assert json.loads(res.content[0].text)["status"] == 200
        # The agent's request is wrapped in the {req: ...} envelope; no
        # credential fields are added.
        assert fake.calls[0][1] == {
            "req": {
                "method": "POST",
                "url": "https://api.example.com/orders",
                "headers": {"X-Trace": "t"},
                "body": '{"a":1}',
            }
        }
        assert fake.calls[0][2] == 130_000

        await session.call_tool(
            "proxy_sse",
            {"method": "GET", "url": "https://s.example.com/stream", "stopOnData": "[DONE]"},
        )
        assert fake.calls[1][1] == {
            "req": {
                "method": "GET",
                "url": "https://s.example.com/stream",
                "headers": None,
                "body": None,
                "stopOnEventName": None,
                "stopOnData": "[DONE]",
            }
        }
        assert fake.calls[1][2] == 130_000


async def test_proxy_rules_tools_forward_and_require_interaction():
    fake = FakeRuntime(
        {
            "list_proxy_rules": {"rules": [{"id": "pr1", "sandboxPrefix": "/api"}]},
            "add_proxy_rule": {"rule": {"id": "pr2"}},
            "update_proxy_rule": {"rule": {"id": "pr1", "targetBase": "https://n"}},
        }
    )
    async with drive(fake) as session:
        res = await session.call_tool("list_proxy_rules", {})
        assert json.loads(res.content[0].text) == [{"id": "pr1", "sandboxPrefix": "/api"}]
        assert fake.calls[0] == ("list_proxy_rules", None, 10_000)

        await session.call_tool(
            "add_proxy_rule", {"sandboxPrefix": "/x", "targetBase": "https://t"}
        )
        assert fake.calls[1][1] == {"sandboxPrefix": "/x", "targetBase": "https://t"}

        await session.call_tool(
            "update_proxy_rule", {"id": "pr1", "targetBase": "https://n"}
        )
        # Only the provided fields land in the patch (omitted = unchanged).
        assert fake.calls[2][1] == {"id": "pr1", "patch": {"targetBase": "https://n"}}

        tools = {t.name: t for t in (await session.list_tools()).tools}
        # Rule creation is user-gated (same flag as the Node server); updating
        # and listing are not.
        assert tools["add_proxy_rule"].meta == {"anthropic/requiresUserInteraction": True}
        assert not tools["update_proxy_rule"].meta


async def test_action_crud_writes_camelcase_wire_payloads():
    fake = FakeRuntime(
        {
            "create_action": {"action": {"id": "a1"}},
            "update_action": {"action": {"id": "a1", "name": "renamed"}},
            "delete_action": {"deleted": True},
            "list_actions": {"actions": []},
            "get_action": {"action": {"id": "a1"}},
            "search_actions": {"actions": []},
            "execute_action": {"run": {"actionId": "a1", "endReason": "complete", "steps": []}},
        }
    )
    async with drive(fake) as session:
        await session.call_tool(
            "create_action",
            {
                "name": "login",
                "description": "does the thing",
                "recordingId": "r1",
                "params": [
                    {"name": "user", "type": "string", "required": True},
                    {"name": "n", "type": "number", "required": False, "default": "1"},
                ],
                "steps": [
                    {
                        "callId": "c1",
                        "kind": "fetch",
                        "overrides": [
                            {
                                "toLocation": "body",
                                "toPath": "data[0].id",
                                "value": "{{user}}",
                            }
                        ],
                        "waitMs": 100,
                        "outputs": {"token": "data.token"},
                    }
                ],
            },
        )
        created = fake.calls[0][1]
        # camelCase on the wire, exactly what the extension's RpcMap expects.
        assert created["steps"][0]["callId"] == "c1"
        assert created["steps"][0]["overrides"][0] == {
            "toLocation": "body",
            "toPath": "data[0].id",
            "value": "{{user}}",
        }
        assert created["steps"][0]["waitMs"] == 100
        assert created["params"][1] == {
            "name": "n",
            "type": "number",
            "required": False,
            "default": "1",
        }

        await session.call_tool(
            "update_action",
            {
                "id": "a1",
                "patch": {
                    "name": "renamed",
                    "steps": [{"callId": "c2", "kind": "sse"}],
                },
            },
        )
        assert fake.calls[1][1] == {
            "id": "a1",
            "patch": {"name": "renamed", "steps": [{"callId": "c2", "kind": "sse"}]},
        }

        await session.call_tool("delete_action", {"id": "a1"})
        assert fake.calls[2][1] == {"id": "a1"}

        await session.call_tool("search_actions", {"query": "login", "recordingId": "r9"})
        assert fake.calls[3][1] == {"query": "login", "recordingId": "r9"}

        res = await session.call_tool("execute_action", {"id": "a1", "params": {"q": 1}})
        assert json.loads(res.content[0].text)["actionId"] == "a1"
        # Multi-step replay gets the generous budget, not the 10s default.
        assert fake.calls[4][2] == 130_000


async def test_capture_tools_mapping_and_timeouts():
    png = base64.b64encode(b"\x89PNG-fake").decode()
    fake = FakeRuntime(
        {
            "capture_screenshot": {
                "historyId": "h1",
                "filename": "shot.png",
                "createdAt": 1,
                "imageBase64": png,
                "mimeType": "image/png",
                "originalBytes": 10,
                "agentBytes": 10,
                "downscaled": False,
                "fullPageStitched": False,
            },
            "capture_element": {
                "captureId": "cap1",
                "page": {"url": "https://x"},
                "capturedAt": "now",
                "elementCount": 1,
                "elements": [],
            },
            "start_gif_recording": {"ok": True, "tabId": 7, "startedAt": 1},
            "stop_gif_recording": {"ok": True, "draftId": "d1"},
            "pause_gif_recording": {"ok": True},
            "resume_gif_recording": {"ok": True},
            "get_gif_recording_status": {"recording": None},
            "list_gif_history": {"drafts": []},
        }
    )
    async with drive(fake) as session:
        res = await session.call_tool("capture_screenshot", {"mode": "visible"})
        # Meta as JSON text + the image itself as an image content block.
        assert res.content[0].type == "text"
        assert "imageBase64" not in res.content[0].text
        img = res.content[1]
        assert img.type == "image"
        assert img.data == png
        assert img.mime_type == "image/png"
        assert fake.calls[0][2] == 130_000

        await session.call_tool(
            "capture_element",
            {
                "point": {"x": 10.5, "y": 20},
                "maxElements": 5,
                "coordinates": "page",
            },
        )
        assert fake.calls[1][1] == {
            "selector": None,
            "point": {"x": 10.5, "y": 20},
            "box": None,
            "all": None,
            "maxElements": 5,
            "coordinates": "page",
        }
        # Worst-case iframe relay chain budget.
        assert fake.calls[1][2] == 45_000

        await session.call_tool("start_gif_recording", {"tabId": 7})
        assert fake.calls[2][1] == {"tabId": 7}
        assert fake.calls[2][2] == 130_000

        for i, name in enumerate(
            [
                "stop_gif_recording",
                "pause_gif_recording",
                "resume_gif_recording",
                "get_gif_recording_status",
                "list_gif_history",
            ],
            start=3,
        ):
            await session.call_tool(name, {})
            assert fake.calls[i][1] is None


async def test_not_found_is_a_tool_error():
    fake = FakeRuntime({"get_recording": {"recording": None}})
    async with drive(fake) as session:
        res = await session.call_tool("get_recording", {"id": "nope"})
        assert res.is_error
        assert 'No recording found with id "nope".' in res.content[0].text


async def test_bridge_failure_surfaces_as_tool_error():
    class DeadRuntime(FakeRuntime):
        async def call(self, method, params=None, timeout_ms=10_000):
            raise RuntimeError("MCP bridge not ready (no owner or peer link).")

    fake = DeadRuntime({})
    async with drive(fake) as session:
        res = await session.call_tool("list_recordings", {})
        assert res.is_error
        assert "no owner or peer link" in res.content[0].text
