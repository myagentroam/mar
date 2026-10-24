import type { FileHandle } from 'node:fs/promises';
import type { NodeAgentSession } from '../database.js';
import type { WorkspaceFileIndex } from '../workspace.js';

export interface WorkspaceWatch {
  readonly workspaceId: string;
  readonly watchId: string;
  readonly sessionHash: string;
  readonly workbenchConnectionId: string;
  readonly nodeGeneration: string;
  readonly prepareFiles?: boolean;
  expiresAt: number;
  readonly topics: {
    readonly sessions: boolean;
    readonly sessionGroup?: import('@myagentroam/protocol').SessionGroup;
    readonly changes: boolean;
    readonly files:
      { readonly path: string; readonly cursor?: string; readonly limit?: number } | undefined;
  };
  timer: NodeJS.Timeout;
}

export interface ActiveWorkspaceUpload {
  readonly id: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly workspacePath: string;
  readonly targetPath: string;
  readonly temporaryPath: string;
  readonly size: number;
  readonly overwrite: boolean;
  readonly directSha256?: string;
  writing?: boolean;
  cancelled?: boolean;
  readonly composerAttachment?: {
    readonly id: string;
    readonly name: string;
    readonly mime: string;
  };
  readonly handle: FileHandle;
  receivedBytes: number;
  readonly timer: NodeJS.Timeout;
}

export interface CompletedComposerAttachment {
  readonly id: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly targetPath: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly expiresAt: number;
  reserved: boolean;
  timer: NodeJS.Timeout | undefined;
}

export class WorkspaceDomainState {
  readonly uploads = new Map<string, ActiveWorkspaceUpload>();
  readonly composerAttachments = new Map<string, CompletedComposerAttachment>();
  readonly changesReads = new Map<string, Promise<unknown>>();
  readonly changesCache = new Map<
    string,
    { readonly value: unknown; readonly expiresAt: number }
  >();
  readonly changesVersions = new Map<string, number>();
  readonly fileIndexes = new Map<string, WorkspaceFileIndex>();
  readonly watches = new Map<string, Map<string, WorkspaceWatch>>();
  readonly watchRevisions = new Map<string, number>();
  watchSnapshotSequence = 0;
  readonly sessionWatchTimers = new Map<string, NodeJS.Timeout>();
  readonly sessionWatchSignatures = new Map<string, string>();
  readonly sessionWatchReads = new Map<string, Promise<void>>();
  readonly sessionCache = new Map<
    string,
    { readonly sessions: readonly NodeAgentSession[]; readonly expiresAt: number }
  >();
  readonly sessionCacheReads = new Map<string, Promise<readonly NodeAgentSession[]>>();
  readonly changesLimiter = new AsyncLimiter(3);
}

class AsyncLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active += 1;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.waiters.shift();
      if (next === undefined) this.active -= 1;
      else next();
    }
  }
}
