import { mkdir } from 'node:fs/promises';
import type { MarAgentRuntimeModelConfiguration } from '@myagentroam/protocol';
import type { ResolvedMcpServer } from '../mcp/model.js';
import {
  marAgentGeneratedImagesDirectory,
  hostedConversationGeneratedImagesDisplayDirectory
} from '../runner/mar-agent/generated-images.js';
import {
  allowedModels,
  selectModel,
  networkModels,
  resolveMcpServers,
  runtimeModels,
  systemInstruction,
  type TemplateVersionSnapshot,
  type HostedConversationTemplates
} from './hosted-conversation-templates.js';
import type { HostedConversationRuntime } from './runtime-contracts.js';
import {
  hostedConversationMessageInputSchema,
  steerComposerMessage,
  type ConversationFileProjection
} from '@myagentroam/protocol';
import type { HostedConversationUploads } from './hosted-conversation-uploads.js';
import {
  hostedConversationSummarySchema,
  type HostedConversationActivity,
  type HostedConversationManifest,
  type HostedConversationSummary
} from '@myagentroam/protocol';
import { sessionTitleFromFirstMessage } from '../session/input-validation.js';
import { safeErrorCode } from '../util/safe-error.js';
import type { HostedConversationStore } from './hosted-conversation-store.js';
import type { HostedConversationWatch } from './hosted-conversation-watch.js';
import type {
  HostedConversationRuntimeEvent,
  HostedConversationRuntimeHandle,
  HostedConversationRuntimeRun
} from './runtime-contracts.js';

class HostedRunEvents {
  private accepted = false;
  private readonly pending: HostedConversationRuntimeEvent[] = [];
  constructor(
    private readonly conversationId: string,
    private readonly watch: HostedConversationWatch
  ) {}
  readonly emit = (event: HostedConversationRuntimeEvent): void => {
    if (this.accepted) this.publish(event);
    else this.pending.push(event);
  };
  accept(): void {
    this.accepted = true;
    for (const event of this.pending) this.publish(event);
    this.pending.length = 0;
  }
  private publish(event: HostedConversationRuntimeEvent): void {
    this.watch.publishEvent(this.conversationId, {
      conversationId: this.conversationId,
      kind: 'runtime',
      runtimeEvent: event
    });
  }
}

interface HostedConversationRunsOptions {
  readonly store: HostedConversationStore;
  readonly hostedWatch: HostedConversationWatch;
  readonly now: () => number;
  readonly nodeId: () => string;
  readonly publishWorkbenchEvent: (payload: unknown) => void;
  readonly uploads: HostedConversationUploads;
  readonly runtime: HostedConversationRuntime;
  readonly templates: HostedConversationTemplates;
  readonly secretEnvironment: NodeJS.ProcessEnv | undefined;
  readonly modelUsage:
    | ((
        grant: import('@myagentroam/protocol').ModelUsageGrant,
        usage: import('@myagentroam/agent').ModelUsageObservation
      ) => void)
    | undefined;
}

/** Owns accepted Hosted Runs, message admissions, settlements and interruption intent. */
export class HostedConversationRuns {
  private readonly activities = new Map<string, HostedConversationActivity>();
  constructor(private readonly options: HostedConversationRunsOptions) {}
  forgetActivity(id: string): void {
    this.activities.delete(id);
  }

  runtimeEvents(conversationId: string): HostedRunEvents {
    return new HostedRunEvents(conversationId, this.options.hostedWatch);
  }

  adopt(input: {
    readonly userId: number;
    readonly conversation: HostedConversationManifest;
    readonly clientMessageId: string;
    readonly handle: HostedConversationRuntimeHandle;
    readonly titleChanged: boolean;
    readonly events: HostedRunEvents;
  }): void {
    const { conversation, handle, userId } = input;
    this.accept(conversation.id, handle);
    this.publishActivity(userId, conversation, 'RUNNING', handle.run.startedAt);
    if (input.titleChanged)
      this.options.hostedWatch.publishEvent(conversation.id, {
        conversationId: conversation.id,
        kind: 'conversation',
        conversation: this.summary(conversation)
      });
    this.options.hostedWatch.publishEvent(conversation.id, {
      conversationId: conversation.id,
      kind: 'run',
      run: handle.run
    });
    input.events.accept();
    const settlement = Promise.resolve().then(async () => {
      try {
        const completion = await handle.completion.catch(() => ({
          status: 'FAILED' as const,
          completedAt: this.options.now()
        }));
        await this.waitForNativeAdmission(handle);
        await this.finishRun(
          userId,
          conversation.id,
          input.clientMessageId,
          handle.run,
          completion
        );
      } catch {
        // Settlement failures must not leave the conversation permanently busy.
      } finally {
        this.release(conversation.id, handle, settlement);
      }
    });
    this.trackSettlement(conversation.id, settlement);
    void settlement;
  }

  async startMessage(
    payload: {
      readonly userId: number;
      readonly models?: unknown;
      readonly compact?: unknown;
      readonly searchBackendAvailable?: boolean;
      readonly runtimeScopeId?: string;
      readonly usageGrant?: import('@myagentroam/protocol').ModelUsageGrant;
    },
    input: ReturnType<typeof hostedConversationMessageInputSchema.parse>,
    conversation: HostedConversationManifest,
    steerPrompt?: string
  ): Promise<unknown> {
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
      : this.options.templates.latestAvailableTemplateVersionId(conversation.templateId);
    if (latestVersionId !== undefined && latestVersionId !== conversation.activeVersionId) {
      const previousVersionId = conversation.activeVersionId;
      const targetVersionId = latestVersionId;
      try {
        version = await this.options.templates.loadTemplateVersion(
          targetVersionId,
          conversation.templateId
        );
        selected = selectModel(version, models, input.modelId ?? version.modelPolicy.defaultId);
        mcpServers = resolveMcpServers(version, this.options.secretEnvironment ?? process.env);
        this.options.templates.pathMounts(paths, version);
        this.options.templates.processExecutor(paths, version);
        upgrade = { previousVersionId, targetVersionId };
      } catch (error) {
        this.publishUpgradeFailure(conversation, previousVersionId, targetVersionId, error);
        throw new Error('HOSTED_CONVERSATION_UPGRADE_FAILED');
      }
    } else {
      version = await this.options.templates.loadTemplateVersion(
        conversation.activeVersionId,
        conversation.templateId
      );
      selected = selectModel(version, models, input.modelId ?? conversation.modelId);
    }
    const attachments = await Promise.all(
      input.attachmentIds.map((fileId) =>
        this.options.uploads.requireAttachment(payload.userId, conversation.id, fileId)
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
    const pathMounts = this.options.templates.pathMounts(
      paths,
      version,
      generatedImagesDirectory,
      generatedImagesLogicalPath,
      temporaryDirectory
    );
    this.publishActivity(payload.userId, conversation, 'STARTING', this.options.now());
    const runtimeEvents = this.runtimeEvents(conversation.id);
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
        ...(payload.searchBackendAvailable === undefined
          ? {}
          : { searchBackendAvailable: payload.searchBackendAvailable }),
        ...(payload.compact === undefined ? {} : { compact: payload.compact }),
        ...(payload.runtimeScopeId === undefined ? {} : { runtimeScopeId: payload.runtimeScopeId }),
        systemInstruction: systemInstruction(version, generatedImagesLogicalPath),
        homeDirectory: paths.homeDirectory,
        workspaceDirectory: version.templateDirectory,
        temporaryDirectory,
        pathMounts,
        processExecutor: this.options.templates.processExecutor(
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
        onEvent: runtimeEvents.emit
      })
      .catch((error) => {
        this.publishActivity(payload.userId, conversation, 'IDLE', this.options.now());
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
      const configuredAt = this.options.now();
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
        completedAt: this.options.now()
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
      this.options.hostedWatch.publishEvent(conversation.id, {
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
    this.adopt({
      userId: payload.userId,
      conversation,
      clientMessageId: input.clientMessageId,
      handle,
      titleChanged: accepted.titleChanged,
      events: runtimeEvents
    });
    return {
      conversation: this.summary(conversation),
      run: handle.run
    };
  }

  private publishUpgradeFailure(
    conversation: HostedConversationManifest,
    previousVersionId: string,
    targetVersionId: string,
    error: unknown
  ): void {
    this.options.hostedWatch.publishEvent(conversation.id, {
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

  private readonly pendingMessages = new Map<string, Promise<unknown>>();
  private readonly activeRuns = new Map<string, HostedConversationRuntimeHandle>();
  private readonly settlements = new Map<string, Promise<void>>();
  private readonly nativeAdmissions = new Map<HostedConversationRuntimeHandle, Promise<void>>();
  private readonly expectedInterruptions = new Set<string>();

  async replaceMessage(
    payload: { readonly userId: number; readonly runtimeScopeId?: string },
    input: {
      readonly prompt: string;
      readonly clientMessageId: string;
      readonly attachmentIds: readonly string[];
      readonly modelId?: string | undefined;
    },
    conversation: HostedConversationManifest,
    start: (steerPrompt?: string) => Promise<unknown>
  ): Promise<unknown> {
    const handle = this.current(conversation.id);
    if (handle === undefined) {
      if (this.settlement(conversation.id)) throw new Error('HOSTED_CONVERSATION_RUN_ACTIVE');
      return start();
    }
    const steerPrompt = steerComposerMessage(input.prompt);
    if (handle.steer) {
      const barrier = Promise.withResolvers<void>();
      this.beginNativeAdmission(handle, barrier.promise);
      let result: import('@myagentroam/agent').SteerResult;
      try {
        const attachments = await Promise.all(
          input.attachmentIds.map((fileId) =>
            this.options.uploads.requireAttachment(payload.userId, conversation.id, fileId)
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
          const now = this.options.now();
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
        this.endNativeAdmission(handle);
      }
    }
    if (!this.interruptActiveRun(payload.userId, conversation, handle))
      throw new Error('HOSTED_CONVERSATION_RUN_ACTIVE');
    await this.settlement(conversation.id)?.catch(() => undefined);
    return start(steerPrompt);
  }

  admitMessage(
    userId: number,
    conversationId: string,
    clientMessageId: string,
    begin: () => Promise<unknown>
  ): Promise<unknown> {
    const key = `${conversationId}\0${clientMessageId}`;
    const pending = this.pending(key);
    if (pending !== undefined) return pending;
    const existing = this.options.store.findMessage(userId, conversationId, clientMessageId);
    if (existing !== undefined) {
      const conversation = this.options.store.requireConversation(userId, conversationId);
      return Promise.resolve({
        conversation: this.summary(conversation),
        run: {
          id: existing.runId,
          status: existing.status,
          startedAt: existing.createdAt,
          completedAt: existing.status === 'RUNNING' ? null : existing.updatedAt
        }
      });
    }
    if (this.hasPending(conversationId))
      return Promise.reject(new Error('HOSTED_CONVERSATION_RUN_ACTIVE'));
    const operation = begin();
    this.acceptMessage(key, operation);
    return operation;
  }

  get active(): boolean {
    return this.pendingMessages.size > 0 || this.activeRuns.size > 0 || this.settlements.size > 0;
  }

  current(conversationId: string): HostedConversationRuntimeHandle | undefined {
    return this.activeRuns.get(conversationId);
  }

  settlement(conversationId: string): Promise<void> | undefined {
    return this.settlements.get(conversationId);
  }

  pending(key: string): Promise<unknown> | undefined {
    return this.pendingMessages.get(key);
  }

  hasPending(conversationId: string): boolean {
    const prefix = `${conversationId}\0`;
    return [...this.pendingMessages.keys()].some((key) => key.startsWith(prefix));
  }

  busy(conversationId: string): boolean {
    return (
      this.activeRuns.has(conversationId) ||
      this.settlements.has(conversationId) ||
      this.hasPending(conversationId)
    );
  }

  acceptMessage(key: string, operation: Promise<unknown>): void {
    this.pendingMessages.set(key, operation);
    void operation.finally(() => this.pendingMessages.delete(key)).catch(() => undefined);
  }

  async waitForAdmissions(conversationId: string): Promise<void> {
    const prefix = `${conversationId}\0`;
    const pending = [...this.pendingMessages.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, operation]) => operation);
    await Promise.allSettled(pending);
  }

  accept(conversationId: string, handle: HostedConversationRuntimeHandle): void {
    this.activeRuns.set(conversationId, handle);
  }

  trackSettlement(conversationId: string, settlement: Promise<void>): void {
    this.settlements.set(conversationId, settlement);
  }

  beginNativeAdmission(handle: HostedConversationRuntimeHandle, barrier: Promise<void>): void {
    this.nativeAdmissions.set(handle, barrier);
  }

  endNativeAdmission(handle: HostedConversationRuntimeHandle): void {
    this.nativeAdmissions.delete(handle);
  }

  waitForNativeAdmission(handle: HostedConversationRuntimeHandle): Promise<void> | undefined {
    return this.nativeAdmissions.get(handle);
  }

  release(
    conversationId: string,
    handle: HostedConversationRuntimeHandle,
    settlement: Promise<void>
  ): void {
    this.clearInterruption(conversationId, handle.run.id);
    if (this.settlements.get(conversationId) === settlement)
      this.settlements.delete(conversationId);
    if (this.activeRuns.get(conversationId) === handle) this.activeRuns.delete(conversationId);
  }

  markInterruption(conversationId: string, runId: string): void {
    this.expectedInterruptions.add(`${conversationId}\0${runId}`);
  }

  clearInterruption(conversationId: string, runId: string): void {
    this.expectedInterruptions.delete(`${conversationId}\0${runId}`);
  }

  expectsInterruption(conversationId: string, runId: string): boolean {
    return this.expectedInterruptions.has(`${conversationId}\0${runId}`);
  }

  interruptActiveRun(
    userId: number,
    conversation: HostedConversationManifest,
    handle: HostedConversationRuntimeHandle
  ): boolean {
    this.markInterruption(conversation.id, handle.run.id);
    try {
      const interrupted = handle.cancel();
      if (!interrupted) {
        this.clearInterruption(conversation.id, handle.run.id);
        return false;
      }
      this.publishActivity(userId, conversation, 'CANCELLING', this.options.now());
      return true;
    } catch (error) {
      this.clearInterruption(conversation.id, handle.run.id);
      throw error;
    }
  }

  cancelAll(cancelled: Set<HostedConversationRuntimeHandle>, errors: unknown[]): void {
    for (const [conversationId, handle] of this.activeRuns) {
      if (cancelled.has(handle)) continue;
      cancelled.add(handle);
      this.markInterruption(conversationId, handle.run.id);
      try {
        if (!handle.cancel('shutdown')) this.clearInterruption(conversationId, handle.run.id);
      } catch (error) {
        this.clearInterruption(conversationId, handle.run.id);
        errors.push(error);
      }
    }
  }

  async close(): Promise<void> {
    const cancelled = new Set<HostedConversationRuntimeHandle>();
    const errors: unknown[] = [];
    this.cancelAll(cancelled, errors);
    await Promise.allSettled(this.pendingMessages.values());
    this.cancelAll(cancelled, errors);
    await Promise.allSettled(this.settlements.values());
    if (errors.length > 0) throw errors[0];
  }
  async finishRun(
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
    const expectedInterruption = this.expectsInterruption(conversationId, run.id);
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
        this.options.hostedWatch.publishEvent(conversationId, {
          conversationId,
          kind: 'files',
          files,
          error: null
        });
      } catch (error) {
        this.options.hostedWatch.publishEvent(conversationId, {
          conversationId,
          kind: 'files',
          files: this.options.store.listFiles(userId, conversationId),
          error: {
            code: safeErrorCode(error, 'HOSTED_CONVERSATION_FILE_RECONCILE_FAILED'),
            message: 'Hosted conversation file projection failed.'
          }
        });
      }
      this.options.hostedWatch.publishEvent(conversationId, {
        conversationId,
        kind: 'run',
        run: {
          id: run.id,
          status: completion.status,
          startedAt: run.startedAt,
          completedAt: completion.completedAt
        }
      });
      void this.options.hostedWatch.refreshReadySnapshots(conversationId, run.id);
      await this.options.store.advanceLastActivity(conversationId, completion.completedAt);
      await this.applyAutomaticTitle(
        conversationId,
        completion.title,
        completion.completedAt
      ).catch(() => undefined);
      conversation = this.options.store.requireConversation(userId, conversationId);
    } finally {
      this.clearInterruption(conversationId, run.id);
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
    this.options.hostedWatch.publishEvent(conversationId, {
      conversationId,
      kind: 'conversation',
      conversation: this.summary(saved)
    });
  }

  activity(conversationId: string): HostedConversationActivity {
    return (
      this.activities.get(conversationId) ?? {
        status: 'IDLE',
        version: 0,
        updatedAt: 0
      }
    );
  }

  summary(conversation: HostedConversationManifest): HostedConversationSummary {
    return hostedConversationSummary(conversation, this.activity(conversation.id));
  }

  publishActivity(
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
    this.options.publishWorkbenchEvent({
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
    this.options.publishWorkbenchEvent({
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

export function attachmentPrompt(
  prompt: string,
  attachments: readonly ConversationFileProjection[]
): string {
  if (attachments.length === 0) return prompt;
  const suffix = attachments.map((file) => `- /workspace/inbox/${file.relativePath}`).join('\n');
  return `${prompt}${prompt.trim().length === 0 ? '' : '\n\n'}Attachments:\n${suffix}`;
}
