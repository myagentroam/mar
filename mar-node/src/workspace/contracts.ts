export interface WorkspaceSettings {
  readonly git?: {
    readonly preserveGitConfig?: boolean;
    readonly includeParentRepository?: boolean;
  };
}

export interface NodeWorkspace {
  readonly id: string;
  readonly path: string;
  readonly kind: 'DIRECTORY' | 'GIT_WORKSPACE';
  readonly gitSummary: unknown | null;
  readonly settings?: WorkspaceSettings;
  readonly preserveGitConfig?: boolean;
  readonly includeParentRepository?: boolean;
}

export interface WorkspaceFileEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: 'FILE' | 'DIRECTORY';
  readonly size: number | null;
  readonly modifiedAt: number | null;
  readonly score?: number;
}

export interface WorkspaceFilePage {
  readonly entries: readonly WorkspaceFileEntry[];
  readonly nextCursor: string | null;
  readonly truncated: boolean;
}

export interface WorkspaceFileSearchPage {
  readonly entries: readonly WorkspaceFileEntry[];
  readonly nextCursor: string | null;
  readonly truncated: boolean;
  readonly indexState?: 'BUILDING' | 'READY';
}
