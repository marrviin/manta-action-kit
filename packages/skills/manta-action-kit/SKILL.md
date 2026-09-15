---
name: manta-action-kit
description: manta-action-kit 套件（Chrome 扩展 + MCP server）的使用指南：环境检查与初始化、扩展/MCP/连接状态排查、读取接口录制、cookie 注入代理转发。「manta」「查录制」「看调用链」「用我的登录态调接口」「proxy_fetch」「环境检查」「初始化环境」「连不上」等说法时使用。
---

# manta-action-kit 套件使用指南

本套件由两部分组成，协作方式见仓库根 `CLAUDE.md`：

- **Chrome 扩展**（`packages/extension`）：录制页面 API 调用（IndexedDB 存储）；作为 MCP 桥（MV3
  service worker 只能当 WS 客户端，主动连出到本地 MCP 进程）；沙箱代理网关（转发时注入 cookie，cookie 永不暴露给 agent）。
- **MCP server**（`packages/mcp`，stdio）：本文件的工具提供方。工具名前缀 `mcp__manta-action-kit__`。
  用户口中的 **「manta」是它的短别名**。

## 一、环境检查（用户说「检查环境 / 初始化 / 连不上 / 排查」时按序执行）

**先跑自带脚本（一条命令覆盖全部检查项，逐项输出 ✅/❌ 与修复建议）：**

```bash
node packages/skills/manta-action-kit/scripts/check-env.mjs
```

脚本覆盖下面 1–3 步（含以 peer 身份做端到端探活，能区分「桥在但扩展没连」与「全链路通」）。
退出码 0 = 全过。**有 ❌ 的项再按下面的手动步骤深挖修复**，修完复跑脚本确认。

四项依次检查，**每项给出通过判据与修复动作**，逐项报告结果而不是只报最终结论。

### 1. MCP server 已注册且可启动

```bash
claude mcp list 2>/dev/null | grep manta-action-kit
```

- ✅ 通过：输出含 `✔ Connected`。
- ❌ 未出现该行 → 注册（在本仓库根目录）：

  ```bash
  pnpm build:mcp   # 先确保 dist 存在，见第 2 步
  claude mcp add manta-action-kit --scope local -- node "$(pwd)/packages/mcp/dist/index.js"
  ```

  然后让用户执行 `/mcp` reconnect 或重启会话。
- ❌ `✘ Failed to connect` → 先看第 2 步（dist 缺失 / 端口被占）。

### 2. dist 已构建

```bash
test -f packages/mcp/dist/index.js && echo OK
```

- ❌ 缺失 → `pnpm build:mcp`。
- 若启动即 fatal 报端口冲突（`MANTA_WS_PORT (8787)` 相关），查占用：
  `lsof -nP -iTCP:8787 -sTCP:LISTEN`（代理端口同理查 8788）。进程残留就 kill，
  或改用空闲端口：注册时加 `--env MANTA_WS_PORT=<port>`，并同步改扩展设置页端口。

### 3. 扩展在线、WS 已连（用工具探活，最便宜的是 `list_recordings`）

直接调用 `mcp__manta-action-kit__list_recordings`（探活探错，不关心返回内容）：

- ✅ 通过：返回 JSON（哪怕空列表）。**空列表 ≠ 故障**，只是还没录过。
- ❌ 报 `No Chrome extension connected. Open the extension (its MCP tab shows the
  connection status) and make sure the configured port matches.` → 依次让用户确认：
  1. Chrome 已打开且加载了本扩展（`chrome://extensions` 开发者模式加载
     `packages/extension/.output/chrome-mv3/`，或 `pnpm dev`）；
  2. 侧边栏 → 设置 → **「MCP 服务」开关已打开**（扩展开关才控制连出）；
  3. 扩展设置页端口与 server 端口一致（默认 8787）。
- ❌ 报 `RPC "..." timed out after ...ms` → 扩展 WS 连着但没响应，多为扩展刚刷新 /
  service worker 休眠，让用户点一下扩展侧边栏唤醒后重试。

### 4. 汇总报告

按「✅/❌ + 修复动作（已做 / 需用户手动）」输出清单。**需要用户在 Chrome 里点开关、
在弹窗里确认这类动作，明确指出来让用户做，agent 不要空转重试。**

## 二、全新环境初始化（用户说「新机器装一下 / 初始化环境」时）

按序执行，前两步是仓库构建，后两步是用户侧操作：

1. `pnpm install && pnpm build && pnpm build:mcp`（扩展产物在
   `packages/extension/.output/chrome-mv3/`，MCP 产物在 `packages/mcp/dist/`）。
2. 注册 MCP server（上面第 1 步的 `claude mcp add` 命令）。
3. 指导用户：Chrome → `chrome://extensions` → 开发者模式 → 加载已解压 → 选
   `packages/extension/.output/chrome-mv3/`。
4. 指导用户：打开侧边栏 → 设置 → 打开「MCP 服务」开关（端口保持默认 8787）。
5. 跑一遍上面的环境检查（至少第 1、3 项）确认打通。

## 三、功能使用（触发词 → 工具）

用户说这些话时直接调 `mcp__manta-action-kit__<tool>`，**不要追问、不要自己写脚本解析 IndexedDB**：

| 用户说法 | 工具 | 说明 |
| --- | --- | --- |
| 「查录制 / 列出录制 / 我录过哪些接口」 | `list_recordings` | 所有录制元数据 |
| 「看这条录制的调用链 / 完整请求响应」 | `get_recording` | 单条录制 + 全链路 |
| 「分析步骤依赖 / 字段从哪来」 | `get_flow` | 有序步骤 + 推断的字段依赖 |
| 「看接口契约 / 去重后的端点」 | `get_endpoints` | 去重端点 + 脱敏 schema |
| 「看单个调用」 | `get_call` | 按 id 取单个 API call |
| 「用我的登录态调这个接口 / 帮我请求一下」 | `proxy_fetch` | 经扩展注入 cookie 转发 |
| 「拉 SSE / 看流式事件」 | `proxy_sse` | 转发 SSE 并收事件 |

关于 `proxy_fetch` / `proxy_sse`：

- 每次调用都会弹 **原生确认框**（MCP `requiresUserInteraction`），这是设计上的主闸门，
  auto/bypass 模式也绕不过——提示用户点允许即可，不是故障。
- cookie 只在扩展内部注入，**永远不会出现在工具返回里**；把响应转述给用户即可。
- 环回/私网/云元数据地址（含 169.254.169.254）会被 SSRF 防护拒绝，属预期拦截。

## 四、调试工作流（改 `packages/mcp` 源码时）

- `pnpm dev:mcp` —— tsc --watch 实时编译 dist。**不会热重启已运行的 MCP 进程**：
  改完代码让用户 `/mcp` reconnect 该 server，或重启会话。
- `pnpm start:mcp` —— 手动跑一次看启动日志（stdio + WS 桥）。
- 扩展侧：`pnpm dev` 加载开发版扩展；改扩展代码后偶尔需在 `chrome://extensions` 点刷新 ↻。

## 五、故障速查

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| `claude mcp list` 无此 server 或 ✘ | 未注册 / dist 缺失 | 第一节第 1、2 步 |
| 工具报 `No Chrome extension connected` | Chrome 没开 / 开关没开 / 端口不一致 | 第一节第 3 步三项 |
| 工具报 `RPC ... timed out` | service worker 休眠 / 刚刷新 | 唤醒扩展后重试 |
| 启动 fatal：端口冲突 | 8787/8788 被占 | `lsof -nP -iTCP:<port>` 查占，kill 或换端口（两端同步改） |
| 改了源码不生效 | tsc watch 不热重启 | `/mcp` reconnect 或重启会话 |

## 六、仓库上下文

- 架构、设计取舍、消息协议见根 `CLAUDE.md`（功能一/二/三）。
- MCP 源码：`packages/mcp/src/`（`index.ts` 工具定义、`bridge.ts` WS 桥与报错文案、
  `protocol.ts` 帧协议与端口常量 8787/8788）。
- 扩展源码：`packages/extension/`（`lib/gateway/` 网关、`lib/mcp/handlers.ts` 按工具开关）。
