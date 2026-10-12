# @manta-action-kit/mcp (Python)

Python port of the Manta Action Kit MCP server ([packages/mcp](../mcp)) — exposes
the Chrome extension's recorded API calls to an agent as MCP tools over stdio,
bridged to the extension over a local WebSocket.

## Scope vs the Node server

The Node server remains the reference implementation; the Python port covers
the full agent tool surface except the script-driven HTTP proxy.

| Capability | Node (`packages/mcp`) | Python (`packages/mcp-py`) |
| --- | --- | --- |
| WS bridge + token handshake (hello/welcome/auth) | ✅ | ✅ |
| owner/peer single-instance election + takeover | ✅ | ✅ |
| recordings: list / get / flow / endpoints / call / set description | ✅ | ✅ |
| actions: list / get / search / create / update / delete / **execute** | ✅ | ✅ |
| proxy_fetch / proxy_sse (gateway entry, cookie injection) | ✅ | ✅ |
| proxy rules: list / add / update (rules live extension-side) | ✅ | ✅ |
| element captures: list / get / diff | ✅ | ✅ |
| capture_screenshot / capture_element | ✅ | ✅ |
| GIF tab recordings: start / stop / pause / resume / status / history | ✅ | ✅ |
| health | ✅ | ✅ |
| local HTTP proxy (script-driven entry) + rebind_proxy | ✅ | ❌ not here — run the Node server alongside; its proxy serves the shared rules |

The wire protocol (frame types, RPC methods, HMAC handshake domain prefixes) is
byte-identical with the Node/extension implementations — pinned by
`tests/test_auth.py` (golden vectors generated from `packages/mcp/src/auth.ts`)
and `tests/test_cross_node_bridge.py` (live handshakes against the real Node
bridge: as extension-role client AND as peer).

## Staying in sync with the Node server

The tool surface is contract-tested against the Node server: the fixture
`tests/fixtures/tool-contract.json` is exported from the REAL Node
registration path and the Python suite fails on any drift in tool names,
descriptions (byte-for-byte), input schemas, and `_meta`:

```sh
pnpm --filter @manta-action-kit/mcp build && \
pnpm --filter @manta-action-kit/mcp contract:export   # regenerate the fixture
uv run pytest tests/test_tool_contract.py tests/test_node_parity.py
```

`tests/test_node_parity.py` additionally pins the lockstep version number,
the protocol's default ports, and the RPC method set. Workflow for Node-side
tool changes is documented in [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Install / run

```sh
uvx manta-action-kit-mcp        # once published to PyPI
# or from a checkout:
uv sync && uv run manta-action-kit-mcp
```

MCP client config (Claude Code / Cursor etc.):

```json
{
  "mcpServers": {
    "manta-action-kit": {
      "command": "uvx",
      "args": ["manta-action-kit-mcp"],
      "env": {
        "MANTA_TOKEN": "<token from the extension's install prompt>",
        "MANTA_WS_PORT": "8787"
      }
    }
  }
}
```

Env:

- `MANTA_TOKEN` — handshake secret shared with the extension (from its install
  prompt). Without it the bridge rejects every client (fail closed).
- `MANTA_WS_PORT` — local bridge port (default 8787; must match the extension
  setting).
- `MANTA_LOG_LEVEL` — `DEBUG`/`INFO`/... (default `INFO`).

## Coexistence with the Node server

Only one process can own the bridge port; both implementations elect an owner
and degrade to peers that forward through it, and they can mix freely (a Python
peer can forward through a Node owner and vice versa). If you need the
script-driven HTTP proxy (proxy rules for scripts), run the Node server —
whichever process owns the port receives the extension's data.

## Development

```sh
uv sync                                   # deps + venv
uv run pytest -q                          # unit + bridge integration tests
pnpm --filter @manta-action-kit/mcp build # enables the cross-language test
uv run pytest tests/test_cross_node_bridge.py -q
```
