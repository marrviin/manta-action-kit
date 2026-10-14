# manta-action-kit 中文速览

完整使用指南见 [SKILL.md](../SKILL.md)（英文），开发/仓库相关见
[dev-setup.md](dev-setup.md)。本文件是中文速查版。

## 这是什么

Chrome 扩展 + 本地 MCP 服务（`@manta-action-kit/mcp`）：在浏览器里录制一段 API
调用流程 → agent 经 MCP 读取录制、蒸馏成可参数化的 **Action** → 回放时扩展在
网络层注入你的登录 cookie。**凭证始终留在浏览器里，AI 永远看不到。**

## 安装 / 初始化（新环境）

1. 从 [Chrome Web Store](https://chromewebstore.google.com/detail/manta-action-kit/pghddhbhbnlcehlmgnnalgaephllkeel)
   安装扩展（Node ≥ 18 为 MCP 服务端要求）。
2. 扩展工具栏图标 → 打开侧栏 → **Action 标签页 → Copy install prompt**（内含
   个人 `MANTA_TOKEN` 和端口）。
3. 在所用客户端里注册 MCP 服务——直接粘贴安装提示词按引导走；Claude Code 手动等价：
   `claude mcp add manta-action-kit --env MANTA_TOKEN=<token> -- npx -y @manta-action-kit/mcp`。
   WorkBuddy（`~/.workbuddy/mcp.json`，注册后还需在连接器 UI 里**信任**）、
   JoyCode（`~/.joycode/joycode-mcp.json`）、Codex（`~/.codex/config.toml`）、
   Cursor（`~/.cursor/mcp.json`）按各自配置文件合并。详见 SKILL.md 第 1 节。
4. 跑一次环境检查确认链路通。

## 环境检查 / 连不上时

```bash
MANTA_TOKEN=<MCP 配置 env 里的 token> node <skill 目录>/scripts/check-env.mjs
```

逐项输出 ✅/❌ 与修复建议（0 = 全通过）。token 从 MCP 配置的 `env` 里拿，或让
用户从扩展侧栏 **Action 标签页 → Copy install prompt** 重新复制。仓库外安装的
副本会自动跳过构建产物检查，并探测各客户端配置文件里的注册状态。

常见故障对应处理：

| 症状                                              | 处理                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MCP 未注册 / 连接失败                             | `claude mcp add`（或对应客户端的配置文件）；仓库内开发则先 `pnpm build:mcp`，再 `node dist/index.js` 注册                                                                                                                                                          |
| 报「No authenticated Chrome extension connected」 | Chrome 没开扩展 / 端口不匹配（默认 8787）/ 设置标签页「连接器」卡片显示 Auth failed（token 不一致 → 重拷安装提示词并更新配置）                                                                                                                                                   |
| 报「RPC ... timed out」                           | 扩展 service worker 刚休眠或重载，让用户点一下扩展侧栏再重试                                                                                                                                                                                                       |
| 启动即报端口冲突                                  | WS bridge 端口（8787）被无关进程占用时会自动回退：向上扫描 32 个端口认领空闲端口，扩展自动发现新端口（约 20–30s，看 stderr 的 `Bridge on ws://127.0.0.1:<port> (fallback …)`）。代理端口（8788）被占用时调 `rebind_proxy` 自愈。仅两个端口配置成同一个才是致命错误 |
| 新功能不生效 / 工具结果与文档不符                 | 扩展与 MCP 服务版本不一致（两者独立更新）。调 `health` 看 `compatHint`，它会指出哪端过旧以及怎么更新                                                                                                                                                               |

## 常用说法 → 工具

| 你说                           | 工具                                                        |
| ------------------------------ | ----------------------------------------------------------- |
| 查录制 / 列出我录过什么        | `list_recordings`                                           |
| 看调用链路 / 字段从哪来        | `get_flow` · `get_endpoints` · `get_recording`              |
| 描述这段录制是干什么的         | `set_recording_description`                                 |
| 把这段录制变成 action / 可复用 | `create_action`                                             |
| 执行那个 action / 跑一遍       | `execute_action`                                            |
| 用我的登录态调这个接口         | `proxy_fetch`（单次临时调用）                               |
| 拉流式 SSE                     | `proxy_sse`                                                 |
| 给脚本开代理规则 / 看代理规则  | `add_proxy_rule` · `list_proxy_rules` · `update_proxy_rule` |
| 截个图 / 整页截图              | `capture_screenshot`                                        |
| 把这个元素序列化出来           | `capture_element`                                           |
| 录个 GIF / 录屏                | `start_gif_recording`                                       |

## 核心原则

**录制是素材，Action 是产物。** 要重放一段流程，正确路径是：`get_flow` /
`get_endpoints` 分析 → `create_action` 蒸馏成参数化步骤 → `execute_action`
端到端回放。**不要用 `proxy_fetch` 逐条手工重放**——那是单次临时调用用的。

## 数据里的标记（marks）

- `precedingInteraction`：该调用由用户点击/输入直接触发，是强意图信号
- `dynamism: 'varies'`：回放时该字段值会变，必须做成参数；时间戳/一次性 id
  用内置助手 `{{nowMs}}` / `{{nowSec}}` / `{{uuid}}`，不要硬编码
- `fromPath: "cookie:<NAME>"`（fromSeq 为 -1）／`inputsFrom.fromCookie`：该请求
  字段由浏览器 cookie 喂入（CSRF/XSRF 双提交）——蒸馏时写成 `{{cookie:<NAME>}}`
  **header** 覆盖，回放时自动取实时 cookie 值（只允许 header 位置，值不会出现在
  工具结果里）
- `execute_action` 失败时带 `continueOnError: true` 重跑一次：所有步骤都会执行，
  `endReason: "completed-with-errors"` 一次性报告每步结果，而不是停在第一个失败
