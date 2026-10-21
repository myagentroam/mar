export const hostingManagementEnUS = {
  conversationHostingEnablement: {
    title: 'Hosted conversations',
    enable: 'Enable hosted conversations',
    enabling: 'Enabling…',
    disable: 'Disable hosted conversations',
    disabling: 'Disabling…',
    availableHint:
      'Enabling this lets the Node persist its private configuration and initialize immediately, without a manual file edit.',
    enabledHint:
      'Hosted conversations are enabled. Node details can disable them when no Run is active or starting.',
    enabledUnavailableHint: 'Hosting is enabled, but the capability is unavailable ({code}).',
    organizationNodeRequired:
      'Only organization-owned Nodes can enable hosted conversations. This feature is unavailable for personal Nodes.',
    platformUnsupported: 'Hosted conversations can be enabled only on Linux Nodes.',
    nodeOffline: 'The Node must be online and enabled before hosting can be enabled.',
    readOnly: 'The current management state does not allow Node configuration changes.',
    stateUnknown: 'The Node did not report a confirmable hosted conversation configuration state.',
    enableConfirmTitle: 'Enable hosted conversations?',
    enableConfirm:
      'The Node will persist its private configuration and initialize hosted conversations immediately. Continue?',
    disableConfirmTitle: 'Disable hosted conversations?',
    disableConfirm:
      'This preserves the hosted directory, conversation history, and configured paths. Node rejects disablement while a Run is active or starting and never cancels it automatically. Continue?',
    enabled: 'Hosted conversations enabled.',
    enabledUnavailable: 'Hosting was enabled, but the capability is unavailable: {code}',
    enableFailed: 'Unable to enable hosted conversations.',
    disabled: 'Hosted conversations disabled.',
    disableActiveRuns:
      'A hosted Run is active or starting. Wait for it to finish, or have its user stop it, then disable hosting.',
    disableFailed: 'Unable to disable hosted conversations.'
  },
  conversationHostingMaintenance: {
    eyebrow: 'Hosted storage',
    title: 'Conversation storage maintenance',
    summary:
      'Capacity follows the filesystem that contains hosted conversations. Preview inactive candidates before permanently clearing them.',
    refresh: 'Refresh storage status',
    nodeOffline: 'The Node must be online and enabled to inspect hosted storage.',
    hostingUnavailable:
      'Hosted conversations are not available on this Node. Resolve the reported Node capability issue before running maintenance.',
    hostingUnavailableDetail: 'Node capability reason: {code}',
    loadFailed: 'Unable to load hosted storage status.',
    capacityAvailable: 'Capacity available',
    capacityHigh: 'Storage usage is high',
    capacityFull: 'New conversations paused',
    capacityAvailableHint: 'Filesystem usage is below 85%. New conversations can be created.',
    capacityHighHint:
      'Filesystem usage is at least 85%. Existing conversations remain available and new conversations can still be created.',
    capacityFullHint:
      'Filesystem usage is at least 95%. Existing conversations remain available, but new conversations are blocked.',
    capacityAria: 'Hosted conversation filesystem usage: {usage}',
    hostedStorage: 'Hosted conversation data',
    filesystemAvailable: 'Filesystem available / total',
    automaticCleanup: 'Automatic cleanup threshold',
    daysValue: '{days} days',
    measuredAt: 'Measured',
    cleanupTitle: 'Inactive conversation cleanup',
    cleanupSummary:
      'Preview returns only a count and reclaimable bytes. Execution rechecks every candidate before permanent deletion.',
    inactiveDays: 'Inactive days',
    rangeHint: 'Choose 1–365 days. The default automatic cleanup threshold is 60 days.',
    preview: 'Preview cleanup',
    permanentCleanup: 'Permanently clean up',
    previewResult: 'Current preview',
    candidateValue: '{count} candidates',
    reclaimableValue: 'Up to {bytes} reclaimable',
    lastCleanup: 'Last cleanup',
    deletedValue: '{count} deleted',
    cleanupResultDetail: '{bytes} released · {skipped} skipped after recheck',
    executeConfirmTitle: 'Permanently clean up inactive conversations?',
    executeConfirm:
      'The preview found {count} conversations inactive for more than {days} days and up to {bytes} reclaimable. Candidates will be rechecked and permanently deleted; this cannot be undone.',
    execute: 'Permanently clean up',
    cancel: 'Cancel',
    cleanupComplete: 'Inactive conversation cleanup completed.',
    previewFailed: 'Unable to preview inactive conversations.',
    executeFailed: 'Unable to complete inactive conversation cleanup.'
  }
} as const;
