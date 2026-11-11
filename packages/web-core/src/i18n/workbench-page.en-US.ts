export const workbenchPageEnUS = {
  workbench: {
    recoverUpload: 'Select the original file for the interrupted upload',
    closeSidebar: 'Close sidebar',
    closeWorkspaceTools: 'Close workspace tools'
  },
  common: {
    loading: 'Loading…',
    retry: 'Retry',
    loadFailedRetry: 'Failed to load. Retry',
    webReady: 'Web Console ready'
  },
  navigation: {
    nodeManagement: 'Nodes',
    workspaceManagement: 'Workspaces',
    skillConfiguration: 'Skill Configuration',
    skillSources: 'Skill Sources',
    mcpSources: 'MCP Sources',
    secrets: 'Environment Secrets',
    marAgentModels: 'MAR Agent Models',
    configuration: 'System Configuration',
    system: 'System Information',
    nodes: 'Work',
    account: 'Account Security',
    personalInstructions: 'Personal Instructions',
    shortcuts: 'Keyboard Shortcuts',
    about: 'About'
  },
  webUpdate: {
    title: 'Application update available',
    message: 'Version v{value0} is available. Click to update and reload all application windows.',
    unavailable: 'The update is not ready to apply. Check for updates and try again.',
    displayModeLabel: 'Display mode',
    displayMode: { browser: 'Browser tab', standalone: 'Standalone PWA window' },
    offlineLabel: 'Application resource cache',
    offline: {
      preparing: 'Preparing application interface resources.',
      ready: 'The app shell is cached. Features still require a connection.',
      degraded: 'The app shell cache is unavailable. Connect and check for an update.',
      online: 'Application resources are loaded online only.'
    },
    check: 'Check for updates',
    apply: 'Apply update',
    reloadPrepared: 'Reload prepared version',
    usePrepared: 'Use prepared version',
    reloadAvailable: 'A prepared version can be reloaded in this window.',
    upToDate: 'No update is available.',
    available: 'An update is available.',
    checkFailed: 'Unable to check for updates. Try again when connected.'
  },
  generated: {
    workbenchSurface: {
      workspaceMetadataUnavailable: 'Workspace information is currently unavailable',
      retryWorkspace: 'Retry loading',
      registerWorkspace: 'Register Workspace',
      offlineWorkspace: 'Node offline. Waiting for reconnection.',
      connectionOffline: 'Offline. Waiting for reconnection.',
      selectAWorkspace: 'Select a Workspace',
      selectANodeInTheResourceExplorer:
        'Open a registered workspace directly from the resource explorer.',
      noNodeConnectedYetCreateARegistration:
        'No node connected yet? Create a registration key in Node management, start the node on the target machine, then return here.',
      openNodeManagement: 'Open Node management',
      openAWorkspace: 'Open a Workspace',
      selectAWorkspaceOnTheCurrentNode:
        'Open a workspace from the resource explorer or switch to an open tab.',
      agentConversation: 'Agent conversation',
      run: 'Run /{value0}',
      typeForCommandsToReferenceWorkspaceFiles:
        "Type / for commands, # for quick prompts, {'@'} to reference workspace files, folders, or Sessions, or add attachments and ask {value0}…",
      readOnlyInspector: 'Read-only inspector',
      workspace: 'Workspace'
    },
    workbenchSelectionStateService: { unknown: 'Unknown' },
    workbenchPageController: {
      noNodeSelected: 'No node selected',
      theNodeIsDisabledOnlyTheCurrent:
        'The node is disabled. Only the current workspace snapshot is available.',
      theNodeIsOfflineLoadedContentIs:
        'The node is offline. Loaded content is read-only and no control operations will be sent.',
      nodeWorkbenchCapabilitiesAreUnavailable:
        'Node Workbench capabilities are unavailable: {value0}.',
      unableToOpenTheSessionLinkedTo:
        'Unable to open the session linked to this notification: {value0}',
      aNewerInstanceWithTheSameIdentity:
        'A newer instance with the same identity has taken over this node. Terminals and unpersisted run state may have been reset.',
      receivedAnUnreadableLiveUpdate: 'Received an unreadable live update.',
      unknown: 'Unknown',
      unableToCreateARegistrationToken: 'Unable to create a registration key: {value0}',
      createANewSessionBranchBeforeThis:
        'Create a new session branch before this user message and prefill it. The original session and workspace files will not change.',
      createANewSessionBranchThatRetains:
        'Create a new session branch that retains the complete turn containing this agent message. The original session and workspace files will not change.',
      createSessionBranch: 'Create session branch',
      createBranch: 'Create branch',
      cancel: 'Cancel',
      sessionBranchCreated: 'Session branch created.',
      sessionBranchCreatedButLoadFailed:
        'The session branch was created, but could not be opened: {value0}',
      rollbackCompletedButLoadFailed:
        'The conversation was rolled back, but could not be reloaded: {value0}',
      unableToCreateSessionBranch: 'Unable to create a session branch: {value0}',
      rollbackConversationWarning:
        'This permanently deletes this user message and all later conversation history in the current session. Workspace files are not rolled back, and the message will be restored to the composer.',
      rollbackConversation: 'Rollback Conversation',
      confirmRollbackConversation: 'Rollback',
      unableToRollbackConversation: 'Unable to roll back the conversation: {value0}'
    }
  }
} as const;
