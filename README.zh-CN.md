<div align="center">

# Manta Action Kit

**让 AI agent 安全访问你真实登录态下的 API——全程不交出任何凭证。**

[![Chrome Web Store](https://img.shields.io/chromewebstore/v/pghddhbhbnlcehlmgnnalgaephllkeel?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white&color=4285F4)](https://chromewebstore.google.com/detail/manta-action-kit/pghddhbhbnlcehlmgnnalgaephllkeel)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-compatible-8A2BE2)](https://modelcontextprotocol.io)
[![Privacy: local-only](https://img.shields.io/badge/data-local--only-success)](PRIVACY.md)

[English](README.md) | **中文**

</div>

Claude Code、Codex、Cursor 写代码很强，但它们碰不了你**带鉴权**的业务 API——
要么把 Cookie / token 粘进 agent 配置（凭证泄进对话记录和日志），要么只能对
agent 说"这个你做不了"。

**Manta Action Kit** 解决这个问题：在浏览器里录制一次真实的 API 调用流程，
之后 agent 既可以重放它、也可以自由调用这些接口——而你的 Cookie 与 token
始终锁在浏览器里，**AI 连一个凭证都看不到**。

## 工作原理

```
   你操作一次页面                  你的 agent（Claude Code / Codex / Cursor / …）
        │                                        │
        ▼                                        │ MCP over stdio
 ┌──────────────────────┐                  ┌──────▼───────────────┐
 │  Manta 扩展           │◀─── 本地 WS ────│  @manta-action-kit/  │
 │  hook fetch/XHR，     │  （双向认证）    │  mcp                 │
 │  逐条记录 API 调用到   │                 └──────────────────────┘
 │  IndexedDB            │
 └──────────┬───────────┘
            │  仅在你批准时，于网络层注入你的 Cookie
            ▼
      目标站点 API   ← 请求从你的浏览器发出，带着你的登录态
```

1. **录制** —— popup 里点"开始"，正常操作页面，点"结束"。扩展捕获每一条
   `fetch`/`XHR`（请求**和**响应，含 SSE 流式响应），沉淀成可逐条查看的调用链。
2. **蒸馏** —— agent 经 MCP 读取录制，把它蒸馏成可复用、可参数化的
   **Action**（`{{param}}` 模板 + 步骤间 outputs 传递）。
3. **执行** —— `execute_action` 或 `proxy_fetch` 经沙箱网关重放流程。扩展在
   转发时注入你的会话 Cookie；AI 自始至终只发过 `method/url/headers/body`。

## 为什么它是安全的

凭证留在浏览器里、**永远到不了 AI**——这是整个产品的核心，而且在多层强制执行：

- **凭证在信任边界注入** —— 扩展经 `chrome.cookies` 读取 Cookie，在网络层
  注入请求头。Cookie 的**值**不出现在任何工具返回、对话记录或日志里。
- **人在环闸门** —— 每个新目标 host 都会弹出扩展侧确认窗口（展示
  method/URL/body），每个 host 每次运行只需确认一次；拒绝或无视，请求就发
  不出去。**所有路径**（agent 调用与脚本驱动调用）都过这道闸，不依赖 MCP
  客户端的行为。
- **SSRF 防护** —— loopback、私网、link-local、云元数据地址（含
  `169.254.169.254`）在任何其他策略**之前**直接拒绝，无一例外。
- **你说了算的域名策略** —— 拒绝域名直接拦、允许域名静默放行。agent **没有
  任何工具**能读取或修改这两张名单。
- **按工具 kill switch** —— 扩展设置里可单独关闭任意 MCP 工具。
- **审计日志** —— 每条转发调用都本地留痕；只记 Cookie **名称**，绝不记值。
- **双向认证的本地桥接** —— 环回 WebSocket 握手做双向 challenge-response
  （两侧各算 `HMAC(token, …)`；token 本身永不上线）。未认证连接直接断开，
  携带网页 Origin 连 `ws://127.0.0.1` 的直接拒绝，没配 token 服务端
  fail closed。
- **数据全部本地** —— IndexedDB + `chrome.storage`。无埋点、无外部服务器、
  无远程代码。见 [PRIVACY.md](PRIVACY.md)。

## 你的 agent 能拿到什么

录制是素材，**Action 才是产物**。蒸馏出的动作是可参数化、可重放的流程，
agent 像用其他工具一样列出并执行它们：

| 领域 | 工具 |
| --- | --- |
| 读取录制 | `list_recordings` · `get_recording` · `get_call` · `get_flow` · `get_endpoints`（脱敏 Schema） |
| Action | `list_actions` · `search_actions` · `create_action` · `execute_action` 等 |
| 沙箱代理 | `proxy_fetch` · `proxy_sse`（带你的登录态） |
| 运维 | `health` · 代理规则管理 |

从 agent 视角看一个 Action 是这样的：

> `search_actions("track shipment")` → *track-order-shipment* —— 参数
> `orderId`；步骤：查订单 → 把 `{{steps[0].outputs[id]}}` 传进物流接口 →
> `execute_action({ actionId, params: { orderId: "A1002" } })` → 搞定。全程
> 走你的登录态、一次确认弹窗、完整审计。

## 快速开始

**1. 安装扩展**：从
[Chrome Web Store](https://chromewebstore.google.com/detail/manta-action-kit/pghddhbhbnlcehlmgnnalgaephllkeel)
安装。

**2. 复制安装提示词**：打开扩展侧边栏 → *Action* 标签页 → *复制安装提示词*。
里面嵌着你的专属桥接 token（`MANTA_TOKEN`）。

**3. 把 MCP 服务加进你的 agent。** 直接把提示词粘贴给 Claude Code / Codex /
任意 MCP 客户端，或手动加进 MCP 配置：

```json
{
  "mcpServers": {
    "manta-action-kit": {
      "command": "npx",
      "args": ["-y", "@manta-action-kit/mcp"],
      "env": {
        "MANTA_WS_PORT": "8787",
        "MANTA_PROXY_PORT": "8788",
        "MANTA_TOKEN": "<从扩展复制的 token>"
      }
    }
  }
}
```

**4. 用起来。** 在你的网站上录制一段流程，然后对 agent 说：

> *"我刚录了订单物流查询的流程。把它变成一个 action，然后查一下订单
> A1002 到哪了。"*

桥接 100% 跑在 `127.0.0.1` 上——除了你批准的 API 调用，没有任何数据离开
你的机器。

## 本地开发

```bash
pnpm install          # 安装依赖 + wxt prepare
pnpm dev              # Chrome 开发模式（HMR，自动加载扩展）
pnpm build            # 生产构建 -> packages/extension/.output/chrome-mv3/
pnpm compile          # 整个工作区类型检查
pnpm test             # vitest 单测（安全关键的纯函数模块）
pnpm zip              # 打包成可上架 zip
```

本仓库是 pnpm monorepo：`packages/extension`（WXT + React 19 + Ant Design v6 +
Tailwind v4，Manifest V3）与 `packages/mcp`
([`@manta-action-kit/mcp`](packages/mcp/README.md)，Node MCP 服务）。架构与
约定见 [CONTRIBUTING.md](CONTRIBUTING.md) 与
[CLAUDE.md](CLAUDE.md)——包括为什么 MV3 service worker 要**反方向**当
WebSocket 客户端、为什么 Cookie 注入走 `declarativeNetRequest` 而不是
`fetch credentials`。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
