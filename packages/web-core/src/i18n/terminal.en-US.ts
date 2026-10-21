export const terminalEnUS = {
  generated: {
    terminalTabView: {
      terminalCopyFailedCheckBrowserClipboardPermissions:
        'Terminal copy failed. Check browser clipboard permissions.',
      terminalPasteFailedCheckClipboardPermissions:
        'Terminal paste failed. Check clipboard permissions or use Ctrl+Shift+V.',
      copy: 'Copy',
      paste: 'Paste',
      clear: 'Clear',
      terminalOutput: 'Terminal output'
    },
    terminalDock: {
      nodeTerminal: 'Node terminal',
      workspaceTerminal: 'Terminal',
      newTerminal: 'New terminal',
      selectAnOnlineNodeFirst: 'Select an online node first.',
      theTargetNodeDoesNotProvideA: 'The target node does not provide a terminal.',
      unableToLoadTerminals: 'Unable to load terminals: {value0}',
      unableToCreateATerminal: 'Unable to create a terminal: {value0}',
      unableToCloseTheTerminal: 'Unable to close the terminal: {value0}',
      unableToReleaseTerminals: 'Unable to release {value0} terminals: {value1}',
      terminalProfile: 'Terminal Profile',
      terminalProfile2: 'Terminal Profile',
      collapseTerminal: 'Collapse terminal',
      expandTerminal: 'Expand terminal',
      collapseTerminal2: 'Collapse terminal',
      expandTerminal2: 'Expand terminal',
      collapseTerminal3: 'Collapse terminal',
      expandTerminal3: 'Expand terminal',
      list: '{value0} list',
      closeTerminal: 'Close terminal {value0}',
      newTerminal2: 'New terminal'
    },
    terminalRelayService: {
      terminalOccupiedRetrying:
        'Terminal still in use. Waiting for the old connection to release before reconnecting.',
      terminalConnectionLostReconnectingInSeconds:
        'Terminal connection lost. Reconnecting in {value0} seconds',
      reconnectingTerminal: 'Reconnecting terminal…',
      theTerminalWasTakenOverInAnother: 'The terminal was taken over in another page.',
      theTerminalRelayReturnedInvalidDataReconnecting:
        'The terminal relay returned invalid data. Reconnecting automatically.'
    }
  }
} as const;
