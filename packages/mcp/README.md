# manta-action-kit-mcp

**English** | [Chinese](#chinese)

MCP (Model Context Protocol) server for Manta Action Kit. Exposes the Chrome
extension's recorded API calls to an AI agent as MCP tools, and provides a
cookie-injecting gateway so scripts/agents can call authenticated APIs without
ever seeing the user's credentials.

## Requirements

This server is only a bridge — it has no data of its own. It requires the
**Manta Action Kit** Chrome extension, which records the API calls, stores them
in IndexedDB, and injects the cookies. Install it first; the extension dials in
automatically once this server is running:

> **Manta Action Kit** (Chrome Web Store):
> <https://chromewebstore.google.com/detail/manta-action-kit/pghddhbhbnlcehlmgnnalgaephllkeel>

## Architecture

An MV3 extension can't listen on a port, so the socket direction is inverted from
a naive "extension serves a port" design (this is the standard pattern used by
Chrome-extension MCP bridges):

```
agent ──stdio (MCP)──▶ manta-action-kit-mcp ──WS server ws://127.0.0.1:8787──▶ extension (WS client)
                                       ◀──── rpc-result {id} ───────────  reads IndexedDB
```

- This package hosts a **WebSocket bridge bound to loopback** (`127.0.0.1:8787`) —
  the trust boundary — and speaks **MCP over stdio** to the agent.
- It also hosts a **local HTTP proxy** (`127.0.0.1:8788` by default) — the
  script-driven gateway. A script points its baseURL at a sandbox prefix and the
  extension rewrites + forwards the request with the user's cookies injected.
- The extension background **dials in** as a client (always-on, reconnecting
  with backoff) and answers RPC calls from its IndexedDB.
- Each agent tool call is forwarded as an `rpc` frame and correlated to its
  `rpc-result` by `id`.

### Handshake authentication

The loopback port is public knowledge, so every socket is authenticated before
any business frame flows — in **both** directions. The extension and the server
share a token (the extension generates it once and injects it into the install
prompt as the `MANTA_TOKEN` env; the token itself never crosses the wire):

```
client → hello   { nonce }                                        (fresh per connection)
server → welcome { proof = HMAC(token, "manta/welcome/" + nonce), nonce }
client → auth    { proof = HMAC(token, "manta/auth/" + nonce) }
```

A socket that fails or stalls mid-handshake is dropped; unauthenticated peers
can neither read data nor inject frames. Connections carrying a web `Origin`
header (a page dialing `ws://127.0.0.1` from the open web) are rejected outright.
Without `MANTA_TOKEN` the server fails closed and rejects every client.

### Single-instance election (owner / peer)

Every MCP process starts identically (via `npx`) and races for the WS bridge port:

- **OWNER**: won the port. Hosts the WS bridge + HTTP proxy; tool calls go straight
  to the extension.
- **PEER**: lost the port. Dials the owner as a client and forwards every tool call
  to it. When the owner exits, each peer re-runs the election, so one takes over
  without a manual restart.

## Tools

### Recordings (read + one write)

| Tool                        | Description                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `list_recordings`           | All recordings' metadata (id, name, origin, createdAt, callCount).                                                           |
| `get_recording`             | One recording + its full API call chain (request/response/status/timing).                                                    |
| `get_flow`                  | A recording's calls as ordered lightweight steps + inferred field dependencies linking them.                                 |
| `get_endpoints`             | Distinct endpoints collapsed by method + normalized path, with request/response bodies as REDACTED schemas (+ `inputsFrom`). |
| `get_call`                  | A single API call by id, with full request/response bodies & headers.                                                        |
| `set_recording_description` | Write (overwrite) a recording's business-level, agent-authored flow summary (the only write path).                           |

### Actions (replayable flows distilled from a recording)

| Tool             | Description                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `list_actions`   | All saved actions (summaries only: params, stepCount).                                         |
| `get_action`     | One action's full definition (steps, overrides, output extraction paths).                       |
| `search_actions` | Find actions by keyword in name/description.                                                    |
| `create_action`  | Distill a recording into a saved, parameterized action (requires user confirmation).            |
| `update_action`  | Patch an action's content by id (requires user confirmation).                                   |
| `delete_action`  | Delete an action by id (requires user confirmation).                                            |
| `execute_action` | Run an action end to end through the gateway (cookies injected, per-host user confirmation).    |

### Proxy rules (script gateway)

| Tool                | Description                                                                |
| ------------------- | -------------------------------------------------------------------------- |
| `list_proxy_rules`  | List sandbox proxy rules (sandboxPrefix → targetBase, enabled, …).         |
| `add_proxy_rule`    | Create a rule mapping a local sandbox prefix to a real target base URL.    |
| `update_proxy_rule` | Patch a rule's sandboxPrefix / targetBase by id (cannot toggle `enabled`). |

> `enabled` is a user-controlled kill switch — tools can read it but never change it.

### Authenticated gateway calls

| Tool          | Description                                                                        |
| ------------- | ---------------------------------------------------------------------------------- |
| `proxy_fetch` | Forward a call through the extension with the user's cookies injected.             |
| `proxy_sse`   | Like `proxy_fetch`, but drains a Server-Sent Events stream and returns all events. |

> Every `proxy_fetch` / `proxy_sse` / `execute_action` call passes the
> extension's **own** confirmation popup (human-in-the-loop, rendered by the
> extension itself) — this covers the script-driven gateway path too and does
> not depend on the MCP client honoring native permission prompts.

### Runtime health

| Tool           | Description                                                             |
| -------------- | ----------------------------------------------------------------------- |
| `health`       | Report wsPort, proxyPort, proxyListening, extensionConnected, role.     |
| `rebind_proxy` | Move the HTTP proxy to a free port at runtime (recover from conflicts). |

## Build & run

```bash
pnpm --filter @manta-action-kit/mcp build   # tsc -> dist/
pnpm --filter @manta-action-kit/mcp start   # node dist/index.js
```

Config:

- `MANTA_WS_PORT` (default `8787`) — WS bridge; must match the extension setting.
- `MANTA_PROXY_PORT` (default `8788`) — local HTTP proxy for the script gateway
  (must differ from `MANTA_WS_PORT`).
- `MANTA_TOKEN` — handshake secret shared with the extension; take it from the
  extension's install prompt. Without it the server rejects every client.

## Wiring into an agent (e.g. Claude Code / Codex)

The extension's **Action tab** has a **Copy install prompt** button that copies
a ready-to-paste instruction with the right command and the current ports +
`MANTA_TOKEN`. In a production build it uses the published package via `npx`;
in a dev build it points at your locally-built `dist/index.js`.

Equivalent manual config — **production** (published package):

```jsonc
{
  "mcpServers": {
    "manta-action-kit": {
      "command": "npx",
      "args": ["-y", "@manta-action-kit/mcp"],
      "env": { "MANTA_WS_PORT": "8787", "MANTA_PROXY_PORT": "8788", "MANTA_TOKEN": "<from the extension>" },
    },
  },
}
```

**Development** (unpublished — run the local build directly):

```jsonc
{
  "mcpServers": {
    "manta-action-kit": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp/dist/index.js"],
      "env": { "MANTA_WS_PORT": "8787", "MANTA_PROXY_PORT": "8788", "MANTA_TOKEN": "<from the extension>" },
    },
  },
}
```

Once the extension connects (it dials in automatically), the tools return live
data; otherwise they return an error telling you what to check.

---

<a name="chinese"></a>

# manta-action-kit-mcp (中文文档)

[English](#manta-action-kit-mcp) | **中文**

Manta Action Kit 的 MCP（Model Context Protocol）服务。它将 Chrome 扩展录制的
API 调用作为 MCP 工具暴露给 AI Agent，并提供一个注入 Cookie 的网关，使脚本/Agent
能够调用需要鉴权的 API，同时全程看不到用户的凭证。

## 前置要求

本服务只是一个桥——自身不持有任何数据。它依赖 **Manta Action Kit** Chrome 扩展：
接口录制、IndexedDB 存储与 Cookie 注入都由扩展完成。请先安装扩展；本服务启动后
扩展会自动拨入连接：

> **Manta Action Kit**（Chrome Web Store）：
> <https://chromewebstore.google.com/detail/manta-action-kit/pghddhbhbnlcehlmgnnalgaephllkeel>

## 架构

MV3 扩展无法监听端口，因此这里把 socket 的连接方向做了反转，而不是采用朴素的
“扩展开放端口对外服务” 设计（这也是 Chrome 扩展类 MCP 桥接的标准做法）：

```
agent ──stdio (MCP)──▶ manta-action-kit-mcp ──WS 服务 ws://127.0.0.1:8787──▶ 扩展 (WS 客户端)
                                           ◀──── rpc-result {id} ───────────  读取 IndexedDB
```

- 本包托管一个 **绑定到本地回环地址的 WebSocket 桥接**（`127.0.0.1:8787`）—— 即
  信任边界 —— 并通过 **stdio 上的 MCP 协议** 与 Agent 通信。
- 同时托管一个 **本地 HTTP 代理**（默认 `127.0.0.1:8788`）—— 即脚本驱动的网关。
  脚本将其 baseURL 指向某个沙箱前缀，扩展会重写并转发请求，同时注入用户的 Cookie。
- 扩展 background 会作为客户端**始终主动拨入连接**（带退避重连），并从自身的
  IndexedDB 中响应 RPC 调用。
- 每一次 Agent 的工具调用都会被转发为一个 `rpc` 帧，并通过 `id` 与对应的
  `rpc-result` 进行关联。

### 握手认证

环回端口是公开常识，因此任何业务帧传输之前，连接双方都要先完成**双向认证**。
扩展与服务端共享一个 token（由扩展首次生成，经安装提示词注入 MCP 配置的
`MANTA_TOKEN` env；token 本身永不上线传输）：

```
客户端 → hello   { nonce }                                          （每次连接随机生成）
服务端 → welcome { proof = HMAC(token, "manta/welcome/" + nonce), nonce }
客户端 → auth    { proof = HMAC(token, "manta/auth/" + nonce) }
```

握手失败或中途停滞的连接会被直接断开；未认证的对端既读不到数据，也无法注入任何帧。
携带网页 `Origin` 头的连接（网页从公网页面直连 `ws://127.0.0.1`）一律拒绝。
未配置 `MANTA_TOKEN` 时服务端 fail closed，拒绝所有客户端。

### 单实例选举（owner / peer）

每个 MCP 进程都以相同方式启动（通过 `npx`），并竞争 WS 桥接端口：

- **OWNER**：抢到端口，托管 WS 桥接 + HTTP 代理；工具调用直接发往扩展。
- **PEER**：没抢到端口，作为客户端连接 owner，并把每次工具调用转发给它。当 owner
  退出时，各 peer 会重新选举，无需手动重启即可接管。

## 工具

### 录制（读取 + 一个写入）

| 工具                        | 说明                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `list_recordings`           | 所有录制的元数据（id、名称、来源、创建时间、调用数）。                                     |
| `get_recording`             | 单个录制 + 其完整 API 调用链（请求/响应/状态/耗时）。                                      |
| `get_flow`                  | 录制的调用链：有序的轻量步骤 + 推断出的字段依赖关系（上游响应值如何喂给下游请求）。        |
| `get_endpoints`             | 按方法 + 归一化路径去重后的独立端点，请求/响应体推断为「脱敏 Schema」（含 `inputsFrom`）。 |
| `get_call`                  | 按 id 获取单个 API 调用，包含完整的请求/响应体与请求头。                                   |
| `set_recording_description` | 写入（覆盖）录制的业务级流程摘要（由 Agent 撰写），是唯一的写入路径。                      |

### 动作（从录制蒸馏出的可回放流程）

| 工具             | 说明                                                                           |
| ---------------- | ------------------------------------------------------------------------------ |
| `list_actions`   | 所有已保存动作的概要（参数、步骤数等）。                                       |
| `get_action`     | 单个动作的完整定义（步骤、覆写、输出提取路径）。                               |
| `search_actions` | 按关键词搜索动作名称/描述。                                                     |
| `create_action`  | 将一段录制蒸馏为可参数化的已保存动作（需用户确认）。                           |
| `update_action`  | 按 id 修改动作内容（需用户确认）。                                             |
| `delete_action`  | 按 id 删除动作（需用户确认）。                                                 |
| `execute_action` | 经网关端到端执行一个动作（注入 Cookie，按目标 host 逐个用户确认）。             |

### 代理规则（脚本网关）

| 工具                | 说明                                                              |
| ------------------- | ----------------------------------------------------------------- |
| `list_proxy_rules`  | 列出沙箱代理规则（sandboxPrefix → targetBase、enabled 等）。      |
| `add_proxy_rule`    | 创建一条规则，将本地沙箱前缀映射到真实目标 base URL。             |
| `update_proxy_rule` | 按 id 修改规则的 sandboxPrefix / targetBase（不能改 `enabled`）。 |

> `enabled` 是用户掌控的安全开关 —— 工具只能读取，不能修改。

### 鉴权网关调用

| 工具          | 说明                                                             |
| ------------- | ---------------------------------------------------------------- |
| `proxy_fetch` | 经扩展转发调用，转发时注入用户的 Cookie。                        |
| `proxy_sse`   | 与 `proxy_fetch` 类似，但用于 SSE 流，抽干后一次性返回全部事件。 |

> 每次 `proxy_fetch` / `proxy_sse` / `execute_action` 调用都会经过扩展**自身**的
> 确认弹窗（人在环，由扩展渲染）——该闸门同时覆盖脚本驱动的网关路径，且不依赖
> MCP 客户端是否支持原生权限提示。

### 运行时健康检查

| 工具           | 说明                                                               |
| -------------- | ------------------------------------------------------------------ |
| `health`       | 返回 wsPort、proxyPort、proxyListening、extensionConnected、role。 |
| `rebind_proxy` | 运行时把 HTTP 代理迁移到空闲端口（用于从端口冲突中恢复）。         |

## 构建与运行

```bash
pnpm --filter @manta-action-kit/mcp build   # tsc -> dist/
pnpm --filter @manta-action-kit/mcp start   # node dist/index.js
```

配置项：

- `MANTA_WS_PORT`（默认 `8787`）—— WS 桥接端口；必须与扩展设置保持一致。
- `MANTA_PROXY_PORT`（默认 `8788`）—— 脚本网关使用的本地 HTTP 代理端口（必须与
  `MANTA_WS_PORT` 不同）。
- `MANTA_TOKEN` —— 与扩展共享的握手密钥；取自扩展的安装提示词。未配置时服务端
  会拒绝所有客户端。

## 接入 Agent（例如 Claude Code / Codex）

扩展的 **Action 标签页** 提供 **复制安装提示词** 按钮，可复制一段可直接粘贴的安装
说明，其中包含正确的命令、当前端口与 `MANTA_TOKEN`。生产构建会通过 `npx` 使用已
发布的包；开发构建则会指向你本地构建出的 `dist/index.js`。

等价的手动配置 —— **生产环境**（已发布的包）：

```jsonc
{
  "mcpServers": {
    "manta-action-kit": {
      "command": "npx",
      "args": ["-y", "@manta-action-kit/mcp"],
      "env": { "MANTA_WS_PORT": "8787", "MANTA_PROXY_PORT": "8788", "MANTA_TOKEN": "<来自扩展>" },
    },
  },
}
```

**开发环境**（未发布 —— 直接运行本地构建）：

```jsonc
{
  "mcpServers": {
    "manta-action-kit": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp/dist/index.js"],
      "env": { "MANTA_WS_PORT": "8787", "MANTA_PROXY_PORT": "8788", "MANTA_TOKEN": "<来自扩展>" },
    },
  },
}
```

扩展会自动拨入连接；连接成功后工具即可返回实时数据，否则会返回错误，提示你
先排查连接（扩展侧边栏的 MCP 标签页显示连接状态）。
