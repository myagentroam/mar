import type {
  WorkspaceDirectFileIdentity,
  WorkspaceDirectFileRange
} from '../service/workspace-direct-file-read-service.js';

export interface WorkspaceFilePreviewContent {
  readonly path: string;
  readonly size?: number;
  readonly encoding: 'utf-8' | 'base64';
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

type DownloadResult = 'COMPLETED' | 'UNAVAILABLE' | 'CANCELLED' | 'FAILED';

/** These ports are already bound to the host's authorized file transport. */
export interface WorkspaceFilePreviewTransfers {
  readonly directFileDownload?:
    | ((path: string, worktreePath?: string, repositoryPath?: string) => Promise<DownloadResult>)
    | undefined;
  readonly directFileObjectUrl?:
    | ((
        path: string,
        worktreePath?: string,
        repositoryPath?: string
      ) => Promise<string | undefined>)
    | undefined;
  readonly directFileReadRange?:
    | ((
        path: string,
        offset: number,
        length: number,
        worktreePath?: string,
        identity?: WorkspaceDirectFileIdentity,
        repositoryPath?: string
      ) => Promise<WorkspaceDirectFileRange | undefined>)
    | undefined;
  readonly directGitFileDownload?:
    | ((
        commit: string,
        path: string,
        repositoryPath: string,
        refs: readonly string[]
      ) => Promise<DownloadResult>)
    | undefined;
  readonly directGitFileObjectUrl?:
    | ((
        commit: string,
        path: string,
        repositoryPath: string,
        refs: readonly string[]
      ) => Promise<string | undefined>)
    | undefined;
  readonly directGitFileReadRange?:
    | ((
        commit: string,
        path: string,
        repositoryPath: string,
        refs: readonly string[],
        offset: number,
        length: number,
        identity?: WorkspaceDirectFileIdentity
      ) => Promise<Omit<WorkspaceDirectFileRange, 'offset'> | undefined>)
    | undefined;
}
