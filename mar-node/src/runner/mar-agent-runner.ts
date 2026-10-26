import type {
  MarAgentNodeModelSummary,
  NodeCapabilities,
  RunnerDefaultConfiguration,
  RunnerProfile
} from '@myagentroam/protocol';
import {
  marAgentNodeModelSummarySchema,
  parseComposerTags,
  resolveMarAgentDefaultReasoningEffort,
  serializeComposerTag
} from '@myagentroam/protocol';
import type { NodeAgentSession } from '../database.js';
import { nodeLog } from '../operational.js';
import { runnerErrorProjection } from '../util/runner-error.js';
import {
  MarAgentError,
  openMarAgentSessionCatalog,
  type MarAgentHistoryEntry,
  type MarAgentSessionCatalog,
  type MarAgentSessionSummary
} from '@myagentroam/agent';
import type { NativeTranscriptImageAttachment } from '../native-transcript-model.js';
import type { NodeConversationTurn } from '../runtime-model.js';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  AbstractRunner,
  type ExternalResumeContext,
  type ExternalResumeResult,
  type NativeSessionRemovalResult,
  type RunnerDiscoveryContext,
  type RunnerSessionPresentation,
  type RunnerSessionPresentationContext
} from './abstract-runner.js';
import type { MarAgentGeneratedImageArtifact } from './mar-agent/conversation-normalizer.js';
import {
  marAgentGeneratedImageSources,
  marAgentGeneratedImagesDirectory
} from './mar-agent/generated-images.js';
import { projectMarAgentHistory } from './mar-agent/history-projection.js';
import { captureMarAgentExecutionInput } from './mar-agent/execution-input.js';

export class MarAgentRunner extends AbstractRunner<'mar-agent'> {
  readonly name = 'mar-agent' as const;
  override prepareMessageInput(input: string, collaborationMode: 'default' | 'plan'): string {
    const prepared = super.prepareMessageInput(input, collaborationMode);
    return parseComposerTags(prepared)
      .map((part) => {
        if (part.kind === 'text') return part.text;
        if (
          part.kind === 'mar_attachments' &&
          part.payload.files.some((file) => file.mime.startsWith('image/'))
        )
          return serializeComposerTag('mar_attachments', {
            ...part.payload,
            instruction: 'Images are included. Use view_image only to revisit them.'
          });
        return part.raw;
      })
      .join('');
  }
  override prepareExecutionContext(input: Readonly<Record<string, unknown>>) {
    return { runner: this.name, runnerInput: captureMarAgentExecutionInput(input) };
  }
  readonly discoveryScope = 'ALL_WORKSPACES' as const;
  #models: readonly MarAgentNodeModelSummary[] = [];
  #releaseSessionResources: ((sessionId: string) => Promise<void>) | undefined;
  #generatedImageRegistrar:
    | ((
        session: NodeAgentSession,
        images: readonly NativeTranscriptImageAttachment[]
      ) => readonly Record<string, unknown>[])
    | undefined;
  constructor(private readonly homeDirectory = homedir()) {
    super();
  }

  configureModels(value: unknown): void {
    this.#models = Array.isArray(value)
      ? value.flatMap((model) => {
          const parsed = marAgentNodeModelSummarySchema.safeParse(model);
          return parsed.success ? [parsed.data as MarAgentNodeModelSummary] : [];
        })
      : [];
  }
  setSessionResourceReleaser(release: (sessionId: string) => Promise<void>): void {
    this.#releaseSessionResources = release;
  }
  setGeneratedImageRegistrar(
    register: (
      session: NodeAgentSession,
      images: readonly NativeTranscriptImageAttachment[]
    ) => readonly Record<string, unknown>[]
  ): void {
    this.#generatedImageRegistrar = register;
  }
  registerGeneratedImages(
    session: NodeAgentSession,
    nativeSessionId: string,
    artifacts: readonly MarAgentGeneratedImageArtifact[]
  ): readonly Record<string, unknown>[] {
    if (
      session.runner !== this.name ||
      session.externalSessionId === null ||
      session.externalSessionId !== nativeSessionId
    )
      return [];
    const images = marAgentGeneratedImageSources(this.homeDirectory, nativeSessionId, artifacts);
    return images.length === 0 ? [] : (this.#generatedImageRegistrar?.(session, images) ?? []);
  }
  registerInputImages(
    session: NodeAgentSession,
    entry: Extract<MarAgentHistoryEntry, { readonly kind: 'user' }>
  ): readonly (Record<string, unknown> | undefined)[] {
    if (
      session.runner !== this.name ||
      session.externalSessionId === null ||
      session.externalSessionId !== entry.sessionId ||
      entry.images === undefined ||
      entry.images.length === 0
    )
      return [];
    const readableImages = entry.images.flatMap((image, imageIndex) =>
      image.readable
        ? [
            {
              image,
              imageIndex
            }
          ]
        : []
    );
    if (readableImages.length === 0) return [];
    const registeredImages =
      this.#generatedImageRegistrar?.(
        session,
        readableImages.map(({ image, imageIndex }) => ({
          name: image.name,
          mime: image.mimeType,
          byteSize: image.byteSize,
          sourceId: `${entry.sessionId}:${entry.sequence}:${imageIndex}`,
          read: () =>
            this.#readInputImage(entry.sessionId, entry.sequence, imageIndex, {
              name: image.name,
              mimeType: image.mimeType,
              byteSize: image.byteSize
            })
        }))
      ) ?? [];
    let registeredIndex = 0;
    return entry.images.map((image) =>
      image.readable ? registeredImages[registeredIndex++] : undefined
    );
  }
  async readToolResultResource(
    session: NodeAgentSession,
    input: import('@myagentroam/protocol').ToolResultResourceInput
  ) {
    if (!session.externalSessionId) throw new Error('SESSION_NOT_FOUND');
    const catalog = await openMarAgentSessionCatalog({ homeDirectory: this.homeDirectory });
    try {
      return await catalog.readToolResultResource(session.externalSessionId, {
        resourceRef: input.resourceRef,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes })
      });
    } finally {
      await catalog.close();
    }
  }

  profile(capabilities: NodeCapabilities): RunnerProfile | undefined {
    if (!this.available(capabilities)) return undefined;
    return this.profileForValidation();
  }
  available(capabilities: NodeCapabilities): boolean {
    return capabilities.marAgent?.available === true;
  }
  protected profileForValidation(): RunnerProfile {
    const models = this.#models.filter(
      (model) => model.enabled && model.conversationModel !== false
    );
    return {
      runner: 'mar-agent',
      models: models.map((model, index) => ({
        id: model.id,
        label: model.name,
        supportedEfforts: [...model.reasoningEfforts],
        defaultEffort: resolveMarAgentDefaultReasoningEffort(
          model.defaultReasoningEffort,
          model.reasoningEfforts
        ),
        ...(index === 0 ? { isDefault: true } : {})
      })),
      accessOptions: [
        {
          id: 'auto',
          label: 'Auto',
          description:
            'MAR Agent may stop before a tool call and request confirmation. Host validation remains active and no Agent sandbox is provided.'
        },
        {
          id: 'full-access',
          label: 'Full access',
          description:
            'Tools run without per-call Agent approval. Host validation remains active and no Agent sandbox is provided.'
        }
      ],
      commands: [
        {
          id: 'compact',
          runner: 'mar-agent' as const,
          label: '/compact',
          description: 'Compact the current session context.',
          inputHint: '/compact',
          source: 'MAR_RUNTIME' as const,
          interaction: 'IMMEDIATE_ACTION' as const,
          available: true,
          reasonCode: null
        },
        {
          id: 'plan',
          runner: 'mar-agent' as const,
          label: '/plan',
          description: 'Toggle collaborative Plan Mode.',
          inputHint: '/plan',
          source: 'MAR_RUNTIME' as const,
          interaction: 'TOGGLE' as const,
          available: true,
          reasonCode: null
        },
        {
          id: 'clear',
          runner: 'mar-agent' as const,
          label: '/clear',
          description: 'Permanently clear this session history while keeping the session.',
          inputHint: '/clear',
          source: 'MAR_RUNTIME' as const,
          interaction: 'DESTRUCTIVE_ACTION' as const,
          available: true,
          reasonCode: null
        },
        {
          id: 'goal',
          runner: 'mar-agent',
          label: '/goal',
          stateLabel: 'Goal',
          description: 'Enter persistent Goal mode.',
          inputHint: '/goal',
          source: 'MAR_RUNTIME',
          interaction: 'TOGGLE',
          available: true,
          reasonCode: null
        }
      ],
      capabilities: [
        'turn.start',
        'conversation',
        'user-input',
        'plan',
        'compact',
        'mcp',
        'subagent'
      ]
    };
  }
  override supportsConfiguration(configuration: RunnerDefaultConfiguration): boolean {
    if (configuration.runner !== this.name) return false;
    const profile = this.profileForValidation();
    const model = profile.models.find((candidate) => candidate.id === configuration.model);
    return (
      model !== undefined &&
      (model.supportedEfforts.length === 0
        ? configuration.effort === model.defaultEffort
        : model.supportedEfforts.includes(configuration.effort)) &&
      profile.accessOptions.some((candidate) => candidate.id === configuration.access)
    );
  }
  defaultConfiguration(): RunnerDefaultConfiguration {
    const profile = this.profileForValidation();
    const model = profile.models[0];
    return {
      runner: 'mar-agent',
      model: model?.id ?? '',
      effort: model?.defaultEffort ?? '',
      access: 'auto'
    };
  }
  override goalAccess(currentAccess: string | null) {
    return { access: currentAccess ?? 'full-access', accessChanged: false };
  }
  override restoreStoredAccess(access: string | null, _fallbackAccess: string): string {
    return access === 'auto' || access === 'full-access' ? access : 'full-access';
  }
  presentSession(
    session: NodeAgentSession,
    capabilities: NodeCapabilities,
    context: RunnerSessionPresentationContext
  ): RunnerSessionPresentation {
    void capabilities;
    const activity = context.managedActive ? 'MANAGED_ACTIVE' : 'IDLE';
    const runtimeCapabilities = [
      'history.read',
      'events.live',
      'turn.start',
      'turn.queue',
      'turn.interrupt',
      'run.cancel',
      'user-input.respond',
      'session.rename',
      'session.remove',
      'session.pin',
      ...(session.externalSessionId === null ? [] : ['session.rewind', 'session.rollback'])
    ];
    return {
      activity,
      control: {
        level: 'MANAGED',
        capabilities: ['history.read', 'events.live', 'turn.start', 'turn.interrupt']
      },
      runtime: {
        level: 'MANAGED',
        capabilities: runtimeCapabilities,
        reasonCode: null
      },
      commandStates: context.commandStates
    };
  }
  resumeExternal(
    external: NodeAgentSession,
    context: ExternalResumeContext
  ): Promise<ExternalResumeResult> {
    if (external.runner !== this.name || external.externalSessionId === null || !context.available)
      return Promise.resolve({ failureCode: 'RUNNER_UNAVAILABLE' });
    const current = context.currentResumed(external.id);
    if (current)
      return Promise.resolve({ session: context.ensureConfiguration(current), activity: 'IDLE' });
    const projection = context.projectionFor(external);
    const session = projection ? context.promote(projection.id) : context.create(external);
    if (!session) return Promise.resolve({ failureCode: 'RUNNER_RESUME_FAILED' });
    context.rememberManagedNative(external.externalSessionId, session.id);
    return Promise.resolve({ session: context.ensureConfiguration(session), activity: 'IDLE' });
  }
  async discoverSessions(
    context: RunnerDiscoveryContext,
    workspace?: import('../database.js').NodeWorkspace
  ): Promise<readonly NodeAgentSession[]> {
    let catalog: MarAgentSessionCatalog | undefined;
    try {
      catalog = await openMarAgentSessionCatalog({ homeDirectory: this.homeDirectory });
      const activeCatalog = catalog;
      const listed = await activeCatalog.list({ limit: 200 });
      if (context.cleanup) {
        const sessions = [...listed.sessions];
        let cursor = listed.nextCursor;
        while (cursor !== undefined) {
          const next = await activeCatalog.list({ limit: 200, cursor });
          sessions.push(...next.sessions);
          cursor = next.nextCursor;
        }
        const workspaces = workspace ? [workspace] : context.workspaces;
        return sessions.flatMap((session) => {
          const target = workspaces.find(
            (candidate) => resolve(candidate.path) === resolve(session.workspace)
          );
          return target
            ? [
                context.createProjection({
                  workspace: target,
                  runner: this.name,
                  externalSessionId: session.id,
                  cwd: session.workspace,
                  lastActivityAt: Date.parse(session.lastActivityAt)
                })
              ]
            : [];
        });
      }
      const workspaces = workspace ? [workspace] : context.workspaces;
      return (
        await Promise.all(
          listed.sessions.map(async (session) => {
            const target = workspaces.find(
              (candidate) => resolve(candidate.path) === resolve(session.workspace)
            );
            if (!target) return [];
            const executionConfiguration =
              session.modelId === undefined
                ? await activeCatalog.executionConfiguration(session.id)
                : session;
            const title = await marAgentSessionTitle(session, activeCatalog);
            return [
              {
                ...context.createProjection({
                  workspace: target,
                  runner: this.name,
                  externalSessionId: session.id,
                  cwd: session.workspace,
                  ...title,
                  lastActivityAt: Date.parse(session.lastActivityAt)
                }),
                ...(executionConfiguration?.modelId === undefined
                  ? {}
                  : { model: executionConfiguration.modelId }),
                ...(executionConfiguration?.reasoningEffort === undefined
                  ? {}
                  : { effort: executionConfiguration.reasoningEffort })
              }
            ];
          })
        )
      ).flat();
    } catch (error) {
      if (context.cleanup) throw error;
      return [];
    } finally {
      await catalog?.close().catch(() => undefined);
    }
  }
  override async forkNative(
    session: NodeAgentSession,
    boundary: string | null,
    title: string
  ): Promise<string> {
    if (session.externalSessionId === null) throw new Error('SESSION_REWIND_UNAVAILABLE');
    const catalog = await openMarAgentSessionCatalog({ homeDirectory: this.homeDirectory });
    try {
      return (await catalog.fork(session.externalSessionId, { boundaryTurnId: boundary, title }))
        .id;
    } catch (error) {
      if (error instanceof MarAgentError) throw new Error(error.code, { cause: error });
      throw error;
    } finally {
      await catalog.close().catch(() => undefined);
    }
  }
  override async rollbackNative(
    session: NodeAgentSession,
    boundary: string | null,
    targetTurnBoundary?: string,
    targetClientMessageId?: string
  ): Promise<number> {
    if (session.externalSessionId === null) throw new Error('SESSION_ROLLBACK_UNAVAILABLE');
    await this.#releaseSessionResources?.(session.externalSessionId);
    const catalog = await openMarAgentSessionCatalog({ homeDirectory: this.homeDirectory });
    try {
      if (targetClientMessageId !== undefined && targetTurnBoundary === undefined)
        throw new Error('SESSION_ROLLBACK_TARGET_INVALID');
      const rolledBack = await catalog.rollback(
        session.externalSessionId,
        targetClientMessageId === undefined
          ? { boundaryTurnId: boundary }
          : {
              beforeInput: { turnId: targetTurnBoundary!, clientMessageId: targetClientMessageId }
            }
      );
      return Date.parse(rolledBack.lastActivityAt);
    } catch (error) {
      if (error instanceof MarAgentError) throw new Error(error.code, { cause: error });
      throw error;
    } finally {
      await catalog.close().catch(() => undefined);
    }
  }
  override supportsRollback(session: NodeAgentSession): boolean {
    return session.externalSessionId !== null;
  }
  override async clearNative(session: NodeAgentSession): Promise<number> {
    if (session.externalSessionId === null) throw new Error('SESSION_CLEAR_UNAVAILABLE');
    await this.#releaseSessionResources?.(session.externalSessionId);
    const catalog = await openMarAgentSessionCatalog({ homeDirectory: this.homeDirectory });
    try {
      return Date.parse((await catalog.clear(session.externalSessionId)).lastActivityAt);
    } catch (error) {
      if (error instanceof MarAgentError) throw new Error(error.code, { cause: error });
      throw error;
    } finally {
      await catalog.close().catch(() => undefined);
    }
  }
  override async removeNative(
    session: NodeAgentSession,
    nativeSessionId: string
  ): Promise<NativeSessionRemovalResult> {
    if (session.runner !== this.name || session.externalSessionId !== nativeSessionId) return false;
    await this.#releaseSessionResources?.(nativeSessionId);
    const catalog = await openMarAgentSessionCatalog({ homeDirectory: this.homeDirectory });
    try {
      return (await catalog.delete(nativeSessionId)).deleted ? true : 'MISSING';
    } finally {
      await catalog.close().catch(() => undefined);
    }
  }
  override async readManagedRunnerTitle(
    session: NodeAgentSession,
    nativeSessionId: string
  ): Promise<string | undefined> {
    if (session.runner !== this.name || session.externalSessionId !== nativeSessionId)
      return undefined;
    const catalog = await openMarAgentSessionCatalog({ homeDirectory: this.homeDirectory });
    try {
      let cursor: string | undefined;
      do {
        const page = await catalog.list({ limit: 200, ...(cursor ? { cursor } : {}) });
        const summary = page.sessions.find((candidate) => candidate.id === nativeSessionId);
        if (summary !== undefined) return (await marAgentSessionTitle(summary, catalog)).title;
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return undefined;
    } finally {
      await catalog.close().catch(() => undefined);
    }
  }
  async restartInputState(
    sessionId: string,
    clientMessageId: string
  ): Promise<'missing' | 'completed' | 'interrupted' | 'paused'> {
    const catalog = await openMarAgentSessionCatalog({ homeDirectory: this.homeDirectory });
    try {
      let cursor: string | undefined;
      const states = new Map<string, 'completed' | 'interrupted' | 'paused'>();
      do {
        const page = await catalog.history(sessionId, {
          ...(cursor === undefined ? {} : { cursor }),
          limit: 1000
        });
        for (const entry of page.entries) {
          if (entry.kind !== 'event' || entry.event.turnId === undefined) continue;
          const event = entry.event;
          if (event.type === 'execution.completed')
            states.set(event.turnId!, event.permissionStop === undefined ? 'completed' : 'paused');
          else if (event.type === 'execution.failed') states.set(event.turnId!, 'completed');
          else if (event.type === 'execution.cancelled') states.set(event.turnId!, 'interrupted');
        }
        const user = page.entries.find(
          (entry) => entry.kind === 'user' && entry.clientMessageId === clientMessageId
        );
        if (user?.kind === 'user') return states.get(user.turnId) ?? 'interrupted';
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return 'missing';
    } finally {
      await catalog.close();
    }
  }

  override async readOfficialConversation(
    session: NodeAgentSession,
    input: { readonly cursor?: string; readonly limit?: number }
  ) {
    if (session.externalSessionId === null) return undefined;
    const catalog = await openMarAgentSessionCatalog({ homeDirectory: this.homeDirectory });
    try {
      const limit = input.limit ?? 10;
      let cursor = input.cursor;
      let nextCursor: string | undefined;
      const entryPages: MarAgentHistoryEntry[][] = [];
      const turnIds = new Set<string>();
      do {
        const page = await catalog.history(session.externalSessionId, {
          ...(cursor === undefined ? {} : { cursor }),
          limit: 1000
        });
        entryPages.push(page.entries);
        for (const entry of page.entries) {
          const turnId = entry.kind === 'user' ? entry.turnId : entry.event.turnId;
          if (turnId !== undefined) turnIds.add(turnId);
        }
        nextCursor = page.nextCursor;
        cursor = nextCursor;
      } while (turnIds.size <= limit && nextCursor !== undefined);
      const entries = entryPages.toReversed().flat();
      const turns = projectMarAgentHistory(session, entries, {
        registerInputImages: (entry) => this.registerInputImages(session, entry),
        registerGeneratedImages: (nativeSessionId, images) =>
          this.registerGeneratedImages(session, nativeSessionId, images)
      });
      if (turns.length > limit) {
        const selected = turns.slice(-limit);
        const firstSequence = firstSequenceForTurn(entries, selected[0]!.id);
        return {
          turns: selected,
          nextCursor: firstSequence === undefined ? (nextCursor ?? null) : String(firstSequence)
        };
      }
      return {
        turns,
        nextCursor: nextCursor ?? null
      };
    } catch {
      return undefined;
    } finally {
      await catalog.close().catch(() => undefined);
    }
  }
  override async readConversationHistory(readers: {
    readonly official: () => Promise<
      | { readonly turns: readonly NodeConversationTurn[]; readonly nextCursor: string | null }
      | undefined
    >;
  }) {
    const page = await readers.official();
    return page === undefined ? undefined : { ...page, source: 'official' as const };
  }
  override nativeImageRoots(session: NodeAgentSession): readonly string[] {
    const generatedImages =
      session.externalSessionId === null
        ? undefined
        : marAgentGeneratedImagesDirectory(this.homeDirectory, session.externalSessionId);
    return [resolve(session.cwd), ...(generatedImages === undefined ? [] : [generatedImages])];
  }
  async readContextUsage(session: NodeAgentSession) {
    if (session.externalSessionId === null || session.model === null) return undefined;
    const model = this.#models.find((candidate) => candidate.id === session.model);
    if (model === undefined) return undefined;
    let catalog: MarAgentSessionCatalog | undefined;
    try {
      catalog = await openMarAgentSessionCatalog({ homeDirectory: this.homeDirectory });
      const usage = await catalog.contextUsage(session.externalSessionId);
      return usage === undefined
        ? undefined
        : {
            model: model.modelId,
            usedTokens: usage.inputTokens,
            maxTokens: model.contextWindowTokens
          };
    } catch {
      return undefined;
    } finally {
      await catalog?.close().catch(() => undefined);
    }
  }
  stop(): void {}

  async #readInputImage(
    sessionId: string,
    sequence: number,
    imageIndex: number,
    expected: { readonly name: string; readonly mimeType: string; readonly byteSize: number }
  ) {
    let catalog: MarAgentSessionCatalog | undefined;
    try {
      catalog = await openMarAgentSessionCatalog({ homeDirectory: this.homeDirectory });
      const image = await catalog.readImage(sessionId, { sequence, imageIndex });
      if (
        image === undefined ||
        image.name !== expected.name ||
        image.mimeType !== expected.mimeType ||
        image.byteSize !== expected.byteSize
      )
        return undefined;
      return {
        name: image.name,
        mime: image.mimeType,
        dataBase64: image.dataBase64
      };
    } catch {
      return undefined;
    } finally {
      await catalog?.close().catch(() => undefined);
    }
  }
}

async function marAgentSessionTitle(
  session: MarAgentSessionSummary,
  catalog: MarAgentSessionCatalog
): Promise<{ title: string; titleOrigin: 'NATIVE' | 'PREVIEW' }> {
  const nativeTitle = session.title.trim();
  if (nativeTitle.length === 0 || /^(?:new|untitled) session$/iu.test(nativeTitle)) {
    try {
      const preview =
        session.firstUserMessagePreview ?? (await catalog.firstUserMessagePreview(session.id));
      if (preview) return { title: preview, titleOrigin: 'PREVIEW' };
    } catch (error) {
      nodeLog('runner.mar-agent.title.failed', {
        sessionId: session.id,
        stage: 'preview',
        code: runnerErrorProjection(error, 'MAR_AGENT_TITLE_PREVIEW_FAILED').code
      });
    }
  }
  return { title: session.title, titleOrigin: 'NATIVE' };
}

function firstSequenceForTurn(
  entries: readonly MarAgentHistoryEntry[],
  turnId: string
): number | undefined {
  return entries.find((entry) =>
    entry.kind === 'user' ? entry.turnId === turnId : entry.event.turnId === turnId
  )?.sequence;
}
