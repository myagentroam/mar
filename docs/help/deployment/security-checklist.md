---
title: 上线安全检查清单
lastUpdated: 2026-11-12
---

# 上线安全检查清单

上线前逐项确认：

- [ ] 已修改 `admin` 初始密码，并限制管理员登录访问。
- [ ] `MAR_PUBLIC_ORIGIN` 与真实 HTTP/HTTPS 入口一致；HTTPS 反向代理必须显式配置该值，漏配时 Server 只看到内部 HTTP，Cookie 默认不会自动带上 `Secure`。不可信网络推荐 HTTPS，HTTP 为明文传输。
- [ ] MySQL、内部组件和 Node 不直接暴露公网；仅开放配置的 Server 入口。
- [ ] Node 使用最小权限非 root/非管理员服务账号，私有配置与 SQLite 仅该账号可读。
- [ ] `allowedRoots` 只列出必要工作目录。
- [ ] Agent 登录状态、模型服务配置和密钥不提交 Git、不贴入 Agent 消息或日志。
- [ ] Server 使用独立部署账号；只读挂载的 `.ssh` 只包含该 Server 读取技能源所需的密钥与配置，未复用个人或其他生产系统密钥。
- [ ] 密钥按个人、节点或组织的最小作用域维护，组织继承范围符合预期，并删除不再需要的值。
- [ ] 已加密备份 Server、Node、工作区与 Agent 必要数据，并验证恢复流程。

完成后定期检查[账户安全](../administration/account.md)、[Node 与 Workspace](../administration/nodes-workspaces.md)和[操作审计](../administration/audit.md)。
