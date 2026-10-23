import type { PublicError, WorkspaceGitTracking } from '@myagentroam/protocol';

export interface HistoryRef {
  readonly name: string;
  readonly displayName: string;
  readonly kind: 'LOCAL' | 'REMOTE';
  readonly hash: string;
  readonly current: boolean;
}

export interface HistoryCommit {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly subject: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly committedAt: number;
  readonly refs: readonly string[];
}

export interface HistoryFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly change: string;
}

export interface ChangeEntry {
  readonly repositoryPath: string;
  readonly repositoryName: string;
  readonly source: 'ROOT' | 'SUBMODULE' | 'WORKTREE';
  readonly worktreePath?: string;
  readonly path: string;
  readonly state: 'STAGED' | 'UNSTAGED' | 'UNTRACKED';
  readonly change: string;
  readonly diffAvailable: boolean;
}

export interface ChangeRepository {
  readonly repositoryPath: string;
  readonly repositoryName: string;
  readonly source: 'ROOT' | 'SUBMODULE' | 'WORKTREE';
  readonly worktreePath?: string;
  readonly physicalPath?: string;
  readonly current: boolean;
  readonly branch: string | null;
  readonly tracking?: WorkspaceGitTracking;
  readonly head?: string;
  readonly status?: 'CLEAN' | 'DIRTY' | 'UNAVAILABLE';
  readonly locked: boolean;
  readonly prunable: boolean;
  readonly error?: PublicError;
  readonly changes: readonly ChangeEntry[];
}

export interface GitWorktreeSummary {
  readonly directoryName: string;
  readonly branch: string | null;
  readonly head: string;
  readonly current: boolean;
  readonly status: 'CLEAN' | 'DIRTY' | 'UNAVAILABLE';
  readonly locked: boolean;
  readonly prunable: boolean;
}
