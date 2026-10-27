import { bindAgentController } from './extension-agent-controller.js';
import { createExecutionCodeModeContext } from './execution-code-mode.js';
import { currentExecutionImages } from '../tools/output-projection.js';
import { requestSmartCompaction, type SmartCompactionInput } from '../runtime/compaction/smart.js';
import { renderPromptSections } from '../prompts/prompt-sections.js';
import { withToolPermissions } from '../tools/permissions.js';
import type { SessionStore } from '../session/store/contracts.js';
import type { ClientToolDefinition } from '../tools/contracts.js';
import type { ModelImage } from '../model/image.js';
import type { ToolRuntimeContext } from '../tools/runtime-context.js';
import type { RoundToolScope } from '../tools/execution.js';
import type { SessionRuntime } from './session-runtime.js';
import type { ExecutionToolSources } from './extension-tools.js';
import type { ExtensionSession } from '../extensions/session.js';
import type { ExtensionOperations, ExtensionOperationContext } from '../extensions/operation.js';
import type { ExtensionPromptComposition } from '../extensions/prompt-composition.js';
import type { DeferredMcpRegistry } from '../tools/mcp/tool-search.js';
import type { SubagentSessionController } from '../subagent/session-controller.js';
import type { ResolvedModelConfiguration } from './model-runtime.js';
import type { ExecutionMode } from './types.js';
import type { CompactFlight } from '../runtime/compaction/coordinator.js';
import type { ExecutionEventPayload } from './session-execution.js';

/** Capture immutable round tool identities, parent scope and resource capabilities. */
export function createExecutionToolScope(input: {
  readonly store: Pick<
    SessionStore,
    | 'readResource'
    | 'writeToolResultResource'
    | 'readCodeModeState'
    | 'retainSessionLease'
    | 'append'
    | 'commitCodeModeState'
    | 'persistResource'
    | 'setResourceUrl'
  >;
  readonly host: ToolRuntimeContext['host'];
  readonly sessionId: string;
  readonly executionId: string;
  readonly turnId: string;
  readonly mode: ExecutionMode;
  readonly controller: AbortController;
  readonly sessionWriterOwner: object;
  readonly selectedModel: ResolvedModelConfiguration;
  readonly permissionPolicy: NonNullable<ToolRuntimeContext['permissionPolicy']>;
  readonly todo: ToolRuntimeContext['todo'];
  readonly waitInterrupt: ToolRuntimeContext['waitInterrupt'];
  readonly skills: ToolRuntimeContext['skills'];
  readonly subagents:
    | Pick<SubagentSessionController, 'captureParentFrame' | 'captureExecution' | 'modelMessages'>
    | undefined;
  readonly coreExtensions: Pick<
    ExtensionSession,
    | 'epoch'
    | 'agentAction'
    | 'withTools'
    | 'invoke'
    | 'assertLive'
    | 'pin'
    | 'diagnose'
    | 'composeModelSystem'
  >;
  readonly operations: Pick<ExtensionOperations, 'enter'>;
  readonly scheduleTool: SessionRuntime['scheduleTool'];
  readonly sources: Pick<ExecutionToolSources, 'withFrame' | 'assertActive'>;
  readonly mcpRegistry: Pick<DeferredMcpRegistry, 'expectedTool' | 'expose'>;
  readonly autoPermissionPrompt: string;
  readonly currentExecutionToolImages: Parameters<typeof currentExecutionImages>[1];
  readonly inputImageBytes: Map<string, ModelImage>;
  snapshotTools(): readonly ClientToolDefinition[];
  baseTools(): readonly ClientToolDefinition[];
  captureTools(): ReturnType<ExtensionSession['capture']>;
  promptComposition(
    tools: readonly ClientToolDefinition[],
    mode: ExecutionMode
  ): ExtensionPromptComposition & { sections: ExtensionPromptComposition['sections'] };
  smartInput(): SmartCompactionInput | undefined;
  modelInputImages(): readonly ModelImage[] | undefined;
  startCompact(input: { async: true }): CompactFlight;
  preparedPrompt(): Awaited<ReturnType<ExtensionSession['composeModelSystem']>> | undefined;
  clearPreparedPrompt(): void;
  operation<T>(run: (call: ExtensionOperationContext) => T): T;
  emit(event: ExecutionEventPayload, assertLive?: () => void): Promise<void>;
}) {
  const {
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
    skills,
    subagents,
    coreExtensions,
    operations,
    scheduleTool,
    sources,
    mcpRegistry,
    autoPermissionPrompt,
    currentExecutionToolImages,
    inputImageBytes,
    snapshotTools,
    baseTools,
    captureTools,
    promptComposition,
    smartInput,
    modelInputImages,
    startCompact,
    preparedPrompt,
    clearPreparedPrompt,
    operation,
    emit
  } = input;
  const captureRoundToolScope = () => {
    const roundTools = snapshotTools();
    const availableBindings = captureTools();
    const roundBindings = new Map(
      roundTools.map((tool) => [tool.name, availableBindings.get(tool.name)!])
    );
    const defaultComposition = promptComposition(roundTools, mode === 'compact' ? 'run' : mode);
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
    const roundSmartInput = smartInput();
    const toolContext: ToolRuntimeContext = {
      imageStore: store,
      host: host,
      requestSmartCompact: () => {
        controller.signal.throwIfAborted();
        requestSmartCompaction(
          roundSmartInput === smartInput() ? roundSmartInput : undefined,
          () => {
            // The Session owns this background operation, not the short-lived tool callback.
            operations.enter(
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
            subagents: bindAgentController(
              subagents.captureExecution(executionId),
              coreExtensions.agentAction
            ),
            subagentMessages: subagents.modelMessages
          }),
      mode,
      sessionId,
      executionId,
      modelId: selectedModel.id,
      signal: controller.signal,
      waitInterrupt,
      emit,
      skills: skills,
      invokeTool: (call, context, caller) => {
        const invoke = () =>
          coreExtensions.withTools(roundBindings, scheduleTool, () =>
            withToolPermissions(permissionPolicy, () =>
              operations.enter(
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
        (modelInputImages() ?? []).map(async (image) => {
          if (image.dataBase64 !== undefined || image.resourceId === undefined) return image;
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
            (binding) => binding.source.kind === 'host' || binding.source.kind === 'extension'
          )
          .map((binding) => binding.definition.name)
      ),
      schedule: scheduleTool,
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
          base: baseTools(),
          window: selectedModel.contextWindowTokens,
          system: systemPrompt
        }),
      recentImages,
      captureCodeContext: () => ({
        ...toolContext,
        waitInterrupt: undefined
      }),
      codeModeContext: createExecutionCodeModeContext({
        store,
        sessionId,
        executionId,
        turnId,
        writerOwner: sessionWriterOwner,
        supportsImages: selectedModel.inputCapabilities.includes('IMAGE'),
        tools: roundTools,
        permissionStop: (callId) =>
          permissionPolicy.stop?.source.parentCallId === callId ? permissionPolicy.stop : undefined,
        assertLive: () => coreExtensions.assertLive(),
        pin: () => coreExtensions.pin(),
        cleanupFailed: () =>
          coreExtensions.diagnose({ code: 'MAR_AGENT_EXTENSION_CLEANUP_FAILED', sessionId })
      })
    };
    return {
      roundTools,
      roundBindings,
      toolScope,
      async composeSystemPrompt() {
        const composed =
          preparedPrompt() ??
          (await operation((call) => coreExtensions.composeModelSystem(defaultComposition, call)));
        clearPreparedPrompt();
        systemPrompt = composed.text;
        return composed;
      }
    };
  };
  return captureRoundToolScope;
}
