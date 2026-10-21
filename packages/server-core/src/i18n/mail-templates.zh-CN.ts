export const mailTemplatesZhCN = {
  test: {
    name: '测试邮件',
    subject: 'MyAgentRoam 邮件测试',
    body: '测试邮件已发送到 {{email}}。'
  },
  notification: {
    name: '通知邮件',
    defaultTitle: '邮件通知',
    previewTitle: '通知预览',
    subject: 'MyAgentRoam通知：{{title}}',
    body: '{{message}}'
  },
  legacyNotification: {
    name: '通知邮件',
    subject: 'MyAgentRoam 工作区通知',
    body: '{{userName}}，\n\n来自 {{workspaceName}} 的通知：\n{{message}}'
  },
  presentation: {
    footer: '由 MyAgentRoam 发送'
  }
} as const;
