export const composerEnUS = {
  composerReference: {
    picker: 'Reference files or sessions',
    file: 'Files',
    session: 'Sessions',
    fileUnavailable: 'File search is unavailable.',
    enterPath: 'Type a path to search files and folders.',
    fileError: 'File search failed. Change the query to try again.',
    sessionLoading: 'Searching sessions…',
    sessionUnavailable: 'Session search is unavailable.',
    sessionError: 'Session search failed. Change the query to try again.',
    noSessions: 'No matching sessions.',
    refine: 'More results available. Refine your search.'
  },
  composerSend: {
    steer: 'Steer',
    holdHint: 'Slide up to steer. Move above the Composer to cancel.',
    holdSendHint: 'Slide up, then release to send. Move above the Composer to cancel.',
    slideToSteer: 'Slide up to steer · Above the Composer cancels',
    releaseToSteer: 'Release to steer · Above the Composer cancels',
    releaseToSend: 'Release to send · Above the Composer cancels',
    releaseToCancel: 'Release to cancel'
  },
  quickPrompts: {
    loadFailed: 'Unable to load quick prompts. Try again.',
    noMatches: 'No matching quick prompts.',
    picker: 'Quick Prompts'
  },
  goal: {
    title: 'Goal',
    view: 'View',
    edit: 'Edit',
    clear: 'Remove',
    update: 'Update',
    cancel: 'Cancel',
    detailsTitle: 'Goal details',
    objectiveLabel: 'Objective',
    turnsLabel: 'Executions',
    revisionLabel: 'Objective revision',
    alreadyActive: 'Goal mode is already active.',
    removedSummary:
      'Goal removed; the current execution was not interrupted. Elapsed {value0}, {value1} turns started.',
    stoppedSummary: 'Run stopped and Goal removed. Elapsed {value0}, {value1} turns started.'
  },
  runnerProfiles: {
    marAgentAccessAutoLabel: 'Auto',
    marAgentAccessAuto:
      'Continue authorized work automatically; ask when material risk or authorization remains unclear. Not a sandbox or independent safety reviewer.',
    marAgentAccessFullLabel: 'Full access',
    codexAccessOnRequestLabel: 'On-request',
    codexAccessWorkspaceWriteLabel: 'Workspace write',
    codexAccessFullLabel: 'Full access',
    codexAccessReadOnlyLabel: 'Read-only',
    claudeAccessDefaultLabel: 'Default',
    claudeAccessAcceptEditsLabel: 'Accept edits',
    claudeAccessBypassLabel: 'Bypass permissions',
    planModeLabel: 'Plan Mode',
    openCodeAccessDefaultLabel: 'Default',
    openCodeAccessAutoLabel: 'Auto approve',
    marAgentAccessFull:
      'Run tools without per-call Agent approval. Host validation remains active, and no Agent sandbox is provided.',
    marAgentCompact: 'Compact the current session context immediately.',
    marAgentPlan: 'Turn collaborative Plan Mode on or off.',
    marAgentClear: 'Permanently clear this session history while keeping the session.',
    codexAccessOnRequest: 'Codex asks for confirmation when additional permission is required.',
    codexAccessWorkspaceWrite: 'Allow Codex to write files in the current Workspace.',
    codexAccessFull: 'Allow Codex to run with full access without individual confirmations.',
    codexAccessReadOnly: 'Restrict Codex to a read-only sandbox.',
    codexCompact: 'Compact the current session context immediately.',
    codexPlan: 'Turn collaborative Plan Mode on or off.',
    codexFast: 'Turn the fast service tier on or off when supported by the model.',
    claudeAccessDefault: 'Confirm risky operations according to Claude Code defaults.',
    claudeAccessAcceptEdits: 'Automatically accept file edits in the current Workspace.',
    claudeAccessBypass: 'Bypass Claude Code permission confirmations.',
    claudeAccessPlan:
      'Explore with read-only tools in Claude Code Plan Mode without editing source files.',
    claudeCompact: 'Compact the current session context through the Claude Agent SDK.',
    claudePlan: 'Turn read-only tagged Plan Mode and its plan card on or off.',
    openCodeAccessDefault: 'Confirm permissions according to OpenCode and Workspace configuration.',
    openCodeAccessAuto: 'Automatically allow tool permissions requested by OpenCode.',
    openCodeCompact: 'Compact the current session context through OpenCode.',
    openCodePlan: 'Turn the native OpenCode Plan Agent on or off.',
    goal: 'Enter persistent Goal mode.'
  },
  common: {
    loading: 'Loading',
    runner: 'Agent',
    fast: 'Fast',
    reasoning: 'Reasoning',
    model: 'Model',
    marAgent: 'MAR Agent',
    codex: 'Codex',
    claudeCode: 'Claude Code',
    openCode: 'OpenCode'
  },
  nodeMessages: {
    planDetail: 'Subsequent messages run in read-only Plan Mode and produce a plan card.',
    implement: 'Implement',
    implementPrompt: 'Implement the plan above.'
  },
  composer: {
    quote: 'Quote',
    previewQuote: 'Preview quote: {name}',
    expandQuote: 'Expand quote',
    collapseQuote: 'Collapse quote',
    selectAll: 'Select all',
    removeQuote: 'Remove quote {name}',
    quoteAssistant: 'Reply excerpt',
    quoteStreaming: 'In-progress excerpt',
    quoteHistory: 'History',
    quoteToolChange: 'This change',
    quoteWorkingTree: 'Working tree',
    quoteUnsaved: 'Unsaved edits',
    quoteTooLarge: 'Cannot add this quote. Select less text or remove some references.',
    skillUnavailableToken: 'Skill {name} is unavailable; click to remove it',
    removeSkill: 'Remove skill {name}',
    removeFileReference: 'Remove file reference {name}',
    removeSessionReference: 'Remove Session reference {name}',
    skillUnavailable: 'A selected skill is no longer available. Remove it and try again.'
  },
  generated: {
    composerAttachments: {
      directTransport: 'Direct LAN connection',
      serverTransport: 'Server relay',
      serverFallbackTransport: 'Server relay',
      enlargeAttachment: 'Enlarge attachment {value0}',
      enlarge: 'Enlarge {value0}',
      uploading: 'Uploading…',
      uploading2: 'Uploading',
      uploaded: 'Uploaded',
      uploadFailed: 'Upload failed',
      removeAttachment: 'Remove attachment {value0}',
      removeAttachment2: 'Remove attachment {value0}'
    },
    composerCommandPicker: {
      loadingRunnerCommands: 'Loading Agent commands…',
      runnerCommandsFailedToLoadTypeAgain: 'Agent commands failed to load. Type / again to retry.',
      loadingSkills: 'Loading skills…',
      skillsFailedToLoadTypeAgain: 'Skills failed to load. Type / again to retry.',
      noAvailableCommandsOrSkills: 'No available commands or skills.',
      thisRunnerHasNoAvailableSlashCommands: 'This Agent has no available slash commands.',
      commandsAndSkills: 'Commands and skills',
      runnerCommands: 'Commands',
      skills: 'Skills'
    },
    composerQueue: {
      pendingWork: 'Pending work',
      goalType: 'Goal',
      queueType: 'Queue {position}',
      paused: 'Paused',
      save: 'Save',
      edit: 'Edit',
      runNow: 'Steer',
      moveUp: 'Move up',
      moveDown: 'Move down',
      delete: 'Remove'
    },
    composerToolbar: {
      addAttachment: 'Add attachment',
      addAttachment2: 'Add attachment',
      fastModeIsEnabled: 'Fast Mode is enabled',
      modelAndReasoningEffort: 'Model and reasoning effort',
      access: 'Access',
      viewContextUsageClickToCompactContext: 'Click to compact context',
      compactUnavailable: 'Context compaction is currently unavailable.',
      enterToQueueCtrlEnterToStop: '{send} to queue · {steer} to steer',
      enterToSendShiftAltEnterFor: '{send} to send · Shift/Alt + Enter for a new line',
      stopRun: 'Stop run',
      stopping: 'Stopping',
      stopRunEsc: 'Stop run ({stop})',
      send: 'Send',
      send2: 'Send'
    },
    conversationComposer: {
      message: 'Message'
    },
    conversationDomain: {},
    workbenchSessionMessageService: {
      enterAMessageWhenAttachingFiles: 'Enter a message when attaching files.',
      attachmentsAreStillUploadingOrFailedWait:
        'Attachments are still uploading or failed. Wait for completion before sending.',
      sendARegularMessageToCreateThe:
        'Send a regular message to create the session before running this command.',
      selectAWorkspaceBeforeSendingAMessage: 'Select a workspace before sending a message.',
      unableToSendTheMessage: 'Unable to send the message: {value0}',
      clearSessionConfirmation:
        'This permanently clears all conversation history and context in the current session. The session title and configuration are kept. Continue?',
      clearSession: 'Clear Session',
      confirmClearSession: 'Clear session',
      cancelClearSession: 'Cancel'
    },
    workspaceQueueService: {
      theQueueOrderChangedTryAgain: 'The queue order changed. Try again: {value0}',
      unableToReorderTheQueuedMessages: 'Unable to reorder the queued messages: {value0}',
      unableToEditTheQueuedMessage: 'Unable to edit the queued message: {value0}',
      unableToDeleteTheQueuedMessage: 'Unable to delete the queued message: {value0}',
      unableToRunTheQueuedMessageNow: 'Unable to run the queued message now: {value0}'
    },
    conversationUserInputService: {
      answerEveryQuestionBeforeSubmitting: 'Answer every question before submitting.',
      answersWereNotSubmitted: 'Answers were not submitted: {value0}'
    },
    workbenchApprovalService: { approvalWasNotSubmitted: 'Approval was not submitted: {value0}' },
    workbenchRunnerChannelService: {
      theMessageWasAddedToTheCurrent: 'The message was added to the current Claude turn.',
      theMessageWasNotDeliveredToThe: 'The message was not delivered to the current Claude turn.',
      unableToSendThroughTheClaudeChannel: 'Unable to send through the Claude channel: {value0}'
    },
    workbenchContextCommandService: {
      compactOlderContextToFreeWindowSpace:
        'Compact older context to free window space while preserving recent conversation and required summaries. Continue?',
      compactContext: 'Compact Context',
      compact: 'Compact',
      cancel: 'Cancel',
      unableToCompactContext: 'Unable to compact context: {value0}'
    },
    workbenchPlanService: { unableToImplementThePlan: 'Unable to implement the plan: {value0}' },
    workbenchRunControlService: {
      runOperationDenied: 'Run operation denied: {value0}',
      runOperationDenied2: 'Run operation denied: {value0}'
    },
    composerAttachmentService: {
      theFirstMessageCanIncludeUpTo: 'The first message can include up to 5 files.',
      attachmentMustBeLargerThan0And:
        'Attachment “{value0}” must be larger than 0 and no larger than 5 MiB.',
      totalAttachmentSizeCannotExceed10MiB: 'Total attachment size cannot exceed 10 MiB.',
      selectAnOnlineWorkspaceBeforeAddingAttachments:
        'Select an online workspace before adding attachments.'
    },
    runnerProfileService: {
      unableToSaveTheNodeDefaultSession:
        'Unable to save the node default session configuration: {value0}'
    },
    workbenchComposerController: {
      unableToUpdateTheSessionConfiguration: 'Unable to update the session configuration: {value0}'
    }
  }
} as const;
