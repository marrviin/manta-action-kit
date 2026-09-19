# Manta Action Kit

**English** | [中文](#中文)

Give AI agents (Claude Code, Codex, …) secure access to your real, logged-in
APIs — without ever handing over your credentials. You record a business API
flow once in your browser; your agent then reads the flow and calls those
endpoints through a controlled sandbox proxy, while your cookies and tokens stay
locked inside the browser.

A pnpm **monorepo** with two packages:

- **`packages/extension`** — the Chrome extension (Manifest V3), the main
  implementation.
- **`packages/mcp`** — [`@manta-action-kit/mcp`](packages/mcp/README.md), the
  MCP server that bridges an agent to the extension over a local WebSocket.

## Stack

- **[WXT](https://wxt.dev)** — file-based MV3 framework, auto-generates the
  manifest, type-safe storage & messaging.
- **React 19 + TypeScript**
- **[Ant Design v6](https://ant.design)** — native React 19 support (no compat
  patch). Wrapped in `components/app-providers.tsx`; theme driven by
  `settings.theme`.
- **Tailwind CSS v4** — layout utilities only; **preflight disabled** so it
  doesn't fight antd.
- **i18n** — react-i18next (en / zh-CN); agent-facing copy is fixed English.

## Features

### 1. API recording (录制)

- **Popup** — one-click start/stop recording of the current tab's API calls,
  with a live captured count.
- **Side panel** — recording management: list (rename / delete) and a detail
  view showing the call chain as a vertical timeline (expand each node for its
  request/response) plus an aggregated **endpoint contract** view.
- Capture: a MAIN-world script hooks the page's `fetch`/`XHR` (no debugger
  banner). SSE (`text/event-stream`) is captured incrementally via `body.tee()`.
- Storage: IndexedDB (database `manta-action-kit`).

### 2. MCP service — let an agent read recordings

There is no MCP master switch: the extension background dials into the local MCP
server (`packages/mcp`) as a **WebSocket client** (an MV3 service worker can't
listen on a port, so the socket direction is inverted). The server speaks MCP
over **stdio** to the agent and runs the WS server the extension connects to.
The loopback bridge is **mutually authenticated** with a token-based
challenge-response (`MANTA_TOKEN` from the extension's install prompt; the
token never crosses the wire). Tools include the recording readers
(`list_recordings` / `get_recording` / `get_call` / `get_endpoints` /
`get_flow`) and the **actions** toolset (create, update, and execute reusable,
parameterized flows distilled from a recording).

### 3. Sandbox proxy — let an agent call authenticated APIs

The reverse direction: a `proxy_fetch` tool takes only `method/url/headers/body`
(**no credentials**). The extension injects the user's browser cookies at
forward time via `chrome.cookies` + a short-lived `declarativeNetRequest`
session rule — so **cookies never reach the AI**. Guards: a per-tool kill
switch, an extension-side human-in-the-loop confirmation popup (covers both the
agent path and the script-driven path, independent of MCP client behavior), and
an audit log (cookie **names** logged, values never). See
[`packages/mcp/README.md`](packages/mcp/README.md) and `lib/gateway/`.

## Prerequisites

- Node ≥ 20 (developed on Node 24)
- pnpm ≥ 9 (developed on pnpm 11)

## Getting started

```bash
pnpm install          # installs deps + runs `wxt prepare`
pnpm dev              # start dev server with HMR (Chrome)
pnpm dev:firefox      # dev for Firefox
```

`pnpm dev` launches a browser with the extension auto-loaded. Popup/side panel
get full HMR; content scripts & background auto-reload.

## Build, test & package

```bash
pnpm build            # production build -> packages/extension/.output/chrome-mv3/
pnpm build:firefox    # -> .output/firefox-mv2/
pnpm zip              # zipped, store-ready package
pnpm compile          # type-check the whole workspace (tsc --noEmit)
pnpm test             # run the unit suite (vitest)
pnpm build:mcp        # build the MCP server -> packages/mcp/dist/
pnpm start:mcp        # run the MCP server (stdio + local WS bridge)
```

To load an unpacked build manually: open `chrome://extensions`, enable Developer
mode, "Load unpacked", select `packages/extension/.output/chrome-mv3/`.

Tests cover the pure, security-critical modules — proxy-rule resolution
(origin-escape prevention), schema inference, example redaction (credential
masking), SSE parsing, endpoint aggregation, and the WS bridge handshake auth
(cross-checked against the server's node:crypto implementation). See
`lib/**/*.test.ts`.

## Project structure

```
packages/
├─ extension/     # Chrome extension (below)
└─ mcp/           # MCP server: bridges an agent to the extension over local WS

packages/extension/
├─ entrypoints/
│  ├─ background.ts          # MV3 service worker: message hub, recording session, gateway
│  ├─ injected-api-hook.ts   # MAIN-world script: patches fetch/XHR to capture calls
│  ├─ popup/ · sidepanel/    # React UIs (recording controls; management)
│  └─ content/               # content script: injects the hook, relays captures
├─ components/               # app-providers, settings, recording/ and gateway/ panels
├─ lib/
│  ├─ db.ts                  # IndexedDB wrapper
│  ├─ storage.ts             # reactive storage items (WXT storage API)
│  ├─ messaging.ts           # typed cross-context message protocol
│  ├─ sse-parse.ts           # pure SSE parser (shared by hook + gateway)
│  ├─ gateway/               # sandbox proxy: cookie injection, proxy-rule routing, audit
│  ├─ mcp/                   # MCP protocol + RPC handlers (extension side)
│  ├─ i18n/                  # react-i18next catalog (en / zh-CN)
│  └─ recording/             # domain types, session state machine, aggregation
├─ assets/tailwind.css       # Tailwind entry + @theme tokens
├─ public/icon/              # extension icons (replace placeholders before release)
└─ wxt.config.ts             # manifest, permissions, Tailwind plugin
```

## Key conventions

- **Adding an entrypoint:** create a file/folder under `entrypoints/`; WXT wires
  the manifest — no manual manifest edits.
- **Permissions** (`wxt.config.ts`): `storage`, `sidePanel`, `scripting`,
  `tabs`, `cookies`, `declarativeNetRequestWithHostAccess`, `alarms`, plus
  `host_permissions: ['<all_urls>']` (hook injection + cookie forwarding).
- **Storage:** structured prefs/toggles → `lib/storage.ts` items (reactive,
  cross-context); bulk recording data → IndexedDB (`lib/db.ts`).
- **Domain types:** the single source of truth is `lib/recording/types.ts`.
- **MAIN-world injection:** `injected-api-hook.ts` is injected by the content
  script; it's registered in `web_accessible_resources` and may only import pure
  types/constants (no extension APIs).
- **Path alias:** `@/` maps to the extension package root.
- **File naming:** lowercase kebab-case for files; components stay PascalCase,
  hooks camelCase.

## Notes

- Capture covers **fetch/XHR** only (WebSocket / sendBeacon / worker requests are
  out of scope). Native `EventSource` is not intercepted; SSE-over-fetch is.
- `pnpm-workspace.yaml` pins which native build scripts pnpm may run and disables
  pnpm 11's redundant pre-run deps check.

## License

MIT — see [LICENSE](LICENSE).

---

<a name="中文"></a>

# Manta Action Kit（中文文档）

[English](#manta-action-kit) | **中文**

让 AI agent（Claude Code、Codex 等）安全访问你**真实登录态**下的 API——全程不
交出任何凭证。你在浏览器里录制一次业务 API 流程；agent 随后读取该流程，并经受控
的沙箱代理调用这些接口，而你的 Cookie 与 token 始终锁在浏览器里。

一个 pnpm **monorepo**，包含两个包：

- **`packages/extension`** —— Chrome 扩展（Manifest V3），主体实现。
- **`packages/mcp`** —— [`@manta-action-kit/mcp`](packages/mcp/README.md)，经
  本地 WebSocket 把 agent 与扩展桥接起来的 MCP 服务。

## 技术栈

- **[WXT](https://wxt.dev)** —— 文件约定式 MV3 框架，自动生成 manifest，
  类型安全的 storage 与消息通信。
- **React 19 + TypeScript**
- **[Ant Design v6](https://ant.design)** —— 原生支持 React 19（无需 compat
  补丁）。统一由 `components/app-providers.tsx` 包裹；主题跟随 `settings.theme`。
- **Tailwind CSS v4** —— 仅用布局工具类；**preflight 已禁用**，避免与 antd 冲突。
- **i18n** —— react-i18next（en / zh-CN）；agent 可见文案固定英文。

## 功能

### 1. API 接口录制

- **Popup（工具栏弹窗）** —— 一键开始/停止录制当前标签页的 API 调用，实时显示
  已捕获数量。
- **侧边栏** —— 录制管理：列表（改名 / 删除）+ 详情视图。详情以竖向时间线展示
  调用链路（每个节点可展开查看请求/响应），另有聚合的**接口契约**视图。
- 捕获方式：MAIN world 脚本 hook 页面的 `fetch`/`XHR`（无 debugger 横幅）。
  SSE（`text/event-stream`）经 `body.tee()` 增量捕获。
- 存储：IndexedDB（数据库名 `manta-action-kit`）。

### 2. MCP 服务——让 agent 读取录制

没有 MCP 总开关：扩展 background 作为 **WebSocket 客户端**主动拨入本地 MCP 服务
（`packages/mcp`；MV3 service worker 无法监听端口，因此连接方向是反的）。服务端
通过 **stdio** 与 agent 通信，并运行扩展连入的 WS 服务。环回桥接采用基于 token 的
challenge-response 做**双向认证**（`MANTA_TOKEN` 取自扩展的安装提示词；token 本身
永不上线传输）。工具包括录制读取（`list_recordings` / `get_recording` /
`get_call` / `get_endpoints` / `get_flow`）和 **Action** 工具组（创建、修改并执行
从录制蒸馏出的可参数化可复用流程）。

### 3. 沙箱代理——让 agent 调用带鉴权的 API

反方向：`proxy_fetch` 工具只接收 `method/url/headers/body`（**不带任何凭证**）。
扩展在转发时经 `chrome.cookies` + 短时效的 `declarativeNetRequest` 会话规则注入
用户浏览器 Cookie——**Cookie 永远到不了 AI**。防护：按工具的 kill switch、扩展侧
人在环确认弹窗（同时覆盖 agent 路径与脚本驱动路径，不依赖 MCP 客户端行为）、审计
日志（只记 Cookie **名称**，绝不记值）。见
[`packages/mcp/README.md`](packages/mcp/README.md) 与 `lib/gateway/`。

## 环境要求

- Node ≥ 20（开发环境 Node 24）
- pnpm ≥ 9（开发环境 pnpm 11）

## 快速开始

```bash
pnpm install          # 安装依赖 + 执行 `wxt prepare`
pnpm dev              # 启动开发服务器（Chrome，带 HMR）
pnpm dev:firefox      # Firefox 开发
```

`pnpm dev` 会启动一个自动加载扩展的浏览器。Popup/侧边栏享受完整 HMR；
content script 与 background 自动重载。

## 构建、测试与打包

```bash
pnpm build            # 生产构建 -> packages/extension/.output/chrome-mv3/
pnpm build:firefox    # -> .output/firefox-mv2/
pnpm zip              # 打包成可上架 zip
pnpm compile          # 类型检查整个工作区 (tsc --noEmit)
pnpm test             # 运行单元测试 (vitest)
pnpm build:mcp        # 构建 MCP 服务 -> packages/mcp/dist/
pnpm start:mcp        # 运行 MCP 服务（stdio + 本地 WS bridge）
```

手动加载未打包构建：打开 `chrome://extensions`，开启开发者模式，"加载已解压的
扩展程序"，选择 `packages/extension/.output/chrome-mv3/`。

测试覆盖纯函数性质的安全关键模块——代理规则解析（防 origin 逃逸）、Schema 推断、
示例脱敏（凭证遮蔽）、SSE 解析、端点聚合，以及 WS 桥接握手认证（与服务端
node:crypto 实现交叉验证）。见 `lib/**/*.test.ts`。

## 项目结构

```
packages/
├─ extension/     # Chrome 扩展（下方详列）
└─ mcp/           # MCP 服务：经本地 WS 把 agent 与扩展桥接起来

packages/extension/
├─ entrypoints/
│  ├─ background.ts          # MV3 service worker：消息中枢、录制会话、网关
│  ├─ injected-api-hook.ts   # MAIN world 脚本：patch fetch/XHR 捕获调用
│  ├─ popup/ · sidepanel/    # React UI（录制控制；管理界面）
│  └─ content/               # content script：注入 hook、中继捕获
├─ components/               # app-providers、settings、recording/ 与 gateway/ 面板
├─ lib/
│  ├─ db.ts                  # IndexedDB 封装
│  ├─ storage.ts             # 响应式 storage items（WXT storage API）
│  ├─ messaging.ts           # 类型化跨上下文消息协议
│  ├─ sse-parse.ts           # 纯 SSE 解析器（hook 与网关共用）
│  ├─ gateway/               # 沙箱代理：Cookie 注入、代理规则路由、审计
│  ├─ mcp/                   # MCP 协议 + RPC 处理（扩展侧）
│  ├─ i18n/                  # react-i18next 文案（en / zh-CN）
│  └─ recording/             # 领域类型、录制状态机、聚合
├─ assets/tailwind.css       # Tailwind 入口 + @theme tokens
├─ public/icon/              # 扩展图标（发布前替换占位图）
└─ wxt.config.ts             # manifest、权限、Tailwind 插件
```

## 关键约定

- **加扩展入口**：在 `entrypoints/` 下建文件/目录即可，WXT 自动写入 manifest——
  别手改 manifest。
- **权限**（`wxt.config.ts`）：`storage` `sidePanel` `scripting` `tabs` `cookies`
  `declarativeNetRequestWithHostAccess` `alarms`，外加
  `host_permissions: ['<all_urls>']`（hook 注入 + Cookie 转发需要）。
- **存储**：结构化偏好/开关 → `lib/storage.ts` items（响应式，跨上下文同步）；
  大体积录制数据 → IndexedDB（`lib/db.ts`）。
- **领域类型**：单一数据源在 `lib/recording/types.ts`。
- **MAIN world 注入**：`injected-api-hook.ts` 由 content script 注入，登记在
  `web_accessible_resources`，只能 import 纯类型/常量（不能用扩展 API）。
- **路径别名**：`@/` 指向扩展包根目录。
- **文件命名**：文件名一律小写 kebab-case；组件保持 PascalCase，hook 用 camelCase。

## 备注

- 捕获只覆盖 **fetch/XHR**（WebSocket / sendBeacon / worker 内请求不在范围内）。
  原生 `EventSource` 未拦截；走 fetch 的 SSE 已覆盖。
- `pnpm-workspace.yaml` 限定了 pnpm 允许运行的 native 构建脚本，并关闭了
  pnpm 11 冗余的运行前依赖检查。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
