---
title: 安装、配置和使用 Codex
lastUpdated: 2026-09-20
---

# 安装、配置和使用 Codex

目标是在 Node 服务账号下让 Codex 使用自己的官方登录状态，并在工作台中创建可发送、停止和继续的会话。

## 安装

以 Node 实际运行的服务账号执行：

```bash
npm install -g @openai/codex
codex --version
```

然后在同一账号下运行 `codex`，按页面引导使用 ChatGPT 账号登录或配置 Codex 支持的认证方式。安装选项和登录要求以 [Codex CLI 官方文档](https://developers.openai.com/codex/cli) 为准。服务账号的 HOME 不同时，其他用户的登录状态不会被 Node 读取。

## 步骤

1. 启动或重启 Node，等待节点详情更新“支持 Agent”。
2. 在节点详情确认“支持 Agent”包含 Codex。
3. 打开 Workspace，新建会话，选择 Codex 及界面提供的模型、思考等级和权限。
4. 发送消息；需要整理上下文时使用当前会话提供的 Compact 操作。

**成功标志：** Codex 会话显示回复、工具和文件更改；刷新后仍能打开并继续同一会话。

## 失败排查

- 无法发现：在服务账号下检查 `codex --version`、登录态、HOME/PATH 和 Node 日志。
- Usage 不可用：账号用量只在 Codex 当前登录方式能够查询时显示；不可用时不影响对话。
- 外部历史无法继续：首次发送会自动验证 Codex 继续路径；若返回错误，检查服务账号登录态、工作区路径和 Codex 本机状态。

下一步：[Agent 排障](runner-troubleshooting.md)。
