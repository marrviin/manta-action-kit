"""Wire protocol constants — Python mirror of @manta-action-kit/protocol.

The single source of truth is packages/protocol/src/index.ts (shared with the
extension); this module mirrors ONLY the pieces the Python server needs. The
frame type strings, RPC method names, and the auth domain prefixes must stay
byte-identical with the TS side — tests/test_auth.py and
tests/test_cross_node_bridge.py pin this against the real Node bridge.
"""

from typing import Final

# Constants (packages/protocol/src/index.ts).
DEFAULT_MCP_PORT: Final[int] = 8787
DEFAULT_PROXY_PORT: Final[int] = 8788

# Frame types (WebSocket wire format).
HELLO: Final[str] = "hello"
WELCOME: Final[str] = "welcome"
AUTH: Final[str] = "auth"
PING: Final[str] = "ping"
PONG: Final[str] = "pong"
RPC: Final[str] = "rpc"
RPC_RESULT: Final[str] = "rpc-result"
PEER_RPC: Final[str] = "peer-rpc"
PEER_RPC_RESULT: Final[str] = "peer-rpc-result"

# Roles a client may declare in its hello frame.
ROLE_EXTENSION: Final[str] = "extension"
ROLE_PEER: Final[str] = "peer"

# RPC methods the agent can invoke against the extension (RpcMethod union).
RPC_METHODS: Final[frozenset[str]] = frozenset(
    {
        "list_recordings",
        "get_recording",
        "get_call",
        "get_flow",
        "get_endpoints",
        "set_recording_description",
        "list_element_captures",
        "get_element_capture",
        "diff_element_captures",
        "proxy_fetch",
        "proxy_sse",
        "proxy_rule",
        "list_proxy_rules",
        "add_proxy_rule",
        "update_proxy_rule",
        "set_proxy_port",
        "list_actions",
        "get_action",
        "search_actions",
        "create_action",
        "update_action",
        "delete_action",
        "execute_action",
        "capture_screenshot",
        "capture_element",
        "start_gif_recording",
        "stop_gif_recording",
        "pause_gif_recording",
        "resume_gif_recording",
        "get_gif_recording_status",
        "list_gif_history",
    }
)
