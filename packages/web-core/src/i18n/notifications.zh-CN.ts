export const notificationsZhCN = {
  workbenchNotificationCenter: {
    recentSessions: '最近会话',
    noRecentSessions: '暂无最近会话',
    recentSessionsCount: '{count} 个进行中的会话',
    webPush: {
      title: '离线推送',
      summary: '所有设备上的工作台都离线时，向当前设备发送通知。实际送达受浏览器和系统限制。',
      generic: { title: 'MyAgentRoam', body: '打开工作台查看通知。' },
      loading: '正在检查离线推送…',
      unsupported: '当前浏览器环境不支持离线推送。',
      systemDisabled: '管理员未开启离线推送。',
      serverUnavailable: '服务器尚未配置离线推送，请联系管理员。',
      actionRequired: '请为当前浏览器启用离线推送；iOS 请从主屏幕打开应用。',
      ready: '当前浏览器离线推送已就绪，不保证送达。',
      disabled: '当前浏览器离线推送已关闭。',
      unavailable: '离线推送同步失败，请登录后重试；关闭后本地仍会隐藏账号内容。',
      enable: '启用 / 重试离线推送',
      disable: '关闭离线推送'
    },
    webPushConfiguration: {
      title: 'Web Push 离线推送',
      description:
        '允许用户为移动端开启离线推送。同一账号任意工作台连接在线时不发送 Push；不影响站内通知、在线系统通知或邮件。实际送达受浏览器、系统和网络限制。'
    },
    systemNotifications: {
      title: '系统通知',
      onlineTitle: '系统通知',
      enable: '开启系统通知',
      disable: '关闭系统通知',
      summary: '切换到其他页面或应用时，仍可收到通知。关闭工作台后不再提醒。',
      enabled: '已开启',
      disabled: '未开启',
      denied: '通知权限已被拒绝，请在浏览器通知设置中允许当前网站。',
      insecure: '系统通知需要 HTTPS 或受信任的 localhost 地址。',
      unsupported: '当前浏览器不支持通过 Service Worker 显示系统通知。',
      unavailable: '系统通知暂不可用，请刷新页面后重试。'
    },
    recentRunTitle: '{value0}: {value1}',
    runningElapsed: '运行时间 {duration} 启动于 {startedAt}',
    runStatus: {
      STARTING: '启动中',
      RUNNING: '运行中',
      CANCELLING: '停止中',
      SUCCEEDED: '已完成',
      FAILED: '失败',
      CANCELLED: '已取消',
      INTERRUPTED: '已中断'
    }
  },
  generated: {
    workspaceUploadService: {
      uploading: '上传中',
      uploadingDirect: '局域网直连上传',
      uploadingServer: 'Server 中继上传',
      uploadingServerFallback: 'Server 中继上传',
      queued: '排队中',
      completed: '已完成',
      canceled: '已取消',
      interrupted: '已中断',
      failed: '失败',
      selectTheOriginalFileWithTheSame: '请选择与中断任务同名且大小相同的原文件'
    },
    workbenchNotificationService: {
      fileUploadFailed: '文件上传失败',
      fileUploadCompleted: '文件上传完成',
      uploadingFile: '文件上传中',
      runCompleted: '运行已完成',
      runFailed: '运行失败',
      runCancelled: '运行已取消',
      runInterrupted: '运行已中断',
      clickToOpenTheRelatedSession: '点击查看相关会话。',
      approvalRequired: '需要审批',
      theAgentIsWaitingForYourConfirmation: 'Agent 正等待你的确认。',
      planReadyToImplement: '计划可实施',
      openTheSessionToViewTheImplementation: '点击打开会话并查看执行入口。',
      yourAnswerIsRequired: '需要你的回答',
      theAgentIsWaitingForYourAnswer: 'Agent 正等待你的回答。',
      session: '会话：{value0} · {value1}'
    },
    workbenchNotificationCenter: {
      openNotificationCenter: '打开通知中心',
      notificationCenter: '通知中心',
      notifications: '通知',
      markAllRead: '全部标记已读',
      clearAll: '清空全部',
      fileTransfers: '文件传输',
      resume: '恢复',
      retry: '重试',
      delete: '删除 {value0}',
      cancel: '取消',
      noNotifications: '暂无通知',
      unread: '未读',
      deleteNotification: '删除通知 {value0}'
    }
  }
} as const;
