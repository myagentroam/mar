import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import type { NodeWorkspace } from '../database.js';
import type { NodeMessageAttachmentInput } from '../runtime-model.js';
import {
  parseComposerAttachmentUpload,
  validComposerAttachmentName
} from '../util/node-operation-parsers.js';
import { preflightWorkspaceUpload, workspaceUploadTemporaryName } from '../workspace.js';
import {
  WorkspaceDomainState,
  type ActiveWorkspaceUpload,
  type CompletedComposerAttachment
} from './workspace-domain-state.js';

const CHUNK_BYTES = 512 * 1024;
const TTL_MS = 60 * 60_000;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export interface ResolvedComposerAttachment {
  readonly attachment: NodeMessageAttachmentInput;
  readonly path: string;
  readonly resourcePath: string;
}

export interface ComposerAttachmentReservation {
  readonly attachments: readonly ResolvedComposerAttachment[];
  commit(retain: (directories: readonly string[]) => void): void;
  release(): void;
}

export class WorkspaceUploadService {
  constructor(
    private readonly state: WorkspaceDomainState,
    private readonly onCompleted: (workspaceId: string) => void,
    private readonly temporaryRoot: () => string
  ) {}

  async preflight(workspace: NodeWorkspace, input: Record<string, unknown>) {
    if (
      (input.directory !== undefined && typeof input.directory !== 'string') ||
      !Array.isArray(input.files) ||
      input.files.length === 0 ||
      input.files.some((file) => !plain(file) || typeof file.name !== 'string')
    )
      throw new Error('UPLOAD_INVALID');
    const seen = new Set<string>();
    return Promise.all(
      input.files.map(async (file) => {
        const name = (file as { name: string }).name;
        if (seen.has(name)) return { name, status: 'INVALID_NAME', path: null };
        seen.add(name);
        const target = await preflightWorkspaceUpload(
          workspace.path,
          typeof input.directory === 'string' ? input.directory : '.',
          name
        );
        return { name, status: target.status, path: target.path || null };
      })
    );
  }

  async create(workspace: NodeWorkspace, input: Record<string, unknown>): Promise<UploadStatus> {
    const attachment = parseComposerAttachmentUpload(input);
    if (
      (input.directory !== undefined && typeof input.directory !== 'string') ||
      typeof input.name !== 'string' ||
      !Number.isSafeInteger(input.size) ||
      (input.size as number) < 0 ||
      typeof input.overwrite !== 'boolean' ||
      (input.sha256 !== undefined &&
        (typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(input.sha256))) ||
      (attachment !== undefined && input.directory !== undefined)
    )
      throw new Error('UPLOAD_INVALID');
    if (
      attachment !== undefined &&
      (!validComposerAttachmentName(input.name) ||
        (input.size as number) > MAX_ATTACHMENT_BYTES ||
        this.state.composerAttachments.has(attachment.id) ||
        [...this.state.uploads.values()].some(
          (upload) => upload.composerAttachment?.id === attachment.id
        ))
    )
      throw new Error('COMPOSER_ATTACHMENT_INVALID');
    const target =
      attachment === undefined
        ? await preflightWorkspaceUpload(
            workspace.path,
            typeof input.directory === 'string' ? input.directory : '.',
            input.name
          )
        : await this.attachmentTarget(attachment.id, input.name);
    if (target.status === 'INVALID_NAME') throw new Error('UPLOAD_NAME_INVALID');
    if (target.status === 'EXISTS_DIRECTORY') throw new Error('UPLOAD_TARGET_DIRECTORY');
    if (target.status === 'EXISTS_FILE' && !input.overwrite)
      throw new Error('UPLOAD_TARGET_EXISTS');
    if (
      [...this.state.uploads.values()].some(
        (upload) => upload.workspaceId === workspace.id && upload.targetPath === target.absolutePath
      )
    )
      throw new Error('UPLOAD_TARGET_BUSY');
    const id = randomUUID();
    const temporaryPath = resolve(dirname(target.absolutePath), workspaceUploadTemporaryName(id));
    const handle = await open(temporaryPath, 'wx+');
    const timer = setTimeout(() => {
      const upload = this.state.uploads.get(id);
      if (upload !== undefined) void this.remove(upload).catch(() => undefined);
    }, TTL_MS);
    const upload: ActiveWorkspaceUpload = {
      id,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      path: target.path,
      targetPath: target.absolutePath,
      temporaryPath,
      size: input.size as number,
      overwrite: input.overwrite,
      ...(typeof input.sha256 === 'string' ? { directSha256: input.sha256 } : {}),
      ...(attachment === undefined ? {} : { composerAttachment: attachment }),
      handle,
      receivedBytes: 0,
      timer
    };
    this.state.uploads.set(id, upload);
    return this.status(id);
  }

  async write(input: Record<string, unknown>): Promise<UploadStatus> {
    if (
      typeof input.uploadId !== 'string' ||
      !Number.isSafeInteger(input.offset) ||
      (input.offset as number) < 0 ||
      typeof input.dataBase64 !== 'string'
    )
      throw new Error('UPLOAD_CHUNK_INVALID');
    const upload = this.require(input.uploadId);
    if (upload.writing) throw new Error('UPLOAD_OFFSET_INVALID');
    if (input.offset !== upload.receivedBytes) throw new Error('UPLOAD_OFFSET_INVALID');
    const bytes = Buffer.from(input.dataBase64, 'base64');
    if (bytes.length === 0 || bytes.length > CHUNK_BYTES) throw new Error('UPLOAD_CHUNK_INVALID');
    if (upload.receivedBytes + bytes.length > upload.size) throw new Error('UPLOAD_SIZE_INVALID');
    upload.writing = true;
    try {
      const result = await upload.handle.write(bytes, 0, bytes.length, upload.receivedBytes);
      if (result.bytesWritten !== bytes.length) throw new Error('UPLOAD_WRITE_FAILED');
      upload.receivedBytes += bytes.length;
      return this.status(upload.id);
    } finally {
      upload.writing = false;
    }
  }

  async createDirect(
    workspace: NodeWorkspace,
    input: {
      readonly path: string;
      readonly size: number;
      readonly sha256: string;
      readonly overwrite: boolean;
      readonly composerAttachment?: { readonly id: string; readonly mime: string };
    }
  ): Promise<UploadStatus> {
    const normalized = input.path.replaceAll('\\', '/');
    const existing = [...this.state.uploads.values()].find(
      (upload) =>
        input.composerAttachment === undefined &&
        upload.composerAttachment === undefined &&
        upload.workspaceId === workspace.id &&
        upload.path === normalized &&
        upload.size === input.size &&
        upload.overwrite === input.overwrite &&
        upload.directSha256 === input.sha256
    );
    if (existing !== undefined) {
      const target = await preflightWorkspaceUpload(
        workspace.path,
        posix.dirname(normalized),
        posix.basename(normalized)
      );
      if (
        target.absolutePath !== existing.targetPath ||
        target.path !== existing.path ||
        target.status === 'INVALID_NAME' ||
        target.status === 'EXISTS_DIRECTORY' ||
        (target.status === 'EXISTS_FILE' && !existing.overwrite)
      )
        throw new Error('UPLOAD_TARGET_INVALID');
      return this.status(existing.id);
    }
    const status = await this.create(workspace, {
      name: posix.basename(normalized),
      size: input.size,
      overwrite: input.overwrite,
      sha256: input.sha256,
      ...(input.composerAttachment === undefined
        ? { directory: posix.dirname(normalized) }
        : {
            composerAttachmentId: input.composerAttachment.id,
            mime: input.composerAttachment.mime
          })
    });
    return status;
  }

  async writeDirect(uploadId: string, bytes: Uint8Array): Promise<number> {
    const status = await this.write({
      uploadId,
      offset: this.status(uploadId).receivedBytes,
      dataBase64: Buffer.from(bytes).toString('base64')
    });
    return status.receivedBytes;
  }

  async completeDirect(uploadId: string, size: number, signal?: AbortSignal): Promise<void> {
    const upload = this.require(uploadId);
    if (size !== upload.size || upload.receivedBytes !== upload.size)
      throw new Error('UPLOAD_SIZE_INVALID');
    const hash = createHash('sha256');
    for await (const bytes of upload.handle.createReadStream({ start: 0, autoClose: false })) {
      this.assertActive(upload, signal);
      hash.update(bytes);
    }
    this.assertActive(upload, signal);
    if (hash.digest('hex') !== upload.directSha256) {
      await this.remove(upload);
      throw new Error('DIRECT_INTEGRITY_FAILED');
    }
    await this.complete(uploadId, signal);
  }

  status(uploadId: unknown): UploadStatus {
    const upload = this.require(uploadId);
    return {
      uploadId: upload.id,
      path: upload.path,
      receivedBytes: upload.receivedBytes,
      size: upload.size
    };
  }

  async complete(uploadId: unknown, signal?: AbortSignal): Promise<UploadStatus> {
    const upload = this.require(uploadId);
    if (upload.receivedBytes !== upload.size) throw new Error('UPLOAD_INCOMPLETE');
    await upload.handle.sync();
    this.assertActive(upload, signal);
    await upload.handle.close();
    await this.validateCommit(upload);
    this.assertActive(upload, signal);
    if (upload.overwrite) {
      await rename(upload.temporaryPath, upload.targetPath);
    } else {
      try {
        await link(upload.temporaryPath, upload.targetPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new Error('UPLOAD_TARGET_EXISTS');
        throw error;
      }
      await rm(upload.temporaryPath);
    }
    clearTimeout(upload.timer);
    this.state.uploads.delete(upload.id);
    this.onCompleted(upload.workspaceId);
    if (upload.composerAttachment !== undefined) {
      const attachment: CompletedComposerAttachment = {
        id: upload.composerAttachment.id,
        workspaceId: upload.workspaceId,
        path: upload.path,
        targetPath: upload.targetPath,
        name: upload.composerAttachment.name,
        mime: upload.composerAttachment.mime,
        size: upload.size,
        expiresAt: Date.now() + TTL_MS,
        reserved: false,
        timer: undefined
      };
      this.state.composerAttachments.set(attachment.id, attachment);
      this.scheduleAttachmentExpiry(attachment);
    }
    return {
      uploadId: upload.id,
      path: upload.path,
      receivedBytes: upload.receivedBytes,
      size: upload.size
    };
  }

  async cancel(uploadId: unknown): Promise<void> {
    if (typeof uploadId !== 'string') throw new Error('UPLOAD_NOT_FOUND');
    const active = this.state.uploads.get(uploadId);
    if (active !== undefined) return this.remove(active);
    const attachment = this.state.composerAttachments.get(uploadId);
    if (attachment === undefined) throw new Error('UPLOAD_NOT_FOUND');
    if (attachment.reserved) throw new Error('COMPOSER_ATTACHMENT_UNAVAILABLE');
    await this.removeCompleted(attachment);
  }

  async reserve(
    workspaceId: string,
    ids: readonly string[]
  ): Promise<ComposerAttachmentReservation> {
    if (new Set(ids).size !== ids.length) throw new Error('COMPOSER_ATTACHMENT_UNAVAILABLE');
    const storedAttachments = ids.map((id) => {
      const stored = this.state.composerAttachments.get(id);
      if (stored === undefined || stored.workspaceId !== workspaceId || stored.reserved)
        throw new Error('COMPOSER_ATTACHMENT_UNAVAILABLE');
      return stored;
    });
    for (const stored of storedAttachments) {
      stored.reserved = true;
      clearTimeout(stored.timer);
      stored.timer = undefined;
    }
    let active = true;
    const assertReserved = () => {
      if (
        !active ||
        storedAttachments.some((stored) => this.state.composerAttachments.get(stored.id) !== stored)
      )
        throw new Error('COMPOSER_ATTACHMENT_UNAVAILABLE');
    };
    const release = () => {
      if (!active) return;
      active = false;
      for (const stored of storedAttachments) {
        if (this.state.composerAttachments.get(stored.id) !== stored) continue;
        stored.reserved = false;
        this.scheduleAttachmentExpiry(stored);
      }
    };
    try {
      const attachments = await Promise.all(
        storedAttachments.map(async (stored) => {
          const metadata = await lstat(stored.targetPath).catch(() => undefined);
          if (
            metadata === undefined ||
            metadata.isSymbolicLink() ||
            !metadata.isFile() ||
            metadata.size !== stored.size
          )
            throw new Error('COMPOSER_ATTACHMENT_UNAVAILABLE');
          const bytes = await readFile(stored.targetPath);
          return {
            attachment: {
              name: stored.name,
              mime: stored.mime,
              dataBase64: bytes.toString('base64')
            },
            path: stored.targetPath,
            resourcePath: stored.path
          };
        })
      );
      assertReserved();
      return {
        attachments,
        commit: (retain) => {
          assertReserved();
          retain(storedAttachments.map((stored) => dirname(stored.targetPath)));
          for (const stored of storedAttachments) this.state.composerAttachments.delete(stored.id);
          active = false;
        },
        release
      };
    } catch (error) {
      release();
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.state.uploads.values()].map((upload) => this.remove(upload)));
    for (const attachment of this.state.composerAttachments.values())
      await this.removeCompleted(attachment);
    this.state.composerAttachments.clear();
  }

  fileResource(workspaceId: string, resourcePath: string): string | undefined {
    for (const attachment of this.state.composerAttachments.values())
      if (attachment.workspaceId === workspaceId && attachment.path === resourcePath)
        return attachment.targetPath;
    return undefined;
  }

  private require(id: unknown): ActiveWorkspaceUpload {
    if (typeof id !== 'string') throw new Error('UPLOAD_NOT_FOUND');
    const upload = this.state.uploads.get(id);
    if (upload === undefined || upload.cancelled) throw new Error('UPLOAD_NOT_FOUND');
    return upload;
  }
  private assertActive(upload: ActiveWorkspaceUpload, signal?: AbortSignal): void {
    if (this.state.uploads.get(upload.id) !== upload || upload.cancelled || signal?.aborted)
      throw new Error('UPLOAD_CANCELLED');
  }
  private async validateCommit(upload: ActiveWorkspaceUpload): Promise<void> {
    if (upload.composerAttachment === undefined) {
      const target = await preflightWorkspaceUpload(
        upload.workspacePath,
        posix.dirname(upload.path),
        posix.basename(upload.path)
      );
      if (target.absolutePath !== upload.targetPath || target.path !== upload.path)
        throw new Error('UPLOAD_TARGET_INVALID');
      if (target.status === 'EXISTS_DIRECTORY') throw new Error('UPLOAD_TARGET_DIRECTORY');
      if (target.status === 'INVALID_NAME') throw new Error('UPLOAD_NAME_INVALID');
      if (target.status === 'EXISTS_FILE' && !upload.overwrite)
        throw new Error('UPLOAD_TARGET_EXISTS');
    } else {
      const target = await lstat(upload.targetPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (target?.isSymbolicLink()) throw new Error('FILE_PATH_ESCAPE');
      if (target !== undefined && (!target.isFile() || !upload.overwrite))
        throw new Error('UPLOAD_TARGET_EXISTS');
    }
    const parent = await lstat(dirname(upload.targetPath));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('UPLOAD_TARGET_INVALID');
    const staging = await lstat(upload.temporaryPath);
    if (!staging.isFile() || staging.isSymbolicLink() || staging.size !== upload.size)
      throw new Error('UPLOAD_STAGING_INVALID');
  }
  private async remove(upload: ActiveWorkspaceUpload): Promise<void> {
    upload.cancelled = true;
    clearTimeout(upload.timer);
    await upload.handle.close().catch(() => undefined);
    const parent = await lstat(dirname(upload.temporaryPath));
    const staging = await lstat(upload.temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (staging !== undefined && (!staging.isFile() || staging.isSymbolicLink()))
    )
      throw new Error('UPLOAD_CLEANUP_FAILED');
    if (staging !== undefined) await rm(upload.temporaryPath, { force: true });
    if (upload.composerAttachment !== undefined)
      await rm(dirname(upload.targetPath), { recursive: true, force: true });
    this.state.uploads.delete(upload.id);
  }
  private async removeCompleted(attachment: CompletedComposerAttachment): Promise<void> {
    if (this.state.composerAttachments.get(attachment.id) !== attachment) return;
    this.state.composerAttachments.delete(attachment.id);
    clearTimeout(attachment.timer);
    await rm(dirname(attachment.targetPath), { recursive: true, force: true }).catch(
      () => undefined
    );
  }
  private scheduleAttachmentExpiry(attachment: CompletedComposerAttachment): void {
    attachment.timer = setTimeout(
      () => {
        if (!attachment.reserved) void this.removeCompleted(attachment);
      },
      Math.max(0, attachment.expiresAt - Date.now())
    );
    attachment.timer.unref();
  }
  private async attachmentTarget(id: string, name: string) {
    const temp = this.temporaryRoot();
    await mkdir(temp, { recursive: true, mode: 0o700 });
    await safeDirectory(temp);
    const directory = join(temp, id);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error('COMPOSER_ATTACHMENT_INVALID');
      throw error;
    }
    await safeDirectory(directory);
    return {
      path: `mar-attachment://${id}/${name}`,
      absolutePath: join(directory, name),
      status: 'READY' as const
    };
  }
}

interface UploadStatus {
  readonly uploadId: string;
  readonly path: string;
  readonly receivedBytes: number;
  readonly size: number;
}
async function safeDirectory(path: string): Promise<void> {
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink())
    throw new Error('COMPOSER_ATTACHMENT_DIRECTORY_INVALID');
}
function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
