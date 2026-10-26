import { basename, dirname, isAbsolute, relative, resolve, win32 } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { isComposerAttachmentResourcePath } from '@myagentroam/protocol';
import type { NodeWorkspace } from '../database.js';
import {
  listWorkspaceFiles,
  mutateWorkspaceFile,
  normalizeFilePreviewPath,
  readAbsoluteFileContentRange,
  readWorkspaceFileContentRange,
  readAbsoluteTextFile,
  readWorkspaceTextFile,
  writeWorkspaceTextFile,
  WorkspaceFileIndex
} from '../workspace.js';
import { WorkspaceDomainState } from './workspace-domain-state.js';
import { revealWorkspaceFileInFileManager } from './workspace-file-manager-service.js';

const INDEX_CACHE_LIMIT = 32;
const INDEX_CACHE_BYTE_LIMIT = 128 * 1024 * 1024;
const INDEX_QUEUE_LIMIT = 16;
const INDEX_QUEUE_TIMEOUT_MS = 120_000;

interface PendingIndexBuild {
  readonly run: () => Promise<void>;
  readonly background: () => boolean;
  readonly needed: () => boolean;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

export class WorkspaceFileService {
  private readonly mutationTails = new Map<string, Promise<void>>();
  private readonly indexQueue: PendingIndexBuild[] = [];
  private indexRunning = false;

  constructor(
    private readonly state: WorkspaceDomainState,
    private readonly onInvalidated: (workspaceId: string) => void,
    private readonly indexLimits: {
      readonly cacheByteLimit?: number;
      readonly indexByteLimit?: number;
      readonly queueLimit?: number;
      readonly queueTimeoutMs?: number;
    } = {},
    private readonly attachmentResource: (
      workspaceId: string,
      path: string
    ) => string | undefined = () => undefined
  ) {}

  async list(workspace: NodeWorkspace, input: Record<string, unknown>): Promise<unknown> {
    if (
      (input.path !== undefined && typeof input.path !== 'string') ||
      (input.cursor !== undefined && typeof input.cursor !== 'string') ||
      (input.limit !== undefined &&
        (!Number.isInteger(input.limit) ||
          (input.limit as number) < 1 ||
          (input.limit as number) > 200))
    )
      throw new Error('DIRECTORY_CURSOR_INVALID');
    return listWorkspaceFiles(
      workspace.path,
      typeof input.path === 'string' ? input.path : '.',
      typeof input.cursor === 'string' ? input.cursor : undefined,
      typeof input.limit === 'number' ? input.limit : undefined
    );
  }

  async read(
    workspace: NodeWorkspace,
    input: Record<string, unknown>,
    workspacePath = workspace.path
  ): Promise<unknown> {
    if (
      typeof input.path !== 'string' ||
      (input.offset !== undefined &&
        (!Number.isInteger(input.offset) || (input.offset as number) < 0)) ||
      (input.limit !== undefined &&
        (!Number.isInteger(input.limit) ||
          (input.limit as number) < 1 ||
          (input.limit as number) > 512 * 1024))
    )
      throw new Error('FILE_RANGE_INVALID');
    const offset = typeof input.offset === 'number' ? input.offset : 0;
    const limit = typeof input.limit === 'number' ? input.limit : 512 * 1024;
    if (input.path.startsWith('mar-attachment:')) {
      const target = await this.resolveAttachmentResource(workspace.id, input.path);
      return {
        ...(await readWorkspaceTextFile(dirname(target), basename(target), offset, limit)),
        path: input.path
      };
    }
    const path = normalizeFilePreviewPath(input.path);
    if (workspacePath !== workspace.path && isFilePreviewAbsolutePath(path))
      throw new Error('FILE_PATH_ESCAPE');
    return isFilePreviewAbsolutePath(path)
      ? readAbsoluteTextFile(path, offset, limit)
      : readWorkspaceTextFile(workspacePath, path, offset, limit);
  }

  async readContent(
    workspace: NodeWorkspace,
    input: Record<string, unknown>,
    workspacePath = workspace.path
  ): Promise<unknown> {
    if (
      typeof input.path !== 'string' ||
      (input.offset !== undefined &&
        (!Number.isInteger(input.offset) || (input.offset as number) < 0)) ||
      (input.limit !== undefined &&
        (!Number.isInteger(input.limit) ||
          (input.limit as number) < 1 ||
          (input.limit as number) > 512 * 1024))
    )
      throw new Error('FILE_RANGE_INVALID');
    if (input.path.startsWith('mar-attachment:')) {
      if (input.previewDirectory !== undefined) throw new Error('FILE_PATH_ESCAPE');
      const target = await this.resolveAttachmentResource(workspace.id, input.path);
      return {
        ...(await readWorkspaceFileContentRange(
          dirname(target),
          basename(target),
          typeof input.offset === 'number' ? input.offset : 0,
          typeof input.limit === 'number' ? input.limit : 512 * 1024
        )),
        path: input.path
      };
    }
    const path = normalizeFilePreviewPath(input.path);
    if (workspacePath !== workspace.path && isFilePreviewAbsolutePath(path))
      throw new Error('FILE_PATH_ESCAPE');
    if (input.previewDirectory !== undefined) {
      if (
        typeof input.previewDirectory !== 'string' ||
        isFilePreviewAbsolutePath(path) ||
        isFilePreviewAbsolutePath(input.previewDirectory)
      )
        throw new Error('FILE_PATH_ESCAPE');
      const root = await realpath(resolve(workspacePath, input.previewDirectory));
      const target = await realpath(resolve(workspacePath, path));
      const suffix = relative(root, target);
      if (
        suffix === '..' ||
        suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
        isAbsolute(suffix)
      )
        throw new Error('FILE_PATH_ESCAPE');
    }
    const offset = typeof input.offset === 'number' ? input.offset : 0;
    const limit = typeof input.limit === 'number' ? input.limit : 512 * 1024;
    return isFilePreviewAbsolutePath(path)
      ? readAbsoluteFileContentRange(path, offset, limit)
      : readWorkspaceFileContentRange(workspacePath, path, offset, limit);
  }

  private async resolveAttachmentResource(workspaceId: string, path: string): Promise<string> {
    if (!isComposerAttachmentResourcePath(path)) throw new Error('FILE_PATH_ESCAPE');
    const target = this.attachmentResource(workspaceId, path);
    if (target === undefined) throw new Error('FILE_NOT_FOUND');
    const [directory, file] = await Promise.all([lstat(dirname(target)), lstat(target)]).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') throw new Error('FILE_NOT_FOUND');
        throw error;
      }
    );
    if (directory.isSymbolicLink() || file.isSymbolicLink()) throw new Error('FILE_PATH_ESCAPE');
    if (!directory.isDirectory() || !file.isFile()) throw new Error('FILE_NOT_REGULAR');
    return target;
  }

  readDirect(
    workspace: NodeWorkspace,
    input: {
      readonly path: string;
      readonly size: number;
      readonly revision: string;
      readonly range?: {
        readonly offset: number;
        readonly length: number;
      };
    },
    workspacePath = workspace.path
  ): AsyncIterable<Uint8Array> {
    const readContent = this.readContent.bind(this);
    return (async function* () {
      const initial = (await readContent(
        workspace,
        { path: input.path, offset: input.range?.offset ?? 0, limit: 1 },
        workspacePath
      )) as { readonly size: number; readonly sourceRevision: string };
      if (initial.size !== input.size || initial.sourceRevision !== input.revision)
        throw new Error('DIRECT_FILE_REVISION_CHANGED');
      let offset = input.range?.offset ?? 0;
      const endOffset =
        input.range === undefined ? input.size : input.range.offset + input.range.length;
      while (offset < endOffset) {
        const range = (await readContent(
          workspace,
          {
            path: input.path,
            offset,
            limit: Math.min(512 * 1024, endOffset - offset)
          },
          workspacePath
        )) as {
          readonly size: number;
          readonly sourceRevision: string;
          readonly contentBase64: string;
          readonly nextOffset: number | null;
        };
        if (range.size !== input.size || range.sourceRevision !== input.revision)
          throw new Error('DIRECT_FILE_REVISION_CHANGED');
        const bytes = Buffer.from(range.contentBase64, 'base64');
        offset += bytes.length;
        if (bytes.length > 0) yield bytes;
        if (offset === endOffset) break;
        if (range.nextOffset !== offset) throw new Error('DIRECT_FILE_REVISION_CHANGED');
      }
      if (offset !== endOffset) throw new Error('DIRECT_FILE_REVISION_CHANGED');
    })();
  }

  async directMetadata(
    workspace: NodeWorkspace,
    input: Record<string, unknown>,
    workspacePath = workspace.path
  ): Promise<{
    readonly size: number;
    readonly revision: string;
    readonly range?: { readonly offset: number; readonly length: number };
  }> {
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
        !Number.isSafeInteger(input.size) ||
        (input.size as number) < 0 ||
        typeof input.revision !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(input.revision)
      )
        throw new Error('FILE_RANGE_INVALID');
      const offset = input.offset as number;
      const length = input.length as number;
      const expectedSize = input.size as number;
      if (offset + length > expectedSize) throw new Error('FILE_RANGE_INVALID');
      const read = (await this.readContent(
        workspace,
        { ...input, offset, limit: length },
        workspacePath
      )) as {
        readonly size: number;
        readonly sourceRevision: string;
        readonly contentBase64: string;
      };
      const bytes = Buffer.from(read.contentBase64, 'base64');
      if (
        read.size !== expectedSize ||
        read.sourceRevision !== input.revision ||
        bytes.length !== length
      )
        throw new Error('DIRECT_FILE_REVISION_CHANGED');
      return {
        size: expectedSize,
        revision: input.revision,
        range: { offset, length }
      };
    }
    const metadata = (await this.readContent(
      workspace,
      { ...input, offset: 0, limit: 1 },
      workspacePath
    )) as { readonly size: number; readonly sourceRevision: string };
    return { size: metadata.size, revision: metadata.sourceRevision };
  }

  async write(workspace: NodeWorkspace, input: Record<string, unknown>): Promise<unknown> {
    if (
      input.repositoryPath !== undefined ||
      input.worktreePath !== undefined ||
      typeof input.path !== 'string' ||
      typeof input.content !== 'string' ||
      typeof input.expectedRevision !== 'string'
    )
      throw new Error('FILE_WRITE_INVALID');
    const path = input.path;
    const content = input.content;
    const expectedRevision = input.expectedRevision;
    if (path.startsWith('mar-attachment:')) throw new Error('FILE_PATH_ESCAPE');
    return this.serializeMutation(workspace.id, async () => {
      const result = await writeWorkspaceTextFile(workspace.path, path, content, expectedRevision);
      this.onInvalidated(workspace.id);
      return result;
    });
  }

  async search(workspace: NodeWorkspace, input: Record<string, unknown>): Promise<unknown> {
    if (
      typeof input.query !== 'string' ||
      (input.cursor !== undefined && typeof input.cursor !== 'string') ||
      (input.includeDirectories !== undefined && typeof input.includeDirectories !== 'boolean') ||
      (input.waitForIndex !== undefined && typeof input.waitForIndex !== 'boolean') ||
      (input.limit !== undefined &&
        (!Number.isInteger(input.limit) ||
          (input.limit as number) < 1 ||
          (input.limit as number) > 200))
    )
      throw new Error('FILE_SEARCH_LIMIT_EXCEEDED');
    return this.index(workspace).search(
      input.query,
      typeof input.cursor === 'string' ? input.cursor : undefined,
      typeof input.limit === 'number' ? input.limit : undefined,
      input.includeDirectories === true,
      input.waitForIndex !== false
    );
  }

  async mutate(workspace: NodeWorkspace, input: Record<string, unknown>): Promise<unknown> {
    const action = input.action;
    if (
      (action !== 'CREATE_FILE' &&
        action !== 'CREATE_DIRECTORY' &&
        action !== 'MOVE' &&
        action !== 'DELETE') ||
      typeof input.path !== 'string' ||
      (action === 'MOVE' && typeof input.destination !== 'string')
    )
      throw new Error('FILE_MUTATION_INVALID');
    const path = input.path;
    const destination = typeof input.destination === 'string' ? input.destination : undefined;
    if (path.startsWith('mar-attachment:') || destination?.startsWith('mar-attachment:'))
      throw new Error('FILE_PATH_ESCAPE');
    return this.serializeMutation(workspace.id, async () => {
      const result = await mutateWorkspaceFile(
        workspace.path,
        action === 'MOVE' ? { action, path, destination: destination as string } : { action, path }
      );
      this.onInvalidated(workspace.id);
      return result;
    });
  }

  async reveal(workspace: NodeWorkspace, input: Record<string, unknown>): Promise<unknown> {
    if (typeof input.path !== 'string') throw new Error('FILE_REVEAL_INVALID');
    return revealWorkspaceFileInFileManager(workspace.path, input.path);
  }

  private async serializeMutation<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTails.get(workspaceId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.mutationTails.set(workspaceId, tail);
    try {
      return await result;
    } finally {
      if (this.mutationTails.get(workspaceId) === tail) this.mutationTails.delete(workspaceId);
    }
  }

  index(workspace: NodeWorkspace): WorkspaceFileIndex {
    let index = this.state.fileIndexes.get(workspace.id);
    if (index === undefined) {
      index = new WorkspaceFileIndex(workspace.path, {
        ...(this.indexLimits.indexByteLimit === undefined
          ? {}
          : { byteLimit: this.indexLimits.indexByteLimit }),
        schedule: (run, background, needed) => this.scheduleIndex(run, background, needed),
        onRebuilt: () => this.pruneIndexes(workspace.id)
      });
    }
    this.state.fileIndexes.delete(workspace.id);
    this.state.fileIndexes.set(workspace.id, index);
    this.pruneIndexes(workspace.id);
    return index;
  }

  prepare(workspace: NodeWorkspace, needed: () => boolean): Promise<void> {
    if (!needed()) return Promise.resolve();
    return this.index(workspace).prepare(needed);
  }

  /** Removes queued preparation whose Watch consumers have all gone away. */
  prunePreparations(): void {
    for (let index = this.indexQueue.length - 1; index >= 0; index -= 1) {
      const job = this.indexQueue[index]!;
      if (job.needed()) continue;
      this.indexQueue.splice(index, 1);
      clearTimeout(job.timer);
      job.resolve();
    }
  }

  private pruneIndexes(protectedId: string): void {
    let bytes = [...this.state.fileIndexes.values()].reduce(
      (total, index) => total + index.accountedBytes,
      0
    );
    const byteLimit = this.indexLimits.cacheByteLimit ?? INDEX_CACHE_BYTE_LIMIT;
    for (const [id, index] of this.state.fileIndexes) {
      if (this.state.fileIndexes.size <= INDEX_CACHE_LIMIT && bytes <= byteLimit) break;
      if (id === protectedId) continue;
      bytes -= index.accountedBytes;
      index.dispose();
      this.state.fileIndexes.delete(id);
    }
    this.prunePreparations();
  }

  private scheduleIndex(
    run: () => Promise<void>,
    background: () => boolean,
    needed: () => boolean
  ): Promise<void> {
    this.prunePreparations();
    if (!needed()) return Promise.resolve();
    if (this.indexQueue.length >= (this.indexLimits.queueLimit ?? INDEX_QUEUE_LIMIT))
      return Promise.reject(new Error('FILE_SEARCH_LIMIT_EXCEEDED'));
    return new Promise<void>((resolve, reject) => {
      const job: PendingIndexBuild = {
        run,
        background,
        needed,
        resolve: () => resolve(),
        reject,
        timer: setTimeout(() => {
          const index = this.indexQueue.indexOf(job);
          if (index < 0) return;
          this.indexQueue.splice(index, 1);
          reject(new Error('FILE_SEARCH_LIMIT_EXCEEDED'));
        }, this.indexLimits.queueTimeoutMs ?? INDEX_QUEUE_TIMEOUT_MS)
      };
      job.timer.unref();
      this.indexQueue.push(job);
      this.runNextIndex();
    });
  }

  private runNextIndex(): void {
    if (this.indexRunning) return;
    this.prunePreparations();
    const foreground = this.indexQueue.findIndex((job) => !job.background());
    const job = this.indexQueue.splice(foreground < 0 ? 0 : foreground, 1)[0];
    if (job === undefined) return;
    clearTimeout(job.timer);
    this.indexRunning = true;
    void Promise.resolve()
      .then(job.run)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.indexRunning = false;
        this.runNextIndex();
      });
  }

  dispose(workspaceId?: string): void {
    if (workspaceId !== undefined) {
      this.state.fileIndexes.get(workspaceId)?.dispose();
      this.state.fileIndexes.delete(workspaceId);
      this.prunePreparations();
      return;
    }
    for (const index of this.state.fileIndexes.values()) index.dispose();
    this.state.fileIndexes.clear();
    this.prunePreparations();
  }
}

function isFilePreviewAbsolutePath(path: string): boolean {
  return isAbsolute(path) || win32.isAbsolute(path);
}
