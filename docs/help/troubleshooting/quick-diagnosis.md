---
title: 从现象开始排查
lastUpdated: 2026-11-12
---

# 从现象开始排查

| 现象                       | 先检查                                  | 下一页                                                      |
| -------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| 页面空白或登录失败         | 入口协议、反向代理、`MAR_PUBLIC_ORIGIN` | [网络、TLS 与 WebSocket](../deployment/network.md)          |
| Node 离线/注册失败         | Node 服务日志、URL、时间、出站网络      | [Node 注册失败或离线](node-offline.md)                      |
| Workspace/文件/Git 不可用  | `allowedRoots`、实际路径、服务账号权限  | [Workspace、文件或 Git 不可用](workspace-files.md)          |
| 会话卡住或只读             | Node 在线、Agent 状态、当前任务         | [会话卡在 Working、Idle 或只读](session-run.md)             |
| 终端打不开/断线            | Node 在线、服务账号、代理 WebSocket     | [终端无法打开或频繁断线](terminal.md)                       |
| MAR Agent 无模型或认证失败 | 模型启用、授权、凭据作用域和模型测试    | [Agent 排障](../runners/runner-troubleshooting.md)          |
| 托管对话不可用或历史为空   | 模板授权、承载 Node 在线与托管能力      | [托管对话](../workbench/hosted-conversations.md)            |
| 模板发布失败               | 来源目录、安全检查、模型、MCP 与容量    | [管理对话模板](../administration/conversation-templates.md) |
| Skill/MCP 安装失败         | 目标权限、Node 环境、网络与密钥引用     | [技能与 MCP 配置](../workbench/skills.md)                   |

## 提供可关联的故障信息

联系管理员前记录以下信息，并只在受控支持渠道提交：

- 发生时间与时区、Server/Web 产品版本、Node 公共组件版本；外部 Agent 问题另附对应 CLI 版本。
- 使用“工作”还是“对话”、受影响的节点/工作区/会话，以及最短复现步骤和预期结果。
- 界面显示的错误码、Server 请求 ID、Node 请求 ID（如有）与脱敏后的详情；没有显示的字段不必猜测。

管理员可用请求 ID 关联 `MAR_DATA_DIR/logs` 中的 Server 日志与 `dataDirectory/logs` 中的 Node 日志，也可查部署服务的标准输出。日志默认保留 7 天，应及时记录；路径说明见[端口与数据位置](../reference/ports-paths-data.md)。不要提交密钥、Cookie、完整聊天、终端正文、Agent 配置或未脱敏日志。

## 页面性能

页面卡顿时，将鼠标移到桌面控制台左下角的性能指示器。实时消息速率高但处理耗时、长任务和内存正常，通常只是当前活动较多；处理 P95、主线程延迟或长任务升高表示浏览器正在阻塞；DOM、消息卡片或 JS Heap 持续偏大时，应先关闭不需要的工作区标签或刷新页面。活动 Run 会话数是当前浏览器从实时回调观察到的数量，不是 Server 全局监控数据。

长任务显示“不可用”时，表示浏览器不支持采集或观察器初始化失败，并不代表没有长任务；只有正常采集且当前窗口内无记录时才显示零。复制的详细诊断同样包含采集可用性，缺少此指标不会单独改变整体健康状态。

## 通用顺序

先看 Server/Web 是否可访问，再看 Node 是否在线，再看当前工作区权限与“支持 Agent”。每次只改变一个条件并复验；不要同时重启 Server、Node、Agent 和浏览器，否则难以定位根因。
