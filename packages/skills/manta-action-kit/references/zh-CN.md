# manta-action-kit 中文速览

完整使用指南见 [SKILL.md](../SKILL.md)（英文）。本文件是中文速查版，覆盖安装检查、常用说法和核心原则。

## 这是什么

Chrome 扩展 + 本地 MCP 服务（`@manta-action-kit/mcp`）：在浏览器里录制一段 API
调用流程 → agent 经 MCP 读取录制、蒸馏成可参数化的 **Action** → 回放时扩展在
网络层注入你的登录 cookie。**凭证始终留在浏览器里，AI 永远看不到。**

## 环境检查 / 连不上时

```bash
MANTA_TOKEN=<MCP 配置 env 里的 token> node <skill 目录>/scripts/check-env.mjs
```

逐项输出 ✅/❌ 与修复建议（0 = 全通过）。token 从 MCP 配置的 `env` 里拿，或让
用户从扩展侧栏 **Action 标签页 → Copy install prompt** 重新复制。

常见故障对应处理：

| 症状                                              | 处理                                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| MCP 未注册 / 连接失败                             | 仓库内 `pnpm build:mcp` 后 `claude mcp add`；仓库外用 `npx -y @manta-action-kit/mcp`                             |
| 报「No authenticated Chrome extension connected」 | Chrome 没开扩展 / 端口不匹配（默认 8787）/ MCP 标签页显示 Auth failed（token 不一致 → 重拷安装提示词并更新配置） |
| 报「RPC ... timed out」                           | 扩展 service worker 刚休眠或重载，让用户点一下扩展侧栏再重试                                                     |
| 启动即报端口冲突                                  | `lsof -nP -iTCP:8787`（代理端口 8788 同理）找到占用者；换端口需两端同时改                                        |

## 常用说法 → 工具

| 你说                           | 工具                                           |
| ------------------------------ | ---------------------------------------------- |
| 查录制 / 列出我录过什么        | `list_recordings`                              |
| 看调用链路 / 字段从哪来        | `get_flow` · `get_endpoints` · `get_recording` |
| 把这段录制变成 action / 可复用 | `create_action`                                |
| 执行那个 action / 跑一遍       | `execute_action`                               |
| 用我的登录态调这个接口         | `proxy_fetch`（单次临时调用）                  |
| 拉流式 SSE                     | `proxy_sse`                                    |
| 截个图 / 整页截图              | `capture_screenshot`                           |
| 把这个元素序列化出来           | `capture_element`                              |
| 录个 GIF / 录屏                | `start_gif_recording`                          |

## 核心原则

**录制是素材，Action 是产物。** 要重放一段流程，正确路径是：`get_flow` /
`get_endpoints` 分析 → `create_action` 蒸馏成参数化步骤 → `execute_action`
端到端回放。**不要用 `proxy_fetch` 逐条手工重放**——那是单次临时调用用的。

## 数据里的标记（marks）

- `relevance.verdict === 'irrelevant'`：背景噪声（埋点/轮询/预检），蒸馏时跳过
- `precedingInteraction`：该调用由用户点击/输入直接触发，是强意图信号
- `depCheck.verdict === 'unlikely'`：推断的依赖边是巧合撞值（时间戳/nonce），
  不要基于它做参数化
- `dynamism: 'varies'`：回放时该字段值会变，必须做成参数；时间戳/一次性 id
  用内置助手 `{{nowMs}}` / `{{nowSec}}` / `{{uuid}}`，不要硬编码
