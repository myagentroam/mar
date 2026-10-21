---
title: 安装、配置和使用 Claude Code
lastUpdated: 2026-09-12
---

# 安装、配置和使用 Claude Code

Claude Code 必须在 Node 服务账号下完成官方登录或你自己的兼容 API 配置。MyAgentRoam 不复制、转换或托管 Claude Code 的账号配置。

## 安装

以 Node 实际运行的服务账号执行，不要使用 `sudo npm install -g`：

```bash
npm install -g @anthropic-ai/claude-code
claude --version
claude doctor
```

然后在同一账号下运行 `claude`，完成 Anthropic 登录，或按 Claude Code 官方文档配置其支持的模型平台。Windows 可使用 WSL 或 Git for Windows，具体要求以 [Claude Code 官方安装文档](https://code.claude.com/docs/en/setup) 为准。

迁移到新的 Node 服务账号时，只迁移该账号需要的 Claude Code 配置与认证，并限制为该账号可读；不要复制历史、缓存、项目会话或其他账号的完整用户目录。迁移后必须按 Node 平台自启动文档在服务进程的实际 `HOME`、`PATH` 下验证 `claude --version`，然后重启 Node 并在节点详情确认可用。

## 可选配置

自定义上下文窗口时，在 Node 服务环境设置 `MAR_CLAUDE_CONTEXT_WINDOW_TOKENS` 为正整数；未设置时默认按 Claude Code 常用 200000 tokens，并可读取该账号 Claude 配置中的同名环境值。

## 步骤

1. 重启 Node 后，在节点详情确认 Claude Code 已列为支持 Agent。
2. 创建会话，选择页面给出的模型、思考等级和权限。
3. 输入 `/plan` 进入原生计划能力；完成计划后关闭计划或选择“执行”再执行。

**成功标志：** 会话能返回内容；上下文用量在 Claude Code 可提供时更新，计划卡显示可继续的实施入口。

## 失败排查

- 节点显示不可用：在服务账号终端检查版本、认证、HOME/PATH 及网络。
- 上下文总量不符合你的模型：设置正确的 `MAR_CLAUDE_CONTEXT_WINDOW_TOKENS` 后重启 Node。
- 外部历史没有详情：确认 Claude Code 历史属于 Node 实际运行账号，再刷新会话。

下一步：[Agent 不可用或模型缺失](runner-troubleshooting.md)。
