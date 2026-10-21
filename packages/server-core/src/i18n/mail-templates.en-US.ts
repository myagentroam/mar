export const mailTemplatesEnUS = {
  test: {
    name: 'Test email',
    subject: 'MyAgentRoam email test',
    body: 'A test email was sent to {{email}}.'
  },
  notification: {
    name: 'Notification email',
    defaultTitle: 'Email notification',
    previewTitle: 'Notification preview',
    subject: 'MyAgentRoam notification: {{title}}',
    body: '{{message}}'
  },
  legacyNotification: {
    name: 'Notification email',
    subject: 'MyAgentRoam Workspace notification',
    body: '{{userName}},\n\nNotification from {{workspaceName}}:\n{{message}}'
  },
  presentation: {
    footer: 'Sent by MyAgentRoam'
  }
} as const;
