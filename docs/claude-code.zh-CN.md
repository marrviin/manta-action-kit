# 在 Claude Code 中使用 Manta Action Kit

[English](claude-code.md) | **中文**

本文说明如何在 [Claude Code](https://claude.com/claude-code) 里安装并使用
Manta Action Kit。

Claude Code 是本套件对标的标准 MCP 客户端：通过 stdio 启动同一个
`@manta-action-kit/mcp` 服务、连接同一个本地回环桥接，因此
[`packages/mcp/README.md`](../packages/mcp/README.md) 里描述的所有工具与安全
特性完全适用。只有两点是 Claude Code 特有的：

1. 服务通过 **`claude mcp add`** 命令（或项目根目录的 `.mcp.json`）注册，
   而不是手改配置文件。
2. 注册即生效——不像 WorkBuddy 还要在界面里额外「信任」一步。新会话或
   `/mcp` 重连后工具即可用。

## 前置要求

- **Chrome** 且已安装 Manta Action Kit 扩展，并已在目标站点登录。
- PATH 里有 **Node.js ≥ 18**（服务通过 `npx` 运行）。
- **Claude Code** CLI。

## 第 1 步 —— 安装扩展并复制桥接 token

和其他客户端完全一致：点击扩展工具栏图标 →「打开侧边栏」→ **Action** 标签页
→ **复制安装提示词**。提示词里嵌着你的专属 `MANTA_TOKEN` 与当前桥接端口，先留
着给第 2 步用。工具栏看不到图标？Chrome 会把新装的扩展折叠进地址栏旁的拼图
菜单——点开它，把 Manta Action Kit 图钉固定即可。

## 第 2 步 —— 注册 MCP 服务

最省事的做法：把第 1 步复制的安装提示词粘贴给 Claude Code——提示词里列着
服务的 name/command/args/env，Claude Code 会自动把它注册进自己的配置。

也可以手动执行。**生产**（已发布的包）：

```bash
claude mcp add manta-action-kit \
  --env MANTA_TOKEN=<从扩展复制的 token> \
  -- npx -y @manta-action-kit/mcp
```

**开发**（本地仓库——先用 `pnpm build:mcp` 构建）：

```bash
claude mcp add manta-action-kit \
  --env MANTA_TOKEN=<从扩展复制的 token> \
  -- node "$(pwd)/packages/mcp/dist/index.js"
```

`MANTA_TOKEN` 必须与扩展一致（它是握手密钥）；`MANTA_WS_PORT`（默认 8787）
需与扩展设置里的 MCP 端口一致。代理端口（`MANTA_PROXY_PORT`，默认 8788）
同样只在改过默认值时才需要设置。保持默认值时端口变量可以省略。

**选对作用域（scope）。** `claude mcp add` 默认注册为 `local`——仅当前项目
可用，存在 `~/.claude.json` 里，且只有你自己可见。其他选择：

| 作用域    | 参数              | 存储位置                 | 可见范围                 |
| --------- | ----------------- | ------------------------ | ------------------------ |
| `local`   | （默认）          | `~/.claude.json`         | 仅自己，仅当前项目       |
| `project` | `--scope project` | 仓库根目录的 `.mcp.json` | 所有 checkout 该仓库的人 |
| `user`    | `--scope user`    | `~/.claude.json`         | 仅自己，所有项目         |

想给团队共用配置就选 `--scope project` 把配置提交进仓库（每个人仍需替换成
自己的 `MANTA_TOKEN`——它是个人专属的）；想让服务在所有项目可用就选
`--scope user`。也可以直接编辑 `~/.claude.json` 或 `.mcp.json`，把下面这段
**合并**进已有的 `mcpServers` 对象（不要整文件覆盖——里面可能已经配了别的
服务）。⚠️ 这两个文件是**严格 JSON**——不能带注释和尾逗号，下面这段可以
直接照抄：

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

**和其他客户端共用端口没问题。** Claude Code 与 WorkBuddy 可以同时注册这个
服务——每个 MCP 进程都会竞争 8787，抢到的成为 **owner**（托管桥接 + 代理），
没抢到的降级为 **peer**，把工具调用转发给 owner。owner 退出后 peer 会重新选举
接管，无需手动重启。用 `health` 工具可以查询当前角色。

## 第 3 步 —— 验证

注册即生效，没有审批环节。确认服务能启动：

```bash
claude mcp list                     # 应看到 manta-action-kit ✔ Connected
claude mcp get manta-action-kit     # 查看 command、args 与 env 块
```

在 Claude Code 会话里，`/mcp` 显示实时连接状态（改完配置后用它重连），
`health` 工具报告桥接与扩展状态。工具的内部名形如
`mcp__manta-action-kit__<tool>`。

## 第 4 步 ——（可选）安装 agent skill

skill 是一份随用随加载的使用指南，装上之后 agent 听到「检查环境」「连不上」
「有哪些 action」这类话就能直接自查，不需要你额外解释。它是可选的——MCP 服务
才是 agent 必需的。

```bash
npx skills add marrviin/manta-action-kit -g -a claude-code -y   # 全局
```

去掉 `-g -a claude-code -y` 则进入交互安装（可选任意支持的 agent 与项目/全局
作用域）。之后重跑同一命令或 `npx skills update -g` 即可更新。手动等价做法——
Claude Code 从 `~/.claude/skills/`（对所有项目生效）和
`<仓库>/.claude/skills/`（仅对该仓库生效）发现 skill：把
`packages/skills/manta-action-kit/` 整个目录复制过去即可。

> `scripts/check-env.mjs` 需要 **Node ≥ 18**。它会自动判断自己是否在仓库内：
> 装在仓库之外的副本会跳过「构建产物」检查（服务端直接跑已发布的 npx 包），
> 并通过 `claude` CLI 探测注册状态。

## 第 5 步 —— 用起来

在站点上录一段流程、注册一次服务，然后直接对 Claude Code 说话：

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

扩展自己对连接状态的展示在侧边栏的**「设置」标签页 → 「连接器」卡片**。
一切正常时的样子：绿色 **Connected** 标签 + MCP 服务版本号（版本号旁出现
黄色提示说明扩展与 MCP 服务版本不配套）。其余状态：_Connecting_（连接中）、
_Disconnected_（服务没在跑或端口不对）、_Auth failed_（token 不一致——
重新复制安装提示词更新配置）。

| 症状                                             | 原因                                                       | 处理                                                                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 对话里没有 `manta-*` 工具                        | 服务是会话开始后才注册的                                   | `/mcp` 重连，或重启会话                                                                                                                     |
| `claude mcp list` 显示 `✘ Failed to connect`     | dist 未构建（本地构建）                                    | `pnpm build:mcp` 后重试                                                                                                                     |
| 报 `command not found: npx` / `node`             | 没装 Node.js（或不在 PATH 里）                             | 去 [nodejs.org](https://nodejs.org) 装 Node ≥ 18，`node -v` 验证后重试                                                                      |
| 8787 被无关进程占用                              | 端口冲突——但会自愈                                         | 无需处理：服务自动向上扫描 32 个端口认领空闲端口，扩展约 20–30 秒内自动跟上（stderr 会打印 `Bridge on ws://127.0.0.1:<port> (fallback …)`） |
| 报 `No authenticated Chrome extension connected` | Chrome 没开 / 扩展没加载 / 端口或 token 漂移               | 打开装有扩展的 Chrome，确认端口为 8787，重新复制安装提示词更新 token                                                                        |
| 报 `MCP bridge has no MANTA_TOKEN configured`    | `env` 里缺 token                                           | 重新复制安装提示词，重新执行 `claude mcp add` 更新                                                                                          |
| 报 `RPC "…" timed out`                           | 扩展 service worker 休眠或刚重载                           | 点一下扩展侧边栏唤醒，再重试                                                                                                                |
| 调用一直卡住，但没看到确认弹窗                   | 确认弹窗被别的窗口挡住，或被 Chrome 折叠进「被隐藏的通知」 | 把 Chrome 切到前台，查看扩展是否有待确认的请求                                                                                              |
| 在某个 Chrome profile 里好使、另一个里失灵       | 扩展（及其登录态）是按 profile 隔离的                      | 用装了扩展并已登录的那个 profile 启动 Chrome                                                                                                |
| WorkBuddy 里能用，但这里提示端口被占             | 8787 已被另一个客户端占用                                  | 属预期行为——本进程会以 peer 身份运行；用 `health` 查看角色                                                                                  |

## 与 WorkBuddy 的差异一览

| 关注点       | Claude Code                                       | WorkBuddy                                               |
| ------------ | ------------------------------------------------- | ------------------------------------------------------- |
| MCP 配置位置 | `~/.claude.json` / `.mcp.json` / `claude mcp add` | `~/.workbuddy/mcp.json`                                 |
| 生效方式     | 注册即可                                          | 注册 **+ 在连接器界面里信任**                           |
| skill 目录   | `~/.claude/skills/`                               | `~/.workbuddy/skills/` 或 `<工作区>/.workbuddy/skills/` |
| 列出服务     | `claude mcp list`                                 | 连接器管理页面                                          |
