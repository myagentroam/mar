import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
  symlink,
  writeFile
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  conversationTemplateDraftSchema,
  conversationTemplatePublishJobSchema,
  conversationTemplatePublishRequestSchema,
  conversationTemplatePublishResultSchema,
  conversationTemplatePublishStatusInputSchema,
  conversationTemplateSourceInspectInputSchema,
  conversationTemplateSourceInspectionSchema,
  conversationTemplateVersionSchema,
  type ConversationTemplateDraft,
  type ConversationTemplatePublishJob,
  type ConversationTemplatePublishResult,
  type ConversationTemplateVersion
} from '@myagentroam/protocol';
import type { NodeDatabase } from '../database.js';
import type { NodeOperationHandler } from '../connector/node-operation-router.js';
import type { NodeMcpInstallation } from '../mcp/model.js';
import { safeErrorCode } from '../util/safe-error.js';
import {
  parseTemplateVersionManifest,
  templateContentHash,
  templateMcpConfigHash,
  templateManifestHash,
  isTemplateRuntimeLinkTarget,
  isReservedTemplateSourcePath,
  type TemplateVersionManifest,
  type TemplateManifestFile,
  type TemplateManifestSymlink,
  type TemplateManifestMcpServer
} from './conversation-template-manifest.js';
import type { HostedConversationStore } from './hosted-conversation-store.js';

interface ConversationTemplateNodeServiceOptions {
  readonly database: NodeDatabase;
  readonly store: HostedConversationStore;
  readonly nodeId: () => string;
  readonly sourceWorkspacePath?: (physicalWorkspacePath: string) => string;
  readonly now?: () => number;
  readonly id?: () => string;
}

type PublishedFile = TemplateManifestFile & { readonly sourcePath: string };
type PublishedSymlink = TemplateManifestSymlink & { readonly sourcePath: string };
type PublishedEntry = PublishedFile | PublishedSymlink;

const HOST_POLICY_VERSION = 1;
const FORCED_EXCLUDED_NAMES = new Set([
  '.git',
  '.env',
  '.npmrc',
  '.pypirc',
  '.ssh',
  '.aws',
  '.azure',
  '.mar'
]);
const ROOT_EXCLUDED_NAMES = new Set(['credentials', 'secrets', 'readme.md', 'agents.md']);
const ROOT_TEMPLATE_INSTRUCTIONS_SOURCE = 'AGENTS.template.md';
const ROOT_TEMPLATE_INSTRUCTIONS_TARGET = 'AGENTS.md';
/** Handles the four closed template-management operations owned by Node. */
export class ConversationTemplateNodeService {
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly publishQueues = new Map<string, Promise<void>>();

  constructor(private readonly options: ConversationTemplateNodeServiceOptions) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
  }

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      'conversation.template.source.inspect': (data) => this.inspectSource(data),
      'conversation.template.publish': (data) => this.publish(data),
      'conversation.template.publish.status': (data) => this.publishStatus(data),
      'conversation.template.version.inspect': (data) => this.inspectVersion(data)
    };
  }

  async recoverInterruptedPublications(): Promise<void> {
    for (const entry of await readdir(this.options.store.templatesPublishingDirectory, {
      withFileTypes: true
    })) {
      await writableRemove(join(this.options.store.templatesPublishingDirectory, entry.name));
    }
    const registeredStorageKeys = new Set(
      (
        this.options.database.raw
          .prepare('SELECT storage_key FROM conversation_template_versions')
          .all() as readonly SqlRow[]
      ).map((row) => stringValue(row, 'storage_key'))
    );
    for (const entry of await readdir(this.options.store.templatesVersionsDirectory, {
      withFileTypes: true
    })) {
      if (registeredStorageKeys.has(entry.name)) continue;
      await writableRemove(join(this.options.store.templatesVersionsDirectory, entry.name));
    }
    await this.finishRegisteredPublications();
    this.options.database.raw
      .prepare(
        `UPDATE conversation_template_publish_jobs
         SET status='FAILED',version_id=NULL,error_code='CONVERSATION_TEMPLATE_PUBLISH_INTERRUPTED',
             error_summary=?,updated_at=?
         WHERE status IN ('QUEUED','RUNNING') AND stage<>'REGISTERED'`
      )
      .run(
        'The publish request was interrupted before the template version was registered.',
        this.now()
      );
  }

  private async inspectSource(raw: unknown) {
    const input = conversationTemplateSourceInspectInputSchema.parse(nodeRequestPayload(raw).data);
    const mcpServers = this.mcpOptions(input.draft.workspaceId);
    try {
      await this.collectSnapshot(input.draft);
      this.selectedMcpServers(input.draft);
      return conversationTemplateSourceInspectionSchema.parse({
        valid: true,
        code: null,
        message: 'The conversation template source is valid.',
        checkedAt: this.now(),
        mcpServers
      });
    } catch (error) {
      const code = safeErrorCode(error, 'CONVERSATION_TEMPLATE_SOURCE_INVALID');
      return conversationTemplateSourceInspectionSchema.parse({
        valid: false,
        code,
        message: `The conversation template source is invalid (${code}).`,
        checkedAt: this.now(),
        mcpServers
      });
    }
  }

  private async publish(raw: unknown): Promise<ConversationTemplatePublishResult> {
    const payload = nodeRequestPayload(raw);
    const request = conversationTemplatePublishRequestSchema.parse(payload.data);
    if (payload.requestUserId !== undefined && payload.requestUserId !== request.requestedByUserId)
      throw new Error('CONVERSATION_TEMPLATE_NOT_AUTHORIZED');
    this.assertLocalDraft(request.draft);
    const existing = this.publishJobRow(request.jobId);
    if (existing !== undefined) {
      if (numberValue(existing, 'requested_by_user_id') !== request.requestedByUserId)
        throw new Error('CONVERSATION_TEMPLATE_NOT_AUTHORIZED');
      if (
        stringValue(existing, 'template_id') !== request.templateId ||
        numberValue(existing, 'draft_revision') !== request.draft.revision ||
        stringValue(existing, 'draft') !== JSON.stringify(request.draft)
      )
        throw new Error('CONVERSATION_TEMPLATE_REVISION_CONFLICT');
      return this.publishResult(existing);
    }
    const createdAt = this.now();
    this.options.database.raw
      .prepare(
        `INSERT INTO conversation_template_publish_jobs
         (id,template_id,draft_revision,stage,status,version_id,error_code,error_summary,
          requested_by_user_id,draft,created_at,updated_at)
         VALUES (?,?,?,'VALIDATING','QUEUED',NULL,NULL,NULL,?,?,?,?)`
      )
      .run(
        request.jobId,
        request.templateId,
        request.draft.revision,
        request.requestedByUserId,
        JSON.stringify(request.draft),
        createdAt,
        createdAt
      );
    this.enqueuePublish(request);
    return this.publishResult(this.requirePublishJobRow(request.jobId));
  }

  private enqueuePublish(request: {
    readonly templateId: string;
    readonly jobId: string;
    readonly draft: ConversationTemplateDraft;
    readonly requestedByUserId: number;
  }): void {
    queueMicrotask(() => {
      const previous = this.publishQueues.get(request.templateId) ?? Promise.resolve();
      const current = previous
        .catch(() => undefined)
        .then(() => this.performPublish(request))
        .finally(() => {
          if (this.publishQueues.get(request.templateId) === current)
            this.publishQueues.delete(request.templateId);
        });
      this.publishQueues.set(request.templateId, current);
    });
  }

  private publishStatus(raw: unknown): ConversationTemplatePublishResult {
    const input = conversationTemplatePublishStatusInputSchema.parse(nodeRequestPayload(raw).data);
    const row = this.requirePublishJobRow(input.jobId);
    if (stringValue(row, 'template_id') !== input.templateId)
      throw new Error('CONVERSATION_TEMPLATE_PUBLISH_JOB_NOT_FOUND');
    return this.publishResult(row);
  }

  private async inspectVersion(raw: unknown) {
    raw = nodeRequestPayload(raw).data;
    if (
      !record(raw) ||
      typeof raw['templateId'] !== 'string' ||
      typeof raw['versionId'] !== 'string' ||
      Object.keys(raw).length !== 2
    )
      throw new Error('CONVERSATION_TEMPLATE_INPUT_INVALID');
    const row = this.options.database.raw
      .prepare('SELECT * FROM conversation_template_versions WHERE id=? AND template_id=?')
      .get(raw['versionId'], raw['templateId']) as SqlRow | undefined;
    if (row === undefined) throw new Error('CONVERSATION_TEMPLATE_NOT_FOUND');
    const version = templateVersion(row);
    try {
      await this.verifyVersion(row);
      if (version.status === 'CORRUPTED')
        throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
      return {
        valid: true,
        code: null,
        message: 'The conversation template version is valid.',
        checkedAt: this.now(),
        version
      };
    } catch (error) {
      const code = safeErrorCode(error, 'CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
      this.options.database.raw
        .prepare("UPDATE conversation_template_versions SET status='CORRUPTED' WHERE id=?")
        .run(version.id);
      return {
        valid: false,
        code,
        message: `The conversation template version is invalid (${code}).`,
        checkedAt: this.now(),
        version: { ...version, status: 'CORRUPTED' as const }
      };
    }
  }

  private async performPublish(request: {
    readonly templateId: string;
    readonly jobId: string;
    readonly draft: ConversationTemplateDraft;
    readonly requestedByUserId: number;
  }): Promise<void> {
    const storageKey = `template_${createHash('sha256').update(request.jobId).digest('base64url')}`;
    const candidate = this.options.store.templatePublishingDirectory(storageKey);
    let sealed: string | undefined;
    let stage: ConversationTemplatePublishJob['stage'] = 'VALIDATING';
    try {
      await this.finishRegisteredPublications(request.templateId);
      this.updateJob(request.jobId, stage, 'RUNNING');
      const snapshot = await this.collectSnapshot(request.draft);
      const entries = snapshot.entries;
      const mcpServers = this.selectedMcpServers(request.draft);
      const mcpConfigHash = templateMcpConfigHash(mcpServers);
      stage = 'ENUMERATING';
      this.updateJob(request.jobId, stage, 'RUNNING');
      await rm(candidate, { recursive: true, force: true });
      const contentDirectory = join(candidate, 'content');
      await mkdir(contentDirectory, { recursive: true, mode: 0o700 });
      for (const directory of snapshot.directories)
        await mkdir(join(contentDirectory, ...directory.split('/')), {
          recursive: true,
          mode: 0o700
        });
      stage = 'COPYING';
      this.updateJob(request.jobId, stage, 'RUNNING');
      for (const entry of entries) {
        const destination = join(contentDirectory, ...entry.relativePath.split('/'));
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        if (entry.kind === 'SYMLINK') {
          const sourceMetadata = await lstat(entry.sourcePath);
          if (
            !sourceMetadata.isSymbolicLink() ||
            (await readlink(entry.sourcePath)) !== entry.linkTarget
          )
            throw new Error('CONVERSATION_TEMPLATE_SOURCE_CHANGED');
          await symlink(entry.linkTarget, destination);
          const copiedTarget = await readlink(destination);
          if (copiedTarget !== entry.linkTarget)
            throw new Error('CONVERSATION_TEMPLATE_SOURCE_CHANGED');
          continue;
        }
        await copyFile(entry.sourcePath, destination);
        const copied = await lstat(destination);
        if (!copied.isFile() || copied.isSymbolicLink() || copied.nlink !== 1)
          throw new Error('CONVERSATION_TEMPLATE_SOURCE_LINK_INVALID');
        await chmod(destination, entry.executable ? 0o555 : 0o444);
      }
      await Promise.all(
        ['inbox', 'output'].map((name) =>
          mkdir(join(contentDirectory, name), { recursive: true, mode: 0o700 })
        )
      );
      await sealDirectories(contentDirectory);
      stage = 'SCANNING';
      this.updateJob(request.jobId, stage, 'RUNNING');
      await verifyCopiedSnapshot(contentDirectory, snapshot.directories, entries, true);
      const versionNumber = this.nextVersionNumber(request.templateId);
      const versionId = this.id();
      const publishedAt = this.now();
      const contentHash = templateContentHash(snapshot.directories, entries);
      const manifest: TemplateVersionManifest = {
        schemaVersion: 2,
        templateId: request.templateId,
        versionId,
        versionNumber,
        draftRevision: request.draft.revision,
        hostPolicyVersion: HOST_POLICY_VERSION,
        publishedByUserId: request.requestedByUserId,
        publishedAt,
        sourceWorkspacePath: snapshot.sourceWorkspacePath,
        draft: request.draft,
        directories: snapshot.directories,
        entries: entries.map((entry) =>
          entry.kind === 'FILE'
            ? {
                kind: entry.kind,
                relativePath: entry.relativePath,
                size: entry.size,
                executable: entry.executable,
                sha256: entry.sha256
              }
            : {
                kind: entry.kind,
                relativePath: entry.relativePath,
                size: entry.size,
                linkTarget: entry.linkTarget,
                targetKind: entry.targetKind,
                resolvedTarget: entry.resolvedTarget
              }
        ),
        contentHash,
        mcpServers,
        mcpConfigHash
      };
      stage = 'MANIFEST';
      this.updateJob(request.jobId, stage, 'RUNNING');
      const manifestJson = JSON.stringify(manifest);
      const manifestHash = templateManifestHash(manifestJson);
      await writeFile(join(candidate, 'manifest.json'), `${manifestJson}\n`, { mode: 0o600 });
      await chmod(join(candidate, 'manifest.json'), 0o444);
      sealed = this.options.store.templateVersionDirectory(storageKey);
      await rename(candidate, sealed);
      await chmod(sealed, 0o555);
      stage = 'SEALED';
      this.updateJob(request.jobId, stage, 'RUNNING');
      const version = conversationTemplateVersionSchema.parse({
        id: versionId,
        templateId: request.templateId,
        version: versionNumber,
        status: 'AVAILABLE',
        contentHash,
        manifestHash,
        mcpConfigHash,
        fileCount: entries.length,
        totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
        hostPolicyVersion: HOST_POLICY_VERSION,
        publishedByUserId: request.requestedByUserId,
        publishedAt
      });
      this.registerVersion(request.jobId, storageKey, manifestJson, version);
      stage = 'REGISTERED';
      await this.finishRegisteredPublication(request.jobId);
    } catch (error) {
      if (stage === 'REGISTERED') return;
      await writableRemove(candidate);
      if (sealed !== undefined) await writableRemove(sealed);
      const code = safeErrorCode(error, 'CONVERSATION_TEMPLATE_PUBLISH_FAILED');
      this.options.database.raw
        .prepare(
          `UPDATE conversation_template_publish_jobs
           SET stage=?,status='FAILED',version_id=NULL,error_code=?,error_summary=?,updated_at=? WHERE id=?`
        )
        .run(stage, code, `The publish request failed (${code}).`, this.now(), request.jobId);
    }
  }

  private async collectSnapshot(draft: ConversationTemplateDraft): Promise<{
    readonly sourceWorkspacePath: string;
    readonly directories: readonly string[];
    readonly entries: readonly PublishedEntry[];
  }> {
    this.assertLocalDraft(draft);
    const workspace = this.options.database.getWorkspace(draft.workspaceId);
    if (workspace === undefined) throw new Error('WORKSPACE_NOT_FOUND');
    const root = await realpath(workspace.path);
    const sourceWorkspacePath = this.options.sourceWorkspacePath?.(root) ?? root;
    validateSourceWorkspacePath(sourceWorkspacePath);
    const directories = new Set<string>();
    const entries = new Map<string, PublishedEntry>();
    let totalBytes = 0;
    const availableBytes = await hostedFilesystemAvailableBytes(this.options.store.rootDirectory);
    await walkWorkspace(root, '', {
      directory: (relativePath) => {
        directories.add(relativePath);
      },
      file: async (filePath, relativePath, metadata) => {
        if (entries.has(relativePath)) return;
        const size = Number(metadata.size);
        totalBytes += size;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > availableBytes)
          throw new Error('CONVERSATION_HOSTING_STORAGE_FULL');
        entries.set(relativePath, {
          kind: 'FILE',
          relativePath,
          sourcePath: filePath,
          size,
          executable: (Number(metadata.mode) & 0o111) !== 0,
          sha256: hashBuffer(await readFile(filePath))
        });
      },
      symlink: async (filePath, relativePath, metadata) => {
        if (entries.has(relativePath)) return;
        const link = await publishedSymlink(root, filePath, relativePath, metadata);
        totalBytes += link.size;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > availableBytes)
          throw new Error('CONVERSATION_HOSTING_STORAGE_FULL');
        entries.set(relativePath, link);
      }
    });
    return {
      sourceWorkspacePath,
      directories: [...directories].sort((left, right) => left.localeCompare(right, 'en-US')),
      entries: [...entries.values()].sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath, 'en-US')
      )
    };
  }

  private mcpOptions(workspaceId: string) {
    return this.options.database.effectiveMcpInstallations(workspaceId).map((installation) => ({
      id: installation.catalogEntryId,
      serverName: installation.serverName,
      displayName: installation.displayName,
      transport: installation.runtime.transport,
      origin: installation.targetKind
    }));
  }

  private selectedMcpServers(
    draft: ConversationTemplateDraft
  ): readonly TemplateManifestMcpServer[] {
    const effective = new Map(
      this.options.database
        .effectiveMcpInstallations(draft.workspaceId)
        .map((installation) => [installation.catalogEntryId, installation])
    );
    return draft.mcpIds.map((id) => {
      const installation = effective.get(id);
      if (
        installation === undefined ||
        (installation.runtime.transport === 'HTTP' && draft.networkMode !== 'UNRESTRICTED')
      )
        throw new Error('CONVERSATION_TEMPLATE_MCP_INVALID');
      return {
        id: installation.catalogEntryId,
        serverName: installation.serverName,
        displayName: installation.displayName,
        version: installation.version,
        origin: installation.targetKind,
        transport: installation.runtime.transport,
        runtime: installation.runtime,
        configuration: installation.configuration
      };
    });
  }

  private assertLocalDraft(raw: unknown): asserts raw is ConversationTemplateDraft {
    const draft = conversationTemplateDraftSchema.parse(raw);
    if (draft.nodeId !== this.options.nodeId())
      throw new Error('CONVERSATION_TEMPLATE_SOURCE_INVALID');
  }

  private nextVersionNumber(templateId: string): number {
    const row = this.options.database.raw
      .prepare(
        'SELECT COALESCE(MAX(version_number),0) AS version_number FROM conversation_template_versions WHERE template_id=?'
      )
      .get(templateId) as SqlRow;
    return numberValue(row, 'version_number') + 1;
  }

  private registerVersion(
    jobId: string,
    storageKey: string,
    manifest: string,
    version: ConversationTemplateVersion
  ): void {
    const database = this.options.database.raw;
    database.exec('BEGIN IMMEDIATE');
    try {
      const job = this.requirePublishJobRow(jobId);
      if (
        stringValue(job, 'template_id') !== version.templateId ||
        stringValue(job, 'stage') !== 'SEALED' ||
        stringValue(job, 'status') !== 'RUNNING' ||
        job['version_id'] !== null ||
        numberValue(job, 'requested_by_user_id') !== version.publishedByUserId
      )
        throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
      const inserted = database
        .prepare(
          `INSERT INTO conversation_template_versions
           (id,template_id,version_number,draft_revision,status,storage_key,manifest,content_hash,
            manifest_hash,mcp_config_hash,file_count,total_bytes,host_policy_version,
            published_by_user_id,published_at,reference_count)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`
        )
        .run(
          version.id,
          version.templateId,
          version.version,
          numberValue(job, 'draft_revision'),
          version.status,
          storageKey,
          manifest,
          version.contentHash,
          version.manifestHash,
          version.mcpConfigHash,
          version.fileCount,
          version.totalBytes,
          version.hostPolicyVersion,
          version.publishedByUserId,
          version.publishedAt
        );
      if (Number(inserted.changes) !== 1)
        throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
      const registered = database
        .prepare(
          `UPDATE conversation_template_publish_jobs
           SET stage='REGISTERED',status='RUNNING',version_id=?,error_code=NULL,error_summary=NULL,
               updated_at=?
           WHERE id=? AND template_id=? AND draft_revision=? AND requested_by_user_id=?
             AND stage='SEALED' AND status='RUNNING' AND version_id IS NULL`
        )
        .run(
          version.id,
          version.publishedAt,
          jobId,
          version.templateId,
          numberValue(job, 'draft_revision'),
          version.publishedByUserId
        );
      if (Number(registered.changes) !== 1)
        throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  private async finishRegisteredPublication(jobId: string): Promise<void> {
    const job = this.requirePublishJobRow(jobId);
    if (
      stringValue(job, 'stage') !== 'REGISTERED' ||
      stringValue(job, 'status') !== 'RUNNING' ||
      job['version_id'] === null
    )
      throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    const versionId = stringValue(job, 'version_id');
    const version = this.options.database.raw
      .prepare('SELECT template_id FROM conversation_template_versions WHERE id=?')
      .get(versionId) as SqlRow | undefined;
    if (
      version === undefined ||
      stringValue(version, 'template_id') !== stringValue(job, 'template_id')
    )
      throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    const completed = this.options.database.raw
      .prepare(
        `UPDATE conversation_template_publish_jobs
         SET status='SUCCEEDED',error_code=NULL,error_summary=NULL,updated_at=?
         WHERE id=? AND stage='REGISTERED' AND status='RUNNING' AND version_id=?`
      )
      .run(this.now(), jobId, versionId);
    if (Number(completed.changes) !== 1) throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
  }

  private async finishRegisteredPublications(templateId?: string): Promise<void> {
    const jobs =
      templateId === undefined
        ? (this.options.database.raw
            .prepare(
              `SELECT id FROM conversation_template_publish_jobs
               WHERE stage='REGISTERED' AND status='RUNNING'
               ORDER BY created_at,id`
            )
            .all() as readonly SqlRow[])
        : (this.options.database.raw
            .prepare(
              `SELECT id FROM conversation_template_publish_jobs
               WHERE template_id=? AND stage='REGISTERED' AND status='RUNNING'
               ORDER BY created_at,id`
            )
            .all(templateId) as readonly SqlRow[]);
    for (const job of jobs) await this.finishRegisteredPublication(stringValue(job, 'id'));
  }

  private updateJob(
    jobId: string,
    stage: ConversationTemplatePublishJob['stage'],
    status: 'RUNNING'
  ): void {
    this.options.database.raw
      .prepare(
        'UPDATE conversation_template_publish_jobs SET stage=?,status=?,updated_at=? WHERE id=?'
      )
      .run(stage, status, this.now(), jobId);
  }

  private publishResult(row: SqlRow): ConversationTemplatePublishResult {
    const job = publishJob(row);
    const version =
      job.status !== 'SUCCEEDED' || job.versionId === undefined
        ? undefined
        : this.options.database.raw
            .prepare('SELECT * FROM conversation_template_versions WHERE id=?')
            .get(job.versionId);
    return conversationTemplatePublishResultSchema.parse({
      job,
      ...(version === undefined ? {} : { version: templateVersion(version as SqlRow) })
    });
  }

  private publishJobRow(jobId: string): SqlRow | undefined {
    return this.options.database.raw
      .prepare('SELECT * FROM conversation_template_publish_jobs WHERE id=?')
      .get(jobId) as SqlRow | undefined;
  }

  private requirePublishJobRow(jobId: string): SqlRow {
    const row = this.publishJobRow(jobId);
    if (row === undefined) throw new Error('CONVERSATION_TEMPLATE_PUBLISH_JOB_NOT_FOUND');
    return row;
  }

  private async verifyVersion(row: SqlRow): Promise<void> {
    const storageKey = stringValue(row, 'storage_key');
    const root = this.options.store.templateVersionDirectory(storageKey);
    const manifestText = await readFile(join(root, 'manifest.json'), 'utf8');
    const manifestJson = manifestText.endsWith('\n') ? manifestText.slice(0, -1) : manifestText;
    if (templateManifestHash(manifestText) !== stringValue(row, 'manifest_hash'))
      throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    const manifest = parseTemplateVersionManifest(JSON.parse(manifestJson));
    if (
      manifest.mcpConfigHash !== stringValue(row, 'mcp_config_hash') ||
      templateMcpConfigHash(manifest.mcpServers) !== manifest.mcpConfigHash ||
      manifest.contentHash !== stringValue(row, 'content_hash') ||
      manifest.entries.length !== numberValue(row, 'file_count') ||
      manifest.entries.reduce((total, entry) => total + entry.size, 0) !==
        numberValue(row, 'total_bytes') ||
      templateContentHash(manifest.directories, manifest.entries) !== manifest.contentHash
    )
      throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    const expected = new Map(manifest.entries.map((entry) => [entry.relativePath, entry]));
    const expectedDirectories = new Set([...manifest.directories, 'inbox', 'output']);
    const actualDirectories = new Set<string>();
    const actual = await listSnapshotEntries(
      join(root, 'content'),
      expectedDirectories,
      actualDirectories,
      true,
      'CONVERSATION_TEMPLATE_VERSION_CORRUPTED'
    );
    if (actual.length !== expected.size || actualDirectories.size !== expectedDirectories.size)
      throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    for (const entry of actual) {
      const expectation = expected.get(entry.relativePath);
      if (expectation === undefined || expectation.kind !== entry.kind)
        throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
      if (expectation.kind === 'FILE' && entry.kind === 'FILE') {
        if (
          expectation.size !== entry.size ||
          expectation.executable !== entry.executable ||
          ((await lstat(entry.sourcePath)).mode & 0o777) !==
            (expectation.executable ? 0o555 : 0o444) ||
          expectation.sha256 !== entry.sha256
        )
          throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
        continue;
      }
      if (
        expectation.kind !== 'SYMLINK' ||
        entry.kind !== 'SYMLINK' ||
        expectation.size !== entry.size ||
        expectation.linkTarget !== entry.linkTarget
      )
        throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
      await verifySymlinkResolution(
        join(root, 'content'),
        expectation,
        entry.sourcePath,
        'CONVERSATION_TEMPLATE_VERSION_CORRUPTED'
      );
    }
  }
}

type SqlRow = Record<string, string | number | bigint | Uint8Array | null>;

function publishJob(row: SqlRow): ConversationTemplatePublishJob {
  return conversationTemplatePublishJobSchema.parse({
    id: stringValue(row, 'id'),
    templateId: stringValue(row, 'template_id'),
    draftRevision: numberValue(row, 'draft_revision'),
    stage: stringValue(row, 'stage'),
    status: stringValue(row, 'status'),
    ...(row['version_id'] === null ? {} : { versionId: stringValue(row, 'version_id') }),
    errorCode: row['error_code'] === null ? null : stringValue(row, 'error_code'),
    ...(row['error_summary'] === null ? {} : { errorSummary: stringValue(row, 'error_summary') }),
    createdAt: numberValue(row, 'created_at'),
    updatedAt: numberValue(row, 'updated_at')
  });
}

function templateVersion(row: SqlRow): ConversationTemplateVersion {
  return conversationTemplateVersionSchema.parse({
    id: stringValue(row, 'id'),
    templateId: stringValue(row, 'template_id'),
    version: numberValue(row, 'version_number'),
    status: stringValue(row, 'status'),
    contentHash: stringValue(row, 'content_hash'),
    manifestHash: stringValue(row, 'manifest_hash'),
    mcpConfigHash: stringValue(row, 'mcp_config_hash'),
    fileCount: numberValue(row, 'file_count'),
    totalBytes: numberValue(row, 'total_bytes'),
    hostPolicyVersion: numberValue(row, 'host_policy_version'),
    publishedByUserId: numberValue(row, 'published_by_user_id'),
    publishedAt: numberValue(row, 'published_at')
  });
}

interface WorkspaceWalker {
  readonly directory: (relativePath: string) => void;
  readonly file: (
    path: string,
    relativePath: string,
    metadata: Awaited<ReturnType<typeof lstat>>
  ) => Promise<void>;
  readonly symlink: (
    path: string,
    relativePath: string,
    metadata: Awaited<ReturnType<typeof lstat>>
  ) => Promise<void>;
}

async function walkWorkspace(
  path: string,
  relativePath: string,
  walker: WorkspaceWalker
): Promise<void> {
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error('CONVERSATION_TEMPLATE_SOURCE_MISSING');
    throw error;
  });
  if (metadata.isSymbolicLink()) {
    if (relativePath.length === 0) throw new Error('CONVERSATION_TEMPLATE_SOURCE_LINK_INVALID');
    await walker.symlink(path, relativePath, metadata);
    return;
  }
  if (metadata.isFile()) {
    if (relativePath.length === 0) throw new Error('CONVERSATION_TEMPLATE_SOURCE_INVALID');
    await walker.file(path, relativePath, metadata);
    return;
  }
  if (!metadata.isDirectory()) throw new Error('CONVERSATION_TEMPLATE_SOURCE_TYPE_INVALID');
  if (relativePath.length > 0) walker.directory(relativePath);
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name, 'en-US')
  )) {
    const childPath = join(path, entry.name);
    const childRelative = relativePath.length === 0 ? entry.name : `${relativePath}/${entry.name}`;
    if (relativePath.length === 0 && (entry.name === 'inbox' || entry.name === 'output'))
      throw new Error('CONVERSATION_TEMPLATE_RESERVED_PATH');
    if (forcedExcluded(childRelative)) continue;
    if (relativePath.length === 0 && entry.name === ROOT_TEMPLATE_INSTRUCTIONS_SOURCE) {
      const templateInstructions = await lstat(childPath);
      if (!templateInstructions.isFile() || templateInstructions.isSymbolicLink())
        throw new Error('CONVERSATION_TEMPLATE_SOURCE_TYPE_INVALID');
      await walker.file(childPath, ROOT_TEMPLATE_INSTRUCTIONS_TARGET, templateInstructions);
      continue;
    }
    await walkWorkspace(childPath, childRelative, walker);
  }
}

async function sealDirectories(root: string, sealRoot = true): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries)
    if (entry.isDirectory()) await sealDirectories(join(root, entry.name));
  if (sealRoot) await chmod(root, 0o555);
}

async function writableRemove(path: string): Promise<void> {
  await chmodTree(path).catch(() => undefined);
  await rm(path, { recursive: true, force: true });
}

async function chmodTree(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) await chmodTree(join(path, entry));
  } else await chmod(path, 0o600);
}

async function verifyCopiedSnapshot(
  contentDirectory: string,
  publishedDirectories: readonly string[],
  expectedEntries: readonly PublishedEntry[],
  sealed: boolean
): Promise<void> {
  const expected = new Map(expectedEntries.map((entry) => [entry.relativePath, entry]));
  const expectedDirectories = new Set([...publishedDirectories, 'inbox', 'output']);
  const actualDirectories = new Set<string>();
  const actual = await listSnapshotEntries(
    contentDirectory,
    expectedDirectories,
    actualDirectories,
    sealed,
    'CONVERSATION_TEMPLATE_SOURCE_CHANGED'
  );
  if (actualDirectories.size !== expectedDirectories.size)
    throw new Error('CONVERSATION_TEMPLATE_SOURCE_CHANGED');
  if (actual.length !== expected.size) throw new Error('CONVERSATION_TEMPLATE_SOURCE_CHANGED');
  for (const entry of actual) {
    const expectedEntry = expected.get(entry.relativePath);
    if (expectedEntry === undefined || expectedEntry.kind !== entry.kind)
      throw new Error('CONVERSATION_TEMPLATE_SOURCE_CHANGED');
    if (expectedEntry.kind === 'FILE' && entry.kind === 'FILE') {
      if (
        expectedEntry.size !== entry.size ||
        expectedEntry.executable !== entry.executable ||
        expectedEntry.sha256 !== entry.sha256
      )
        throw new Error('CONVERSATION_TEMPLATE_SOURCE_CHANGED');
      continue;
    }
    if (
      expectedEntry.kind !== 'SYMLINK' ||
      entry.kind !== 'SYMLINK' ||
      expectedEntry.size !== entry.size ||
      expectedEntry.linkTarget !== entry.linkTarget
    )
      throw new Error('CONVERSATION_TEMPLATE_SOURCE_CHANGED');
    await verifySymlinkResolution(
      contentDirectory,
      expectedEntry,
      entry.sourcePath,
      'CONVERSATION_TEMPLATE_SOURCE_CHANGED'
    );
  }
}

async function verifySymlinkResolution(
  contentDirectory: string,
  expected: Omit<PublishedSymlink, 'sourcePath'>,
  path: string,
  errorCode: string
): Promise<void> {
  let actualTarget: string;
  try {
    actualTarget = await realpath(path);
  } catch {
    throw new Error(errorCode);
  }
  if (expected.targetKind === 'RUNTIME') {
    if (actualTarget !== expected.resolvedTarget) throw new Error(errorCode);
    return;
  }
  let expectedTarget: string;
  try {
    expectedTarget = await realpath(join(contentDirectory, ...expected.resolvedTarget.split('/')));
  } catch {
    throw new Error(errorCode);
  }
  if (actualTarget !== expectedTarget || !within(await realpath(contentDirectory), actualTarget))
    throw new Error(errorCode);
}

type ObservedEntry =
  | PublishedFile
  | Pick<PublishedSymlink, 'kind' | 'relativePath' | 'sourcePath' | 'size' | 'linkTarget'>;

async function listSnapshotEntries(
  root: string,
  expectedDirectories: ReadonlySet<string>,
  actualDirectories: Set<string>,
  sealed: boolean,
  errorCode: string,
  prefix = ''
): Promise<readonly ObservedEntry[]> {
  const rootMetadata = await lstat(root);
  if (
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    (sealed && (rootMetadata.mode & 0o777) !== 0o555)
  )
    throw new Error(errorCode);
  const entries: ObservedEntry[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      const linkTarget = await readlink(path);
      entries.push({
        kind: 'SYMLINK',
        relativePath,
        sourcePath: path,
        size: Buffer.byteLength(linkTarget),
        linkTarget
      });
      continue;
    }
    if (metadata.isDirectory()) {
      if (!expectedDirectories.has(relativePath)) throw new Error(errorCode);
      actualDirectories.add(relativePath);
      entries.push(
        ...(await listSnapshotEntries(
          path,
          expectedDirectories,
          actualDirectories,
          sealed,
          errorCode,
          relativePath
        ))
      );
      continue;
    }
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (sealed && (metadata.mode & 0o777) !== (metadata.mode & 0o111 ? 0o555 : 0o444))
    )
      throw new Error(errorCode);
    entries.push({
      kind: 'FILE',
      relativePath,
      sourcePath: path,
      size: Number(metadata.size),
      executable: (metadata.mode & 0o111) !== 0,
      sha256: hashBuffer(await readFile(path))
    });
  }
  return entries;
}

function forcedExcluded(relativePath: string): boolean {
  const parts = relativePath.split('/');
  if (
    parts.some((part) => {
      const lower = part.toLocaleLowerCase('en-US');
      return FORCED_EXCLUDED_NAMES.has(lower) || lower.startsWith('.env');
    })
  )
    return true;
  const leaf = parts.at(-1)?.toLocaleLowerCase('en-US') ?? '';
  return (
    (parts.length === 1 &&
      (ROOT_EXCLUDED_NAMES.has(leaf) ||
        leaf.endsWith('.pem') ||
        leaf.endsWith('.key') ||
        leaf === 'id_rsa' ||
        leaf === 'id_ed25519')) ||
    leaf.endsWith('.sock')
  );
}

async function publishedSymlink(
  workspaceRoot: string,
  path: string,
  relativePath: string,
  metadata: Awaited<ReturnType<typeof lstat>>
): Promise<PublishedSymlink> {
  if (!metadata.isSymbolicLink()) throw new Error('CONVERSATION_TEMPLATE_SOURCE_LINK_INVALID');
  const linkTarget = await readlink(path);
  let resolvedTarget: string;
  try {
    resolvedTarget = await realpath(path);
  } catch {
    throw new Error('CONVERSATION_TEMPLATE_SOURCE_LINK_INVALID');
  }
  if (resolvedTarget === workspaceRoot || within(workspaceRoot, resolvedTarget)) {
    const targetMetadata = await lstat(resolvedTarget).catch(() => undefined);
    if (
      targetMetadata === undefined ||
      (targetMetadata.isDirectory() &&
        (resolvedTarget === workspaceRoot || within(resolvedTarget, path)))
    )
      throw new Error('CONVERSATION_TEMPLATE_SOURCE_LINK_INVALID');
    const targetRelative = relative(workspaceRoot, resolvedTarget).split(sep).join('/');
    if (targetRelative.length === 0 || forcedExcluded(targetRelative))
      throw new Error('CONVERSATION_TEMPLATE_SOURCE_LINK_INVALID');
    return {
      kind: 'SYMLINK',
      relativePath,
      sourcePath: path,
      size: Buffer.byteLength(linkTarget),
      linkTarget,
      targetKind: 'SNAPSHOT',
      resolvedTarget: targetRelative
    };
  }
  if (!isTemplateRuntimeLinkTarget(resolvedTarget))
    throw new Error('CONVERSATION_TEMPLATE_SOURCE_LINK_INVALID');
  return {
    kind: 'SYMLINK',
    relativePath,
    sourcePath: path,
    size: Buffer.byteLength(linkTarget),
    linkTarget,
    targetKind: 'RUNTIME',
    resolvedTarget
  };
}

async function hostedFilesystemAvailableBytes(path: string): Promise<number> {
  try {
    const filesystem = await statfs(path);
    const available = Number(filesystem.bavail) * Number(filesystem.bsize);
    if (!Number.isFinite(available) || available < 0)
      throw new Error('CONVERSATION_HOSTING_STORAGE_UNAVAILABLE');
    return Math.min(Math.floor(available), Number.MAX_SAFE_INTEGER);
  } catch (error) {
    if (error instanceof Error && error.message === 'CONVERSATION_HOSTING_STORAGE_UNAVAILABLE')
      throw error;
    throw new Error('CONVERSATION_HOSTING_STORAGE_UNAVAILABLE');
  }
}

function validateSourceWorkspacePath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || path === '/')
    throw new Error('CONVERSATION_TEMPLATE_SOURCE_INVALID');
  if (isReservedTemplateSourcePath(path)) throw new Error('CONVERSATION_TEMPLATE_SOURCE_INVALID');
}

function within(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation.length > 0 && relation !== '..' && !relation.startsWith(`..${sep}`);
}

function hashBuffer(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function stringValue(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`DATABASE_VALUE_INVALID:${key}`);
  return value;
}

function numberValue(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' && typeof value !== 'bigint')
    throw new Error(`DATABASE_VALUE_INVALID:${key}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`DATABASE_VALUE_INVALID:${key}`);
  return number;
}

function nodeRequestPayload(raw: unknown): {
  readonly data: unknown;
  readonly requestUserId?: number;
} {
  if (!record(raw)) return { data: raw };
  const { __requestUserId, ...data } = raw;
  delete data.__workspaceWatchSessionHash;
  if (__requestUserId === undefined) return { data };
  if (
    typeof __requestUserId !== 'number' ||
    !Number.isSafeInteger(__requestUserId) ||
    __requestUserId <= 0
  )
    throw new Error('CONVERSATION_TEMPLATE_NOT_AUTHORIZED');
  return { data, requestUserId: __requestUserId };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
