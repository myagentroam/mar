export type WorkspaceFileTabKind =
  | 'WORKTREE_TEXT'
  | 'WORKTREE_DIFF'
  | 'HISTORY_DIFF'
  | 'HISTORY_TEXT'
  | 'WORKTREE_PREVIEW'
  | 'TOOL_CHANGE_DIFF';

export interface WorkspaceFileTab {
  readonly id: number;
  readonly identity: string;
  readonly kind: WorkspaceFileTabKind;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly fileName: string;
  readonly repositoryPath: string;
  readonly worktreePath: string;
  readonly commit?: string;
  readonly previousPath?: string;
  readonly refs?: readonly string[];
  readonly paths?: readonly string[];
  readonly previewKind?:
    | 'IMAGE'
    | 'PDF'
    | 'DOCUMENT'
    | 'SPREADSHEET'
    | 'PRESENTATION'
    | 'VIDEO'
    | 'AUDIO'
    | 'UNSUPPORTED';
  readonly targetLine?: number;
  readonly targetColumn?: number;
  readonly toolChange?: {
    readonly scope: 'SESSION' | 'HOSTED';
    readonly sessionId: string;
    readonly changeId: string;
    readonly diff: Extract<import('@myagentroam/protocol').FileChangeDiff, { status: 'available' }>;
  };
}

export type WorkspaceFileOpenIntent = Omit<WorkspaceFileTab, 'id' | 'identity' | 'fileName'>;

export interface WorkspaceFileTabsSnapshot {
  readonly tabs: readonly WorkspaceFileTab[];
  readonly activeIdentity?: string;
}

export function workspaceFileTabIdentity(intent: WorkspaceFileOpenIntent): string {
  const repositoryPath = intent.repositoryPath ?? '';
  const worktreePath = intent.worktreePath ?? '';
  switch (intent.kind) {
    case 'TOOL_CHANGE_DIFF':
      return `tool-change\0${intent.nodeId}\0${intent.toolChange?.scope ?? ''}\0${intent.toolChange?.sessionId ?? ''}\0${intent.toolChange?.changeId ?? ''}\0${intent.toolChange?.diff.resourceRef ?? ''}`;
    case 'WORKTREE_TEXT':
      return `worktree-text\0${repositoryPath}\0${worktreePath}\0${intent.path}`;
    case 'WORKTREE_DIFF':
      return `worktree-diff\0${repositoryPath}\0${worktreePath}\0${intent.path}`;
    case 'HISTORY_DIFF':
      return `history-diff\0${repositoryPath}\0${intent.commit ?? ''}\0${intent.previousPath ?? ''}\0${intent.path}`;
    case 'HISTORY_TEXT':
      return `history-text\0${repositoryPath}\0${intent.commit ?? ''}\0${intent.path}`;
    case 'WORKTREE_PREVIEW':
      return `worktree-preview\0${repositoryPath}\0${worktreePath}\0${intent.path}`;
  }
}

export function workspaceFileTabName(path: string): string {
  return path.split('/').at(-1) ?? path;
}
