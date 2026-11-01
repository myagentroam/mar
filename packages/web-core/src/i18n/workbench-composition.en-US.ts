export const workbenchCompositionEnUS = {
  generated: {
    workbenchEntityService: {
      leaveBlankToDisplayTheRegisteredAddress: 'Leave blank to display the registered address.',
      renameNode: 'Rename node',
      nodeName: 'Node name',
      nodeNameCannotExceed80Characters: 'Node name cannot exceed 80 characters',
      save: 'Save',
      cancel: 'Cancel',
      unableToUpdateTheNodeName: 'Unable to update the node name: {value0}',
      enterANonEmptySessionName: 'Enter a non-empty session name.',
      renameSession: 'Rename session',
      sessionName: 'Session name',
      sessionNameCannotBeEmpty: 'Session name cannot be empty',
      sessionNameCannotExceed160Characters: 'Session name cannot exceed 160 characters',
      save2: 'Save',
      cancel2: 'Cancel',
      unableToUpdateTheSessionName: 'Unable to update the session name: {value0}',
      unableToTheSession: 'Unable to {value0} the session: {value1}',
      unableToMoveThePinnedSession: 'Unable to move the pinned session: {value0}',
      thisPermanentlyDeletesTheNativeSessionAnd:
        'This permanently deletes the native {value0} session “{value1}” and cannot be undone.',
      deleteSession: 'Delete session',
      deleteSession2: 'Delete session',
      cancel3: 'Cancel',
      theNativeSessionWasDeleted: 'The native session was deleted.',
      unableToDeleteTheSession: 'Unable to delete the session: {value0}',
      deletingDisconnectsItAndRemovesItsServer:
        'Deleting “{value0}” disconnects it and removes its server credentials and node record. The machine will need a new registration key to reconnect.',
      deleteNode: 'Delete Node',
      deleteNode2: 'Delete Node',
      cancel4: 'Cancel',
      nodeDeletedCreateANewRegistrationToken:
        'Node deleted. Create a new registration key to reconnect it.',
      unableToDeleteTheNode: 'Unable to delete the node: {value0}'
    },
    workbenchPresentationStateService: {
      contextWindow: 'Context Window: {value0}',
      gcCount: 'GC: {value0} · {value1} tokens',
      stopping: 'Stopping · {value0}'
    },
    workbenchPageInteractionService: {
      filePreviewIsCurrentlyUnavailable: 'File preview is currently unavailable.',
      copyFailedCheckTheBrowserClipboardPermission:
        'Copy failed. Check the browser clipboard permission.'
    },
    workbenchNewSessionController: {
      foldersCannotBeAttachedCompressTheFolder:
        'Folders cannot be attached. Compress the folder first.'
    },
    runnerUsageService: {
      usageCapabilityDetectionFailedCloseAndReopen:
        'Usage capability detection failed. Close and reopen Node Details to retry.',
      detectingUsageCapability: 'Detecting usage capability.',
      usageQueriesRequireAnOfficialOAuthAccount:
        'Usage queries require an official OAuth account. API keys and third-party API services are not supported.',
      thisRunnerIsUnavailableSoUsageCannot:
        'This Agent is unavailable, so usage cannot be queried.',
      thisRunnerDoesNotCurrentlySupportUsage:
        'This Agent does not currently support usage queries.',
      unableToQueryUsage: 'Unable to query usage: {value0}',
      notProvided: 'Not Provided'
    },
    workbenchCapabilityService: {
      unableToLoadNodes: 'Unable to load nodes: {value0}',
      unknown: 'Unknown',
      unknown2: 'Unknown'
    }
  },
  common: {
    ready: 'Ready',
    unavailable: 'Unavailable',
    unableToPinSession: 'Unable to pin the session: {reason}',
    unableToUnpinSession: 'Unable to unpin the session: {reason}'
  },
  workspace: {
    directory: 'Directory'
  },
  nodeMessages: {
    fiveHourLimit: '5-hour limit',
    sevenDayLimit: '7-day limit',
    sevenDaySonnetLimit: '7-day Sonnet limit',
    codexUsage: 'Codex Usage',
    claudeUsage: 'Claude Code Usage'
  }
} as const;
