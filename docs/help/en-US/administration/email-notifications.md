---
title: Configure SMTP Email and Notification Templates
lastUpdated: 2026-11-13
---

# Configure SMTP Email and Notification Templates

An administrator can configure one deployment-wide SMTP connection under **Admin → System Configuration** and view built-in test and notification templates. The **Server** sends all email; Node, browser, and Agent do not receive SMTP credentials.

## Configure and test

1. The value column for **Email SMTP configuration** shows only `-`. Select **Edit** to enter the host, port, TLS mode, sender address, sender name, and optional authentication in separate fields. These fields are still saved as one SMTP configuration. For example:

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

   `STARTTLS` requires a TLS upgrade; `TLS` encrypts from the start. Enable email sending, complete the fields, then save. The password is not shown again; on a later edit, leave it empty to retain it only if the authentication account is unchanged. Switch off **Enable email sending** and save to clear the SMTP configuration and disable delivery. This action requires confirmation because the saved password will be deleted.

2. Select **View email templates** in the configuration dialog to browse the built-in Chinese and English test and notification templates. The preview shows the same formatted email sent to recipients. Templates cannot be edited or replaced; sent messages include styled HTML and a plain-text alternative. Notification subjects support `{{title}}`; message bodies support `{{message}}`, `{{userName}}`, `{{workspaceName}}`, and `{{email}}`.
3. Select **Send test email** in the template dialog, choose a test template, and enter a single recipient address. The test uses the **saved** SMTP configuration. Success means the SMTP server accepted the message; it does not guarantee inbox delivery. Only administrators can test, and test sends are rate-limited.

Do not paste your password into a conversation or commit it to a repository. If delivery fails, check network access from the Server, the SMTP port, TLS mode, certificate, and provider-specific application password. Saving the configuration does not send an email.

## Agent notification MCP

An Agent in an ordinary Workspace conversation can call `mar_notification` → `send_email_notification` with a message and optional title. Omit `recipientEmail` to use the initiating account’s email address saved on the Server. A request to “email my account” does not require looking up or passing an address; specify `recipientEmail` only for another authorized recipient. If the account has no valid email address, the tool returns `MAIL_RECIPIENT_NOT_CONFIGURED`; configure an account email or specify a recipient. An invalid explicit address never falls back to the account email. The notification template ID can be omitted or left empty; the built-in Chinese or English template is then selected using the sender's saved interface language. A template can also be selected explicitly. An empty title uses the default title in the selected template's language, independently of the sender's interface language. The Agent works in the **current authorized Workspace on its MAR Node**. The Server sends the email using its configured SMTP connection; this is not browser or Node local email, and it does not change the repository cron or CI.

The recipient does not have to belong to the current user or any account, but the initiator must still have access to the current Node and Workspace. The Agent cannot access SMTP credentials. Manual and scheduled Runs can explicitly call the tool. The Workspace session list labels email notification “Injected during execution” under “Loaded MCP”; this does not mean SMTP is configured or sending is available. Existing workbench notifications are not forwarded automatically, and hosted conversations do not provide the tool. Sending has a real external effect and is limited to 50 emails per execution. Do not blindly retry an uncertain result.

Notification sending is unavailable while the Node is disconnected from the Server. After reconnection, the same execution can continue using the tools if it is still valid and current authorization checks pass; a temporary disconnect does not require restarting the execution. Reconnection does not restore access for an execution that has ended, been cancelled, or had its authorization revoked. A disconnect during an in-flight send can still leave the outcome uncertain, and the system does not resend automatically.

## Multi-channel notifications

When the Server advertises a compatible capability, the same execution-scoped `mar_notification` also offers `send_notification`. Omitting `channels` means `["push"]`; `["email"]` and `["push","email"]` are also accepted. The email channel uses the initiating account’s email when `recipientEmail` is omitted; a single authorized address can override it. An optional `templateId` is accepted. Omitting channels still sends only Push, not email. Do not submit email fields for Push-only requests. Push always targets the initiating account, not an account or device selected by email.

```json
{ "message": "The requested task is complete." }
```

Email your own account without passing a recipient address:

```json
{ "channels": ["email"], "message": "The requested task is complete." }
```

Email another authorized address and send Push at the same time:

```json
{
  "channels": ["push", "email"],
  "recipientEmail": "recipient@example.test",
  "message": "The requested task is complete."
}
```

Push creates an explicit Agent notification for the current ordinary session and attempts delivery to all eligible independent clients of that account. The same [personal settings, online suppression, and platform limits](../workbench/navigation.md#system-notifications) apply. Channels run independently and return persistence facts, client-count summaries, and email results. Push-provider or SMTP acceptance does not mean device display or inbox delivery. Do not blindly retry a partial or uncertain result as a new call. The existing `send_email_notification` remains email-only; email-only calls do not create workbench notifications. Both tools have real external effects: never send credentials or unauthorized project-sensitive content.
