# 在 JoyCode 中使用 Manta Action Kit

[English](joycode.md) | **中文**

本文说明如何在 [JoyCode](https://joycode.com)（内置 MCP 客户端的智能编程
IDE）里安装并使用 Manta Action Kit。

JoyCode 和其他 MCP 客户端（Claude Code、WorkBuddy）一样：通过 stdio 启动
同一个 `@manta-action-kit/mcp` 服务、连接同一个本地回环桥接，因此
[`packages/mcp/README.md`](../packages/mcp/README.md) 里描述的所有工具与
安全特性完全适用。只有两点是 JoyCode 特有的：

1. JoyCode 从 **`~/.joycode/joycode-mcp.json`** 读取 MCP 服务配置（需要手动
   编辑——JoyCode 没有 `claude mcp add` 这样的 CLI）。
2. 注册即**生效** —— 和 Claude Code 一样，没有额外的「信任」步骤。保存文件、
   重启 JoyCode（或新开一个会话），工具就会出现。

> 注意文件名是 `joycode-mcp.json` —— 开头没有点号，也不叫 `mcp.json`。
> 配置写到错误的路径会被静默忽略。

## 前置要求

- **Chrome** 且已安装 Manta Action Kit 扩展，并已在目标站点登录。
- PATH 里有 **Node.js ≥ 18**（服务通过 `npx` 运行）。
- **JoyCode** 桌面端。

## 第 1 步 —— 安装扩展并复制桥接 token

和其他客户端完全一致：点击扩展工具栏图标 →「打开侧边栏」→ **Action** 标签页
→ **复制安装提示词**。提示词里嵌着你的专属 `MANTA_TOKEN` 与当前桥接端口，先留
着给第 2 步用。

## 第 2 步 —— 注册 MCP 服务

打开 `~/.joycode/joycode-mcp.json`，把下面这段**合并**进已有的 `mcpServers`
对象（不要整文件覆盖——里面可能已经配了别的服务）：

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
      },
      "disabled": false
    }
  }
}
```

如果改用本地仓库的构建产物而不是已发布的包（先 `pnpm build:mcp`）：

```jsonc
{
  "mcpServers": {
    "manta-action-kit": {
      "type": "stdio",
      "command": "node",
      "args": ["/绝对路径/manta-action-kit/packages/mcp/dist/index.js"],
      "env": {
        "MANTA_WS_PORT": "8787",
        "MANTA_PROXY_PORT": "8788",
        "MANTA_TOKEN": "<从扩展复制的 token>",
      },
      "disabled": false,
    },
  },
}
```

`MANTA_TOKEN` 必须与扩展一致（握手密钥）；`MANTA_WS_PORT`（默认 8787）必须与
扩展设置里的 MCP 端口一致。保持默认端口的话可以省略端口变量。

**和其他客户端共用端口没问题。** JoyCode 与 Claude Code 可以同时注册这个
服务——两个 MCP 进程抢 8787 端口，抢到的成为 **owner**（承载桥接 + 代理），
没抢到的降级为 **peer**，把工具调用转发给 owner。owner 退出后 peer 会自动
重新竞选接管，无需手动重启。用 `health` 工具可以看到当前角色。

## 第 3 步 —— 验证

保存文件，重启 JoyCode（或新开会话）让配置生效，然后对 agent 说：

> _"搜索你的 MCP 工具里的 manta-action-kit，运行 `health` 工具。"_

JoyCode 的 agent 会按需发现已连接的 MCP 工具，这句话也是确认服务已启动的
最快方式。`health` 报告桥接和扩展在线即链路可用。再用 `list_recordings`
之类的只读工具验证余下链路——空列表同样说明整条链路是通的（只是还没录制过）。

## 第 4 步 —— （可选）安装 agent skill

skill 是一份按需加载的使用指南，让「检查环境」「连不上」「我有哪些 action」
这类说法不用你解释就能被理解。它是可选的——agent 真正必需的只有 MCP 服务。

JoyCode 从 `~/.joycode/skills/`（对所有项目生效）和
`<工作区>/.joycode/skills/`（仅该工作区）发现 skill。最简单的安装方式是
`npx skills add marrviin/manta-action-kit -y`（按提示选择 JoyCode 与作用域），
或手动把 `packages/skills/manta-action-kit/` 整个目录复制到 skills 目录。

> `scripts/check-env.mjs` 需要 **Node ≥ 18**。它会自动判断自己是否在仓库内：
> 装在仓库之外的副本会跳过「构建产物」检查（服务端直接跑已发布的 npx 包），
> 并主动探测 JoyCode 的 `~/.joycode/joycode-mcp.json` 来确认注册状态。

## 第 5 步 —— 使用

在站点上录一段流程、注册一次服务，然后直接对 JoyCode agent 说话：

> _"我刚录了会议室预订流程，把它做成 action，然后预订明早 10 点的 A 会议室。"_

> `list_recordings` 返回每条录制的元数据**以及**其依赖、交互和字段动态性
> 标记，几十条录制时 payload 可达数百 KB。如果客户端截断了结果，请缩小
> 范围——用 `get_flow` / `get_endpoints` 一次查一条。

## 提示词 → 工具速查表

| 你说                                        | 工具                                           |
| ------------------------------------------- | ---------------------------------------------- |
| "看看录制" / "我录了什么"                   | `list_recordings`                              |
| "看看调用链" / "这些字段哪来的"             | `get_recording` · `get_flow` · `get_endpoints` |
| "把这段录制变成 action" / "做成可复用"      | `create_action`                                |
| "跑一下那个 action" / "重放"                | `execute_action`                               |
| "带我的登录态调这个接口" / "帮我取这个数据" | `proxy_fetch` · `proxy_sse`                    |
| "截个图" / "序列化这个元素"                 | `capture_screenshot` · `capture_element`       |

每个 `proxy_fetch`、`proxy_sse` 和 `execute_action` 依然会走扩展自己的确认
弹窗，和其他客户端完全一致。

## 排障

| 症状                                          | 原因                                         | 处理                                                     |
| --------------------------------------------- | -------------------------------------------- | -------------------------------------------------------- |
| 会话里没有 `manta-*` 工具                     | 会话启动后才改的配置                         | 重启 JoyCode 或新开会话                                  |
| 重启后还是没有                                | 配置写错了文件（`mcp.json`、`.mcp.json`）    | 用 `~/.joycode/joycode-mcp.json`                         |
| 所有 MCP 工具都消失，不止我们的               | JSON 语法错误导致整个配置失效                | 校验文件语法后修复                                       |
| `No authenticated Chrome extension connected` | Chrome 没开 / 扩展未加载 / 端口或 token 漂移 | 打开带扩展的 Chrome，确认端口是 8787，重新复制安装提示词 |
| `MCP bridge has no MANTA_TOKEN configured`    | `env` 块里少了 token                         | 重新复制安装提示词并更新 `env.MANTA_TOKEN`               |
| `RPC "…" timed out`                           | 扩展 service worker 休眠 / 刚重载            | 点一下扩展的侧边栏唤醒它，再重试                         |
| Claude Code 里能用，但这里提示端口被占        | 8787 已被另一个客户端占用                    | 属预期行为——本进程以 peer 身份运行；用 `health` 查看角色 |

## 与 Claude Code / WorkBuddy 的差异一览

| 关注点       | Claude Code                                       | WorkBuddy                                               | JoyCode                                             |
| ------------ | ------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| MCP 配置位置 | `~/.claude.json` / `.mcp.json` / `claude mcp add` | `~/.workbuddy/mcp.json`                                 | `~/.joycode/joycode-mcp.json`                       |
| 生效方式     | 注册即生效                                        | 注册 **+ 界面里信任**                                   | 注册 + 重启会话                                     |
| skill 目录   | `~/.claude/skills/`                               | `~/.workbuddy/skills/` 或 `<工作区>/.workbuddy/skills/` | `~/.joycode/skills/` 或 `<工作区>/.joycode/skills/` |
| 查看服务列表 | `claude mcp list`                                 | 连接器管理页                                            | 让 agent 搜索 MCP 工具，或直接看配置文件            |
