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
副本会自动跳过构建产物检查（输出一行 `⚠️ … build check n/a`——⚠️ 是跳过提示，
不算失败），并探测各客户端配置文件里的注册状态。健康输出长这样：

```text
✅ Claude Code has manta-action-kit MCP registered
✅ WS bridge port 8787 has an MCP server listening
✅ End-to-end probe passed (MCP → bridge → extension) — current recording count: 3
✅ Versions in lockstep (ext 0.6.0 = server 0.6.0)
```

常见故障对应处理：

| 症状                                              | 处理                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MCP 未注册 / 连接失败                             | `claude mcp add`（或对应客户端的配置文件）；仓库内开发则先 `pnpm build:mcp`，再 `node dist/index.js` 注册                                                                                                                                                          |
| 报「No authenticated Chrome extension connected」 | Chrome 没开扩展 / 端口不匹配（默认 8787）/ 设置标签页「连接器」卡片显示 Auth failed（token 不一致 → 重拷安装提示词并更新配置）                                                                                                                                     |
| 报「RPC ... timed out」                           | 扩展 service worker 刚休眠或重载，让用户点一下扩展侧栏再重试                                                                                                                                                                                                       |
| 启动即报端口冲突                                  | WS bridge 端口（8787）被无关进程占用时会自动回退：向上扫描 32 个端口认领空闲端口，扩展自动发现新端口（约 20–30s，看 stderr 的 `Bridge on ws://127.0.0.1:<port> (fallback …)`）。代理端口（8788）被占用时调 `rebind_proxy` 自愈。仅两个端口配置成同一个才是致命错误 |
| 新功能不生效 / 工具结果与文档不符                 | 扩展与 MCP 服务版本不一致（两者独立更新）。调 `health` 看 `compatHint`，它会指出哪端过旧以及怎么更新                                                                                                                                                               |

## 常用说法 → 工具

| 你说                                          | 工具                                                        |
| --------------------------------------------- | ----------------------------------------------------------- |
| 查录制 / 列出我录过什么                       | `list_recordings`                                           |
| 看调用链路 / 字段从哪来                       | `get_flow` · `get_endpoints` · `get_recording`              |
| 看单个调用                                    | `get_call`                                                  |
| 描述这段录制是干什么的                        | `set_recording_description`                                 |
| 查 action 列表                                | `list_actions`                                              |
| 找一个能做 X 的 action                        | `search_actions`                                            |
| 看 action 定义 / 参数                         | `get_action`                                                |
| 把这段录制变成 action / 可复用                | `create_action`                                             |
| 改 action 的参数 / 步骤 / 描述                | `update_action`                                             |
| 删掉这个 action                               | `delete_action`                                             |
| 执行那个 action / 回放流程 / 自动操作这个流程 | `execute_action`                                            |
| 用我的登录态调这个接口                        | `proxy_fetch`（单次临时调用）                               |
| 拉流式 SSE                                    | `proxy_sse`                                                 |
| 给脚本开代理规则 / 看代理规则                 | `add_proxy_rule` · `list_proxy_rules` · `update_proxy_rule` |
| 看元素捕获历史                                | `list_element_captures`                                     |
| 看某个捕获的完整结构                          | `get_element_capture`                                       |
| 对比两次捕获哪里不一样                        | `diff_element_captures`                                     |
| 截个图 / 整页截图                             | `capture_screenshot`                                        |
| 把这个元素序列化出来                          | `capture_element`                                           |
| 录个 GIF / 录屏                               | `start_gif_recording`                                       |
| 暂停 / 恢复录制                               | `pause_gif_recording` · `resume_gif_recording`              |
| 停止录制                                      | `stop_gif_recording`                                        |
| 在录吗 / 录到哪了                             | `get_gif_recording_status`                                  |
| 看录制草稿历史                                | `list_gif_history`                                          |
| 链路体检（版本是否一致等）                    | `health`                                                    |
| 代理端口被占，换个端口                        | `rebind_proxy`                                              |

## 核心原则

**录制是素材，Action 是产物。** 要重放一段流程，正确路径是：`get_flow` /
`get_endpoints` 分析 → `create_action` 蒸馏成参数化步骤 → `execute_action`
端到端回放。**不要用 `proxy_fetch` 逐条手工重放**——那是单次临时调用用的。

## 各功能要点（速查）

### Action（蒸馏 / 回放）

- 创建 / 修改 / 删除 action 是**静默**的（只做校验，两侧都不弹窗）；人在环闸门
  在**回放时**：`execute_action` 走扩展网关，确认弹窗**每个目标 host 整轮只确认
  一次**。
- 步骤只引用录制的 callId，**不含任何凭证**；回放时扩展注入实时 cookie，步骤间
  依赖（上游响应值 → 下游请求字段）自动解析，无需手工编排。
- 模板助手：时间戳 / 一次性 id 用内置 `{{nowMs}}` / `{{nowSec}}` / `{{uuid}}`
  （同名声明参数优先），不要硬编码。表单体、嵌入 URL 编码 JSON 信封
  （路径写 `data[0].id`）、数组根 body（按下标）都能覆写。
- 回放失败要诊断时，带 `continueOnError: true` 重跑：所有步骤都执行，
  `endReason: "completed-with-errors"` 一次报齐每步结果。

### 页面采集（agent 驱动，作用于活动标签页，全程静默）

- 元素捕获和 GIF 录制**不能**在 `chrome://` 页跑；截图**可以**（CDP 兜底），
  只有 Web Store 等受保护页仍拒绝（`screenshot:protected-page`）。
- 该标签页开着 DevTools → 截图报 `screenshot:debugger-conflict`，让用户关掉
  DevTools 重试。
- `capture_element`：selector / `point` / `box` 三选一；返回**瘦身树**，完整
  结构走 `get_element_capture(captureId)`。可穿透 iframe（深度 3；selector 按
  iframe 内部写法给）。超时 45s——首响应慢别提前放弃。坐标若读自整页截图，
  传 `coordinates: "page"`。
- GIF：`start_gif_recording` 会**阻塞**等用户在确认弹窗点「允许」（Chrome 要求
  手势才能取 tabCapture 流），最多约 2 分钟，别当故障。到 5 分钟自动停。
  停止后拿到的是 **WebM 草稿**——转 GIF/MP4 只能在扩展预览页做，让用户从侧栏
  「页面采集」里打开草稿转码 / 下载。

### 沙箱代理（proxy_fetch / proxy_sse / 代理规则）

- **每次调用都弹扩展侧确认窗**（人在环主闸门，脚本路径也走这道闸）——让用户点
  「允许」，这是设计行为不是故障；允许域名列表里的目标会静默放行。
- cookie 只在扩展内部注入，**永不出现在工具结果里**；直接把响应转述给用户即可。
- 环回 / 私网 / 云元数据地址（含 169.254.169.254）被 SSRF 防护拒绝——属预期拦截。
- 代理规则：`add` / `update` 会弹**原生**确认提示（展示前缀和目标，用户核验）；
  `enabled` 开关是用户专属，agent 改不了。

### 元素捕获（用户侧采集 + agent 只读）

- 用户在页内点击 / 框选捕获（`Alt+Shift+I`），本地存 20 条，可在预览页两两
  diff；agent 只有 `list` / `get` / `diff` 三个只读工具。
- 拿捕获去复刻 UI：按语义重建 HTML + 干净的 CSS 规则，**别照搬内联的计算样式**
  ——那是「当时长什么样」的事实依据，不是该发布的样式表。注意自定义属性和
  伪元素（`::before`/`::after`）规则。

## 数据里的标记（marks）——通俗版

`get_flow` 返回按序排列的轻量步骤列表（不含请求/响应体，要看完整报文用
`get_recording`）。一个典型步骤长这样：

```json
{
  "seq": 3,
  "method": "POST",
  "url": "https://shop.example.com/api/orders",
  "status": 200,
  "precedingInteraction": {
    "kind": "click",
    "text": "提交订单",
    "deltaMs": 180
  },
  "deps": [
    {
      "fromSeq": 1,
      "fromPath": "data.orderId",
      "toSeq": 3,
      "toLocation": "query",
      "toPath": "orderId",
      "value": "A10293",
      "origin": "inferred"
    }
  ]
}
```

- `precedingInteraction`：**「用户点了/输了什么，紧接着这个调用就发出去了」**。
  带此标记的步骤是用户意图的直接后果（蒸馏 action 时要保留）；没有此标记的
  步骤是自己发出来的（埋点、预加载、轮询），通常不进 action。注意它只是提示
  （5s 回看窗口），不是因果证明。
- `deps`（及 `get_endpoints` 的 `inputsFrom`）：**「这个请求字段的值来自前面
  某一步的响应」**（上例：第 1 步响应的 `data.orderId` 喂给第 3 步的 `orderId`
  查询参数）。是启发式匹配，强提示但非证明；`origin: "confirmed"/"manual"`
  表示用户确认过，`inferred` 表示纯自动推断——参数化之前先确认这条边讲得通。
- `fromSeq: -1` 且 `fromPath: "cookie:<NAME>"`：该字段由浏览器 cookie 喂入
  （CSRF/XSRF 双提交），蒸馏时写成 `{{cookie:<NAME>}}` **header** 覆盖，回放时
  自动取实时 cookie 值（只允许 header 位置，值不会出现在工具结果里）。
- `dynamism` / `queryDynamism`（只在 `get_endpoints` 的请求 schema 上）：回答
  **「明天回放时这个字段的值还会一样吗？」**——纯统计判定（`source: 'stats'`）。
  `varies` = 多次调用值全不同（时间戳、会话 token、自动生成的 id）→ 必须做成
  参数，或用内置助手 `{{nowMs}}` / `{{nowSec}}` / `{{uuid}}`，不要硬编码；
  `stable` = 多次调用值全同 → 可写死；**没有标记 = 只观测到一次**，靠值的形状
  自行判断（`createdAt` 这种即使没标也大概率是 varies）。
- `execute_action` 失败时带 `continueOnError: true` 重跑一次：所有步骤都会执行，
  `endReason: "completed-with-errors"` 一次性报告每步结果，而不是停在第一个失败。
