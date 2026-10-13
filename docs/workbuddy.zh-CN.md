# 在 WorkBuddy 中使用 Manta Action Kit

[English](workbuddy.md) | **中文**

本文说明如何在 [WorkBuddy](https://www.workbuddy.cn)（腾讯出品的 AI 工作台）里
安装并使用 Manta Action Kit。

WorkBuddy 和其他 MCP 客户端（Claude Code、Codex）一样：通过 stdio 启动同一个
`@manta-action-kit/mcp` 服务、连接同一个本地回环桥接，因此
[`packages/mcp/README.md`](../packages/mcp/README.md) 里描述的所有工具与安全
特性完全适用。只有两点不同：

1. WorkBuddy 从 **`~/.workbuddy/mcp.json`**（全局）读取 MCP 服务配置。
2. 只把条目写进这个文件**还不够** —— 新增的服务在你于连接器界面里显式
   **信任**之前不会启动（见第 3 步）。

> 注意文件名是 `mcp.json`，**不是** `.mcp.json`。写到带点号的那个路径会被
> 静默忽略。

## 前置要求

- **Chrome** 且已安装 Manta Action Kit 扩展，并已在目标站点登录。
- PATH 里有 **Node.js ≥ 18**（服务通过 `npx` 运行）。
- **WorkBuddy** 桌面端。

## 第 1 步 —— 安装扩展并复制桥接 token

和其他客户端完全一致：点击扩展工具栏图标 →「打开侧边栏」→ **Action** 标签页
→ **复制安装提示词**。提示词里嵌着你的专属 `MANTA_TOKEN` 与当前桥接端口，先留
着给第 2 步用。

## 第 2 步 —— 注册 MCP 服务

打开 `~/.workbuddy/mcp.json`，把下面这段**合并**进已有的 `mcpServers` 对象
（不要整文件覆盖——里面可能已经配了别的服务）：

```json
{
  "mcpServers": {
    "manta-action-kit": {
      "type": "stdio",
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

如果改用本地仓库的构建产物而不是已发布的包：

```jsonc
{
  "mcpServers": {
    "manta-action-kit": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/manta-action-kit/packages/mcp/dist/index.js"],
      "env": {
        "MANTA_WS_PORT": "8787",
        "MANTA_PROXY_PORT": "8788",
        "MANTA_TOKEN": "<来自扩展>",
      },
    },
  },
}
```

`MANTA_TOKEN` 必须与扩展一致（它是握手密钥）；`MANTA_WS_PORT`（默认 8787）
需与扩展设置里的 MCP 端口一致。保持默认值时端口变量可以省略。

**和其他客户端共用端口没问题。** WorkBuddy 与 Claude Code 可以同时注册这个
服务——每个 MCP 进程都会竞争 8787，抢到的成为 **owner**（托管桥接 + 代理），
没抢到的降级为 **peer**，把工具调用转发给 owner。owner 退出后 peer 会重新选举
接管，无需手动重启。用 `health` 工具可以查询当前角色。

## 第 3 步 —— 信任该服务（必需，最容易漏）

改 JSON 只是「声明」了这个服务。在你批准之前，WorkBuddy 不会启动进程，也不会
暴露任何工具：

1. 打开 WorkBuddy 的**连接器管理**页面。
2. 点击该页面**右上角**的**「自定义连接器」**入口。
3. 在列表里找到 `manta-action-kit`，点击「**信任**」。

WorkBuddy 会把授权记录在 `~/.workbuddy/mcp-approvals.json`，随后启动服务，其
工具即可在对话中使用（内部名形如 `mcp__manta-action-kit__<tool>`）。

如果你之后修改了该条目的 command / args / env，需要重新信任或新开一个会话才会
生效。

## 第 4 步 ——（可选）安装 agent skill

skill 是一份随用随加载的使用指南，装上之后 agent 听到「检查环境」「连不上」
「有哪些 action」这类话就能直接自查，不需要你额外解释。它是可选的——MCP 服务
才是 agent 必需的。

WorkBuddy 会从 `~/.workbuddy/skills/`（对所有项目生效）和
`<工作区>/.workbuddy/skills/`（仅对该工作区生效）发现个人与项目级 skill：

```bash
npx skills add marrviin/manta-action-kit -y   # 交互式安装：选 WorkBuddy + 作用域
```

> `scripts/check-env.mjs` 需要 **Node ≥ 18**。它会自动判断自己是否在仓库内：
> 装在仓库之外的副本会跳过「构建产物」检查（服务端直接跑已发布的 npx 包），
> 并主动探测 WorkBuddy 的 `~/.workbuddy/mcp.json` 来确认注册状态。

## 第 5 步 —— 用起来

在站点上录一段流程、信任一次服务，然后直接对 WorkBuddy 说话：

> _"我刚录了会议室预订的流程。把它变成一个 action，帮我订明天 10 点的 A 会议室。"_

想确认链路是否通，可以让 agent 做一次环境检查，或者直接调一个只读工具（比如
`list_recordings`）——返回空列表也说明链路是通的（只是还没录过东西）。

> `list_recordings` 返回的不只是元数据，还带每条录制的依赖、用户交互与字段动态
> 性标记，因此返回体可能很大（几十条录制时可达数百 KB）。如果客户端因此截断
> 输出，就收窄请求——一次只处理一条录制，用 `get_flow` / `get_endpoints`。

## 常用说法 → 工具

| 你说                           | 工具                                           |
| ------------------------------ | ---------------------------------------------- |
| 查录制 / 列出我录过什么        | `list_recordings`                              |
| 看调用链路 / 字段从哪来        | `get_recording` · `get_flow` · `get_endpoints` |
| 把这段录制变成 action / 可复用 | `create_action`                                |
| 执行那个 action / 跑一遍       | `execute_action`                               |
| 用我的登录态调这个接口         | `proxy_fetch` · `proxy_sse`                    |
| 截个图 / 整页截图              | `capture_screenshot`                           |
| 把页面上的元素序列化出来       | `capture_element`                              |

每次 `proxy_fetch` / `proxy_sse` / `execute_action` 仍然会经过扩展自身的确认
弹窗，与其他客户端完全一致。

## 排障

| 症状                                             | 原因                                         | 处理                                                                 |
| ------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------- |
| 对话里完全没有 `manta-*` 工具                    | 配置写好了但从未信任                         | 见第 3 步，在「自定义连接器」入口里信任                              |
| 信任后仍然没有                                   | 配置写到了 `~/.workbuddy/.mcp.json`（带点）  | 改用 `~/.workbuddy/mcp.json`                                         |
| 报 `No authenticated Chrome extension connected` | Chrome 没开 / 扩展没加载 / 端口或 token 漂移 | 打开装有扩展的 Chrome，确认端口为 8787，重新复制安装提示词更新 token |
| 报 `MCP bridge has no MANTA_TOKEN configured`    | `env` 里缺 token                             | 重新复制安装提示词，更新 `env.MANTA_TOKEN`                           |
| 报 `RPC "…" timed out`                           | 扩展 service worker 休眠或刚重载             | 点一下扩展侧边栏唤醒，再重试                                         |
| Claude Code 里能用，但这里提示端口被占           | 8787 已被另一个客户端占用                    | 属预期行为——WorkBuddy 会以 peer 身份运行；用 `health` 查看角色       |

## 与 Claude Code 的差异一览

| 关注点       | Claude Code                                       | WorkBuddy                                               |
| ------------ | ------------------------------------------------- | ------------------------------------------------------- |
| MCP 配置位置 | `~/.claude.json` / `.mcp.json` / `claude mcp add` | `~/.workbuddy/mcp.json`                                 |
| 生效方式     | 注册即可                                          | 注册 **+ 在连接器界面里信任**                           |
| skill 目录   | `~/.claude/skills/`                               | `~/.workbuddy/skills/` 或 `<工作区>/.workbuddy/skills/` |
| 列出服务     | `claude mcp list`                                 | 连接器管理页面                                          |
