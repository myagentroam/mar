export const workbenchNotificationMessages = {
  'zh-CN': {
    approval: { title: '需要确认', detail: '请打开' },
    plan: { title: '计划可实施', detail: '请打开' },
    userInput: { title: '需要你的回答', detail: '请打开' },
    schedule: {
      skipped: { title: '定时任务已跳过', detail: '请打开会话查看记录' },
      failed: { title: '定时任务运行失败', detail: '请打开会话查看记录' },
      proposal: { title: '定时任务有待确认修改', detail: '请打开会话查看' }
    },
    run: {
      succeeded: '运行已完成',
      failed: '运行失败',
      cancelled: '运行已取消',
      interrupted: '运行已中断',
      hostedDetail: '点击查看对话。',
      sessionDetail: '点击查看相关会话。',
      separator: '，'
    },
    titleSeparator: '：'
  },
  'en-US': {
    approval: { title: 'Approval required', detail: 'open it.' },
    plan: { title: 'Plan ready to implement', detail: 'open it.' },
    userInput: { title: 'Your answer is required', detail: 'open it.' },
    schedule: {
      skipped: { title: 'Scheduled task skipped', detail: 'open the session for details.' },
      failed: { title: 'Scheduled task failed', detail: 'open the session for details.' },
      proposal: { title: 'Scheduled task edit proposed', detail: 'open the session to review it.' }
    },
    run: {
      succeeded: 'Run completed',
      failed: 'Run failed',
      cancelled: 'Run cancelled',
      interrupted: 'Run interrupted',
      hostedDetail: 'Open the conversation.',
      sessionDetail: 'Open the related session.',
      separator: '. '
    },
    titleSeparator: ': '
  }
} as const;
