---
title: 配置 SMTP 邮件与通知模板
lastUpdated: 2026-11-13
---

# 配置 SMTP 邮件与通知模板

系统管理员可以在“管理 → 系统配置”配置一份部署级 SMTP 连接，并查看内置的测试与通知邮件模板。所有邮件由 **Server** 发出；Node、浏览器和 Agent 不会得到 SMTP 密码。

## 配置与测试

1. “邮件SMTP配置”在列表的值栏只显示 `-`。点击“编辑”，在弹窗中按字段填写 SMTP 主机、端口、TLS 方式、发件地址、发件人名称以及可选的认证账号与密码；系统仍会将这些字段保存为一份 SMTP 配置。例如：

   ```json
   {
     "host": "smtp.example.com",
     "port": 587,
     "tls": "STARTTLS",
     "from": "agent@example.com",
     "fromName": "MyAgentRoam",
     "username": "agent@example.com",
     "password": "your-app-password"
   }
   ```

   `tls` 可为 `STARTTLS`（必须完成 TLS 升级）或 `TLS`（连接建立时就使用 TLS）。启用邮件发送后填写字段并保存；配置保存后密码不再回显，认证账号不变时密码留空可保留原密码。关闭“启用邮件发送”并保存会提示确认，确认后清除 SMTP 配置和密码、停用发信。

2. 在配置弹窗点击“查看邮件模板”，查看只读的中英文测试和通知模板，并预览与实际发信一致的排版邮件。内置模板不可编辑或替换；发送时同时包含带样式的 HTML 内容和纯文本替代正文，通知主题支持 `{{title}}`，正文支持 `{{message}}`、`{{userName}}`、`{{workspaceName}}`、`{{email}}` 占位符。
3. 在模板弹窗点击“发送测试邮件”，选择测试模板并输入一个收件邮箱。测试使用**已保存**的 SMTP 配置；成功提示只代表 SMTP 服务器接受请求，不保证邮件进入收件箱。测试需管理员权限，并受发送频率限制。

密码不应粘贴到对话或提交到仓库。连接失败时先检查主机可达性、端口、TLS 模式、证书和服务商提供的应用密码；保存配置本身不会发邮件。

## Agent 的通知 MCP

普通 Workspace 会话的 Agent 可使用内建 `mar_notification` 的 `send_email_notification`，提供正文和可选标题，收件邮箱 `recipientEmail` 可省略：默认发送到本次执行发起账号在 Server 保存的邮箱。“给我的账号发邮件”不需要查询或传入邮箱；只有发送到其他获授权地址时才指定 `recipientEmail`。账号没有有效邮箱时返回 `MAIL_RECIPIENT_NOT_CONFIGURED`，请先配置账号邮箱或显式提供收件地址；显式地址无效时不会回退到账号邮箱。通知模板 ID 可以不填或留空，此时根据发起用户当前保存的界面语言使用内置中文或英文通知模板；也可显式指定模板；标题留空时使用所选模板语言对应的默认标题，不受发起用户界面语言影响。Agent 的工作环境是获授权 **MAR Node 上的当前 Workspace 会话**；邮件实际通过 Server 配置的 SMTP 发出，而不是由浏览器、Node 的本地邮箱或仓库 cron/CI 发出。

收件邮箱不必是当前用户或系统账号，但发起人仍需有权使用当前 Node 和 Workspace，且不能读取 SMTP 凭据。手动 Run 与定时 Run 都可显式调用；工作区会话列表的“已加载 MCP”会将邮件通知标记为“执行时注入”，这不代表当前已配置 SMTP 或具备发送条件。现有通知中心消息不会自动转为邮件，托管对话不提供该 MCP。每次执行最多发送 50 封；结果不确定时不要盲目重试，以免重复发送。

Node 与 Server 暂时断线时通知发送不可用；重连后，只要本次执行仍有效且当前权限校验通过，即可继续使用通知工具，无须因普通断线重启执行。已结束、取消或撤权的执行不会因重连恢复权限。在途发送遇到断线仍可能结果不确定，系统不会自动重发。

## 多渠道通知

Server 声明兼容能力时，同一执行注入的 `mar_notification` 还提供 `send_notification`。省略 `channels` 等于 `["push"]`；可指定 `["email"]` 或 `["push","email"]`。邮件渠道省略 `recipientEmail` 时使用发起账号邮箱，也可显式提供获授权的单个地址，可选 `templateId`；省略渠道仍只发送 Push，不自动发送邮件。只请求 Push 时不要提交邮件字段。Push 收件人固定为本次执行的发起账号，不通过邮箱选择用户或设备。

```json
{ "message": "The requested task is complete." }
```

发送给自己的账号邮箱，无须传入收件地址：

```json
{ "channels": ["email"], "message": "The requested task is complete." }
```

向其他获授权地址发邮件并同时推送：

```json
{
  "channels": ["push", "email"],
  "recipientEmail": "recipient@example.test",
  "message": "The requested task is complete."
}
```

Push 会创建一条关联当前普通会话的显式 Agent 通知，并向该账号所有符合条件的独立客户端尽力分发；[个人设置、在线抑制和平台限制](../workbench/navigation.md#系统通知)同样适用。各渠道独立尝试，返回持久化事实、分设备汇总和邮件结果；厂商或 SMTP 接受不代表设备显示或进入收件箱。部分成功或结果不确定时，不要以新调用盲目重试。旧 `send_email_notification` 仍然只发邮件，纯邮件不会额外创建站内通知。两种工具都会产生真实外部副作用，不能发送凭据或未经许可的项目敏感内容。
