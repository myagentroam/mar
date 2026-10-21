---
title: Agent 与会话控制状态
lastUpdated: 2026-09-20
---

# Agent 与会话控制状态

MyAgentRoam 只显示 Node 实际发现并可用的 Agent。模型、权限、思考等级和计划选项都以页面当时显示的内容为准。

在 MyAgentRoam 中新建的会话可直接发送、停止和排队。由 Agent CLI 或编辑器创建、后来被发现的历史会话也会作为普通会话显示；首次发送时，Node 会在当前工作区和现有用户授权范围内原子验证并激活继续路径。

激活不会复制或搬移历史，也不会取得其他系统的账号权限。它只是在当前 Node、当前工作区和现有用户授权下继续同一会话。

## 用户可观察的边界

MyAgentRoam 会话可以显示队列、`Working`、`Idle` 和停止状态。外部会话能否继续取决于对应 Agent 能否在首次发送时确认安全路径；仍在其他程序中运行、路径不匹配或 Agent 不可用时，发送会返回明确错误且不会创建 Run。浏览器刷新不会改变这些事实。

下一步：[选择 Codex、Claude Code 或 OpenCode](../runners/overview.md)。
