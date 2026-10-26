export const notificationsEnUS = {
  workbenchNotificationCenter: {
    recentSessions: 'Recent Sessions',
    noRecentSessions: 'No recent sessions',
    recentSessionsCount: '{count} active sessions',
    webPush: {
      title: 'Offline Push',
      summary:
        'Receive notifications on this device when all your workbenches are offline. Delivery depends on your browser and system.',
      generic: { title: 'MyAgentRoam', body: 'Open Console to check your notifications.' },
      loading: 'Checking offline Push availability…',
      unsupported: 'Offline Push is not supported in this browser environment.',
      systemDisabled: 'Offline Push is disabled by the administrator.',
      serverUnavailable:
        'This Server is not configured for offline Push. Contact your administrator.',
      actionRequired:
        'Enable offline Push for this browser. On iOS, open the app from the Home Screen.',
      ready: 'Offline Push is ready for this browser. Delivery is best effort.',
      disabled: 'Offline Push is disabled for this browser.',
      unavailable:
        'Offline Push could not be synchronized. Retry while signed in; disabling still hides account content locally.',
      enable: 'Enable / retry offline Push',
      disable: 'Disable offline Push'
    },
    webPushConfiguration: {
      title: 'Web Push notifications',
      description:
        'Let users enable offline Push on mobile devices. Any online workbench connection suppresses Push for that account, without affecting in-app notifications, online system notifications, or email. Delivery depends on the browser, operating system, and network.'
    },
    systemNotifications: {
      title: 'System notifications',
      onlineTitle: 'System notifications',
      enable: 'Enable system notifications',
      disable: 'Disable system notifications',
      summary:
        'Receive notifications when you switch to another page or app. Notifications stop when you close the workbench.',
      enabled: 'Enabled',
      disabled: 'Disabled',
      denied: 'Notifications are blocked. Allow this site in your browser notification settings.',
      insecure: 'System notifications require HTTPS or a trusted localhost origin.',
      unsupported: 'This browser does not support system notifications with a Service Worker.',
      unavailable: 'System notifications are unavailable. Reload the page and try again.'
    },
    recentRunTitle: '{value0}: {value1}',
    runningElapsed: 'Running for {duration} started {startedAt}',
    runStatus: {
      STARTING: 'Starting',
      RUNNING: 'Running',
      CANCELLING: 'Stopping',
      SUCCEEDED: 'Completed',
      FAILED: 'Failed',
      CANCELLED: 'Canceled',
      INTERRUPTED: 'Interrupted'
    }
  },
  generated: {
    workspaceUploadService: {
      uploading: 'Uploading',
      uploadingDirect: 'Uploading over direct LAN connection',
      uploadingServer: 'Uploading through Server relay',
      uploadingServerFallback: 'Uploading through Server relay',
      queued: 'Queued',
      completed: 'Completed',
      canceled: 'Canceled',
      interrupted: 'Interrupted',
      failed: 'Failed',
      selectTheOriginalFileWithTheSame:
        'Select the original file with the same name and size as the interrupted upload.'
    },
    workbenchNotificationService: {
      fileUploadFailed: 'File upload failed',
      fileUploadCompleted: 'File upload completed',
      uploadingFile: 'Uploading file',
      runCompleted: 'Run completed',
      runFailed: 'Run failed',
      runCancelled: 'Run canceled',
      runInterrupted: 'Run interrupted',
      clickToOpenTheRelatedSession: 'Click to open the related session.',
      approvalRequired: 'Approval required',
      theAgentIsWaitingForYourConfirmation: 'The Agent is waiting for your confirmation.',
      planReadyToImplement: 'Plan ready to implement',
      openTheSessionToViewTheImplementation: 'Open the session to view the implementation action.',
      yourAnswerIsRequired: 'Your answer is required',
      theAgentIsWaitingForYourAnswer: 'The Agent is waiting for your answer.',
      session: 'Session: {value0} · {value1}'
    },
    workbenchNotificationCenter: {
      openNotificationCenter: 'Open notification center',
      notificationCenter: 'Notification center',
      notifications: 'Notifications',
      markAllRead: 'Mark all as read',
      clearAll: 'Clear all',
      fileTransfers: 'File transfers',
      resume: 'Resume',
      retry: 'Retry',
      delete: 'Delete {value0}',
      cancel: 'Cancel',
      noNotifications: 'No notifications',
      unread: 'Unread',
      deleteNotification: 'Delete notification {value0}'
    }
  }
} as const;
