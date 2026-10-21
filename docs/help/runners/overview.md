---
title: 选择 Agent
lastUpdated: 2026-09-24
---

# 选择 Agent

Node 会按需发现本机可用的 Agent；节点详情“支持 Agent”只列出已发现的项目，每个 Agent 占一行。未安装、无法执行或未完成配置的 Agent 不会作为可选项显示。

MyAgentRoam 默认推荐内置 MAR Agent。页面统一按 **MAR Agent、Codex、Claude Code、OpenCode** 排序；若前面的 Agent 未配置、未安装或不可用，新会话自动选择下一个可用 Agent。已建立的会话仍使用创建时选择的 Agent。

| Agent       | 使用前要确认                                | 页面中的模型来源             | 适合的场景                         |
| ----------- | ------------------------------------------- | ---------------------------- | ---------------------------------- |
| MAR Agent   | 管理员已登记、启用并向当前用户授权模型连接  | Server 授权的 MAR Agent 模型 | 内置 SDK、工具、MCP 和 subagent    |
| Codex       | 服务账号能运行并已登录 Codex                | Codex 当前账号可用模型       | 继续 Codex 会话、整理上下文        |
| Claude Code | 服务账号能运行并已登录或配置 Claude Code    | Claude Code 当前配置         | Claude Code 会话、计划和上下文用量 |
| OpenCode    | Node 服务账号的全局 OpenCode 配置已声明模型 | Node 用户全局 OpenCode 配置  | 任意大模型、计划和思考等级         |

选择时以页面实际展示的模型、思考等级和权限为准。MAR Agent 只展示当前用户有权使用的已启用模型。系统管理员可以管理全部模型，但实际使用仍受模型所绑定凭据的作用域限制；模型管理权或使用权也不自动授予凭据详情的查看和管理权，见[模型与凭据授权](mar-agent.md#配置使用授权)。一个工作区可以使用多个 Agent，但一个会话创建后始终属于当时选择的 Agent；需要换 Agent 时请新建会话。

**成功标志：** 新建会话的选择器中出现 Agent 与模型，发送后能够看到对应 Agent 的回复和工具记录。

按需阅读 [MAR Agent](mar-agent.md)、[Codex](codex.md)、[Claude Code](claude-code.md) 或 [OpenCode](opencode.md) 说明。如果 Agent 缺失，先阅读[Agent 不可用或模型缺失](runner-troubleshooting.md)。
