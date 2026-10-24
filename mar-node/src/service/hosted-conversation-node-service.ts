import { assertMcpServerNames } from '../mcp/naming.js';
import { modelUsageGrantSchema, steerComposerMessage } from '@myagentroam/protocol';
import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm, utimes } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  toolResultResourceInputSchema,
  toolResultResourcePageSchema,
  conversationTurnSchema,
  conversationTemplateSummarySchema,
  hostedConversationConfigUpdateInputSchema,
  hostedConversationCreateInputSchema,
  hostedConversationDeleteResultSchema,
  hostedConversationFileDeleteInputSchema,
  hostedConversationFileDeleteResultSchema,
  hostedConversationFileReadInputSchema,
  hostedConversationFileReadResultSchema,
  hostedConversationFilesSchema,
  hostedConversationHistoryInputSchema,
  hostedConversationHistoryPageSchema,
  hostedConversationIdInputSchema,
  hostedConversationImageReadInputSchema,
  hostedConversationListInputSchema,
  hostedConversationListPageSchema,
  hostedConversationMessageInputSchema,
  hostedConversationMetadataUpdateInputSchema,
  hostedConversationRollbackInputSchema,
  hostedConversationSnapshotSchema,
  hostedConversationSummarySchema,
  hostedConversationUnwatchInputSchema,
  hostedConversationUploadChunkInputSchema,
  hostedConversationUploadControlInputSchema,
  hostedConversationUploadCreateInputSchema,
  hostedConversationUploadPreflightInputSchema,
  hostedConversationUploadPreflightResultSchema,
  hostedConversationUploadSchema,
  hostedConversationWatchInputSchema,
  marAgentRuntimeModelConfigurationSchema,
  resolveMarAgentDefaultReasoningEffort,
  type ConversationFileProjection,
  type ConversationTemplateDraft,
  type ConversationTemplateSummary,
  type HostedConversationActivity,
  type HostedConversationManifest,
  type HostedConversationSummary,
  type MarAgentNodeModelSummary,
  type MarAgentRuntimeModelConfiguration,
  type WorkbenchEvent
} from '@myagentroam/protocol';
import type { LocalProcessExecutor, WorkspacePathMount } from '@myagentroam/agent';
import type { NodeOperationHandler } from '../connector/node-operation-router.js';
import type { NodeDatabase } from '../database.js';
import type { ResolvedMcpServer } from '../mcp/model.js';
import {
  hostedConversationGeneratedImagesDisplayDirectory,
  hostedConversationImageRunId,
  marAgentGeneratedImagesDirectory
} from '../runner/mar-agent/generated-images.js';
import { sessionTitleFromFirstMessage } from '../util/node-operation-parsers.js';
import { safeErrorCode } from '../util/safe-error.js';
import {
  SessionWatchSlotCoordinator,
  type SessionWatchSlotToken
} from './session-watch-slot-coordinator.js';
import type {
  HostedConversationMessageRecord,
  HostedConversationPaths,
  HostedConversationStore
} from './hosted-conversation-store.js';

import {
  parseTemplateVersionManifest,
  templateContentHash,
  templateMcpConfigHash,
  templateManifestHash,
  type TemplateManifestMcpServer
} from './conversation-template-manifest.js';

const DEFAULT_HOSTED_CONVERSATION_TITLE = 'New conversation';

export interface HostedConversationRuntimeEvent {
  readonly kind: 'RUN' | 'ITEM' | 'DELTA';
  readonly executionId: string;
  readonly turnId?: string;
  readonly sequence: number;
  readonly createdAt: number;
  readonly payload: unknown;
}

export interface HostedConversationRuntimeRun {
  readonly id: string;
  readonly status: 'RUNNING';
  readonly startedAt: number;
  readonly completedAt: null;
}

export interface HostedConversationRuntimeHandle {
  readonly steer?: (input: {
    readonly prompt: string;
    readonly modelText: string;
    readonly clientMessageId: string;
    readonly modelId?: string;
    readonly runtimeScopeId?: string;
  }) => Promise<import('@myagentroam/agent').SteerResult>;
  readonly run: HostedConversationRuntimeRun;
  readonly completion: Promise<{
    readonly status: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';
    readonly completedAt: number;
    readonly title?: string;
  }>;
  readonly cancel: () => boolean;
}

export interface HostedConversationRuntimeSessionInput {
  readonly conversationId: string;
  readonly homeDirectory: string;
  readonly workspaceDirectory: string;
  readonly systemInstruction: string;
  readonly defaultModelId: string;
  readonly models: readonly MarAgentRuntimeModelConfiguration[];
  readonly runtimeScopeId?: string;
  readonly pathMounts: readonly WorkspacePathMount[];
  readonly processExecutor: LocalProcessExecutor;
}

export interface HostedConversationRuntimeHistoryInput {
  readonly conversationId: string;
  readonly sessionId: string;
  readonly homeDirectory: string;
  readonly modelId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface HostedConversationRuntimeHistoryPage {
  readonly turns: readonly unknown[];
  readonly nextCursor: string | null;
}

export interface HostedConversationRuntimeRollbackInput extends HostedConversationRuntimeHistoryInput {
  readonly boundaryTurnId: string | null;
}

export interface HostedConversationRuntimeRunInput {
  readonly onModelUsage?: import('@myagentroam/agent').ModelUsageObserver;
  readonly compact?: unknown;
  readonly conversationId: string;
  readonly sessionId: string;
  readonly clientMessageId: string;
  readonly userPrompt: string;
  readonly prompt: string;
  readonly attachmentIds: readonly string[];
  readonly access: 'full-access';
  readonly modelId: string;
  readonly models: readonly MarAgentRuntimeModelConfiguration[];
  readonly runtimeScopeId?: string;
  readonly systemInstruction: string;
  readonly homeDirectory: string;
  readonly workspaceDirectory: string;
  readonly temporaryDirectory: string;
  readonly pathMounts: readonly WorkspacePathMount[];
  readonly processExecutor: LocalProcessExecutor;
  readonly mcpServers: readonly ResolvedMcpServer[];
  readonly webAccess: boolean;
  readonly onEvent?: (event: HostedConversationRuntimeEvent) => Promise<void> | void;
}

export interface HostedConversationRuntime {
  readToolResultResource?(
    input: {
      homeDirectory: string;
      sessionId: string;
    } & import('@myagentroam/protocol').ToolResultResourceInput
  ): Promise<import('@myagentroam/protocol').ToolResultResourcePage>;
  createSession(
    input: HostedConversationRuntimeSessionInput
  ): Promise<{ readonly sessionId: string }>;
  history(
    input: HostedConversationRuntimeHistoryInput
  ): Promise<HostedConversationRuntimeHistoryPage>;
  rollback(
    input: HostedConversationRuntimeRollbackInput
  ): Promise<{ readonly lastActivityAt: number }>;
  startRun(input: HostedConversationRuntimeRunInput): Promise<HostedConversationRuntimeHandle>;
  releaseSession(input: HostedConversationRuntimeHistoryInput): Promise<void>;
}

export interface HostedConversationProcessExecutorInput {
  readonly workspaceDirectory: string;
  readonly sourceWorkspacePath?: string;
  readonly inboxDirectory: string;
  readonly outputDirectory: string;
  readonly generatedImagesDirectory?: string;
  readonly generatedImagesLogicalPath?: string;
  readonly temporaryDirectory: string;
  readonly networkMode: ConversationTemplateDraft['networkMode'];
}

interface HostedConversationNodeServiceOptions {
  readonly modelUsage?: (
    grant: import('@myagentroam/protocol').ModelUsageGrant,
    usage: import('@myagentroam/agent').ModelUsageObservation
  ) => void;
  readonly database: NodeDatabase;
  readonly store: HostedConversationStore;
  readonly runtime: HostedConversationRuntime;
  readonly nodeId: () => string;
  readonly nodeAppVersion?: () => string;
  readonly processExecutorFactory: (
    input: HostedConversationProcessExecutorInput
  ) => LocalProcessExecutor;
  readonly nodeGeneration?: () => string;
  readonly sessionWatchSlots?: SessionWatchSlotCoordinator;
  readonly emitWatchEvent?: (payload: unknown) => void;
  readonly nextWorkbenchEvent?: (payload: unknown) => WorkbenchEvent | undefined;
  readonly emitWorkbenchEvent?: (event: WorkbenchEvent) => void;
  readonly secretEnvironment?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly id?: () => string;
  readonly assertCanCreate?: () => Promise<void>;
  readonly readImage: (runId: string, selector: string) => Promise<unknown | undefined>;
}

interface TemplateVersionSnapshot {
  readonly id: string;
  readonly templateId: string;
  readonly storageKey: string;
  readonly templateDirectory: string;
  readonly sourceWorkspacePath: string;
  readonly draft: TemplateDraftSnapshot;
  readonly modelPolicy: TemplateModelPolicy;
  readonly mcpServers: readonly TemplateManifestMcpServer[];
}

type TemplateDraftSnapshot = Omit<ConversationTemplateDraft, 'allowedModels' | 'defaultModelId'>;

interface TemplateModelPolicy {
  readonly allowedIds: readonly string[];
  readonly defaultId: string;
}

interface HostedConversationWatchLease {
  readonly ownerKey: string;
  readonly slotToken: SessionWatchSlotToken;
  readonly sessionHash: string;
  readonly workbenchConnectionId: string;
  readonly watchId: string;
  readonly conversationId: string;
  readonly templateId: string;
  readonly userId: number;
  readonly models: readonly MarAgentRuntimeModelConfiguration[];
  readonly nodeGeneration: string;
  readonly pendingEvents: WorkbenchEvent[];
  expiresAt: number;
  ready: boolean;
  timer: NodeJS.Timeout;
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

const HOST_POLICY_VERSION = 1;
const MAX_FILE_READ_BYTES = 512 * 1024;
const WATCH_TTL_MS = 45_000;
/** Implements the Node-owned hosted-conversation domain over an injected MAR Agent runtime. */
export class HostedConversationNodeService {
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly pendingCreates = new Map<string, Promise<unknown>>();
  private readonly pendingMessages = new Map<string, Promise<unknown>>();
  private readonly activeRuns = new Map<string, HostedConversationRuntimeHandle>();
  private readonly runSettlements = new Map<string, Promise<void>>();
  private readonly nativeAdmissions = new Map<HostedConversationRuntimeHandle, Promise<void>>();
  private readonly activities = new Map<string, HostedConversationActivity>();
  private readonly expectedInterruptions = new Set<string>();
  private readonly uploads = new Map<string, ActiveUpload>();
  private readonly uploadsByRequest = new Map<string, string>();
  private readonly pendingUploadCreates = new Map<string, Promise<unknown>>();
  private readonly uploadNameReservations = new Map<string, Set<string>>();
  private readonly fileDeletes = new Set<string>();
  private readonly fileWrites = new Map<
    string,
    Set<{
      readonly uploadId?: string;
      readonly completion: Promise<unknown>;
    }>
  >();
  private closing: Promise<void> | undefined;
  private readonly watchLeases = new Map<string, HostedConversationWatchLease>();
  private readonly cleanupLocks = new Set<string>();
  private readonly historyMutations = new Map<string, Promise<unknown>>();
  private readonly historyVersions = new Map<string, number>();
  private readonly sessionWatchSlots: SessionWatchSlotCoordinator;
  private disablePrepared = false;
  private snapshotSequence = 0;
  private workbenchSequence = 0;

  constructor(private readonly options: HostedConversationNodeServiceOptions) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
    this.sessionWatchSlots = options.sessionWatchSlots ?? new SessionWatchSlotCoordinator();
  }

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      'conversation.hosted.list': (raw) => this.list(raw),
      'conversation.hosted.create': (raw) => this.create(raw),
      'conversation.hosted.get': (raw) => this.get(raw),
      'conversation.hosted.history': (raw) => this.history(raw),
      'conversation.hosted.watch': (raw) => this.watch(raw),
      'conversation.hosted.unwatch': (raw) => this.unwatch(raw),
      'conversation.hosted.message': (raw) => this.message(raw),
      'conversation.hosted.rollback': (raw) => this.rollback(raw),
      'conversation.hosted.interrupt': (raw) => this.interrupt(raw),
      'conversation.hosted.config.update': (raw) => this.updateConfiguration(raw),
      'conversation.hosted.metadata.update': (raw) => this.updateMetadata(raw),
      'conversation.hosted.image.read': (raw) => this.readImage(raw),
      'conversation.hosted.tool-resource.read': (raw) => this.readToolResource(raw),
      'conversation.hosted.files.list': (raw) => this.listFiles(raw),
      'conversation.hosted.file.read': (raw) => this.readFile(raw),
      'conversation.hosted.file.delete': (raw) =>
        this.fileWrite(raw, hostedConversationFileDeleteInputSchema, () => this.deleteFile(raw)),
      'conversation.hosted.files.upload.preflight': (raw) => this.preflightUpload(raw),
      'conversation.hosted.files.upload.create': (raw) =>
        this.fileWrite(raw, hostedConversationUploadCreateInputSchema, () =>
          this.createUpload(raw)
        ),
      'conversation.hosted.files.upload.chunk': (raw) =>
        this.fileWrite(raw, hostedConversationUploadChunkInputSchema, () =>
          this.writeUploadChunk(raw)
        ),
      'conversation.hosted.files.upload.status': (raw) => this.uploadStatus(raw),
      'conversation.hosted.files.upload.complete': (raw) =>
        this.fileWrite(raw, hostedConversationUploadControlInputSchema, () =>
          this.completeUpload(raw)
        ),
      'conversation.hosted.files.upload.cancel': (raw) =>
        this.fileWrite(raw, hostedConversationUploadControlInputSchema, () =>
          this.cancelUpload(raw)
        ),
      'conversation.hosted.delete': (raw) => this.delete(raw)
    };
  }

  /**
   * Closes Run admission while a management operation verifies that it can
   * release the hosting runtime without interrupting an existing execution.
   */
  prepareForDisable(): (() => void) | undefined {
    if (
      this.disablePrepared ||
      this.pendingMessages.size > 0 ||
      this.activeRuns.size > 0 ||
      this.runSettlements.size > 0 ||
      this.historyMutations.size > 0
    )
      return undefined;
    this.disablePrepared = true;
    return () => {
      this.disablePrepared = false;
    };
  }

  private list(raw: unknown) {
    const payload = hostedRequest(raw);
    const input = hostedConversationListInputSchema.parse(payload.data);
    const page = this.options.store.listConversations({
      userId: payload.userId,
      limit: input.limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor })
    });
    return hostedConversationListPageSchema.parse({
      ...page,
      items: page.items.map((conversation) => ({
        ...conversation,
        activity: this.activity(conversation.id)
      }))
    });
  }

  private create(raw: unknown): Promise<unknown> {
    if (this.disablePrepared) return Promise.reject(new Error('CONVERSATION_HOSTING_UNAVAILABLE'));
    const payload = hostedRequest(raw);
    const input = hostedConversationCreateInputSchema.parse(payload.data);
    const template = conversationTemplateSummarySchema.parse(payload.template);
    const models = runtimeModels(payload.models);
    if (
      template.id !== input.templateId ||
      template.nodeId !== this.options.nodeId() ||
      !template.available ||
      template.status !== 'ACTIVE' ||
      template.currentVersionId === null
    )
      throw new Error('HOSTED_CONVERSATION_TEMPLATE_UNAVAILABLE');
    const key = `${payload.userId}\0${input.clientRequestId}`;
    const pending = this.pendingCreates.get(key);
    if (pending !== undefined) return pending;
    const existing = this.options.store.findConversationByClientRequest(
      payload.userId,
      input.clientRequestId
    );
    if (existing !== undefined) return this.snapshot(payload.userId, existing.id, models);
    const operation = this.createConversation(
      payload.userId,
      input.clientRequestId,
      template,
      models,
      payload.runtimeScopeId
    );
    this.pendingCreates.set(key, operation);
    void operation.finally(() => this.pendingCreates.delete(key)).catch(() => undefined);
    return operation;
  }

  private async createConversation(
    userId: number,
    clientRequestId: string,
    template: ConversationTemplateSummary,
    models: readonly MarAgentRuntimeModelConfiguration[],
    runtimeScopeId?: string
  ): Promise<unknown> {
    await this.options.assertCanCreate?.();
    const version = await this.loadTemplateVersion(template.currentVersionId!, template.id);
    const selected = selectModel(version, models, version.modelPolicy.defaultId);
    const conversationId = this.id();
    const prepared = await this.options.store.prepareConversationEnvironment(
      userId,
      conversationId
    );
    const pathMounts = this.pathMounts(prepared.paths, version);
    const processExecutor = this.processExecutor(prepared.paths, version);
    let sessionId: string | undefined;
    try {
      const session = await this.options.runtime.createSession({
        conversationId,
        homeDirectory: prepared.paths.homeDirectory,
        workspaceDirectory: version.templateDirectory,
        systemInstruction: systemInstruction(version),
        defaultModelId: selected.id,
        models: networkModels(allowedModels(version, models), version.draft.networkMode),
        ...(runtimeScopeId === undefined ? {} : { runtimeScopeId }),
        pathMounts,
        processExecutor
      });
      sessionId = session.sessionId;
      const createdAt = this.now();
      const manifest: HostedConversationManifest = {
        id: conversationId,
        nodeId: this.options.nodeId(),
        sessionId,
        templateId: template.id,
        templateName: template.name,
        activeVersionId: version.id,
        title: DEFAULT_HOSTED_CONVERSATION_TITLE,
        titleSource: 'DEFAULT',
        pinnedAt: null,
        status: 'ACTIVE',
        modelId: selected.id,
        createdAt,
        updatedAt: createdAt,
        lastActivityAt: createdAt,
        userStorageKey: prepared.userStorageKey,
        conversationStorageKey: prepared.conversationStorageKey,
        clientRequestId,
        templateDeleted: false,
        quota: {
          usedBytes: 0,
          maxBytes: version.draft.quotas.maxStorageBytes
        }
      };
      const persisted = await this.options.store.createConversation(manifest);
      if (persisted.id !== conversationId) {
        await this.options.runtime
          .releaseSession({
            conversationId,
            sessionId,
            homeDirectory: prepared.paths.homeDirectory
          })
          .catch(() => undefined);
        await rm(prepared.paths.conversationDirectory, { recursive: true, force: true });
      }
      return this.snapshot(userId, persisted.id, models);
    } catch (error) {
      if (sessionId !== undefined)
        await this.options.runtime
          .releaseSession({
            conversationId,
            sessionId,
            homeDirectory: prepared.paths.homeDirectory
          })
          .catch(() => undefined);
      await rm(prepared.paths.conversationDirectory, { recursive: true, force: true }).catch(
        () => undefined
      );
      throw error;
    }
  }

  private async get(raw: unknown): Promise<unknown> {
    const payload = hostedRequest(raw);
    const input = hostedConversationIdInputSchema.parse(payload.data);
    return this.snapshot(
      payload.userId,
      input.conversationId,
      runtimeModels(payload.models),
      payload.templateDeleted
    );
  }

  private async history(raw: unknown): Promise<unknown> {
    const payload = hostedRequest(raw);
    const input = hostedConversationHistoryInputSchema.parse(payload.data);
    const conversation = this.options.store.requireConversation(
      payload.userId,
      input.conversationId
    );
    const paths = this.options.store.pathsForConversation(payload.userId, conversation.id);
    const page = await this.options.runtime.history({
      conversationId: conversation.id,
      sessionId: conversation.sessionId,
      homeDirectory: paths.homeDirectory,
      modelId: conversation.modelId,
      limit: input.limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor })
    });
    return hostedConversationHistoryPageSchema.parse(page);
  }

  private async snapshot(
    userId: number,
    conversationId: string,
    availableModels: readonly MarAgentRuntimeModelConfiguration[],
    templateDeleted = false,
    includeActiveHistoryMutation = false,
    historyOverride?: HostedConversationRuntimeHistoryPage
  ): Promise<unknown> {
    if (includeActiveHistoryMutation)
      return this.readSnapshot(
        userId,
        conversationId,
        availableModels,
        templateDeleted,
        historyOverride
      );
    while (true) {
      const version = this.historyVersions.get(conversationId) ?? 0;
      const mutation = this.historyMutations.get(conversationId);
      if (mutation !== undefined) {
        await mutation.catch(() => undefined);
        continue;
      }
      const snapshot = await this.readSnapshot(
        userId,
        conversationId,
        availableModels,
        templateDeleted
      );
      if (
        !this.historyMutations.has(conversationId) &&
        (this.historyVersions.get(conversationId) ?? 0) === version
      )
        return snapshot;
    }
  }

  private async readSnapshot(
    userId: number,
    conversationId: string,
    availableModels: readonly MarAgentRuntimeModelConfiguration[],
    templateDeleted: boolean,
    historyOverride?: HostedConversationRuntimeHistoryPage
  ): Promise<unknown> {
    let conversation = this.options.store.requireConversation(userId, conversationId);
    if (templateDeleted)
      conversation = await this.options.store.retainConversationTemplate(
        userId,
        conversationId,
        this.now()
      );
    const latestVersionId = conversation.templateDeleted
      ? undefined
      : this.latestAvailableTemplateVersionId(conversation.templateId);
    const displayVersionId = latestVersionId ?? conversation.activeVersionId;
    const version = await this.loadTemplateVersion(displayVersionId, conversation.templateId);
    const models = networkModels(
      allowedModels(version, availableModels),
      version.draft.networkMode
    ).filter((model) => model.conversationModel !== false);
    if (
      models.length > 0 &&
      availableModels.find((model) => model.id === conversation.modelId)?.conversationModel !==
        false
    ) {
      const configuredModelId = conversation.modelId;
      const selected = selectModel(version, availableModels, conversation.modelId);
      if (selected.id !== conversation.modelId)
        conversation = await this.options.store.updateConversation(conversation.id, (current) =>
          current.modelId === configuredModelId ? { ...current, modelId: selected.id } : current
        );
    }
    const paths = this.options.store.pathsForConversation(userId, conversation.id);
    const history =
      historyOverride ??
      (await this.options.runtime.history({
        conversationId: conversation.id,
        sessionId: conversation.sessionId,
        homeDirectory: paths.homeDirectory,
        modelId: conversation.modelId,
        limit: 10
      }));
    return hostedConversationSnapshotSchema.parse({
      nodeAppVersion: this.options.nodeAppVersion?.() ?? 'unknown',
      conversation: this.summary(conversation),
      template: templateSummary(conversation, version.draft),
      run: this.activeRuns.get(conversation.id)?.run ?? null,
      turns: history.turns,
      historyNextCursor: history.nextCursor,
      files: this.options.store.listFiles(userId, conversation.id),
      models: models.map(modelSummary),
      error: null,
      snapshotSequence: 0
    });
  }

  private async watch(raw: unknown): Promise<unknown> {
    if (this.closing) throw new Error('CONVERSATION_HOSTING_UNAVAILABLE');
    const payload = hostedRequest(raw);
    const input = hostedConversationWatchInputSchema.parse(payload.data);
    const conversation = this.options.store.requireConversation(
      payload.userId,
      input.conversationId
    );
    if (this.cleanupLocks.has(conversation.id))
      throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    const sessionHash = requireWatchSessionHash(payload.sessionHash);
    const ownerKey = watchOwnerKey(sessionHash, input.workbenchConnectionId);
    if (input.mode === 'renew') {
      const lease = this.watchLeases.get(ownerKey);
      if (
        lease === undefined ||
        !this.sessionWatchSlots.owns(ownerKey, lease.slotToken) ||
        lease.watchId !== input.watchId ||
        lease.conversationId !== input.conversationId ||
        lease.userId !== payload.userId
      ) {
        throw new Error('SESSION_WATCH_NOT_FOUND');
      }
      if (lease.expiresAt <= Date.now()) {
        this.removeWatchLease(ownerKey);
        throw new Error('SESSION_WATCH_NOT_FOUND');
      }
      lease.expiresAt = Date.now() + WATCH_TTL_MS;
      clearTimeout(lease.timer);
      lease.timer = this.watchLeaseTimer(ownerKey);
      return this.acceptedWatch(lease);
    }
    const models = runtimeModels(payload.models);
    const existing = this.watchLeases.get(ownerKey);
    if (
      existing !== undefined &&
      this.sessionWatchSlots.owns(ownerKey, existing.slotToken) &&
      existing.watchId === input.watchId &&
      existing.conversationId === input.conversationId &&
      existing.userId === payload.userId &&
      existing.expiresAt > Date.now()
    ) {
      existing.expiresAt = Date.now() + WATCH_TTL_MS;
      clearTimeout(existing.timer);
      existing.timer = this.watchLeaseTimer(ownerKey);
      return this.acceptedWatch(existing);
    }
    this.removeWatchLease(ownerKey);
    const slotToken = this.sessionWatchSlots.replace(ownerKey, 'hosted-conversation', () =>
      this.removeWatchLease(ownerKey)
    );
    const lease: HostedConversationWatchLease = {
      ownerKey,
      slotToken,
      sessionHash,
      workbenchConnectionId: input.workbenchConnectionId,
      watchId: input.watchId,
      conversationId: input.conversationId,
      templateId: conversation.templateId,
      userId: payload.userId,
      models,
      nodeGeneration: this.options.nodeGeneration?.() ?? 'local-test-generation',
      pendingEvents: [],
      expiresAt: Date.now() + WATCH_TTL_MS,
      ready: false,
      timer: undefined as unknown as NodeJS.Timeout
    };
    lease.timer = this.watchLeaseTimer(ownerKey);
    this.watchLeases.set(ownerKey, lease);
    void this.initializeWatchLease(lease);
    return this.acceptedWatch(lease);
  }

  private unwatch(raw: unknown): unknown {
    const payload = hostedRequest(raw);
    const input = hostedConversationUnwatchInputSchema.parse(payload.data);
    this.options.store.requireConversation(payload.userId, input.conversationId);
    const ownerKey = watchOwnerKey(
      requireWatchSessionHash(payload.sessionHash),
      input.workbenchConnectionId
    );
    const lease = this.watchLeases.get(ownerKey);
    if (
      lease?.watchId === input.watchId &&
      lease.conversationId === input.conversationId &&
      lease.userId === payload.userId
    )
      this.removeWatchLease(ownerKey);
    return { unwatched: true };
  }

  publishRuntimeEvent(conversationId: string, event: HostedConversationRuntimeEvent): boolean {
    return this.publishHostedEvent(conversationId, {
      conversationId,
      kind: 'runtime',
      runtimeEvent: event
    });
  }

  isConversationInUse(conversationId: string): boolean {
    return (
      this.cleanupLocks.has(conversationId) ||
      this.historyMutations.has(conversationId) ||
      this.activeRuns.has(conversationId) ||
      this.runSettlements.has(conversationId) ||
      this.fileWrites.has(conversationId) ||
      [...this.watchLeases.values()].some((lease) => lease.conversationId === conversationId) ||
      [...this.uploads.values()].some(
        (upload) => upload.conversationId === conversationId && upload.status === 'UPLOADING'
      ) ||
      [...this.pendingMessages.keys()].some((key) => key.startsWith(`${conversationId}\0`))
    );
  }

  beginConversationCleanup(conversationId: string): (() => void) | undefined {
    if (this.isConversationInUse(conversationId)) return undefined;
    this.cleanupLocks.add(conversationId);
    return () => {
      this.cleanupLocks.delete(conversationId);
    };
  }

  async releaseConversationForCleanup(conversation: HostedConversationManifest): Promise<void> {
    const paths = this.options.store.pathsForManifest(conversation);
    await this.options.runtime
      .releaseSession({
        conversationId: conversation.id,
        sessionId: conversation.sessionId,
        homeDirectory: paths.homeDirectory
      })
      .catch(() => undefined);
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.disablePrepared = true;
    for (const [conversationId, handle] of this.activeRuns) {
      const interruptionKey = runInterruptionKey(conversationId, handle.run.id);
      this.expectedInterruptions.add(interruptionKey);
      if (!handle.cancel()) this.expectedInterruptions.delete(interruptionKey);
    }
    for (const ownerKey of [...this.watchLeases.keys()]) this.removeWatchLease(ownerKey);
    this.closing = (async () => {
      await Promise.all([...this.fileWrites.keys()].map((id) => this.waitForFileWrites(id)));
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
    })();
    return this.closing;
  }

  private async fileWrite(
    raw: unknown,
    schema: { parse(value: unknown): { conversationId: string; uploadId?: string } },
    operation: () => Promise<unknown>
  ): Promise<unknown> {
    const payload = hostedRequest(raw);
    const input = schema.parse(payload.data);
    if (this.closing) throw new Error('CONVERSATION_HOSTING_UNAVAILABLE');
    this.requireWritableConversation(payload.userId, input.conversationId);
    const writes = this.fileWrites.get(input.conversationId) ?? new Set();
    if (
      input.uploadId !== undefined &&
      [...writes].some((write) => write.uploadId === input.uploadId)
    )
      throw new Error('HOSTED_CONVERSATION_FILE_CONFLICT');
    // Register before the operation can enter its first asynchronous preparation.
    const write = {
      ...(input.uploadId === undefined ? {} : { uploadId: input.uploadId }),
      completion: Promise.resolve().then(operation)
    };
    writes.add(write);
    this.fileWrites.set(input.conversationId, writes);
    try {
      return await write.completion;
    } finally {
      writes.delete(write);
      if (writes.size === 0) this.fileWrites.delete(input.conversationId);
    }
  }

  private async waitForFileWrites(conversationId: string): Promise<void> {
    const writes = this.fileWrites.get(conversationId);
    if (writes) await Promise.allSettled([...writes].map((write) => write.completion));
  }

  private message(raw: unknown): Promise<unknown> {
    if (this.disablePrepared) return Promise.reject(new Error('CONVERSATION_HOSTING_UNAVAILABLE'));
    const payload = hostedRequest(raw);
    const input = hostedConversationMessageInputSchema.parse(payload.data);
    if (this.historyMutations.has(input.conversationId))
      return Promise.reject(new Error('HOSTED_CONVERSATION_STATE_INVALID'));
    const key = `${input.conversationId}\0${input.clientMessageId}`;
    const pending = this.pendingMessages.get(key);
    if (pending !== undefined) return pending;
    const existing = this.options.store.findMessage(
      payload.userId,
      input.conversationId,
      input.clientMessageId
    );
    if (existing !== undefined) {
      const conversation = this.options.store.requireConversation(
        payload.userId,
        input.conversationId
      );
      return Promise.resolve({
        conversation: this.summary(conversation),
        run: runFromMessage(existing)
      });
    }
    if (
      [...this.pendingMessages.keys()].some((candidate) =>
        candidate.startsWith(`${input.conversationId}\0`)
      )
    )
      return Promise.reject(new Error('HOSTED_CONVERSATION_RUN_ACTIVE'));
    const operation =
      input.deliveryIntent === 'REPLACE_CURRENT'
        ? this.replaceCurrentMessage(payload, input)
        : this.startMessage(payload, input);
    this.pendingMessages.set(key, operation);
    void operation.finally(() => this.pendingMessages.delete(key)).catch(() => undefined);
    return operation;
  }

  private async replaceCurrentMessage(
    payload: HostedRequestPayload,
    input: ReturnType<typeof hostedConversationMessageInputSchema.parse>
  ): Promise<unknown> {
    const conversation = this.options.store.requireConversation(
      payload.userId,
      input.conversationId
    );
    if (
      this.cleanupLocks.has(conversation.id) ||
      this.historyMutations.has(conversation.id) ||
      conversation.status !== 'ACTIVE'
    )
      throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    const handle = this.activeRuns.get(conversation.id);
    if (handle === undefined) {
      if (this.runSettlements.has(conversation.id))
        throw new Error('HOSTED_CONVERSATION_RUN_ACTIVE');
      return this.startMessage(payload, input);
    }
    const steerPrompt = steerComposerMessage(input.prompt);
    if (handle.steer) {
      const barrier = Promise.withResolvers<void>();
      this.nativeAdmissions.set(handle, barrier.promise);
      let result: import('@myagentroam/agent').SteerResult;
      try {
        const attachments = await Promise.all(
          input.attachmentIds.map((fileId) =>
            this.requireAttachment(payload.userId, conversation.id, fileId)
          )
        );
        result = await handle.steer({
          prompt: input.prompt,
          modelText: attachmentPrompt(steerPrompt, attachments),
          clientMessageId: input.clientMessageId,
          ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
          ...(payload.runtimeScopeId === undefined
            ? {}
            : { runtimeScopeId: payload.runtimeScopeId })
        });
        if (result.status !== 'notAccepted') {
          const now = this.now();
          this.options.store.createMessage({
            conversationId: conversation.id,
            clientMessageId: input.clientMessageId,
            runId: handle.run.id,
            userTextPresent:
              result.status === 'accepted' && sessionTitleFromFirstMessage(input.prompt).length > 0,
            status: 'RUNNING',
            createdAt: handle.run.startedAt,
            updatedAt: now
          });
          const accepted = await this.options.store.saveMessageAcceptance({
            conversationId: conversation.id,
            modelId: conversation.modelId,
            activityAt: now
          });
          return { conversation: this.summary(accepted.conversation), run: handle.run };
        }
      } finally {
        barrier.resolve();
        this.nativeAdmissions.delete(handle);
      }
    }
    if (!this.interruptActiveRun(payload.userId, conversation, handle))
      throw new Error('HOSTED_CONVERSATION_RUN_ACTIVE');
    await this.runSettlements.get(conversation.id)?.catch(() => undefined);
    return this.startMessage(payload, input, steerPrompt);
  }

  private async startMessage(
    payload: HostedRequestPayload,
    input: ReturnType<typeof hostedConversationMessageInputSchema.parse>,
    steerPrompt?: string
  ): Promise<unknown> {
    let conversation = this.options.store.requireConversation(payload.userId, input.conversationId);
    if (this.cleanupLocks.has(conversation.id))
      throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    if (this.historyMutations.has(conversation.id))
      throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    if (conversation.status !== 'ACTIVE') throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    if (this.activeRuns.has(conversation.id) || this.runSettlements.has(conversation.id))
      throw new Error('HOSTED_CONVERSATION_RUN_ACTIVE');
    const temporaryTitle = sessionTitleFromFirstMessage(input.prompt);
    const firstNonEmptyMessage =
      temporaryTitle.length > 0 &&
      !this.options.store.hasNonEmptyUserMessage(payload.userId, conversation.id);
    const models = runtimeModels(payload.models);
    const paths = this.options.store.pathsForConversation(payload.userId, conversation.id);
    let version: TemplateVersionSnapshot;
    let selected: MarAgentRuntimeModelConfiguration;
    let mcpServers: readonly ResolvedMcpServer[] | undefined;
    let upgrade:
      | {
          readonly previousVersionId: string;
          readonly targetVersionId: string;
        }
      | undefined;
    const latestVersionId = conversation.templateDeleted
      ? undefined
      : this.latestAvailableTemplateVersionId(conversation.templateId);
    if (latestVersionId !== undefined && latestVersionId !== conversation.activeVersionId) {
      const previousVersionId = conversation.activeVersionId;
      const targetVersionId = latestVersionId;
      try {
        version = await this.loadTemplateVersion(targetVersionId, conversation.templateId);
        selected = selectModel(version, models, input.modelId ?? version.modelPolicy.defaultId);
        mcpServers = resolveMcpServers(version, this.options.secretEnvironment ?? process.env);
        this.pathMounts(paths, version);
        this.processExecutor(paths, version);
        upgrade = { previousVersionId, targetVersionId };
      } catch (error) {
        this.publishUpgradeFailure(conversation, previousVersionId, targetVersionId, error);
        throw new Error('HOSTED_CONVERSATION_UPGRADE_FAILED');
      }
    } else {
      version = await this.loadTemplateVersion(
        conversation.activeVersionId,
        conversation.templateId
      );
      selected = selectModel(version, models, input.modelId ?? conversation.modelId);
    }
    const attachments = await Promise.all(
      input.attachmentIds.map((fileId) =>
        this.requireAttachment(payload.userId, conversation.id, fileId)
      )
    );
    const prompt = attachmentPrompt(steerPrompt ?? input.prompt, attachments);
    const generatedImagesDirectory = marAgentGeneratedImagesDirectory(
      paths.homeDirectory,
      conversation.sessionId
    );
    const generatedImagesLogicalPath = hostedConversationGeneratedImagesDisplayDirectory(
      conversation.sessionId
    );
    if (generatedImagesDirectory === undefined || generatedImagesLogicalPath === undefined)
      throw new Error('HOSTED_CONVERSATION_SESSION_INVALID');
    await mkdir(generatedImagesDirectory, { recursive: true, mode: 0o700 });
    const temporaryDirectory = await this.options.store.prepareConversationTemporaryDirectory(
      payload.userId,
      conversation.id
    );
    const pathMounts = this.pathMounts(
      paths,
      version,
      generatedImagesDirectory,
      generatedImagesLogicalPath,
      temporaryDirectory
    );
    this.publishActivity(payload.userId, conversation, 'STARTING', this.now());
    const pendingRuntimeEvents: HostedConversationRuntimeEvent[] = [];
    let runtimeEventsAccepted = false;
    const handle = await this.options.runtime
      .startRun({
        ...(payload.usageGrant === undefined || this.options.modelUsage === undefined
          ? {}
          : { onModelUsage: (usage) => this.options.modelUsage!(payload.usageGrant!, usage) }),
        conversationId: conversation.id,
        sessionId: conversation.sessionId,
        clientMessageId: input.clientMessageId,
        userPrompt: input.prompt,
        prompt,
        attachmentIds: input.attachmentIds,
        access: 'full-access',
        modelId: selected.id,
        models: networkModels(allowedModels(version, models), version.draft.networkMode),
        ...(payload.compact === undefined ? {} : { compact: payload.compact }),
        ...(payload.runtimeScopeId === undefined ? {} : { runtimeScopeId: payload.runtimeScopeId }),
        systemInstruction: systemInstruction(version, generatedImagesLogicalPath),
        homeDirectory: paths.homeDirectory,
        workspaceDirectory: version.templateDirectory,
        temporaryDirectory,
        pathMounts,
        processExecutor: this.processExecutor(
          paths,
          version,
          temporaryDirectory,
          generatedImagesDirectory,
          generatedImagesLogicalPath
        ),
        mcpServers: (
          mcpServers ?? resolveMcpServers(version, this.options.secretEnvironment ?? process.env)
        ).map((server) => ({ ...server, authorizationIdentity: `user:${payload.userId}` })),
        webAccess: version.draft.networkMode !== 'NONE',
        onEvent: (event) => {
          if (runtimeEventsAccepted) this.publishRuntimeEvent(conversation.id, event);
          else pendingRuntimeEvents.push(event);
        }
      })
      .catch((error) => {
        this.publishActivity(payload.userId, conversation, 'IDLE', this.now());
        if (upgrade !== undefined) {
          this.publishUpgradeFailure(
            conversation,
            upgrade.previousVersionId,
            upgrade.targetVersionId,
            error
          );
          throw new Error('HOSTED_CONVERSATION_UPGRADE_FAILED');
        }
        throw error;
      });
    const startedAt = handle.run.startedAt;
    let messageCreated = false;
    let accepted: {
      readonly conversation: HostedConversationManifest;
      readonly titleChanged: boolean;
    };
    try {
      this.options.store.createMessage({
        conversationId: conversation.id,
        clientMessageId: input.clientMessageId,
        runId: handle.run.id,
        userTextPresent: temporaryTitle.length > 0,
        status: 'RUNNING',
        createdAt: startedAt,
        updatedAt: startedAt
      });
      messageCreated = true;
      const configuredAt = this.now();
      accepted = await this.options.store.saveMessageAcceptance({
        conversationId: conversation.id,
        modelId: selected.id,
        activityAt: configuredAt,
        ...(upgrade === undefined
          ? {}
          : {
              templateVersion: {
                expectedActiveVersionId: upgrade.previousVersionId,
                activeVersionId: upgrade.targetVersionId,
                maxStorageBytes: version.draft.quotas.maxStorageBytes
              }
            }),
        ...(firstNonEmptyMessage ? { automaticTitle: temporaryTitle } : {})
      });
    } catch (error) {
      try {
        handle.cancel();
      } catch {
        // Preserve the original persistence failure.
      }
      const completion = await handle.completion.catch(() => ({
        status: 'FAILED' as const,
        completedAt: this.now()
      }));
      if (messageCreated)
        try {
          this.options.store.finishMessage(
            conversation.id,
            input.clientMessageId,
            completion.status,
            completion.completedAt
          );
        } catch {
          // Preserve the original persistence failure.
        }
      this.publishActivity(payload.userId, conversation, 'IDLE', completion.completedAt);
      if (upgrade !== undefined)
        this.publishUpgradeFailure(
          conversation,
          upgrade.previousVersionId,
          upgrade.targetVersionId,
          error
        );
      throw error;
    }
    conversation = accepted.conversation;
    if (upgrade !== undefined)
      this.publishHostedEvent(conversation.id, {
        conversationId: conversation.id,
        kind: 'upgrade',
        upgrade: {
          status: 'SUCCEEDED',
          previousVersionId: upgrade.previousVersionId,
          targetVersionId: upgrade.targetVersionId,
          activeVersionId: conversation.activeVersionId,
          conversation: this.summary(conversation),
          error: null
        }
      });
    this.activeRuns.set(conversation.id, handle);
    this.publishActivity(payload.userId, conversation, 'RUNNING', handle.run.startedAt);
    if (accepted.titleChanged)
      this.publishHostedEvent(conversation.id, {
        conversationId: conversation.id,
        kind: 'conversation',
        conversation: this.summary(conversation)
      });
    this.publishHostedEvent(conversation.id, {
      conversationId: conversation.id,
      kind: 'run',
      run: handle.run
    });
    runtimeEventsAccepted = true;
    for (const event of pendingRuntimeEvents) this.publishRuntimeEvent(conversation.id, event);
    pendingRuntimeEvents.length = 0;
    const settlement = Promise.resolve().then(async () => {
      try {
        const completion = await handle.completion.catch(() => ({
          status: 'FAILED' as const,
          completedAt: this.now()
        }));
        await this.nativeAdmissions.get(handle);
        await this.finishRun(
          payload.userId,
          conversation.id,
          input.clientMessageId,
          handle.run,
          completion
        );
      } catch {
        // Run settlement failures must not leave the conversation permanently busy.
      } finally {
        this.expectedInterruptions.delete(runInterruptionKey(conversation.id, handle.run.id));
        if (this.runSettlements.get(conversation.id) === settlement)
          this.runSettlements.delete(conversation.id);
        if (this.activeRuns.get(conversation.id) === handle)
          this.activeRuns.delete(conversation.id);
      }
    });
    this.runSettlements.set(conversation.id, settlement);
    void settlement;
    return {
      conversation: this.summary(conversation),
      run: handle.run
    };
  }

  private rollback(raw: unknown): Promise<unknown> {
    if (this.disablePrepared) return Promise.reject(new Error('CONVERSATION_HOSTING_UNAVAILABLE'));
    const payload = hostedRequest(raw);
    const input = hostedConversationRollbackInputSchema.parse(payload.data);
    const conversation = this.options.store.requireConversation(
      payload.userId,
      input.conversationId
    );
    if (
      conversation.status !== 'ACTIVE' ||
      this.cleanupLocks.has(conversation.id) ||
      this.historyMutations.has(conversation.id)
    )
      return Promise.reject(new Error('HOSTED_CONVERSATION_STATE_INVALID'));
    if (
      this.activity(conversation.id).status !== 'IDLE' ||
      this.activeRuns.has(conversation.id) ||
      this.runSettlements.has(conversation.id) ||
      [...this.pendingMessages.keys()].some((key) => key.startsWith(`${conversation.id}\0`))
    )
      return Promise.reject(new Error('HOSTED_CONVERSATION_RUN_ACTIVE'));
    const operation = this.rollbackConversation(payload, conversation, input);
    this.historyMutations.set(conversation.id, operation);
    void operation
      .finally(() => {
        if (this.historyMutations.get(conversation.id) === operation)
          this.historyMutations.delete(conversation.id);
      })
      .catch(() => undefined);
    return operation;
  }

  private async rollbackConversation(
    payload: HostedRequestPayload,
    conversation: HostedConversationManifest,
    input: ReturnType<typeof hostedConversationRollbackInputSchema.parse>
  ): Promise<unknown> {
    const paths = this.options.store.pathsForConversation(payload.userId, conversation.id);
    const turns = await this.readAllHistory(conversation, paths);
    const targetIndex = turns.findIndex((turn) => turn.id === input.turnId);
    const target = turns[targetIndex];
    const userMessage = target?.items.find(
      (item) => item.kind === 'user_message' && item.status === 'COMPLETED'
    );
    if (
      target === undefined ||
      !terminalHostedTurnStatus(target.status) ||
      userMessage === undefined ||
      target.rewind?.before !== input.boundary
    )
      throw new Error('HOSTED_CONVERSATION_ROLLBACK_TARGET_INVALID');
    let rolledBack: { readonly lastActivityAt: number };
    try {
      rolledBack = await this.options.runtime.rollback({
        conversationId: conversation.id,
        sessionId: conversation.sessionId,
        homeDirectory: paths.homeDirectory,
        modelId: conversation.modelId,
        boundaryTurnId: input.boundary
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'MAR_AGENT_ROLLBACK_TARGET_INVALID')
        throw new Error('HOSTED_CONVERSATION_ROLLBACK_TARGET_INVALID', { cause: error });
      throw error;
    }
    this.historyVersions.set(conversation.id, (this.historyVersions.get(conversation.id) ?? 0) + 1);
    await this.options.store.advanceLastActivity(
      conversation.id,
      Math.max(this.now(), rolledBack.lastActivityAt)
    );
    const snapshot = await this.snapshot(
      payload.userId,
      conversation.id,
      runtimeModels(payload.models),
      payload.templateDeleted,
      true
    );
    this.publishHostedSnapshot(conversation.id, snapshot);
    return snapshot;
  }

  private async readAllHistory(
    conversation: HostedConversationManifest,
    paths: HostedConversationPaths
  ) {
    const turns = [];
    let cursor: string | undefined;
    do {
      const page = await this.options.runtime.history({
        conversationId: conversation.id,
        sessionId: conversation.sessionId,
        homeDirectory: paths.homeDirectory,
        modelId: conversation.modelId,
        limit: 100,
        ...(cursor === undefined ? {} : { cursor })
      });
      turns.unshift(...page.turns.map((turn) => conversationTurnSchema.parse(turn)));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return turns;
  }

  private async finishRun(
    userId: number,
    conversationId: string,
    clientMessageId: string,
    run: HostedConversationRuntimeRun,
    completion: {
      readonly status: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';
      readonly completedAt: number;
      readonly title?: string;
    }
  ): Promise<void> {
    const interruptionKey = runInterruptionKey(conversationId, run.id);
    const expectedInterruption = this.expectedInterruptions.has(interruptionKey);
    let conversation: HostedConversationManifest | undefined;
    try {
      this.options.store.finishRunMessages(
        conversationId,
        run.id,
        completion.status,
        completion.completedAt
      );
      try {
        const files = await this.options.store.reconcileFiles(userId, conversationId);
        this.publishHostedEvent(conversationId, {
          conversationId,
          kind: 'files',
          files,
          error: null
        });
      } catch (error) {
        this.publishHostedEvent(conversationId, {
          conversationId,
          kind: 'files',
          files: this.options.store.listFiles(userId, conversationId),
          error: {
            code: safeErrorCode(error, 'HOSTED_CONVERSATION_FILE_RECONCILE_FAILED'),
            message: 'Hosted conversation file projection failed.'
          }
        });
      }
      this.publishHostedEvent(conversationId, {
        conversationId,
        kind: 'run',
        run: {
          id: run.id,
          status: completion.status,
          startedAt: run.startedAt,
          completedAt: completion.completedAt
        }
      });
      void this.refreshReadyWatchSnapshots(conversationId, run.id);
      await this.options.store.advanceLastActivity(conversationId, completion.completedAt);
      await this.applyAutomaticTitle(
        conversationId,
        completion.title,
        completion.completedAt
      ).catch(() => undefined);
      conversation = this.options.store.requireConversation(userId, conversationId);
    } finally {
      this.expectedInterruptions.delete(interruptionKey);
      if (conversation === undefined)
        try {
          conversation = this.options.store.requireConversation(userId, conversationId);
        } catch {
          // The conversation may have been deleted while the Run was settling.
        }
      if (conversation !== undefined)
        this.publishActivity(userId, conversation, 'IDLE', completion.completedAt);
    }
    if (
      conversation !== undefined &&
      (completion.status !== 'INTERRUPTED' || !expectedInterruption)
    )
      this.publishTerminalNotification(userId, conversation, run.id, completion);
  }

  private async applyAutomaticTitle(
    conversationId: string,
    value: string | undefined,
    updatedAt: number
  ): Promise<void> {
    const title = automaticHostedConversationTitle(value);
    if (title === undefined) return;
    const saved = await this.options.store.saveAutomaticTitle(conversationId, title, updatedAt);
    if (saved === undefined) return;
    this.publishHostedEvent(conversationId, {
      conversationId,
      kind: 'conversation',
      conversation: this.summary(saved)
    });
  }

  private interrupt(raw: unknown): unknown {
    const payload = hostedRequest(raw);
    const input = hostedConversationIdInputSchema.parse(payload.data);
    const conversation = this.options.store.requireConversation(
      payload.userId,
      input.conversationId
    );
    const handle = this.activeRuns.get(input.conversationId);
    if (handle === undefined) return { interrupted: false };
    return { interrupted: this.interruptActiveRun(payload.userId, conversation, handle) };
  }

  private interruptActiveRun(
    userId: number,
    conversation: HostedConversationManifest,
    handle: HostedConversationRuntimeHandle
  ): boolean {
    const interruptionKey = runInterruptionKey(conversation.id, handle.run.id);
    this.expectedInterruptions.add(interruptionKey);
    try {
      const interrupted = handle.cancel();
      if (!interrupted) {
        this.expectedInterruptions.delete(interruptionKey);
        return false;
      }
      this.publishActivity(userId, conversation, 'CANCELLING', this.now());
      return true;
    } catch (error) {
      this.expectedInterruptions.delete(interruptionKey);
      throw error;
    }
  }

  private async updateConfiguration(raw: unknown): Promise<unknown> {
    const payload = hostedRequest(raw);
    const input = hostedConversationConfigUpdateInputSchema.parse(payload.data);
    const conversation = this.options.store.requireConversation(
      payload.userId,
      input.conversationId
    );
    if (this.cleanupLocks.has(conversation.id))
      throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    const latestVersionId = conversation.templateDeleted
      ? undefined
      : this.latestAvailableTemplateVersionId(conversation.templateId);
    const displayVersionId = latestVersionId ?? conversation.activeVersionId;
    const version = await this.loadTemplateVersion(displayVersionId, conversation.templateId);
    const models = runtimeModels(payload.models);
    const selected = selectModel(version, models, input.modelId ?? conversation.modelId);
    const updatedAt = this.now();
    const saved = await this.options.store.updateConversation(conversation.id, (current) => ({
      ...current,
      modelId: selected.id,
      updatedAt,
      lastActivityAt: updatedAt
    }));
    this.publishHostedEvent(conversation.id, {
      conversationId: conversation.id,
      kind: 'configuration',
      conversation: this.summary(saved)
    });
    return { conversation: this.summary(saved) };
  }

  private async updateMetadata(raw: unknown): Promise<unknown> {
    const payload = hostedRequest(raw);
    const input = hostedConversationMetadataUpdateInputSchema.parse(payload.data);
    const conversation = this.options.store.requireConversation(
      payload.userId,
      input.conversationId
    );
    if (this.cleanupLocks.has(conversation.id))
      throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    const updatedAt = this.now();
    const saved = await this.options.store.updateConversation(conversation.id, (current) => ({
      ...current,
      title: input.title ?? current.title,
      titleSource: input.title === undefined ? current.titleSource : 'CUSTOM',
      pinnedAt: input.pinned === undefined ? current.pinnedAt : input.pinned ? updatedAt : null,
      updatedAt,
      lastActivityAt: current.lastActivityAt
    }));
    this.publishHostedEvent(conversation.id, {
      conversationId: conversation.id,
      kind: 'configuration',
      conversation: this.summary(saved)
    });
    return { conversation: this.summary(saved) };
  }

  private async listFiles(raw: unknown): Promise<unknown> {
    const payload = hostedRequest(raw);
    const input = hostedConversationIdInputSchema.parse(payload.data);
    return hostedConversationFilesSchema.parse({
      files: this.options.store.listFiles(payload.userId, input.conversationId)
    });
  }

  private async readToolResource(raw: unknown): Promise<unknown> {
    const payload = hostedRequest(raw);
    const { conversationId } = hostedConversationIdInputSchema.parse(payload.data);
    const conversation = this.options.store.requireConversation(payload.userId, conversationId);
    const paths = this.options.store.pathsForConversation(payload.userId, conversation.id);
    const data = payload.data as Record<string, unknown>;
    const input = toolResultResourceInputSchema.parse({
      resourceRef: data.resourceRef,
      cursor: data.cursor,
      maxBytes: data.maxBytes
    });
    if (!this.options.runtime.readToolResultResource) throw new Error('TOOL_RESOURCE_UNSUPPORTED');
    return toolResultResourcePageSchema.parse(
      await this.options.runtime.readToolResultResource({
        homeDirectory: paths.homeDirectory,
        sessionId: conversation.sessionId,
        ...input
      })
    );
  }

  private async readImage(raw: unknown): Promise<unknown> {
    const payload = hostedRequest(raw);
    const input = hostedConversationImageReadInputSchema.parse(payload.data);
    this.options.store.requireConversation(payload.userId, input.conversationId);
    if (input.runId !== hostedConversationImageRunId(input.conversationId))
      throw new Error('HOSTED_CONVERSATION_NOT_AUTHORIZED');
    const image = await this.options.readImage(input.runId, input.imageRef);
    if (image === undefined) throw new Error('RUN_IMAGE_NOT_FOUND');
    return { image };
  }

  private async readFile(raw: unknown): Promise<unknown> {
    const payload = hostedRequest(raw);
    const input = hostedConversationFileReadInputSchema.parse(payload.data);
    const file = this.options.store.requireFile(payload.userId, input.conversationId, input.fileId);
    const path = this.options.store.filePath(payload.userId, file);
    const offset = input.offset ?? 0;
    const limit = Math.min(input.limit ?? MAX_FILE_READ_BYTES, MAX_FILE_READ_BYTES);
    const handle = await openRegularFile(path);
    try {
      const before = await handle.stat();
      assertRegularFileMetadata(before);
      const pathMetadata = await regularFileMetadata(path);
      if (!sameFileIdentity(before, pathMetadata))
        throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
      if (offset > before.size) throw new Error('HOSTED_CONVERSATION_FILE_RANGE_INVALID');
      const buffer = Buffer.alloc(Math.min(limit, Math.max(0, before.size - offset)));
      const read = await handle.read(buffer, 0, buffer.length, offset);
      const after = await handle.stat();
      const currentPathMetadata = await regularFileMetadata(path);
      if (!sameFileSnapshot(before, after) || !sameFileSnapshot(after, currentPathMetadata))
        throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
      const next = offset + read.bytesRead;
      const eof = next >= after.size;
      const currentFile: ConversationFileProjection = {
        ...file,
        size: after.size,
        updatedAt: Math.max(
          file.createdAt,
          safeFileTimestamp(after.mtimeMs),
          safeFileTimestamp(after.ctimeMs)
        )
      };
      return hostedConversationFileReadResultSchema.parse({
        file: currentFile,
        encoding: 'base64',
        content: buffer.subarray(0, read.bytesRead).toString('base64'),
        offset,
        nextOffset: eof ? null : next,
        eof
      });
    } finally {
      await handle.close();
    }
  }

  private async deleteFile(raw: unknown): Promise<unknown> {
    const payload = hostedRequest(raw);
    const input = hostedConversationFileDeleteInputSchema.parse(payload.data);
    this.requireWritableConversation(payload.userId, input.conversationId);
    const deleteKey = `${input.conversationId}\0${input.fileId}`;
    if (this.fileDeletes.has(deleteKey)) throw new Error('HOSTED_CONVERSATION_FILE_CONFLICT');
    this.fileDeletes.add(deleteKey);
    try {
      const files = await this.options.store.deleteFile(
        payload.userId,
        input.conversationId,
        input.fileId,
        this.now()
      );
      const result = hostedConversationFileDeleteResultSchema.parse({
        deletedFileId: input.fileId,
        files
      });
      this.publishHostedEvent(input.conversationId, {
        conversationId: input.conversationId,
        kind: 'files',
        files: result.files,
        error: null
      });
      return result;
    } finally {
      this.fileDeletes.delete(deleteKey);
    }
  }

  private async preflightUpload(raw: unknown): Promise<unknown> {
    const payload = hostedRequest(raw);
    const input = hostedConversationUploadPreflightInputSchema.parse(payload.data);
    const conversation = this.requireWritableConversation(payload.userId, input.conversationId);
    const version = await this.loadTemplateVersion(
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

  private async createUpload(raw: unknown): Promise<unknown> {
    const payload = hostedRequest(raw);
    const input = hostedConversationUploadCreateInputSchema.parse(payload.data);
    const conversation = this.requireWritableConversation(payload.userId, input.conversationId);
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
    payload: HostedRequestPayload,
    input: ReturnType<typeof hostedConversationUploadCreateInputSchema.parse>,
    conversation: HostedConversationManifest,
    requestKey: string
  ): Promise<unknown> {
    const version = await this.loadTemplateVersion(
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

  private async writeUploadChunk(raw: unknown): Promise<unknown> {
    const payload = hostedRequest(raw);
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

  private uploadStatus(raw: unknown): unknown {
    const payload = hostedRequest(raw);
    const input = hostedConversationUploadControlInputSchema.parse(payload.data);
    const upload = this.requireUpload(payload.userId, input.conversationId, input.uploadId);
    return { upload: hostedConversationUploadSchema.parse(uploadProjection(upload)) };
  }

  private async completeUpload(raw: unknown): Promise<unknown> {
    const payload = hostedRequest(raw);
    const input = hostedConversationUploadControlInputSchema.parse(payload.data);
    const upload = this.requireUpload(payload.userId, input.conversationId, input.uploadId);
    if (upload.status === 'COMPLETED')
      return { upload: hostedConversationUploadSchema.parse(uploadProjection(upload)) };
    if (upload.status !== 'UPLOADING' || upload.receivedBytes !== upload.size)
      throw new Error('HOSTED_CONVERSATION_UPLOAD_INCOMPLETE');
    const conversation = this.requireWritableConversation(payload.userId, upload.conversationId);
    const version = await this.loadTemplateVersion(
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
      this.publishHostedEvent(upload.conversationId, {
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

  private async cancelUpload(raw: unknown): Promise<unknown> {
    const payload = hostedRequest(raw);
    const input = hostedConversationUploadControlInputSchema.parse(payload.data);
    const upload = this.requireUpload(payload.userId, input.conversationId, input.uploadId);
    if (upload.status === 'COMPLETED') throw new Error('HOSTED_CONVERSATION_UPLOAD_STATE_INVALID');
    upload.status = 'CANCELLED';
    await rm(upload.temporaryPath, { force: true });
    this.releaseUploadName(upload.conversationId, upload.name);
    return { upload: hostedConversationUploadSchema.parse(uploadProjection(upload)) };
  }

  private async delete(raw: unknown): Promise<unknown> {
    if (this.closing) throw new Error('CONVERSATION_HOSTING_UNAVAILABLE');
    const payload = hostedRequest(raw);
    const input = hostedConversationIdInputSchema.parse(payload.data);
    const conversation = this.options.store.requireConversation(
      payload.userId,
      input.conversationId
    );
    if (this.cleanupLocks.has(conversation.id) || this.historyMutations.has(conversation.id))
      throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    this.cleanupLocks.add(conversation.id);
    try {
      await this.waitForPendingMessageStarts(conversation.id);
      const handle = this.activeRuns.get(conversation.id);
      if (handle !== undefined) {
        const interruptionKey = runInterruptionKey(conversation.id, handle.run.id);
        this.expectedInterruptions.add(interruptionKey);
        if (!handle.cancel()) this.expectedInterruptions.delete(interruptionKey);
      }
      await this.waitForFileWrites(conversation.id);
      await this.cancelConversationUploads(payload.userId, conversation.id);
      const paths = this.options.store.pathsForConversation(payload.userId, conversation.id);
      await this.options.runtime
        .releaseSession({
          conversationId: conversation.id,
          sessionId: conversation.sessionId,
          homeDirectory: paths.homeDirectory
        })
        .catch(() => undefined);
      await this.runSettlements.get(conversation.id)?.catch(() => undefined);
      this.removeConversationWatchLeases(conversation.id);
      await this.options.store.permanentDeleteConversation(conversation.id);
      this.activities.delete(conversation.id);
      this.historyVersions.delete(conversation.id);
      return hostedConversationDeleteResultSchema.parse({
        deletedConversationId: conversation.id
      });
    } finally {
      this.cleanupLocks.delete(conversation.id);
    }
  }

  private async waitForPendingMessageStarts(conversationId: string): Promise<void> {
    const prefix = `${conversationId}\0`;
    const pending = [...this.pendingMessages.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, operation]) => operation);
    await Promise.allSettled(pending);
  }

  private async initializeWatchLease(lease: HostedConversationWatchLease): Promise<void> {
    try {
      const snapshot = await this.get({
        conversationId: lease.conversationId,
        __requestUserId: lease.userId,
        __marAgentModels: lease.models
      });
      if (this.watchLeases.get(lease.ownerKey) !== lease) return;
      this.options.emitWatchEvent?.({
        type: 'watch.hosted-conversation.snapshot',
        workbenchConnectionId: lease.workbenchConnectionId,
        watchId: lease.watchId,
        nodeGeneration: lease.nodeGeneration,
        nodeId: this.options.nodeId(),
        templateId: lease.templateId,
        conversationId: lease.conversationId,
        revision: 1,
        snapshotSequence: ++this.snapshotSequence,
        expiresAt: lease.expiresAt,
        payload: snapshot
      });
      lease.ready = true;
      for (const event of lease.pendingEvents) this.emitWatchLeaseEvent(lease, event);
      lease.pendingEvents.length = 0;
    } catch (error) {
      if (this.watchLeases.get(lease.ownerKey) !== lease) return;
      this.options.emitWatchEvent?.({
        type: 'watch.failed',
        workbenchConnectionId: lease.workbenchConnectionId,
        watchType: 'hosted-conversation',
        watchId: lease.watchId,
        nodeGeneration: lease.nodeGeneration,
        nodeId: this.options.nodeId(),
        templateId: lease.templateId,
        conversationId: lease.conversationId,
        code: safeErrorCode(error, 'HOSTED_CONVERSATION_WATCH_FAILED'),
        message: 'Hosted conversation watch snapshot failed.'
      });
      this.removeWatchLease(lease.ownerKey);
    }
  }

  private async refreshReadyWatchSnapshots(
    conversationId: string,
    completedRunId: string
  ): Promise<void> {
    const leases = [...this.watchLeases.values()].filter(
      (lease) => lease.conversationId === conversationId && lease.ready
    );
    await Promise.allSettled(
      leases.map(async (lease) => {
        const snapshot = await this.snapshot(lease.userId, conversationId, lease.models);
        if (this.watchLeases.get(lease.ownerKey) !== lease || !lease.ready) return;
        const activeRunId = this.activeRuns.get(conversationId)?.run.id;
        if (
          (activeRunId !== undefined && activeRunId !== completedRunId) ||
          (activeRunId === undefined && this.activity(conversationId).status !== 'IDLE')
        )
          return;
        this.options.emitWatchEvent?.({
          type: 'watch.hosted-conversation.snapshot',
          workbenchConnectionId: lease.workbenchConnectionId,
          watchId: lease.watchId,
          nodeGeneration: lease.nodeGeneration,
          nodeId: this.options.nodeId(),
          templateId: lease.templateId,
          conversationId: lease.conversationId,
          revision: 1,
          snapshotSequence: ++this.snapshotSequence,
          expiresAt: lease.expiresAt,
          payload: {
            ...(snapshot as Record<string, unknown>),
            run: null
          }
        });
      })
    );
  }

  private publishHostedSnapshot(conversationId: string, snapshot: unknown): void {
    for (const lease of this.watchLeases.values()) {
      if (lease.conversationId !== conversationId || !lease.ready) continue;
      this.options.emitWatchEvent?.({
        type: 'watch.hosted-conversation.snapshot',
        workbenchConnectionId: lease.workbenchConnectionId,
        watchId: lease.watchId,
        nodeGeneration: lease.nodeGeneration,
        nodeId: this.options.nodeId(),
        templateId: lease.templateId,
        conversationId: lease.conversationId,
        revision: 1,
        snapshotSequence: ++this.snapshotSequence,
        expiresAt: lease.expiresAt,
        payload: snapshot
      });
    }
  }

  private activity(conversationId: string): HostedConversationActivity {
    return (
      this.activities.get(conversationId) ?? {
        status: 'IDLE',
        version: 0,
        updatedAt: 0
      }
    );
  }

  private summary(conversation: HostedConversationManifest): HostedConversationSummary {
    return hostedConversationSummary(conversation, this.activity(conversation.id));
  }

  private publishActivity(
    userId: number,
    conversation: HostedConversationManifest,
    status: HostedConversationActivity['status'],
    updatedAt: number
  ): void {
    const current = this.activity(conversation.id);
    const activity: HostedConversationActivity = {
      status,
      version: current.version + 1,
      updatedAt
    };
    this.activities.set(conversation.id, activity);
    this.publishWorkbenchEvent({
      kind: 'activity',
      userId,
      templateId: conversation.templateId,
      conversationId: conversation.id,
      activity
    });
  }

  private publishTerminalNotification(
    userId: number,
    conversation: HostedConversationManifest,
    runId: string,
    completion: {
      readonly status: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';
      readonly completedAt: number;
    }
  ): void {
    this.publishWorkbenchEvent({
      kind: 'notification',
      event: {
        runId,
        sequence: 1,
        eventType: 'notification',
        payload: {
          targetType: 'HOSTED_CONVERSATION',
          userId,
          templateId: conversation.templateId,
          conversationId: conversation.id,
          conversationTitle: conversation.title,
          runId,
          notificationId: `run:${this.options.nodeId()}:${conversation.id}:${runId}`,
          kind: 'RUN_TERMINAL',
          outcome: completion.status,
          occurredAt: completion.completedAt
        },
        createdAt: completion.completedAt
      }
    });
  }

  private publishWorkbenchEvent(payload: unknown): void {
    const event = this.options.nextWorkbenchEvent?.(payload) ?? {
      sequence: ++this.workbenchSequence,
      category: 'hosted-conversation' as const,
      payload
    };
    if (event !== undefined) this.options.emitWorkbenchEvent?.(event);
  }

  private publishUpgradeFailure(
    conversation: HostedConversationManifest,
    previousVersionId: string,
    targetVersionId: string,
    error: unknown
  ): void {
    this.publishHostedEvent(conversation.id, {
      conversationId: conversation.id,
      kind: 'upgrade',
      upgrade: {
        status: 'FAILED',
        previousVersionId,
        targetVersionId,
        activeVersionId: conversation.activeVersionId,
        conversation: this.summary(conversation),
        error: {
          code: safeErrorCode(error, 'HOSTED_CONVERSATION_UPGRADE_FAILED'),
          message: 'The conversation template upgrade failed.'
        }
      }
    });
  }

  private publishHostedEvent(conversationId: string, payload: unknown): boolean {
    const leases = [...this.watchLeases.values()].filter(
      (lease) => lease.conversationId === conversationId
    );
    if (leases.length === 0) return false;
    const event = this.options.nextWorkbenchEvent?.(payload) ?? {
      sequence: ++this.workbenchSequence,
      category: 'hosted-conversation' as const,
      payload
    };
    if (event === undefined) return false;
    for (const lease of leases) {
      if (!lease.ready) lease.pendingEvents.push(event);
      else this.emitWatchLeaseEvent(lease, event);
    }
    return true;
  }

  private emitWatchLeaseEvent(lease: HostedConversationWatchLease, event: WorkbenchEvent): void {
    this.options.emitWatchEvent?.({
      type: 'watch.hosted-conversation.event',
      workbenchConnectionId: lease.workbenchConnectionId,
      watchId: lease.watchId,
      nodeGeneration: lease.nodeGeneration,
      nodeId: this.options.nodeId(),
      templateId: lease.templateId,
      conversationId: lease.conversationId,
      expiresAt: lease.expiresAt,
      event
    });
  }

  private acceptedWatch(lease: HostedConversationWatchLease): unknown {
    return {
      accepted: true,
      watchId: lease.watchId,
      nodeGeneration: lease.nodeGeneration,
      expiresAt: lease.expiresAt
    };
  }

  private removeConversationWatchLeases(conversationId: string): void {
    for (const lease of [...this.watchLeases.values()])
      if (lease.conversationId === conversationId) this.removeWatchLease(lease.ownerKey);
  }

  private removeWatchLease(ownerKey: string): void {
    const lease = this.watchLeases.get(ownerKey);
    if (lease === undefined) return;
    clearTimeout(lease.timer);
    this.watchLeases.delete(ownerKey);
    this.sessionWatchSlots.release(ownerKey, lease.slotToken);
  }

  private watchLeaseTimer(ownerKey: string): NodeJS.Timeout {
    const timer = setTimeout(() => this.removeWatchLease(ownerKey), WATCH_TTL_MS);
    timer.unref();
    return timer;
  }

  private requireWritableConversation(
    userId: number,
    conversationId: string
  ): HostedConversationManifest {
    const conversation = this.options.store.requireConversation(userId, conversationId);
    if (this.cleanupLocks.has(conversation.id))
      throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    if (conversation.status !== 'ACTIVE') throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    return conversation;
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

  private async cancelConversationUploads(userId: number, conversationId: string): Promise<void> {
    for (const upload of this.uploads.values()) {
      if (upload.userId !== userId || upload.conversationId !== conversationId) continue;
      if (upload.status === 'UPLOADING') {
        upload.status = 'CANCELLED';
        await rm(upload.temporaryPath, { force: true }).catch(() => undefined);
        this.releaseUploadName(upload.conversationId, upload.name);
      }
    }
  }

  private async requireAttachment(
    userId: number,
    conversationId: string,
    fileId: string
  ): Promise<ConversationFileProjection> {
    const file = this.options.store.requireFile(userId, conversationId, fileId);
    if (file.category !== 'UPLOAD') throw new Error('HOSTED_CONVERSATION_ATTACHMENT_INVALID');
    await assertRegularFile(this.options.store.filePath(userId, file), file.size);
    return file;
  }

  private async uploadPreflightStatus(
    conversation: HostedConversationManifest,
    draft: TemplateDraftSnapshot,
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

  private pathMounts(
    paths: HostedConversationPaths,
    version: TemplateVersionSnapshot,
    generatedImagesDirectory?: string,
    generatedImagesLogicalPath?: string,
    temporaryDirectory?: string
  ): readonly WorkspacePathMount[] {
    const mounts: WorkspacePathMount[] = [
      {
        logicalPath: '/workspace',
        physicalPath: version.templateDirectory,
        writable: false
      },
      {
        logicalPath: '/workspace/inbox',
        physicalPath: paths.uploadsDirectory,
        writable: true
      },
      {
        logicalPath: '/workspace/output',
        physicalPath: paths.outputDirectory,
        writable: true
      }
    ];
    if (temporaryDirectory !== undefined)
      mounts.push({
        logicalPath: '/tmp',
        physicalPath: temporaryDirectory,
        writable: true
      });
    if (generatedImagesDirectory !== undefined && generatedImagesLogicalPath !== undefined)
      mounts.push({
        logicalPath: generatedImagesLogicalPath,
        physicalPath: generatedImagesDirectory,
        writable: false
      });
    if (version.sourceWorkspacePath !== undefined)
      mounts.push(
        {
          logicalPath: version.sourceWorkspacePath,
          physicalPath: version.templateDirectory,
          writable: false
        },
        {
          logicalPath: join(version.sourceWorkspacePath, 'inbox'),
          physicalPath: paths.uploadsDirectory,
          writable: true
        },
        {
          logicalPath: join(version.sourceWorkspacePath, 'output'),
          physicalPath: paths.outputDirectory,
          writable: true
        }
      );
    return mounts;
  }

  private processExecutor(
    paths: HostedConversationPaths,
    version: TemplateVersionSnapshot,
    temporaryDirectory = paths.temporaryRootDirectory,
    generatedImagesDirectory?: string,
    generatedImagesLogicalPath?: string
  ): LocalProcessExecutor {
    return this.options.processExecutorFactory({
      workspaceDirectory: version.templateDirectory,
      sourceWorkspacePath: version.sourceWorkspacePath,
      inboxDirectory: paths.uploadsDirectory,
      outputDirectory: paths.outputDirectory,
      ...(generatedImagesDirectory === undefined || generatedImagesLogicalPath === undefined
        ? {}
        : { generatedImagesDirectory, generatedImagesLogicalPath }),
      temporaryDirectory,
      networkMode: version.draft.networkMode
    });
  }

  private latestAvailableTemplateVersionId(templateId: string): string | undefined {
    const row = this.options.database.raw
      .prepare(
        `SELECT id FROM conversation_template_versions
         WHERE template_id=? AND status='AVAILABLE'
         ORDER BY version_number DESC,published_at DESC,id DESC
         LIMIT 1`
      )
      .get(templateId) as { readonly id?: unknown } | undefined;
    if (row === undefined) return undefined;
    if (typeof row.id !== 'string') throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    return row.id;
  }

  private async loadTemplateVersion(
    versionId: string,
    templateId: string
  ): Promise<TemplateVersionSnapshot> {
    const row = this.options.database.raw
      .prepare(
        `SELECT id,template_id,status,storage_key,manifest,content_hash,manifest_hash,mcp_config_hash,
                file_count,total_bytes,host_policy_version
         FROM conversation_template_versions WHERE id=? AND template_id=?`
      )
      .get(versionId, templateId) as Record<string, unknown> | undefined;
    if (
      row === undefined ||
      (row.status !== 'AVAILABLE' && row.status !== 'RETAINED') ||
      row.host_policy_version !== HOST_POLICY_VERSION ||
      typeof row.storage_key !== 'string' ||
      typeof row.manifest !== 'string' ||
      typeof row.content_hash !== 'string' ||
      typeof row.manifest_hash !== 'string' ||
      typeof row.mcp_config_hash !== 'string'
    )
      throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    const versionDirectory = this.options.store.templateVersionDirectory(row.storage_key);
    const manifestPath = join(versionDirectory, 'manifest.json');
    const contentDirectory = join(versionDirectory, 'content');
    const manifestInfo = await lstat(manifestPath).catch(() => undefined);
    const contentInfo = await lstat(contentDirectory).catch(() => undefined);
    if (
      manifestInfo === undefined ||
      !manifestInfo.isFile() ||
      manifestInfo.isSymbolicLink() ||
      contentInfo === undefined ||
      !contentInfo.isDirectory() ||
      contentInfo.isSymbolicLink() ||
      (contentInfo.mode & 0o777) !== 0o555
    )
      throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    let persisted: unknown;
    try {
      const manifestText = await readFile(manifestPath, 'utf8');
      const manifestJson = manifestText.endsWith('\n') ? manifestText.slice(0, -1) : manifestText;
      if (manifestJson !== row.manifest || templateManifestHash(manifestText) !== row.manifest_hash)
        throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
      persisted = JSON.parse(manifestJson);
    } catch {
      throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    }
    if (!record(persisted)) throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    const snapshot = parseTemplateVersionManifest(persisted);
    const { allowedModels, defaultModelId, ...draft } = snapshot.draft;
    const mcpServers = snapshot.mcpServers;
    const contentHash = templateContentHash(snapshot.directories, snapshot.entries);
    const totalBytes = snapshot.entries.reduce((total, entry) => total + entry.size, 0);
    if (
      snapshot.mcpConfigHash !== row.mcp_config_hash ||
      templateMcpConfigHash(mcpServers) !== row.mcp_config_hash ||
      snapshot.contentHash !== row.content_hash ||
      contentHash !== row.content_hash ||
      row.file_count !== snapshot.entries.length ||
      row.total_bytes !== totalBytes
    )
      throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    if (
      persisted.versionId !== versionId ||
      persisted.templateId !== templateId ||
      persisted.hostPolicyVersion !== HOST_POLICY_VERSION ||
      draft.templateId !== templateId ||
      draft.nodeId !== this.options.nodeId()
    )
      throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    return {
      id: versionId,
      templateId,
      storageKey: row.storage_key,
      templateDirectory: contentDirectory,
      sourceWorkspacePath: snapshot.sourceWorkspacePath,
      draft,
      modelPolicy: {
        allowedIds: allowedModels.map((model) => model.modelId),
        defaultId: defaultModelId
      },
      mcpServers
    };
  }
}

interface HostedRequestPayload {
  readonly usageGrant?: import('@myagentroam/protocol').ModelUsageGrant;
  readonly compact?: unknown;
  readonly data: unknown;
  readonly userId: number;
  readonly template?: unknown;
  readonly model?: unknown;
  readonly models?: unknown;
  readonly runtimeScopeId?: string;
  readonly sessionHash?: unknown;
  readonly templateDeleted?: boolean;
}

function hostedRequest(raw: unknown): HostedRequestPayload {
  if (!record(raw)) throw new Error('HOSTED_CONVERSATION_NOT_AUTHORIZED');
  const {
    __usageGrant,
    __requestUserId,
    __template,
    __marAgentModel,
    __marAgentModels,
    __marAgentCompact,
    __marAgentRuntimeScopeId,
    __workspaceWatchSessionHash,
    __templateDeleted,
    ...data
  } = raw;
  if (
    typeof __requestUserId !== 'number' ||
    !Number.isSafeInteger(__requestUserId) ||
    __requestUserId <= 0
  )
    throw new Error('HOSTED_CONVERSATION_NOT_AUTHORIZED');
  if (__templateDeleted !== undefined && __templateDeleted !== true)
    throw new Error('HOSTED_CONVERSATION_NOT_AUTHORIZED');
  if (
    __marAgentRuntimeScopeId !== undefined &&
    (typeof __marAgentRuntimeScopeId !== 'string' || __marAgentRuntimeScopeId.length === 0)
  )
    throw new Error('HOSTED_CONVERSATION_NOT_AUTHORIZED');
  return {
    data,
    ...(__usageGrant === undefined
      ? {}
      : { usageGrant: modelUsageGrantSchema.parse(__usageGrant) }),
    userId: __requestUserId,
    ...(__template === undefined ? {} : { template: __template }),
    ...(__marAgentModel === undefined ? {} : { model: __marAgentModel }),
    ...(__marAgentModels === undefined ? {} : { models: __marAgentModels }),
    ...(__marAgentCompact === undefined ? {} : { compact: __marAgentCompact }),
    ...(__marAgentRuntimeScopeId === undefined ? {} : { runtimeScopeId: __marAgentRuntimeScopeId }),
    ...(__workspaceWatchSessionHash === undefined
      ? {}
      : { sessionHash: __workspaceWatchSessionHash }),
    ...(__templateDeleted === true ? { templateDeleted: true } : {})
  };
}

function requireWatchSessionHash(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error('HOSTED_CONVERSATION_NOT_AUTHORIZED');
  return value;
}

function watchOwnerKey(sessionHash: string, workbenchConnectionId: string): string {
  return `${sessionHash}:${workbenchConnectionId}`;
}

function runtimeModels(value: unknown): readonly MarAgentRuntimeModelConfiguration[] {
  return marAgentRuntimeModelConfigurationSchema
    .array()
    .parse(value) as unknown as readonly MarAgentRuntimeModelConfiguration[];
}

function allowedModels(
  version: TemplateVersionSnapshot,
  models: readonly MarAgentRuntimeModelConfiguration[]
): readonly MarAgentRuntimeModelConfiguration[] {
  const allowed = new Set(version.modelPolicy.allowedIds);
  return models.filter((model) => model.enabled && allowed.has(model.modelId));
}

function selectModel(
  version: TemplateVersionSnapshot,
  models: readonly MarAgentRuntimeModelConfiguration[],
  requestedModelId: string
): MarAgentRuntimeModelConfiguration {
  const available = allowedModels(version, models).filter(
    (model) => model.conversationModel !== false
  );
  const requested = available.find((candidate) => candidate.id === requestedModelId);
  if (requested !== undefined) return requested;
  if (
    models.some(
      (candidate) => candidate.id === requestedModelId && candidate.conversationModel === false
    )
  )
    throw new Error('HOSTED_CONVERSATION_MODEL_NOT_AVAILABLE');
  const defaultModel = available.find(
    (candidate) => candidate.modelId === version.modelPolicy.defaultId
  );
  if (defaultModel !== undefined) return defaultModel;
  const model = version.modelPolicy.allowedIds
    .map((allowedId) => available.find((candidate) => candidate.modelId === allowedId))
    .find((candidate) => candidate !== undefined);
  if (model === undefined) throw new Error('HOSTED_CONVERSATION_MODEL_NOT_AVAILABLE');
  return model;
}

function networkModels(
  models: readonly MarAgentRuntimeModelConfiguration[],
  networkMode: ConversationTemplateDraft['networkMode']
): readonly MarAgentRuntimeModelConfiguration[] {
  if (networkMode !== 'NONE') return models;
  return models.map((model): MarAgentRuntimeModelConfiguration =>
    model.hostedWebSearch ? { ...model, hostedWebSearch: false } : model
  );
}

function resolveMcpServers(
  version: TemplateVersionSnapshot,
  environment: NodeJS.ProcessEnv
): readonly ResolvedMcpServer[] {
  const resolveReferences = (
    references: Readonly<Record<string, { readonly secretName: string }>> | undefined
  ): Readonly<Record<string, string>> => {
    const resolved: Record<string, string> = {};
    for (const [name, reference] of Object.entries(references ?? {})) {
      const value = environment[reference.secretName];
      if (value === undefined) throw new Error('CONVERSATION_TEMPLATE_MCP_INVALID');
      resolved[name] = value;
    }
    return resolved;
  };
  assertMcpServerNames(version.mcpServers.map((server) => ({ name: server.serverName })));
  return version.mcpServers.flatMap((server): readonly ResolvedMcpServer[] => {
    if (server.runtime.transport === 'HTTP') {
      if (version.draft.networkMode !== 'UNRESTRICTED') return [];
      return [
        {
          name: server.serverName,
          lifecycle: 'EXECUTION',
          transport: 'HTTP',
          url: server.runtime.url,
          headers: {
            ...resolveReferences(server.runtime.headers),
            ...resolveReferences(server.configuration.headers)
          }
        }
      ];
    }
    return [
      {
        name: server.serverName,
        lifecycle: 'EXECUTION',
        transport: 'STDIO',
        command: server.runtime.command,
        args: [...server.runtime.args, ...(server.configuration.arguments ?? [])],
        environment: {
          ...resolveReferences(server.runtime.environment),
          ...resolveReferences(server.configuration.environment)
        }
      }
    ];
  });
}

function hostedConversationSummary(
  manifest: HostedConversationManifest,
  activity?: HostedConversationActivity
): HostedConversationSummary {
  return hostedConversationSummarySchema.parse({
    id: manifest.id,
    nodeId: manifest.nodeId,
    sessionId: manifest.sessionId,
    templateId: manifest.templateId,
    templateName: manifest.templateName,
    activeVersionId: manifest.activeVersionId,
    title: manifest.title,
    titleSource: manifest.titleSource,
    pinnedAt: manifest.pinnedAt,
    status: manifest.status,
    modelId: manifest.modelId,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    lastActivityAt: manifest.lastActivityAt,
    ...(activity === undefined ? {} : { activity })
  });
}

function templateSummary(
  conversation: HostedConversationManifest,
  draft: TemplateDraftSnapshot
): ConversationTemplateSummary {
  return conversationTemplateSummarySchema.parse({
    id: conversation.templateId,
    nodeId: conversation.nodeId,
    name: conversation.templateName,
    description: draft.description,
    status: conversation.templateDeleted ? 'DELETED' : 'ACTIVE',
    currentVersionId: conversation.activeVersionId,
    available: !conversation.templateDeleted,
    createdAt: conversation.createdAt,
    updatedAt: draft.updatedAt
  });
}

function modelSummary(
  model: MarAgentRuntimeModelConfiguration,
  index: number
): MarAgentNodeModelSummary {
  return {
    id: model.id,
    name: model.name,
    protocol: model.protocol,
    baseUrl: model.baseUrl,
    modelId: model.modelId,
    contextWindowTokens: model.contextWindowTokens,
    maxOutputTokens: model.maxOutputTokens,
    inputCapabilities: model.inputCapabilities,
    outputCapabilities: model.outputCapabilities,
    reasoningEfforts: model.reasoningEfforts,
    defaultReasoningEffort: resolveMarAgentDefaultReasoningEffort(
      model.defaultReasoningEffort,
      model.reasoningEfforts
    ),
    titleGeneration: model.titleGeneration,
    codeMode: model.codeMode,
    ...(model.fastMode === true ? { fastMode: true } : {}),
    hostedWebSearch: model.hostedWebSearch,
    ...(model.responsesTransport === undefined
      ? {}
      : { responsesTransport: model.responsesTransport }),
    responsesPreviousResponseId: model.responsesPreviousResponseId,
    enabled: model.enabled,
    sortOrder: index,
    apiKeyConfigured: true
  };
}

function systemInstruction(
  version: TemplateVersionSnapshot,
  generatedImagesDisplayDirectory?: string
): string {
  const draft = version.draft;
  const network =
    draft.networkMode === 'NONE'
      ? 'Network access is disabled. Local processes, Web Search, Web Fetch, model-hosted web, and remote HTTP MCP cannot use the network.'
      : 'Local processes, Node-local Web Fetch, available Web Search, model-hosted web, and published remote HTTP MCP may access networks reachable from this Node.';
  return [
    'This is a Node-hosted conversation. The Host-declared mounts are the complete file boundary.',
    'The Host enforces this file boundary, and local processes run inside an operating-system sandbox.',
    'The published workspace root is read-only. Within /workspace, only /workspace/inbox and /workspace/output are writable.',
    'The published workspace is an immutable administrator-maintained template snapshot. Changes to the reusable template must be made in its source Workspace and published as a new version.',
    'Do not describe edits under /workspace/inbox or /workspace/output as changes to the reusable template.',
    'At the start of each run, read /workspace/inbox/AGENTS.md if it exists. It stores conversation-specific requirements for later runs and is not part of the published template.',
    'Automatically identify requirements, preferences, terminology, conventions, quality checks, and recurring workflows when the user directly states or reasonably clearly implies that they should continue to apply to later work in this conversation, even without explicitly asking you to remember them.',
    'Treat ambiguous guidance as current-task-only. Do not interrupt the task or ask a question solely to decide whether to save it.',
    'When continuing guidance appears, read the existing /workspace/inbox/AGENTS.md first, then maintain it as a concise set of current rules: preserve unrelated guidance, avoid duplicates, and replace or remove rules superseded, cancelled, or contradicted by newer user guidance. Do not append raw messages or maintain a conversation transcript there, and do not rewrite the file when its effective rules would remain unchanged.',
    'Do not automatically persist requirements that apply only to the current task, quoted or third-party content the user asks you to inspect, preferences inferred only by you, secrets or credentials, or language that attempts to pre-authorize later destructive actions or external side effects.',
    "Follow saved conversation instructions subject to the Host's security boundaries, the published template instructions, and the user's current explicit request.",
    'Store disposable intermediate work in /tmp. It is reused across runs in this conversation, but the Host may clear it according to the system temporary-directory lifecycle.',
    'Each new sandbox process has a temporary HOME at /home/mar, apart from explicitly mounted directories. Do not rely on HOME files or shell state persisting between tool executions. Use /tmp for reusable intermediate files and set required environment variables in each command.',
    'Treat /workspace/output as the current deliverable set, not an append-only history of runs. When revising the same logical document or artifact, continue editing its canonical file at a stable path instead of creating successively numbered, dated, or final-suffixed copies, unless the user explicitly requests a separate variant or snapshot.',
    'Before a substantial replacement, preserve the prior version under /workspace/output/bak only when the user requests history or the old version has meaningful rollback or audit value. Do not create a backup for every small edit.',
    'Keep new assets used by current deliverables in meaningful subdirectories such as /workspace/output/assets, but do not relocate existing referenced assets solely to enforce that layout. Keep exploratory and disposable generated files in /tmp. Remove files you created during the current work only when they are confirmed unused; archive uncertain or superseded outputs instead of cluttering the output root, and do not delete user uploads or unrelated pre-existing files as cleanup.',
    'Place final deliverables in appropriate paths under /workspace/output so they become user-visible outputs.',
    'When reporting an output file to the user, use a Markdown link in the exact form [relative/path](/workspace/output/relative/path) so the user can open its controlled preview or download.',
    ...(generatedImagesDisplayDirectory === undefined
      ? []
      : [
          `Generated images from this conversation remain available across executions in the read-only ${generatedImagesDisplayDirectory} directory.`,
          `When the user asks to place a previously generated image in output, inspect ${generatedImagesDisplayDirectory} and copy the existing file from ${generatedImagesDisplayDirectory} to /workspace/output when available. If it is missing, report that fact; regenerate only when requested or authorized by the user.`
        ]),
    ...(version.sourceWorkspacePath === undefined
      ? []
      : [
          `The published workspace is also mounted read-only at ${version.sourceWorkspacePath} as a compatibility alias; it is the same immutable snapshot, not the live source Workspace. ${join(version.sourceWorkspacePath, 'inbox')} and ${join(version.sourceWorkspacePath, 'output')} are aliases of the same writable overlays.`
        ]),
    'Read user uploads from /workspace/inbox.',
    network
  ].join('\n');
}

function attachmentPrompt(
  prompt: string,
  attachments: readonly ConversationFileProjection[]
): string {
  if (attachments.length === 0) return prompt;
  const suffix = attachments.map((file) => `- /workspace/inbox/${file.relativePath}`).join('\n');
  return `${prompt}${prompt.trim().length === 0 ? '' : '\n\n'}Attachments:\n${suffix}`;
}

function automaticHostedConversationTitle(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const title = sessionTitleFromFirstMessage(value);
  if (
    title.length === 0 ||
    /^(?:new|untitled) session(?:\s*[-–—:]\s*\d{4}-\d{2}-\d{2}.*)?$/iu.test(title)
  )
    return undefined;
  return title;
}

function terminalHostedTurnStatus(status: string): boolean {
  return (
    status === 'SUCCEEDED' ||
    status === 'FAILED' ||
    status === 'CANCELLED' ||
    status === 'INTERRUPTED' ||
    status === 'LOST'
  );
}

function runFromMessage(record: HostedConversationMessageRecord) {
  return {
    id: record.runId,
    status: record.status,
    startedAt: record.createdAt,
    completedAt: record.status === 'RUNNING' ? null : record.updatedAt
  };
}

function runInterruptionKey(conversationId: string, runId: string): string {
  return `${conversationId}\0${runId}`;
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

async function assertRegularFile(path: string, expectedSize: number): Promise<void> {
  const metadata = await regularFileMetadata(path);
  if (metadata.size !== expectedSize) throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
}

async function openRegularFile(path: string) {
  return open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
  });
}

async function regularFileMetadata(path: string) {
  const metadata = await lstat(path).catch(() => {
    throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
  });
  assertRegularFileMetadata(metadata);
  return metadata;
}

function assertRegularFileMetadata(metadata: Stats): void {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 0
  )
    throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function safeFileTimestamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
