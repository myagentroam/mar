---
title: 上线安全检查清单
lastUpdated: 2026-08-23
---

# 上线安全检查清单

上线前逐项确认：

- [ ] 已修改 `admin` 初始密码，并限制管理员登录访问。
- [ ] 浏览器入口使用 HTTPS，`MAR_PUBLIC_ORIGIN` 与真实地址一致。
- [ ] MySQL、Server 回环端口和 Node 均不直接暴露公网。
- [ ] Node 使用最小权限非 root/非管理员服务账号，私有配置与 SQLite 仅该账号可读。
- [ ] `allowedRoots` 只列出必要工作目录。
- [ ] Agent 登录状态、模型服务配置和密钥不提交 Git、不贴入 Agent 消息或日志。
- [ ] Server 使用独立部署账号；只读挂载的 `.ssh` 只包含该 Server 读取技能源所需的密钥与配置，未复用个人或其他生产系统密钥。
- [ ] 密钥按个人、节点或组织的最小作用域维护，组织继承范围符合预期，并删除不再需要的值。
- [ ] 已加密备份 Server、Node、工作区与 Agent 必要数据，并验证恢复流程。

完成后定期检查[账户安全](../administration/account.md)、[Node 与 Workspace](../administration/nodes-workspaces.md)和[操作审计](../administration/audit.md)。
