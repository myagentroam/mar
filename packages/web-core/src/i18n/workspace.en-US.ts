export const workspaceEnUS = {
  sessionGroups: {
    tree: 'View session tree',
    treeTruncated: 'The tree is limited to 100 sessions.',
    label: 'Session groups',
    main: 'Main Sessions',
    child: 'Child Sessions',
    mainTab: 'Main',
    childTab: 'Child',
    unread: 'Unread',
    running: '{count} running sessions',
    emptyMain: 'No main sessions',
    emptyChild: 'No child sessions',
    noResults: 'No matching sessions',
    move: 'Move to Main Sessions',
    confirm: 'Move',
    cancel: 'Cancel',
    description:
      "This only clears the session's group relationship with its parent and moves it to Main Sessions. Its history, active runs, and queue are preserved. Relationships of its own child sessions are unchanged.",
    moved: 'Moved to Main Sessions',
    failed: 'Unable to move the session: {reason}'
  },
  generated: {
    sessionPrompt: {
      title: 'Session Prompt',
      description:
        'Appended after your personal instructions for this session. Changes apply from the next execution, including queued messages and Goal continuation. They do not remove instructions already in the conversation history.',
      placeholder: 'Enter session-specific instructions. Leave blank and save to clear.',
      tooLong: 'Session Prompt cannot exceed 20,000 characters.',
      cancel: 'Cancel',
      save: 'Save'
    },
    workspaceRegistrationPicker: {
      enterADirectoryName: 'Enter a directory name',
      enterASingleDirectoryNameWithoutPath: 'Enter a single directory name without path separators',
      registerANewWorkspace: 'Register a New Workspace',
      goToParentDirectory: 'Go to parent directory',
      goToParentDirectory2: 'Go to parent directory',
      up: 'Up',
      roots: 'Roots',
      currentDirectory: 'Current Directory',
      refreshDirectory: 'Refresh directory',
      refreshDirectory2: 'Refresh directory',
      newDirectory: 'New directory',
      selectCurrentDirectory: 'Select current directory',
      pending: 'Pending',
      cancelNewDirectory: 'Cancel new directory',
      cancelNewDirectory2: 'Cancel new directory',
      outsideAllowedRoots: 'Outside Allowed Roots',
      open: 'Open {value0}',
      open2: 'Open {value0}',
      loadingAllowedRoots: 'Loading allowed roots…',
      expandAndSelectADirectoryToRegister: 'Expand and select a directory to register.',
      onlyTheFirst200ChildDirectoriesAre: 'Only the first 200 child directories are shown.',
      selected: 'Selected:',
      createAndRegister: 'Create and register',
      registerWorkspace: 'Register Workspace',
      newDirectory2: 'New Directory',
      directoryName: 'Directory Name',
      enterADirectoryName2: 'Enter a directory name',
      cancel: 'Cancel',
      confirm: 'Confirm'
    },
    workspaceRegistrationService: {
      unableToLoadAvailableDirectories: 'Unable to load available directories: {value0}',
      aDirectoryWithThisNameAlreadyExists:
        'A directory with this name already exists. Choose another name.',
      theDirectoryNameIsInvalidEnterA:
        'The directory name is invalid. Enter a single directory name.',
      theSelectedDirectoryIsOutsideTheWorkspace:
        'The selected directory is outside the workspace roots allowed by the node.',
      unableToRegisterTheWorkspace: 'Unable to register the workspace: {value0}'
    },
    workspaceSessionService: {
      unableToLoadMoreSessions: 'Unable to load more sessions: {value0}',
      unableToSynchronizeSessions: 'Unable to synchronize sessions: {value0}'
    },
    workbenchWorkspaceSelectionService: {
      thisWorkspaceIsNoLongerInThe:
        'This workspace is no longer in the target node snapshot and cannot be opened.',
      unableToLoadNodeWorkspaces: 'Unable to load node workspaces: {value0}',
      thisWorkspaceIsNoLongerInThe2:
        'This workspace is no longer in the target node snapshot and cannot be opened.',
      unableToRefreshNodeWorkspaces: 'Unable to refresh node workspaces: {value0}',
      thisWorkspaceIsNoLongerInThe3:
        'This workspace is no longer in the current node snapshot and cannot be opened.',
      unableToLoadTheNodeState: 'Unable to load the node state: {value0}'
    },
    workbenchSessionSelectionService: {
      unableToLoadConversationHistory: 'Unable to load conversation history: {value0}'
    },
    workbenchWorkspaceTreeController: {
      thisWorkspaceIsNoLongerInThe:
        'This workspace is no longer in the current node snapshot and cannot be opened.',
      unableToLoadNodeWorkspaces: 'Unable to load node workspaces: {value0}',
      unregisterThisDoesNotDeleteTheLocal:
        'Remove workspace “{value0}”? This does not delete the local directory and will be rejected while tasks are running.',
      unregisterWorkspace: 'Remove workspace',
      unregister: 'Remove workspace',
      cancel: 'Cancel',
      theWorkspaceWasUnregisteredItsLocalDirectory:
        'The workspace was removed. Its local directory was not deleted.',
      unableToUnregisterTheWorkspace: 'Unable to remove the workspace: {value0}'
    },
    workspaceTree: {
      filterNodeWorkspaces: 'Filter Nodes and Workspaces',
      noMatchingResources: 'No matching Nodes or Workspaces.',
      ungrouped: 'Ungrouped',
      expandWorkspaceGroup: 'Expand Workspace group {value0}',
      collapseWorkspaceGroup: 'Collapse Workspace group {value0}',
      moveWorkspaceToGroup: 'Move to Group',
      workspaceGroupName: 'Workspace group',
      workspaceGroupMovePlaceholder: 'Select an existing group or enter a new group',
      emptyWorkspaceGroupLeavesUngrouped:
        'Save with an empty value to remove this Workspace from its group.',
      workspaceGroupNameTooLong: 'Workspace group name cannot exceed 128 characters.',
      enterWorkspaceName: 'Enter a workspace name.',
      renameWorkspace: 'Rename workspace',
      workspaceNameRequired: 'Workspace name is required.',
      workspaceNameTooLong: 'Workspace name cannot exceed 255 characters.',
      save: 'Save',
      cancel: 'Cancel'
    }
  }
} as const;
