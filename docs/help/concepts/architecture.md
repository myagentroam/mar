---
title: Server、Node、Web 与 Agent
lastUpdated: 2026-10-21
---

# Server、Node、Web 与 Agent

MyAgentRoam 把网页管理与本机执行分开：浏览器通过 Server 完成认证、授权与控制，Node 在用户授权范围内运行 Agent 并操作文件。获授权的直传数据通道见下文。

```text
浏览器 Web ── HTTPS / WebSocket ── Server ── Node 主动连接 ── 本机 Agent / 工作区 / 终端
```

- **Server** 负责身份、授权、受管模型凭据、企业管理与受控中继，不是工作区文件或会话正文的权威。
- **Node** 拥有本地执行与工作区存储，处理文件、Git、终端、Agent 任务及本机会话集成。它主动连接 Server，不向浏览器暴露通用的入站 Node API。
- **MAR Agent** 是 SDK、CLI 与 Node 集成共用的运行内核，管理模型执行、工具、上下文和会话续接。外部 Runner（Codex、Claude Code、OpenCode）保留原生账号与历史机制，各自支持的控制能力被呈现到统一工作台。
- **Web** 呈现能力并保留必要的浏览器界面状态。业务 API 与控制信令经 Server；普通工作区文件与终端可使用 Server 授权的直传数据通道，失败回退中继，托管对话始终经中继。浏览器不持有 Node/Runner 的执行凭据。

## 为什么以 Agent 为中心？

Agent 是主要执行者，而不是浏览器 IDE 的附属功能。人负责定义目标、调整执行方向、检查文件与 Diff、审阅结果。文件、Git 与终端服务于这一流程；MAR 不试图复刻完整 IDE，也不为每种 CLI 操作建立专用按钮。Agent 工具可在配置的权限与执行环境内执行命令，不要求用户先打开 Web Terminal。

自托管不等于模型上下文保持离线：所选 Provider 会接收发送给它的上下文。Server 与 Node 承担不同存储职责，请保护两侧主机与服务账号。用户可见边界见[数据归属与安全边界](data-and-security.md)及[会话、运行与消息队列](session-run-turn.md)。

下一步：[Node 与 Workspace](node-and-workspace.md)和[数据归属与安全边界](data-and-security.md)。
