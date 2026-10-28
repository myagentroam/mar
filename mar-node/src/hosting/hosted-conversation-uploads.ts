import { assertRegularFile } from './hosted-conversation-file-identity.js';
import type { Stats } from 'node:fs';
import { lstat, open, rename, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import {
  hostedConversationUploadChunkInputSchema,
  hostedConversationUploadControlInputSchema,
  hostedConversationUploadCreateInputSchema,
  hostedConversationUploadPreflightInputSchema,
  hostedConversationUploadPreflightResultSchema,
  hostedConversationUploadSchema,
  type ConversationFileProjection,
  type ConversationTemplateDraft,
  type HostedConversationManifest
} from '@myagentroam/protocol';
import type {
  HostedConversationPaths,
  HostedConversationStore
} from './hosted-conversation-store.js';

interface UploadRequest {
  readonly data: unknown;
  readonly userId: number;
}
interface UploadOptions {
  readonly store: HostedConversationStore;
  readonly request: (raw: unknown) => UploadRequest;
  readonly requireWritableConversation: (userId: number, id: string) => HostedConversationManifest;
  readonly loadTemplateVersion: (
    versionId: string,
    templateId: string
  ) => Promise<{ readonly draft: Pick<ConversationTemplateDraft, 'quotas'> }>;
  readonly publish: (conversationId: string, payload: unknown) => boolean;
}
interface ActiveUpload {
  readonly uploadId: string;
  readonly conversationId: string;
  readonly userId: number;
  readonly clientRequestId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly temporaryPath: string;
  readonly targetPath: string;
  receivedBytes: number;
  status: 'UPLOADING' | 'COMPLETED' | 'CANCELLED';
  file?: ConversationFileProjection;
}

/** Owns Hosted upload admission, name reservations and temporary files. */
export class HostedConversationUploads {
  private readonly uploads = new Map<string, ActiveUpload>();
  private readonly uploadsByRequest = new Map<string, string>();
  private readonly pendingUploadCreates = new Map<string, Promise<unknown>>();
  private readonly uploadNameReservations = new Map<string, Set<string>>();
  constructor(
    private readonly options: UploadOptions,
    private readonly now: () => number,
    private readonly id: () => string
  ) {}

  busy(conversationId: string): boolean {
    return [...this.uploads.values()].some(
      (upload) => upload.conversationId === conversationId && upload.status === 'UPLOADING'
    );
  }
  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.uploads.values()].map(async (upload) => {
        if (upload.status === 'UPLOADING') {
          upload.status = 'CANCELLED';
          await rm(upload.temporaryPath, { force: true });
        }
      })
    );
    this.uploads.clear();
    this.uploadsByRequest.clear();
    this.uploadNameReservations.clear();
  }
  async preflightUpload(raw: unknown): Promise<unknown> {
    const payload = this.options.request(raw);
    const input = hostedConversationUploadPreflightInputSchema.parse(payload.data);
    const conversation = this.options.requireWritableConversation(
      payload.userId,
      input.conversationId
    );
    const version = await this.options.loadTemplateVersion(
      conversation.activeVersionId,
      conversation.templateId
    );
    const files = await Promise.all(
      input.files.map(async (file) => ({
        name: file.name,
        status: await this.uploadPreflightStatus(conversation, version.draft, file.name, file.size)
      }))
    );
    return hostedConversationUploadPreflightResultSchema.parse({ files });
  }

  async createUpload(raw: unknown): Promise<unknown> {
    const payload = this.options.request(raw);
    const input = hostedConversationUploadCreateInputSchema.parse(payload.data);
    const conversation = this.options.requireWritableConversation(
      payload.userId,
      input.conversationId
    );
    const requestKey = `${payload.userId}\0${conversation.id}\0${input.clientRequestId}`;
    const existingId = this.uploadsByRequest.get(requestKey);
    if (existingId !== undefined) {
      const existing = this.uploads.get(existingId);
      if (existing !== undefined)
        return { upload: hostedConversationUploadSchema.parse(uploadProjection(existing)) };
    }
    const pending = this.pendingUploadCreates.get(requestKey);
    if (pending !== undefined) return pending;
    const operation = this.createUploadForRequest(payload, input, conversation, requestKey);
    this.pendingUploadCreates.set(requestKey, operation);
    void operation
      .finally(() => {
        if (this.pendingUploadCreates.get(requestKey) === operation)
          this.pendingUploadCreates.delete(requestKey);
      })
      .catch(() => undefined);
    return operation;
  }

  private async createUploadForRequest(
    payload: UploadRequest,
    input: ReturnType<typeof hostedConversationUploadCreateInputSchema.parse>,
    conversation: HostedConversationManifest,
    requestKey: string
  ): Promise<unknown> {
    const version = await this.options.loadTemplateVersion(
      conversation.activeVersionId,
      conversation.templateId
    );
    const paths = this.options.store.pathsForConversation(payload.userId, conversation.id);
    const status = await this.uploadPreflightStatus(
      conversation,
      version.draft,
      input.name,
      input.size
    );
    if (status === 'QUOTA_EXCEEDED' || status === 'TOO_LARGE')
      throw new Error('HOSTED_CONVERSATION_QUOTA_EXCEEDED');
    if (status !== 'READY') throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
    const uploadId = this.id();
    const temporaryPath = join(paths.uploadsDirectory, `.${uploadId}.upload`);
    const name = await this.allocateUploadName(paths, payload.userId, conversation.id, input.name);
    const targetPath = join(paths.uploadsDirectory, name);
    try {
      const handle = await open(temporaryPath, 'wx', 0o600);
      await handle.close();
    } catch (error) {
      this.releaseUploadName(conversation.id, name);
      throw error;
    }
    const upload: ActiveUpload = {
      uploadId,
      conversationId: conversation.id,
      userId: payload.userId,
      clientRequestId: input.clientRequestId,
      name,
      mimeType: input.mimeType,
      size: input.size,
      temporaryPath,
      targetPath,
      receivedBytes: 0,
      status: 'UPLOADING'
    };
    this.uploads.set(uploadId, upload);
    this.uploadsByRequest.set(requestKey, uploadId);
    return { upload: hostedConversationUploadSchema.parse(uploadProjection(upload)) };
  }

  async writeUploadChunk(raw: unknown): Promise<unknown> {
    const payload = this.options.request(raw);
    const input = hostedConversationUploadChunkInputSchema.parse(payload.data);
    const upload = this.requireUpload(payload.userId, input.conversationId, input.uploadId);
    if (upload.status !== 'UPLOADING') throw new Error('HOSTED_CONVERSATION_UPLOAD_STATE_INVALID');
    if (input.offset !== upload.receivedBytes)
      throw new Error('HOSTED_CONVERSATION_UPLOAD_OFFSET_INVALID');
    const chunk = Buffer.from(input.dataBase64, 'base64');
    if (upload.receivedBytes + chunk.byteLength > upload.size)
      throw new Error('HOSTED_CONVERSATION_UPLOAD_SIZE_INVALID');
    await assertUploadTemporaryFile(upload.temporaryPath, upload.receivedBytes);
    const handle = await open(upload.temporaryPath, 'r+');
    try {
      await handle.write(chunk, 0, chunk.byteLength, upload.receivedBytes);
    } finally {
      await handle.close();
    }
    upload.receivedBytes += chunk.byteLength;
    return { upload: hostedConversationUploadSchema.parse(uploadProjection(upload)) };
  }

  uploadStatus(raw: unknown): unknown {
    const payload = this.options.request(raw);
    const input = hostedConversationUploadControlInputSchema.parse(payload.data);
    const upload = this.requireUpload(payload.userId, input.conversationId, input.uploadId);
    return { upload: hostedConversationUploadSchema.parse(uploadProjection(upload)) };
  }

  async completeUpload(raw: unknown): Promise<unknown> {
    const payload = this.options.request(raw);
    const input = hostedConversationUploadControlInputSchema.parse(payload.data);
    const upload = this.requireUpload(payload.userId, input.conversationId, input.uploadId);
    if (upload.status === 'COMPLETED')
      return { upload: hostedConversationUploadSchema.parse(uploadProjection(upload)) };
    if (upload.status !== 'UPLOADING' || upload.receivedBytes !== upload.size)
      throw new Error('HOSTED_CONVERSATION_UPLOAD_INCOMPLETE');
    const conversation = this.options.requireWritableConversation(
      payload.userId,
      upload.conversationId
    );
    const version = await this.options.loadTemplateVersion(
      conversation.activeVersionId,
      conversation.templateId
    );
    if (
      upload.size > version.draft.quotas.maxUploadBytes ||
      conversation.quota.usedBytes + upload.size > conversation.quota.maxBytes
    )
      throw new Error('HOSTED_CONVERSATION_QUOTA_EXCEEDED');
    await assertUploadTemporaryFile(upload.temporaryPath, upload.size);
    const target = await lstat(upload.targetPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (target !== undefined) throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
    const handle = await open(upload.temporaryPath, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(upload.temporaryPath, upload.targetPath);
    const createdAt = this.now();
    try {
      await utimes(upload.targetPath, new Date(createdAt), new Date(createdAt));
      const file: ConversationFileProjection = {
        id: this.options.store.fileProjectionId(upload.conversationId, 'UPLOAD', upload.name),
        conversationId: upload.conversationId,
        category: 'UPLOAD',
        relativePath: upload.name,
        displayName: upload.name,
        mimeType: upload.mimeType,
        size: upload.size,
        source: 'USER',
        createdAt,
        updatedAt: createdAt
      };
      upload.file = await this.options.store.registerFile(payload.userId, file);
      upload.status = 'COMPLETED';
      this.releaseUploadName(upload.conversationId, upload.name);
      this.options.publish(upload.conversationId, {
        conversationId: upload.conversationId,
        kind: 'files',
        files: this.options.store.listFiles(payload.userId, upload.conversationId),
        error: null
      });
      return { upload: hostedConversationUploadSchema.parse(uploadProjection(upload)) };
    } catch (error) {
      await rename(upload.targetPath, upload.temporaryPath).catch(() => undefined);
      this.releaseUploadName(upload.conversationId, upload.name);
      throw error;
    }
  }

  async cancelUpload(raw: unknown): Promise<unknown> {
    const payload = this.options.request(raw);
    const input = hostedConversationUploadControlInputSchema.parse(payload.data);
    const upload = this.requireUpload(payload.userId, input.conversationId, input.uploadId);
    if (upload.status === 'COMPLETED') throw new Error('HOSTED_CONVERSATION_UPLOAD_STATE_INVALID');
    upload.status = 'CANCELLED';
    await rm(upload.temporaryPath, { force: true });
    this.releaseUploadName(upload.conversationId, upload.name);
    return { upload: hostedConversationUploadSchema.parse(uploadProjection(upload)) };
  }

  private requireUpload(userId: number, conversationId: string, uploadId: string): ActiveUpload {
    this.options.store.requireConversation(userId, conversationId);
    const upload = this.uploads.get(uploadId);
    if (
      upload === undefined ||
      upload.userId !== userId ||
      upload.conversationId !== conversationId
    )
      throw new Error('HOSTED_CONVERSATION_UPLOAD_NOT_FOUND');
    return upload;
  }

  async requireAttachment(
    userId: number,
    conversationId: string,
    fileId: string
  ): Promise<ConversationFileProjection> {
    const file = this.options.store.requireFile(userId, conversationId, fileId);
    if (file.category !== 'UPLOAD') throw new Error('HOSTED_CONVERSATION_ATTACHMENT_INVALID');
    await assertRegularFile(this.options.store.filePath(userId, file), file.size);
    return file;
  }

  async cancelConversationUploads(userId: number, conversationId: string): Promise<void> {
    for (const upload of this.uploads.values()) {
      if (upload.userId !== userId || upload.conversationId !== conversationId) continue;
      if (upload.status === 'UPLOADING') {
        upload.status = 'CANCELLED';
        await rm(upload.temporaryPath, { force: true }).catch(() => undefined);
        this.releaseUploadName(upload.conversationId, upload.name);
      }
    }
  }

  private async uploadPreflightStatus(
    conversation: HostedConversationManifest,
    draft: Pick<ConversationTemplateDraft, 'quotas'>,
    name: string,
    size: number
  ): Promise<'READY' | 'INVALID_NAME' | 'TOO_LARGE' | 'QUOTA_EXCEEDED'> {
    if (Buffer.byteLength(name, 'utf8') > 255) return 'INVALID_NAME';
    if (size > draft.quotas.maxUploadBytes) return 'TOO_LARGE';
    if (conversation.quota.usedBytes + size > conversation.quota.maxBytes) return 'QUOTA_EXCEEDED';
    return 'READY';
  }

  private async allocateUploadName(
    paths: HostedConversationPaths,
    userId: number,
    conversationId: string,
    requestedName: string
  ): Promise<string> {
    const existingNames = new Set(
      this.options.store
        .listFiles(userId, conversationId)
        .filter((file) => file.category === 'UPLOAD')
        .map((file) => canonicalUploadName(file.relativePath))
    );
    const parts = uploadNameParts(requestedName);
    let index = parts.index;
    for (;;) {
      const candidate = uploadNameCandidate(parts, index);
      const canonical = canonicalUploadName(candidate);
      if (existingNames.has(canonical) || this.isUploadNameReserved(conversationId, canonical)) {
        index = Math.max(1, index + 1);
        continue;
      }
      this.reserveUploadName(conversationId, canonical);
      let target: Stats | undefined;
      try {
        target = await lstat(join(paths.uploadsDirectory, candidate));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate;
        this.releaseUploadName(conversationId, candidate);
        throw error;
      }
      if (target === undefined) return candidate;
      this.releaseUploadName(conversationId, candidate);
      if (!target.isFile()) throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
      existingNames.add(canonical);
      index = Math.max(1, index + 1);
    }
  }

  private isUploadNameReserved(conversationId: string, canonicalName: string): boolean {
    return this.uploadNameReservations.get(conversationId)?.has(canonicalName) ?? false;
  }

  private reserveUploadName(conversationId: string, canonicalName: string): void {
    const reserved = this.uploadNameReservations.get(conversationId) ?? new Set<string>();
    reserved.add(canonicalName);
    this.uploadNameReservations.set(conversationId, reserved);
  }

  private releaseUploadName(conversationId: string, name: string): void {
    const reserved = this.uploadNameReservations.get(conversationId);
    if (reserved === undefined) return;
    reserved.delete(canonicalUploadName(name));
    if (reserved.size === 0) this.uploadNameReservations.delete(conversationId);
  }
}
function canonicalUploadName(name: string): string {
  return name.normalize('NFKC').toLocaleLowerCase();
}

function uploadNameParts(name: string): {
  readonly stem: string;
  readonly extension: string;
  readonly index: number;
} {
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot) : '';
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const suffix = /^(.*) \((\d+)\)$/u.exec(stem);
  if (suffix === null || suffix[1] === undefined || suffix[2] === undefined)
    return { stem, extension, index: 0 };
  const index = Number.parseInt(suffix[2], 10);
  return {
    stem: suffix[1],
    extension,
    index: Number.isSafeInteger(index) && index > 0 ? index : 0
  };
}

function uploadNameCandidate(
  parts: { readonly stem: string; readonly extension: string },
  index: number
): string {
  if (index === 0) return `${parts.stem}${parts.extension}`;
  const suffix = ` (${index})`;
  const maximumStemLength = 512 - parts.extension.length - suffix.length;
  return `${truncateUploadStem(parts.stem, maximumStemLength)}${suffix}${parts.extension}`;
}

function truncateUploadStem(stem: string, maximumLength: number): string {
  if (stem.length <= maximumLength) return stem;
  const truncated = stem.slice(0, Math.max(0, maximumLength));
  const last = truncated.charCodeAt(truncated.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? truncated.slice(0, -1) : truncated;
}

function uploadProjection(upload: ActiveUpload) {
  return {
    uploadId: upload.uploadId,
    conversationId: upload.conversationId,
    name: upload.name,
    mimeType: upload.mimeType,
    receivedBytes: upload.receivedBytes,
    size: upload.size,
    status: upload.status,
    ...(upload.file === undefined ? {} : { file: upload.file })
  };
}

async function assertUploadTemporaryFile(path: string, expectedSize: number): Promise<void> {
  const metadata = await lstat(path).catch(() => {
    throw new Error('HOSTED_CONVERSATION_UPLOAD_STATE_INVALID');
  });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size !== expectedSize
  )
    throw new Error('HOSTED_CONVERSATION_UPLOAD_STATE_INVALID');
}
