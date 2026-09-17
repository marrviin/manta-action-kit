# manta-action-kit-mcp

**English** | [Chinese](#chinese)

MCP (Model Context Protocol) server for Manta Action Kit. Exposes the Chrome
extension's recorded API calls to an AI agent as MCP tools, and provides a
cookie-injecting gateway so scripts/agents can call authenticated APIs without
ever seeing the user's credentials.

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
- The extension, when **Settings → MCP service** is toggled on, **dials in** as a client
  and answers RPC calls from its IndexedDB.
- Each agent tool call is forwarded as an `rpc` frame and correlated to its
  `rpc-result` by `id`.

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

> Every `proxy_fetch` / `proxy_sse` call requires the user to approve a native
> confirmation prompt before it runs (requires Claude Code v2.1.199+).

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

Config (both must be distinct free ports):

- `MANTA_WS_PORT` (default `8787`) — WS bridge; must match the extension setting.
- `MANTA_PROXY_PORT` (default `8788`) — local HTTP proxy for the script gateway.

## Wiring into an agent (e.g. Claude Code / Codex)

The extension's settings page has a **Copy install instructions (for Agent)** button that copies
a ready-to-paste instruction with the right command and current port. In a
production build it uses the published package via `npx`; in a dev build it points
at your locally-built `dist/index.js`.

Equivalent manual config — **production** (published package):

```jsonc
{
  "mcpServers": {
    "manta-action-kit": {
      "command": "npx",
      "args": ["-y", "@manta-action-kit/mcp"],
      "env": { "MANTA_WS_PORT": "8787", "MANTA_PROXY_PORT": "8788" },
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
      "env": { "MANTA_WS_PORT": "8787", "MANTA_PROXY_PORT": "8788" },
    },
  },
}
```

Then: open the extension → **Settings** → turn on **MCP service** (same port). Once the
extension connects, the tools return live data; otherwise they return an error
telling you to connect.

---

<a name="chinese"></a>

# manta-action-kit-mcp (中文文档)

[English](#manta-action-kit-mcp) | **中文**

Manta Action Kit 的 MCP（Model Context Protocol）服务。它将 Chrome 扩展录制的
API 调用作为 MCP 工具暴露给 AI Agent，并提供一个注入 Cookie 的网关，使脚本/Agent
能够调用需要鉴权的 API，同时全程看不到用户的凭证。

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
- 当扩展在**设置 → MCP 服务** 中开启开关后，会作为客户端 **主动拨入连接**，并从
  自身的 IndexedDB 中响应 RPC 调用。
- 每一次 Agent 的工具调用都会被转发为一个 `rpc` 帧，并通过 `id` 与对应的
  `rpc-result` 进行关联。

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

> 每次 `proxy_fetch` / `proxy_sse` 调用前，都要求用户在原生确认弹窗中批准
> （需要 Claude Code v2.1.199+）。

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

配置项（两者必须是不同的空闲端口）：

- `MANTA_WS_PORT`（默认 `8787`）—— WS 桥接端口；必须与扩展设置保持一致。
- `MANTA_PROXY_PORT`（默认 `8788`）—— 脚本网关使用的本地 HTTP 代理端口。

## 接入 Agent（例如 Claude Code / Codex）

扩展的设置页提供了 **复制安装说明（给 Agent）** 按钮，可复制一段可直接粘贴的安装
说明，其中包含正确的命令与当前端口。生产构建会通过 `npx` 使用已发布的包；开发构建
则会指向你本地构建出的 `dist/index.js`。

等价的手动配置 —— **生产环境**（已发布的包）：

```jsonc
{
  "mcpServers": {
    "manta-action-kit": {
      "command": "npx",
      "args": ["-y", "@manta-action-kit/mcp"],
      "env": { "MANTA_WS_PORT": "8787", "MANTA_PROXY_PORT": "8788" },
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
      "env": { "MANTA_WS_PORT": "8787", "MANTA_PROXY_PORT": "8788" },
    },
  },
}
```

然后：打开扩展 → **设置** → 开启 **MCP 服务**（端口保持一致）。扩展连接成功后，
工具即可返回实时数据；否则会返回错误，提示你先建立连接。
