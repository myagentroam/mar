import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  conversationFileProjectionSchema,
  hostedConversationManifestSchema,
  hostedConversationSummarySchema,
  type ConversationFileProjection,
  type HostedConversationManifest,
  type HostedConversationSummary
} from '@myagentroam/protocol';
import type { NodeDatabase } from '../database.js';
import { assertNodeRelations } from '../database-relations.js';

interface HostedConversationStoreOptions {
  readonly dataDirectory: string;
  readonly rootDirectory: string;
  readonly temporaryRootDirectory?: string;
  readonly nodeId: string;
  readonly database: NodeDatabase;
}

export interface HostedConversationListInput {
  readonly userId: number;
  readonly limit: number;
  readonly cursor?: string;
}

export interface HostedConversationListPage {
  readonly items: readonly HostedConversationSummary[];
  readonly nextCursor: string | null;
}

export interface HostedConversationPaths {
  readonly conversationDirectory: string;
  readonly manifestDirectory: string;
  readonly manifestPath: string;
  readonly homeDirectory: string;
  readonly dataDirectory: string;
  readonly uploadsDirectory: string;
  readonly outputDirectory: string;
  readonly temporaryRootDirectory: string;
  readonly runtimeDirectory: string;
  readonly templateBindingDirectory: string;
  readonly fileIndexDirectory: string;
  readonly quotaDirectory: string;
}

export interface HostedConversationMessageRecord {
  readonly conversationId: string;
  readonly clientMessageId: string;
  readonly runId: string;
  readonly userTextPresent: boolean;
  readonly status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface RebuiltHostedConversation {
  readonly manifest: HostedConversationManifest;
  readonly files: readonly ConversationFileProjection[];
}

interface HostedConversationCursor {
  readonly cursorVersion: 1;
  readonly sortVersion: 2;
  readonly limit: number;
  readonly pinned: boolean;
  readonly lastActivityAt: number;
  readonly id: string;
  readonly binding: string;
}

const STORAGE_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{7,159}$/u;
const PROTOCOL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const CURSOR_BINDING = /^[A-Za-z0-9_-]{43}$/u;
const HOSTED_CONVERSATION_CURSOR_VERSION = 1;
const HOSTED_CONVERSATION_SORT_VERSION = 2;
const MAX_HOSTED_CONVERSATION_PAGE_SIZE = 100;
const HOSTED_CONVERSATION_TEMPORARY_DIRECTORY = 'myagentroam-hosted-conversations';

/** Owns the private disk hierarchy that is authoritative for hosted conversations. */
export class HostedConversationStore {
  readonly templatesVersionsDirectory: string;
  readonly templatesPublishingDirectory: string;
  readonly usersDirectory: string;
  readonly garbageDirectory: string;
  readonly temporaryRootDirectory: string;
  private readonly temporaryNodeDirectory: string;
  private readonly conversationMutations = new Map<string, Promise<void>>();

  constructor(private readonly options: HostedConversationStoreOptions) {
    this.templatesVersionsDirectory = join(options.rootDirectory, 'templates', 'versions');
    this.templatesPublishingDirectory = join(options.rootDirectory, 'templates', 'publishing');
    this.usersDirectory = join(options.rootDirectory, 'users');
    this.garbageDirectory = join(options.rootDirectory, 'garbage');
    this.temporaryRootDirectory = resolve(
      options.temporaryRootDirectory ?? join(tmpdir(), HOSTED_CONVERSATION_TEMPORARY_DIRECTORY)
    );
    this.temporaryNodeDirectory = childPath(
      this.temporaryRootDirectory,
      opaqueStorageKey('node', 'myagentroam-hosted-node', options.nodeId)
    );
  }

  get rootDirectory(): string {
    return this.options.rootDirectory;
  }

  async initialize(): Promise<void> {
    await mkdir(this.options.dataDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.options.rootDirectory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.options.rootDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
    const dataRoot = await realpath(this.options.dataDirectory);
    const storeRoot = await realpath(this.options.rootDirectory);
    if (!within(dataRoot, storeRoot) || dataRoot === storeRoot)
      throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
    await rm(join(this.options.rootDirectory, 'recoverable-deleted'), {
      recursive: true,
      force: true
    });
    for (const directory of [
      join(this.options.rootDirectory, 'templates'),
      this.templatesVersionsDirectory,
      this.templatesPublishingDirectory,
      this.usersDirectory,
      this.garbageDirectory
    ]) {
      await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
      const actual = await realpath(directory);
      if (!within(storeRoot, actual)) throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
    }
    await this.recoverGarbage();
  }

  userStorageKey(userId: number): string {
    if (!Number.isSafeInteger(userId) || userId <= 0)
      throw new Error('HOSTED_CONVERSATION_NOT_AUTHORIZED');
    return `user_${createHash('sha256')
      .update(`myagentroam-hosted-user\0${this.options.nodeId}\0${userId}`)
      .digest('base64url')}`;
  }

  listConversations(input: HostedConversationListInput): HostedConversationListPage {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_HOSTED_CONVERSATION_PAGE_SIZE
    )
      throw new Error('HOSTED_CONVERSATION_LIST_INVALID');
    const userStorageKey = this.userStorageKey(input.userId);
    const position =
      input.cursor === undefined
        ? undefined
        : this.decodeConversationCursor(input.cursor, userStorageKey, input.limit);
    const columns = `id,node_id,session_id,template_id,template_name,active_version_id,
                     title,title_source,pinned_at,status,model_id,created_at,updated_at,last_activity_at`;
    const rows =
      position === undefined
        ? this.options.database.raw
            .prepare(
              `SELECT ${columns}
             FROM hosted_conversations
             WHERE user_storage_key=? AND node_id=?
             ORDER BY (pinned_at IS NOT NULL) DESC,last_activity_at DESC,id DESC
             LIMIT ?`
            )
            .all(userStorageKey, this.options.nodeId, input.limit + 1)
        : this.options.database.raw
            .prepare(
              `SELECT ${columns}
             FROM hosted_conversations
             WHERE user_storage_key=? AND node_id=?
               AND (
                 (pinned_at IS NOT NULL) < ?
                 OR (
                   (pinned_at IS NOT NULL) = ?
                   AND (last_activity_at < ? OR (last_activity_at = ? AND id < ?))
                 )
               )
             ORDER BY (pinned_at IS NOT NULL) DESC,last_activity_at DESC,id DESC
             LIMIT ?`
            )
            .all(
              userStorageKey,
              this.options.nodeId,
              position.pinned ? 1 : 0,
              position.pinned ? 1 : 0,
              position.lastActivityAt,
              position.lastActivityAt,
              position.id,
              input.limit + 1
            );
    const selected = rows.slice(0, input.limit);
    const items = selected.map(hostedConversationSummary);
    const last = selected.at(-1);
    return {
      items,
      nextCursor:
        rows.length > input.limit && last !== undefined
          ? this.encodeConversationCursor(
              userStorageKey,
              input.limit,
              last.pinned_at !== null,
              numberColumn(last.last_activity_at),
              stringColumn(last.id)
            )
          : null
    };
  }

  templateVersionDirectory(storageKey: string): string {
    return childPath(this.templatesVersionsDirectory, storageKey);
  }

  templatePublishingDirectory(storageKey: string): string {
    return childPath(this.templatesPublishingDirectory, storageKey);
  }

  conversationDirectory(userStorageKey: string, conversationStorageKey: string): string {
    const userDirectory = childPath(this.usersDirectory, userStorageKey);
    return childPath(join(userDirectory, 'sessions'), conversationStorageKey);
  }

  conversationStorageKey(conversationId: string): string {
    if (!PROTOCOL_ID.test(conversationId)) throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
    return `conversation_${createHash('sha256')
      .update(`myagentroam-hosted-conversation\0${this.options.nodeId}\0${conversationId}`)
      .digest('base64url')}`;
  }

  async prepareConversationEnvironment(
    userId: number,
    conversationId: string
  ): Promise<{
    readonly userStorageKey: string;
    readonly conversationStorageKey: string;
    readonly paths: HostedConversationPaths;
  }> {
    const userStorageKey = this.userStorageKey(userId);
    const conversationStorageKey = this.conversationStorageKey(conversationId);
    const paths = this.activePaths(userStorageKey, conversationStorageKey);
    await this.createConversationLayout(paths);
    return { userStorageKey, conversationStorageKey, paths };
  }

  pathsForConversation(userId: number, conversationId: string): HostedConversationPaths {
    const manifest = this.requireConversation(userId, conversationId);
    return this.activePaths(manifest.userStorageKey, manifest.conversationStorageKey);
  }

  pathsForManifest(manifest: HostedConversationManifest): HostedConversationPaths {
    const current = this.requireConversationById(manifest.id);
    if (
      current.userStorageKey !== manifest.userStorageKey ||
      current.conversationStorageKey !== manifest.conversationStorageKey
    )
      throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
    return this.activePaths(current.userStorageKey, current.conversationStorageKey);
  }

  findConversationById(conversationId: string): HostedConversationManifest | undefined {
    if (!PROTOCOL_ID.test(conversationId)) return undefined;
    const row = this.options.database.raw
      .prepare('SELECT * FROM hosted_conversations WHERE id=?')
      .get(conversationId) as SqlRow | undefined;
    return row === undefined ? undefined : hostedConversationManifest(row);
  }

  inactiveCleanupCandidates(cutoffAt: number): readonly HostedConversationManifest[] {
    if (!Number.isSafeInteger(cutoffAt) || cutoffAt < 0)
      throw new Error('HOSTED_CONVERSATION_INPUT_INVALID');
    return (
      this.options.database.raw
        .prepare(
          `SELECT * FROM hosted_conversations
           WHERE node_id=?
             AND status='ACTIVE'
             AND last_activity_at<?
           ORDER BY last_activity_at,id`
        )
        .all(this.options.nodeId, cutoffAt) as readonly SqlRow[]
    ).map(hostedConversationManifest);
  }

  async conversationStorageBytes(manifest: HostedConversationManifest): Promise<number> {
    return directorySize(this.pathsForManifest(manifest).conversationDirectory);
  }

  async hostedStorageUsedBytes(): Promise<number> {
    return directorySize(this.options.rootDirectory);
  }

  async prepareConversationTemporaryDirectory(
    userId: number,
    conversationId: string
  ): Promise<string> {
    const conversation = this.requireConversation(userId, conversationId);
    return this.prepareTemporaryDirectory(conversation);
  }

  async permanentDeleteConversation(conversationId: string): Promise<{
    readonly conversation: HostedConversationManifest;
    readonly releasedBytes: number;
  }> {
    return this.withConversationMutation(conversationId, async () => {
      const conversation = this.requireConversationById(conversationId);
      const source = this.pathsForManifest(conversation).conversationDirectory;
      await this.assertConversationLayout(conversationPaths(source));
      const releasedBytes = await directorySize(source);
      const garbage = join(
        this.garbageDirectory,
        `${conversation.conversationStorageKey}-${randomUUID()}`
      );
      if (!within(this.garbageDirectory, garbage))
        throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
      await rename(source, garbage);
      const database = this.options.database.raw;
      database.exec('BEGIN IMMEDIATE');
      try {
        this.adjustVersionReferences(versionReferences(conversation), []);
        database
          .prepare('DELETE FROM conversation_files WHERE conversation_id=?')
          .run(conversation.id);
        database
          .prepare('DELETE FROM hosted_conversation_messages WHERE conversation_id=?')
          .run(conversation.id);
        const deleted = database
          .prepare('DELETE FROM hosted_conversations WHERE id=?')
          .run(conversation.id);
        if (Number(deleted.changes) !== 1) throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        await rename(garbage, source).catch(() => undefined);
        throw error;
      }
      await rm(garbage, { recursive: true, force: true }).catch(() => undefined);
      await this.removeTemporaryDirectory(conversation);
      return { conversation, releasedBytes };
    });
  }

  async advanceLastActivity(
    conversationId: string,
    activityAt: number
  ): Promise<HostedConversationManifest> {
    if (!Number.isSafeInteger(activityAt) || activityAt < 0)
      throw new Error('HOSTED_CONVERSATION_INPUT_INVALID');
    return this.withConversationMutation(conversationId, async () => {
      const current = this.requireConversationById(conversationId);
      const nextActivityAt = Math.max(current.lastActivityAt, activityAt);
      const nextUpdatedAt = Math.max(current.updatedAt, activityAt);
      if (nextActivityAt === current.lastActivityAt && nextUpdatedAt === current.updatedAt)
        return current;
      return this.saveConversationUnlocked({
        ...current,
        updatedAt: nextUpdatedAt,
        lastActivityAt: nextActivityAt
      });
    });
  }

  findConversationByClientRequest(
    userId: number,
    clientRequestId: string
  ): HostedConversationManifest | undefined {
    if (!PROTOCOL_ID.test(clientRequestId)) throw new Error('HOSTED_CONVERSATION_INPUT_INVALID');
    const row = this.options.database.raw
      .prepare(
        'SELECT * FROM hosted_conversations WHERE user_storage_key=? AND client_request_id=?'
      )
      .get(this.userStorageKey(userId), clientRequestId) as SqlRow | undefined;
    return row === undefined ? undefined : hostedConversationManifest(row);
  }

  requireConversation(userId: number, conversationId: string): HostedConversationManifest {
    if (!PROTOCOL_ID.test(conversationId)) throw new Error('HOSTED_CONVERSATION_NOT_AUTHORIZED');
    const row = this.options.database.raw
      .prepare('SELECT * FROM hosted_conversations WHERE id=?')
      .get(conversationId) as SqlRow | undefined;
    if (row === undefined || stringColumn(row.user_storage_key) !== this.userStorageKey(userId))
      throw new Error('HOSTED_CONVERSATION_NOT_AUTHORIZED');
    return hostedConversationManifest(row);
  }

  async createConversation(
    manifest: HostedConversationManifest
  ): Promise<HostedConversationManifest> {
    const parsed = hostedConversationManifestSchema.parse(manifest);
    if (parsed.nodeId !== this.options.nodeId)
      throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
    if (parsed.clientRequestId !== undefined) {
      const existing = this.options.database.raw
        .prepare(
          'SELECT * FROM hosted_conversations WHERE user_storage_key=? AND client_request_id=?'
        )
        .get(parsed.userStorageKey, parsed.clientRequestId) as SqlRow | undefined;
      if (existing !== undefined) return hostedConversationManifest(existing);
    }
    const paths = this.activePaths(parsed.userStorageKey, parsed.conversationStorageKey);
    await this.createConversationLayout(paths);
    await this.writeManifest(paths.manifestPath, parsed);
    const database = this.options.database.raw;
    database.exec('BEGIN IMMEDIATE');
    try {
      this.insertConversation(parsed);
      this.adjustVersionReferences([], versionReferences(parsed));
      database.exec('COMMIT');
      return parsed;
    } catch (error) {
      database.exec('ROLLBACK');
      await rm(paths.conversationDirectory, { recursive: true, force: true }).catch(
        () => undefined
      );
      if (parsed.clientRequestId !== undefined && isUniqueConstraint(error)) {
        const repeated = this.options.database.raw
          .prepare(
            'SELECT * FROM hosted_conversations WHERE user_storage_key=? AND client_request_id=?'
          )
          .get(parsed.userStorageKey, parsed.clientRequestId) as SqlRow | undefined;
        if (repeated !== undefined) return hostedConversationManifest(repeated);
      }
      throw error;
    }
  }

  async saveConversation(
    manifest: HostedConversationManifest
  ): Promise<HostedConversationManifest> {
    const parsed = hostedConversationManifestSchema.parse(manifest);
    return this.withConversationMutation(parsed.id, () => this.saveConversationUnlocked(parsed));
  }

  async updateConversation(
    conversationId: string,
    update: (current: HostedConversationManifest) => HostedConversationManifest
  ): Promise<HostedConversationManifest> {
    return this.withConversationMutation(conversationId, () => {
      const current = this.requireConversationById(conversationId);
      const next = update(current);
      return next === current ? current : this.saveConversationUnlocked(next);
    });
  }

  async saveAutomaticTitle(
    conversationId: string,
    title: string,
    updatedAt: number
  ): Promise<HostedConversationManifest | undefined> {
    if (!Number.isSafeInteger(updatedAt) || updatedAt < 0)
      throw new Error('HOSTED_CONVERSATION_INPUT_INVALID');
    return this.withConversationMutation(conversationId, async () => {
      const current = this.requireConversationById(conversationId);
      if (current.titleSource !== 'AUTO' || current.title === title) return undefined;
      return this.saveConversationUnlocked({
        ...current,
        title,
        updatedAt: Math.max(current.updatedAt, updatedAt)
      });
    });
  }

  async saveMessageAcceptance(input: {
    readonly conversationId: string;
    readonly modelId: string;
    readonly activityAt: number;
    readonly automaticTitle?: string;
    readonly templateVersion?: {
      readonly expectedActiveVersionId: string;
      readonly activeVersionId: string;
      readonly maxStorageBytes: number;
    };
  }): Promise<{
    readonly conversation: HostedConversationManifest;
    readonly titleChanged: boolean;
  }> {
    if (!Number.isSafeInteger(input.activityAt) || input.activityAt < 0)
      throw new Error('HOSTED_CONVERSATION_INPUT_INVALID');
    return this.withConversationMutation(input.conversationId, async () => {
      const current = this.requireConversationById(input.conversationId);
      if (
        input.templateVersion !== undefined &&
        (current.activeVersionId !== input.templateVersion.expectedActiveVersionId ||
          current.templateDeleted ||
          current.status !== 'ACTIVE')
      )
        throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
      const titleChanged =
        input.automaticTitle !== undefined &&
        current.titleSource !== 'CUSTOM' &&
        (current.titleSource !== 'AUTO' || input.automaticTitle !== current.title);
      const conversation = await this.saveConversationUnlocked({
        ...current,
        ...(titleChanged ? { title: input.automaticTitle, titleSource: 'AUTO' as const } : {}),
        ...(input.templateVersion === undefined
          ? {}
          : {
              activeVersionId: input.templateVersion.activeVersionId,
              quota: {
                usedBytes: current.quota.usedBytes,
                maxBytes: input.templateVersion.maxStorageBytes
              }
            }),
        modelId: input.modelId,
        updatedAt: Math.max(current.updatedAt, input.activityAt),
        lastActivityAt: Math.max(current.lastActivityAt, input.activityAt)
      });
      return { conversation, titleChanged };
    });
  }

  private async saveConversationUnlocked(
    manifest: HostedConversationManifest
  ): Promise<HostedConversationManifest> {
    const parsed = hostedConversationManifestSchema.parse(manifest);
    const current = this.requireConversationById(parsed.id);
    const next = hostedConversationManifestSchema.parse({
      ...parsed,
      updatedAt: Math.max(current.updatedAt, parsed.updatedAt),
      lastActivityAt: Math.max(current.lastActivityAt, parsed.lastActivityAt)
    });
    if (
      current.userStorageKey !== next.userStorageKey ||
      current.conversationStorageKey !== next.conversationStorageKey ||
      current.nodeId !== next.nodeId ||
      current.sessionId !== next.sessionId ||
      current.clientRequestId !== next.clientRequestId
    )
      throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
    const paths = this.activePaths(next.userStorageKey, next.conversationStorageKey);
    await this.assertConversationLayout(paths);
    await this.writeManifest(paths.manifestPath, next);
    const database = this.options.database.raw;
    database.exec('BEGIN IMMEDIATE');
    try {
      this.updateConversationRow(next);
      this.adjustVersionReferences(versionReferences(current), versionReferences(next));
      database.exec('COMMIT');
      return next;
    } catch (error) {
      database.exec('ROLLBACK');
      await this.writeManifest(paths.manifestPath, current).catch(() => undefined);
      throw error;
    }
  }

  async rewriteManifestFromIndex(conversationId: string): Promise<HostedConversationManifest> {
    return this.withConversationMutation(conversationId, () =>
      this.rewriteManifestFromIndexUnlocked(conversationId)
    );
  }

  private async rewriteManifestFromIndexUnlocked(
    conversationId: string
  ): Promise<HostedConversationManifest> {
    const manifest = this.requireConversationById(conversationId);
    const paths = this.activePaths(manifest.userStorageKey, manifest.conversationStorageKey);
    await this.assertConversationLayout(paths);
    await this.writeManifest(paths.manifestPath, manifest);
    return manifest;
  }

  async retainConversationTemplate(
    userId: number,
    conversationId: string,
    updatedAt: number
  ): Promise<HostedConversationManifest> {
    if (!Number.isSafeInteger(updatedAt) || updatedAt < 0)
      throw new Error('HOSTED_CONVERSATION_INPUT_INVALID');
    const current = this.requireConversation(userId, conversationId);
    const version = this.options.database.raw
      .prepare('SELECT status FROM conversation_template_versions WHERE id=? AND template_id=?')
      .get(current.activeVersionId, current.templateId) as SqlRow | undefined;
    if (version === undefined || !['AVAILABLE', 'RETAINED'].includes(stringColumn(version.status)))
      throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    if (current.templateDeleted && stringColumn(version.status) === 'RETAINED') return current;
    const next = hostedConversationManifestSchema.parse({
      ...current,
      templateDeleted: true,
      updatedAt: Math.max(current.updatedAt, updatedAt)
    });
    const paths = this.activePaths(next.userStorageKey, next.conversationStorageKey);
    await this.assertConversationLayout(paths);
    await this.writeManifest(paths.manifestPath, next);
    const database = this.options.database.raw;
    database.exec('BEGIN IMMEDIATE');
    try {
      this.updateConversationRow(next);
      this.adjustVersionReferences(versionReferences(current), versionReferences(next));
      const retained = database
        .prepare(
          `UPDATE conversation_template_versions SET status='RETAINED'
           WHERE id=? AND template_id=? AND status IN ('AVAILABLE','RETAINED')`
        )
        .run(current.activeVersionId, current.templateId);
      if (Number(retained.changes) !== 1)
        throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
      database.exec('COMMIT');
      return next;
    } catch (error) {
      database.exec('ROLLBACK');
      await this.writeManifest(paths.manifestPath, current).catch(() => undefined);
      throw error;
    }
  }

  fileProjectionId(
    conversationId: string,
    category: ConversationFileProjection['category'],
    relativePath: string
  ): string {
    if (!PROTOCOL_ID.test(conversationId)) throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
    const validated = conversationFileProjectionSchema.parse({
      id: 'file_validation',
      conversationId,
      category,
      relativePath,
      displayName: relativePath.split('/').at(-1) ?? relativePath,
      mimeType: 'application/octet-stream',
      size: 0,
      source: category === 'UPLOAD' ? 'USER' : 'AGENT',
      createdAt: 0,
      updatedAt: 0
    });
    return `file_${createHash('sha256')
      .update(
        `myagentroam-hosted-file\0${this.options.nodeId}\0${conversationId}\0${validated.category}\0${validated.relativePath}`
      )
      .digest('base64url')}`;
  }

  async reconcileFiles(
    userId: number,
    conversationId: string
  ): Promise<readonly ConversationFileProjection[]> {
    return this.withConversationMutation(conversationId, async () => {
      const manifest = this.requireConversation(userId, conversationId);
      const paths = this.activePaths(manifest.userStorageKey, manifest.conversationStorageKey);
      await this.assertConversationLayout(paths);
      const existing = this.existingFiles(conversationId);
      const files = await this.scanConversationFiles(manifest, paths, existing);
      await this.replaceConversationFiles(manifest, paths, files);
      return files;
    });
  }

  listFiles(userId: number, conversationId: string): readonly ConversationFileProjection[] {
    this.requireConversation(userId, conversationId);
    return (
      this.options.database.raw
        .prepare(
          `SELECT id,conversation_id,category,relative_path,display_name,mime_type,size,source,
                  turn_id,item_id,created_at,updated_at
           FROM conversation_files
           WHERE conversation_id=?
           ORDER BY updated_at DESC,relative_path,category`
        )
        .all(conversationId) as readonly SqlRow[]
    ).map(conversationFileProjection);
  }

  requireFile(userId: number, conversationId: string, fileId: string): ConversationFileProjection {
    this.requireConversation(userId, conversationId);
    const row = this.options.database.raw
      .prepare(
        `SELECT id,conversation_id,category,relative_path,display_name,mime_type,size,source,
                turn_id,item_id,created_at,updated_at
         FROM conversation_files WHERE id=? AND conversation_id=?`
      )
      .get(fileId, conversationId) as SqlRow | undefined;
    if (row === undefined) throw new Error('HOSTED_CONVERSATION_FILE_NOT_FOUND');
    return conversationFileProjection(row);
  }

  filePath(userId: number, file: ConversationFileProjection): string {
    const paths = this.pathsForConversation(userId, file.conversationId);
    const root = file.category === 'UPLOAD' ? paths.uploadsDirectory : paths.outputDirectory;
    return safeRelativePath(root, file.relativePath);
  }

  async deleteFile(
    userId: number,
    conversationId: string,
    fileId: string,
    deletedAt: number
  ): Promise<readonly ConversationFileProjection[]> {
    if (!Number.isSafeInteger(deletedAt) || deletedAt < 0)
      throw new Error('HOSTED_CONVERSATION_INPUT_INVALID');
    return this.withConversationMutation(conversationId, () =>
      this.deleteFileUnlocked(userId, conversationId, fileId, deletedAt)
    );
  }

  private async deleteFileUnlocked(
    userId: number,
    conversationId: string,
    fileId: string,
    deletedAt: number
  ): Promise<readonly ConversationFileProjection[]> {
    const manifest = this.requireConversation(userId, conversationId);
    const file = this.requireFile(userId, conversationId, fileId);
    const paths = this.activePaths(manifest.userStorageKey, manifest.conversationStorageKey);
    await this.assertConversationLayout(paths);
    const source = this.filePath(userId, file);
    const metadata = await lstat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new Error('HOSTED_CONVERSATION_FILE_NOT_FOUND');
      throw error;
    });
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1)
      throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
    if (metadata.size !== file.size || safeFileTimestamp(metadata.mtimeMs) !== file.updatedAt)
      throw new Error('HOSTED_CONVERSATION_FILE_CONFLICT');

    const tombstone = join(paths.temporaryRootDirectory, `.deleted-${randomUUID()}`);
    await rename(source, tombstone).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new Error('HOSTED_CONVERSATION_FILE_NOT_FOUND');
      throw error;
    });
    try {
      const moved = await lstat(tombstone);
      if (
        !moved.isFile() ||
        moved.isSymbolicLink() ||
        moved.nlink !== 1 ||
        moved.size !== file.size ||
        safeFileTimestamp(moved.mtimeMs) !== file.updatedAt
      )
        throw new Error('HOSTED_CONVERSATION_FILE_CONFLICT');
      const existing = this.existingFiles(conversationId);
      const files = await this.scanConversationFiles(manifest, paths, existing);
      if (files.some((candidate) => candidate.id === file.id)) {
        await rm(tombstone, { force: true }).catch(() => undefined);
        await this.replaceConversationFiles(manifest, paths, files);
        throw new Error('HOSTED_CONVERSATION_FILE_CONFLICT');
      }
      await this.replaceConversationFiles(manifest, paths, files, deletedAt);
      await rm(tombstone, { force: true }).catch(() => undefined);
      return files;
    } catch (error) {
      const sourceState = await lstat(source).catch((sourceError: NodeJS.ErrnoException) => {
        if (sourceError.code === 'ENOENT') return undefined;
        throw sourceError;
      });
      if (sourceState === undefined) {
        await rename(tombstone, source).catch(() => {
          throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
        });
      } else {
        await rm(tombstone, { force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  async registerFile(
    userId: number,
    file: ConversationFileProjection
  ): Promise<ConversationFileProjection> {
    const input = conversationFileProjectionSchema.parse(file);
    return this.withConversationMutation(input.conversationId, () =>
      this.registerFileUnlocked(userId, input)
    );
  }

  private async registerFileUnlocked(
    userId: number,
    input: ConversationFileProjection
  ): Promise<ConversationFileProjection> {
    const manifest = this.requireConversation(userId, input.conversationId);
    const path = this.filePath(userId, input);
    const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new Error('HOSTED_CONVERSATION_FILE_NOT_FOUND');
      throw error;
    });
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.size !== input.size
    )
      throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
    const modifiedAt = safeFileTimestamp(metadata.mtimeMs);
    const parsed = conversationFileProjectionSchema.parse({
      ...input,
      createdAt: Math.min(input.createdAt, modifiedAt),
      updatedAt: modifiedAt
    });
    if (manifest.quota.usedBytes + parsed.size > manifest.quota.maxBytes)
      throw new Error('HOSTED_CONVERSATION_QUOTA_EXCEEDED');
    const database = this.options.database.raw;
    database.exec('BEGIN IMMEDIATE');
    try {
      database
        .prepare(
          `INSERT INTO conversation_files
           (id,conversation_id,category,relative_path,display_name,mime_type,size,source,
            turn_id,item_id,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          parsed.id,
          parsed.conversationId,
          parsed.category,
          parsed.relativePath,
          parsed.displayName,
          parsed.mimeType,
          parsed.size,
          parsed.source,
          parsed.turnId ?? null,
          parsed.itemId ?? null,
          parsed.createdAt,
          parsed.updatedAt
        );
      const update = database
        .prepare(
          `UPDATE hosted_conversations
           SET used_bytes=used_bytes+?,
               updated_at=MAX(updated_at,?),
               last_activity_at=MAX(last_activity_at,?)
           WHERE id=? AND used_bytes+?<=max_bytes`
        )
        .run(parsed.size, parsed.updatedAt, parsed.updatedAt, parsed.conversationId, parsed.size);
      if (Number(update.changes) !== 1) throw new Error('HOSTED_CONVERSATION_QUOTA_EXCEEDED');
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      if (isUniqueConstraint(error)) throw new Error('HOSTED_CONVERSATION_FILE_CONFLICT');
      throw error;
    }
    try {
      await this.rewriteManifestFromIndexUnlocked(parsed.conversationId);
    } catch (error) {
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare('DELETE FROM conversation_files WHERE id=?').run(parsed.id);
        database
          .prepare(
            `UPDATE hosted_conversations
             SET used_bytes=CASE WHEN used_bytes>=? THEN used_bytes-? ELSE 0 END
             WHERE id=?`
          )
          .run(parsed.size, parsed.size, parsed.conversationId);
        database.exec('COMMIT');
      } catch {
        database.exec('ROLLBACK');
      }
      throw error;
    }
    return parsed;
  }

  findMessage(
    userId: number,
    conversationId: string,
    clientMessageId: string
  ): HostedConversationMessageRecord | undefined {
    this.requireConversation(userId, conversationId);
    const row = this.options.database.raw
      .prepare(
        `SELECT conversation_id,client_message_id,run_id,user_text_present,status,created_at,updated_at
         FROM hosted_conversation_messages
         WHERE conversation_id=? AND client_message_id=?`
      )
      .get(conversationId, clientMessageId) as SqlRow | undefined;
    return row === undefined ? undefined : hostedConversationMessage(row);
  }

  hasNonEmptyUserMessage(userId: number, conversationId: string): boolean {
    this.requireConversation(userId, conversationId);
    return (
      this.options.database.raw
        .prepare(
          `SELECT 1
           FROM hosted_conversation_messages
           WHERE conversation_id=? AND user_text_present=1
           LIMIT 1`
        )
        .get(conversationId) !== undefined
    );
  }

  createMessage(record: HostedConversationMessageRecord): HostedConversationMessageRecord {
    const result = this.options.database.raw
      .prepare(
        `INSERT INTO hosted_conversation_messages
         (conversation_id,client_message_id,run_id,user_text_present,status,created_at,updated_at)
         SELECT ?,?,?,?,?,?,? FROM hosted_conversations WHERE id=?`
      )
      .run(
        record.conversationId,
        record.clientMessageId,
        record.runId,
        record.userTextPresent ? 1 : 0,
        record.status,
        record.createdAt,
        record.updatedAt,
        record.conversationId
      );
    if (Number(result.changes) !== 1) throw new Error('HOSTED_CONVERSATION_NOT_FOUND');
    return record;
  }

  finishMessage(
    conversationId: string,
    clientMessageId: string,
    status: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED',
    updatedAt: number
  ): void {
    this.options.database.raw
      .prepare(
        `UPDATE hosted_conversation_messages
         SET status=?,updated_at=?
         WHERE conversation_id=? AND client_message_id=?`
      )
      .run(status, updatedAt, conversationId, clientMessageId);
  }
  finishRunMessages(
    conversationId: string,
    runId: string,
    status: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED',
    updatedAt: number
  ): void {
    this.options.database.raw
      .prepare(
        `UPDATE hosted_conversation_messages SET status=?,updated_at=? WHERE conversation_id=? AND run_id=?`
      )
      .run(status, updatedAt, conversationId, runId);
  }

  async rebuildConversationIndex(): Promise<readonly HostedConversationManifest[]> {
    const existing = this.existingFilesByConversation();
    const rebuilt = await this.scanConversationRoot(this.usersDirectory, existing);
    const ids = new Set<string>();
    for (const item of rebuilt) {
      if (ids.has(item.manifest.id)) throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
      ids.add(item.manifest.id);
    }
    this.replaceConversationIndex(rebuilt);
    return rebuilt.map((item) => item.manifest);
  }

  private async recoverGarbage(): Promise<void> {
    for (const entry of await sortedEntries(this.garbageDirectory))
      await rm(join(this.garbageDirectory, entry.name), { recursive: true, force: true });
  }

  private async scanConversationRoot(
    rootDirectory: string,
    existing: ReadonlyMap<string, ReadonlyMap<string, ConversationFileProjection>>
  ): Promise<readonly RebuiltHostedConversation[]> {
    const rebuilt: RebuiltHostedConversation[] = [];
    const root = await realpath(rootDirectory);
    for (const user of await sortedEntries(rootDirectory)) {
      if (user.isSymbolicLink() || !user.isDirectory() || !STORAGE_KEY.test(user.name))
        throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
      const sessionsDirectory = join(rootDirectory, user.name, 'sessions');
      const sessionsInfo = await lstat(sessionsDirectory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (sessionsInfo === undefined) continue;
      if (!sessionsInfo.isDirectory() || sessionsInfo.isSymbolicLink())
        throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
      const actualSessions = await realpath(sessionsDirectory);
      if (!within(root, actualSessions)) throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
      for (const conversation of await sortedEntries(sessionsDirectory)) {
        if (
          conversation.isSymbolicLink() ||
          !conversation.isDirectory() ||
          !STORAGE_KEY.test(conversation.name)
        )
          throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
        const directory = join(sessionsDirectory, conversation.name);
        const actual = await realpath(directory);
        if (!within(actualSessions, actual)) throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
        const paths = conversationPaths(directory);
        await this.assertConversationLayout(paths);
        let manifest: HostedConversationManifest;
        let manifestNeedsUpgrade = false;
        try {
          const stored = storedHostedConversationManifest(
            JSON.parse(await readFile(paths.manifestPath, 'utf8'))
          );
          manifest = stored.manifest;
          manifestNeedsUpgrade = stored.upgraded;
        } catch {
          throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
        }
        if (
          manifest.nodeId !== this.options.nodeId ||
          manifest.userStorageKey !== user.name ||
          manifest.conversationStorageKey !== conversation.name
        )
          throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
        const indexed = existing.get(manifest.id) ?? new Map();
        await this.cleanupRestartTransients(paths, indexed);
        const files = await this.scanConversationFiles(manifest, paths, indexed);
        const usedBytes = this.assertFileQuotas(manifest, files);
        const next =
          usedBytes === manifest.quota.usedBytes
            ? manifest
            : hostedConversationManifestSchema.parse({
                ...manifest,
                quota: { ...manifest.quota, usedBytes }
              });
        if (manifestNeedsUpgrade || next !== manifest)
          await this.writeManifest(paths.manifestPath, next);
        rebuilt.push({ manifest: next, files });
      }
    }
    return rebuilt;
  }

  private existingFilesByConversation(): ReadonlyMap<
    string,
    ReadonlyMap<string, ConversationFileProjection>
  > {
    const files = this.options.database.raw
      .prepare(
        `SELECT id,conversation_id,category,relative_path,display_name,mime_type,size,source,
                turn_id,item_id,created_at,updated_at
         FROM conversation_files`
      )
      .all() as readonly SqlRow[];
    const byConversation = new Map<string, Map<string, ConversationFileProjection>>();
    for (const row of files) {
      const file = conversationFileProjection(row);
      let indexed = byConversation.get(file.conversationId);
      if (indexed === undefined) {
        indexed = new Map();
        byConversation.set(file.conversationId, indexed);
      }
      indexed.set(fileProjectionKey(file.category, file.relativePath), file);
    }
    return byConversation;
  }

  private existingFiles(conversationId: string): ReadonlyMap<string, ConversationFileProjection> {
    return this.existingFilesByConversation().get(conversationId) ?? new Map();
  }

  private async cleanupRestartTransients(
    paths: HostedConversationPaths,
    existing: ReadonlyMap<string, ConversationFileProjection>
  ): Promise<void> {
    for (const entry of await sortedEntries(paths.temporaryRootDirectory))
      await rm(join(paths.temporaryRootDirectory, entry.name), { recursive: true, force: true });
    for (const entry of await sortedEntries(paths.uploadsDirectory)) {
      if (!/^\.[A-Za-z0-9][A-Za-z0-9._:-]{0,159}\.upload$/u.test(entry.name)) continue;
      if (existing.has(fileProjectionKey('UPLOAD', entry.name))) continue;
      await rm(join(paths.uploadsDirectory, entry.name), { recursive: true, force: true });
    }
  }

  private async scanConversationFiles(
    manifest: HostedConversationManifest,
    paths: HostedConversationPaths,
    existing: ReadonlyMap<string, ConversationFileProjection>
  ): Promise<readonly ConversationFileProjection[]> {
    const files: ConversationFileProjection[] = [];
    for (const [category, root] of [
      ['UPLOAD', paths.uploadsDirectory],
      ['OUTPUT', paths.outputDirectory]
    ] as const)
      await this.scanProjectedDirectory(manifest, category, root, root, existing, files);
    return files.sort((left, right) =>
      fileProjectionKey(left.category, left.relativePath).localeCompare(
        fileProjectionKey(right.category, right.relativePath),
        'en-US'
      )
    );
  }

  private async scanProjectedDirectory(
    manifest: HostedConversationManifest,
    category: ConversationFileProjection['category'],
    root: string,
    directory: string,
    existing: ReadonlyMap<string, ConversationFileProjection>,
    output: ConversationFileProjection[]
  ): Promise<void> {
    for (const entry of await sortedEntries(directory)) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
      if (entry.isDirectory()) {
        await this.scanProjectedDirectory(manifest, category, root, path, existing, output);
        continue;
      }
      if (!entry.isFile()) throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
      const relativePath = relative(root, path).split(sep).join('/');
      if (
        category === 'UPLOAD' &&
        /^\.[A-Za-z0-9][A-Za-z0-9._:-]{0,159}\.upload$/u.test(relativePath) &&
        !existing.has(fileProjectionKey(category, relativePath))
      )
        continue;
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1)
        throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
      if (!Number.isSafeInteger(metadata.size) || metadata.size < 0)
        throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
      const key = fileProjectionKey(category, relativePath);
      const previous = existing.get(key);
      const modifiedAt = safeFileTimestamp(metadata.mtimeMs);
      const createdAt =
        previous?.createdAt ?? safeFileTimestamp(metadata.birthtimeMs || metadata.ctimeMs);
      output.push(
        conversationFileProjectionSchema.parse({
          id: previous?.id ?? this.fileProjectionId(manifest.id, category, relativePath),
          conversationId: manifest.id,
          category,
          relativePath,
          displayName: relativePath.split('/').at(-1) ?? relativePath,
          mimeType: previous?.mimeType ?? inferMimeType(relativePath),
          size: metadata.size,
          source: previous?.source ?? (category === 'UPLOAD' ? 'USER' : 'AGENT'),
          ...(previous?.turnId === undefined ? {} : { turnId: previous.turnId }),
          ...(previous?.itemId === undefined ? {} : { itemId: previous.itemId }),
          createdAt,
          updatedAt: Math.max(createdAt, modifiedAt)
        })
      );
    }
  }

  private async replaceConversationFiles(
    manifest: HostedConversationManifest,
    paths: HostedConversationPaths,
    files: readonly ConversationFileProjection[],
    activityAt = 0
  ): Promise<void> {
    const usedBytes = this.assertFileQuotas(manifest, files);
    const latestFileAt = files.reduce((latest, file) => Math.max(latest, file.updatedAt), 0);
    const next = hostedConversationManifestSchema.parse({
      ...manifest,
      updatedAt: Math.max(manifest.updatedAt, latestFileAt, activityAt),
      lastActivityAt: Math.max(manifest.lastActivityAt, latestFileAt, activityAt),
      quota: { ...manifest.quota, usedBytes }
    });
    await this.writeManifest(paths.manifestPath, next);
    const database = this.options.database.raw;
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare('DELETE FROM conversation_files WHERE conversation_id=?').run(manifest.id);
      const insert = conversationFileInsert(database);
      for (const file of files) insertConversationFile(insert, file);
      this.updateConversationRow(next);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      await this.writeManifest(paths.manifestPath, manifest).catch(() => undefined);
      throw error;
    }
  }

  private assertFileQuotas(
    manifest: HostedConversationManifest,
    files: readonly ConversationFileProjection[]
  ): number {
    const usedBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (usedBytes > manifest.quota.maxBytes) throw new Error('HOSTED_CONVERSATION_QUOTA_EXCEEDED');
    return usedBytes;
  }

  private encodeConversationCursor(
    userStorageKey: string,
    limit: number,
    pinned: boolean,
    lastActivityAt: number,
    id: string
  ): string {
    const cursor: HostedConversationCursor = {
      cursorVersion: HOSTED_CONVERSATION_CURSOR_VERSION,
      sortVersion: HOSTED_CONVERSATION_SORT_VERSION,
      limit,
      pinned,
      lastActivityAt,
      id,
      binding: this.conversationCursorBinding(userStorageKey, limit, pinned, lastActivityAt, id)
    };
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodeConversationCursor(
    cursor: string,
    userStorageKey: string,
    limit: number
  ): HostedConversationCursor {
    try {
      if (cursor.length === 0 || cursor.length > 2_048 || !/^[A-Za-z0-9_-]+$/u.test(cursor))
        throw new Error('invalid cursor encoding');
      const decoded = Buffer.from(cursor, 'base64url');
      if (decoded.toString('base64url') !== cursor) throw new Error('non-canonical cursor');
      const value: unknown = JSON.parse(decoded.toString('utf8'));
      if (!isHostedConversationCursor(value)) throw new Error('invalid cursor payload');
      if (
        value.cursorVersion !== HOSTED_CONVERSATION_CURSOR_VERSION ||
        value.sortVersion !== HOSTED_CONVERSATION_SORT_VERSION ||
        value.limit !== limit ||
        value.binding !==
          this.conversationCursorBinding(
            userStorageKey,
            value.limit,
            value.pinned,
            value.lastActivityAt,
            value.id
          )
      )
        throw new Error('cursor binding mismatch');
      return value;
    } catch {
      throw new Error('HOSTED_CONVERSATION_CURSOR_INVALID');
    }
  }

  private conversationCursorBinding(
    userStorageKey: string,
    limit: number,
    pinned: boolean,
    lastActivityAt: number,
    id: string
  ): string {
    return createHash('sha256')
      .update(
        [
          'myagentroam-hosted-conversation-cursor',
          this.options.nodeId,
          userStorageKey,
          String(HOSTED_CONVERSATION_SORT_VERSION),
          String(limit),
          String(pinned),
          String(lastActivityAt),
          id
        ].join('\0')
      )
      .digest('base64url');
  }

  private requireConversationById(conversationId: string): HostedConversationManifest {
    const row = this.options.database.raw
      .prepare('SELECT * FROM hosted_conversations WHERE id=?')
      .get(conversationId) as SqlRow | undefined;
    if (row === undefined) throw new Error('HOSTED_CONVERSATION_NOT_FOUND');
    return hostedConversationManifest(row);
  }

  private activePaths(
    userStorageKey: string,
    conversationStorageKey: string
  ): HostedConversationPaths {
    return conversationPaths(this.conversationDirectory(userStorageKey, conversationStorageKey));
  }

  private async prepareTemporaryDirectory(
    conversation: HostedConversationManifest
  ): Promise<string> {
    await this.ensureTemporaryNodeDirectory();
    const userDirectory = childPath(this.temporaryNodeDirectory, conversation.userStorageKey);
    await this.ensureDirectory(userDirectory, this.temporaryNodeDirectory);
    const conversationDirectory = childPath(userDirectory, conversation.conversationStorageKey);
    await this.ensureDirectory(conversationDirectory, userDirectory);
    return conversationDirectory;
  }

  private async removeTemporaryDirectory(conversation: HostedConversationManifest): Promise<void> {
    try {
      const directory = await this.prepareTemporaryDirectory(conversation);
      await rm(directory, { recursive: true, force: true });
    } catch {
      // Host temporary storage is best-effort and may already be unavailable.
    }
  }

  private async ensureTemporaryNodeDirectory(): Promise<void> {
    await mkdir(this.temporaryRootDirectory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.temporaryRootDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
    const actualRoot = await realpath(this.temporaryRootDirectory);
    if (actualRoot !== this.temporaryRootDirectory)
      throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
    await this.ensureDirectory(this.temporaryNodeDirectory, this.temporaryRootDirectory);
  }

  private async createConversationLayout(paths: HostedConversationPaths): Promise<void> {
    const userDirectory = dirname(dirname(paths.conversationDirectory));
    const sessionsDirectory = dirname(paths.conversationDirectory);
    await this.ensureDirectory(userDirectory, this.usersDirectory);
    await this.ensureDirectory(sessionsDirectory, userDirectory);
    await this.ensureDirectory(paths.conversationDirectory, sessionsDirectory);
    for (const directory of [
      paths.manifestDirectory,
      paths.homeDirectory,
      paths.dataDirectory,
      paths.uploadsDirectory,
      paths.outputDirectory,
      paths.temporaryRootDirectory,
      paths.runtimeDirectory,
      paths.templateBindingDirectory,
      paths.fileIndexDirectory,
      paths.quotaDirectory
    ])
      await this.ensureDirectory(directory, paths.conversationDirectory);
  }

  private async assertConversationLayout(paths: HostedConversationPaths): Promise<void> {
    const metadata = await lstat(paths.conversationDirectory).catch(() => {
      throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
    });
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
    const root = await realpath(paths.conversationDirectory);
    if (root !== resolve(paths.conversationDirectory))
      throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
    for (const directory of [
      paths.manifestDirectory,
      paths.homeDirectory,
      paths.dataDirectory,
      paths.uploadsDirectory,
      paths.outputDirectory,
      paths.temporaryRootDirectory,
      paths.runtimeDirectory,
      paths.templateBindingDirectory,
      paths.fileIndexDirectory,
      paths.quotaDirectory
    ]) {
      const directoryMetadata = await lstat(directory).catch(() => {
        throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
      });
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink())
        throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
      const actual = await realpath(directory);
      if (!within(root, actual)) throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
    }
  }

  private async ensureDirectory(path: string, root: string): Promise<void> {
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
    const actual = await realpath(path);
    const actualRoot = await realpath(root);
    if (actual !== actualRoot && !within(actualRoot, actual))
      throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
  }

  private async withConversationMutation<T>(
    conversationId: string,
    operation: () => Promise<T> | T
  ): Promise<T> {
    const previous = this.conversationMutations.get(conversationId) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined
    );
    this.conversationMutations.set(conversationId, settled);
    try {
      return await result;
    } finally {
      if (this.conversationMutations.get(conversationId) === settled)
        this.conversationMutations.delete(conversationId);
    }
  }

  private async writeManifest(
    manifestPath: string,
    manifest: HostedConversationManifest
  ): Promise<void> {
    const parsed = hostedConversationManifestSchema.parse(manifest);
    const temporaryPath = join(dirname(manifestPath), `.conversation-${randomUUID()}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(parsed)}\n`, { mode: 0o600, flag: 'wx' });
    try {
      await rename(temporaryPath, manifestPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private insertConversation(manifest: HostedConversationManifest): void {
    this.assertConversationVersion(manifest);
    this.options.database.raw
      .prepare(
        `INSERT INTO hosted_conversations
         (id,user_storage_key,conversation_storage_key,client_request_id,node_id,session_id,
          template_id,template_name,active_version_id,title,title_source,pinned_at,status,model_id,
          template_deleted,used_bytes,max_bytes,created_at,updated_at,
          last_activity_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        manifest.id,
        manifest.userStorageKey,
        manifest.conversationStorageKey,
        manifest.clientRequestId ?? null,
        manifest.nodeId,
        manifest.sessionId,
        manifest.templateId,
        manifest.templateName,
        manifest.activeVersionId,
        manifest.title,
        manifest.titleSource,
        manifest.pinnedAt,
        manifest.status,
        manifest.modelId,
        manifest.templateDeleted ? 1 : 0,
        manifest.quota.usedBytes,
        manifest.quota.maxBytes,
        manifest.createdAt,
        manifest.updatedAt,
        manifest.lastActivityAt
      );
  }

  private updateConversationRow(manifest: HostedConversationManifest): void {
    this.assertConversationVersion(manifest);
    const result = this.options.database.raw
      .prepare(
        `UPDATE hosted_conversations
         SET template_id=?,template_name=?,active_version_id=?,title=?,title_source=?,pinned_at=?,
             status=?,model_id=?,template_deleted=?,
             used_bytes=?,max_bytes=?,updated_at=?,last_activity_at=?
         WHERE id=? AND user_storage_key=? AND conversation_storage_key=? AND node_id=? AND session_id=?`
      )
      .run(
        manifest.templateId,
        manifest.templateName,
        manifest.activeVersionId,
        manifest.title,
        manifest.titleSource,
        manifest.pinnedAt,
        manifest.status,
        manifest.modelId,
        manifest.templateDeleted ? 1 : 0,
        manifest.quota.usedBytes,
        manifest.quota.maxBytes,
        manifest.updatedAt,
        manifest.lastActivityAt,
        manifest.id,
        manifest.userStorageKey,
        manifest.conversationStorageKey,
        manifest.nodeId,
        manifest.sessionId
      );
    if (Number(result.changes) !== 1) throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
  }

  private assertConversationVersion(manifest: HostedConversationManifest): void {
    if (
      this.options.database.raw
        .prepare('SELECT 1 FROM conversation_template_versions WHERE id=? AND template_id=?')
        .get(manifest.activeVersionId, manifest.templateId) === undefined
    )
      throw Object.assign(new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED'), {
        publicDetails: 'The active template version does not exist or belongs to another template.'
      });
  }

  private adjustVersionReferences(previous: readonly string[], next: readonly string[]): void {
    const counts = new Map<string, number>();
    for (const id of previous) counts.set(id, (counts.get(id) ?? 0) - 1);
    for (const id of next) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [id, delta] of counts) {
      if (delta === 0) continue;
      const result =
        delta > 0
          ? this.options.database.raw
              .prepare(
                'UPDATE conversation_template_versions SET reference_count=reference_count+? WHERE id=?'
              )
              .run(delta, id)
          : this.options.database.raw
              .prepare(
                `UPDATE conversation_template_versions
                 SET reference_count=reference_count+?
                 WHERE id=? AND reference_count>=?`
              )
              .run(delta, id, -delta);
      if (Number(result.changes) !== 1) throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    }
  }

  private replaceConversationIndex(rebuilt: readonly RebuiltHostedConversation[]): void {
    const database = this.options.database.raw;
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare('DELETE FROM conversation_files').run();
      if (rebuilt.length === 0) {
        database.prepare('DELETE FROM hosted_conversation_messages').run();
        database.prepare('DELETE FROM hosted_conversations').run();
      } else {
        const placeholders = rebuilt.map(() => '?').join(',');
        const ids = rebuilt.map((item) => item.manifest.id);
        database
          .prepare(
            `DELETE FROM hosted_conversation_messages
             WHERE conversation_id NOT IN (${placeholders})`
          )
          .run(...ids);
        database
          .prepare(`DELETE FROM hosted_conversations WHERE id NOT IN (${placeholders})`)
          .run(...ids);
      }
      database.prepare('UPDATE conversation_template_versions SET reference_count=0').run();
      const upsert = database.prepare(
        `INSERT INTO hosted_conversations
         (id,user_storage_key,conversation_storage_key,client_request_id,node_id,session_id,template_id,template_name,
          active_version_id,title,title_source,pinned_at,status,model_id,template_deleted,
          used_bytes,max_bytes,created_at,updated_at,last_activity_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
          user_storage_key=excluded.user_storage_key,
          conversation_storage_key=excluded.conversation_storage_key,
          client_request_id=excluded.client_request_id,
          node_id=excluded.node_id,
          session_id=excluded.session_id,
          template_id=excluded.template_id,
          template_name=excluded.template_name,
          active_version_id=excluded.active_version_id,
          title=excluded.title,
          title_source=excluded.title_source,
          pinned_at=excluded.pinned_at,
          status=excluded.status,
          model_id=excluded.model_id,
          template_deleted=excluded.template_deleted,
          used_bytes=excluded.used_bytes,
          max_bytes=excluded.max_bytes,
          created_at=excluded.created_at,
          updated_at=excluded.updated_at,
          last_activity_at=excluded.last_activity_at`
      );
      const insertFile = conversationFileInsert(database);
      const addReference = database.prepare(
        'UPDATE conversation_template_versions SET reference_count=reference_count+1 WHERE id=?'
      );
      for (const item of rebuilt) {
        const manifest = item.manifest;
        this.assertConversationVersion(manifest);
        upsert.run(
          manifest.id,
          manifest.userStorageKey,
          manifest.conversationStorageKey,
          manifest.clientRequestId ?? null,
          manifest.nodeId,
          manifest.sessionId,
          manifest.templateId,
          manifest.templateName,
          manifest.activeVersionId,
          manifest.title,
          manifest.titleSource,
          manifest.pinnedAt,
          manifest.status,
          manifest.modelId,
          manifest.templateDeleted ? 1 : 0,
          manifest.quota.usedBytes,
          manifest.quota.maxBytes,
          manifest.createdAt,
          manifest.updatedAt,
          manifest.lastActivityAt
        );
        for (const file of item.files) insertConversationFile(insertFile, file);
        if (Number(addReference.run(manifest.activeVersionId).changes) !== 1)
          throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
      }
      database
        .prepare(
          `UPDATE hosted_conversation_messages
           SET status='INTERRUPTED',updated_at=? WHERE status='RUNNING'`
        )
        .run(Date.now());
      assertNodeRelations(database);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

async function directorySize(path: string): Promise<number> {
  const metadata = await lstat(path);
  if (metadata.isFile() || metadata.isSymbolicLink()) {
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0)
      throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
    return metadata.size;
  }
  if (!metadata.isDirectory()) throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
  let total = 0;
  for (const entry of await sortedEntries(path)) {
    total += await directorySize(join(path, entry.name));
    if (!Number.isSafeInteger(total)) throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
  }
  return total;
}

function fileProjectionKey(
  category: ConversationFileProjection['category'],
  relativePath: string
): string {
  return `${category}:${relativePath}`;
}

function safeFileTimestamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

function inferMimeType(relativePath: string): string {
  const extension = relativePath.split('.').at(-1)?.toLocaleLowerCase('en-US');
  if (extension === 'txt' || extension === 'log') return 'text/plain';
  if (extension === 'md') return 'text/markdown';
  if (extension === 'json') return 'application/json';
  if (extension === 'csv') return 'text/csv';
  if (extension === 'html' || extension === 'htm') return 'text/html';
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'pdf') return 'application/pdf';
  return 'application/octet-stream';
}

function conversationFileInsert(database: NodeDatabase['raw']) {
  return database.prepare(
    `INSERT INTO conversation_files
     (id,conversation_id,category,relative_path,display_name,mime_type,size,source,
      turn_id,item_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
}

function insertConversationFile(
  insert: ReturnType<ReturnType<typeof conversationFileInsert>['run']> extends never
    ? never
    : ReturnType<typeof conversationFileInsert>,
  file: ConversationFileProjection
): void {
  insert.run(
    file.id,
    file.conversationId,
    file.category,
    file.relativePath,
    file.displayName,
    file.mimeType,
    file.size,
    file.source,
    file.turnId ?? null,
    file.itemId ?? null,
    file.createdAt,
    file.updatedAt
  );
}

async function sortedEntries(directory: string) {
  return (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name, 'en-US')
  );
}

function conversationPaths(conversationDirectory: string): HostedConversationPaths {
  const manifestDirectory = join(conversationDirectory, 'manifest');
  const dataDirectory = join(conversationDirectory, 'data');
  const runtimeDirectory = join(conversationDirectory, 'runtime');
  return {
    conversationDirectory,
    manifestDirectory,
    manifestPath: join(manifestDirectory, 'conversation.json'),
    homeDirectory: join(conversationDirectory, 'home'),
    dataDirectory,
    uploadsDirectory: join(dataDirectory, 'inbox'),
    outputDirectory: join(dataDirectory, 'output'),
    temporaryRootDirectory: join(dataDirectory, 'tmp'),
    runtimeDirectory,
    templateBindingDirectory: join(runtimeDirectory, 'template-binding'),
    fileIndexDirectory: join(runtimeDirectory, 'file-index'),
    quotaDirectory: join(runtimeDirectory, 'quota')
  };
}

function storedHostedConversationManifest(input: unknown): {
  readonly manifest: HostedConversationManifest;
  readonly upgraded: boolean;
} {
  const stored: Record<string, unknown> =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const withoutLegacyMetadata = { ...stored };
  delete withoutLegacyMetadata['recoverableUntil'];
  delete withoutLegacyMetadata['pendingVersionId'];
  const missingPinnedAt = !('pinnedAt' in stored);
  const missingTitleSource = !('titleSource' in stored);
  const legacyUpgradeStatus =
    stored.status === 'UPGRADE_PENDING' || stored.status === 'UPGRADE_FAILED';
  const hasPendingVersion = 'pendingVersionId' in stored;
  const upgraded =
    missingPinnedAt ||
    missingTitleSource ||
    'recoverableUntil' in stored ||
    hasPendingVersion ||
    legacyUpgradeStatus;
  return {
    manifest: hostedConversationManifestSchema.parse(
      upgraded
        ? {
            ...withoutLegacyMetadata,
            ...(missingPinnedAt ? { pinnedAt: null } : {}),
            ...(missingTitleSource ? { titleSource: 'CUSTOM' } : {}),
            ...(legacyUpgradeStatus ? { status: 'ACTIVE' } : {})
          }
        : input
    ),
    upgraded
  };
}

function childPath(parent: string, key: string): string {
  if (!STORAGE_KEY.test(key)) throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
  const candidate = resolve(parent, key);
  if (!within(parent, candidate)) throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
  return candidate;
}

function opaqueStorageKey(prefix: string, domain: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(`${domain}\0${value}`).digest('base64url')}`;
}

function safeRelativePath(root: string, relativePath: string): string {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith('/') ||
    relativePath.includes('\\') ||
    relativePath
      .split('/')
      .some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  )
    throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
  const candidate = resolve(root, ...relativePath.split('/'));
  if (!within(root, candidate)) throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
  return candidate;
}

function within(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation.length > 0 && relation !== '..' && !relation.startsWith(`..${sep}`);
}

type SqlRow = Record<string, unknown>;

function hostedConversationManifest(row: SqlRow): HostedConversationManifest {
  const clientRequestId = nullableStringColumn(row.client_request_id);
  const parsed = hostedConversationManifestSchema.safeParse({
    id: row.id,
    nodeId: row.node_id,
    sessionId: row.session_id,
    templateId: row.template_id,
    templateName: row.template_name,
    activeVersionId: row.active_version_id,
    title: row.title,
    titleSource: row.title_source,
    pinnedAt: nullableNumberColumn(row.pinned_at),
    status: row.status,
    modelId: row.model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    userStorageKey: row.user_storage_key,
    conversationStorageKey: row.conversation_storage_key,
    ...(clientRequestId === null ? {} : { clientRequestId }),
    templateDeleted: booleanColumn(row.template_deleted),
    quota: {
      usedBytes: row.used_bytes,
      maxBytes: row.max_bytes
    }
  });
  if (!parsed.success) throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
  return parsed.data;
}

function isHostedConversationCursor(value: unknown): value is HostedConversationCursor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const cursor = value as Record<string, unknown>;
  const keys = Object.keys(cursor).sort();
  if (
    keys.length !== 7 ||
    keys.join(',') !== 'binding,cursorVersion,id,lastActivityAt,limit,pinned,sortVersion'
  )
    return false;
  return (
    cursor.cursorVersion === HOSTED_CONVERSATION_CURSOR_VERSION &&
    cursor.sortVersion === HOSTED_CONVERSATION_SORT_VERSION &&
    Number.isSafeInteger(cursor.limit) &&
    (cursor.limit as number) >= 1 &&
    (cursor.limit as number) <= MAX_HOSTED_CONVERSATION_PAGE_SIZE &&
    typeof cursor.pinned === 'boolean' &&
    Number.isSafeInteger(cursor.lastActivityAt) &&
    (cursor.lastActivityAt as number) >= 0 &&
    typeof cursor.id === 'string' &&
    PROTOCOL_ID.test(cursor.id) &&
    typeof cursor.binding === 'string' &&
    CURSOR_BINDING.test(cursor.binding)
  );
}

function conversationFileProjection(row: SqlRow): ConversationFileProjection {
  const turnId = nullableStringColumn(row.turn_id);
  const itemId = nullableStringColumn(row.item_id);
  const parsed = conversationFileProjectionSchema.safeParse({
    id: row.id,
    conversationId: row.conversation_id,
    category: row.category,
    relativePath: row.relative_path,
    displayName: row.display_name,
    mimeType: row.mime_type,
    size: row.size,
    source: row.source,
    ...(turnId === null ? {} : { turnId }),
    ...(itemId === null ? {} : { itemId }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
  if (!parsed.success) throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
  return parsed.data;
}

function hostedConversationMessage(row: SqlRow): HostedConversationMessageRecord {
  const status = stringColumn(row.status);
  if (
    status !== 'RUNNING' &&
    status !== 'SUCCEEDED' &&
    status !== 'FAILED' &&
    status !== 'INTERRUPTED'
  )
    throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
  return {
    conversationId: stringColumn(row.conversation_id),
    clientMessageId: stringColumn(row.client_message_id),
    runId: stringColumn(row.run_id),
    userTextPresent: booleanColumn(row.user_text_present),
    status,
    createdAt: numberColumn(row.created_at),
    updatedAt: numberColumn(row.updated_at)
  };
}

function hostedConversationSummary(row: Record<string, unknown>): HostedConversationSummary {
  const parsed = hostedConversationSummarySchema.safeParse({
    id: row.id,
    nodeId: row.node_id,
    sessionId: row.session_id,
    templateId: row.template_id,
    templateName: row.template_name,
    activeVersionId: row.active_version_id,
    title: row.title,
    titleSource: row.title_source,
    pinnedAt: nullableNumberColumn(row.pinned_at),
    status: row.status,
    modelId: row.model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at
  });
  if (!parsed.success) throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
  return parsed.data;
}

function versionReferences(manifest: HostedConversationManifest): readonly string[] {
  return [manifest.activeVersionId];
}

function nullableStringColumn(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return stringColumn(value);
}

function nullableNumberColumn(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return numberColumn(value);
}

function booleanColumn(value: unknown): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT_UNIQUE')
  );
}

function stringColumn(value: unknown): string {
  if (typeof value !== 'string') throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
  return value;
}

function numberColumn(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('HOSTED_CONVERSATION_STORAGE_INVALID');
  return value;
}
