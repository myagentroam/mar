export interface WorkspaceFilePreviewContent {
  readonly path: string;
  readonly size?: number;
  readonly encoding: 'utf-8' | 'base64';
  readonly previewEncoding?: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly revision?: string;
}

export interface WorkspaceFilePreviewTarget {
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly repositoryPath?: string;
  readonly worktreePath?: string;
  readonly history?: {
    readonly commit: string;
    readonly repositoryPath: string;
    readonly refs: readonly string[];
  };
}
