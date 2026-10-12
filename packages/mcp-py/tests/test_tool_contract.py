"""Tool-contract sync between the Node server and this Python port.

The fixture (tests/fixtures/tool-contract.json) is EXPORTED from the real
Node registration path — see packages/mcp/scripts/export-tool-contract.mjs:

    pnpm --filter @manta-action-kit/mcp build
    pnpm --filter @manta-action-kit/mcp contract:export

This test then proves the Python server exposes the same surface: tool names,
byte-identical descriptions, structurally-equal input schemas, and _meta.
When a Node-side tool changes, regenerate the fixture and the diff tells you
exactly what to port — drift fails here instead of in front of a user.

Intentional divergence (allowed in ALLOWED_MISSING): `rebind_proxy` — it
rebinds the local HTTP proxy, which the Python port does not host.
"""

import json
from pathlib import Path

import pytest

from conftest import FakeRuntime, drive

FIXTURE = Path(__file__).parent / "fixtures" / "tool-contract.json"

pytestmark = pytest.mark.skipif(
    not FIXTURE.exists(),
    reason="tool-contract.json missing — run: pnpm --filter @manta-action-kit/mcp contract:export",
)

#: Tools the Node server has that the Python port intentionally does not.
ALLOWED_MISSING = {
    "rebind_proxy": "rebinds the local HTTP proxy — the Python port hosts none",
}

#: Byte-different descriptions that are intentional (runtime differs).
ALLOWED_DESCRIPTION_OVERRIDES = {
    "health": (
        "the Python port hosts no HTTP proxy, so its health report and "
        "description differ on purpose"
    ),
}


def load_contract():
    tools = json.loads(FIXTURE.read_text())
    return {t["name"]: t for t in tools}


async def python_tools():
    """The Python server's tool surface, via a real MCP client session."""
    fake = FakeRuntime({})
    async with drive(fake) as session:
        tools = await session.list_tools()
        return {t.name: t for t in tools.tools}


# ── JSON Schema normalization ───────────────────────────────────────────────
# Zod-to-JSON-Schema (Node) and pydantic (Python) express the same shapes
# differently. Normalize both down to the structural skeleton: types, enums,
# properties, required, items — dropping annotation-only keys (description,
# title, default, min/max, $schema, $defs) and unwrapping pydantic's
# anyOf-[X, null] (zod .optional() instead just omits from `required`).

_KEEP = {"type", "enum", "properties", "required", "items", "anyOf"}


def _collect_defs(schema, defs):
    """Gather every $defs table (pydantic hoists shared models there)."""
    if isinstance(schema, dict):
        defs.update(schema.get("$defs", {}))
        for v in schema.values():
            _collect_defs(v, defs)
    elif isinstance(schema, list):
        for v in schema:
            _collect_defs(v, defs)


def _resolve_refs(schema, defs, seen=()):
    if isinstance(schema, list):
        return [_resolve_refs(x, defs, seen) for x in schema]
    if not isinstance(schema, dict):
        return schema
    if "$ref" in schema:
        name = schema["$ref"].rsplit("/", 1)[-1]
        if name in seen or name not in defs:  # cycle guard
            return {}
        # Keep any sibling keys (e.g. description) alongside the target.
        merged = {**_resolve_refs(defs[name], defs, (*seen, name)), **{k: v for k, v in schema.items() if k != "$ref"}}
        return merged
    return {k: _resolve_refs(v, defs, seen) for k, v in schema.items()}


def _norm(schema):
    defs: dict = {}
    _collect_defs(schema, defs)
    return _norm_inner(_resolve_refs(schema, defs))


def _norm_inner(schema):
    if isinstance(schema, list):
        return sorted(_norm_inner(x) for x in schema)
    if not isinstance(schema, dict):
        return schema
    if schema.get("type") == "null":
        return None
    if "const" in schema and "enum" not in schema:
        schema = {**schema, "enum": [schema["const"]]}

    # anyOf: unwrap a lone non-null branch (pydantic Optional), else normalize
    # each branch and sort so branch order doesn't matter.
    if "anyOf" in schema:
        branches = [_norm_inner(b) for b in schema["anyOf"]]
        non_null = [b for b in branches if b is not None]
        if None in branches and len(non_null) == 1:
            return non_null[0]
        out = {k: v for k, v in schema.items() if k in _KEEP and k != "anyOf"}
        out["anyOf"] = sorted(non_null, key=_key)
        return _sorted_keys(out)

    out = {k: v for k, v in schema.items() if k in _KEEP}
    if "enum" in out:
        out["enum"] = sorted(out["enum"])
    if "properties" in out:
        out["properties"] = {k: _norm_inner(v) for k, v in out["properties"].items()}
    if "required" in out:
        out["required"] = sorted(out["required"])
    if "items" in out:
        out["items"] = _norm_inner(out["items"])
    return _sorted_keys(out)


def _key(x):
    return json.dumps(x, sort_keys=True) if isinstance(x, (dict, list)) else str(x)


def _sorted_keys(d):
    return {k: d[k] for k in sorted(d)}


# ── the contract ────────────────────────────────────────────────────────────


async def test_tool_names_match_node():
    node = load_contract()
    py = await python_tools()
    missing = set(node) - set(py) - set(ALLOWED_MISSING)
    extra = set(py) - set(node)
    assert not missing, f"tools the Node server has but Python lacks: {sorted(missing)}"
    assert not extra, f"tools only Python has (remove or add to Node): {sorted(extra)}"


async def test_descriptions_are_byte_identical():
    node = load_contract()
    py = await python_tools()
    drifted = [
        name
        for name, ntool in node.items()
        if name not in ALLOWED_DESCRIPTION_OVERRIDES
        and name not in ALLOWED_MISSING
        and name in py
        and py[name].description != ntool["description"]
    ]
    assert not drifted, (
        f"descriptions drifted for tools {drifted} — copy the Node text "
        f"from tests/fixtures/tool-contract.json"
    )


async def test_input_schemas_match_structurally():
    node = load_contract()
    py = await python_tools()
    drifted = []
    for name, ntool in node.items():
        if name in ALLOWED_MISSING or name not in py:
            continue
        n_schema = _norm(ntool["inputSchema"])
        p_schema = _norm(py[name].input_schema)
        if p_schema != n_schema:
            drifted.append(
                f"{name}:\n  python: {json.dumps(p_schema, sort_keys=True)}\n"
                f"  node:   {json.dumps(n_schema, sort_keys=True)}"
            )
    assert not drifted, "input schemas drifted:\n" + "\n".join(drifted)


async def test_meta_flags_match():
    node = load_contract()
    py = await python_tools()
    drifted = [
        name
        for name, ntool in node.items()
        if name not in ALLOWED_MISSING
        and name in py
        and (py[name].meta or None) != (ntool.get("_meta") or None)
    ]
    assert not drifted, f"_meta drifted for tools {drifted} (requiresUserInteraction flags)"
