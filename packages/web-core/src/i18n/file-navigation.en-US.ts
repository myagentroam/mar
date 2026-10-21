export const fileNavigationEnUS = {
  workspaceDisplayFilter: { empty: 'No matching files or folders.' },
  settings: {
    iconThemeSeti: 'Seti',
    iconThemeMaterial: 'Material'
  },
  generated: {
    workspaceFileTree: {
      fileTree: 'File tree',
      moreActionsFor: 'More actions for {value0}',
      open: 'Open',
      openInNewWindow: 'Open in new window',
      download: 'Download',
      newFile: 'New file',
      newFolder: 'New folder',
      uploadFiles: 'Upload files',
      copyRelativePath: 'Copy relative path',
      rename: 'Rename',
      delete: 'Delete',
      loading: 'Loading…',
      loadMore: 'Load more'
    },
    quickOpenDialog: {
      quickOpen: 'Quick Open',
      resultTypes: 'Result types',
      all: 'All',
      workspace: 'Workspace',
      session: 'Session',
      symbol: 'Symbol',
      file: 'File',
      definition: 'Definition',
      reference: 'Reference',
      enterANameOrPath: 'Enter a name, path, or complete symbol…',
      searching: 'Searching…',
      preparing: 'Preparing the index…',
      failed: 'Search failed. Other available results remain usable.',
      unavailable: 'Unavailable for the current Workspace or Node.',
      timedOut: 'Waiting timed out. Background preparation may still be running; try again.',
      incomplete: 'Results are incomplete. Refine your query.',
      completeSymbolRequired:
        'Enter a complete symbol name, not a qualified name or partial expression.',
      details: 'Error details',
      retry: 'Retry',
      noMatches: 'No matching results'
    },
    composerFileReferencePicker: {
      referenceAFileOrFolder: 'Reference a file or folder',
      searchingFilesAndFolders: 'Searching files and folders…',
      folder: 'Folder',
      file: 'File',
      noMatchingPaths: 'No matching paths'
    }
  }
} as const;
