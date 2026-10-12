"""MCP tool layer — Python port of packages/mcp/src/index.ts.

Covers the full tool surface except the script-driven HTTP proxy: recordings
(read + description), element captures, screenshots, GIF tab recordings,
actions (CRUD + execute), and the proxy_fetch/proxy_sse gateway entry. Tool
descriptions are kept verbatim from the Node server where possible so agents
get identical guidance from either implementation.

Not implemented here (use the Node server for these):
  - proxy rules + the local HTTP proxy (script-driven gateway entry) and
    rebind_proxy — there is no local proxy process to rebind.
"""

from __future__ import annotations

import base64
import json
import logging
from typing import Any, Literal

from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import CallToolResult, ImageContent, TextContent
from pydantic import BaseModel, ConfigDict, Field

from .runtime import Runtime

logger = logging.getLogger("manta.mcp.server")

#: Per-call RPC budgets, mirroring the Node tool layer.
DEFAULT_TIMEOUT_MS = 10_000
LONG_TIMEOUT_MS = 130_000  # proxy_fetch / proxy_sse / execute_action / capture_screenshot / start_gif_recording
CAPTURE_ELEMENT_TIMEOUT_MS = 45_000  # worst-case iframe relay chain


def _dump(data: Any) -> str:
    """Pretty JSON text content (JSON.stringify-equivalent)."""
    return json.dumps(data, indent=2, ensure_ascii=False)


# ── action input models (camelCase on the wire, like the Node zod schemas) ──


class ActionParamIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str = Field(description="Param name, used in {{name}} templates.")
    description: str | None = Field(default=None, description="What this param means.")
    type: Literal["string", "number", "boolean"] = Field(description="Param type.")
    required: bool = Field(description="Whether execute_action must receive it.")
    default: str | None = Field(default=None, description="Default value used when omitted.")


class ActionOverrideIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    to_location: Literal["url", "query", "body", "header"] = Field(
        alias="toLocation",
        description='Where to write: "url" (toPath empty), "query" (query param name), "header" (header name), or "body" (dotted/bracketed JSON path like "data[0].id").',
    )
    to_path: str = Field(
        alias="toPath",
        description='Target path/name (empty for toLocation "url").',
    )
    value: str = Field(
        description=(
            "Template value: {{param}}, {{steps[N].outputs[X]}}, or a built-in helper "
            "{{nowMs}}/{{nowSec}}/{{uuid}} (param of the same name wins). For body overrides "
            "the replay restores the recorded field's JSON type (numeric → number, boolean → "
            'boolean, array/object → JSON.parse); new paths: value starting with "["/"{" is '
            "parsed as JSON."
        )
    )


class ActionStepIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    call_id: str = Field(alias="callId", description="A call id from this recording.")
    kind: Literal["fetch", "sse"] = Field(description="Replay mode: plain fetch or SSE drain.")
    overrides: list[ActionOverrideIn] | None = Field(
        default=None, description="Templated rewrites applied to the recorded request."
    )
    wait_ms: int | None = Field(
        default=None, ge=0, le=10_000, alias="waitMs", description="Pause before this step (0-10000)."
    )
    outputs: dict[str, str] | None = Field(
        default=None,
        description=(
            "Output name → JSON path into this step's response (parsed as JSON; for SSE "
            "steps each event's data is tried). Later steps reference it via "
            "{{steps[N].outputs[name]}}."
        ),
    )


class ActionPatchIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str | None = Field(default=None, description="New name (non-empty).")
    description: str | None = Field(default=None, description="New description (non-empty).")
    params: list[ActionParamIn] | None = Field(
        default=None, description="Replacement params array (full replacement, not a merge)."
    )
    steps: list[ActionStepIn] | None = Field(
        default=None, description="Replacement steps array (full replacement, not a merge)."
    )


class PointIn(BaseModel):
    x: float = Field(description="Viewport/page X coordinate.")
    y: float = Field(description="Viewport/page Y coordinate.")


class BoxIn(BaseModel):
    x: float = Field(description="Left edge.")
    y: float = Field(description="Top edge.")
    w: float = Field(description="Width.")
    h: float = Field(description="Height.")


def _wire(model: BaseModel) -> dict[str, Any]:
    """Serialize an input model to the extension's wire shape (camelCase,
    omitted optionals — mirrors what the Node zod layer would forward)."""
    return model.model_dump(by_alias=True, exclude_none=True)


def build_server(runtime: Runtime, version: str):
    """Build the MCP server over the elected runtime (owner bridge or peer link)."""

    async def call(method: str, params: Any = None, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> Any:
        # Surface link/RPC failures with their message (mirrors the Node
        # server's errorContent catch-all) — an unexpected exception would
        # otherwise be masked by the generic "Error executing tool" text.
        try:
            return await runtime.call(method, params, timeout_ms)
        except Exception as err:
            raise ToolError(str(err)) from None

    mcp = _new_mcp(version)

    # ── ops ────────────────────────────────────────────────────────────────

    @mcp.tool(
        name="health",
        description=(
            "Report the MCP server's runtime health so an agent can detect and "
            "recover from connection problems. Returns: role (owner hosts the "
            "bridge; peer forwards to the owner process), wsPort (the WebSocket "
            "bridge port), extensionConnected (whether the Chrome extension is "
            "reachable over the bridge), and proxyPort/proxyListening (always "
            "null/false in the Python port — the script-driven HTTP proxy is not "
            "implemented here; use the Node server for proxy rules)."
        ),
    )
    async def health() -> str:
        return _dump(runtime.health_snapshot())

    # ── recordings: read + describe ────────────────────────────────────────

    @mcp.tool(
        name="list_recordings",
        description=(
            "List all API recordings captured by the Manta Action Kit Chrome "
            "extension (metadata only: id, name, origin, createdAt, callCount). "
            "Recordings are SOURCE MATERIAL for actions: analyze a flow (get_flow "
            "/ get_endpoints / get_recording), then distill it into a reusable, "
            "parameterized action via create_action. When the goal is to RUN a "
            "captured flow, execute the action via execute_action — do not replay "
            "a recording's calls one by one via proxy_fetch."
        ),
    )
    async def list_recordings() -> str:
        res = await call("list_recordings", None)
        return _dump(res.get("recordings", res))

    @mcp.tool(
        name="get_recording",
        description=(
            "Get a single recording plus its full API call chain (each call's "
            "request/response, status, timing). Use list_recordings first to find "
            "the id. The result includes the recording's agent-authored "
            "`description` when present; if it is missing, the result carries a "
            "`descriptionHint` nudging you to write one via set_recording_description "
            "so downstream steps understand this recording. Each call may carry a "
            "`relevance` mark (`relevant` / `irrelevant` / `uncertain`, with a "
            "`role` like `telemetry`): `irrelevant` calls are background noise "
            "(analytics, polling, preflights) — skip them when analyzing the flow "
            "or distilling an action; no `relevance` field means the recording has "
            "not been analyzed. Recordings are source material: use what you learn "
            "here to author an action via create_action, and run captured flows "
            "through execute_action instead of replaying calls manually."
        ),
    )
    async def get_recording(id: str) -> str:
        res = await call("get_recording", {"id": id})
        if not res.get("recording"):
            raise ToolError(f'No recording found with id "{id}".')
        return _dump(res)

    @mcp.tool(
        name="set_recording_description",
        description=(
            "Write (or overwrite) a recording's `description`: a business-level, "
            "agent-authored summary of the WHOLE FLOW this recording represents — "
            "what real task it accomplishes, what you can DO with it (inputs it "
            "needs and results it yields), how the steps chain end to end, and "
            "what to watch out for when reusing it (required inputs to change, "
            "stale/time-bound or sensitive data, auth/login assumptions, side "
            "effects). Write for a reader deciding whether and how to reuse this "
            "flow — NOT an endpoint reference. Do NOT restate per-endpoint "
            "request/response field contracts, schemas, or field lists: that "
            "already lives in get_endpoints / get_flow and duplicating it here is "
            "noise. Study the flow first (get_flow for the chain, get_endpoints "
            "for contracts, get_recording for bodies), then distill the intent. "
            "This is the ONLY way to set a description; it is a dedicated write "
            "path that touches nothing else on the recording. Shown read-only at "
            "the top of the recording detail page."
        ),
    )
    async def set_recording_description(id: str, description: str) -> str:
        res = await call("set_recording_description", {"id": id, "description": description})
        if not res.get("recording"):
            raise ToolError(f'No recording found with id "{id}".')
        return _dump(res["recording"])

    @mcp.tool(
        name="get_flow",
        description=(
            "Get a recording's FLOW: its calls as ordered lightweight steps "
            "(seq/method/url/status, no bodies) plus the inferred field "
            "dependencies linking them — i.e. which response value from an earlier "
            "call feeds a later call's request. Deps may carry a `depCheck` mark: "
            "`verdict: 'unlikely'` means the local model considers the edge a "
            "coincidental value match (a colliding timestamp/nonce) rather than a "
            "real data flow — do not build parameterization on it; an absent mark "
            "means not analyzed. Steps may also carry a `relevance` mark "
            "(`relevant` / `irrelevant` / `uncertain` — skip `irrelevant` calls as "
            "background noise) and a `precedingInteraction` mark (the user "
            "interaction, with its text and `deltaMs`, that most likely triggered "
            "the call — direct consequences of user intent vs calls that merely "
            "co-occur). Use this to understand how the calls chain together before "
            "turning the flow into an action (create_action); use get_recording "
            "for full request/response bodies. Running a captured flow goes "
            "through execute_action — do not replay the chain's calls one by one "
            "via proxy_fetch. Find the id via list_recordings."
        ),
    )
    async def get_flow(id: str) -> str:
        res = await call("get_flow", {"id": id})
        if not res.get("flow"):
            raise ToolError(f'No recording found with id "{id}".')
        return _dump(res["flow"])

    @mcp.tool(
        name="get_endpoints",
        description=(
            "Get a recording's distinct ENDPOINTS: its calls collapsed by method + "
            'normalized URL path (numeric ids / uuids become ":id") into one '
            "contract each, with request/response bodies inferred into REDACTED "
            "schemas — field names, types, optional/nullable flags, and one masked "
            "example per scalar, but no real values or credentials. Use this to "
            "learn a site's API surface cleanly, without wading through repetitive "
            "raw calls. Each endpoint may also carry inputsFrom: request fields "
            "whose VALUES come from an upstream endpoint's response (e.g. "
            "body.orderId ← `GET /orders` response `.data[].id`) — so before "
            "calling an endpoint, resolve its inputsFrom by first calling the "
            "upstream endpoint and reading the value from there, instead of "
            "guessing ids/tokens. inputsFrom carries only the source location, "
            "never the literal value. Request fields may also carry a `dynamism` "
            "mark (and query params a `queryDynamism` map): `verdict: 'varies'` "
            "means the value would differ on a replay in a fresh session "
            "(timestamp, session token, auto-generated id) and must become an "
            "action parameter, while `stable` is safe to hardcode; `source: "
            "'stats'` (multi-observation) outranks `'model'` "
            "(single-observation). Use get_recording for concrete bodies, "
            "get_flow for the raw per-call dependency chain. Find the id via "
            "list_recordings. Recordings are source material for actions: author "
            "the endpoint chain as an action (create_action) and run it via "
            "execute_action rather than replaying calls manually."
        ),
    )
    async def get_endpoints(id: str) -> str:
        res = await call("get_endpoints", {"id": id})
        return _dump(res.get("endpoints", res))

    @mcp.tool(
        name="get_call",
        description=(
            "Get one captured API call by its id, including full request and "
            "response bodies/headers. Source material for analysis and for "
            "authoring actions (create_action); running a captured flow goes "
            "through execute_action."
        ),
    )
    async def get_call(callId: str) -> str:
        res = await call("get_call", {"callId": callId})
        if not res.get("call"):
            raise ToolError(f'No call found with id "{callId}".')
        return _dump(res["call"])

    # ── element captures: read ─────────────────────────────────────────────

    @mcp.tool(
        name="list_element_captures",
        description=(
            "List saved element-capture snapshots taken by the Manta Action Kit "
            "Chrome extension's in-page inspector (metadata only: id, url, title, "
            "capturedAt, elementCount). Each snapshot is a structured, LLM-ready "
            "description of a DOM element the user visually picked or boxed on a "
            "page — tag/attrs/text plus computed styles. Use list_element_captures "
            "to find ids, get_element_capture for the full tree, "
            "diff_element_captures to compare two snapshots (e.g. the same "
            "component captured in two contexts)."
        ),
    )
    async def list_element_captures() -> str:
        res = await call("list_element_captures", None)
        return _dump(res.get("captures", res))

    @mcp.tool(
        name="get_element_capture",
        description=(
            "Get one element-capture snapshot in full: the nested element tree "
            "with computed styles, pseudo-element styles and viewport rects — a "
            "faithful description of how the element is built, suitable for "
            "analyzing styles, replicating the component in code, or feeding a "
            "fix suggestion back to the user. Use list_element_captures first to "
            "find the id."
        ),
    )
    async def get_element_capture(id: str) -> str:
        res = await call("get_element_capture", {"id": id})
        if not res.get("capture"):
            raise ToolError(f'No element capture found with id "{id}".')
        return _dump(res)

    @mcp.tool(
        name="diff_element_captures",
        description=(
            "Diff two saved element-capture snapshots and return a preformatted "
            "TEXT report of property-level changes (text/styles/pseudo-elements "
            "per DOM path, A vs B) plus an `identical` flag. Typical use: the "
            "user captured the same component twice — before/after a change, or "
            "in two contexts (standalone vs embedded, page A vs page B) — and "
            "wants to know exactly which styles differ. Nodes are aligned by "
            "document order, so big structural changes between the two captures "
            "can produce noisy output."
        ),
    )
    async def diff_element_captures(a: str, b: str) -> CallToolResult:
        res = await call("diff_element_captures", {"a": a, "b": b})
        return CallToolResult(
            content=[
                TextContent(type="text", text=res["report"]),
                TextContent(type="text", text=f'identical: {res["identical"]}'),
            ]
        )

    # ── gateway: proxy_fetch / proxy_sse ───────────────────────────────────

    @mcp.tool(
        name="proxy_fetch",
        description=(
            "Make an authenticated API call THROUGH the Manta Action Kit extension "
            "(edge gateway). You provide only method/url and optionally "
            "headers/body — DO NOT send any credentials (no Cookie, no "
            "Authorization); the extension injects the user's browser cookies for "
            "the target site at forward time, so you never see them. ⚠️ EVERY call "
            "passes the extension's sandbox gate: the user must approve a "
            "confirmation popup in the browser (unless the target domain is on "
            "the user's allowlist). If the call fails with a user-declined/timeout "
            "error, do NOT retry the same call. Returns the sanitized response "
            "(Set-Cookie stripped; large bodies truncated). The response includes "
            "injectedCookieCount (a COUNT, never names/values): if it is 0 and you "
            "get a 401/403, the user is NOT logged in to that site — tell them to "
            "log in rather than retrying; if it is > 0 and you still get 401/403, "
            "cookies were sent so the endpoint likely needs something else (a "
            "header/token), not a login."
        ),
    )
    async def proxy_fetch(
        method: Literal["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        url: str,
        headers: dict[str, str] | None = None,
        # Plain `str` (not `str | None`) on purpose: the SDK pre-parses string
        # args whose annotation isn't exactly str, so a JSON request body like
        # '{"a":1}' would be coerced into a dict and fail validation. Node's
        # zod optional has the same shape: omitted → None, explicit null → error.
        body: str = None,
    ) -> str:
        req = {"method": method, "url": url, "headers": headers, "body": body}
        # Authorization happens inside the extension (sandbox domain policy +
        # confirmation popup) — forward straight through.
        res = await call("proxy_fetch", {"req": req}, LONG_TIMEOUT_MS)
        return _dump(res)

    @mcp.tool(
        name="proxy_sse",
        description=(
            "Like proxy_fetch, but for a Server-Sent Events (text/event-stream) "
            "endpoint. The extension injects the user's cookies, opens the "
            "stream, and drains it, then returns ALL collected events at once — "
            "this is not a live per-token feed (MCP tool calls are "
            "request/response). Use it for streaming endpoints (e.g. an AI chat "
            "stream). Same authorization rules as proxy_fetch; Accept defaults to "
            "text/event-stream. The gateway makes NO assumption about how a "
            "stream ends: by default it stops at EOF, an 8s idle gap, or a "
            "size/time cap. If you know the stream's terminator (from a recording "
            "via get_recording — SSE responses are captured as an event sequence "
            "there), pass stopOnEventName or stopOnData to stop promptly. Result: "
            "{events:[{event?,id?,data}], endReason, eventCount}. endReason: "
            '"complete"=EOF, "stop-match"=your stop condition matched, "idle"='
            'stream went quiet, "max-events"/"max-bytes"/"timeout"=a cap was hit. '
            "Also includes injectedCookieCount (a COUNT, never names/values): 0 "
            "alongside a 401/403 status means the user is not logged in to that "
            "site — surface that rather than retrying. ⚠️ EVERY call passes the "
            "extension's sandbox gate: the user must approve a confirmation popup "
            "in the browser (unless the target domain is on the user's allowlist)."
        ),
    )
    async def proxy_sse(
        method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"],
        url: str,
        headers: dict[str, str] | None = None,
        # Plain `str` — see proxy_fetch (keeps JSON bodies un-coerced).
        body: str = None,
        stopOnEventName: str | None = None,
        stopOnData: str | None = None,
    ) -> str:
        req = {
            "method": method,
            "url": url,
            "headers": headers,
            "body": body,
            "stopOnEventName": stopOnEventName,
            "stopOnData": stopOnData,
        }
        res = await call("proxy_sse", {"req": req}, LONG_TIMEOUT_MS)
        return _dump(res)

    # ── proxy rules ────────────────────────────────────────────────────────
    # The rules live extension-side, so they are manageable from this server
    # even though the Python port hosts no local HTTP proxy itself (script
    # traffic flows through whichever process hosts the proxy — e.g. the Node
    # server). rebind_proxy is the only tool intentionally absent here.

    @mcp.tool(
        name="list_proxy_rules",
        description=(
            "List the sandbox proxy rules (the script-driven gateway entry). Each "
            "rule maps a local sandbox prefix (http://127.0.0.1:<proxyPort>"
            "<sandboxPrefix>) to a real target base URL; a script points its "
            "baseURL at the sandbox prefix and the extension rewrites + forwards "
            "the request with the user's cookies injected. Returns each rule's "
            "{id, sandboxPrefix, targetBase, enabled, createdBy, createdAt}. Use "
            "this before add_proxy_rule / update_proxy_rule to see existing "
            "prefixes (prefixes must be unique). NOTE: `enabled` is the "
            "user-controlled kill switch — you can read it here but cannot change "
            "it."
        ),
    )
    async def list_proxy_rules() -> str:
        res = await call("list_proxy_rules", None)
        return _dump(res.get("rules", res))

    @mcp.tool(
        name="add_proxy_rule",
        meta={"anthropic/requiresUserInteraction": True},
        description=(
            "Create a sandbox proxy rule so a script can call a target API "
            "through the extension (with the user's cookies injected, never "
            "exposed to you). Provide sandboxPrefix (a local path prefix like "
            '"/api", normalized to a leading "/" and unique across rules) and '
            'targetBase (the real http(s) base URL like "https://api.com/v1"). '
            "After this, requests to http://127.0.0.1:<proxyPort><sandboxPrefix>/"
            "... are rewritten onto targetBase. ⚠️ Creating a rule requires the "
            "user to approve a native confirmation prompt (it shows the prefix "
            "and target — the user should verify them). On approval the rule is "
            "enabled immediately; if the user declines, the call fails and no "
            "rule is created. You still CANNOT set the `enabled` flag yourself — "
            "approving the prompt is what enables the rule. Fails if the prefix "
            "collides or the target is not a valid http(s) URL."
        ),
    )
    async def add_proxy_rule(sandboxPrefix: str, targetBase: str) -> str:
        res = await call("add_proxy_rule", {"sandboxPrefix": sandboxPrefix, "targetBase": targetBase})
        return _dump(res.get("rule", res))

    @mcp.tool(
        name="update_proxy_rule",
        description=(
            "Update an existing proxy rule's CONTENT by id. You may patch either "
            "sandboxPrefix or targetBase — only the fields you pass change. Get "
            "the id from list_proxy_rules. IMPORTANT: you CANNOT enable or "
            "disable a rule — the `enabled` kill switch is reserved for the user "
            "and is not accepted here. Changing sandboxPrefix/targetBase is "
            "re-validated (prefix must stay unique, target must be a valid "
            "http(s) URL). Fails if the id is unknown."
        ),
    )
    async def update_proxy_rule(
        id: str, sandboxPrefix: str | None = None, targetBase: str | None = None
    ) -> str:
        # Build the patch from only the provided fields so omitted ones are
        # left unchanged (same as the Node handler).
        patch: dict[str, str] = {}
        if sandboxPrefix is not None:
            patch["sandboxPrefix"] = sandboxPrefix
        if targetBase is not None:
            patch["targetBase"] = targetBase
        res = await call("update_proxy_rule", {"id": id, "patch": patch})
        return _dump(res.get("rule", res))

    # ── actions: discovery + CRUD + run ────────────────────────────────────

    @mcp.tool(
        name="list_actions",
        description=(
            "List all saved actions — reusable, parameterized API flows the user "
            "(or an agent) distilled from a recording. Each action references "
            "calls by id from its source recording (never embedded credentials) "
            "and declares the runtime params it needs. Returns summaries only (id, "
            "name, description, param name/type/required, stepCount). Call "
            "get_action with the id for the full definition (steps, overrides, "
            "output paths) before executing. Use search_actions to filter by "
            "keyword, execute_action to run one."
        ),
    )
    async def list_actions() -> str:
        res = await call("list_actions", None)
        return _dump(res.get("actions", res))

    @mcp.tool(
        name="get_action",
        description=(
            "Get one saved action's full definition: its params "
            "(name/type/required/default), steps (recorded callId, overrides, "
            "waits, output extraction paths), and metadata. Find the id via "
            "list_actions or search_actions."
        ),
    )
    async def get_action(id: str) -> str:
        res = await call("get_action", {"id": id})
        if not res.get("action"):
            raise ToolError(f'No action found with id "{id}".')
        return _dump(res["action"])

    @mcp.tool(
        name="search_actions",
        description=(
            "Find saved actions whose name or description contains a keyword "
            "(case-insensitive). Pass recordingId to scope the search to actions "
            "built from one recording. This is the discovery entry point when the "
            "user wants to get something done: search, pick an action, get_action "
            "for its full shape (steps, overrides, outputs), then execute_action "
            "with the params it declares. Returns summaries only. A non-empty "
            "query is required — use list_actions to browse everything."
        ),
    )
    async def search_actions(query: str, recordingId: str | None = None) -> str:
        res = await call("search_actions", {"query": query, "recordingId": recordingId})
        return _dump(res.get("actions", res))

    @mcp.tool(
        name="create_action",
        description=(
            "Distill a recorded flow into a saved, replayable ACTION. An action = "
            "params (typed runtime inputs) + steps (the recording’s calls, each "
            "referenced by callId, never embedded credentials). Per step, "
            "`overrides` rewrite the recorded request before replay with TEMPLATE "
            "values only (never recorded literals): toLocation is \"url\" (toPath "
            'must be empty), "query" (toPath = query param name), "header" '
            '(toPath = header name), or "body" (toPath = dotted/bracketed JSON '
            "path like \"data[0].id\"; the body may be JSON, a form carrying an "
            "embedded JSON object like `appid=...&body=%7B...%7D` (paths address "
            "the embedded JSON), or a plain form (single-segment toPath = whole "
            "form field)). Templates are `{{paramName}}`, `{{steps[N].outputs[name]}}`, "
            "or the built-in helpers `{{nowMs}}`/`{{nowSec}}`/`{{uuid}}` for fresh "
            "timestamps and one-shot ids (a declared param of the same name wins) "
            "— the latter reads an output that step N declared. `outputs` (per "
            "step) map output names to JSON paths into that step’s response "
            "(parsed as JSON; for SSE steps each event’s data is tried). "
            "`waitMs` pauses before a step (0-10000). Steps replay strictly in "
            "order through the user’s browser session. Study the recording first "
            "(get_flow, get_endpoints, get_recording), then build the action from "
            "it."
        ),
    )
    async def create_action(
        name: str,
        description: str,
        recordingId: str,
        steps: list[ActionStepIn],
        params: list[ActionParamIn] | None = None,
    ) -> str:
        payload: dict[str, Any] = {
            "name": name,
            "description": description,
            "recordingId": recordingId,
            "params": [_wire(p) for p in (params or [])],
            "steps": [_wire(s) for s in steps],
        }
        res = await call("create_action", payload)
        return _dump(res.get("action", res))

    @mcp.tool(
        name="update_action",
        description=(
            "Patch an action's CONTENT by id: name, description, params, and/or "
            "steps (any subset — only what you pass changes). The id, "
            "recordingId, and timestamps are never patchable, and steps are "
            "re-validated against the source recording (callIds must belong to "
            "it). Get the current definition via get_action first."
        ),
    )
    async def update_action(id: str, patch: ActionPatchIn) -> str:
        res = await call("update_action", {"id": id, "patch": _wire(patch)})
        if not res.get("action"):
            raise ToolError(f'No action found with id "{id}".')
        return _dump(res["action"])

    @mcp.tool(
        name="delete_action",
        meta={"anthropic/requiresUserInteraction": True},
        description=(
            "Delete a saved action by id. Idempotent: deleting an unknown id just "
            "returns {deleted: false}. The source recording is never touched. "
            "⚠️ Requires the user to approve a native confirmation prompt."
        ),
    )
    async def delete_action(id: str) -> str:
        res = await call("delete_action", {"id": id})
        return _dump(res)

    @mcp.tool(
        name="execute_action",
        description=(
            "Run a saved action end to end. Pass the params it declares (required "
            "ones must be present; others fall back to their defaults). Each step "
            "replays through the extension's gateway with the user's cookies "
            "injected — you never see credentials. The run stops at the first "
            "failed step (gateway-refused or transport error); a 4xx/5xx response "
            "still counts as a completed step. Results carry per-step status, a "
            "body/event preview (truncated), and the outputs extracted by declared "
            "paths. This is the entry point for running a recorded flow — the "
            "steps are orchestrated for you (same gateway channel as proxy_fetch, "
            "with dependencies resolved and params templated in); do not "
            "re-implement a recording's call chain by hand via proxy_fetch. "
            "⚠️ The run passes the extension's sandbox gate: the user confirms "
            "each target host via a confirmation popup in the browser (once per "
            "host per run, unless the host is on the user's allowlist); a denied "
            "host aborts the run with a refused step."
        ),
    )
    async def execute_action(
        id: str, params: dict[str, str | int | bool] | None = None
    ) -> str:
        # Multi-step replay can involve several network round-trips plus waits —
        # use the same generous budget as the Node server's execute_action.
        res = await call(
            "execute_action", {"id": id, "params": params}, LONG_TIMEOUT_MS
        )
        return _dump(res.get("run", res))

    # ── capture: screenshot + element + GIF recordings ─────────────────────

    @mcp.tool(
        name="capture_screenshot",
        description=(
            "Screenshot the active tab of the user's Chrome window. mode=visible "
            "captures the current viewport; mode=fullPage scrolls and stitches "
            "the whole page (30s+ on long pages; width is pinned to the "
            "viewport). Returns the image itself (downscaled to a 1568px JPEG "
            "when the raw PNG is large) plus metadata — the full-resolution "
            "original is saved to the extension's screenshot history and can be "
            "reopened by the user from the side panel's capture tab. Runs "
            "silently: no preview tab, no animation, no notification. Caveats: "
            "browser-internal pages (chrome://) are captured via a CDP fallback, "
            "but Chrome-protected targets (Web Store etc.) refuse and report "
            "screenshot:protected-page; if DevTools is attached to the tab the "
            "capture reports screenshot:debugger-conflict — ask the user to close "
            "DevTools; on the CDP fallback path Chrome's 'being debugged' "
            "infobar may appear in the shot and in any tab recording. file:// "
            "tabs fail unless the user enabled 'Allow access to file URLs' for "
            "the extension."
        ),
    )
    async def capture_screenshot(mode: Literal["visible", "fullPage"]) -> CallToolResult:
        # fullPage can scroll-and-stitch for tens of seconds on long pages —
        # same generous budget as execute_action.
        res = await call("capture_screenshot", {"mode": mode}, LONG_TIMEOUT_MS)
        meta = {k: v for k, v in res.items() if k not in ("imageBase64", "mimeType")}
        return CallToolResult(
            content=[
                TextContent(type="text", text=_dump(meta)),
                ImageContent(
                    type="image",
                    data=res["imageBase64"],
                    mime_type=res["mimeType"],
                ),
            ]
        )

    @mcp.tool(
        name="capture_element",
        description=(
            "Serialize a page element from the active tab into a structured "
            "description (tag, attributes, text, computed styles) — no user "
            "interaction needed. Exactly one of: selector (CSS; default = first "
            "match + its visible subtree, click-pick semantics; all=true = every "
            "match as a forest of single elements; if the top frame has no match, "
            "the page's iframes are searched too — write the selector as seen "
            "INSIDE the frame), point ({x,y}, shadow-DOM aware hit test; a hit on "
            "an <iframe> captures the INNER element, not the shell), or box "
            "({x,y,w,h} — all elements intersecting the rectangle; a box covering "
            "only an iframe captures that frame's content). Coordinates: viewport "
            "px by default; for coordinates read off a mode=fullPage screenshot "
            "pass coordinates='page' (out-of-viewport coordinates are "
            "auto-treated as page space, so a fullPage screenshot's coords below "
            "the fold just work). maxElements caps the response (default 100). "
            "The response is a LEAN tree (full per-node style maps stripped to "
            "stay within token budget); for the complete payload with fullStyles "
            "pass the returned captureId to get_element_capture. Fails on pages "
            "that cannot be injected (chrome://, Web Store) or with no matching "
            "element."
        ),
    )
    async def capture_element(
        selector: str | None = None,
        point: PointIn | None = None,
        box: BoxIn | None = None,
        all: bool | None = None,
        maxElements: int | None = None,
        coordinates: Literal["page", "viewport"] | None = None,
    ) -> str:
        params: dict[str, Any] = {
            "selector": selector,
            "point": _wire(point) if point else None,
            "box": _wire(box) if box else None,
            "all": all,
            "maxElements": maxElements,
            "coordinates": coordinates,
        }
        # 45s: must cover the worst-case iframe relay chain (up to 3 nested
        # relays × 12s + the base capture) — 30s cut off captures that were
        # still legitimately progressing.
        res = await call("capture_element", params, CAPTURE_ELEMENT_TIMEOUT_MS)
        return _dump(res)

    @mcp.tool(
        name="start_gif_recording",
        description=(
            "Start recording the active tab (or tabId) for GIF export. ⚠️ HUMAN "
            "IN THE LOOP: a confirmation popup opens in the browser and this call "
            "BLOCKS until the user clicks Allow (up to ~2 minutes) — a "
            "denied/closed/expired popup fails the call. Chrome shows a recording "
            "bar on the tab while capturing. Recordings auto-stop at the "
            "5-minute limit. The WebM draft is saved on stop; afterwards poll "
            "get_gif_recording_status. Note: screenshots (capture_screenshot "
            "fullPage CDP fallback) of a recording tab put the debugger infobar "
            "into the recording. file:// tabs fail stream minting unless the user "
            "enabled 'Allow access to file URLs' — the error surfaces as "
            "start-failed."
        ),
    )
    async def start_gif_recording(tabId: int | None = None) -> str:
        # Blocks on the human confirm window (up to 120s) — generous budget.
        res = await call("start_gif_recording", {"tabId": tabId}, LONG_TIMEOUT_MS)
        return _dump(res)

    @mcp.tool(
        name="stop_gif_recording",
        description=(
            "Stop the running tab recording and finalize the WebM draft. Returns "
            "{ok, draftId?, hitTimeLimit?}; draftId may be briefly absent if the "
            "save has not landed yet — call get_gif_recording_status and read "
            "lastResult.draftId in that case."
        ),
    )
    async def stop_gif_recording() -> str:
        res = await call("stop_gif_recording", None)
        return _dump(res)

    @mcp.tool(
        name="pause_gif_recording",
        description=(
            "Pause the running tab recording (frames are not captured while "
            "paused)."
        ),
    )
    async def pause_gif_recording() -> str:
        res = await call("pause_gif_recording", None)
        return _dump(res)

    @mcp.tool(
        name="resume_gif_recording",
        description="Resume a paused tab recording.",
    )
    async def resume_gif_recording() -> str:
        res = await call("resume_gif_recording", None)
        return _dump(res)

    @mcp.tool(
        name="get_gif_recording_status",
        description=(
            "Report the current tab-recording state ({status: 'recording'|"
            "'paused', startedAt, tabId} or null) plus lastResult — how the "
            "PREVIOUS recording ended ({ok, draftId?, hitTimeLimit?, endedAt}), "
            "useful after a time-limit auto-stop or a stop whose draftId had not "
            "landed yet."
        ),
    )
    async def get_gif_recording_status() -> str:
        res = await call("get_gif_recording_status", None)
        return _dump(res)

    @mcp.tool(
        name="list_gif_history",
        description=(
            "List the recorded WebM drafts (id, filename, createdAt; metadata "
            "only). These are PRE-TRANSCODE drafts: WebM→GIF conversion (and MP4 "
            "export) runs inside the extension's preview tab and cannot be "
            "triggered remotely — tell the user to open the recording from the "
            "side panel's capture tab to transcode/download it."
        ),
    )
    async def list_gif_history() -> str:
        res = await call("list_gif_history", None)
        return _dump(res.get("drafts", res))

    return mcp


def _new_mcp(version: str):
    from mcp.server.mcpserver import MCPServer

    return MCPServer(
        "manta-action-kit-mcp",
        instructions=(
            "Exposes the Manta Action Kit Chrome extension's recorded API calls "
            "to you as tools. Data lives in the extension's IndexedDB; every "
            "tool forwards to the extension over a local WebSocket bridge "
            "(handshake-authenticated). Start with list_recordings to discover "
            "captured flows, distill them into reusable actions via "
            "create_action, and run them with execute_action — do not replay "
            "recordings call-by-call via proxy_fetch."
        ),
    )
