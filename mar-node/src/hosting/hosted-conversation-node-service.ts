import {
  HostedConversationTemplates,
  allowedModels,
  selectModel,
  networkModels,
  resolveMcpServers,
  runtimeModels,
  systemInstruction,
  type TemplateDraftSnapshot,
  type HostedConversationProcessExecutorInput
} from './hosted-conversation-templates.js';
export type { HostedConversationProcessExecutorInput } from './hosted-conversation-templates.js';
import {
  openRegularFile,
  regularFileMetadata,
  assertRegularFileMetadata
} from './hosted-conversation-file-identity.js';
import { HostedConversationUploads } from './hosted-conversation-uploads.js';
import { HostedConversationRuns } from './hosted-conversation-runs.js';
import { HostedConversationFileOperations } from './hosted-conversation-file-operations.js';
import type {
  HostedConversationRuntimeEvent,
  HostedConversationRuntimeHistoryPage,
  HostedConversationRuntime
} from './runtime-contracts.js';
export type {
  HostedConversationRuntimeEvent,
  HostedConversationRuntimeRun,
  HostedConversationRuntimeHandle,
  HostedConversationRuntimeSessionInput,
  HostedConversationRuntimeHistoryInput,
  HostedConversationRuntimeHistoryPage,
  HostedConversationRuntimeRollbackInput,
  HostedConversationRuntimeRunInput,
  HostedConversationRuntime
} from './runtime-contracts.js';
import { resolveSessionRollbackTarget } from '../service/session-rollback-target.js';
import { imagePreviews, MAX_IMAGE_PREVIEW_SOURCE_BYTES } from '../service/image-preview-service.js';
import { modelUsageGrantSchema } from '@myagentroam/protocol';
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { rm } from 'node:fs/promises';
import {
  toolResultResourceInputSchema,
  toolResultResourcePageSchema,
  conversationTurnSchema,
  conversationTemplateSummarySchema,
  hostedConversationConfigUpdateInputSchema,
  hostedConversationTemplateSwitchInputSchema,
  hostedConversationTemplateSwitchResultSchema,
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
  hostedConversationModelOptionsInputSchema,
  hostedConversationModelOptionsSchema,
  hostedConversationRollbackInputSchema,
  hostedConversationSnapshotSchema,
  hostedConversationUnwatchInputSchema,
  hostedConversationUploadChunkInputSchema,
  hostedConversationUploadControlInputSchema,
  hostedConversationUploadCreateInputSchema,
  hostedConversationWatchInputSchema,
  resolveMarAgentDefaultReasoningEffort,
  type ConversationFileProjection,
  type ConversationTemplateSummary,
  type HostedConversationManifest,
  type MarAgentNodeModelSummary,
  type MarAgentRuntimeModelConfiguration,
  type WorkbenchEvent
} from '@myagentroam/protocol';
import type { LocalProcessExecutor } from '@myagentroam/agent/host';
import type { NodeOperationHandler } from '../application/node-operation-contracts.js';
import type { NodeDatabase } from '../database.js';
import { hostedConversationImageRunId } from '../runner/mar-agent/generated-images.js';
import { SessionWatchSlotCoordinator } from '../service/session-watch-slot-coordinator.js';
import { HostedConversationWatch } from './hosted-conversation-watch.js';
import type {
  HostedConversationPaths,
  HostedConversationStore
} from './hosted-conversation-store.js';

const DEFAULT_HOSTED_CONVERSATION_TITLE = 'New conversation';

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

const MAX_FILE_READ_BYTES = 512 * 1024;
/** Implements the Node-owned hosted-conversation domain over an injected MAR Agent runtime. */
export class HostedConversationNodeService {
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly pendingCreates = new Map<string, Promise<unknown>>();
  private readonly runs: HostedConversationRuns;
  private readonly templates: HostedConversationTemplates;
  private readonly fileOperations = new HostedConversationFileOperations();
  private readonly hostedUploads: HostedConversationUploads;
  private closing: Promise<void> | undefined;
  private readonly cleanupLocks = new Set<string>();
  private readonly historyMutations = new Map<string, Promise<unknown>>();
  private readonly historyVersions = new Map<string, number>();
  private disablePrepared = false;
  private workbenchSequence = 0;
  private readonly hostedWatch: HostedConversationWatch;

  constructor(private readonly options: HostedConversationNodeServiceOptions) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
    this.templates = new HostedConversationTemplates(
      options.database,
      options.store,
      options.nodeId,
      options.processExecutorFactory
    );
    this.hostedUploads = new HostedConversationUploads(
      {
        store: options.store,
        request: hostedRequest,
        requireWritableConversation: (userId, id) => this.requireWritableConversation(userId, id),
        loadTemplateVersion: (versionId, templateId) =>
          this.templates.loadTemplateVersion(versionId, templateId),
        publish: (id, payload) => this.hostedWatch.publishEvent(id, payload)
      },
      this.now,
      this.id
    );
    this.hostedWatch = new HostedConversationWatch({
      slots: options.sessionWatchSlots ?? new SessionWatchSlotCoordinator(),
      nodeId: options.nodeId,
      nodeGeneration: options.nodeGeneration,
      emit: options.emitWatchEvent,
      nextEvent: (payload) => this.makeWorkbenchEvent(payload),
      initial: (lease) =>
        this.get({
          conversationId: lease.conversationId,
          __requestUserId: lease.userId,
          __sourceTemplateId: lease.templateId,
          __marAgentModels: lease.models
        }),
      snapshot: (userId, conversationId, models) => this.snapshot(userId, conversationId, models),
      mayRefresh: (conversationId, completedRunId) => {
        const activeRunId = this.runs.current(conversationId)?.run.id;
        return !(
          (activeRunId !== undefined && activeRunId !== completedRunId) ||
          (activeRunId === undefined && this.runs.activity(conversationId).status !== 'IDLE')
        );
      }
    });
    this.runs = new HostedConversationRuns({
      store: options.store,
      hostedWatch: this.hostedWatch,
      now: this.now,
      nodeId: options.nodeId,
      publishWorkbenchEvent: (payload) => this.publishWorkbenchEvent(payload),
      uploads: this.hostedUploads,
      runtime: options.runtime,
      templates: this.templates,
      secretEnvironment: options.secretEnvironment,
      modelUsage: options.modelUsage
    });
  }

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      'conversation.hosted.list': (raw) => this.list(raw),
      'conversation.hosted.model-options': (raw) => this.modelOptions(raw),
      'conversation.hosted.create': (raw) => this.create(raw),
      'conversation.hosted.get': (raw) => this.get(raw),
      'conversation.hosted.history': (raw) => this.history(raw),
      'conversation.hosted.watch': (raw) => this.watch(raw),
      'conversation.hosted.unwatch': (raw) => this.unwatch(raw),
      'conversation.hosted.message': (raw) => this.message(raw),
      'conversation.hosted.rollback': (raw) => this.rollback(raw),
      'conversation.hosted.interrupt': (raw) => this.interrupt(raw),
      'conversation.hosted.config.update': (raw) => this.updateConfiguration(raw),
      'conversation.hosted.template.switch': (raw) => this.switchTemplate(raw),
      'conversation.hosted.metadata.update': (raw) => this.updateMetadata(raw),
      'conversation.hosted.image.read': (raw) => this.readImage(raw),
      'conversation.hosted.tool-resource.read': (raw) => this.readToolResource(raw),
      'conversation.hosted.files.list': (raw) => this.listFiles(raw),
      'conversation.hosted.file.read': (raw) => this.readFile(raw),
      'conversation.hosted.file.delete': (raw) =>
        this.fileWrite(raw, hostedConversationFileDeleteInputSchema, () => this.deleteFile(raw)),
      'conversation.hosted.files.upload.preflight': (raw) =>
        this.hostedUploads.preflightUpload(raw),
      'conversation.hosted.files.upload.create': (raw) =>
        this.fileWrite(raw, hostedConversationUploadCreateInputSchema, () =>
          this.hostedUploads.createUpload(raw)
        ),
      'conversation.hosted.files.upload.chunk': (raw) =>
        this.fileWrite(raw, hostedConversationUploadChunkInputSchema, () =>
          this.hostedUploads.writeUploadChunk(raw)
        ),
      'conversation.hosted.files.upload.status': (raw) => this.hostedUploads.uploadStatus(raw),
      'conversation.hosted.files.upload.complete': (raw) =>
        this.fileWrite(raw, hostedConversationUploadControlInputSchema, () =>
          this.hostedUploads.completeUpload(raw)
        ),
      'conversation.hosted.files.upload.cancel': (raw) =>
        this.fileWrite(raw, hostedConversationUploadControlInputSchema, () =>
          this.hostedUploads.cancelUpload(raw)
        ),
      'conversation.hosted.delete': (raw) => this.delete(raw)
    };
  }

  /**
   * Closes Run admission while a management operation verifies that it can
   * release the hosting runtime without interrupting an existing execution.
   */
  prepareForDisable(): (() => void) | undefined {
    if (this.disablePrepared || this.runs.active || this.historyMutations.size > 0)
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
        activity: this.runs.activity(conversation.id)
      }))
    });
  }

  private async modelOptions(raw: unknown): Promise<unknown> {
    if (this.disablePrepared) throw new Error('CONVERSATION_HOSTING_UNAVAILABLE');
    const payload = hostedRequest(raw);
    const input = hostedConversationModelOptionsInputSchema.parse(payload.data);
    const template = conversationTemplateSummarySchema.parse(payload.template);
    if (
      template.id !== input.templateId ||
      template.nodeId !== this.options.nodeId() ||
      !template.available ||
      template.status !== 'ACTIVE' ||
      template.currentVersionId === null
    )
      throw new Error('HOSTED_CONVERSATION_TEMPLATE_UNAVAILABLE');
    const version = await this.templates.loadTemplateVersion(
      template.currentVersionId,
      template.id
    );
    const models = allowedModels(version, runtimeModels(payload.models)).filter(
      (model) => model.conversationModel !== false
    );
    const selected =
      models.length === 0 ? undefined : selectModel(version, models, version.modelPolicy.defaultId);
    return hostedConversationModelOptionsSchema.parse({
      models: networkModels(models, version.draft.networkMode).map(modelSummary),
      defaultModelId: selected?.id ?? null
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
    if (existing !== undefined) {
      if (existing.templateId !== input.templateId)
        throw new Error('HOSTED_CONVERSATION_TEMPLATE_CONFLICT');
      return this.snapshot(payload.userId, existing.id, models);
    }
    const operation = this.createConversation(
      payload.userId,
      input.clientRequestId,
      template,
      models,
      input.modelId,
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
    requestedModelId?: string,
    runtimeScopeId?: string
  ): Promise<unknown> {
    await this.options.assertCanCreate?.();
    const version = await this.templates.loadTemplateVersion(
      template.currentVersionId!,
      template.id
    );
    if (
      requestedModelId !== undefined &&
      !allowedModels(version, models).some(
        (model) => model.id === requestedModelId && model.conversationModel !== false
      )
    )
      throw new Error('HOSTED_CONVERSATION_MODEL_NOT_AVAILABLE');
    const selected = selectModel(
      version,
      models,
      requestedModelId ?? version.modelPolicy.defaultId
    );
    const conversationId = this.id();
    const prepared = await this.options.store.prepareConversationEnvironment(
      userId,
      conversationId
    );
    const pathMounts = this.templates.pathMounts(prepared.paths, version);
    const processExecutor = this.templates.processExecutor(prepared.paths, version);
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
    this.assertTemplateContext(
      payload,
      this.options.store.requireConversation(payload.userId, input.conversationId)
    );
    return this.snapshot(
      payload.userId,
      input.conversationId,
      runtimeModels(payload.models),
      payload.templateDeleted,
      false,
      undefined,
      payload.sourceTemplateId
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
    historyOverride?: HostedConversationRuntimeHistoryPage,
    sourceTemplateId?: string
  ): Promise<unknown> {
    if (includeActiveHistoryMutation)
      return this.readSnapshot(
        userId,
        conversationId,
        availableModels,
        templateDeleted,
        historyOverride,
        sourceTemplateId
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
        templateDeleted,
        undefined,
        sourceTemplateId
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
    historyOverride?: HostedConversationRuntimeHistoryPage,
    sourceTemplateId?: string
  ): Promise<unknown> {
    let conversation = this.options.store.requireConversation(userId, conversationId);
    if (sourceTemplateId !== undefined && conversation.templateId !== sourceTemplateId)
      throw new Error('HOSTED_CONVERSATION_TEMPLATE_CONFLICT');
    const templateId = conversation.templateId;
    const activeVersionId = conversation.activeVersionId;
    if (templateDeleted)
      conversation = await this.options.store.retainConversationTemplate(
        userId,
        conversationId,
        this.now(),
        sourceTemplateId ?? templateId
      );
    const latestVersionId = conversation.templateDeleted
      ? undefined
      : this.templates.latestAvailableTemplateVersionId(conversation.templateId);
    const displayVersionId = latestVersionId ?? conversation.activeVersionId;
    const version = await this.templates.loadTemplateVersion(
      displayVersionId,
      conversation.templateId
    );
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
          current.templateId === templateId &&
          current.activeVersionId === activeVersionId &&
          current.modelId === configuredModelId
            ? { ...current, modelId: selected.id }
            : current
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
    const current = this.options.store.requireConversation(userId, conversationId);
    if (current.templateId !== templateId || current.activeVersionId !== activeVersionId)
      throw new Error('HOSTED_CONVERSATION_TEMPLATE_CONFLICT');
    return hostedConversationSnapshotSchema.parse({
      nodeAppVersion: this.options.nodeAppVersion?.() ?? 'unknown',
      conversation: this.runs.summary(conversation),
      template: templateSummary(conversation, version.draft),
      run: this.runs.current(conversation.id)?.run ?? null,
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
    this.assertTemplateContext(payload, conversation);
    if (this.cleanupLocks.has(conversation.id))
      throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    const sessionHash = requireWatchSessionHash(payload.sessionHash);
    return this.hostedWatch.watch(input, sessionHash, payload.userId, conversation.templateId, () =>
      runtimeModels(payload.models)
    );
  }

  private unwatch(raw: unknown): unknown {
    const payload = hostedRequest(raw);
    const input = hostedConversationUnwatchInputSchema.parse(payload.data);
    this.options.store.requireConversation(payload.userId, input.conversationId);
    return this.hostedWatch.unwatch(
      input,
      requireWatchSessionHash(payload.sessionHash),
      payload.userId
    );
  }

  publishRuntimeEvent(conversationId: string, event: HostedConversationRuntimeEvent): boolean {
    return this.hostedWatch.publishEvent(conversationId, {
      conversationId,
      kind: 'runtime',
      runtimeEvent: event
    });
  }

  isConversationInUse(conversationId: string): boolean {
    return (
      this.cleanupLocks.has(conversationId) ||
      this.historyMutations.has(conversationId) ||
      this.runs.busy(conversationId) ||
      this.fileOperations.busy(conversationId) ||
      this.hostedWatch.hasConversation(conversationId) ||
      this.hostedUploads.busy(conversationId)
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
    const runs = this.runs.close();
    this.hostedWatch.close();
    this.closing = (async () => {
      const results = await Promise.allSettled([
        runs,
        (async () => {
          await this.fileOperations.close();
          await this.hostedUploads.close();
        })()
      ]);
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      );
      if (failure) throw failure.reason;
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
    return this.fileOperations.write(input.conversationId, input.uploadId, operation);
  }

  private async waitForFileWrites(conversationId: string): Promise<void> {
    await this.fileOperations.wait(conversationId);
  }

  private message(raw: unknown): Promise<unknown> {
    if (this.disablePrepared) return Promise.reject(new Error('CONVERSATION_HOSTING_UNAVAILABLE'));
    const payload = hostedRequest(raw);
    const input = hostedConversationMessageInputSchema.parse(payload.data);
    this.assertTemplateContext(
      payload,
      this.options.store.requireConversation(payload.userId, input.conversationId)
    );
    if (this.historyMutations.has(input.conversationId))
      return Promise.reject(new Error('HOSTED_CONVERSATION_STATE_INVALID'));
    return this.runs.admitMessage(
      payload.userId,
      input.conversationId,
      input.clientMessageId,
      () =>
        input.deliveryIntent === 'REPLACE_CURRENT'
          ? this.replaceCurrentMessage(payload, input)
          : this.startMessage(payload, input)
    );
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
    return this.runs.replaceMessage(payload, input, conversation, (steerPrompt) =>
      this.startMessage(payload, input, steerPrompt)
    );
  }

  private async startMessage(
    payload: HostedRequestPayload,
    input: ReturnType<typeof hostedConversationMessageInputSchema.parse>,
    steerPrompt?: string
  ): Promise<unknown> {
    if (this.disablePrepared) throw new Error('CONVERSATION_HOSTING_UNAVAILABLE');
    let conversation = this.options.store.requireConversation(payload.userId, input.conversationId);
    this.assertTemplateContext(payload, conversation);
    if (this.cleanupLocks.has(conversation.id))
      throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    if (this.historyMutations.has(conversation.id))
      throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    if (conversation.status !== 'ACTIVE') throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    if (this.runs.current(conversation.id) || this.runs.settlement(conversation.id))
      throw new Error('HOSTED_CONVERSATION_RUN_ACTIVE');
    return this.runs.startMessage(payload, input, conversation, steerPrompt);
  }

  private rollback(raw: unknown): Promise<unknown> {
    if (this.disablePrepared) return Promise.reject(new Error('CONVERSATION_HOSTING_UNAVAILABLE'));
    const payload = hostedRequest(raw);
    const input = hostedConversationRollbackInputSchema.parse(payload.data);
    const conversation = this.options.store.requireConversation(
      payload.userId,
      input.conversationId
    );
    this.assertTemplateContext(payload, conversation);
    if (
      conversation.status !== 'ACTIVE' ||
      this.cleanupLocks.has(conversation.id) ||
      this.historyMutations.has(conversation.id)
    )
      return Promise.reject(new Error('HOSTED_CONVERSATION_STATE_INVALID'));
    if (this.runs.activity(conversation.id).status !== 'IDLE' || this.runs.busy(conversation.id))
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
    const selectedInput =
      target === undefined ? undefined : resolveSessionRollbackTarget(target, input.itemId);
    if (
      target === undefined ||
      !terminalHostedTurnStatus(target.status) ||
      selectedInput === undefined ||
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
        boundaryTurnId: input.boundary,
        ...(selectedInput.clientMessageId === undefined
          ? {}
          : {
              beforeInput: {
                turnId: target.rewind!.after,
                clientMessageId: selectedInput.clientMessageId
              }
            })
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
    this.hostedWatch.publishSnapshot(conversation.id, snapshot);
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

  private interrupt(raw: unknown): unknown {
    const payload = hostedRequest(raw);
    const input = hostedConversationIdInputSchema.parse(payload.data);
    const conversation = this.options.store.requireConversation(
      payload.userId,
      input.conversationId
    );
    const handle = this.runs.current(input.conversationId);
    if (handle === undefined) return { interrupted: false };
    return { interrupted: this.runs.interruptActiveRun(payload.userId, conversation, handle) };
  }

  private switchTemplate(raw: unknown): Promise<unknown> {
    if (this.closing || this.disablePrepared) throw new Error('CONVERSATION_HOSTING_UNAVAILABLE');
    const payload = hostedRequest(raw);
    const input = hostedConversationTemplateSwitchInputSchema.parse(payload.data);
    const conversation = this.requireWritableConversation(payload.userId, input.conversationId);
    if (this.fileOperations.busy(conversation.id) || this.hostedUploads.busy(conversation.id))
      throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    if (this.runs.busy(conversation.id)) throw new Error('HOSTED_CONVERSATION_RUN_ACTIVE');
    const template = conversationTemplateSummarySchema.parse(payload.template);
    if (
      template.id !== input.templateId ||
      template.nodeId !== conversation.nodeId ||
      template.status !== 'ACTIVE' ||
      !template.available ||
      template.currentVersionId === null
    )
      throw new Error('HOSTED_CONVERSATION_TEMPLATE_UNAVAILABLE');
    return this.withConversationChange(conversation.id, async () => {
      const current = this.options.store.requireConversation(payload.userId, conversation.id);
      const unchanged = current.templateId === input.templateId;
      if (!unchanged && current.templateId !== input.expectedTemplateId)
        throw new Error('HOSTED_CONVERSATION_TEMPLATE_CONFLICT');
      const version = await this.templates.loadTemplateVersion(
        unchanged ? current.activeVersionId : template.currentVersionId!,
        template.id
      );
      const models = networkModels(
        allowedModels(version, runtimeModels(payload.models)),
        version.draft.networkMode
      ).filter((model) => model.conversationModel !== false);
      let saved = current;
      if (!unchanged) {
        const selected = selectModel(version, models, current.modelId);
        resolveMcpServers(version, this.options.secretEnvironment ?? process.env);
        const paths = this.options.store.pathsForConversation(payload.userId, current.id);
        this.templates.pathMounts(paths, version);
        this.templates.processExecutor(paths, version);
        if (current.quota.usedBytes > version.draft.quotas.maxStorageBytes)
          throw new Error('HOSTED_CONVERSATION_QUOTA_EXCEEDED');
        const updatedAt = this.now();
        saved = await this.options.store.updateConversation(current.id, (latest) => ({
          ...latest,
          templateId: template.id,
          templateName: template.name,
          templateDeleted: false,
          activeVersionId: version.id,
          modelId: selected.id,
          quota: { ...latest.quota, maxBytes: version.draft.quotas.maxStorageBytes },
          updatedAt,
          lastActivityAt: updatedAt
        }));
        try {
          this.hostedWatch.publishEvent(saved.id, {
            conversationId: saved.id,
            kind: 'template-changed'
          });
        } catch {
          // Committed configuration does not depend on best-effort Watch delivery.
        } finally {
          this.hostedWatch.removeConversation(saved.id);
        }
      }
      return hostedConversationTemplateSwitchResultSchema.parse({
        conversation: this.runs.summary(saved),
        template: templateSummary(saved, version.draft),
        models: models.map(modelSummary)
      });
    });
  }

  private withConversationChange(
    conversationId: string,
    change: () => Promise<unknown>
  ): Promise<unknown> {
    if (this.historyMutations.has(conversationId))
      throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    const operation = Promise.resolve().then(change);
    this.historyMutations.set(conversationId, operation);
    void operation
      .finally(() => {
        if (this.historyMutations.get(conversationId) === operation)
          this.historyMutations.delete(conversationId);
      })
      .catch(() => undefined);
    return operation;
  }

  private updateConfiguration(raw: unknown): Promise<unknown> {
    const payload = hostedRequest(raw);
    const input = hostedConversationConfigUpdateInputSchema.parse(payload.data);
    const conversation = this.requireWritableConversation(payload.userId, input.conversationId);
    this.assertTemplateContext(payload, conversation);
    return this.withConversationChange(conversation.id, () =>
      this.saveConfiguration(payload, input, conversation)
    );
  }

  private async saveConfiguration(
    payload: HostedRequestPayload,
    input: ReturnType<typeof hostedConversationConfigUpdateInputSchema.parse>,
    conversation: HostedConversationManifest
  ): Promise<unknown> {
    if (this.cleanupLocks.has(conversation.id))
      throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    const latestVersionId = conversation.templateDeleted
      ? undefined
      : this.templates.latestAvailableTemplateVersionId(conversation.templateId);
    const displayVersionId = latestVersionId ?? conversation.activeVersionId;
    const version = await this.templates.loadTemplateVersion(
      displayVersionId,
      conversation.templateId
    );
    const models = runtimeModels(payload.models);
    const selected = selectModel(version, models, input.modelId ?? conversation.modelId);
    const updatedAt = this.now();
    const saved = await this.options.store.updateConversation(conversation.id, (current) => ({
      ...current,
      modelId: selected.id,
      updatedAt,
      lastActivityAt: updatedAt
    }));
    this.hostedWatch.publishEvent(conversation.id, {
      conversationId: conversation.id,
      kind: 'configuration',
      conversation: this.runs.summary(saved)
    });
    return { conversation: this.runs.summary(saved) };
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
    this.hostedWatch.publishEvent(conversation.id, {
      conversationId: conversation.id,
      kind: 'configuration',
      conversation: this.runs.summary(saved)
    });
    return { conversation: this.runs.summary(saved) };
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
    return {
      image:
        input.preview === undefined ? image : await imagePreviews.fromImage(image, input.preview)
    };
  }

  private async readFile(raw: unknown): Promise<unknown> {
    const payload = hostedRequest(raw);
    const input = hostedConversationFileReadInputSchema.parse(payload.data);
    const file = this.options.store.requireFile(payload.userId, input.conversationId, input.fileId);
    const path = this.options.store.filePath(payload.userId, file);
    const offset = input.preview === undefined ? (input.offset ?? 0) : 0;
    const limit = Math.min(input.limit ?? MAX_FILE_READ_BYTES, MAX_FILE_READ_BYTES);
    const handle = await openRegularFile(path);
    try {
      const before = await handle.stat();
      assertRegularFileMetadata(before);
      const pathMetadata = await regularFileMetadata(path);
      if (!sameFileIdentity(before, pathMetadata))
        throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
      if (offset > before.size) throw new Error('HOSTED_CONVERSATION_FILE_RANGE_INVALID');
      if (input.preview !== undefined && before.size > MAX_IMAGE_PREVIEW_SOURCE_BYTES)
        throw new Error('IMAGE_PREVIEW_TOO_LARGE');
      const buffer = Buffer.alloc(
        input.preview === undefined
          ? Math.min(limit, Math.max(0, before.size - offset))
          : before.size
      );
      const read = await handle.read(buffer, 0, buffer.length, offset);
      if (input.preview !== undefined) {
        while (read.bytesRead < buffer.length) {
          const next = await handle.read(
            buffer,
            read.bytesRead,
            buffer.length - read.bytesRead,
            read.bytesRead
          );
          if (next.bytesRead === 0) throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
          read.bytesRead += next.bytesRead;
        }
      }
      const after = await handle.stat();
      const currentPathMetadata = await regularFileMetadata(path);
      if (!sameFileSnapshot(before, after) || !sameFileSnapshot(after, currentPathMetadata))
        throw new Error('HOSTED_CONVERSATION_FILE_INVALID');
      if (input.preview !== undefined)
        return { image: await imagePreviews.create(buffer, input.preview) };
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
    this.fileOperations.beginDelete(deleteKey);
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
      this.hostedWatch.publishEvent(input.conversationId, {
        conversationId: input.conversationId,
        kind: 'files',
        files: result.files,
        error: null
      });
      return result;
    } finally {
      this.fileOperations.endDelete(deleteKey);
    }
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
      const handle = this.runs.current(conversation.id);
      if (handle !== undefined) {
        this.runs.markInterruption(conversation.id, handle.run.id);
        if (!handle.cancel()) this.runs.clearInterruption(conversation.id, handle.run.id);
      }
      await this.waitForFileWrites(conversation.id);
      await this.hostedUploads.cancelConversationUploads(payload.userId, conversation.id);
      const paths = this.options.store.pathsForConversation(payload.userId, conversation.id);
      await this.options.runtime
        .releaseSession({
          conversationId: conversation.id,
          sessionId: conversation.sessionId,
          homeDirectory: paths.homeDirectory
        })
        .catch(() => undefined);
      await this.runs.settlement(conversation.id)?.catch(() => undefined);
      this.hostedWatch.removeConversation(conversation.id);
      await this.options.store.permanentDeleteConversation(conversation.id);
      this.runs.forgetActivity(conversation.id);
      this.historyVersions.delete(conversation.id);
      return hostedConversationDeleteResultSchema.parse({
        deletedConversationId: conversation.id
      });
    } finally {
      this.cleanupLocks.delete(conversation.id);
    }
  }

  private async waitForPendingMessageStarts(conversationId: string): Promise<void> {
    await this.runs.waitForAdmissions(conversationId);
  }

  private makeWorkbenchEvent(payload: unknown): WorkbenchEvent | undefined {
    return (
      this.options.nextWorkbenchEvent?.(payload) ?? {
        sequence: ++this.workbenchSequence,
        category: 'hosted-conversation' as const,
        payload
      }
    );
  }

  private publishWorkbenchEvent(payload: unknown): void {
    const event = this.makeWorkbenchEvent(payload);
    if (event !== undefined) this.options.emitWorkbenchEvent?.(event);
  }

  private requireWritableConversation(
    userId: number,
    conversationId: string
  ): HostedConversationManifest {
    const conversation = this.options.store.requireConversation(userId, conversationId);
    if (this.cleanupLocks.has(conversation.id) || this.historyMutations.has(conversation.id))
      throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    if (conversation.status !== 'ACTIVE') throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    return conversation;
  }

  private assertTemplateContext(
    payload: HostedRequestPayload,
    conversation: HostedConversationManifest
  ): void {
    if (
      payload.sourceTemplateId !== undefined &&
      payload.sourceTemplateId !== conversation.templateId
    )
      throw new Error('HOSTED_CONVERSATION_TEMPLATE_CONFLICT');
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
  readonly sourceTemplateId?: string;
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
    __sourceTemplateId,
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
    __sourceTemplateId !== undefined &&
    (typeof __sourceTemplateId !== 'string' || __sourceTemplateId.length === 0)
  )
    throw new Error('HOSTED_CONVERSATION_NOT_AUTHORIZED');
  if (
    __marAgentRuntimeScopeId !== undefined &&
    (typeof __marAgentRuntimeScopeId !== 'string' || __marAgentRuntimeScopeId.length === 0)
  )
    throw new Error('HOSTED_CONVERSATION_NOT_AUTHORIZED');
  return {
    data,
    ...(__sourceTemplateId === undefined ? {} : { sourceTemplateId: __sourceTemplateId }),
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
    ...(model.serviceTier === undefined ? {} : { serviceTier: model.serviceTier }),
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

function terminalHostedTurnStatus(status: string): boolean {
  return (
    status === 'SUCCEEDED' ||
    status === 'FAILED' ||
    status === 'CANCELLED' ||
    status === 'INTERRUPTED' ||
    status === 'LOST'
  );
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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
