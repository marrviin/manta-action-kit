# @manta-action-kit/skills

Agent skills（Claude Code Skill 格式）——教 agent 使用与调试 Manta Action Kit 的
MCP server（`packages/mcp`）。

## 包含的 skills

| 目录 | 说明 |
| --- | --- |
| `manta-action-kit` | 套件使用指南：环境检查与初始化、扩展/MCP/连接排查、读录制、代理转发、调试工作流。自带 `scripts/check-env.mjs` 一键健康检查 |

## 在本仓库开发时如何生效

仓库根目录的 `.claude/skills/manta-action-kit` 是指向本包的**符号链接**，Claude Code
会自动发现并按需加载（也可手动 `/manta-action-kit`）。克隆后无需任何操作。

## 安装到其他项目

```bash
npx degit marrviin/manta-action-kit/packages/skills/manta-action-kit ~/.claude/skills/manta-action-kit
# 或发布后：
# npm i @manta-action-kit/skills && cp -r node_modules/@manta-action-kit/skills/manta-action-kit ~/.claude/skills/
```

## 发布

```bash
cd packages/skills && npm publish
```

新增 skill 时在 `packages/skills/<kebab-case-name>/SKILL.md` 建目录即可（frontmatter 需含
`name` 与 `description`，`description` 写清触发词——agent 靠它决定是否加载）。
