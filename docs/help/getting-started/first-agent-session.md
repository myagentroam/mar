---
title: 开始第一次 Agent 对话
lastUpdated: 2026-09-20
---

# 开始第一次 Agent 对话

这篇文档帮助你在已登记的工作区中发送第一条由 MyAgentRoam 管理的 Agent 消息。

## 前置条件

- 已选择工作区，并且节点详情显示至少一个可用 Agent。
- 使用内置 MAR Agent 时，管理员已配置并启用模型，当前用户具有模型使用权且处于所绑定凭据的作用域内；无需安装外部 CLI。
- 使用 Codex、Claude Code 或 OpenCode 时，对应 CLI 已在 Node 服务账号下完成登录或服务提供商配置。

## 步骤

1. 在会话面板点击“新建会话”。
2. 在页面底部的消息输入区选择已接入的 Agent，再选择界面提供的模型、思考等级和权限。
3. 输入一个小且可验证的请求，例如“阅读当前项目结构并说明入口文件，不修改文件”。
4. 点击发送；运行中观察 `Working` 状态、回复和工具卡，完成后状态变为 `Idle`。

**成功标志：** 对话中出现你的消息和 Agent 回复；会话列表保留新会话，刷新页面后仍能重新打开历史。

## 失败排查

- 无 Agent 或无模型：查看[Agent 不可用或模型缺失](../runners/runner-troubleshooting.md)。
- 外部历史无法继续：首次发送会自动验证继续路径；若返回错误，检查 Node、Agent 本机状态和工作区路径。
- 发送后未完成：先检查 Node 是否在线，再查[会话卡在 Working 或 Idle](../troubleshooting/session-run.md)。

下一步：[发送消息与 Composer](../workbench/composer.md)和[选择 Agent](../runners/overview.md)。
