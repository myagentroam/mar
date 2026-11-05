export const filePreviewEnUS = {
  filePreview: { loadFailed: 'Unable to load the file.' },
  common: {
    retry: 'Retry',
    save: 'Save',
    cancel: 'Cancel',
    gitDiff: 'Git Diff'
  },
  generated: {
    imagePreview: {
      loadFailed: 'The image could not be loaded.',
      viewOriginal: 'View original',
      retry: 'Retry'
    },
    gitDiffViewer: {
      gitDiffHasNoDisplayableTextContent: 'Git Diff has no displayable text content.',
      gitDiffLoadFailed: 'Git Diff failed to load.',
      retry: 'Retry',
      diffToolbar: 'Diff toolbar',
      previousFile: 'Previous file',
      previousFile2: 'Previous file',
      filesAvailable: '{value0} files available',
      nextFile: 'Next file',
      nextFile2: 'Next file',
      previousChange: 'Previous change',
      previousChange2: 'Previous change (↑)',
      changes: '{value0} changes',
      nextChange: 'Next change',
      nextChange2: 'Next change (↓)',
      closeDiffPreview: 'Close diff preview',
      diffPreviewActions: 'Diff preview actions',
      downloadDiff: 'Download diff',
      closeDiffPreview2: 'Close diff preview',
      binaryFilesDoNotSupportDiff: 'Non-text files do not support code comparison.',
      openFilePreview: 'Open file preview',
      filePreviewRequiresNewerNode: 'Upgrade the Node before previewing this file.',
      before: 'Before',
      after: 'After',
      before2: 'before',
      after2: 'after',
      before3: 'before',
      after3: 'after',
      theFileExceeds4MiBAndWas: 'The file exceeds 4 MiB and was not loaded for preview.',
      thisVersionDoesNotExist: 'This version does not exist.',
      thisBinaryFileTypeCannotBePreviewed:
        'This binary file type cannot be previewed in the browser.',
      theCurrentNodeVersionDoesNotSupport:
        'The current node version does not support binary Diff previews.',
      theCurrentNodeDidNotReturnThe:
        'The current node did not return the full new file. A limited unified Diff is shown below.',
      workingTree: 'Working Tree',
      showingTheFirst512KiB: 'Showing the first 512 KiB',
      fullWorkingTreeFile: 'Full working tree file',
      emptyFile: '(empty file)',
      diffCodeMinimap: 'Diff code minimap'
    },
    standaloneFilePreviewPage: {
      theFilePreviewURLIsInvalid: 'The file preview URL is invalid.',
      unableToReadTheFileCheckYour:
        'Unable to read the file. Check your sign-in state, node connection, and file permissions.'
    },
    filePreviewDialog: {
      filePreview: '{value0} file preview',
      readOnlyFile: 'Read-only file',
      downloadFile: 'Download file',
      closePreview: 'Close preview',
      filePreviewActions: 'File preview actions',
      downloadFile2: 'Download file',
      closePreview2: 'Close preview',
      codeEditorPreview: 'Code editor preview',
      onlyTheFirst512KiBIsShown:
        'Only the first 512 KiB is shown. Download reads the complete text file within Node limits.',
      filePreview2: '{value0} file preview',
      thisFileTypeCannotBePreviewedIn: 'This file type cannot be previewed.',
      previewFailedDownloadInstead: 'Unable to preview this file.',
      loadingPreview: 'Loading…',
      filePreviewTabs: 'File preview tabs'
    }
  },
  fileEditor: {
    openSource: 'Open source file',
    openSourceShortcut: 'Open source file (Ctrl/⌘+E)',
    edit: 'Edit file',
    editing: 'Editing',
    readOnly: 'Read-only file',
    encodingFallback: '{encoding} fallback; text may be inaccurate',
    saved: 'File saved.',
    saveFailed: 'Unable to save the file.',
    conflict: 'The file changed elsewhere. Reload it before editing again.',
    unsavedTitle: 'Unsaved changes',
    unsavedMessage: 'Closing will discard your unsaved changes. Continue?',
    symbols: 'Symbols',
    searchSymbols: 'Search symbols',
    noSymbols: 'No symbols',
    definitions: 'Definitions',
    references: 'References',
    files: 'Files',
    navigationResults: 'Navigation results',
    preparingNavigation: 'Preparing code navigation…',
    navigationLimited:
      'The symbol index has reached its size limit. Navigation results may be incomplete.',
    navigationUnavailable: 'Symbol indexing is unavailable on this Node.',
    noDefinition: 'No definitions or references found.'
  },
  filePreviewContext: {
    copy: 'Copy',
    paste: 'Paste',
    reload: 'Reload',
    clipboardFailed: 'Unable to access the clipboard.',
    reloadUnsaved: 'Reloading will discard your unsaved changes. Continue?'
  },
  markdownPreview: {
    open: 'Open Markdown preview',
    refresh: 'Refresh preview',
    settings: 'Markdown Preview Settings',
    watermarkEnabled: 'Show watermark',
    watermarkText: 'Watermark text',
    watermarkPlaceholder: 'Enter watermark text',
    watermarkRequired: 'Enter watermark text when the watermark is enabled.'
  },
  htmlPreview: {
    open: 'Run HTML preview',
    browser: 'Browser',
    preview: 'Preview',
    reload: 'Reload',
    source: 'Open source',
    external: 'Open in browser',
    savedVersion: 'Preview shows the saved version.',
    saving: 'Wait for file saving to finish before previewing.',
    trustedWarning:
      'Trusted code: this HTML shares the Console hostname, may access your signed-in permissions, and may send files to external sites.',
    isolatedWarning:
      'This HTML can run JavaScript, read files in its directory and subdirectories, and send them to external sites.',
    unavailable: 'Unable to start the HTML preview. Check file access and the preview origin.'
  },
  inlineFind: {
    label: 'Find in file',
    placeholder: 'Find',
    shortcutDescription: 'Find in a text file preview or Diff',
    previous: 'Previous match',
    next: 'Next match',
    close: 'Close find',
    replacePlaceholder: 'Replace with',
    selectAll: 'Select all matches',
    matchCase: 'Match case',
    regexp: 'Regular expression',
    wholeWord: 'Whole word',
    replace: 'Replace',
    replaceAll: 'Replace all'
  },
  gitDiffViewer: {
    mobileSummary: 'Diff summary',
    mobileFileSummary: 'Files {value0} / {value1}',
    mobileChangeSummary: 'Changes {value0} / {value1}',
    collapseMobileActions: 'Collapse diff actions',
    expandMobileActions: 'Expand diff actions'
  },
  filePreviewDialog: {
    closeFileWindow: 'Close file window',
    collapseMobileActions: 'Collapse file preview actions',
    expandMobileActions: 'Expand file preview actions'
  }
} as const;
