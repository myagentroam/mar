import { createHash } from 'node:crypto';
import {
  LocalAgentHost,
  MarAgentError,
  createMarAgent,
  generateSessionTitle,
  openMarAgentSessionCatalog,
  type CreateMarAgentOptions,
  type LocalProcessExecutor,
  type MarAgent,
  type MarAgentEvent,
  type MarAgentHistoryEntry,
  type MarAgentHost,
  type MarAgentSessionCatalog,
  type ToolExecutionResult,
  type WorkspacePathMount
} from '@myagentroam/agent';
import type { NodeAgentSession } from '../../database.js';
import type { NativeTranscriptImageAttachment } from '../../native-transcript-model.js';
import { projectMarAgentHistory } from './history-projection.js';
import type {
  HostedConversationRuntime,
  HostedConversationRuntimeEvent,
  HostedConversationRuntimeHandle,
  HostedConversationRuntimeHistoryInput,
  HostedConversationRuntimeHistoryPage,
  HostedConversationRuntimeRollbackInput,
  HostedConversationRuntimeRunInput,
  HostedConversationRuntimeSessionInput
} from '../../service/hosted-conversation-node-service.js';
import {
  MarAgentConversationNormalizer,
  type MarAgentGeneratedImageArtifact,
  type MarAgentNormalizedItem
} from './conversation-normalizer.js';
import {
  hostedConversationGeneratedImagesDisplayDirectory,
  hostedConversationImageRunId,
  marAgentGeneratedImageSources,
  marAgentGeneratedImagesDirectory
} from './generated-images.js';
import { MarAgentMcpClientPool } from './mcp-client-pool.js';
import {
  MarAgentRuntimeModelFactory,
  sdkModelConfigurations,
  closeImageCredentialProviders,
  type MarAgentRuntimeModel
} from './runtime-model-factory.js';
import { createImageGenerationExtensions } from './image-generation-extensions.js';
import { createWebToolsExtensions } from './web-tools-extensions.js';
import { combineExecutionExtensions } from './execution-extensions.js';
import {
  compactRuntimeConfigurations,
  marAgentCompactExtensionSource,
  updateMarAgentCompactState,
  type MarAgentCompactState
} from './compact-extensions.js';
import type { WebFetchHandler } from '../../service/web-fetch-contracts.js';

export interface HostedLocalAgentHostInput {
  readonly publishModelResource?: MarAgentHost['publishModelResource'];
  readonly modelUsage?: import('@myagentroam/agent').ModelUsageObserver;
  readonly mode: 'node';
  readonly homeDirectory: string;
  readonly workspace: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly guaranteedCommands: Readonly<Record<string, string>>;
  readonly processExecutor: LocalProcessExecutor;
  readonly restrictPaths: true;
  readonly workspaceWritable: false;
  readonly pathMounts: readonly WorkspacePathMount[];
  readonly modelFactory?: Pick<MarAgentRuntimeModelFactory, 'create'>;
  readonly mcpTools?: readonly import('@myagentroam/agent').ClientToolDefinition[];
  readonly callMcp?: (
    call: { name: string; arguments: unknown },
    signal: AbortSignal
  ) => Promise<ToolExecutionResult>;
  readonly extensions?: import('@myagentroam/agent').LocalAgentExecutionExtensions;
}

interface MarAgentHostedConversationRuntimeOptions {
  readonly publishModelResource?: (
    image: Parameters<NonNullable<MarAgentHost['publishModelResource']>>[0],
    context: Parameters<NonNullable<MarAgentHost['publishModelResource']>>[1] & {
      conversationId: string;
    }
  ) => ReturnType<NonNullable<MarAgentHost['publishModelResource']>>;
  readonly createAgent?: typeof createMarAgent;
  readonly generateTitle?: typeof generateSessionTitle;
  readonly createHost?: (input: HostedLocalAgentHostInput) => MarAgentHost;
  readonly openCatalog?: typeof openMarAgentSessionCatalog;
  readonly now?: () => number;
  readonly onEvent?: (conversationId: string, event: MarAgentEvent) => Promise<void> | void;
  readonly webSearch?: (
    input: { query: string; maxResults: number },
    signal: AbortSignal
  ) => Promise<ToolExecutionResult>;
  readonly webFetch?: WebFetchHandler;
  readonly modelFactory?: Pick<MarAgentRuntimeModelFactory, 'create'>;
  readonly registerNativeImages?: (
    runId: string,
    roots: readonly string[],
    images: readonly NativeTranscriptImageAttachment[]
  ) => readonly Record<string, unknown>[];
}

interface ActiveExecution {
  readonly handle: HostedConversationRuntimeHandle;
  readonly completion: Promise<unknown>;
  readonly cancelTitle: () => void;
}

/**
 * Opens one short-lived MAR Agent Host per hosted Run so template mounts cannot leak across Run
 * boundaries. Conversation-scoped tmp and Session history may remain available to later Runs.
 */
export class MarAgentHostedConversationRuntime implements HostedConversationRuntime {
  readonly #createAgent: typeof createMarAgent;
  readonly #generateTitle: typeof generateSessionTitle;
  readonly #createHost: (input: HostedLocalAgentHostInput) => MarAgentHost;
  readonly #publishModelResource: MarAgentHostedConversationRuntimeOptions['publishModelResource'];
  readonly #openCatalog: typeof openMarAgentSessionCatalog;
  readonly #now: () => number;
  readonly #onEvent:
    ((conversationId: string, event: MarAgentEvent) => Promise<void> | void) | undefined;
  readonly #webSearch:
    | ((
        input: { query: string; maxResults: number },
        signal: AbortSignal
      ) => Promise<ToolExecutionResult>)
    | undefined;
  readonly #webFetch: WebFetchHandler | undefined;
  readonly #active = new Map<string, ActiveExecution>();
  readonly #modelFactory: Pick<MarAgentRuntimeModelFactory, 'create'>;
  readonly #registerNativeImages:
    | ((
        runId: string,
        roots: readonly string[],
        images: readonly NativeTranscriptImageAttachment[]
      ) => readonly Record<string, unknown>[])
    | undefined;

  constructor(options: MarAgentHostedConversationRuntimeOptions = {}) {
    this.#publishModelResource = options.publishModelResource;
    this.#createAgent = options.createAgent ?? createMarAgent;
    this.#generateTitle = options.generateTitle ?? generateSessionTitle;
    this.#createHost = options.createHost ?? ((input) => new LocalAgentHost(input));
    this.#openCatalog = options.openCatalog ?? openMarAgentSessionCatalog;
    this.#now = options.now ?? Date.now;
    this.#onEvent = options.onEvent;
    this.#webSearch = options.webSearch;
    this.#webFetch = options.webFetch;
    this.#registerNativeImages = options.registerNativeImages;
    this.#modelFactory =
      options.modelFactory ??
      new MarAgentRuntimeModelFactory({
        resolve: async () => {
          throw new Error('MAR_AGENT_RUNTIME_CREDENTIALS_UNSUPPORTED');
        }
      });
  }

  async createSession(
    input: HostedConversationRuntimeSessionInput
  ): Promise<{ readonly sessionId: string }> {
    const { agent, mcp, closeImages } = await this.#createRuntime(input);
    try {
      const session = await agent.createSession({
        workspace: '/workspace'
      });
      return { sessionId: session.id };
    } finally {
      await agent.dispose().catch(() => undefined);
      await closeImages();
      await mcp?.close().catch(() => undefined);
    }
  }

  async readToolResultResource(
    input: {
      homeDirectory: string;
      sessionId: string;
    } & import('@myagentroam/protocol').ToolResultResourceInput
  ) {
    const catalog = await this.#openCatalog({ homeDirectory: input.homeDirectory });
    try {
      return await catalog.readToolResultResource(input.sessionId, {
        resourceRef: input.resourceRef,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes })
      });
    } finally {
      await catalog.close();
    }
  }

  async history(
    input: HostedConversationRuntimeHistoryInput
  ): Promise<HostedConversationRuntimeHistoryPage> {
    const catalog = await this.#openCatalog({ homeDirectory: input.homeDirectory });
    try {
      const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);
      let cursor =
        input.cursor === undefined
          ? undefined
          : decodeHostedHistoryCursor(input.cursor, input.sessionId);
      let entries: MarAgentHistoryEntry[] = [];
      let turns = projectMarAgentHistory(historySession(input), entries);
      do {
        const page = await catalog.history(input.sessionId, {
          limit: Math.min(1000, Math.max(100, limit * 20)),
          ...(cursor === undefined ? {} : { cursor })
        });
        entries = [...page.entries, ...entries];
        cursor = page.nextCursor;
        turns = projectMarAgentHistory(historySession(input), entries);
      } while (cursor !== undefined && turns.length <= limit);
      const selected = turns.slice(-limit);
      const earliestTurnId = selected[0]?.id;
      const earliestSequence =
        earliestTurnId === undefined
          ? undefined
          : entries.find((entry) => historyEntryTurnId(entry) === earliestTurnId)?.sequence;
      const projected = projectMarAgentHistory(historySession(input), entries, {
        registerInputImages: (entry) => this.#registerInputImages(input, entry),
        registerGeneratedImages: (sessionId, images) =>
          this.#registerGeneratedImages(input, sessionId, images)
      }).slice(-limit);
      return {
        turns: projected,
        nextCursor:
          turns.length > selected.length && earliestSequence !== undefined
            ? encodeHostedHistoryCursor(input.sessionId, earliestSequence)
            : null
      };
    } finally {
      await catalog.close();
    }
  }

  async rollback(
    input: HostedConversationRuntimeRollbackInput
  ): Promise<{ readonly lastActivityAt: number }> {
    await this.releaseSession(input);
    const catalog = await this.#openCatalog({ homeDirectory: input.homeDirectory });
    try {
      const rolledBack = await catalog.rollback(
        input.sessionId,
        input.beforeInput === undefined
          ? { boundaryTurnId: input.boundaryTurnId }
          : { beforeInput: input.beforeInput }
      );
      return { lastActivityAt: Date.parse(rolledBack.lastActivityAt) };
    } catch (error) {
      if (error instanceof MarAgentError) throw new Error(error.code, { cause: error });
      throw error;
    } finally {
      await catalog.close().catch(() => undefined);
    }
  }

  async startRun(
    input: HostedConversationRuntimeRunInput
  ): Promise<HostedConversationRuntimeHandle> {
    if (this.#active.has(input.sessionId)) throw new Error('HOSTED_CONVERSATION_RUN_ACTIVE');
    const { agent, mcp, closeImages, models } = await this.#createRuntime(input);
    const titleController = new AbortController();
    let titleTask: Promise<string | undefined> | undefined;
    const metadata = await agent.getSession(input.sessionId).catch(() => undefined);
    let execution: ReturnType<Awaited<ReturnType<MarAgent['openSession']>>['run']>;
    let session: Awaited<ReturnType<MarAgent['openSession']>>;
    try {
      session = await agent.openSession(input.sessionId);
      execution = session.run({
        prompt: input.prompt,
        clientMessageId: input.clientMessageId,
        modelId: input.modelId,
        permissionMode: 'full-access',
        images: []
      });
    } catch (error) {
      await agent.dispose().catch(() => undefined);
      await closeImages();
      await mcp?.close().catch(() => undefined);
      throw error;
    }
    const startedAt = this.#now();
    let settled = false;
    const normalizer = new MarAgentConversationNormalizer();
    const completion = (async () => {
      try {
        for await (const event of execution) {
          if (event.type === 'execution.started' && metadata?.automaticTitlePending && !titleTask)
            titleTask = this.#generateTitle({
              models: sdkModelConfigurations(
                models.filter((model) =>
                  input.models.some((candidate) => candidate.id === model.id)
                )
              ),
              currentModelId: input.modelId,
              prompt: input.userPrompt,
              ...(input.onModelUsage === undefined
                ? {}
                : {
                    onModelUsage: (usage: import('@myagentroam/agent').ModelRequestUsage) =>
                      input.onModelUsage!({
                        ...usage,
                        sessionId: input.sessionId,
                        executionId: execution.executionId,
                        purpose: 'title',
                        agentRole: 'root'
                      })
                  }),
              signal: titleController.signal
            }).catch(() => undefined);
          await this.#onEvent?.(input.conversationId, event);
          for (const projected of projectHostedEvent(
            normalizer,
            event,
            {
              clientMessageId: input.clientMessageId,
              prompt: input.userPrompt
            },
            (sessionId, images) => this.#registerGeneratedImages(input, sessionId, images)
          ))
            await input.onEvent?.(projected);
        }
        const result = await execution.result();
        const generatedTitle = await titleTask;
        if (generatedTitle && !titleController.signal.aborted)
          await agent
            .setSessionTitle(input.sessionId, generatedTitle, {
              automatic: true,
              expectedTitle: metadata!.title,
              executionId: execution.executionId
            })
            .catch(() => undefined);
        const title = await this.#readGeneratedTitle(input.homeDirectory, input.sessionId).catch(
          () => undefined
        );
        return {
          status:
            result.status === 'completed'
              ? ('SUCCEEDED' as const)
              : result.status === 'cancelled'
                ? ('INTERRUPTED' as const)
                : ('FAILED' as const),
          completedAt: this.#now(),
          ...(title === undefined ? {} : { title })
        };
      } catch {
        const title = await this.#readGeneratedTitle(input.homeDirectory, input.sessionId).catch(
          () => undefined
        );
        return {
          status: 'FAILED' as const,
          completedAt: this.#now(),
          ...(title === undefined ? {} : { title })
        };
      } finally {
        titleController.abort();
        await titleTask;
        settled = true;
        this.#active.delete(input.sessionId);
        await agent.dispose().catch(() => undefined);
        await closeImages();
        await mcp?.close().catch(() => undefined);
      }
    })();
    const handle: HostedConversationRuntimeHandle = {
      run: {
        id: execution.executionId,
        status: 'RUNNING',
        startedAt,
        completedAt: null
      },
      completion,
      steer: (request) => {
        if (
          settled ||
          this.#active.get(input.sessionId)?.handle !== handle ||
          (request.modelId !== undefined && request.modelId !== input.modelId) ||
          (request.runtimeScopeId !== undefined && request.runtimeScopeId !== input.runtimeScopeId)
        )
          return Promise.resolve({ status: 'notAccepted' });
        return session.steer({
          expectedExecutionId: execution.executionId,
          prompt: request.prompt,
          modelText: request.modelText,
          clientMessageId: request.clientMessageId
        });
      },
      cancel: () => {
        if (settled || this.#active.get(input.sessionId)?.handle !== handle) return false;
        execution.cancel();
        return true;
      }
    };
    this.#active.set(input.sessionId, {
      handle,
      completion,
      cancelTitle: () => titleController.abort()
    });
    return handle;
  }

  async releaseSession(input: HostedConversationRuntimeHistoryInput): Promise<void> {
    const active = this.#active.get(input.sessionId);
    if (active === undefined) return;
    active.cancelTitle();
    active.handle.cancel();
    await active.completion.catch(() => undefined);
  }

  async dispose(): Promise<void> {
    const active = [...this.#active.values()];
    for (const execution of active) {
      execution.cancelTitle();
      execution.handle.cancel();
    }
    await Promise.allSettled(active.map((execution) => execution.completion));
  }

  async #readGeneratedTitle(homeDirectory: string, sessionId: string): Promise<string | undefined> {
    const catalog = await this.#openCatalog({ homeDirectory });
    try {
      let cursor: string | undefined;
      do {
        const page = await catalog.list({
          limit: 200,
          ...(cursor === undefined ? {} : { cursor })
        });
        const session = page.sessions.find((candidate) => candidate.id === sessionId);
        if (session !== undefined) {
          const title = session.title.trim().replace(/\s+/g, ' ').slice(0, 160);
          return title.length === 0 || title.toLocaleLowerCase() === 'new session'
            ? undefined
            : title;
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return undefined;
    } finally {
      await catalog.close();
    }
  }

  async #createRuntime(
    input: HostedConversationRuntimeSessionInput | HostedConversationRuntimeRunInput
  ): Promise<{
    readonly agent: MarAgent;
    readonly mcp?: MarAgentMcpClientPool;
    readonly closeImages: () => Promise<void>;
    readonly models: readonly MarAgentRuntimeModel[];
  }> {
    const generatedImageDisplayDirectory =
      'sessionId' in input
        ? hostedConversationGeneratedImagesDisplayDirectory(input.sessionId)
        : undefined;
    const mcp =
      'mcpServers' in input && input.mcpServers.length > 0
        ? await MarAgentMcpClientPool.connect(input.mcpServers, input.workspaceDirectory, {
            authorizationScope: JSON.stringify([input.homeDirectory, input.sessionId]),
            processExecutor: input.processExecutor,
            owner: {
              sessionId: input.sessionId,
              executionId: input.clientMessageId
            }
          })
        : undefined;
    let host: MarAgentHost;
    let models: MarAgentRuntimeModel[] = [];
    const compact = 'compact' in input ? input.compact : undefined;
    const compactState: MarAgentCompactState = { revision: 0 };
    const closeImages = () => closeImageCredentialProviders(models);
    try {
      models = this.#modelFactory.create(compactRuntimeConfigurations(input.models, compact), {
        ...(input.runtimeScopeId === undefined ? {} : { runtimeScopeId: input.runtimeScopeId }),
        executionId: 'clientMessageId' in input ? input.clientMessageId : input.conversationId
      });
      updateMarAgentCompactState(
        compactState,
        compact,
        models,
        input.models.map((model) => model.id)
      );
      const selectedModelId = 'defaultModelId' in input ? input.defaultModelId : input.modelId;
      const imageExtensions = createImageGenerationExtensions({
        configuration: models.find((model) => model.id === selectedModelId)?.imageGeneration,
        homeDirectory: input.homeDirectory,
        ...(generatedImageDisplayDirectory === undefined
          ? {}
          : { displayDirectory: generatedImageDisplayDirectory }),
        host: () => host
      });
      const webAccess = 'webAccess' in input && input.webAccess;
      const extensions = combineExecutionExtensions(
        imageExtensions,
        createWebToolsExtensions({
          enabled: webAccess,
          hostedSearchModelIds: models
            .filter((model) => model.hostedWebSearch)
            .map((model) => model.id),
          hostedWebSearch:
            models.find((model) => model.id === selectedModelId)?.hostedWebSearch ?? false,
          ...(this.#webSearch === undefined ? {} : { webSearch: this.#webSearch }),
          ...(this.#webFetch === undefined ? {} : { webFetch: this.#webFetch })
        })
      );
      host = this.#createHost({
        ...(this.#publishModelResource === undefined
          ? {}
          : {
              publishModelResource: (image, context) =>
                this.#publishModelResource!(image, {
                  ...context,
                  conversationId: input.conversationId
                })
            }),
        ...('onModelUsage' in input && input.onModelUsage !== undefined
          ? { modelUsage: input.onModelUsage }
          : {}),
        extensions,
        mode: 'node',
        homeDirectory: input.homeDirectory,
        workspace: input.workspaceDirectory,
        environment: hostedEnvironment(),
        guaranteedCommands: {},
        processExecutor: input.processExecutor,
        restrictPaths: true,
        workspaceWritable: false,
        pathMounts: hostedPathMounts(input),
        ...(mcp === undefined
          ? {}
          : {
              mcpCatalog: () => mcp.catalog(),
              callMcp: (
                call: { name: string; arguments: unknown },
                signal: AbortSignal,
                context?: import('@myagentroam/agent').McpToolCallContext
              ) => mcp.call(call.name, call.arguments, signal, context?.expectedTool)
            })
      });
    } catch (error) {
      await closeImages();
      await Promise.allSettled(
        models.flatMap((model) =>
          model.credentialProvider ? [model.credentialProvider.close()] : []
        )
      );
      await mcp?.close().catch(() => undefined);
      throw error;
    }
    try {
      const options: CreateMarAgentOptions = {
        mode: 'node',
        host,
        models: sdkModelConfigurations(
          models.filter((model) => input.models.some((candidate) => candidate.id === model.id))
        ),
        runtimeExtensions: marAgentCompactExtensionSource(compactState),
        defaultModelId: 'defaultModelId' in input ? input.defaultModelId : input.modelId,
        workspaceMapping: {
          logicalPath: '/workspace',
          physicalPath: input.workspaceDirectory
        },
        systemInstruction: input.systemInstruction
      };
      return {
        agent: await this.#createAgent(options),
        models,
        closeImages,
        ...(mcp === undefined ? {} : { mcp })
      };
    } catch (error) {
      await host.dispose().catch(() => undefined);
      await closeImages();
      await Promise.allSettled(
        models.flatMap((model) =>
          model.credentialProvider ? [model.credentialProvider.close()] : []
        )
      );
      await mcp?.close().catch(() => undefined);
      throw error;
    }
  }

  #registerGeneratedImages(
    input: Pick<
      HostedConversationRuntimeHistoryInput | HostedConversationRuntimeRunInput,
      'conversationId' | 'sessionId' | 'homeDirectory'
    >,
    eventSessionId: string,
    artifacts: readonly MarAgentGeneratedImageArtifact[]
  ): readonly Record<string, unknown>[] {
    if (eventSessionId !== input.sessionId) return [];
    const root = marAgentGeneratedImagesDirectory(input.homeDirectory, input.sessionId);
    if (root === undefined) return [];
    const images = marAgentGeneratedImageSources(input.homeDirectory, input.sessionId, artifacts);
    return images.length === 0
      ? []
      : (this.#registerNativeImages?.(
          hostedConversationImageRunId(input.conversationId),
          [root],
          images
        ) ?? []);
  }

  #registerInputImages(
    input: Pick<
      HostedConversationRuntimeHistoryInput,
      'conversationId' | 'sessionId' | 'homeDirectory'
    >,
    entry: Extract<MarAgentHistoryEntry, { readonly kind: 'user' }>
  ): readonly (Record<string, unknown> | undefined)[] {
    if (
      entry.sessionId !== input.sessionId ||
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
      this.#registerNativeImages?.(
        hostedConversationImageRunId(input.conversationId),
        [],
        readableImages.map(({ image, imageIndex }) => ({
          name: image.name,
          mime: image.mimeType,
          byteSize: image.byteSize,
          sourceId: `${entry.sessionId}:${entry.sequence}:${imageIndex}`,
          read: () =>
            this.#readInputImage(input.homeDirectory, entry.sessionId, entry.sequence, imageIndex, {
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

  async #readInputImage(
    homeDirectory: string,
    sessionId: string,
    sequence: number,
    imageIndex: number,
    expected: { readonly name: string; readonly mimeType: string; readonly byteSize: number }
  ) {
    let catalog: MarAgentSessionCatalog | undefined;
    try {
      catalog = await this.#openCatalog({ homeDirectory });
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

function historySession(input: HostedConversationRuntimeHistoryInput): NodeAgentSession {
  return {
    id: input.sessionId,
    model: input.modelId ?? null,
    effort: null,
    access: 'full-access'
  } as NodeAgentSession;
}

function historyEntryTurnId(entry: MarAgentHistoryEntry): string | undefined {
  return entry.kind === 'user' ? entry.turnId : entry.event.turnId;
}

function encodeHostedHistoryCursor(sessionId: string, beforeSequence: number): string {
  return Buffer.from(JSON.stringify({ version: 1, sessionId, beforeSequence }), 'utf8').toString(
    'base64url'
  );
}

function decodeHostedHistoryCursor(cursor: string, sessionId: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      readonly version?: unknown;
      readonly sessionId?: unknown;
      readonly beforeSequence?: unknown;
    };
    if (
      parsed.version !== 1 ||
      parsed.sessionId !== sessionId ||
      !Number.isSafeInteger(parsed.beforeSequence) ||
      (parsed.beforeSequence as number) <= 0
    )
      throw new Error('HOSTED_CONVERSATION_HISTORY_CURSOR_INVALID');
    return String(parsed.beforeSequence);
  } catch (error) {
    if (error instanceof Error && error.message === 'HOSTED_CONVERSATION_HISTORY_CURSOR_INVALID')
      throw error;
    throw new Error('HOSTED_CONVERSATION_HISTORY_CURSOR_INVALID', { cause: error });
  }
}

function projectHostedEvent(
  normalizer: MarAgentConversationNormalizer,
  event: MarAgentEvent,
  userMessage: {
    readonly clientMessageId: string;
    readonly prompt: string;
  },
  registerGeneratedImages?: (
    sessionId: string,
    images: readonly MarAgentGeneratedImageArtifact[]
  ) => readonly Record<string, unknown>[]
): readonly HostedConversationRuntimeEvent[] {
  const createdAt = Date.parse(event.timestamp);
  const base = {
    executionId: event.executionId,
    ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
    sequence: event.sequence,
    createdAt: Number.isFinite(createdAt) ? createdAt : 0
  };
  if (event.type === 'execution.started')
    return [
      { ...base, kind: 'RUN', payload: { status: 'RUNNING' } },
      ...(event.turnId === undefined
        ? []
        : [
            {
              ...base,
              kind: 'ITEM' as const,
              payload: {
                item: {
                  itemId: `${event.turnId}:user`,
                  kind: 'user_message',
                  status: 'COMPLETED',
                  payload: {
                    clientMessageId: userMessage.clientMessageId,
                    text: userMessage.prompt,
                    contexts: [],
                    delivery: 'ACCEPTED'
                  }
                }
              }
            }
          ])
    ];
  if (event.type === 'execution.completed')
    return [{ ...base, kind: 'RUN', payload: { status: 'SUCCEEDED' } }];
  if (event.type === 'execution.cancelled')
    return [{ ...base, kind: 'RUN', payload: { status: 'INTERRUPTED' } }];
  const runEvent =
    event.type === 'execution.failed'
      ? [{ ...base, kind: 'RUN' as const, payload: { status: 'FAILED' } }]
      : [];
  if (event.type === 'message.delta')
    return [
      ...runEvent,
      {
        ...base,
        kind: 'DELTA',
        payload: {
          itemId: normalizer.messageItemId(event.itemId),
          text: event.delta,
          phase: event.phase
        }
      }
    ];
  return [
    ...runEvent,
    ...normalizer.normalize(event).map((item) => ({
      ...base,
      kind: 'ITEM' as const,
      payload: {
        item: hostedConversationItem(item, event.sessionId, registerGeneratedImages)
      }
    }))
  ];
}

function hostedConversationItem(
  item: MarAgentNormalizedItem,
  sessionId: string,
  registerGeneratedImages:
    | ((
        sessionId: string,
        images: readonly MarAgentGeneratedImageArtifact[]
      ) => readonly Record<string, unknown>[])
    | undefined
): MarAgentNormalizedItem {
  const { generatedImages, ...publicItem } = item;
  const attachments =
    generatedImages === undefined
      ? []
      : (registerGeneratedImages?.(sessionId, generatedImages) ?? []);
  if (attachments.length === 0) return publicItem;
  return { ...publicItem, payload: { ...publicItem.payload, attachments } };
}

function hostedPathMounts(
  input: HostedConversationRuntimeSessionInput | HostedConversationRuntimeRunInput
): readonly WorkspacePathMount[] {
  if (!('sessionId' in input)) return input.pathMounts;
  const generatedImages = marAgentGeneratedImagesDirectory(input.homeDirectory, input.sessionId);
  const logicalPath = hostedConversationGeneratedImagesDisplayDirectory(input.sessionId);
  if (generatedImages === undefined || logicalPath === undefined) return input.pathMounts;
  if (input.pathMounts.some((mount) => mount.logicalPath === logicalPath)) return input.pathMounts;
  return [
    ...input.pathMounts,
    {
      logicalPath,
      physicalPath: generatedImages,
      writable: false
    }
  ];
}

function hostedEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    SHELL: '/bin/bash',
    MAR_AGENT_HOSTED_ENVIRONMENT: createHash('sha256')
      .update('myagentroam-hosted-environment-v1')
      .digest('hex')
  };
}
