export const personalSettingsEnUS = {
  modelUsage: {
    pagination: 'Usage record pages',
    updateRecords: 'Update records',
    recordsSnapshot: 'Records have not auto-refreshed to preserve your current view.',
    refreshDelayed: 'Refresh unavailable; retrying shortly',
    refreshed: 'Last refreshed: {time}',
    overviewScope: 'Current category · Unaffected by filters below',
    title: 'Personal usage',
    refresh: 'Refresh',
    last24Hours: 'Last 24 hours',
    last7Days: 'Last 7 days',
    tokens: 'Tokens',
    input: 'Input',
    output: 'Output',
    cache: 'Cache',
    cacheWithRate: '{tokens} ({rate})',
    requests: 'Requests',
    range: 'Time range',
    custom: 'Custom range',
    from: 'Start time',
    to: 'End time',
    runner: 'Runner',
    model: 'Model',
    all: 'All',
    mode: 'Mode',
    purpose: 'Purpose',
    trend: 'Usage over time',
    selected:
      'Filtered usage: Input {input} · Cache {cache} · Output {output} · Total tokens {tokens} · {requests} requests',
    timeZone: 'Time zone: {zone}',
    empty: 'No recorded requests in this range.',
    unknown: 'Unknown',
    chartData: 'View chart data',
    time: 'Time',
    inputTokens: 'Input tokens',
    outputTokens: 'Output tokens',
    totalTokens: 'Total tokens',
    distribution: 'Usage breakdown',
    metric: 'Metric',
    runners: 'By Runner',
    models: 'By model',
    records: 'Usage records',
    recordsHint: 'Newest completed requests first. Column sorting applies to this page only.',
    requestedModel: 'Requested model',
    actualModel: 'Returned model',
    sessionId: 'Session ID',
    runId: 'Execution ID',
    requestId: 'Request ID',
    responseId: 'Response ID',
    cacheReadTokens: 'Cache read tokens',
    cacheWriteTokens: 'Cache write tokens',
    reasoningTokens: 'Reasoning tokens',
    coverageLabel: 'Coverage',
    state: 'Status',
    loading: 'Loading usage…',
    retry: 'Could not load usage. Select Refresh to try again.',
    invalidRange: 'Choose a valid range of up to 90 days that does not end in the future.',
    runnerNames: {
      'mar-agent': 'MAR Agent',
      codex: 'Codex',
      'claude-code': 'Claude Code',
      opencode: 'OpenCode'
    },
    modes: {
      work: 'Work',
      conversation: 'Conversation'
    },
    purposes: {
      conversation: 'Conversation',
      compact: 'Compact',
      title: 'Title generation',
      prompt_completion: 'Composer Prediction',
      other: 'Other model request'
    },
    states: {
      running: 'Running',
      succeeded: 'Succeeded',
      failed: 'Failed',
      cancelled: 'Cancelled',
      interrupted: 'Interrupted'
    },
    coverages: {
      request: 'Request-level usage',
      partial: 'Partially observable'
    },
    roles: {
      root: 'Main task',
      subagent: 'Subagent'
    }
  },
  shortcutGroups: {
    workspace: 'Workspace and global',
    files: 'Files and previews',
    editing: 'Search and editing',
    composer: 'Messages and queue'
  },
  keyboardShortcuts: {
    platformHint:
      'On macOS, use Command instead of Ctrl for Workspace and file shortcuts, and Option instead of Alt. Workspace Ctrl+Tab and Ctrl+W combinations, and Composer and queue Ctrl+Enter, still use Control.',
    openNotificationCenter: 'Global: Open or close the notification center',
    cycleWorkspaceTabs: 'Workspace: Switch to the previous or next tab (wraps around)',
    cycleWorkspaceTabsWithCtrlTab: 'Workspace: Switch to the next or previous tab (wraps around)',
    selectWorkspaceTab: 'Workspace: Select a tab by number (0 selects the tenth)',
    openNewSession: 'Workspace: Create a new session',
    closeWorkspaceTab:
      'Workspace: Close the active unpinned tab (also in Composer; other inputs, terminal, and dialogs excluded)',
    closeAllWorkspaceTabs:
      'Workspace: Close all unpinned tabs (also in Composer; other inputs, terminal, and dialogs excluded)',
    openMarkdownPreview: 'Markdown/HTML file preview: Open rendered preview in a separate window',
    quickOpenWorkspaceFile: 'Workspace: Quick Open',
    openGitChanges: 'Workspace: Switch the Inspector to Git Changes',
    searchWorkspaceContent: 'Workspace: Search file contents',
    findInPreview: 'Text file preview or Diff: Find in the current content',
    selectEditorContent: 'Text editor: Select all content',
    toggleFileEditing: 'Text file or Diff: Toggle editing/read-only or open the text tab',
    previousPreviewLocation: 'File preview: Go back to the previous location',
    nextPreviewLocation: 'File preview: Go forward to the next location',
    replaceInEditor: 'Text editor: Open find and replace',
    saveEditor: 'Text editor: Save the current file',
    openEditorSymbols: 'Text file preview: Open the current file symbol list',
    focusWorkspaceTerminal: 'Workspace: Expand or collapse the selected terminal',
    openComposerModelMenu: 'Composer: Open the model menu',
    sendMessage: 'Composer: Send a message',
    composerNewline: 'Composer: Insert a newline',
    replaceRunningMessage: 'Composer: Stop the current run and prioritize the message',
    stopRun: 'Composer: Stop the current run',
    openFileReferences: 'Composer: Open file and folder references',
    openAgentCommands: 'Composer: Open available Agent commands',
    saveQueuedMessage: 'Queue editor: Save the edited message',
    runQueuedMessage: 'Queue editor: Execute the edited message',
    closeFileTab: 'File tabs: Close the active file tab',
    modelMenuGroup: 'Model menu: Switch between models and effort levels',
    openCompanionPreview: 'File tree or conversation file link: Open in a separate preview window',
    quickOpenNavigation:
      'Quick Open: Choose and open a Workspace, Session, symbol, or file, or close the dialog',
    quickOpenSeparatePreview:
      'Quick Open: Open the selected symbol or file in a separate preview window',
    fileTabNavigation: 'File tabs: Move between tabs or jump to the first or last tab',
    findMatchNavigation: 'Embedded find: Jump to the next or previous match',
    closeEmbeddedFind: 'Embedded find: Close the search bar',
    closeStandalonePreview: 'Separate file preview: Request to close the window'
  },
  common: {
    language: 'Language',
    localeUpdateFailed: 'Unable to save the language preference. Try again.'
  },
  settings: {
    about: 'About',
    version: 'Version',
    documentation: 'Help documentation',
    openDocumentation: 'Open documentation',
    thirdPartyOpenSourceSoftware: 'Third-party open-source software and notices',
    viewThirdPartyNotices: 'View Web third-party notices',
    thirdPartySummary:
      'Selected open-source components across the product; not a complete dependency inventory.',
    thirdPartyGroups: {
      web: {
        title: 'Web interface',
        components:
          'Vue · Element Plus · Vue I18n · xterm.js · Vue Office · markdown-it · markdown-it-task-lists · highlight.js · CodeMirror · Lezer · Mermaid · PDF.js · DOMPurify · GitHub Markdown CSS'
      },
      server: {
        title: 'Server',
        components: 'Fastify · mysql2 · Nodemailer · Web Push · ws · Undici · Zod'
      },
      execution: {
        title: 'Node and MAR Agent',
        components:
          'node-pty · node-datachannel · Playwright · QuickJS / quickjs-emscripten · MCP SDK'
      },
      tools: {
        title: 'Bundled tools',
        components: 'ripgrep · Universal Ctags'
      },
      icons: {
        title: 'Icons',
        components:
          'Visual Studio Code Seti File Icon Theme · Material Design Icons · Material Icon Theme'
      },
      computerUse: {
        title: 'Computer Use (optional, platform-dependent)',
        components: 'Python · PyAutoGUI · Pillow · PyObjC'
      }
    },
    thirdPartyDistributionNotices:
      'For Server, Node and optional runtimes, consult the license and notice files in the corresponding distributions. External Agents, SDKs and separately installed tools remain subject to their own terms.',
    appearance: 'Appearance',
    appearanceSummary:
      'Theme, icon theme, language, and the default file mode are stored only in this browser. The terminal keeps its dark color scheme.',
    theme: 'Theme',
    light: 'Light',
    dark: 'Dark',
    iconTheme: 'Icon theme',
    defaultFileMode: 'Default file mode',
    fileModeEdit: 'Edit',
    fileModeReadOnly: 'Read only'
  },
  quickPrompts: {
    title: 'Quick Prompts',
    summary: 'Type #phrase in the message editor to insert its prompt.',
    add: 'Add prompt',
    edit: 'Edit',
    remove: 'Delete',
    phrase: 'Phrase',
    phraseHint: 'For example: review',
    prompt: 'Prompt',
    empty: 'No quick prompts yet.',
    phraseRequired: 'Enter a phrase.',
    phraseInvalid: 'A phrase cannot contain whitespace or # and must be at most 80 characters.',
    promptRequired: 'Enter a prompt.',
    saved: 'Quick prompt saved.',
    saveFailed: 'Unable to save quick prompt: {value0}',
    removeConfirmation: 'Delete “{value0}”? This cannot be undone.',
    removed: 'Quick prompt deleted.',
    removeFailed: 'Unable to delete quick prompt: {value0}'
  },
  personalInstructions: {
    title: 'Personal Instructions',
    scopeHelp:
      'Configure additional guidance for later Agent runs by this account. Each run combines Common with the selected Agent guidance and does not modify AGENTS.md or CLAUDE.md on the workspace or Node.',
    common: 'Common',
    codex: 'Codex',
    claudeCode: 'Claude Code',
    openCode: 'OpenCode',
    marAgent: 'MAR Agent',
    prompt: 'Personal instructions',
    placeholder: 'Enter personal instructions for this scope',
    promptRequired: 'Enter personal instructions.',
    promptInvalid: 'Personal instructions must be at most 20,000 characters.',
    loadFailed: 'Unable to load personal instructions. Try again.',
    saved: 'Personal instructions saved.',
    saveFailed: 'Unable to save personal instructions: {value0}',
    clear: 'Clear',
    clearConfirmation: 'Clear the personal instructions for the current scope?',
    cleared: 'Personal instructions cleared.',
    clearFailed: 'Unable to clear personal instructions: {value0}'
  },
  generated: {
    settingsContent: {
      accountSecurity: 'Account Security',
      currentAccountAdminUpTo5Devices:
        'Current account: admin. Up to 5 devices can be signed in at once. Changing the password revokes existing sessions.',
      signInSessions: 'Sign-in sessions',
      signInSessions5: 'Sign-in Sessions ({value0}/5)',
      refreshSignInSessions: 'Refresh sign-in sessions',
      noActiveSignInSessions: 'No active sign-in sessions.',
      currentDevice: 'Current Device',
      signedInDevice: 'Signed-in Device',
      signedIn: 'Signed in',
      expires: 'Expires',
      signOut: 'Sign out',
      confirmSignOutSession: 'Sign out this session?',
      changePassword: 'Change Password',
      signOut2: 'Sign out',
      confirmSignOut: 'Sign out of this account?',
      changePassword2: 'Change Password',
      currentPassword: 'Current Password',
      enterCurrentPassword: 'Enter current password',
      currentPassword2: 'Current Password',
      newPassword: 'New Password',
      enterNewPassword: 'Enter new password',
      newPassword2: 'New Password',
      confirmNewPassword: 'Confirm New Password',
      enterTheNewPasswordAgain: 'Enter the new password again',
      confirmNewPassword2: 'Confirm New Password',
      cancel: 'Cancel',
      confirmChange: 'Confirm change',
      nodeRegistration: 'Node Registration',
      createAOneTimeTokenThenComplete:
        'Create a registration key, then register the device you want to connect.',
      viewNodeDeploymentAndAutoStartGuide: 'View Node deployment and auto-start guide',
      createOneTimeNodeRegistrationToken: 'Create registration key',
      keyboardShortcuts: 'Keyboard Shortcuts',
      theFollowingShortcutsAreAvailableInThe:
        'The following shortcuts are available in the current workbench.'
    }
  }
} as const;
