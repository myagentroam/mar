import { readResourceImages, restoreMessages } from '../runtime/context/restore.js';
import type { SessionStore } from '../session/store/contracts.js';
import { createNativeSteer } from './native-steer.js';
import { latestModelUsage, reasoningEffortBaseline } from '../runtime/context/usage.js';
import { splitContextualPrompt } from '../runtime/context/contextual-blocks.js';
import type { ContextualWorldState } from '../runtime/context/world-state.js';
import {
  contextualInstructionInsertIndex,
  latestContextualWorldStateGeneration,
  parsePersistedContextualWorldState,
  persistContextualWorldState,
  resetContextualWorldState,
  updateContextualWorldState,
  updatePromptWorldState
} from '../runtime/context/world-state.js';
import { eventForPersistence, publicModelUsage } from '../runtime/event-projection.js';
import { ExecutionLoop, type PreparedExecutionRound } from '../runtime/execution.js';
import type { ModelImage } from '../model/image.js';
import { publishModelResources } from '../runtime/resource-publication.js';
import { ResourceInputProjection } from './resource-input.js';
import {
  closeModelAdapters,
  createExecutionModelResources,
  createModelTurnSession
} from './model-runtime.js';
import {
  prepareSessionModelRequest,
  projectSessionRequestMessages
} from './request-preparation.js';
import { createSubagentBackend } from './subagent-backend.js';
import {
  ExecutionToolPermissions,
  projectPermissionTool,
  resolvePermissionMode,
  withToolPermissions
} from '../tools/permissions.js';
import type { RoundToolScope } from '../tools/execution.js';
import { createToolWaitInterrupt } from '../tools/wait.js';
import { discoveredMcpToolNames, rebindMcpToolSearchOutputs } from '../tools/mcp/history.js';
import { currentExecutionImages } from '../tools/output-projection.js';
import type { ResolvedModelConfiguration } from './model-runtime.js';

import { createHash, randomUUID } from 'node:crypto';
import { ExecutionToolSources } from './extension-tools.js';
import type { ExtensionManager } from '../extensions/manager.js';
import type { CoreOperationContext } from '../extensions/operation.js';
import {
  compactExtensionMessages,
  compactExtensionResult,
  compactExtensionDiagnostic,
  type CoreCompactDiagnostic,
  type CoreCompactResult
} from '../extensions/compaction.js';
import { ExtensionRequestBridge, ExtensionRequestSnapshots } from '../extensions/model-request.js';
import {
  normalizeSessionMessagesInput,
  sessionMessagesPage
} from '../extensions/session-messages.js';
import { transformCoreModelStream } from '../extensions/model-stream.js';
import type { ModelEvent } from '../model/contracts.js';
import {
  SessionInputCoordinator,
  recordSessionInputCommit,
  type CoreSessionBackend,
  type SessionInputEntry,
  type CoreSessionRequest,
  type CoreAppendInput,
  type CoreSessionActionResult,
  type CoreInputSource
} from '../extensions/session-input.js';
import { createExtensionSessionBackend } from './extension-session.js';
import { invokeCorePromptSubmission, type CorePromptInput } from '../extensions/prompt-input.js';
import { createExtensionAgentsBackend } from './extension-agents.js';
import type { CoreAgentsBackend } from '../extensions/agents.js';
import { coreMcpCatalog } from '../extensions/mcp.js';
import { isDeepStrictEqual } from 'node:util';
import { MarAgentError, describeMarAgentError } from '../error.js';
import type { HostDescription, MarAgentHost } from '../host/contracts.js';
import type { MarAgentReasoningEffort } from '../model/configuration.js';
import { prepareModelConfiguration } from '../model/request-configuration.js';
import type {
  ClientToolDefinition,
  ModelAdapter,
  ModelAttemptDiagnostic,
  ModelMessage,
  ModelRequest,
  ModelUsage
} from '../model/contracts.js';
import type { EnvironmentContextState } from '../prompts/core.js';
import { autoPermissionPrompt } from '../prompts/permissions.js';
import { MAR_AGENT_PROMPT_VERSION, buildSystemPromptSections } from '../prompts/index.js';
import { renderPromptSections } from '../extensions/prompt-composition.js';
import {
  retainedSessionResourcesSnapshot,
  type RetainedSessionResources
} from '../prompts/resources.js';
import { childSubagentInstruction } from '../prompts/subagent.js';
import { renderSubagentUpdate } from '../subagent/model-update.js';
import { AsyncQueue } from '../runtime/async-queue.js';
import { CompactionOperation } from '../runtime/compaction/operation.js';
import { generateCompactionCandidate } from '../runtime/compaction/generate.js';
import { CompactCoordinator, type CompactFlight } from '../runtime/compaction/coordinator.js';
import { CompactRequests } from '../runtime/compaction/requests.js';
import { compactSnapshotAnchor } from '../runtime/compaction/retained-context.js';
import {
  DEFAULT_COMPACTION_FOCUS,
  buildCompactedHistory,
  buildCompactionMessages,
  compactedHistoryMessages
} from '../runtime/compaction/history.js';
import {
  currentLocalTimeContext,
  environmentContextUpdate,
  restoreEnvironmentState
} from '../runtime/context/environment.js';
import { ContextGcRuntime, type ContextGcCommitResult } from '../runtime/context/gc-runtime.js';
import { AGENT_EXECUTION_POLICY } from '../runtime/execution-policy.js';
import { loadAgentInstructions, renderAgentInstructions } from '../runtime/context/instructions.js';
import { normalizeMessagesForModel } from '../runtime/context/normalize.js';
import {
  latestSmartContextTokens,
  requestSmartCompaction,
  type SmartCompactionInput
} from '../runtime/compaction/smart.js';
import {
  compactSummaryFromCheckpoint,
  inputMetadataFromRecord
} from '../session/store/execution-state.js';
import type { CompactUserInput } from '../session/store/contracts.js';
import {
  SubagentSessionController,
  type SubagentMailboxMessage,
  type SubagentMessageDelivery,
  type SubagentTurnHandle
} from '../subagent/session-controller.js';
import { agentStartToolDefinitionWithModels } from '../tools/agent/agent-start.js';
import { allowsDirectTool, allowsToolCaller, toolCallers } from '../tools/callers.js';
import { assertMcpToolCatalog } from '../tools/mcp/catalog.js';
import { BUILTIN_TOOL_DEFINITIONS } from '../tools/registry.js';
import type { ToolRuntimeContext, ToolRuntimeImage } from '../tools/runtime-context.js';
import { createSessionToolScheduler } from '../tools/scheduler.js';
import { TodoStore } from '../tools/agent/todo.js';
import { DeferredMcpRegistry } from '../tools/mcp/tool-search.js';
import type {
  CreateMarAgentOptions,
  ExecutionHandle,
  ExecutionMode,
  ExecutionResult,
  MarAgentEvent,
  MarAgentSession,
  RunInput
} from './types.js';

type EventPayload<T = MarAgentEvent> = T extends MarAgentEvent
  ? Omit<T, 'eventId' | 'sequence' | 'timestamp' | 'sessionId' | 'executionId' | 'turnId'>
  : never;
type ModelAttemptPurpose = 'EXECUTION' | 'COMPACTION' | 'TITLE' | 'SUBAGENT';
interface ExhaustedModelAttemptSummary {
  readonly attempts: number;
  readonly retries: number;
}
interface SessionExecutionContext {
  readonly executionId: string;
  readonly modelId: string;
  readonly mode: ExecutionMode;
  readonly models: ReadonlyMap<string, ResolvedModelConfiguration>;
  readonly instruction: string | undefined;
  steer?: (input: import('./types.js').SteerInput) => Promise<import('./types.js').SteerResult>;
  compactRequests?: CompactRequests;
  requestMessages?: { read(): readonly ModelMessage[] };
  appendedMessages?: {
    append(recordId: string, message: ModelMessage): void;
  };
  toolSources?: ExecutionToolSources;
}
export interface SessionRuntime {
  execution?: SessionExecutionContext;
  todo?: TodoStore;
  readonly scheduleTool: ReturnType<typeof createSessionToolScheduler>;
  readonly sourceType: 'user' | 'subagent';
  adapterGeneration: number;
  adapters: Map<string, ModelAdapter>;
  contextualWorldState?: ContextualWorldState;
  subagents?: SubagentSessionController;
  subagentsOpening?: Promise<SubagentSessionController>;
  inputs?: SessionInputCoordinator;
  requestSnapshots?: ExtensionRequestSnapshots;
  recordProjection?: Promise<unknown>;
  sessionBackend?: CoreSessionBackend & { kick(): void };
  agentsBackend?: CoreAgentsBackend;
}
interface InternalExecutionOptions {
  readonly publishHostEvents?: boolean;
  readonly signal?: AbortSignal;
  readonly inputSource?: 'parent_agent' | 'extension';
  readonly extensionSource?: CoreInputSource;
  readonly automaticInput?: boolean;
  readonly inputCommitted?: (recordId: string) => void;
  readonly promptAdmitted?: boolean;
  readonly modelText?: string;
  readonly inputContext?: readonly string[];
  readonly modelContext?: readonly string[];
  readonly initialMailbox?: readonly SubagentMailboxMessage[];
  readonly turnId?: string;
  readonly delivery?: SubagentMessageDelivery;
  readonly mcpExecutionScopeId?: string;
}
interface InternalExecutionHandle extends ExecutionHandle {
  readonly persistedEvents: boolean;
  readonly turnId: string;
  enqueueMessage(message: string, delivery?: SubagentMessageDelivery): boolean;
}
interface InternalMarAgentSession extends MarAgentSession {
  startSubagentTurn(input: {
    readonly permissionMode?: import('../tools/permissions.js').PermissionMode;
    readonly prompt: string;
    readonly modelId: string;
    readonly reasoningEffort: MarAgentReasoningEffort;
    readonly role: 'general-purpose' | 'explore';
    readonly initialMailbox: readonly SubagentMailboxMessage[];
    readonly turnId: string;
    readonly delivery?: SubagentMessageDelivery;
    readonly mcpExecutionScopeId?: string;
    readonly origin?: CoreOperationContext;
  }): SubagentTurnHandle;
}

/** Agent-owned registries shared with Session orchestration, not public execution state. */
export interface AgentSessionRegistry {
  readonly active: Map<string, AbortController>;
  readonly activeExecutionAdapters: Set<ModelAdapter>;
  readonly executionResults: Map<string, Promise<ExecutionResult>>;
  readonly sessionRuntimes: Map<string, SessionRuntime>;
  readonly sessionWriterOwner: object;
}

interface SessionServices {
  readonly host: MarAgentHost;
  readonly description: HostDescription;
  readonly settings: Pick<CreateMarAgentOptions, 'workspaceMapping' | 'systemInstruction'>;
  readonly store: SessionStore;
  readonly extensions: ExtensionManager;
  readonly registry: AgentSessionRegistry;
  readonly hasCustomAdapters: boolean;
  readonly modelState: () => {
    readonly models: ReadonlyMap<string, ResolvedModelConfiguration>;
    readonly defaultModelId: string;
    readonly generation: number;
  };
  readonly createAdapter: (
    modelId: string,
    models: ReadonlyMap<string, ResolvedModelConfiguration>
  ) => ModelAdapter;
  readonly activeAdaptersExcept: (sessionId: string) => ReadonlySet<ModelAdapter>;
  readonly assertCanStart: (sessionId?: string) => void;
  readonly assertSessionAdmission: (sessionId?: string) => void;
}

/** SDK Session orchestration owns warm resources; Runtime owns only the model/tool loop. */
export function createSessionOpener(services: SessionServices) {
  const { host, description, settings, store, createAdapter, activeAdaptersExcept } = services;
  const { active, activeExecutionAdapters, executionResults, sessionRuntimes, sessionWriterOwner } =
    services.registry;
  const openSession = async (
    sessionId: string,
    workspace?: string
  ): Promise<InternalMarAgentSession> => {
    services.assertSessionAdmission();
    const storedSession = await store.getSession(sessionId);
    services.assertSessionAdmission();
    const storedWorkspace = storedSession.workspace;
    const sessionSource = storedSession.source;
    const logicalWorkspace =
      settings.workspaceMapping?.logicalPath ?? workspace ?? storedWorkspace ?? '';
    const instructionWorkspace =
      settings.workspaceMapping?.physicalPath ?? workspace ?? storedWorkspace ?? '';
    const currentEnvironment: EnvironmentContextState = {
      platform: description.platform,
      ...(description.architecture ? { architecture: description.architecture } : {}),
      ...(description.shell ? { shell: description.shell } : {}),
      ...(description.guaranteedCommands
        ? { guaranteedCommands: description.guaranteedCommands }
        : {}),
      workspace: logicalWorkspace
    };
    if (!restoreEnvironmentState({ version: 1, state: currentEnvironment }))
      throw new MarAgentError(
        'MAR_AGENT_HOST_INCOMPATIBLE',
        'Host environment facts are invalid or exceed the context limit.'
      );
    let sessionRuntime = sessionRuntimes.get(sessionId);
    if (sessionRuntime === undefined) {
      sessionRuntime = {
        sourceType: sessionSource.type,
        scheduleTool: createSessionToolScheduler(),
        adapterGeneration: services.modelState().generation,
        adapters: new Map()
      };
      sessionRuntimes.set(sessionId, sessionRuntime);
    }
    if (sessionSource.type === 'user' && sessionRuntime.subagents === undefined) {
      sessionRuntime.subagentsOpening ??= SubagentSessionController.open({
        parentSessionId: sessionId,
        rootSessionId: sessionId,
        backend: createSubagentBackend(store, storedWorkspace)
      });
      try {
        sessionRuntime.subagents = await sessionRuntime.subagentsOpening;
      } finally {
        delete sessionRuntime.subagentsOpening;
      }
    }
    const buildSessionPromptSections = (
      availableTools: readonly ClientToolDefinition[],
      promptMode: ExecutionMode,
      selectedModel: ResolvedModelConfiguration,
      executionSystemInstruction: string | undefined,
      skillCatalog: string | undefined
    ) =>
      buildSystemPromptSections({
        mode: promptMode,
        platform: description.platform,
        ...(description.architecture ? { architecture: description.architecture } : {}),
        ...(description.shell ? { shell: description.shell } : {}),
        ...(description.guaranteedCommands
          ? { guaranteedCommands: description.guaranteedCommands }
          : {}),
        workspace: logicalWorkspace,
        tools: availableTools
          .filter((tool) => !tool.name.startsWith('mcp__'))
          .map((tool) => tool.name),
        directTools: availableTools
          .filter(
            (tool) =>
              !tool.name.startsWith('mcp__') &&
              allowsDirectTool(
                tool,
                availableTools.some((candidate) => candidate.name === 'code_exec')
              )
          )
          .map((tool) => tool.name),
        extension: executionSystemInstruction
      }).concat([
        { id: 'core:skill-catalog', text: skillCatalog || null },
        {
          id: 'core:child-instructions',
          text: sessionSource.type === 'subagent' ? childSubagentInstruction || null : null
        }
      ]);
    const sessionAdapter = (
      modelId: string,
      configuredModels: ReadonlyMap<string, ResolvedModelConfiguration>
    ): ModelAdapter => {
      let selected = sessionRuntime.adapters.get(modelId);
      if (selected === undefined) {
        selected = createAdapter(modelId, configuredModels);
        if (!services.hasCustomAdapters || selected.createTurnSession !== undefined)
          sessionRuntime.adapters.set(modelId, selected);
      }
      return selected;
    };
    const refreshSessionAdapters = async (generation: number): Promise<void> => {
      if (sessionRuntime.adapterGeneration === generation) return;
      const retainedByActiveSessions = activeAdaptersExcept(sessionId);
      await closeModelAdapters(
        [...sessionRuntime.adapters.values()].filter(
          (adapter) => !retainedByActiveSessions.has(adapter)
        )
      );
      sessionRuntime.adapters.clear();
      sessionRuntime.adapterGeneration = generation;
    };
    const sessionInputs = () =>
      (sessionRuntime.inputs ??= new SessionInputCoordinator((receipt) =>
        services.extensions.session(sessionId)?.diagnose({
          code: receipt.errorCode ?? 'MAR_AGENT_SESSION_INPUT_FAILED',
          operationId: receipt.operationId,
          sessionId
        })
      ));
    // Only physical record commits and projection replacement enter this lane, never Hooks.
    const withRecordProjection = async <T>(action: () => Promise<T>): Promise<T> => {
      const pending = (sessionRuntime.recordProjection ?? Promise.resolve())
        .catch(() => undefined)
        .then(action);
      sessionRuntime.recordProjection = pending;
      try {
        return await pending;
      } finally {
        if (sessionRuntime.recordProjection === pending) delete sessionRuntime.recordProjection;
      }
    };
    const appendExtensionMessage = async (
      entry: SessionInputEntry,
      request: Extract<CoreSessionRequest, { kind: 'append' }>,
      call: CoreOperationContext
    ): Promise<CoreSessionActionResult> => {
      call.signal.throwIfAborted();
      const release = await store.acquireSessionWriteLease(sessionId, sessionWriterOwner);
      try {
        return await withRecordProjection(async () => {
          call.signal.throwIfAborted();
          const message = projectAppendedModelMessage(request.input);
          const record = await store.append(
            sessionId,
            {
              type: message ? 'model.context' : 'session.notice',
              payload: {
                ...(message ?? {
                  content: request.input.content,
                  textBlocks: request.input.textBlocks
                }),
                source: extensionInputSource(call, request.input.attribution)
              },
              ...(call.executionId ? { executionId: call.executionId } : {}),
              ...(call.turnId ? { turnId: call.turnId } : {})
            },
            { signal: call.signal }
          );
          const result = {
            changed: true,
            modelChanged: !!message,
            recordId: record.recordId,
            ...(call.executionId ? { executionId: call.executionId } : {})
          };
          recordSessionInputCommit(entry, result);
          if (message) sessionRuntime.execution?.appendedMessages?.append(record.recordId, message);
          return result;
        });
      } finally {
        await release();
      }
    };
    const execution = (
      mode: ExecutionMode,
      input: RunInput,
      internal: InternalExecutionOptions = {}
    ): InternalExecutionHandle => {
      services.assertCanStart(sessionId);
      if ([...active.keys()].some((key) => key.startsWith(`${sessionId}:`)))
        throw new MarAgentError(
          'MAR_AGENT_EXECUTION_ACTIVE',
          'Session already has an active execution.'
        );
      const {
        models: executionModels,
        defaultModelId: executionDefaultModelId,
        generation: executionModelGeneration
      } = services.modelState();
      if (
        mode !== 'compact' &&
        executionModels.get(input.modelId ?? executionDefaultModelId)?.conversationModel === false
      )
        throw new MarAgentError(
          'MAR_AGENT_MODEL_DISABLED',
          'The selected model is not a conversation model.'
        );
      const executionId = randomUUID(),
        turnId = internal.turnId ?? randomUUID(),
        queue = new AsyncQueue<MarAgentEvent>(),
        controller = new AbortController();
      const compactCoordinator = new CompactCoordinator();
      const messageSources = new WeakMap<
        ModelMessage,
        import('../session/store/index.js').SessionRecord
      >();
      let liveModelMessages: readonly ModelMessage[] = [];
      const compactRequests = new CompactRequests(executionId, () =>
        compactCoordinator.assertNotReentrant()
      );
      const permissionPolicy = new ExecutionToolPermissions(
        mode === 'compact' ? 'full-access' : resolvePermissionMode(input.permissionMode),
        { sessionId, executionId },
        host.requestToolApproval
          ? {
              request: (request, signal) => host.requestToolApproval!(request, signal),
              signal: controller.signal
            }
          : undefined
      );
      const projectTools = (tools: readonly ClientToolDefinition[]) =>
        permissionPolicy.mode === 'auto' ? tools.map(projectPermissionTool) : tools;
      const abortSource = () => controller.abort(internal.signal?.reason);
      internal.signal?.addEventListener('abort', abortSource, { once: true });
      if (internal.signal?.aborted) abortSource();
      let executionEnvironment: EnvironmentContextState = {
        ...currentEnvironment,
        ...currentLocalTimeContext()
      };
      const executionSystemInstruction = settings.systemInstruction;
      const executionContext: SessionExecutionContext = {
        executionId,
        modelId: input.modelId ?? executionDefaultModelId,
        mode: mode === 'compact' ? 'run' : mode,
        models: executionModels,
        instruction: executionSystemInstruction,
        compactRequests
      };
      sessionRuntime.execution = executionContext;
      const manualCompactionId = mode === 'compact' ? randomUUID() : undefined;
      active.set(`${sessionId}:${executionId}`, controller);
      const inputs = sessionInputs();
      const acceptParent = (message: SubagentMailboxMessage) => {
        const origin = message.delivery?.origin;
        const signal = AbortSignal.any([
          controller.signal,
          ...(message.delivery?.signal === undefined ? [] : [message.delivery.signal])
        ]);
        if (signal.aborted) {
          message.delivery?.settled?.('cancelled');
          return;
        }
        const accept = (call: CoreOperationContext) => {
          const entry = inputs.accept(
            { kind: 'submit', input: { text: message.text } },
            call,
            (request, call, leaf) => leaf(request, call),
            'accepted',
            message
          );
          void entry.terminal.then(() => {
            if (entry.receipt.status === 'cancelled' || entry.receipt.status === 'failed')
              message.delivery?.settled?.(entry.receipt.status);
          });
        };
        if (origin) {
          accept(
            Object.freeze({
              ...origin,
              sessionId,
              sessionEpoch: services.extensions.session(sessionId)?.epoch ?? 0,
              signal,
              executionId,
              turnId
            })
          );
          return;
        }
        services.extensions.operations.enter(
          {
            sessionId,
            sessionEpoch: services.extensions.session(sessionId)?.epoch ?? 0,
            actor: 'sdk',
            entry: 'native-api',
            signal,
            executionId,
            turnId
          },
          accept
        );
      };
      for (const message of internal.initialMailbox ?? []) acceptParent(message);
      let acceptsMailbox = sessionSource.type === 'subagent' && mode !== 'compact';
      let acceptsSteer = false;
      let sequence = 0;
      let emitTail = Promise.resolve();
      let releaseSession: (() => Promise<void>) | undefined;
      let failedExecution = false;
      let exhaustedModelAttempt: ExhaustedModelAttemptSummary | undefined;
      // Serialize durable events before either the local stream or Host observes them.
      let persistedTerminal = false;
      const emit = (event: EventPayload, assertLive?: () => void) => {
        assertLive?.();
        const full = {
          ...event,
          eventId: randomUUID(),
          sequence: ++sequence,
          timestamp: new Date().toISOString(),
          sessionId,
          executionId,
          turnId
        } as MarAgentEvent;
        const operation = emitTail.then(async () => {
          assertLive?.();
          const persistent = eventForPersistence(full);
          let committedTerminal = false;
          if (persistent !== undefined && releaseSession !== undefined) {
            const stored = await store.append(sessionId, {
              type: full.type,
              payload: persistent,
              executionId,
              turnId
            });
            if (
              full.type === 'execution.completed' ||
              full.type === 'execution.failed' ||
              full.type === 'execution.cancelled'
            )
              committedTerminal = persistedTerminal = true;
            if (full.type === 'message.completed') {
              const message = liveModelMessages.findLast(
                (item) => item.role === 'assistant' && item.content === full.text
              );
              if (message) messageSources.set(message, stored);
            }
          }
          queue.push(full);
          compactRequests.publish(full);
          if (internal.publishHostEvents !== false) {
            try {
              await host.emit(full);
            } catch (error) {
              if (!committedTerminal) throw error;
              // Host observation cannot rewrite a terminal already committed to the Store.
              try {
                // Host errors may contain private data; publish only SDK-owned facts.
                process.emitWarning(
                  new MarAgentError(
                    'MAR_AGENT_HOST_EVENT_PUBLICATION_FAILED',
                    `Host publication of ${full.type} failed for Execution ${executionId}.`,
                    {
                      details: {
                        sessionId,
                        executionId,
                        eventId: full.eventId,
                        eventType: full.type
                      }
                    }
                  )
                );
              } catch {
                // A diagnostic sink must not change the committed outcome either.
              }
            }
          }
        });
        emitTail = operation.catch(() => undefined);
        return operation;
      };
      const recordModelAttempt =
        (purpose: ModelAttemptPurpose) => (diagnostic: ModelAttemptDiagnostic) => {
          if (purpose === 'EXECUTION' || purpose === 'COMPACTION') {
            if (
              (diagnostic.state === 'STARTED' && diagnostic.attempt === 1) ||
              diagnostic.state === 'SUCCEEDED'
            )
              exhaustedModelAttempt = undefined;
            else if (
              diagnostic.state === 'FAILED' &&
              diagnostic.willRetry === false &&
              diagnostic.attempt > 1
            )
              exhaustedModelAttempt = {
                attempts: diagnostic.attempt,
                retries: diagnostic.attempt - 1
              };
          }
          const operation = emitTail.then(async () => {
            await store.append(sessionId, {
              type: 'model.attempt',
              payload: { purpose, ...diagnostic },
              executionId,
              turnId
            });
          });
          emitTail = operation.catch(() => undefined);
          return operation;
        };
      const createCompactionOperation = (
        compactionId: string,
        signal: AbortSignal = controller.signal
      ) =>
        new CompactionOperation(signal, (progress) => {
          const operation = emitTail.then(async () => {
            await store.append(sessionId, {
              type: 'compact.progress',
              payload: { compactionId, ...progress },
              executionId,
              turnId
            });
          });
          emitTail = operation.catch(() => undefined);
          return operation;
        });
      const result = withToolPermissions(permissionPolicy, async (): Promise<ExecutionResult> => {
        let finalAnswer = '';
        let executionLoop: ExecutionLoop | undefined;
        let executionToolSources: ExecutionToolSources | undefined;
        const contextGc = new ContextGcRuntime();
        let selectedAdapter: ModelAdapter | undefined;
        const modelResources = createExecutionModelResources(activeExecutionAdapters);
        const subagents = sessionSource.type === 'user' ? sessionRuntime.subagents : undefined;
        try {
          controller.signal.throwIfAborted();
          releaseSession = await store.acquireSessionLease(sessionId, sessionWriterOwner);
          if (!inputs.executing) await inputs.idle();
          let immediateTarget: ModelMessage[] | undefined;
          const pendingAppends: {
            readonly recordId: string;
            readonly message: ModelMessage;
          }[] = [];
          executionContext.appendedMessages = {
            append(recordId, message) {
              pendingAppends.push({
                recordId,
                message
              });
              if (immediateTarget) immediateTarget.push(message);
            }
          };
          await refreshSessionAdapters(executionModelGeneration);
          const sessionState = await store.readExecutionState(sessionId);

          if (!store.hasRetainedSessionLease(sessionId, sessionWriterOwner))
            sessionRuntime.todo = TodoStore.restore(sessionState.todo);
          const todo = (sessionRuntime.todo ??= TodoStore.restore(sessionState.todo));
          const contextRecords = sessionState.contextRecords;
          const contextualWorldStateGeneration =
            latestContextualWorldStateGeneration(contextRecords);
          const restoredContextualWorldState = sessionRuntime.contextualWorldState;
          const persistedContextualWorldState = parsePersistedContextualWorldState(
            await store.readContextualWorldState(sessionId)
          );
          const initialContextualWorldState: ContextualWorldState =
            restoredContextualWorldState !== undefined &&
            restoredContextualWorldState.generation === contextualWorldStateGeneration
              ? restoredContextualWorldState
              : persistedContextualWorldState !== undefined &&
                  persistedContextualWorldState.generation === contextualWorldStateGeneration
                ? persistedContextualWorldState
                : {
                    generation: contextualWorldStateGeneration,
                    initialized: false,
                    instructionSnapshot: undefined,
                    resourceSnapshot: undefined,
                    entries: []
                  };
          sessionRuntime.contextualWorldState = initialContextualWorldState;
          const compactMayContainAgentInstructions = contextRecords.some(
            (record) => compactSummaryFromCheckpoint(record) !== undefined
          );
          const restored = await restoreMessages(store, sessionId, contextRecords, {
            messageSources,
            includeImages: mode !== 'compact'
          });
          // This execution owns checkpoint adoption, not another copy of the live context.
          const modelContext = (() => {
            const messages = restored.messages;
            let userMessages = [...restored.userMessages];
            let recordedEnvironment = restored.environmentState;
            let instructionInsertIndex = 0;
            let worldState = initialContextualWorldState;
            const commitWorldState = async (next: ContextualWorldState) => {
              await persistContextualWorldState(store, sessionId, next);
              worldState = next;
              sessionRuntime.contextualWorldState = next;
            };
            const resetCompactWorldState = async (
              generation: string,
              committed?: { readonly resources: string | undefined }
            ) => {
              instructionInsertIndex = contextualInstructionInsertIndex(messages);
              const next = resetContextualWorldState(generation, instructionInsertIndex, {
                instructionSnapshot: currentInstructionSnapshot,
                instructionContent: renderAgentInstructions(instructionEntries, true),
                resourceSnapshot: committed
                  ? committed.resources
                  : retainedSessionResourcesSnapshot(await loadRetainedSessionResources())
              });
              if (!committed) await commitWorldState(next);
              else {
                // The checkpoint is authoritative; its sidecar is recoverable on restart.
                worldState = next;
                sessionRuntime.contextualWorldState = next;
                try {
                  await persistContextualWorldState(store, sessionId, next);
                } catch {
                  coreExtensions.diagnose({
                    code: 'MAR_AGENT_COMPACT_SIDECAR_PERSIST_FAILED',
                    sessionId
                  });
                }
              }
            };
            const recordEnvironment = async () => {
              const message = environmentContextUpdate(executionEnvironment, recordedEnvironment);
              if (!message) return;
              await store.append(sessionId, {
                type: 'context.environment',
                payload: { version: 1, state: executionEnvironment },
                executionId,
                turnId
              });
              messages.push(message);
              recordedEnvironment = executionEnvironment;
            };
            const syncMcpWorldState = async (index = instructionInsertIndex) => {
              const snapshot = mcpRegistry.navigation();
              if (worldState.mcpSnapshot === snapshot) return;
              const next: ContextualWorldState = {
                ...worldState,
                mcpSnapshot: snapshot,
                entries: [
                  ...worldState.entries,
                  {
                    index,
                    kind: 'mcp',
                    content: snapshot ?? '<mcp_catalog>No deferred MCP tools remain.</mcp_catalog>'
                  }
                ]
              };
              await commitWorldState(next);
            };
            return {
              messages,
              get worldState(): ContextualWorldState {
                return worldState;
              },
              commitWorldState,
              recordEnvironment,
              syncMcpWorldState,
              rememberInput(input: CompactUserInput) {
                userMessages.push(input);
              },
              compactInputs(prefix: readonly ModelMessage[]) {
                return userMessages.filter((entry) =>
                  prefix.some(
                    (message) =>
                      message.role === 'user' &&
                      message.contextKind === undefined &&
                      (entry.metadata?.recordId
                        ? message.metadata?.recordId === entry.metadata.recordId
                        : message.content === entry.content)
                  )
                );
              },
              async initializeWorldState() {
                instructionInsertIndex =
                  mode === 'compact' ? contextualInstructionInsertIndex(messages) : messages.length;
                // Only the latest Compact may rebuild missing sidecar resources, never a GC boundary.
                if (
                  !worldState.initialized &&
                  contextRecords.some(
                    (record) =>
                      record.recordId === contextualWorldStateGeneration &&
                      compactSummaryFromCheckpoint(record) !== undefined
                  )
                )
                  await resetCompactWorldState(contextualWorldStateGeneration!);
                const nextInstructionWorldState = updateContextualWorldState(
                  worldState,
                  instructionInsertIndex,
                  {
                    instructionSnapshot: currentInstructionSnapshot,
                    instructionContent: renderAgentInstructions(
                      instructionEntries,
                      compactMayContainAgentInstructions ||
                        worldState.instructionSnapshot !== undefined
                    )
                  }
                );
                if (!isDeepStrictEqual(worldState, nextInstructionWorldState))
                  await commitWorldState(nextInstructionWorldState);
              },
              // Must run inside the existing writer/projection commit window.
              replaceCompactMessages(
                replacementHistory: ReturnType<typeof buildCompactedHistory>,
                retainedModelContext: readonly ModelMessage[]
              ) {
                messages.splice(
                  0,
                  messages.length,
                  environmentContextUpdate(executionEnvironment)!,
                  ...compactedHistoryMessages(replacementHistory),
                  ...retainedModelContext
                );
                pendingAppends.length = 0;
                selected.resetContinuation?.();
              },
              // Derived state follows the committed splice, never delays it past the writer window.
              async adoptCompactCheckpoint(
                recordId: string,
                replacementHistory: ReturnType<typeof buildCompactedHistory>,
                retainedModelContext: readonly ModelMessage[],
                resources: string | undefined
              ) {
                contextGc.reset();
                restoreMcpDiscovery();
                recordedEnvironment = executionEnvironment;
                userMessages = replacementHistory
                  .filter((message) => message.kind !== 'summary')
                  .map((message) => ({
                    content: message.content,
                    ...(message.metadata ? { metadata: { ...message.metadata } } : {})
                  }));
                userMessages.push(
                  ...retainedModelContext
                    .filter(
                      (message) => message.role === 'user' && message.contextKind === undefined
                    )
                    .map((message) => ({
                      content: message.content,
                      ...(message.metadata ? { metadata: message.metadata } : {})
                    }))
                );
                await resetCompactWorldState(recordId, { resources });
              },
              async adoptGcCheckpoint(committed: ContextGcCommitResult, appendBoundary: number) {
                smartContextTokens = undefined;
                selected.resetContinuation?.();
                const refreshed = await restoreMessages(store, sessionId, committed.records, {
                  includeImages: true,
                  currentTurnId: turnId,
                  messageSources,
                  projection: committed.projection
                });
                const restoredIds = new Set(committed.records.map((record) => record.recordId));
                const lateMessages = pendingAppends
                  .slice(appendBoundary)
                  .filter((entry) => !restoredIds.has(entry.recordId))
                  .map((entry) => entry.message);
                messages.splice(0, messages.length, ...refreshed.messages, ...lateMessages);
                restoreMcpDiscovery();
                recordedEnvironment = refreshed.environmentState;
                userMessages = [...refreshed.userMessages];
                instructionInsertIndex = contextualInstructionInsertIndex(messages);
                const next = resetContextualWorldState(
                  latestContextualWorldStateGeneration(committed.records),
                  instructionInsertIndex,
                  {
                    instructionSnapshot: currentInstructionSnapshot,
                    instructionContent: renderAgentInstructions(
                      instructionEntries,
                      committed.records.some(
                        (record) => compactSummaryFromCheckpoint(record) !== undefined
                      )
                    )
                  }
                );
                await commitWorldState(next);
              }
            };
          })();
          const messages = modelContext.messages;
          const pendingInputs = restored.pendingInputs;
          const waitInterrupt = createToolWaitInterrupt(() => pendingInputs.size > 0);
          liveModelMessages = messages;
          const restoredRecordIds = new Set(contextRecords.map((record) => record.recordId));
          for (const pending of pendingAppends)
            if (!restoredRecordIds.has(pending.recordId)) messages.push(pending.message);
          pendingAppends.length = 0;
          immediateTarget = messages;
          let smartInput: SmartCompactionInput | undefined;
          let compactContext!: (input?: {
            readonly focus?: string;
            readonly async?: boolean;
          }) => Promise<boolean>;
          let startCompact!: (input?: {
            readonly focus?: string;
            readonly async?: boolean;
          }) => CompactFlight;
          const writeInputRecord = async (
            content: CorePromptInput,
            type: 'turn.user' | 'extension.input',
            metadata: {
              readonly source?: CoreInputSource;
              readonly inputSource?: 'parent_agent' | 'extension';
              readonly messageId?: string;
              readonly clientMessageId?: string;
            },
            call: CoreOperationContext,
            committed: (
              actual: CorePromptInput,
              recordId: string,
              metadata: NonNullable<ModelMessage['metadata']>
            ) => void
          ) => {
            call.signal.throwIfAborted();
            if (content.images?.length && !selectedModel.inputCapabilities.includes('IMAGE'))
              throw new MarAgentError(
                'MAR_AGENT_INPUT_CAPABILITY_UNSUPPORTED',
                'Selected model does not support image input.'
              );
            await withRecordProjection(async () => {
              call.signal.throwIfAborted();
              const smartPercent =
                smartContextTokens === undefined
                  ? undefined
                  : (smartContextTokens * 100) / selectedModel.contextWindowTokens;
              const smartCompaction =
                mode !== 'compact' &&
                sessionSource.type === 'user' &&
                type === 'turn.user' &&
                metadata.inputSource === undefined &&
                smartPercent !== undefined &&
                smartPercent >= AGENT_EXECUTION_POLICY.smartCompactionPercent &&
                smartPercent < AGENT_EXECUTION_POLICY.automaticCompactionPercent;
              const modelImages = await publishModelResources(
                host,
                content.images,
                {
                  sessionId,
                  executionId
                },
                store
              );
              const actualContent =
                modelImages === content.images
                  ? content
                  : {
                      ...content,
                      ...(modelImages === undefined ? {} : { images: modelImages })
                    };
              const images = modelImages?.length
                ? await store.persistInputImages(sessionId, modelImages)
                : [];
              const record = await store.append(
                sessionId,
                {
                  type,
                  payload: {
                    ...metadata,
                    prompt: content.text,
                    ...(smartCompaction ? { smartCompaction: true } : {}),
                    ...(content.modelText === undefined ? {} : { modelText: content.modelText }),
                    ...(content.context === undefined ? {} : { context: content.context }),
                    ...(content.modelContext === undefined
                      ? {}
                      : { modelContext: content.modelContext }),
                    ...(images.length ? { images } : {})
                  },
                  executionId,
                  turnId
                },
                { signal: call.signal }
              );
              const inputMetadata = inputMetadataFromRecord(record);
              smartInput = {
                recordId: record.recordId,
                eligible: smartCompaction,
                requested: false
              };
              modelContext.rememberInput({
                content: content.modelText ?? content.text,
                metadata: inputMetadata
              });
              committed(actualContent, record.recordId, inputMetadata);
              for (const text of content.modelContext ?? content.context ?? [])
                messages.push({ role: 'user', content: text, contextKind: 'contextual' });
            });
          };
          const appendMailboxMessages = async (restoring = false): Promise<boolean> =>
            inputs.drain(
              async (entry, request, call) => {
                call.signal.throwIfAborted();
                if (request.kind === 'compact') {
                  if (request.input.async) {
                    const flight = startCompact(request.input);
                    entry.start();
                    return { changed: await flight.result, executionId };
                  }
                  return { changed: await compactContext(request.input), executionId };
                }
                if (request.kind === 'append') {
                  const result = await appendExtensionMessage(entry, request, call);
                  return { ...result, executionId };
                }
                if (entry.nativeSteer?.recordId) {
                  const received = pendingInputs.get(entry.nativeSteer.recordId);
                  if (!received) return { changed: false, modelChanged: false };
                  return withRecordProjection(async () => {
                    call.signal.throwIfAborted();
                    const payload = received.payload as Record<string, unknown>;
                    const images = await store.readInputImages(sessionId, payload.images);
                    if (images.length && !selectedModel.inputCapabilities.includes('IMAGE'))
                      throw new MarAgentError(
                        'MAR_AGENT_INPUT_CAPABILITY_UNSUPPORTED',
                        'Selected model does not support image input.'
                      );
                    const percent =
                      smartContextTokens === undefined
                        ? undefined
                        : (smartContextTokens * 100) / selectedModel.contextWindowTokens;
                    const eligible =
                      sessionSource.type === 'user' &&
                      percent !== undefined &&
                      percent >= AGENT_EXECUTION_POLICY.smartCompactionPercent &&
                      percent < AGENT_EXECUTION_POLICY.automaticCompactionPercent;
                    const actual: Record<string, unknown> = {
                      ...payload,
                      ...(eligible ? { smartCompaction: true } : {})
                    };
                    const content = (actual.modelText ?? actual.prompt) as string;
                    const applied = await store.append(
                      sessionId,
                      {
                        type: 'model.context',
                        payload: {
                          role: 'user',
                          content,
                          inputRef: received.recordId,
                          input: actual
                        },
                        executionId,
                        turnId
                      },
                      { signal: call.signal }
                    );
                    const outcome = {
                      changed: true,
                      modelChanged: true,
                      executionId,
                      recordId: received.recordId
                    };
                    recordSessionInputCommit(entry, outcome);
                    pendingInputs.delete(received.recordId);
                    const metadata = inputMetadataFromRecord({ ...received, payload: actual });
                    const message: ModelMessage = {
                      role: 'user',
                      content,
                      metadata,
                      ...(images.length ? { images } : {})
                    };
                    messages.push(message);
                    messageSources.set(message, applied);
                    modelContext.rememberInput({ content, metadata });
                    smartInput = { recordId: received.recordId, eligible, requested: false };
                    for (const text of (payload.modelContext ?? payload.context ?? []) as string[])
                      messages.push({ role: 'user', content: text, contextKind: 'contextual' });
                    return outcome;
                  });
                }
                const parent = entry.parentMessage as SubagentMailboxMessage | undefined;
                let outcome: CoreSessionActionResult | undefined;
                const content: CorePromptInput = {
                  text: request.input.text,
                  ...(request.input.modelText === undefined
                    ? {}
                    : { modelText: request.input.modelText }),
                  ...(request.input.context === undefined
                    ? {}
                    : { context: request.input.context }),
                  ...(request.input.modelContext === undefined
                    ? {}
                    : { modelContext: request.input.modelContext }),
                  ...(request.input.images === undefined ? {} : { images: request.input.images })
                };
                await writeInputRecord(
                  content,
                  parent && !parent.delivery?.origin ? 'turn.user' : 'extension.input',
                  parent && !parent.delivery?.origin
                    ? {
                        inputSource: 'parent_agent',
                        ...(parent.delivery ? { messageId: parent.delivery.messageId } : {})
                      }
                    : {
                        source: extensionInputSource(
                          call,
                          request.input.provenance,
                          request.input.modelAttribution
                        ),
                        ...(parent?.delivery ? { messageId: parent.delivery.messageId } : {})
                      },
                  call,
                  (actual, recordId, metadata) => {
                    outcome = { changed: true, executionId, recordId };
                    recordSessionInputCommit(entry, outcome);
                    messages.push({
                      role: 'user',
                      content: actual.modelText ?? actual.text,
                      metadata,
                      ...(actual.images?.length
                        ? {
                            images: actual.images.map((image) => ({ ...image }))
                          }
                        : {})
                    });
                    parent?.delivery?.applied();
                  }
                );
                return outcome!;
              },
              {
                executionId,
                turnId,
                signal: controller.signal,
                ...(restoring ? { restoring: true as const } : {})
              },
              inputs.boundarySize
            );
          const hasRestoredUserImages = messages.some(
            (message) => message.role === 'user' && Boolean(message.images?.length)
          );
          let modelInputImages: ModelImage[] | undefined;
          const inputImageBytes = new Map<string, ModelImage>();
          const currentExecutionToolImages: ToolRuntimeImage[] = [];
          let currentExecutionUserIndex: number | undefined;
          await emit({ type: 'execution.started', mode, permissionMode: permissionPolicy.mode });
          if (restored.ignoredImages > 0)
            await store.append(sessionId, {
              type: 'context.warning',
              payload: {
                code: 'MAR_AGENT_INPUT_IMAGE_IGNORED',
                message: 'One or more corrupt historical input images were ignored.',
                ignoredImages: restored.ignoredImages
              },
              executionId,
              turnId
            });
          selectedAdapter = sessionAdapter(
            input.modelId ?? executionDefaultModelId,
            executionModels
          );
          const selectedModel = executionModels.get(input.modelId ?? executionDefaultModelId)!;
          const restoredMessageCount = messages.length;
          const resourceInput = new ResourceInputProjection(
            selectedModel.useResourceUrl === true,
            store,
            sessionId,
            messages
          );
          const selected = modelResources.openTurn(
            selectedAdapter,
            services.hasCustomAdapters && selectedAdapter.createTurnSession === undefined
          );
          let lastServerUsage = latestModelUsage(contextRecords, selectedModel.id);
          let smartContextTokens = latestSmartContextTokens(
            contextRecords,
            selectedModel.id,
            selectedModel.contextWindowTokens
          );
          const compactUserTokenLimit = Math.min(
            20_000,
            Math.floor(selectedModel.contextWindowTokens / 8)
          );
          const reasoningEffort = input.reasoningEffort ?? selectedModel.defaultReasoningEffort;
          if (mode !== 'compact' && subagents)
            await subagents.beginParentExecution({
              executionId,
              modelId: selectedModel.id,
              reasoningEffort,
              models: executionModels,
              emitTerminal: async (task) =>
                emit({
                  type: 'subagent.completed',
                  agentId: task.agentId,
                  description: task.description,
                  status: task.status,
                  ...(task.permissionStop === undefined
                    ? {}
                    : { permissionStop: task.permissionStop }),
                  ...(task.modelId === undefined ? {} : { modelId: task.modelId }),
                  ...(task.modelName === undefined ? {} : { modelName: task.modelName }),
                  ...(task.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: task.reasoningEffort }),
                  ...(task.latestMessage === undefined
                    ? {}
                    : { latestMessage: task.latestMessage }),
                  ...(task.latestActivity === undefined
                    ? {}
                    : { latestActivity: task.latestActivity }),
                  ...(task.errorCode === undefined ? {} : { errorCode: task.errorCode }),
                  ...(task.errorMessage === undefined ? {} : { errorMessage: task.errorMessage })
                }),
              startTurn: async (turn) => {
                const child = await openSession(turn.sessionId);
                return child.startSubagentTurn({
                  permissionMode: permissionPolicy.mode,
                  prompt: turn.prompt,
                  modelId: turn.modelId,
                  reasoningEffort: turn.reasoningEffort,
                  role: turn.role,
                  initialMailbox: turn.initialMailbox,
                  turnId: turn.turnId,
                  ...(turn.origin === undefined ? {} : { origin: turn.origin }),
                  mcpExecutionScopeId: executionId,
                  ...(turn.delivery ? { delivery: turn.delivery } : {})
                });
              }
            });
          const catalogContext = {
            sessionId,
            executionId,
            modelId: selectedModel.id,
            ...(sessionSource.type === 'subagent'
              ? internal.mcpExecutionScopeId === undefined
                ? {}
                : { executionScopeId: internal.mcpExecutionScopeId }
              : { claimExecutionScope: true })
          };
          const readMcpCatalog = async (): Promise<import('./types.js').McpToolCatalog> => {
            if (host.listMcpToolCatalog) {
              const catalog = await host.listMcpToolCatalog(catalogContext);
              assertMcpToolCatalog(catalog);
              return catalog;
            }
            const definitions = (await host.listMcpTools?.(catalogContext)) ?? [];
            return {
              revision: createHash('sha256').update(JSON.stringify(definitions)).digest('hex'),
              servers: [{ id: 'legacy', name: 'External MCP' }],
              tools: definitions.map((definition) => ({
                definition,
                serverId: 'legacy',
                rawName: definition.name,
                sourceIdentity: `legacy:${executionId}`,
                definitionRevision: createHash('sha256')
                  .update(JSON.stringify(definition))
                  .digest('hex'),
                lifetime: 'execution',
                exposure: 'deferred'
              }))
            };
          };
          const mcpCatalog = await readMcpCatalog();
          const mcpRegistry = new DeferredMcpRegistry(discoveredMcpToolNames(messages));
          const mcpTools = mcpCatalog.tools.map((tool) => tool.definition);
          const extensions = (await host.listExecutionExtensions?.(catalogContext)) ?? {};
          if (extensions.tools?.some((tool) => tool.name.startsWith('mcp__')))
            throw new MarAgentError(
              'MAR_AGENT_TOOL_INPUT_INVALID',
              'Host tools cannot use the MCP namespace.'
            );
          const selectedModelForTools = executionModels.get(
            input.modelId ?? executionDefaultModelId
          )!;
          const builtinTools = BUILTIN_TOOL_DEFINITIONS.map((tool) =>
            tool.name === 'agent_start'
              ? agentStartToolDefinitionWithModels(
                  [...executionModels.values()]
                    .filter((configuration) => configuration.conversationModel !== false)
                    .map((configuration) => ({
                      id: configuration.id,
                      name: configuration.name,
                      reasoningEfforts: configuration.reasoningEfforts
                    }))
                )
              : tool
          );
          const combinedTools = [...builtinTools, ...(extensions.tools ?? []), ...mcpTools];
          if (new Set(combinedTools.map((tool) => tool.name)).size !== combinedTools.length)
            throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Tool names conflict.');
          const executionSourceNames = new Set(combinedTools.map((tool) => tool.name));
          const supplementalBindings =
            services.extensions.options
              .baseTools?.(sessionId, { executionId })
              ?.filter((binding) => !executionSourceNames.has(binding.definition.name)) ?? [];
          const sources = (executionToolSources = new ExecutionToolSources(
            executionId,
            sessionId,
            combinedTools,
            builtinTools,
            mcpCatalog,
            supplementalBindings
          ));
          const sourceBindings = sources.bindings;
          const coreExtensions = await services.extensions.prepare(
            sessionId,
            controller.signal,
            sourceBindings,
            sessionSource.type === 'user' &&
              (mode === 'run' || mode === 'plan') &&
              !internal.automaticInput
          );
          executionContext.toolSources = sources;
          const operation = <T>(run: (call: CoreOperationContext) => T): T =>
            services.extensions.operations.run(
              {
                sessionId,
                sessionEpoch: coreExtensions.epoch,
                executionId,
                turnId,
                actor: 'sdk',
                entry: 'native-api',
                signal: controller.signal
              },
              run
            );
          if (mode !== 'compact') {
            // Missing entries prepend in reverse order; warm entries retain their FIFO position.
            for (const record of [...pendingInputs.values()].reverse()) {
              operation((call) =>
                inputs.restoreSteer(
                  record.recordId,
                  (record.payload as { prompt: string }).prompt,
                  call
                )
              );
            }
          }
          await operation((call) => coreExtensions.ready(call));
          const captureTools = () =>
            operation((call) => {
              return coreExtensions.capture(
                call,
                false,
                sourceBindings.filter(
                  (binding) =>
                    !supplementalBindings.includes(binding) || binding.available?.(call) !== false
                )
              );
            });
          const streamModel = (
            start: (signal: AbortSignal) => AsyncIterable<ModelEvent>,
            signal: AbortSignal = controller.signal
          ) =>
            transformCoreModelStream(
              start,
              signal,
              (event, signal) =>
                operation((call) =>
                  coreExtensions.modelEvent(event, Object.freeze({ ...call, signal }))
                ),
              () =>
                coreExtensions.diagnose({
                  code: 'MAR_AGENT_MODEL_STREAM_CLEANUP_FAILED',
                  sessionId
                })
            );

          const transformModelRequest = async (
            candidate: ModelRequest,
            bindings = captureTools(),
            modelId = selectedModel.id,
            purpose: 'conversation' | 'compact' = mode === 'compact' ? 'compact' : 'conversation'
          ): Promise<ModelRequest> => {
            let lowered = candidate;
            if (coreExtensions.hooks.hasInterceptors('model.request')) {
              const bridge = new ExtensionRequestBridge(
                modelId,
                candidate,
                undefined,
                selected.continuationInputCount?.() ?? 0
              );
              const request = await operation((call) =>
                coreExtensions.hooks.invoke(
                  'model.request',
                  bridge.view,
                  call,
                  async (view) => view
                )
              );
              lowered = bridge.lower(request);
              if (bridge.rewroteCommittedInput) selected.resetContinuation?.();
            }
            for (const definition of lowered.tools) {
              const binding = bindings.get(definition.name);
              const { description: _description, ...contract } = definition;
              const { description: _capturedDescription, ...capturedContract } = binding
                ? permissionPolicy.mode === 'auto'
                  ? projectPermissionTool(binding.definition)
                  : binding.definition
                : {};
              if (!binding || !isDeepStrictEqual(contract, capturedContract))
                throw new MarAgentError(
                  'MAR_AGENT_EXTENSION_MODEL_REQUEST_INVALID',
                  'Request tools do not match captured sources.'
                );
            }
            return {
              ...lowered,
              usageRequestId: randomUUID(),
              ...(host.modelUsage === undefined
                ? {}
                : {
                    onModelUsage: (usage) =>
                      host.modelUsage!({
                        ...usage,
                        sessionId,
                        executionId,
                        purpose,
                        agentRole: sessionSource.type === 'subagent' ? 'subagent' : 'root'
                      }),
                    onModelUsageFailure: () =>
                      coreExtensions.diagnose({
                        code: 'MAR_AGENT_MODEL_USAGE_FAILED',
                        sessionId
                      })
                  })
            };
          };
          const toolEligible = (tool: ClientToolDefinition): boolean => {
            toolCallers(tool);
            if (sessionSource.type === 'subagent' && tool.agentScope === 'ROOT_ONLY') return false;
            if (
              sessionSource.type === 'subagent' &&
              (tool.name.startsWith('agent_') || tool.name === 'question')
            )
              return false;
            if (tool.name === 'tool_search') return mcpRegistry.hasDeferred;
            return tool.name === 'code_exec' || tool.name === 'code_exec_wait'
              ? selectedModelForTools.codeMode && description.capabilities.includes('code.execute')
              : tool.name === 'question'
                ? mode === 'plan'
                : tool.name !== 'view_image' ||
                  selectedModelForTools.inputCapabilities.includes('IMAGE');
          };
          const updateMcpRegistry = () =>
            mcpRegistry.update(
              coreMcpCatalog(
                [...mcpCatalog.servers, ...coreExtensions.mcp.servers()],
                captureTools()
              ),
              (tool) => toolEligible(tool.definition),
              { nativeToolNames: true }
            );
          updateMcpRegistry();
          rebindMcpToolSearchOutputs(messages, mcpRegistry);
          const availableTools = [...captureTools().values()]
            .map((binding) => binding.definition)
            .filter(toolEligible);
          const instructionContext = await loadAgentInstructions({
            home: description.homeDirectory,
            workspace: instructionWorkspace,
            availableTools: new Set(availableTools.map((tool) => tool.name)),
            hostSkills: extensions.skills ?? [],
            ...(settings.workspaceMapping === undefined
              ? {}
              : { workspaceDisplayPath: logicalWorkspace })
          });
          const instructionEntries = instructionContext?.entries ?? [];
          const currentInstructionSnapshot = renderAgentInstructions(instructionEntries, false);
          const baseTools = () =>
            [...captureTools().values()]
              .filter((binding) => binding.mcp === undefined)
              .map((binding) => binding.definition)
              .filter(
                (tool) =>
                  toolEligible(tool) &&
                  (tool.name !== 'skill' || (instructionContext?.skills.size ?? 0) > 0)
              );
          let executionTools = mcpRegistry.project(baseTools());
          const restoreMcpDiscovery = () => {
            mcpRegistry.restore(discoveredMcpToolNames(messages));
            rebindMcpToolSearchOutputs(messages, mcpRegistry);
            executionTools = mcpRegistry.project(baseTools());
          };
          const loadRetainedSessionResources = async (): Promise<RetainedSessionResources> => {
            await subagents?.prepareSessionResources(controller.signal);
            const hostResources = (await host.listSessionResources?.(sessionId)) ?? {
              processes: [] as const
            };
            return {
              ...(hostResources.idleTtlMs === undefined
                ? {}
                : { idleTtlMs: hostResources.idleTtlMs }),
              processes: hostResources.processes,
              ...(hostResources.codeCells ? { codeCells: hostResources.codeCells } : {}),
              subagents: subagents?.listSessionResources() ?? []
            };
          };
          await modelContext.initializeWorldState();
          const buildExecutionPromptSections = (
            availableTools: readonly ClientToolDefinition[] = executionTools,
            promptMode: ExecutionMode = mode
          ) =>
            buildSessionPromptSections(
              availableTools,
              promptMode,
              selectedModel,
              executionSystemInstruction,
              instructionContext?.skillCatalog
            );
          const buildExecutionSystemPrompt = (
            availableTools: readonly ClientToolDefinition[] = executionTools,
            promptMode: ExecutionMode = mode
          ) => renderPromptSections(buildExecutionPromptSections(availableTools, promptMode));
          const promptComposition = (
            availableTools: readonly ClientToolDefinition[],
            promptMode: ExecutionMode
          ) => ({
            sections: buildExecutionPromptSections(availableTools, promptMode),
            facts: {
              modelId: selectedModel.id,
              mode: promptMode,
              tools: availableTools.map((tool) => tool.name)
            }
          });
          if (mode !== 'compact') await modelContext.syncMcpWorldState();
          const writeCompactionRecord = async (
            summary: string,
            _automatic: boolean,
            signal: AbortSignal,
            write: (
              summary: string,
              options: { signal: AbortSignal }
            ) => Promise<import('../session/store/index.js').SessionRecord>
          ) =>
            withRecordProjection(async () => {
              signal.throwIfAborted();
              const stored = await write(summary, { signal });
              inputs.recordCompactCommit({ changed: true, recordId: stored.recordId, executionId });
              return stored;
            });
          const performCompact = (
            input: { readonly focus?: string },
            leaf: (
              input: { readonly focus?: string },
              call: CoreOperationContext
            ) => Promise<CoreSessionActionResult>
          ) =>
            operation((call) =>
              inputs.performCompact(input, call, (commit) =>
                coreExtensions.hooks.invoke(
                  'session.compact',
                  input,
                  call,
                  async (input, effective) => {
                    effective.signal.throwIfAborted();
                    if (input.focus !== undefined && typeof input.focus !== 'string')
                      throw new MarAgentError(
                        'MAR_AGENT_SESSION_INPUT_INVALID',
                        'Compaction focus is invalid.'
                      );
                    const outcome = await leaf(input, effective);
                    commit(outcome);
                    return outcome;
                  }
                )
              )
            );
          const captureRoundToolScope = () => {
            const roundTools = projectTools(executionTools);
            const availableBindings = captureTools();
            const roundBindings = new Map(
              roundTools.map((tool) => [tool.name, availableBindings.get(tool.name)!])
            );
            const defaultComposition = promptComposition(
              roundTools,
              mode === 'compact' ? 'run' : mode
            );
            if (permissionPolicy.mode === 'auto')
              defaultComposition.sections = [
                ...defaultComposition.sections,
                { id: 'core:auto-permission', text: autoPermissionPrompt }
              ];
            const defaultSystemPrompt = renderPromptSections(defaultComposition.sections);
            let systemPrompt = defaultSystemPrompt;
            const roundMcpExpectations = new Map(
              roundTools
                .filter((tool) => roundBindings.get(tool.name)?.mcp !== undefined)
                .map((tool) => [tool.name, mcpRegistry.expectedTool(tool.name)])
            );
            const parentFrame =
              subagents === undefined || mode === 'compact'
                ? undefined
                : subagents.captureParentFrame(executionId);
            const roundSmartInput = smartInput;
            const toolContext: ToolRuntimeContext = {
              imageStore: store,
              host: host,
              requestSmartCompact: () => {
                controller.signal.throwIfAborted();
                requestSmartCompaction(
                  roundSmartInput === smartInput ? roundSmartInput : undefined,
                  () => {
                    // The Session owns this background operation, not the short-lived tool callback.
                    services.extensions.operations.enter(
                      {
                        sessionId,
                        sessionEpoch: coreExtensions.epoch,
                        executionId,
                        turnId,
                        actor: 'sdk',
                        entry: 'native-api',
                        signal: controller.signal
                      },
                      () => startCompact({ async: true })
                    );
                  }
                );
              },
              permissionPolicy,
              writeToolResultResource: (text) => store.writeToolResultResource(sessionId, text),
              todo,
              ...(subagents === undefined || mode === 'compact'
                ? {}
                : {
                    subagents: coreExtensions.bindAgents(subagents.captureExecution(executionId)),
                    subagentMessages: subagents.modelMessages
                  }),
              mode,
              sessionId,
              executionId,
              modelId: selectedModel.id,
              signal: controller.signal,
              waitInterrupt,
              emit,
              skills: instructionContext?.skills ?? new Map(),
              invokeTool: (call, context, caller) => {
                const invoke = () =>
                  coreExtensions.withTools(roundBindings, sessionRuntime.scheduleTool, () =>
                    withToolPermissions(permissionPolicy, () =>
                      services.extensions.operations.enter(
                        {
                          sessionId,
                          sessionEpoch: coreExtensions.epoch,
                          executionId,
                          turnId,
                          actor: caller === 'programmatic' ? 'code-mode' : 'model',
                          entry: caller,
                          ...(context.parentCallId === undefined
                            ? {}
                            : { parentToolCallId: context.parentCallId }),
                          signal: context.signal
                        },
                        (operation) => coreExtensions.invoke(call, operation, roundBindings)
                      )
                    )
                  );
                return sources.withFrame(context, () =>
                  parentFrame === undefined ? invoke() : parentFrame(invoke)
                );
              }
            };
            const recentImages = async () => {
              const inputImages = await Promise.all(
                (modelInputImages ?? []).map(async (image) => {
                  if (image.dataBase64 !== undefined || image.resourceId === undefined)
                    return image;
                  const cached = inputImageBytes.get(image.resourceId);
                  if (cached !== undefined) return cached;
                  const source = await store.readResource(sessionId, image.resourceId);
                  const restored = { ...image, ...source };
                  inputImageBytes.set(image.resourceId, restored);
                  return restored;
                })
              );
              return currentExecutionImages(inputImages, currentExecutionToolImages);
            };
            const toolScope: RoundToolScope = {
              context: toolContext,
              tools: roundTools,
              expectations: roundMcpExpectations,
              extensionToolNames: new Set(
                [...roundBindings.values()]
                  .filter(
                    (binding) =>
                      binding.source.kind === 'host' || binding.source.kind === 'extension'
                  )
                  .map((binding) => binding.definition.name)
              ),
              schedule: sessionRuntime.scheduleTool,
              assertLive: () => coreExtensions.assertLive(),
              assertExecutionLive: () => sources.assertActive(),
              emit: (event, assertLive) =>
                emit(event, () => {
                  coreExtensions.assertLive();
                  assertLive?.();
                }),
              searchMcpTools: (arguments_, searchSignal) =>
                mcpRegistry.expose(arguments_, {
                  signal: searchSignal,
                  base: projectTools(baseTools()),
                  window: selectedModel.contextWindowTokens,
                  system: systemPrompt
                }),
              recentImages,
              captureCodeContext: () => ({
                ...toolContext,
                waitInterrupt: undefined
              }),
              codeModeContext: async (call) => {
                const stateSnapshot =
                  call.name === 'code_exec' ? await store.readCodeModeState(sessionId) : [];
                return {
                  retainSession: async () => {
                    coreExtensions.assertLive();
                    const release = await store.retainSessionLease(sessionId, sessionWriterOwner);
                    let unpin: () => void;
                    try {
                      unpin = coreExtensions.pin();
                    } catch (error) {
                      try {
                        await release();
                      } catch {
                        coreExtensions.diagnose({
                          code: 'MAR_AGENT_EXTENSION_CLEANUP_FAILED',
                          sessionId
                        });
                      }
                      throw error;
                    }
                    return async () => {
                      try {
                        await release();
                      } finally {
                        unpin();
                      }
                    };
                  },
                  onSettled: async (result) => {
                    await store.append(sessionId, {
                      type: 'code.cell.completed',
                      payload: { ...result, callId: call.callId },
                      executionId,
                      turnId
                    });
                  },
                  supportsImages: selectedModel.inputCapabilities.includes('IMAGE'),
                  permissionStop: () =>
                    permissionPolicy.stop?.source.parentCallId === call.callId
                      ? permissionPolicy.stop
                      : undefined,
                  tools: roundTools.filter((tool) => allowsToolCaller(tool, 'programmatic')),
                  state: stateSnapshot,
                  commitState: (mutations) =>
                    store.commitCodeModeState(sessionId, mutations, {
                      executionId,
                      turnId,
                      expectedState: stateSnapshot
                    })
                };
              }
            };
            return {
              roundTools,
              roundBindings,
              toolScope,
              async composeSystemPrompt() {
                const composed =
                  preparedCompactPrompt ??
                  (await operation((call) =>
                    coreExtensions.composeModelSystem(defaultComposition, call)
                  ));
                preparedCompactPrompt = undefined;
                systemPrompt = composed.text;
                return composed;
              }
            };
          };
          let preparedCompactPrompt:
            Awaited<ReturnType<typeof coreExtensions.composeModelSystem>> | undefined;
          sources.bind(captureRoundToolScope().toolScope);
          let preparingRequestMessages: readonly ModelMessage[] | undefined;
          let preparingRequestBaseLength = 0;
          let dispatchedInputCount = 0;
          let dispatchedLocalCount = 0;
          executionContext.requestMessages = {
            read: () =>
              preparingRequestMessages !== undefined
                ? normalizeMessagesForModel(
                    [...preparingRequestMessages, ...messages.slice(preparingRequestBaseLength)],
                    { supportsImages: selectedModel.inputCapabilities.includes('IMAGE') }
                  )
                : projectSessionRequestMessages(
                    messages.map((message, index) =>
                      index === currentExecutionUserIndex && modelInputImages?.length
                        ? { ...message, images: modelInputImages }
                        : message
                    ),
                    mode === 'compact' ? [] : modelContext.worldState.entries,
                    mode !== 'compact' && selectedModel.inputCapabilities.includes('IMAGE'),
                    baseTools().some((tool) => tool.name === 'code_exec'),
                    permissionPolicy.mode === 'auto'
                  )
          };
          if (mode !== 'compact') {
            if (pendingInputs.size) await appendMailboxMessages(true);
            let entered = false;
            const writeInput = async (content: CorePromptInput, call: CoreOperationContext) => {
              call.signal.throwIfAborted();
              if (
                (content.images?.length || hasRestoredUserImages) &&
                !selectedModel.inputCapabilities.includes('IMAGE')
              )
                throw new MarAgentError(
                  'MAR_AGENT_INPUT_CAPABILITY_UNSUPPORTED',
                  'Selected model does not support image input.'
                );
              if (entered) {
                await sessionRuntime.sessionBackend!.enqueue(
                  { kind: 'submit', input: { ...content, delivery: 'idle' } },
                  call,
                  (request, effective, next) => next(request, effective)
                );
                return {};
              }
              await modelContext.recordEnvironment();
              call.signal.throwIfAborted();
              await writeInputRecord(
                content,
                internal.inputSource === 'extension' ? 'extension.input' : 'turn.user',
                {
                  ...(internal.extensionSource ? { source: internal.extensionSource } : {}),
                  ...(internal.delivery ? { messageId: internal.delivery.messageId } : {}),
                  ...(internal.inputSource === undefined
                    ? {}
                    : { inputSource: internal.inputSource }),
                  ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {})
                },
                call,
                (actual, recordId, metadata) => {
                  entered = true;
                  modelInputImages = actual.images?.map((image) => ({ ...image }));
                  messages.push({
                    role: 'user',
                    content: actual.modelText ?? actual.text,
                    metadata,
                    ...(modelInputImages?.length ? { images: modelInputImages } : {})
                  });
                  currentExecutionUserIndex = messages.length - 1;
                  internal.inputCommitted?.(recordId);
                  internal.delivery?.applied();
                }
              );
              return {};
            };
            const content: CorePromptInput = {
              text: input.prompt,
              ...(internal.modelText === undefined ? {} : { modelText: internal.modelText }),
              ...(internal.inputContext === undefined ? {} : { context: internal.inputContext }),
              ...(internal.modelContext === undefined
                ? {}
                : { modelContext: internal.modelContext }),
              ...(input.images === undefined ? {} : { images: input.images })
            };
            await operation((call) =>
              internal.promptAdmitted
                ? writeInput(content, call)
                : invokeCorePromptSubmission(coreExtensions.hooks, content, call, writeInput)
            );
            if (!entered) {
              await emit({ type: 'execution.completed' });
              return { executionId, status: 'completed', finalAnswer: '', inputHandled: true };
            }
            acceptsSteer = true;
            executionContext.steer = createNativeSteer({
              executionId,
              inputs,
              signal: controller.signal,
              isOpen: () => acceptsSteer,
              operation,
              admit: (content, call, write) =>
                invokeCorePromptSubmission(coreExtensions.hooks, content, call, write),
              receive: (content, clientMessageId, call) =>
                withRecordProjection(async () => {
                  call.signal.throwIfAborted();
                  if (content.images?.length && !selectedModel.inputCapabilities.includes('IMAGE'))
                    throw new MarAgentError(
                      'MAR_AGENT_INPUT_CAPABILITY_UNSUPPORTED',
                      'Selected model does not support image input.'
                    );
                  const modelImages = await publishModelResources(
                    host,
                    content.images,
                    {
                      sessionId,
                      executionId
                    },
                    store
                  );
                  const images = modelImages?.length
                    ? await store.persistInputImages(sessionId, modelImages)
                    : [];
                  const record = await store.append(
                    sessionId,
                    {
                      type: 'turn.user',
                      payload: {
                        deferred: true,
                        prompt: content.text,
                        ...(content.modelText === undefined
                          ? {}
                          : { modelText: content.modelText }),
                        ...(content.context === undefined ? {} : { context: content.context }),
                        ...(content.modelContext === undefined
                          ? {}
                          : { modelContext: content.modelContext }),
                        clientMessageId,
                        ...(images.length ? { images } : {})
                      },
                      executionId,
                      turnId
                    },
                    { signal: call.signal }
                  );
                  pendingInputs.set(record.recordId, record);
                  return record;
                }),
              notify: (entry) => emit({ type: 'input.received', entry }),
              wake: () => waitInterrupt.notify(),
              diagnose: () =>
                coreExtensions.diagnose({ code: 'MAR_AGENT_STEER_POST_COMMIT_FAILED', sessionId })
            });
          }
          const modelConfiguration = prepareModelConfiguration(selectedModel, reasoningEffort, {
            baselineEffort: reasoningEffortBaseline(contextRecords, selectedModel.id),
            messages
          });
          let requestReasoningEffort = modelConfiguration.requestReasoningEffort;
          if (mode !== 'compact')
            for (const update of modelConfiguration.updates) {
              messages.push(update);
              await store.append(sessionId, {
                type: 'model.context',
                payload: update,
                executionId,
                turnId
              });
            }
          const runPreparedExecution = async (
            compactFocus: string = input.prompt,
            compactSignal: AbortSignal = controller.signal
          ): Promise<void> => {
            const initialSystemPrompt =
              mode === 'compact'
                ? buildExecutionSystemPrompt(executionTools, 'run')
                : buildExecutionSystemPrompt();
            const generateCompactExtension = async (
              history: readonly ModelMessage[],
              reason: 'manual' | 'automatic',
              focus: string | undefined,
              compaction: CompactionOperation
            ): Promise<CoreCompactResult | undefined> => {
              if (!coreExtensions.hooks.hasInterceptors('compact.generate')) return undefined;
              const summaryTokenBudget = Math.min(
                10_000,
                selectedModel.maxOutputTokens,
                Math.max(1, Math.floor(selectedModel.contextWindowTokens / 4))
              );
              let diagnosticReports = 0;
              let acceptsDiagnostics = true;
              try {
                const result = await compaction.generate((signal) =>
                  operation((call) =>
                    coreExtensions.hooks.invoke(
                      'compact.generate',
                      Object.freeze({
                        operationId: call.operationId,
                        reason,
                        messages: compactExtensionMessages(history),
                        ...(focus === undefined ? {} : { focus }),
                        summaryTokenBudget,
                        getPrompt: () => buildCompactionMessages('')[1]!.content,
                        reportModelUsage:
                          host.modelUsage === undefined
                            ? undefined
                            : (usage: import('../model/usage-observer.js').ModelRequestUsage) =>
                                host.modelUsage!({
                                  ...usage,
                                  sessionId,
                                  executionId,
                                  purpose: 'compact',
                                  agentRole: sessionSource.type === 'subagent' ? 'subagent' : 'root'
                                }),
                        reportDiagnostic: async (value: CoreCompactDiagnostic) => {
                          if (!acceptsDiagnostics || ++diagnosticReports > 8) return;
                          try {
                            const diagnostic = compactExtensionDiagnostic(value);
                            if (diagnostic) await compaction.observeExtension(diagnostic);
                          } catch {
                            // Diagnostic failures must not change compaction or fallback.
                          }
                        }
                      }),
                      Object.freeze({ ...call, signal }),
                      async () => undefined
                    )
                  )
                );
                compaction.signal.throwIfAborted();
                const handled = compactExtensionResult(result, summaryTokenBudget);
                await compaction.finishExtension(
                  handled ? 'HANDLED' : result === undefined ? 'DECLINED' : 'INVALID_RESULT'
                );
                return handled;
              } catch {
                await compaction.finishExtension('FAILED');
                compaction.signal.throwIfAborted();
                return undefined;
              } finally {
                acceptsDiagnostics = false;
              }
            };
            await store.append(sessionId, {
              type: 'execution.header',
              payload: {
                promptVersion: MAR_AGENT_PROMPT_VERSION,
                promptHash: createHash('sha256').update(initialSystemPrompt).digest('hex'),
                modelId: selectedModel.id,
                modelName: selectedModel.name,
                reasoningEffort,
                contextWindowTokens: selectedModel.contextWindowTokens,
                mode
              },
              executionId,
              turnId
            });
            let lastServerContextTokens = lastServerUsage?.contextInputTokens;
            let compactBoundary = restoredMessageCount;
            const advanceCompactBoundary = () => {
              // Keep a new image with its complete tool round until a model accepts it.
              if (!resourceInput.hasPendingImages(messages.slice(compactBoundary)))
                compactBoundary = messages.length;
            };
            const invalidateCompactUsage = () => {
              lastServerContextTokens = undefined;
              lastServerUsage = undefined;
              smartContextTokens = undefined;
              requestReasoningEffort = prepareModelConfiguration(selectedModel, reasoningEffort, {
                checkpointAdopted: true
              }).requestReasoningEffort;
            };
            const compactLeaf = async (
              input: { readonly focus?: string; readonly async?: boolean },
              signal: AbortSignal,
              prepare: () => Promise<void>,
              compactionId: string
            ) => {
              if (messages.length < 2) return false;
              const cutoff = Math.min(compactBoundary, messages.length);
              const current = messages[cutoff - 1]!;
              const retainCurrent =
                mode !== 'compact' && current.role === 'user' && current.contextKind === undefined;
              const prefix = messages.slice(0, cutoff - (retainCurrent ? 1 : 0));
              if (
                !prefix.some(
                  (message) =>
                    message.role !== 'user' ||
                    message.contextKind === undefined ||
                    message.contextKind === 'summary'
                )
              )
                return false;
              const compactHistory = structuredClone(prefix);
              const prefixInputs = modelContext.compactInputs(prefix);
              const snapshotTools = structuredClone(projectTools(executionTools));
              const generation = modelContext.worldState.generation;
              const snapshotUsage = lastServerUsage;
              const snapshotEffort = requestReasoningEffort ?? reasoningEffort;
              const anchorRecordId = prefix
                .map(
                  (message) => messageSources.get(message)?.recordId ?? message.metadata?.recordId
                )
                .findLast((id) => id !== undefined);
              const visibleAnchor = compactSnapshotAnchor(prefix, messageSources);
              const anchor = {
                ...(anchorRecordId ? { anchorRecordId } : {}),
                ...(visibleAnchor ? { anchor: visibleAnchor } : {})
              };
              const compactComposition = splitContextualPrompt(
                await operation((call) =>
                  coreExtensions.composeModelSystem(promptComposition(snapshotTools, 'run'), call)
                )
              );
              await emit({
                type: 'context.compacting',
                compactionId,
                async: input.async === true,
                stage: 'GENERATING',
                ...anchor
              });
              let latestUsage: ModelUsage | undefined;
              let compactSummary: string;
              const compaction = createCompactionOperation(compactionId, signal);
              const compactTurn = createModelTurnSession(selectedAdapter!);
              try {
                const candidate = await generateCompactionCandidate(
                  {
                    history: compactHistory,
                    system: compactComposition.system,
                    ...(compactComposition.systemBlocks === undefined
                      ? {}
                      : { systemBlocks: compactComposition.systemBlocks }),
                    tools: snapshotTools,
                    contextWindowTokens: selectedModel.contextWindowTokens,
                    latestUsage: snapshotUsage,
                    reasoningEffort: snapshotEffort,
                    ...(input.focus === undefined ? {} : { focus: input.focus }),
                    reason: mode === 'compact' ? 'manual' : 'automatic',
                    promptCacheKey: sessionId
                  },
                  {
                    operation: compaction,
                    turn: compactTurn,
                    generateExtension: generateCompactExtension,
                    transformRequest: (request) =>
                      transformModelRequest(request, undefined, selectedModel.id, 'compact'),
                    stream: streamModel,
                    observeUsage: (usage) =>
                      emit({
                        type: 'usage.updated',
                        purpose: 'compact',
                        ...publicModelUsage(usage)
                      }),
                    onAttemptDiagnostic: recordModelAttempt('COMPACTION')
                  }
                );
                compactSummary = candidate.summary;
                latestUsage = candidate.usage;
              } finally {
                await compaction.dispose();
                await compactTurn.close();
              }
              await emit({
                type: 'context.compacting',
                compactionId,
                async: !compactCoordinator.waiting && input.async === true,
                stage: compactCoordinator.waiting ? 'WAITING' : 'READY',
                ...anchor
              });
              await prepare();
              signal.throwIfAborted();
              const compactResources = retainedSessionResourcesSnapshot(
                await loadRetainedSessionResources()
              );
              const replacementHistory = buildCompactedHistory(
                compactSummary,
                prefixInputs,
                compactUserTokenLimit
              );
              let retainedModelContext: ModelMessage[] = [];
              const compactRecord = await writeCompactionRecord(
                compactSummary,
                true,
                signal,
                async (actual, options) => {
                  if (
                    modelContext.worldState.generation !== generation ||
                    prefix.some((message, index) => messages[index] !== message)
                  )
                    throw new MarAgentError(
                      'MAR_AGENT_COMPACT_STALE',
                      'The compaction prefix has changed.'
                    );
                  retainedModelContext = messages
                    .slice(prefix.length)
                    .filter(
                      (message) => message.contextKind !== 'private' || message.role === 'provider'
                    );
                  const record = await store.compact(
                    sessionId,
                    {
                      summary: actual,
                      replacementHistory,
                      retainedModelContext: retainedModelContext.map((message) => {
                        const source = messageSources.get(message);
                        const saved =
                          source?.type === 'model.context' &&
                          (source.payload as Record<string, unknown>).inputRef
                            ? source.payload
                            : source?.type === 'compact.completed'
                              ? (
                                  (
                                    source.payload as {
                                      retainedModelContext?: Record<string, unknown>[];
                                    }
                                  ).retainedModelContext ?? []
                                ).find((item) => item.inputRef === message.metadata?.recordId)
                              : undefined;
                        return saved
                          ? {
                              ...(saved as { role: 'user'; content: string }),
                              ...(message.metadata ? { metadata: message.metadata } : {})
                            }
                          : {
                              ...message,
                              ...(message.images?.length
                                ? {
                                    images: message.images.map(
                                      ({ dataBase64: _bytes, ...image }) => image
                                    )
                                  }
                                : {})
                            };
                      }),
                      pendingInputs: [...pendingInputs.values()],
                      snapshotMessageCount: prefix.length,
                      ...(anchorRecordId ? { snapshotRecordId: anchorRecordId } : {}),
                      automatic: mode !== 'compact',
                      environment: executionEnvironment,
                      modelId: selectedModel.id,
                      contextWindowTokens: selectedModel.contextWindowTokens,
                      ...(latestUsage === undefined ? {} : { usage: latestUsage }),
                      executionId,
                      turnId
                    },
                    options
                  );
                  modelContext.replaceCompactMessages(replacementHistory, retainedModelContext);
                  compactBoundary = messages.length - retainedModelContext.length;
                  return record;
                }
              );
              await modelContext.adoptCompactCheckpoint(
                compactRecord.recordId,
                replacementHistory,
                retainedModelContext,
                compactResources
              );
              invalidateCompactUsage();
              await emit({
                type: 'context.compacted',
                compactionId,
                async: input.async === true,
                retainedContext: retainedModelContext.length > 0,
                ...anchor
              });
              return true;
            };
            startCompact = (input = {}) => {
              const id = manualCompactionId ?? randomUUID();
              const flight = compactCoordinator.start(id, input.focus, async (prepare, signal) => {
                const linked = AbortSignal.any([signal, controller.signal, compactSignal]);
                try {
                  if (mode === 'compact' && inputs.currentCompact())
                    return await compactLeaf(input, linked, prepare, id);
                  return (
                    await performCompact(input, async (effective, call) => ({
                      changed: await compactLeaf(
                        { ...effective, async: input.async === true },
                        AbortSignal.any([linked, call.signal]),
                        prepare,
                        id
                      ),
                      executionId
                    }))
                  ).changed;
                } catch (error) {
                  const diagnostic = describeMarAgentError(error, 'MAR_AGENT_COMPACT_FAILED');
                  await emit({
                    type: 'context.compact_failed',
                    compactionId: id,
                    code: diagnostic.code,
                    async: input.async === true,
                    cancelled: linked.aborted
                  });
                  throw error;
                }
              });
              if (smartInput) smartInput.requested = true;
              return flight;
            };
            compactContext = async (input = {}) => {
              const flight = startCompact(input);
              if (input.async) return false;
              await emit({
                type: 'context.compacting',
                compactionId: flight.id,
                stage: 'WAITING',
                async: false
              });
              return (await compactCoordinator.checkpoint(true)) ?? false;
            };
            compactRequests.bind((input) =>
              compactCoordinator.pending
                ? startCompact({
                    ...(input.prompt === undefined ? {} : { focus: input.prompt }),
                    async: input.async === true
                  })
                : undefined
            );
            if (mode === 'compact') {
              startCompact({ focus: compactFocus });
              compactRequests.drain((input) =>
                startCompact({
                  ...(input.prompt === undefined ? {} : { focus: input.prompt }),
                  async: input.async === true
                })
              );
              await compactCoordinator.checkpoint(true);
              compactRequests.seal();
              compactRequests.drain((input) =>
                startCompact({
                  ...(input.prompt === undefined ? {} : { focus: input.prompt }),
                  async: input.async === true
                })
              );
              await compactCoordinator.checkpoint(true);
              return;
            }
            const ensureContextBudget = async () => {
              const percent =
                lastServerContextTokens === undefined
                  ? undefined
                  : (lastServerContextTokens * 100) / selectedModel.contextWindowTokens;
              if (
                percent !== undefined &&
                percent >= AGENT_EXECUTION_POLICY.automaticCompactionPercent
              ) {
                const hadPending = compactCoordinator.pending;
                let compacted: boolean;
                try {
                  compacted = await compactContext();
                } catch (error) {
                  controller.signal.throwIfAborted();
                  if (!hadPending) throw error;
                  advanceCompactBoundary();
                  compacted = await compactContext();
                }
                if (!compacted)
                  throw new MarAgentError(
                    'MAR_AGENT_CONTEXT_LIMIT',
                    'Provider usage reached the compaction threshold but no history can be compacted.'
                  );
              } else {
                const adopted = await compactCoordinator.checkpoint(false).catch(() => {
                  controller.signal.throwIfAborted();
                });
                if (
                  !adopted &&
                  percent !== undefined &&
                  percent >= AGENT_EXECUTION_POLICY.backgroundCompactionPercent &&
                  !compactCoordinator.pending
                )
                  startCompact({ async: true });
              }
            };
            executionLoop = new ExecutionLoop({
              mode,
              sourceType: sessionSource.type,
              permissionStop: () => permissionPolicy.stop,
              signal: controller.signal,
              model: selectedModel,
              messages,
              toolImages: currentExecutionToolImages,
              publish: emit,
              appendContext: (message) =>
                withRecordProjection(async () => {
                  const stored = await store.append(sessionId, {
                    type: 'model.context',
                    payload: message,
                    executionId,
                    turnId
                  });
                  messageSources.set(message, stored);
                }),
              prepareRound: async function prepareRound(
                pendingOutputContinuation,
                subagentUpdatesCollected = false
              ): Promise<PreparedExecutionRound> {
                await appendMailboxMessages();
                if (!subagentUpdatesCollected && subagents)
                  await withRecordProjection(async () => {
                    controller.signal.throwIfAborted();
                    for (const update of subagents.collectModelUpdates()) {
                      controller.signal.throwIfAborted();
                      const message: ModelMessage = {
                        role: 'user',
                        content: renderSubagentUpdate(update.snapshot, update.truncated),
                        contextKind: 'contextual'
                      };
                      const stored = await store.append(
                        sessionId,
                        {
                          type: 'model.context',
                          payload: message,
                          executionId,
                          turnId
                        },
                        { signal: controller.signal }
                      );
                      messages.push(message);
                      messageSources.set(message, stored);
                      update.acknowledge();
                    }
                  });
                updateMcpRegistry();
                executionTools = mcpRegistry.project(baseTools());
                await modelContext.syncMcpWorldState(messages.length);
                advanceCompactBoundary();
                const blocking = compactRequests.drain((input) =>
                  startCompact({
                    ...(input.prompt === undefined ? {} : { focus: input.prompt }),
                    async: input.async === true
                  })
                );
                if (blocking) await compactCoordinator.checkpoint(true);
                await ensureContextBudget();
                await modelContext.syncMcpWorldState(messages.length);
                executionEnvironment = { ...currentEnvironment, ...currentLocalTimeContext() };
                await modelContext.recordEnvironment();
                const { roundTools, roundBindings, toolScope, composeSystemPrompt } =
                  captureRoundToolScope();
                const residentTools = projectTools(mcpRegistry.projectDirect(baseTools()));
                const requestContextMessages =
                  pendingOutputContinuation === undefined
                    ? messages
                    : [...messages, pendingOutputContinuation];
                sources.bind(toolScope);
                const composedSystem = splitContextualPrompt(await composeSystemPrompt());
                const candidateWorld = updatePromptWorldState(
                  modelContext.worldState,
                  messages.length,
                  composedSystem.parts
                );
                const candidateRequest = prepareSessionModelRequest(
                  {
                    system: composedSystem.system,
                    ...(composedSystem.systemBlocks
                      ? { systemBlocks: composedSystem.systemBlocks }
                      : {}),
                    messages: requestContextMessages,
                    tools: roundTools,
                    promptCacheKey: sessionId,
                    reasoningEffort,
                    ...(requestReasoningEffort === undefined ? {} : { requestReasoningEffort }),
                    ...(modelInputImages?.length ? { images: modelInputImages } : {}),
                    onAttemptDiagnostic: recordModelAttempt('EXECUTION')
                  },
                  selectedModel,
                  candidateWorld.entries,
                  residentTools,
                  permissionPolicy.mode === 'auto'
                );
                preparingRequestMessages = candidateRequest.messages;
                preparingRequestBaseLength = messages.length;
                let request: ModelRequest;
                try {
                  request = await transformModelRequest(candidateRequest, roundBindings);
                } finally {
                  preparingRequestMessages = undefined;
                }
                controller.signal.throwIfAborted();
                if (candidateWorld !== modelContext.worldState) {
                  // Commit only after request middleware accepts the entire candidate.
                  await modelContext.commitWorldState(candidateWorld);
                }
                const lateCoreChange =
                  inputs.hasBoundaryCompactPending && (await appendMailboxMessages());
                const lateBlocking = compactRequests.drain((input) =>
                  startCompact({
                    ...(input.prompt === undefined ? {} : { focus: input.prompt }),
                    async: input.async === true
                  })
                );
                const lateAdopted = lateBlocking && (await compactCoordinator.checkpoint(true));
                if (lateCoreChange || lateAdopted) {
                  // Middleware may admit a blocking join after the initial checkpoint.
                  // Never sample the candidate assembled against the replaced context.
                  return prepareRound(pendingOutputContinuation, true);
                }
                return { request: await resourceInput.prepare(request), toolScope };
              },
              startModel: async function* (request) {
                const snapshots = (sessionRuntime.requestSnapshots ??=
                  new ExtensionRequestSnapshots());
                const snapshot = snapshots.record(selectedModel.id, request);
                dispatchedInputCount = request.messages.length;
                dispatchedLocalCount = messages.length;
                yield* streamModel(async function* (nativeSignal) {
                  for await (const event of selected.start(request, nativeSignal)) {
                    if (event.type === 'completed' && event.reason !== 'cancelled') {
                      if (snapshot) snapshots.complete(snapshot);
                    }
                    yield event;
                  }
                }, controller.signal);
              },
              recoverySignal: () => controller.signal,
              compactContext,
              afterModel: async (closedPrefixLength, acceptedRequest) => {
                if (acceptedRequest) {
                  resourceInput.complete(acceptedRequest);
                  compactBoundary = closedPrefixLength;
                }
                selected.commitContinuationInput?.(
                  dispatchedInputCount + messages.length - dispatchedLocalCount
                );
                if (
                  lastServerContextTokens !== undefined &&
                  (lastServerContextTokens * 100) / selectedModel.contextWindowTokens >=
                    AGENT_EXECUTION_POLICY.backgroundCompactionPercent &&
                  !compactCoordinator.pending
                )
                  startCompact({ async: true });
              },
              observeContextTokens: (tokens) => {
                lastServerContextTokens = tokens;
                smartContextTokens = tokens;
              },
              observeUsage: (usage) => {
                if (usage !== undefined) {
                  lastServerContextTokens = usage.contextInputTokens;
                  smartContextTokens = usage.contextInputTokens;
                  lastServerUsage = { ...usage, historyMessages: [...messages] };
                }
              },
              checkpoint: async (round, latestUsage) => {
                advanceCompactBoundary();
                const blocking = compactRequests.drain((input) =>
                  startCompact({
                    ...(input.prompt === undefined ? {} : { focus: input.prompt }),
                    async: input.async === true
                  })
                );
                if (blocking) await compactCoordinator.checkpoint(true);
                else
                  await compactCoordinator.checkpoint(false).catch(() => {
                    controller.signal.throwIfAborted();
                  });
                if (
                  !compactCoordinator.pending &&
                  sessionSource.type !== 'subagent' &&
                  latestUsage !== undefined
                ) {
                  // Only a committed GC checkpoint may replace active context and invalidate continuation.
                  const appendBoundary = pendingAppends.length;
                  const committed = await contextGc.run({
                    store,
                    sessionId,
                    system: round.request.system,
                    tools: round.toolScope.tools,
                    modelId: selectedModel.id,
                    contextWindowTokens: selectedModel.contextWindowTokens,
                    usage: latestUsage,
                    ...modelConfiguration.contextProjection,
                    workspace: logicalWorkspace,
                    platform: description.platform,
                    getActiveProcessIds: async () => {
                      const resources = await host
                        .listSessionResources?.(sessionId)
                        .catch(() => undefined);
                      return new Set(
                        (resources?.processes ?? [])
                          .filter((process) => process.status === 'running')
                          .map((process) => process.processId)
                      );
                    }
                  });
                  if (committed) {
                    await modelContext.adoptGcCheckpoint(committed, appendBoundary);
                  }
                }
              },
              mailbox: {
                hasPending: () => inputs.hasBoundaryPending && !inputs.executing,
                append: appendMailboxMessages,
                close: () => {
                  acceptsMailbox = false;
                  acceptsSteer = false;
                }
              }
            });
            const completed = await executionLoop.run();
            compactRequests.seal();
            compactRequests.drain((input) =>
              startCompact({
                ...(input.prompt === undefined ? {} : { focus: input.prompt }),
                async: input.async === true
              })
            );
            await compactCoordinator.checkpoint(true).catch(() => {
              controller.signal.throwIfAborted();
            });
            finalAnswer = completed.finalAnswer;
          };
          if (mode === 'compact')
            await performCompact({ focus: input.prompt }, async (effective, call) => {
              await runPreparedExecution(effective.focus ?? DEFAULT_COMPACTION_FOCUS, call.signal);
              return { changed: true, executionId };
            });
          else await runPreparedExecution();
          subagents?.endParentExecution(executionId);
          await emit({
            type: 'execution.completed',
            ...(permissionPolicy.stop ? { permissionStop: permissionPolicy.stop } : {})
          });
          return {
            executionId,
            status: 'completed',
            ...(permissionPolicy.stop ? { permissionStop: permissionPolicy.stop } : {}),
            finalAnswer: mode === 'compact' || permissionPolicy.stop ? '' : finalAnswer
          };
        } catch (error) {
          failedExecution = true;
          finalAnswer = executionLoop?.finalAnswer ?? finalAnswer;
          acceptsMailbox = false;
          acceptsSteer = false;
          delete executionContext.steer;
          await sessionRuntime.recordProjection?.catch(() => undefined);
          await compactCoordinator.close(error);
          compactRequests.close(new MarAgentError('MAR_AGENT_CANCELLED', 'Execution ended.'));
          if (executionContext.compactRequests === compactRequests)
            delete executionContext.compactRequests;
          if (controller.signal.aborted) {
            subagents?.endParentExecution(executionId);
            // A faulted Store must not prevent result settlement or lease release.
            await emit({ type: 'execution.cancelled' }).catch(() => undefined);
            return {
              executionId,
              status: 'cancelled',
              finalAnswer: mode === 'compact' ? '' : finalAnswer
            };
          }
          const diagnostic = modelAttemptFailureDiagnostic(
            describeMarAgentError(error, 'MAR_AGENT_EXECUTION_FAILED'),
            exhaustedModelAttempt
          );
          subagents?.endParentExecution(executionId);
          // Keep the original diagnostic if persisting the failure terminal also fails.
          await emit({ type: 'execution.failed', ...diagnostic }).catch(() => undefined);
          return {
            executionId,
            status: 'failed',
            finalAnswer: mode === 'compact' ? '' : finalAnswer,
            errorCode: diagnostic.code,
            errorMessage: diagnostic.message
          };
        } finally {
          // Revoke this Execution's request and input bindings, not Session warm resources.
          delete executionContext.requestMessages;
          compactRequests.close(new MarAgentError('MAR_AGENT_CANCELLED', 'Execution ended.'));
          if (executionContext.compactRequests === compactRequests)
            delete executionContext.compactRequests;
          delete executionContext.appendedMessages;
          delete executionContext.steer;
          acceptsMailbox = false;
          executionToolSources?.close();
          if (executionContext.toolSources === executionToolSources)
            delete executionContext.toolSources;
          internal.signal?.removeEventListener('abort', abortSource);
          // Compact retains its existing owner, waiting and error propagation.
          await compactCoordinator.close(
            controller.signal.reason ?? new MarAgentError('MAR_AGENT_CANCELLED', 'Execution ended.')
          );
          await modelResources.close();
          // Ending the parent Execution does not destroy Session-owned child tasks.
          subagents?.endParentExecution(executionId);
          try {
            await releaseSession?.();
          } catch (error) {
            // Preserve the first failure/cancellation; successful executions still report release errors.
            if (!failedExecution) throw error;
          } finally {
            // Writer release cannot skip owner-safe deactivation; the event stream closes last.
            if (sessionRuntime.execution === executionContext) delete sessionRuntime.execution;
            active.delete(`${sessionId}:${executionId}`);
            sessionRuntime.sessionBackend?.kick();
            queue.close();
          }
        }
      });
      const executionKey = `${sessionId}:${executionId}`;
      executionResults.set(executionKey, result);
      void result.then(
        (outcome) => {
          inputs.settleExecution(executionId, outcome.status);
          executionResults.delete(executionKey);
        },
        () => {
          inputs.settleExecution(executionId, 'failed');
          executionResults.delete(executionKey);
        }
      );
      return {
        get persistedEvents() {
          return persistedTerminal;
        },
        executionId,
        turnId,
        [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
        result: () => {
          queue.discardIfUnobserved();
          return result;
        },
        cancel: () =>
          controller.abort(new MarAgentError('MAR_AGENT_CANCELLED', 'Execution was cancelled.')),
        enqueueMessage: (message, delivery) => {
          if (!acceptsMailbox || controller.signal.aborted) return false;
          acceptParent({ text: message, ...(delivery ? { delivery } : {}) });
          return true;
        }
      };
    };
    sessionRuntime.sessionBackend ??= createExtensionSessionBackend({
      describe: async (call) => {
        call.signal.throwIfAborted();
        const defaults = sessionRuntime.execution;
        const state = defaults ?? services.modelState();
        const modelId = defaults?.modelId ?? services.modelState().defaultModelId;
        const current = await store.getSession(sessionId);
        const userTurns = await store.userTurnCount(sessionId);
        call.signal.throwIfAborted();
        const model = state.models.get(modelId);
        if (!model)
          throw new MarAgentError('MAR_AGENT_MODEL_DISABLED', 'Selected model is unavailable.');
        return {
          sessionId,
          ...(logicalWorkspace ? { cwd: logicalWorkspace, root: logicalWorkspace } : {}),
          modelId,
          modelName: model.name,
          startedAt: Date.parse(current.createdAt),
          source: structuredClone(sessionSource),
          userTurns
        };
      },
      composePrompt: async (facts, call) => {
        call.signal.throwIfAborted();
        const defaults = sessionRuntime.execution;
        const state = defaults ?? services.modelState();
        const modelId = facts.modelId ?? defaults?.modelId ?? services.modelState().defaultModelId;
        const instruction = defaults ? defaults.instruction : settings.systemInstruction;
        const model = state.models.get(modelId);
        if (!model)
          throw new MarAgentError('MAR_AGENT_MODEL_DISABLED', 'Selected model is unavailable.');
        const mode = facts.mode ?? defaults?.mode ?? 'run';
        const bindings = services.extensions.session(sessionId)?.capture(call);
        if (!bindings)
          throw new MarAgentError(
            'MAR_AGENT_EXTENSION_PROMPT_UNAVAILABLE',
            'Session prompt tool sources are unavailable.'
          );
        const definitions = [...bindings.values()]
          .filter((binding) => binding.available?.(call) !== false)
          .map((binding) => binding.definition)
          .filter(
            (tool) =>
              !(
                sessionSource.type === 'subagent' &&
                (tool.agentScope === 'ROOT_ONLY' ||
                  tool.name.startsWith('agent_') ||
                  tool.name === 'question')
              ) &&
              !(tool.name === 'question' && mode !== 'plan') &&
              !(tool.name === 'view_image' && !model.inputCapabilities.includes('IMAGE')) &&
              !(
                ['code_exec', 'code_exec_wait'].includes(tool.name) &&
                (!model.codeMode || !description.capabilities.includes('code.execute'))
              )
          );
        const byName = new Map(definitions.map((tool) => [tool.name, tool]));
        const tools =
          facts.tools === undefined
            ? definitions
            : facts.tools.flatMap((name) => {
                const tool = byName.get(name);
                return tool ? [tool] : [];
              });
        const executionId = call.executionId ?? defaults?.executionId;
        if (executionId === undefined && host.listExecutionExtensions && !host.listSessionSkills)
          throw new MarAgentError(
            'MAR_AGENT_EXTENSION_PROMPT_UNAVAILABLE',
            'The Host does not provide an idle Session Skill catalog.'
          );
        const hostSkills =
          executionId !== undefined
            ? ((await host.listExecutionExtensions?.({ sessionId, modelId, executionId }))
                ?.skills ?? [])
            : ((await host.listSessionSkills?.({ sessionId, modelId })) ?? []);
        call.signal.throwIfAborted();
        const instructions = await loadAgentInstructions({
          home: description.homeDirectory,
          workspace: instructionWorkspace,
          availableTools: new Set(tools.map((tool) => tool.name)),
          hostSkills,
          ...(settings.workspaceMapping === undefined
            ? {}
            : { workspaceDisplayPath: logicalWorkspace })
        });
        call.signal.throwIfAborted();
        return {
          sections: buildSessionPromptSections(
            tools,
            mode,
            model,
            instruction,
            instructions?.skillCatalog
          ),
          facts: { modelId, mode, tools: tools.map((tool) => tool.name) }
        };
      },
      captureRequest: async (call, input) => {
        call.signal.throwIfAborted();
        return sessionRuntime.requestSnapshots?.capture(input);
      },
      sessionId,
      coordinator: sessionInputs,
      activeExecutionId: () =>
        [...active.keys()]
          .find((key) => key.startsWith(`${sessionId}:`))
          ?.slice(sessionId.length + 1),
      append: appendExtensionMessage,
      messages: async (input, call) => {
        const selection = normalizeSessionMessagesInput(input);
        call.signal.throwIfAborted();
        let target = sessionId;
        let targetModelId: string | undefined;
        if (selection.agentId !== undefined) {
          if (!sessionRuntime.agentsBackend)
            throw new MarAgentError(
              'MAR_AGENT_SESSION_INPUT_UNAVAILABLE',
              'Session child message access is unavailable.'
            );
          const child = await sessionRuntime.agentsBackend.inspect(
            { agentId: selection.agentId },
            call
          );
          target = child.agentId;
          targetModelId = child.modelId;
        }
        call.signal.throwIfAborted();
        const targetRuntime = sessionRuntimes.get(target);
        const requestMessages = targetRuntime?.execution?.requestMessages;
        if (selection.view === 'request' && requestMessages) {
          const messages = requestMessages.read();
          const restored = selection.includeImages
            ? await Promise.all(
                messages.map(async (message) =>
                  message.images?.length
                    ? {
                        ...message,
                        images: await readResourceImages(store, target, message.images)
                      }
                    : message
                )
              )
            : messages;
          call.signal.throwIfAborted();
          return sessionMessagesPage(restored, selection);
        }
        const modelState = services.modelState();
        const requestModel =
          selection.view === 'request'
            ? modelState.models.get(targetModelId ?? modelState.defaultModelId)
            : undefined;
        if (selection.view === 'request' && !requestModel)
          throw new MarAgentError('MAR_AGENT_MODEL_DISABLED', 'Selected model is unavailable.');
        const includeImages =
          selection.includeImages &&
          (requestModel === undefined || requestModel.inputCapabilities.includes('IMAGE'));
        const state = await store.readExecutionState(target);
        call.signal.throwIfAborted();
        const restored = await restoreMessages(store, target, state.contextRecords, {
          includeImages,
          strictImages: includeImages
        });
        call.signal.throwIfAborted();
        if (requestModel) {
          const generation = latestContextualWorldStateGeneration(state.contextRecords);
          const cachedWorld = targetRuntime?.contextualWorldState;
          const world =
            cachedWorld?.generation === generation
              ? cachedWorld
              : parsePersistedContextualWorldState(await store.readContextualWorldState(target));
          call.signal.throwIfAborted();
          return sessionMessagesPage(
            projectSessionRequestMessages(
              restored.messages,
              world?.generation === generation ? (world?.entries ?? []) : [],
              requestModel.inputCapabilities.includes('IMAGE'),
              requestModel.codeMode
            ),
            selection
          );
        }
        return sessionMessagesPage(restored.messages, selection, restored.toolOutcomes);
      },
      launch: async (entry, request, call) => {
        if (sessionSource.type !== 'user')
          throw new MarAgentError(
            'MAR_AGENT_SESSION_INPUT_UNAVAILABLE',
            'Idle subagent input must use its task controller.'
          );
        let resolveInput!: (outcome: CoreSessionActionResult) => void;
        let rejectInput!: (error: unknown) => void;
        const inputCommitted = new Promise<CoreSessionActionResult>((resolve, reject) => {
          resolveInput = resolve;
          rejectInput = reject;
        });
        void inputCommitted.catch(() => undefined);
        const handle = execution(
          request.kind === 'compact' ? 'compact' : 'run',
          {
            prompt:
              request.kind === 'compact'
                ? (request.input.focus ?? DEFAULT_COMPACTION_FOCUS)
                : request.input.text,
            ...(request.kind === 'submit' && request.input.images !== undefined
              ? { images: request.input.images }
              : {})
          },
          {
            automaticInput: true,
            inputCommitted: (recordId) => {
              const outcome = { changed: true, recordId, executionId: handle.executionId };
              recordSessionInputCommit(entry, outcome);
              resolveInput(outcome);
            },
            ...(request.kind === 'submit' ? { promptAdmitted: true } : {}),
            ...(call.actor === 'sdk' && call.extensionId === undefined
              ? {}
              : { inputSource: 'extension' as const }),
            ...(request.kind === 'submit' && request.input.modelText !== undefined
              ? { modelText: request.input.modelText }
              : {}),
            ...(request.kind === 'submit' && request.input.context !== undefined
              ? { inputContext: request.input.context }
              : {}),
            ...(request.kind === 'submit' && request.input.modelContext !== undefined
              ? { modelContext: request.input.modelContext }
              : {}),
            ...(call.actor === 'sdk' && call.extensionId === undefined
              ? {}
              : {
                  extensionSource: extensionInputSource(
                    call,
                    request.kind === 'submit' ? request.input.provenance : undefined,
                    request.kind === 'submit' ? request.input.modelAttribution : undefined
                  )
                })
          }
        );
        void handle.result().then((result) => {
          if (request.kind === 'compact')
            resolveInput({
              changed: result.status === 'completed',
              executionId: handle.executionId
            });
          else
            rejectInput(
              new MarAgentError(
                result.errorCode ??
                  (result.status === 'cancelled'
                    ? 'MAR_AGENT_EXECUTION_CANCELLED'
                    : 'MAR_AGENT_SESSION_INPUT_FAILED'),
                'Execution ended before its input record was committed.'
              )
            );
        }, rejectInput);
        return Object.assign(handle, { inputCommitted });
      },
      diagnose: (code, operationId) =>
        services.extensions.session(sessionId)?.diagnose({ code, operationId, sessionId })
    });
    if (sessionSource.type === 'user')
      sessionRuntime.agentsBackend ??= createExtensionAgentsBackend({
        existingController: () => sessionRuntime.subagents,
        controller: async () => {
          // Access to managed children is not a new Execution admission for their parent.
          services.assertCanStart();
          if (sessionRuntime.subagents === undefined) await openSession(sessionId);
          if (!sessionRuntime.subagents)
            throw new MarAgentError(
              'MAR_AGENT_SUBAGENT_FAILED',
              'Session task controller is unavailable.'
            );
          return sessionRuntime.subagents;
        },
        parent: (controller, call) => {
          const current =
            call.executionId === undefined
              ? undefined
              : controller.parentExecution(call.executionId);
          if (call.executionId !== undefined && !current)
            throw new MarAgentError(
              'MAR_AGENT_SUBAGENT_FAILED',
              'Parent Execution source is unavailable.'
            );
          const state = services.modelState();
          const selected = state.models.get(state.defaultModelId)!;
          return {
            ...(current ?? {
              modelId: selected.id,
              reasoningEffort: selected.defaultReasoningEffort,
              models: state.models,
              emitTerminal: async () => {},
              startTurn: async (turn) => {
                const child = await openSession(turn.sessionId);
                return child.startSubagentTurn({
                  prompt: turn.prompt,
                  modelId: turn.modelId,
                  reasoningEffort: turn.reasoningEffort,
                  role: turn.role,
                  initialMailbox: turn.initialMailbox,
                  turnId: turn.turnId,
                  ...(turn.origin === undefined ? {} : { origin: turn.origin }),
                  ...(turn.delivery === undefined ? {} : { delivery: turn.delivery })
                });
              }
            }),
            operationId: call.operationId,
            origin: call,
            signal: call.signal,
            ...(call.ownerInstanceId === undefined
              ? {}
              : { ownerInstanceId: call.ownerInstanceId }),
            ...(call.extensionId === undefined ? {} : { extensionId: call.extensionId })
          };
        }
      });
    return {
      id: sessionId,
      run: (input) => execution('run', input),
      plan: (input) => execution('plan', input),
      steer: (input) =>
        sessionRuntime.execution?.steer?.(input) ?? Promise.resolve({ status: 'notAccepted' }),
      compact: (input = {}) => {
        const requests = sessionRuntime.execution?.compactRequests;
        if (requests) {
          services.assertSessionAdmission(sessionId);
          return requests.request(input);
        }
        return execution('compact', {
          prompt: input.prompt ?? DEFAULT_COMPACTION_FOCUS,
          ...input
        });
      },
      cancel: async (executionId) => active.get(`${sessionId}:${executionId}`)?.abort(),
      startSubagentTurn: (turn) =>
        execution(
          turn.role === 'explore' ? 'plan' : 'run',
          {
            prompt: turn.prompt,
            modelId: turn.modelId,
            reasoningEffort: turn.reasoningEffort,
            ...(turn.permissionMode === undefined ? {} : { permissionMode: turn.permissionMode })
          },
          {
            publishHostEvents: false,
            ...(turn.origin === undefined ? {} : { signal: turn.origin.signal }),
            inputSource: turn.origin === undefined ? 'parent_agent' : 'extension',
            ...(turn.origin === undefined
              ? {}
              : { extensionSource: extensionInputSource(turn.origin) }),
            initialMailbox: turn.initialMailbox,
            turnId: turn.turnId,
            ...(turn.mcpExecutionScopeId === undefined
              ? {}
              : { mcpExecutionScopeId: turn.mcpExecutionScopeId }),
            ...(turn.delivery ? { delivery: turn.delivery } : {})
          }
        )
    };
  };
  return openSession;
}

function extensionInputSource(
  call: CoreOperationContext,
  provenance?: string,
  modelAttribution?: 'none'
) {
  return {
    operationId: call.operationId,
    actor: call.actor,
    ...(call.extensionId ? { extensionId: call.extensionId } : {}),
    ...(call.ownerInstanceId ? { ownerInstanceId: call.ownerInstanceId } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
    ...(modelAttribution === undefined ? {} : { modelAttribution })
  };
}

function modelAttemptFailureDiagnostic(
  diagnostic: { code: string; message: string },
  summary: ExhaustedModelAttemptSummary | undefined
): { code: string; message: string } {
  if (summary === undefined) return diagnostic;
  const prefix = `Model request failed after ${summary.attempts} attempts (${summary.retries} retries). `;
  const availableCharacters = Math.max(0, 1_000 - [...prefix].length);
  return {
    code: diagnostic.code,
    message: `${prefix}${[...diagnostic.message].slice(0, availableCharacters).join('')}`
  };
}

function projectAppendedModelMessage(input: CoreAppendInput): ModelMessage | undefined {
  if (input.visibility === 'transcript') return undefined;
  return {
    role: 'user',
    contextKind: 'contextual',
    content: input.content,
    ...(input.textBlocks === undefined
      ? {}
      : { textBlocks: input.textBlocks.map((block) => ({ text: block.text })) })
  };
}
