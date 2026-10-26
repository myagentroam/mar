import type { NodeOperationHandler } from '../connector/node-operation-router.js';
import { createHash } from 'node:crypto';
import { isAbsolute, win32 } from 'node:path';
import type { DirectTransferDescriptor } from '@myagentroam/protocol';
import type { NodeWorkspace } from '../database.js';
import type { WorkspaceInspection } from '../workspace.js';
import {
  listGitHistoryRefs,
  normalizeFilePreviewPath,
  openGitHistoryFileContent,
  readGitHistory,
  readGitHistoryFileDiff,
  readGitHistoryFileContentRange,
  readGitHistoryFiles,
  readCurrentChangeDiff,
  readRestrictedDiff,
  resolveGitRepository,
  resolveGitRepositoryTarget,
  resolveWorkspaceGitRoot,
  restoreCurrentChange
} from '../workspace.js';
import { WorkspaceChangeService } from './workspace-change-service.js';
import { WorkspaceCodeNavigationService } from './workspace-code-navigation-service.js';
import { WorkspaceContentSearchService } from './workspace-content-search-service.js';
import { WorkspaceFileService } from './workspace-file-service.js';
import { WorkspaceUploadService } from './workspace-upload-service.js';
import { WorkspaceWatchController } from './workspace-watch-controller.js';
import { WorkspaceWatchService } from './workspace-watch-service.js';
import {
  WorkspaceWatchSnapshotService,
  type WorkspaceWatchTopic
} from './workspace-watch-snapshot-service.js';

export interface WorkspaceWorkbenchServiceOptions {
  readonly requireWorkspace: (workspaceId: unknown) => NodeWorkspace;
  readonly inspectWorkspace: (workspace: NodeWorkspace) => Promise<WorkspaceInspection>;
  readonly commitWorkspace: (
    workspace: NodeWorkspace,
    inspection: WorkspaceInspection
  ) => Promise<NodeWorkspace>;
  readonly watch: WorkspaceWatchService;
  readonly files: WorkspaceFileService;
  readonly uploads: WorkspaceUploadService;
  readonly changes: WorkspaceChangeService;
  readonly listSessions: (
    workspaceId: string,
    sessionGroup?: import('@myagentroam/protocol').SessionGroup
  ) => Promise<unknown>;
  readonly invalidate: (workspaceId: string) => void;
  readonly nodeId: () => string;
  readonly nodeGeneration: () => string;
  readonly emitWatchEvent: (payload: unknown) => void;
}

export class WorkspaceWorkbenchService {
  private readonly contentSearch: WorkspaceContentSearchService;
  private readonly codeNavigation: WorkspaceCodeNavigationService;
  private readonly snapshots: WorkspaceWatchSnapshotService;
  private readonly watchController: WorkspaceWatchController;

  constructor(private readonly options: WorkspaceWorkbenchServiceOptions) {
    this.contentSearch = new WorkspaceContentSearchService(options.files);
    this.codeNavigation = new WorkspaceCodeNavigationService({
      files: options.files,
      nodeId: options.nodeId,
      searchContent: (workspace, query) => this.contentSearch.search(workspace, { query })
    });
    this.snapshots = new WorkspaceWatchSnapshotService(options);
    this.watchController = new WorkspaceWatchController({
      requireWorkspace: options.requireWorkspace,
      watch: options.watch,
      snapshots: this.snapshots,
      nodeGeneration: options.nodeGeneration
    });
  }

  cancelFilePrewarm(watch: import('./workspace-domain-state.js').WorkspaceWatch): void {
    this.snapshots.cancelFilePrewarm(watch);
    this.options.files.prunePreparations();
  }

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      ...this.watchController.operations(),
      'workspace.files.list': (data) => this.listFiles(record(data)),
      'workspace.file.read': (data) => this.readFile(record(data)),
      'workspace.file.write': (data) => this.writeFile(record(data)),
      'workspace.file.content.read': (data) => this.readFileContent(record(data)),
      'workspace.file.direct.metadata': (data) => this.directFileMetadata(record(data)),
      'workspace.files.search': (data) => this.searchFiles(record(data)),
      'workspace.files.mutate': (data) => this.mutateFile(record(data)),
      'workspace.files.reveal': (data) => {
        const input = record(data);
        return this.options.files.reveal(this.options.requireWorkspace(input.workspaceId), input);
      },
      'workspace.content.search': (data) => this.searchContent(record(data)),
      'workspace.symbol.prepare': (data) => this.prepareSymbolIndex(record(data)),
      'workspace.symbol.definition': (data) => this.symbolDefinition(record(data)),
      'workspace.files.upload.preflight': (data) => this.preflight(record(data)),
      'workspace.files.upload.create': (data) => this.createUpload(record(data)),
      'workspace.files.upload.chunk': (data) => this.writeUpload(record(data)),
      'workspace.files.upload.status': (data) => ({
        upload: this.options.uploads.status(record(data).uploadId)
      }),
      'workspace.files.upload.complete': (data) => this.completeUpload(record(data)),
      'workspace.files.upload.cancel': (data) => this.cancelUpload(record(data)),
      'workspace.changes.current': (data) => this.currentChanges(record(data)),
      'workspace.change.diff': (data) => this.changeDiff(record(data)),
      'workspace.change.restore': (data) => this.restoreChange(record(data)),
      'workspace.git.refs.list': (data) => this.gitRefs(record(data)),
      'workspace.git.history.list': (data) => this.gitHistory(record(data)),
      'workspace.git.commit.files': (data) => this.gitCommitFiles(record(data)),
      'workspace.git.commit.file.diff': (data) => this.gitCommitFileDiff(record(data)),
      'workspace.git.commit.file.content.read': (data) => this.gitCommitFileContent(record(data)),
      'workspace.git.commit.file.direct.metadata': (data) =>
        this.gitCommitFileDirectMetadata(record(data)),
      'workspace.diff': (data) => this.diff(record(data))
    };
  }

  invalidateTopic(workspaceId: string, topic: WorkspaceWatchTopic): Promise<void> {
    return this.snapshots.invalidate(workspaceId, topic);
  }

  ensureTopicSnapshot(workspaceId: string, topic: WorkspaceWatchTopic): Promise<void> {
    return this.snapshots.ensureSnapshot(workspaceId, topic);
  }

  /** Node-owned file mutations must not reuse a generation's old candidate list. */
  invalidateWorkspaceFiles(workspaceId: string): void {
    this.codeNavigation.invalidate(workspaceId);
  }

  /** Releases page-watch state without discarding the durable code index. */
  releaseWorkspace(workspaceId: string): void {
    this.snapshots.clear(workspaceId);
  }

  /** Removes all Workspace state after the Workspace itself is unregistered. */
  clearWorkspace(workspaceId: string): void {
    this.releaseWorkspace(workspaceId);
    this.codeNavigation.forget(workspaceId);
  }

  clear(): void {
    this.snapshots.clearAll();
  }

  private async listFiles(input: Record<string, unknown>): Promise<unknown> {
    const workspace = this.options.requireWorkspace(input.workspaceId);
    if (input.cursor !== undefined || (input.path !== undefined && input.path !== '.'))
      return { files: await this.options.files.list(workspace, input) };
    const inspection = await this.options.inspectWorkspace(workspace);
    const files = await this.options.files.list(workspace, input);
    return {
      files,
      workspace: await this.options.commitWorkspace(workspace, inspection)
    };
  }
  async readPredictionFile(
    workspaceId: string,
    path: string,
    worktreePath?: string
  ): Promise<unknown> {
    const workspace = this.options.requireWorkspace(workspaceId);
    const repository = await this.fileRepository(
      workspace,
      worktreePath ? { worktreePath, path } : {}
    );
    const { readWorkspaceTextFile } = await import('../workspace.js');
    return readWorkspaceTextFile(repository, path, 0, 64 * 1024);
  }

  private async readFile(input: Record<string, unknown>): Promise<unknown> {
    const workspace = this.options.requireWorkspace(input.workspaceId);
    const repository = await this.fileRepository(workspace, input);
    return { file: await this.options.files.read(workspace, input, repository) };
  }
  private async writeFile(input: Record<string, unknown>): Promise<unknown> {
    const workspace = this.options.requireWorkspace(input.workspaceId);
    return { file: await this.options.files.write(workspace, input) };
  }
  private async searchFiles(input: Record<string, unknown>): Promise<unknown> {
    const workspace = this.options.requireWorkspace(input.workspaceId);
    return { files: await this.options.files.search(workspace, input) };
  }
  private async mutateFile(input: Record<string, unknown>): Promise<unknown> {
    const workspace = this.options.requireWorkspace(input.workspaceId);
    return { file: await this.options.files.mutate(workspace, input) };
  }
  private async searchContent(input: Record<string, unknown>): Promise<unknown> {
    const workspace = this.options.requireWorkspace(input.workspaceId);
    return { search: await this.contentSearch.search(workspace, input) };
  }
  private async symbolDefinition(input: Record<string, unknown>): Promise<unknown> {
    const workspace = this.options.requireWorkspace(input.workspaceId);
    return { definition: await this.codeNavigation.definition(workspace, input) };
  }
  private async prepareSymbolIndex(input: Record<string, unknown>): Promise<unknown> {
    const workspace = this.options.requireWorkspace(input.workspaceId);
    return { preparation: await this.codeNavigation.prepare(workspace, input) };
  }
  private async preflight(input: Record<string, unknown>): Promise<unknown> {
    return {
      uploads: await this.options.uploads.preflight(
        this.options.requireWorkspace(input.workspaceId),
        input
      )
    };
  }
  private async createUpload(input: Record<string, unknown>): Promise<unknown> {
    return {
      upload: await this.options.uploads.create(
        this.options.requireWorkspace(input.workspaceId),
        input
      )
    };
  }
  private async writeUpload(input: Record<string, unknown>): Promise<unknown> {
    return { upload: await this.options.uploads.write(input) };
  }
  private async completeUpload(input: Record<string, unknown>): Promise<unknown> {
    return { upload: await this.options.uploads.complete(input.uploadId) };
  }
  private async cancelUpload(input: Record<string, unknown>): Promise<unknown> {
    await this.options.uploads.cancel(input.uploadId);
    return { cancelled: true };
  }
  private async currentChanges(input: Record<string, unknown>): Promise<unknown> {
    return this.options.changes.current(this.options.requireWorkspace(input.workspaceId));
  }

  private async readFileContent(input: Record<string, unknown>): Promise<unknown> {
    if (typeof input.workspaceId !== 'string') throw new Error('WORKSPACE_NOT_FOUND');
    const workspace = this.options.requireWorkspace(input.workspaceId);
    const repository = await this.fileRepository(workspace, input);
    return {
      file: await this.options.files.readContent(workspace, input, repository),
      ...(input.previewDirectory === undefined ? {} : { previewBoundaryVerified: true })
    };
  }

  private async directFileMetadata(input: Record<string, unknown>): Promise<unknown> {
    if (typeof input.workspaceId !== 'string') throw new Error('WORKSPACE_NOT_FOUND');
    const workspace = this.options.requireWorkspace(input.workspaceId);
    const repository = await this.fileRepository(workspace, input);
    return {
      file: await this.options.files.directMetadata(workspace, input, repository)
    };
  }

  private async changeDiff(input: Record<string, unknown>): Promise<unknown> {
    if (
      typeof input.workspaceId !== 'string' ||
      typeof input.path !== 'string' ||
      (input.repositoryPath !== undefined && typeof input.repositoryPath !== 'string') ||
      (input.worktreePath !== undefined && typeof input.worktreePath !== 'string')
    )
      throw new Error('GIT_DIFF_INVALID');
    const workspace = this.gitWorkspace(input.workspaceId);
    const repository = await resolveGitRepositoryTarget(
      await resolveWorkspaceGitRoot(workspace.path, workspace.includeParentRepository ?? true),
      input.repositoryPath ?? '',
      input.worktreePath
    );
    return { diff: await readCurrentChangeDiff(repository, input.path) };
  }

  private async restoreChange(input: Record<string, unknown>): Promise<unknown> {
    if (
      typeof input.workspaceId !== 'string' ||
      typeof input.path !== 'string' ||
      (input.repositoryPath !== undefined && typeof input.repositoryPath !== 'string') ||
      (input.worktreePath !== undefined && typeof input.worktreePath !== 'string') ||
      (input.state !== 'STAGED' && input.state !== 'UNSTAGED' && input.state !== 'UNTRACKED')
    )
      throw new Error('GIT_CHANGE_RESTORE_UNAVAILABLE');
    const workspace = this.gitWorkspace(input.workspaceId);
    const repository = await resolveGitRepositoryTarget(
      await resolveWorkspaceGitRoot(workspace.path, workspace.includeParentRepository ?? true),
      input.repositoryPath ?? '',
      input.worktreePath
    );
    await restoreCurrentChange(repository, input.path, input.state);
    this.options.invalidate(workspace.id);
    return { restored: true };
  }

  private async gitRepository(input: Record<string, unknown>): Promise<string> {
    if (
      typeof input.workspaceId !== 'string' ||
      (input.repositoryPath !== undefined && typeof input.repositoryPath !== 'string')
    )
      throw new Error('GIT_REPOSITORY_INVALID');
    const workspace = this.gitWorkspace(input.workspaceId);
    return resolveGitRepository(
      await resolveWorkspaceGitRoot(workspace.path, workspace.includeParentRepository ?? true),
      input.repositoryPath ?? ''
    );
  }

  private async fileRepository(
    workspace: NodeWorkspace,
    input: Record<string, unknown>
  ): Promise<string> {
    if (input.worktreePath === undefined && input.repositoryPath === undefined)
      return workspace.path;
    if (
      (input.worktreePath !== undefined && typeof input.worktreePath !== 'string') ||
      (input.repositoryPath !== undefined && typeof input.repositoryPath !== 'string')
    )
      throw new Error('GIT_REPOSITORY_INVALID');
    if (
      typeof input.path !== 'string' ||
      input.path.startsWith('mar-attachment:') ||
      input.previewDirectory !== undefined
    )
      throw new Error('FILE_PATH_ESCAPE');
    const path = normalizeFilePreviewPath(input.path);
    if (isAbsolute(path) || win32.isAbsolute(path)) throw new Error('FILE_PATH_ESCAPE');
    return resolveGitRepositoryTarget(
      await resolveWorkspaceGitRoot(workspace.path, workspace.includeParentRepository ?? true),
      (input.repositoryPath as string | undefined) ?? '',
      input.worktreePath as string | undefined
    );
  }

  private refs(input: Record<string, unknown>): readonly string[] | undefined {
    if (input.refs === undefined) return undefined;
    if (
      !Array.isArray(input.refs) ||
      input.refs.length > 128 ||
      input.refs.some((ref) => typeof ref !== 'string')
    )
      throw new Error('GIT_HISTORY_REF_INVALID');
    return input.refs as string[];
  }

  private async gitRefs(input: Record<string, unknown>): Promise<unknown> {
    return { refs: await listGitHistoryRefs(await this.gitRepository(input)) };
  }

  private async gitHistory(input: Record<string, unknown>): Promise<unknown> {
    const refs = this.refs(input);
    if (input.cursor !== undefined && typeof input.cursor !== 'string')
      throw new Error('GIT_HISTORY_CURSOR_INVALID');
    if (
      input.limit !== undefined &&
      (typeof input.limit !== 'number' ||
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 100)
    )
      throw new Error('GIT_HISTORY_LIMIT_INVALID');
    return readGitHistory(await this.gitRepository(input), {
      ...(refs === undefined ? {} : { refs }),
      ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {})
    });
  }

  private async gitCommitFiles(input: Record<string, unknown>): Promise<unknown> {
    if (typeof input.commit !== 'string') throw new Error('GIT_HISTORY_COMMIT_INVALID');
    return {
      files: await readGitHistoryFiles(
        await this.gitRepository(input),
        input.commit,
        this.refs(input)
      )
    };
  }

  private async gitCommitFileDiff(input: Record<string, unknown>): Promise<unknown> {
    if (
      typeof input.commit !== 'string' ||
      typeof input.path !== 'string' ||
      (input.previousPath !== undefined && typeof input.previousPath !== 'string')
    )
      throw new Error('GIT_DIFF_INVALID');
    return {
      diff: await readGitHistoryFileDiff(
        await this.gitRepository(input),
        input.commit,
        input.path,
        this.refs(input),
        input.previousPath
      )
    };
  }

  private async gitCommitFileContent(input: Record<string, unknown>): Promise<unknown> {
    if (
      typeof input.commit !== 'string' ||
      typeof input.path !== 'string' ||
      !Number.isSafeInteger(input.offset) ||
      (input.offset as number) < 0 ||
      !Number.isSafeInteger(input.limit) ||
      (input.limit as number) < 1 ||
      (input.limit as number) > 20 * 1024 * 1024
    )
      throw new Error('FILE_RANGE_INVALID');
    return {
      file: await readGitHistoryFileContentRange(
        await this.gitRepository(input),
        input.commit,
        input.path,
        input.offset as number,
        input.limit as number,
        this.refs(input)
      )
    };
  }

  private async gitCommitFileDirectMetadata(input: Record<string, unknown>): Promise<unknown> {
    return {
      file: await this.gitDirectMetadata(input)
    };
  }

  async directDownload(descriptor: DirectTransferDescriptor): Promise<{
    readonly offset: number;
    readonly chunks: AsyncIterable<Uint8Array>;
  }> {
    if (descriptor.direction !== 'DOWNLOAD') throw new Error('DIRECT_RESOURCE_UNSUPPORTED');
    const workspace = this.options.requireWorkspace(descriptor.resource.workspaceId);
    if (descriptor.resource.kind === 'WORKSPACE_FILE') {
      const input: Record<string, unknown> = {
        workspaceId: workspace.id,
        path: descriptor.resource.path,
        ...(descriptor.resource.repositoryPath === undefined
          ? {}
          : { repositoryPath: descriptor.resource.repositoryPath }),
        ...(descriptor.resource.worktreePath === undefined
          ? {}
          : { worktreePath: descriptor.resource.worktreePath })
      };
      return {
        offset: descriptor.range?.offset ?? 0,
        chunks: this.options.files.readDirect(
          workspace,
          {
            path: descriptor.resource.path,
            size: descriptor.size,
            revision: descriptor.revision,
            ...(descriptor.range === undefined ? {} : { range: descriptor.range })
          },
          await this.fileRepository(workspace, input)
        )
      };
    }
    const resource = descriptor.resource;
    const input = {
      workspaceId: workspace.id,
      path: resource.path,
      commit: resource.commit,
      ...(resource.repositoryPath === undefined ? {} : { repositoryPath: resource.repositoryPath }),
      ...(resource.worktreePath === undefined ? {} : { worktreePath: resource.worktreePath })
    };
    const repository = await this.gitRepository(input);
    if (descriptor.revision !== gitResourceRevision(resource.commit, resource.path))
      throw new Error('DIRECT_FILE_REVISION_CHANGED');
    const refs = this.refs(input);
    return {
      offset: descriptor.range?.offset ?? 0,
      chunks: (async function* () {
        let offset = descriptor.range?.offset ?? 0;
        const rangeStart = descriptor.range?.offset ?? 0;
        const rangeEnd = rangeStart + (descriptor.range?.length ?? descriptor.size);
        while (offset < rangeEnd) {
          const range = await readGitHistoryFileContentRange(
            repository,
            resource.commit,
            resource.path,
            offset,
            Math.min(512 * 1024, rangeEnd - offset),
            refs
          );
          if (range.size !== descriptor.size) throw new Error('DIRECT_FILE_REVISION_CHANGED');
          const bytes = Buffer.from(range.contentBase64, 'base64');
          offset += bytes.length;
          if (bytes.length > 0) yield bytes;
          if (offset === rangeEnd) break;
          if (range.nextOffset !== offset) throw new Error('DIRECT_FILE_REVISION_CHANGED');
        }
        if (offset !== rangeEnd) throw new Error('DIRECT_FILE_REVISION_CHANGED');
      })()
    };
  }

  private async gitDirectMetadata(input: Record<string, unknown>) {
    const repository = await this.gitRepository(input);
    if (typeof input.commit !== 'string' || typeof input.path !== 'string')
      throw new Error('GIT_HISTORY_COMMIT_INVALID');
    const revision = gitResourceRevision(input.commit, input.path);
    if (
      input.offset !== undefined ||
      input.length !== undefined ||
      input.size !== undefined ||
      input.revision !== undefined
    ) {
      if (
        !Number.isSafeInteger(input.offset) ||
        (input.offset as number) < 0 ||
        !Number.isSafeInteger(input.length) ||
        (input.length as number) < 1 ||
        (input.length as number) > 512 * 1024 ||
        !Number.isSafeInteger(input.size) ||
        (input.size as number) < 0 ||
        input.revision !== revision
      )
        throw new Error('FILE_RANGE_INVALID');
      const offset = input.offset as number;
      const length = input.length as number;
      const size = input.size as number;
      if (offset + length > size) throw new Error('FILE_RANGE_INVALID');
      const range = await readGitHistoryFileContentRange(
        repository,
        input.commit,
        input.path,
        offset,
        length,
        this.refs(input)
      );
      const bytes = Buffer.from(range.contentBase64, 'base64');
      if (range.size !== size || bytes.length !== length)
        throw new Error('DIRECT_FILE_REVISION_CHANGED');
      return {
        size,
        revision,
        range: { offset, length }
      };
    }
    const content = await openGitHistoryFileContent(
      repository,
      input.commit,
      input.path,
      this.refs(input)
    );
    return { size: content.size, revision };
  }

  private async diff(input: Record<string, unknown>): Promise<unknown> {
    if (
      typeof input.workspaceId !== 'string' ||
      typeof input.fromRef !== 'string' ||
      typeof input.toRef !== 'string'
    )
      throw new Error('GIT_DIFF_INVALID');
    const workspace = this.gitWorkspace(input.workspaceId);
    return {
      diff: await readRestrictedDiff(
        await resolveWorkspaceGitRoot(workspace.path, workspace.includeParentRepository ?? true),
        input.fromRef,
        input.toRef
      )
    };
  }

  private gitWorkspace(workspaceId: string): NodeWorkspace {
    const workspace = this.options.requireWorkspace(workspaceId);
    return workspace;
  }
}

function gitResourceRevision(commit: string, path: string): string {
  return createHash('sha256').update(commit).update('\0').update(path).digest('hex');
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
