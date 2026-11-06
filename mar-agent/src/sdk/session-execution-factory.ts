import type { ModelImage } from '../model/image.js';
import { restoreMessages } from '../runtime/context/restore.js';
import { latestModelUsage, reasoningEffortBaseline } from '../runtime/context/usage.js';
import { publicModelUsage } from '../runtime/event-projection.js';
import { truncateModelText } from '../runtime/token-budget.js';
import type { PreparedExecutionRound } from '../runtime/execution.js';
import type {
  SessionModelMessage as ModelMessage,
  SessionModelRequest as ModelRequest
} from '../session/model-request.js';
import type { SessionStore } from '../session/store/contracts.js';
import type { ClientToolDefinition } from '../tools/contracts.js';
import { executeRoundTools, type RoundToolScope } from '../tools/execution.js';
import { rebindMcpToolSearchOutputs } from '../tools/mcp/history.js';
import {
  ExecutionToolPermissions,
  projectPermissionTool,
  resolvePermissionMode,
  withToolPermissions
} from '../tools/permissions.js';
import { createToolWaitInterrupt } from '../tools/wait.js';
import { createExecutionCompactExtension } from './execution-compact-extension.js';
import { generateExecutionCompaction } from './execution-compact-generation.js';
import { createExecutionCompactionFlight } from './execution-compaction-flight.js';
import { createExecutionCompaction } from './execution-compaction.js';
import { ExecutionContextCoordinator } from './execution-context-coordinator.js';
import { createExecutionInput } from './execution-input.js';
import { createExecutionModelContext } from './execution-model-context.js';
import { ExecutionModelLifecycle } from './execution-model-lifecycle.js';
import { createExecutionModelRequest } from './execution-model-request.js';
import { createExecutionRoundPreparer } from './execution-round-preparation.js';
import { prepareExecutionRoundRequest } from './execution-round-request.js';
import { ExecutionToolCatalog, initializeExecutionToolCatalog } from './execution-tool-catalog.js';
import { createExecutionToolScope } from './execution-tool-scope.js';
import type { ResolvedModelConfiguration } from './model-runtime.js';
import { createNativeSteer } from './native-steer.js';
import { projectSessionRequestMessages } from './request-preparation.js';
import { ResourceInputProjection } from './resource-input.js';

import { createHash, randomUUID } from 'node:crypto';
import { AgentError, describeAgentError } from '../error.js';
import { transformCoreModelStream } from '../extensions/model-stream.js';
import type { ExtensionOperationContext } from '../extensions/operation.js';
import { SESSION_CONTEXT_PROVIDER } from '../extensions/session-context.js';
import { invokeCorePromptSubmission } from '../extensions/prompt-input.js';
import {
  SessionInputCoordinator,
  type ExtensionSessionActionResult,
  type ExtensionSessionRequest,
  type SessionInputEntry
} from '../extensions/session-input.js';
import type { HostDescription, AgentHost } from '../host/contracts.js';
import type { ModelAdapter, ModelAttemptDiagnostic, ModelEvent } from '../model/contracts.js';
import { prepareModelConfiguration } from '../model/request-configuration.js';
import type { EnvironmentContextState } from '../prompts/core.js';
import { MAR_AGENT_PROMPT_VERSION, buildSystemPromptSections } from '../prompts/index.js';
import { autoPermissionPrompt } from '../prompts/permissions.js';
import { renderPromptSections } from '../prompts/prompt-sections.js';
import {
  retainedSessionResourcesSnapshot,
  type RetainedSessionResources
} from '../prompts/resources.js';
import type { CompactFlight } from '../runtime/compaction/coordinator.js';
import { CompactionOperation } from '../runtime/compaction/operation.js';
import {
  latestSmartContextTokens,
  type SmartCompactionInput
} from '../runtime/compaction/smart.js';
import { currentLocalTimeContext } from '../runtime/context/environment.js';
import { ContextGcRuntime } from '../runtime/context/gc-runtime.js';
import { loadAgentInstructions, renderAgentInstructions } from '../runtime/context/instructions.js';
import { normalizeMessagesForModel } from '../runtime/context/normalize.js';
import { compactSummaryFromCheckpoint } from '../session/record-projection.js';
import type { ToolHost, ToolRuntimeImage } from '../tools/runtime-context.js';
import { ExecutionToolSources } from './extension-tools.js';
import {
  SessionExecution,
  type ExecutionEventPayload,
  type InternalExecutionHandle,
  type InternalExecutionOptions
} from './session-execution.js';
import { SessionRuntime } from './session-runtime.js';
import type { CreateAgentOptions, ExecutionMode, RunInput } from './types.js';

import type { AgentSessionComposition, SessionServices } from './session-composition.js';

type ModelAttemptPurpose = 'EXECUTION' | 'COMPACTION' | 'TITLE' | 'SUBAGENT';
interface ExhaustedModelAttemptSummary {
  readonly attempts: number;
  readonly retries: number;
}

/** Composes the execution-owned workflow from Session capabilities. */
export function createSessionExecutionFactory(ports: {
  assertCanStart: SessionServices['assertCanStart'];
  extensions: Pick<SessionServices['extensions'], 'operations' | 'prepare' | 'session'>;
  baseTools: SessionServices['extensions']['options']['baseTools'];
  hasCustomAdapters: boolean;
  modelState: SessionServices['modelState'];
  host: ToolHost &
    Pick<
      AgentHost,
      | 'emit'
      | 'requestToolApproval'
      | 'listSessionResources'
      | 'modelUsage'
      | 'listMcpToolCatalog'
      | 'listMcpTools'
      | 'listExecutionExtensions'
    >;
  store: Pick<
    SessionStore,
    | 'acquireSessionLease'
    | 'append'
    | 'readExecutionState'
    | 'readContextualWorldState'
    | 'hasRetainedSessionLease'
    | 'readResource'
    | 'writeContextualWorldState'
    | 'persistInputImages'
    | 'readInputImages'
    | 'persistResource'
    | 'setResourceUrl'
    | 'writeToolResultResource'
    | 'readCodeModeState'
    | 'retainSessionLease'
    | 'commitCodeModeState'
    | 'commitContextGc'
    | 'readPage'
    | 'compact'
  >;
  description: HostDescription;
  settings: Pick<CreateAgentOptions, 'workspaceMapping' | 'systemInstruction'>;
  sessionWriterOwner: object;
  activeExecutionAdapters: AgentSessionComposition['activeExecutionAdapters'];
  sessionId: string;
  sessionRuntime: Pick<
    SessionRuntime,
    | 'assertCanExecute'
    | 'bindExecutionContext'
    | 'deactivateExecution'
    | 'joinRecordProjection'
    | 'registerExecution'
    | 'publishEvent'
    | 'restoreExecutionState'
    | 'scheduleTool'
    | 'sessionBackend'
    | 'unbindExecutionContext'
    | 'unregisterExecution'
    | 'updateContextualWorldState'
    | 'recordRequest'
    | 'completeRequest'
  >;
  sessionSource: Awaited<ReturnType<SessionStore['getSession']>>['source'];
  logicalWorkspace: string;
  instructionWorkspace: string;
  currentEnvironment: EnvironmentContextState;
  buildSessionPromptSections: (
    tools: readonly ClientToolDefinition[],
    mode: ExecutionMode,
    model: ResolvedModelConfiguration,
    instruction: string | undefined,
    skills: string | undefined
  ) => ReturnType<typeof buildSystemPromptSections>;
  sessionAdapter(
    modelId: string,
    models: ReadonlyMap<string, ResolvedModelConfiguration>
  ): ModelAdapter;
  refreshSessionAdapters(generation: number): Promise<void>;
  sessionInputs(): SessionInputCoordinator;
  withRecordProjection<T>(action: () => Promise<T>): Promise<T>;
  appendExtensionMessage(
    entry: SessionInputEntry,
    request: Extract<ExtensionSessionRequest, { kind: 'append' }>,
    call: ExtensionOperationContext
  ): Promise<ExtensionSessionActionResult>;
}) {
  const {
    assertCanStart,
    extensions: extensionManager,
    baseTools: extensionBaseTools,
    hasCustomAdapters,
    modelState,
    host,
    store,
    description,
    settings,
    sessionWriterOwner,
    activeExecutionAdapters,
    sessionId,
    sessionRuntime,
    sessionSource,
    logicalWorkspace,
    instructionWorkspace,
    currentEnvironment,
    buildSessionPromptSections,
    sessionAdapter,
    refreshSessionAdapters,
    sessionInputs,
    withRecordProjection,
    appendExtensionMessage
  } = ports;
  const execution = (
    mode: ExecutionMode,
    input: RunInput,
    internal: InternalExecutionOptions = {}
  ): InternalExecutionHandle => {
    assertCanStart(sessionId);
    sessionRuntime.assertCanExecute();
    const {
      models: executionModels,
      defaultModelId: executionDefaultModelId,
      generation: executionModelGeneration
    } = modelState();
    if (
      mode !== 'compact' &&
      executionModels.get(input.modelId ?? executionDefaultModelId)?.conversationModel === false
    )
      throw new AgentError(
        'MAR_AGENT_MODEL_DISABLED',
        'The selected model is not a conversation model.'
      );
    const executionId = randomUUID(),
      turnId = internal.turnId ?? randomUUID(),
      executionOwner = new SessionExecution(
        sessionId,
        executionId,
        turnId,
        mode,
        sessionSource.type,
        {
          modelId: input.modelId ?? executionDefaultModelId,
          mode: mode === 'compact' ? 'run' : mode,
          models: executionModels,
          generation: executionModelGeneration,
          instruction: settings.systemInstruction
        },
        activeExecutionAdapters
      ),
      controller = executionOwner.controller;
    const compactCoordinator = executionOwner.compact;
    const messageSources = new WeakMap<
      ModelMessage,
      import('../session/store/index.js').SessionRecord
    >();
    let liveModelMessages: readonly ModelMessage[] = [];
    const compactRequests = executionOwner.compactRequests;
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
    const abortSource = () => executionOwner.cancel(internal.signal?.reason);
    internal.signal?.addEventListener('abort', abortSource, { once: true });
    if (internal.signal?.aborted) abortSource();
    let executionEnvironment: EnvironmentContextState = {
      ...currentEnvironment,
      ...currentLocalTimeContext()
    };
    const executionSystemInstruction = executionOwner.snapshot.instruction;
    const executionContext = executionOwner.context;
    sessionRuntime.bindExecutionContext(executionContext);
    const manualCompactionId = mode === 'compact' ? randomUUID() : undefined;
    sessionRuntime.registerExecution(executionOwner);
    const inputs = sessionInputs();
    let acceptsSteer = false;
    let exhaustedModelAttempt: ExhaustedModelAttemptSummary | undefined;
    const eventPorts = {
      hasRetainedLease: () => store.hasRetainedSessionLease(sessionId, sessionWriterOwner),
      persist: async (
        full: import('./types.js').AgentEvent,
        persistent: import('./types.js').AgentEvent
      ) => {
        const stored = await store.append(sessionId, {
          type: full.type,
          payload: persistent,
          executionId,
          turnId
        });
        if (full.type === 'message.completed') {
          const message = liveModelMessages.findLast(
            (item) => item.role === 'assistant' && item.content === full.text
          );
          if (message) messageSources.set(message, stored);
        }
      },
      observe: (event: import('./types.js').AgentEvent) => sessionRuntime.publishEvent(event),
      ...(internal.publishHostEvents === false
        ? {}
        : { publish: (full: import('./types.js').AgentEvent) => host.emit(full) })
    };
    const emit = (event: ExecutionEventPayload, assertLive?: () => void) =>
      executionOwner.emit(event, eventPorts, assertLive);
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
        const operation = executionOwner.orderEvent(async () => {
          await store.append(sessionId, {
            type: 'model.attempt',
            payload: { purpose, ...diagnostic },
            executionId,
            turnId
          });
        });
        return operation;
      };
    const createCompactionOperation = (
      compactionId: string,
      signal: AbortSignal = controller.signal
    ) =>
      new CompactionOperation(signal, (progress) => {
        const operation = executionOwner.orderEvent(async () => {
          await store.append(sessionId, {
            type: 'compact.progress',
            payload: { compactionId, ...progress },
            executionId,
            turnId
          });
        });
        return operation;
      });
    let finalAnswer = '';
    let executionToolSources: ExecutionToolSources | undefined;
    let releaseImageBytes: (() => void) | undefined;
    const contextGc = new ContextGcRuntime();
    let selectedAdapter: ModelAdapter | undefined;
    executionOwner.start({
      scope: (run) => withToolPermissions(permissionPolicy, run),
      prepareProgram: async () => {
        await executionOwner.prepare({
          acquireLease: () => store.acquireSessionLease(sessionId, sessionWriterOwner),
          waitForInputs: () => (inputs.executing ? Promise.resolve() : inputs.idle()),
          bindCommittedInputs: () => {
            executionOwner.bindViews({
              appendedMessages: {
                append(recordId, message) {
                  executionOwner.appendCommittedMessage(recordId, message);
                }
              }
            });
          },
          refreshAdapters: () => refreshSessionAdapters(executionModelGeneration)
        });
        const {
          todo,
          contextRecords,
          generation: contextualWorldStateGeneration,
          world: initialContextualWorldState
        } = await sessionRuntime.restoreExecutionState(store, sessionWriterOwner);
        const compactMayContainAgentInstructions = contextRecords.some(
          (record) => compactSummaryFromCheckpoint(record) !== undefined
        );
        const restored = await restoreMessages(store, sessionId, contextRecords, {
          messageSources,
          // Keep durable references for the retained tail; the Compact snapshot removes images.
          includeImages: true
        });
        let modelLifecycle!: ExecutionModelLifecycle;
        let applyCompactBoundary: (value: number) => void = () => {};
        const modelContext = createExecutionModelContext({
          restored,
          initialContextualWorldState,
          store,
          sessionId,
          executionId,
          turnId,
          mode,
          contextRecords,
          contextualWorldStateGeneration,
          compactMayContainAgentInstructions,
          messageSources,
          updateWorldState: (state) => sessionRuntime.updateContextualWorldState(state),
          environment: () => executionEnvironment,
          instructionSnapshot: () => currentInstructionSnapshot,
          renderInstructions: (previous) => renderAgentInstructions(instructionEntries, previous),
          retainedResourceSnapshot: async () =>
            retainedSessionResourcesSnapshot(await loadRetainedSessionResources()),
          mcpNavigation: () => mcpRegistry.navigation(),
          reportSidecarFailure: () =>
            coreExtensions.diagnose({
              code: 'MAR_AGENT_COMPACT_SIDECAR_PERSIST_FAILED',
              sessionId
            }),
          resetGc: () => contextGc.reset(),
          restoreMcp: () => restoreMcpDiscovery(),
          resetContinuation: () => selected.resetContinuation?.(),
          resetSmartContext: () => {
            modelLifecycle.resetSmart();
          },
          replaceResources: (items) => resourceInput.replace(items),
          adoptGcResources: (state) => resourceInput.adoptGc(state),
          clearAppendedMessages: () => executionOwner.clearAppendedMessages(),
          appendedAfter: (boundary, ids) => executionOwner.appendedAfter(boundary, ids)
        });
        const messages = modelContext.messages;
        const pendingInputs = restored.pendingInputs;
        const waitInterrupt = createToolWaitInterrupt(() => pendingInputs.size > 0);
        liveModelMessages = messages;
        const restoredRecordIds = new Set(contextRecords.map((record) => record.recordId));
        executionOwner.connectMessageProjection(messages, restoredRecordIds);
        let smartInput: SmartCompactionInput | undefined;
        let compactContext!: (input?: {
          readonly focus?: string;
          readonly async?: boolean;
        }) => Promise<boolean>;
        let startCompact!: (input?: {
          readonly focus?: string;
          readonly async?: boolean;
        }) => CompactFlight;
        const { startInitialInput, receiveSteer, appendExtensionContext, appendMailboxMessages } =
          createExecutionInput({
            host,
            store,
            sessionId,
            executionId,
            turnId,
            mode,
            controller,
            inputs,
            messages,
            pendingInputs,
            messageSources,
            modelContext,
            model: () => selectedModel,
            tokens: () => modelLifecycle.smartContextTokens,
            setSmartInput: (value) => {
              smartInput = value;
            },
            withRecordProjection,
            appendExtensionMessage,
            startCompact: () => startCompact,
            compactContext: () => compactContext
          });
        const hasRestoredUserImages = messages.some(
          (message) => message.role === 'user' && Boolean(message.images?.length)
        );
        let modelInputImages: ModelImage[] | undefined;
        const inputImageBytes = new Map<string, ModelImage>();
        const currentExecutionToolImages: ToolRuntimeImage[] = [];
        let currentExecutionUserIndex: number | undefined;
        await emit({
          type: 'execution.started',
          mode,
          permissionMode: permissionPolicy.mode
        });
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
        selectedAdapter = sessionAdapter(input.modelId ?? executionDefaultModelId, executionModels);
        const selectedModel = executionModels.get(input.modelId ?? executionDefaultModelId)!;
        const restoredMessageCount = messages.length;
        const resourceInput = new ResourceInputProjection(
          selectedModel.useResourceUrl === true,
          store,
          sessionId,
          messages,
          {
            records: contextRecords,
            persist: async (state) => {
              await withRecordProjection(() =>
                store.append(sessionId, {
                  type: 'resource.window',
                  payload: state,
                  executionId,
                  turnId
                })
              );
            }
          }
        );
        releaseImageBytes = () => resourceInput.releaseBytes();
        const selected = executionOwner.openMainTurn(
          selectedAdapter,
          hasCustomAdapters && selectedAdapter.createTurnSession === undefined
        );
        const initialUsage = latestModelUsage(contextRecords, selectedModel.id);
        const initialSmartTokens = latestSmartContextTokens(
          contextRecords,
          selectedModel.id,
          selectedModel.contextWindowTokens
        );
        const compactUserTokenLimit = Math.min(
          20_000,
          Math.floor(selectedModel.contextWindowTokens / 8)
        );
        const reasoningEffort = input.reasoningEffort ?? selectedModel.defaultReasoningEffort;
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
        const {
          catalog: mcpCatalog,
          registry: mcpRegistry,
          extensions,
          supplemental: supplementalBindings,
          sources
        } = await initializeExecutionToolCatalog({
          host,
          context: catalogContext,
          models: executionModels,
          messages,
          supplemental: (names) =>
            extensionBaseTools?.(sessionId, { executionId })?.filter(
              (binding) => !names.has(binding.definition.name)
            ) ?? []
        });
        executionToolSources = sources;
        const sourceBindings = sources.bindings;
        const selectedModelForTools = executionModels.get(
          input.modelId ?? executionDefaultModelId
        )!;
        const coreExtensions = await extensionManager.prepare(
          sessionId,
          controller.signal,
          sourceBindings,
          sessionSource.type === 'user' && !internal.automaticInput
        );
        executionOwner.bindViews({ toolSources: sources });
        const operation = <T>(run: (call: ExtensionOperationContext) => T): T =>
          extensionManager.operations.run(
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

        modelLifecycle = new ExecutionModelLifecycle({
          modelId: selectedModel.id,
          contextWindowTokens: selectedModel.contextWindowTokens,
          signal: controller.signal,
          messages,
          turn: selected,
          runtime: sessionRuntime,
          resources: resourceInput,
          stream: streamModel,
          compactPending: () => compactCoordinator.pending,
          startCompact: () => {
            startCompact({ async: true });
          },
          updateBoundary: (value) => applyCompactBoundary(value),
          initialUsage,
          initialSmartTokens
        });
        const transformModelRequest = createExecutionModelRequest({
          sessionId,
          executionId,
          modelId: selectedModel.id,
          source: sessionSource.type,
          compact: mode === 'compact',
          autoPermission: permissionPolicy.mode === 'auto',
          turn: selected,
          hooks: coreExtensions.hooks,
          host,
          capture: captureTools,
          operation,
          usageFailed: () =>
            coreExtensions.diagnose({ code: 'MAR_AGENT_MODEL_USAGE_FAILED', sessionId })
        });
        let instructionSkills: ReadonlyMap<string, unknown> | undefined;
        const toolCatalog = new ExecutionToolCatalog({
          catalog: mcpCatalog,
          registry: mcpRegistry,
          messages,
          model: selectedModelForTools,
          child: sessionSource.type === 'subagent',
          mode,
          codeExecute: description.capabilities.includes('code.execute'),
          capture: captureTools,
          servers: () => coreExtensions.mcp.servers(),
          hasSkills: () => (instructionSkills?.size ?? 0) > 0
        });
        const updateMcpRegistry = () => toolCatalog.updateRegistry();
        updateMcpRegistry();
        rebindMcpToolSearchOutputs(messages, mcpRegistry);
        const availableTools = toolCatalog.available();
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
        instructionSkills = instructionContext?.skills;
        const baseTools = () => toolCatalog.base();
        toolCatalog.refresh();
        const restoreMcpDiscovery = () => toolCatalog.restore();
        const loadRetainedSessionResources = async (): Promise<RetainedSessionResources> => {
          const hostResources = (await host.listSessionResources?.(sessionId)) ?? {
            processes: [] as const
          };
          const provider = coreExtensions.services.resolve(SESSION_CONTEXT_PROVIDER);
          const extensions = (await provider?.resources?.(controller.signal)) ?? [];
          controller.signal.throwIfAborted();
          return {
            ...(hostResources.idleTtlMs === undefined
              ? {}
              : { idleTtlMs: hostResources.idleTtlMs }),
            processes: hostResources.processes,
            ...(hostResources.codeCells ? { codeCells: hostResources.codeCells } : {}),
            extensions: extensions
              .slice(0, 8)
              .map((value) => truncateModelText(value, 32768, 'extension resource').content)
          };
        };
        await modelContext.initializeWorldState();
        const buildExecutionPromptSections = (
          availableTools: readonly ClientToolDefinition[] = toolCatalog.tools,
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
          availableTools: readonly ClientToolDefinition[] = toolCatalog.tools,
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
        const performCompact = (
          input: { readonly focus?: string },
          leaf: (
            input: { readonly focus?: string },
            call: ExtensionOperationContext
          ) => Promise<ExtensionSessionActionResult>
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
                    throw new AgentError(
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
        const captureRoundToolScope = createExecutionToolScope({
          store,
          host,
          sessionId,
          executionId,
          turnId,
          mode,
          controller,
          sessionWriterOwner,
          selectedModel,
          permissionPolicy,
          todo,
          waitInterrupt,
          skills: instructionContext?.skills ?? new Map(),
          coreExtensions,
          operations: extensionManager.operations,
          scheduleTool: sessionRuntime.scheduleTool,
          sources,
          mcpRegistry,
          autoPermissionPrompt,
          currentExecutionToolImages,
          inputImageBytes,
          snapshotTools: () => projectTools(toolCatalog.tools),
          baseTools: () => projectTools(baseTools()),
          captureTools,
          promptComposition,
          smartInput: () => smartInput,
          modelInputImages: () => modelInputImages,
          startCompact: (input) => startCompact(input),
          preparedPrompt: () => preparedCompactPrompt,
          clearPreparedPrompt: () => {
            preparedCompactPrompt = undefined;
          },
          operation,
          emit
        });
        let preparedCompactPrompt:
          Awaited<ReturnType<typeof coreExtensions.composeModelSystem>> | undefined;
        sources.bind(captureRoundToolScope().toolScope);
        let preparingRequestMessages: readonly ModelMessage[] | undefined;
        let preparingRequestBaseLength = 0;
        executionOwner.bindViews({
          requestMessages: {
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
          }
        });
        if (mode !== 'compact') {
          const entered = await startInitialInput({
            input,
            internal,
            restoredImages: hasRestoredUserImages,
            operation,
            admit: (content, call, write) =>
              invokeCorePromptSubmission(coreExtensions.hooks, content, call, write),
            enqueue: (content, call) =>
              sessionRuntime.sessionBackend!.enqueue(
                { kind: 'submit', input: { ...content, delivery: 'idle' } },
                call,
                (request, effective, next) => next(request, effective)
              ),
            project: (actual, metadata) => {
              modelInputImages = actual.images?.map((image) => ({ ...image }));
              messages.push({
                role: 'user',
                content: actual.modelText ?? actual.text,
                metadata,
                ...(modelInputImages?.length ? { images: modelInputImages } : {})
              });
              currentExecutionUserIndex = messages.length - 1;
            }
          });
          if (!entered) return { inputHandled: true as const };
          acceptsSteer = true;
          executionOwner.acceptSteer(
            createNativeSteer({
              executionId,
              inputs,
              signal: controller.signal,
              isOpen: () => acceptsSteer,
              operation,
              admit: (content, call, write) =>
                invokeCorePromptSubmission(coreExtensions.hooks, content, call, write),
              receive: receiveSteer,
              notify: (entry) => emit({ type: 'input.received', entry }),
              wake: () => waitInterrupt.notify(),
              diagnose: () =>
                coreExtensions.diagnose({
                  code: 'MAR_AGENT_STEER_POST_COMMIT_FAILED',
                  sessionId
                })
            })
          );
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
              ? buildExecutionSystemPrompt(toolCatalog.tools, 'run')
              : buildExecutionSystemPrompt();
          const generateCompactExtension = createExecutionCompactExtension({
            modelId: selectedModel.id,
            contextWindowTokens: selectedModel.contextWindowTokens,
            maxOutputTokens: selectedModel.maxOutputTokens,
            hasInterceptor: () => coreExtensions.hooks.hasInterceptors('compact.generate'),
            invoke: (context, signal) =>
              operation((call) =>
                coreExtensions.hooks.invoke(
                  'compact.generate',
                  Object.freeze({ ...context, operationId: call.operationId }),
                  Object.freeze({ ...call, signal }),
                  async () => undefined
                )
              ),
            ...(host.modelUsage === undefined
              ? {}
              : {
                  reportUsage: (usage) =>
                    host.modelUsage!({
                      ...usage,
                      sessionId,
                      executionId,
                      purpose: 'compact',
                      agentRole: sessionSource.type === 'subagent' ? 'subagent' : 'root'
                    })
                })
          });
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
          const contextCoordinator = new ExecutionContextCoordinator({
            initialBoundary: restoredMessageCount,
            messages,
            resources: resourceInput,
            execution: executionOwner,
            model: modelLifecycle,
            context: modelContext,
            compact: compactCoordinator,
            requests: compactRequests,
            signal: controller.signal,
            window: selectedModel.contextWindowTokens,
            gcEnabled: selectedModel.gcEnabled ?? true,
            gc: contextGc,
            gcBase: {
              store,
              sessionId,
              modelId: selectedModel.id,
              contextWindowTokens: selectedModel.contextWindowTokens,
              ...modelConfiguration.contextProjection,
              workspace: logicalWorkspace,
              platform: description.platform
            },
            start: (value) => startCompact(value),
            wait: (value) => compactContext(value),
            activeProcesses: async () => {
              const resources = await host.listSessionResources?.(sessionId).catch(() => undefined);
              return new Set(
                (resources?.processes ?? [])
                  .filter((process) => process.status === 'running')
                  .map((process) => process.processId)
              );
            }
          });
          applyCompactBoundary = (value) => contextCoordinator.setBoundary(value);
          const invalidateCompactUsage = () => {
            modelLifecycle.invalidate();
            requestReasoningEffort = prepareModelConfiguration(selectedModel, reasoningEffort, {
              checkpointAdopted: true
            }).requestReasoningEffort;
          };
          const compactLeaf = createExecutionCompaction({
            mode,
            sessionId,
            executionId,
            turnId,
            model: selectedModel,
            messages,
            pendingInputs,
            messageSources,
            modelContext,
            resourceInput,
            store,
            coordinator: compactCoordinator,
            userTokenLimit: compactUserTokenLimit,
            boundary: () => contextCoordinator.boundary,
            updateBoundary: (value) => {
              contextCoordinator.setBoundary(value);
            },
            snapshotTools: () => projectTools(toolCatalog.tools),
            usage: () => modelLifecycle.usage,
            effort: () => requestReasoningEffort ?? reasoningEffort,
            environment: () => executionEnvironment,
            compose: (tools) =>
              operation((call) =>
                coreExtensions.composeModelSystem(promptComposition(tools, 'run'), call)
              ),
            generate: (snapshot, compactionId, signal) =>
              generateExecutionCompaction({
                snapshot,
                createOperation: () => createCompactionOperation(compactionId, signal),
                withTurn: (run) => executionOwner.withCompactTurn(selectedAdapter!, run),
                generateExtension: generateCompactExtension,
                transformRequest: (request) =>
                  transformModelRequest(request, undefined, selectedModel.id, 'compact'),
                stream: streamModel,
                observeUsage: (usage) =>
                  emit({ type: 'usage.updated', purpose: 'compact', ...publicModelUsage(usage) }),
                onAttemptDiagnostic: recordModelAttempt('COMPACTION')
              }),
            retainedResources: async () =>
              retainedSessionResourcesSnapshot(await loadRetainedSessionResources()),
            withProjection: withRecordProjection,
            recordCommit: (recordId) =>
              inputs.recordCompactCommit({ changed: true, recordId, executionId }),
            invalidateContext: (error) => executionOwner.invalidateContext(error),
            invalidateUsage: invalidateCompactUsage,
            emit
          });
          ({ start: startCompact, wait: compactContext } = createExecutionCompactionFlight({
            coordinator: compactCoordinator,
            executionId,
            manualId: manualCompactionId,
            mode,
            executionSignal: controller.signal,
            compactSignal,
            currentManual: () => Boolean(inputs.currentCompact()),
            markSmartRequested: () => {
              if (smartInput) smartInput.requested = true;
            },
            compact: compactLeaf,
            perform: performCompact,
            emit
          }));
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
          const prepareRound = createExecutionRoundPreparer<
            ModelMessage,
            {
              candidateRequest: ModelRequest;
              request: ModelRequest;
              toolScope: RoundToolScope;
            },
            PreparedExecutionRound<RoundToolScope>
          >({
            prepareInputs: (includeSessionContext) =>
              contextCoordinator.prepareInputs({
                includeSessionContext,
                appendMailbox: appendMailboxMessages,
                appendSessionContext: async () => {
                  await appendExtensionContext(
                    coreExtensions.services.resolve(SESSION_CONTEXT_PROVIDER)
                  );
                },
                refreshTools: () => {
                  updateMcpRegistry();
                  toolCatalog.refresh();
                },
                updateEnvironment: () => {
                  executionEnvironment = { ...currentEnvironment, ...currentLocalTimeContext() };
                }
              }),
            buildCandidate: (continuation) =>
              prepareExecutionRoundRequest({
                messages,
                continuation,
                model: selectedModel,
                requestBase: {
                  promptCacheKey: sessionId,
                  reasoningEffort,
                  ...(requestReasoningEffort === undefined ? {} : { requestReasoningEffort }),
                  ...(modelInputImages?.length ? { images: modelInputImages } : {}),
                  onAttemptDiagnostic: recordModelAttempt('EXECUTION')
                },
                residentTools: () => projectTools(mcpRegistry.projectDirect(baseTools())),
                autoPermission: permissionPolicy.mode === 'auto',
                signal: controller.signal,
                capture: captureRoundToolScope,
                bind: (scope) => sources.bind(scope),
                world: () => modelContext.worldState,
                commitWorld: (world) => modelContext.commitWorldState(world),
                preparing: (next, baseLength) => {
                  preparingRequestMessages = next;
                  preparingRequestBaseLength = baseLength;
                },
                transform: (candidate, bindings) => transformModelRequest(candidate, bindings)
              }),
            adoptLateInput: async () => {
              const lateCoreChange =
                inputs.hasBoundaryCompactPending && (await appendMailboxMessages());
              const lateBlocking = compactRequests.drain((input) =>
                startCompact({
                  ...(input.prompt === undefined ? {} : { focus: input.prompt }),
                  async: input.async === true
                })
              );
              const lateAdopted = lateBlocking && (await compactCoordinator.checkpoint(true));
              return Boolean(lateCoreChange || lateAdopted);
            },
            prepareResources: async ({ candidateRequest, request, toolScope }) => {
              resourceInput.observe(candidateRequest.messages);
              const media =
                selectedModel.gcEnabled === false
                  ? undefined
                  : await resourceInput.gcCandidate(request, candidateRequest.images);
              if (media?.reason === 'HARD_LIMIT') {
                const committed = await contextCoordinator.gc(
                  { request, toolScope },
                  modelLifecycle.usage,
                  media
                );
                if (committed) return { retry: true as const };
              }
              return {
                round: {
                  request: await resourceInput.prepare(
                    request,
                    candidateRequest.images,
                    candidateRequest.messages
                  ),
                  toolScope
                }
              };
            }
          });
          const completed = await executionOwner.runMainLoop({
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
            prepareRound,
            runTools: executeRoundTools,
            startModel: (request) => modelLifecycle.start(request),
            recoverySignal: () => controller.signal,
            compactContext,
            afterModel: (closedPrefixLength, request) =>
              modelLifecycle.afterModel(closedPrefixLength, request),
            observeContextTokens: (tokens) => modelLifecycle.observeTokens(tokens),
            observeUsage: (usage) => modelLifecycle.observeUsage(usage),
            checkpoint: (round, latestUsage) => contextCoordinator.checkpoint(round, latestUsage),
            mailbox: {
              hasPending: () => inputs.hasBoundaryPending && !inputs.executing,
              append: appendMailboxMessages,
              close: () => {
                acceptsSteer = false;
              }
            }
          });
          compactRequests.seal();
          compactRequests.drain((input) =>
            startCompact({
              ...(input.prompt === undefined ? {} : { focus: input.prompt }),
              async: input.async === true
            })
          );
          await compactCoordinator.checkpoint(true).catch(() => {
            controller.signal.throwIfAborted();
            executionOwner.assertContextValid();
          });
          finalAnswer = completed.finalAnswer;
        };
        return {
          run: runPreparedExecution,
          performManualCompact: (run) =>
            performCompact({ focus: input.prompt }, async (effective, call) => {
              await run(effective.focus, call.signal);
              return { changed: true, executionId };
            }),
          finalAnswer: () => finalAnswer,
          permissionStop: () => permissionPolicy.stop
        };
      },
      beforeFailure: async (error) => {
        acceptsSteer = false;
        executionOwner.stopSteer();
        await sessionRuntime.joinRecordProjection();
        await compactCoordinator.close(error).catch(() => undefined);
        executionOwner.retireCompactRequests(
          new AgentError('MAR_AGENT_CANCELLED', 'Execution ended.')
        );
      },
      diagnostic: (error) =>
        modelAttemptFailureDiagnostic(
          describeAgentError(error, 'MAR_AGENT_EXECUTION_FAILED'),
          exhaustedModelAttempt
        ),
      emit,
      endParent: () => {},
      finalize: (failed) =>
        executionOwner.finish({
          failed,
          reason:
            controller.signal.reason ?? new AgentError('MAR_AGENT_CANCELLED', 'Execution ended.'),
          releaseImageBytes: () => releaseImageBytes?.(),
          revokeBindings: () => {
            executionOwner.revokeViews(new AgentError('MAR_AGENT_CANCELLED', 'Execution ended.'));
          },
          closeToolSources: () => {
            executionToolSources?.close();
            executionOwner.detachToolSources();
          },
          detachAbort: () => internal.signal?.removeEventListener('abort', abortSource),
          endParent: () => {},
          deactivate: () => {
            sessionRuntime.unbindExecutionContext(executionContext);
            sessionRuntime.deactivateExecution(executionOwner);
            sessionRuntime.sessionBackend?.kick();
          }
        }),
      settle: (status) => {
        inputs.settleExecution(executionId, status);
        sessionRuntime.unregisterExecution(executionOwner);
      }
    });
    return executionOwner.handle();
  };
  return execution;
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
