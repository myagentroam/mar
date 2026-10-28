---
title: 数据归属、凭据与安全边界
lastUpdated: 2026-10-29
---

# 数据归属、凭据与安全边界

| 位置         | 主要数据                                       | 你需要保护什么                         |
| ------------ | ---------------------------------------------- | -------------------------------------- |
| Server/MySQL | 账户、登记、授权、MAR 模型 Key、企业配置与审计 | 数据库备份、TLS、管理员密码与访问权限  |
| Node         | 私有配置、工作区和终端的必要记录               | 服务账号、配置文件权限、`allowedRoots` |
| Agent CLI    | 登录状态、模型服务配置、对话历史               | Agent 官方账号与配置目录               |
| Workspace    | 源码、Git、运行产物                            | 文件权限、仓库密钥与备份               |

浏览器通过 Server 认证和授权，不直接访问 Node 的通用 API。获授权的普通工作区文件、Git 和终端数据可使用 WebRTC 直传，无法直传时回退到 Server 中继；直传不替代授权。Server 不持久化终端正文，也不将 Node 或 Agent 凭据交给浏览器。MyAgentRoam 不能替代主机补丁、磁盘加密、最小权限、代码审查或 Agent 自身的安全设置。

MAR Agent 模型 API Key 以明文保存在 Server MySQL，但不会通过查询 API、审计或页面回显。工具权限模式不替代操作系统沙箱：Host 路径和资源限制仍然生效，工具使用 Node 服务账号的实际权限。不同入口的默认模式与审批规则见 [MAR Agent 会话与权限](../runners/mar-agent.md#会话与权限)。

下一步：[备份与恢复](../deployment/backup-restore.md)和[上线安全检查清单](../deployment/security-checklist.md)。
