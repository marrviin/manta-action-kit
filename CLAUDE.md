# CLAUDE.md

> 给 Claude Code（及其他 AI 助手）的项目上下文。人也可以读。

## 项目是什么

**manta-action-kit** —— 一个 pnpm **monorepo**，包含：

- `packages/extension` —— Chrome 扩展（Manifest V3），当前主体实现。
- `packages/mcp` —— 未来的 MCP 工具（本次为空占位）。

扩展的产品定位：

- **Popup**（工具栏弹窗）：功能快速入口、快速开关。
- **Side panel**（侧边栏）：复杂功能管理 + 插件设置。侧边栏顶部用**标签页**切换不同功能，标签栏最右侧固定一个**设置齿轮按钮**（点击在下方展示设置页）。

### 功能一：API 调用录制（已完成）

用户在 popup 点“开始录制”，在页面正常操作，扩展录下页面发起的所有 API 调用（fetch/XHR，含请求输入与响应输出）；点“结束录制”停止。侧边栏“接口录制”标签页里能看到本地录制列表（可改名、删除、进详情），详情以**调用链路**（竖向时间线）展示每个 API 节点，点开看请求/响应，另有**接口契约**聚合视图。

> **回放（replay）功能已彻底移除**：相关代码（`lib/recording/replay.ts`、`lib/recording/replay-runs.ts`、`components/recording/replay-*`、`hooks/use-replay-*`）与 IndexedDB `replayRuns` store（v9 升级时删除）均已删除，`REPLAY_*` 消息、`ReplayRun`/`ReplayResult` 类型、`replayProgress` storage item 也一并清理。

### 功能二：MCP 服务（供 agent 读取录制）（已完成第一期）

设置页有一个 **MCP 服务** 开关（+ 端口输入，默认 8787）。开启后，扩展 background 作为
**WebSocket 客户端**主动连到本地 MCP 服务（`packages/mcp`）。`packages/mcp` 是一个 Node
进程，既用 **stdio 跑标准 MCP 协议**给 agent，又在 `ws://127.0.0.1:<port>` 上**跑本地 WS
服务端**等扩展连入。agent 调用 MCP 工具 → 服务转成 `rpc` 帧发给扩展 → 扩展读 IndexedDB →
回 `rpc-result`（按 id 关联）。第一期工具：`list_recordings` / `get_recording` / `get_call`。

> **为什么 socket 方向是「扩展连出、mcp 当服务端」**：MV3 service worker **不能监听端口/开
> WS 服务端**，只能当客户端。所以把 WS 服务端放 `packages/mcp`，扩展开关只控制是否连出。
> 这是 Chrome 扩展 ↔ agent 桥接的通行做法（ivoglent/Browser-Bridge/ypresto 皆如此）。

### 功能三：沙箱代理（agent 经插件转发调用，注入 cookie）（已完成第一期）

反过来用 MCP：给 agent 一个 **`proxy_fetch`** 工具，agent 只发 `method/url/headers/body`（**不带任何凭证**），
由扩展在转发时**注入用户浏览器 cookie**（`chrome.cookies.getAll` + `declarativeNetRequest` 动态会话规则把
`Cookie` 头注入本次请求，**无需打开标签页**），从而 **cookie 不暴露给 AI**。关卡：**人在环确认**
（MCP 工具的原生权限提示 `requiresUserInteraction`，每次调用都强制弹窗，连 auto/bypass 模式也绕不过——这是主闸门，
见 memory [[gateway-human-in-loop]]）→ **SSRF 防护**（`lib/gateway/authorize.ts` 的 `isBlockedHost` 拒绝
loopback/私网/link-local，含 `169.254.169.254` 云元数据，agent 与脚本两条路径都拦）→ **注入+转发** → **审计日志**
（IndexedDB，cookie 只记名字不记值）。扩展侧还有 **per-tool kill switch**（`lib/mcp/handlers.ts` + 设置里按工具开关）。
脚本代理（proxy rule）这条无 agent、无原生弹窗，鉴权靠「规则存在且 enabled」，`enabled` 是人类专属开关，agent 结构性改不动
（`ProxyRuleContentPatch` 不含该字段）。侧栏「沙箱代理」标签页看审计日志 / 管代理规则。

> **为什么 cookie 注入走 DNR 而非 `credentials:'include'`**：MV3 service worker 的 `fetch` 对目标站是跨站，
> `SameSite=Lax/Strict` 的会话 cookie 会被浏览器拦掉；且 `fetch` 不能设 `Cookie` 头（forbidden header）。
> 故用 `chrome.cookies` 读值（含 HttpOnly）+ DNR `modifyHeaders` 在网络层注入。代价：cookie 值流经扩展，
> 但**永不到 AI**（核心诉求满足）。相关模块集中在 `lib/gateway/`。

## 技术栈

| 领域     | 选型                                          | 说明                                                 |
| -------- | --------------------------------------------- | ---------------------------------------------------- |
| 扩展框架 | **WXT 0.21**                                  | 文件约定式入口，自动生成 manifest，跨浏览器          |
| UI 框架  | **React 19 + TypeScript**                     |                                                      |
| 组件库   | **Ant Design v6** (+ `@ant-design/icons`)     | 原生支持 React 19，**不需要** v5-patch-for-react-19  |
| 样式     | **Tailwind CSS v4**                           | 仅留工具类；**preflight 已禁用**（避免与 antd 冲突） |
| 存储     | **IndexedDB** + `chrome.storage`(WXT storage) | 录制载荷放 IDB；开关/设置放 storage                  |
| 包管理   | **pnpm 11** / Node 24                         |                                                      |

## 常用命令

本仓库是 **pnpm workspace（monorepo）**。下列命令在**仓库根目录**运行，会自动委托到
`packages/extension`（见根 `package.json` 的 `pnpm --filter @manta-action-kit/extension ...`）：

```bash
pnpm dev            # 启动开发（自动加载扩展的临时 Chrome + 热重载）
pnpm dev:firefox    # Firefox 开发
pnpm build          # 生产构建 -> packages/extension/.output/chrome-mv3/
pnpm zip            # 打包成可上架 zip
pnpm compile        # 递归所有包做类型检查 (pnpm -r compile)
pnpm build:mcp      # 构建 MCP 服务 -> packages/mcp/dist/
pnpm start:mcp      # 运行 MCP 服务（stdio + 本地 WS bridge）
```

也可以进包里单独跑：`pnpm --filter @manta-action-kit/extension <script>`，或 `cd packages/extension && pnpm <script>`。

**手动装到自己的 Chrome**：`chrome://extensions` → 开发者模式 → 加载已解压 → 选 `packages/extension/.output/chrome-mv3/`。

改完代码后：`pnpm dev` 一般自动重载；偶尔 content/background 不生效就在 `chrome://extensions` 点刷新 ↻。

## 目录结构

仓库为 monorepo，顶层：

```
packages/
├─ extension/     # 当前 Chrome 扩展实现（下方详列）
└─ mcp/           # MCP 服务：给 agent 暴露「读取接口录制」工具，经本地 WS 与扩展联动
package.json          # 工作区根：私有，脚本委托到各包
pnpm-workspace.yaml   # packages: ['packages/*'] + onlyBuiltDependencies + verifyDepsBeforeRun:false
pnpm-lock.yaml        # 单一锁文件（整个工作区）
CLAUDE.md · README.md # 仓库级文档
```

`packages/extension/` 内部（WXT 项目根）：

```
entrypoints/                    # WXT 约定：每个文件/子目录 = 一个扩展入口，自动写入 manifest
├─ background.ts                # MV3 service worker：消息中枢 + 录制会话 + 网关编排
├─ injected-api-hook.ts         # MAIN world 注入脚本：patch fetch/XHR 捕获调用
├─ popup/                       # 工具栏弹窗（录制开关、快速入口）
│  ├─ index.html · main.tsx · app.tsx
├─ sidepanel/                   # 侧边栏（Tabs 切功能 + 右侧设置齿轮）
│  ├─ index.html · main.tsx · app.tsx
└─ content/                     # content script（ISOLATED）：注入 hook + 中继捕获 + 页内工具条
   ├─ index.tsx · toolbar.tsx

components/
├─ app-providers.tsx            # antd ConfigProvider(主题+zhCN+App) 统一包装，popup/sidepanel 共用
├─ settings.tsx                 # 设置页（启用开关、主题切换）
└─ recording/
   ├─ api-recording-feature.tsx # “接口录制”功能：列表↔详情，自包含（塞进侧边栏标签页）
   ├─ recording-list.tsx        # 列表：改名(行内)/删除/进详情/空态
   ├─ recording-detail.tsx      # 详情：Timeline 调用链路 + 接口契约
   ├─ call-node.tsx             # 单个调用节点（Collapse 展开请求/响应）
   └─ method-badge.tsx          # HTTP method / 状态码 Tag 徽章

lib/
├─ db.ts                        # IndexedDB 封装（无三方依赖）：recordings + calls 两个 store
├─ storage.ts                   # WXT storage items（settings.enabled/theme、recordingState、toolbarState）
├─ messaging.ts                 # 类型化消息协议（ProtocolMap 为单一数据源）
├─ utils.ts                     # helpers：uuid / originOf / shortPath / formatTime / prettyJson / cn
└─ recording/
   ├─ types.ts                  # 领域类型单一数据源（ApiCall/Recording/RecordingState/...）
   └─ session.ts                # 录制状态机（background 内运行）+ 只录 API 的过滤

hooks/
├─ use-recording-state.ts       # 响应式读取实时录制状态
├─ use-recordings.ts            # 读 IDB 列表 + 改名/删除
└─ use-storage.ts               # 通用 storage-item ↔ React state（脚手架保留）

assets/tailwind.css             # Tailwind 入口（禁 preflight）+ 品牌 token
public/icon/                    # 图标 16/32/48/96/128
wxt.config.ts                   # manifest、权限、web_accessible_resources、Tailwind 插件
package.json · tsconfig.json    # 扩展包自己的依赖与 TS 配置
```

## 架构 / 数据流（功能一）

```
[injected-api-hook.ts]  MAIN world，patch window.fetch + XMLHttpRequest
        │  CustomEvent('manta-action-kit:api-call') 在 script 元素上派发
        ▼
[content/index.tsx]  ISOLATED world，document_start 注入 hook；监听事件 → sendMessage
        │  runtime.sendMessage('API_CALL_CAPTURED')
        ▼
[background.ts]  录制状态机(session.ts)：按 tab 累积、只录 API、停止时落库
        │
        ▼
[IndexedDB]  lib/db.ts（recordings 元数据 + calls 载荷）
        ▲
        │  读取/改名/删除
[popup]  开关+计数        [sidepanel]  Tabs → ApiRecordingFeature（列表/详情）
```

**为什么录制状态放 background**：录制要跨页面跳转/刷新、popup 关闭后继续，所以开关状态存 `storage.session:recordingState`（抗 MV3 service worker 休眠），调用缓冲在 background 内存中累积，停止时一次性写 IndexedDB。

## 关键约定（改代码前必读）

- **加扩展入口**：在 `entrypoints/` 下建文件/目录即可，WXT 自动写入 manifest，**别手改 manifest**。
- **加侧边栏功能标签页**：在 `entrypoints/sidepanel/app.tsx` 的 `FEATURES` 数组加一项 + 对应内容组件；设置齿轮逻辑已固定，无需动。
- **消息通信**：所有跨上下文消息在 `lib/messaging.ts` 的 `ProtocolMap` 里加类型，再用 `sendMessage(type, data)`（返回类型自动推导）。`Message` 是判别联合，background 里 `switch(msg.type)` 可正确窄化。
- **存储**：
  - 结构化偏好/开关 → `lib/storage.ts` 定义 WXT storage item，React 里用对应 hook 读（响应式，跨上下文自动同步）。
  - 录制这种大体积数据 → IndexedDB（`lib/db.ts`）。
- **领域类型**：全部在 `lib/recording/types.ts`，injected/background/UI 共用，改数据结构从这里改。
- **UI 用 antd**：新组件优先用 antd；用 `App.useApp()` 拿 `message`/`modal`（已被 `AppProviders` 包裹）。主题跟随 `settings.theme`。
- **MAIN world 注入脚本**（`injected-api-hook.ts`）：跑在页面上下文，**不能** import 扩展 API，只能 import 纯类型/常量；必须登记在 `wxt.config.ts` 的 `web_accessible_resources`。
- **文件命名**：所有文件一律用**小写 kebab-case**（如 `app-providers.tsx`、`use-recordings.ts`、`api-recording-feature.tsx`），入口文件也是小写（`app.tsx`）。**注意区分文件名与代码标识符**：导出的组件/hook 名保持各自约定——React 组件用 PascalCase（`AppProviders`）、hook 用 camelCase（`useRecordings`），只有**文件名**统一小写。
- **路径别名**：`@/` 指向项目根，如 `@/lib/db`。

## 权限（wxt.config.ts）

`storage` `sidePanel` `scripting` `tabs` `cookies` `declarativeNetRequestWithHostAccess` `alarms` + `host_permissions: ['<all_urls>']`（注入 hook 与网关 cookie 转发需要）。`web_accessible_resources` 登记了 `injected-api-hook.js`。（`activeTab`/`downloads`/`notifications` 已移除：无代码使用，会被商店审核以「未用权限」打回。）

## 构建环境注意事项

- `pnpm-workspace.yaml` 里 `verifyDepsBeforeRun: false`：pnpm 11 会在每次 `pnpm run` 前做依赖检查，因为一些用不到的传递性原生依赖（测试驱动等）未构建而报非零退出——这里关掉该冗余检查。`onlyBuiltDependencies` 只放行 `esbuild`、`@parcel/watcher`。
- `action.default_title` 会被 popup 的 `<title>` 覆盖，改扩展显示名要同时改 `wxt.config.ts` 和两个 `index.html` 的 `<title>`。
- antd 的 CSS-in-JS 走 `<style>` 注入，MV3 只禁内联 script 不禁 style，扩展页面正常渲染。

## 已知取舍 / 待办

- 捕获只覆盖 **fetch/XHR**；WebSocket、sendBeacon、页面 worker 内请求抓不到（符合“API 调用”定位；将来要全量再叠加 `chrome.debugger`）。原生 `EventSource` 也**未**拦截——目标场景的 SSE 走的是 fetch+流，将来遇到真用 EventSource 的站再补。
- **SSE（`text/event-stream`）流式录制**：注入 hook 检测到流式响应时，用 `res.body.tee()` 把响应体分成两条独立流——一条经 `rebuildResponse()` 重建成新 `Response` 交还页面，另一条自己后台读、增量解析成 `sseEvents` 事件序列（见 `lib/sse-parse.ts`，注入 hook 与网关 `lib/gateway/run.ts` 共用同一解析器）。
  - **为什么用 `tee()` 不用 `res.clone()`**：clone 分支的生命周期绑在原 response 上，页面读到终止事件后 abort 原响应会把 clone 一起掐断，只能录到开头几个事件；tee 的两条流互相独立，页面 abort 自己那条不影响我们，才能录全（thinking→message→chat_final）。
  - **重建 Response 的属性补偿**：`new Response(stream, init)` 只接受 `status/statusText/headers`，会丢 `url/redirected/type/ok`；`rebuildResponse()` 先用 `Object.defineProperty` 补回，引擎不允许时降级用 `Proxy` 透传，让页面几乎无法区分。
  - **不破坏页面**：整个 tee+重建包在 try/catch，任何一步失败就原样返回原 `res`（退化成“这条流不录”，但绝不破坏页面）；只对 `text/event-stream` 生效，普通响应完全不碰。
  - **收尾靠 idle 超时**：多数 SSE 流服务端不主动关闭（靠客户端读到终止事件后自行断开），所以 drain 用“无字节 N 秒即结束”的 idle 竞速兜底（注入 hook 侧 3s；网关 `drainSse` 侧 8s + 115s 总上限），否则 `reader.read()` 会一直挂。
- 引入 antd 后共享 chunk 约 629 kB（本地加载，可接受）；popup 也加载完整 antd，若要瘦身可做按需分包。

## 验证

改动后至少跑 `pnpm compile`（0 类型错误）+ `pnpm test`（vitest 单测，覆盖 `lib/gateway/proxy-rule`、`lib/recording/{schema,redact,aggregate}`、`lib/sse-parse` 等纯模块）+ `pnpm build`（产出 MV3 包）。端到端：`pnpm dev` → 打开有接口的页面 → popup 开始录制 → 操作 → 结束 → 侧边栏看记录 → 进详情看链路与接口契约。
