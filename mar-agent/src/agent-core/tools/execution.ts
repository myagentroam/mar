import { MarAgentError, describeMarAgentError } from '../error.js';
import type { ModelEvent } from '../model/contracts.js';
import type { EventPayload } from '../runtime/events.js';
import { toolEventSummary } from '../runtime/event-projection.js';
import { allowsToolCaller } from './callers.js';
import { CodeCellExecutionError } from './code-mode/cells.js';
import { createCodeToolDispatch } from './code-mode/dispatch.js';
import type {
  ClientToolDefinition,
  McpToolCallContext,
  ToolCaller,
  ToolExecutionContext,
  ToolExecutionResult
} from './contracts.js';
import {
  boundedModelToolOutput,
  structuredToolArtifacts,
  structuredToolEventData,
  structuredToolFailureData
} from './output-projection.js';
import type { ToolRuntimeContext, ToolRuntimeImage } from './runtime-context.js';
import { publishModelResources } from '../runtime/resource-publication.js';
import { executeRegisteredTool } from './runtime.js';
import { failedToolResultExtensions } from './result-extensions.js';
import { permissionStopFromError } from './permissions.js';
import { scheduleToolCallBatch, type createSessionToolScheduler } from './scheduler.js';
import type { ToolCall } from './contracts.js';

export type ClientToolCall = Extract<ModelEvent, { type: 'client_tool.call' }>;
export type ExecutedToolCall = {
  call: ClientToolCall;
  content: string;
  images?: ToolExecutionResult['images'];
  sourceImages?: ToolExecutionResult['images'];
  observations?: ToolExecutionResult['observations'];
  calls?: ToolExecutionResult['calls'];
} & ({ failed: false; output: ToolExecutionResult } | { failed: true; error: unknown });

/** One immutable model round's catalog; execution resources remain owned by the SDK/Host. */
export interface RoundToolScope {
  readonly context: Omit<
    ToolRuntimeContext,
    'codeMode' | 'expectedMcpTool' | 'searchMcpTools' | 'recentImages'
  >;
  readonly tools: readonly ClientToolDefinition[];
  readonly expectations: ReadonlyMap<string, McpToolCallContext['expectedTool']>;
  readonly extensionToolNames: ReadonlySet<string>;
  readonly schedule: ReturnType<typeof createSessionToolScheduler>;
  readonly assertLive: () => void;
  readonly assertExecutionLive: () => void;
  readonly emit: (event: EventPayload, assertLive?: () => void) => Promise<void>;
  readonly searchMcpTools: NonNullable<ToolRuntimeContext['searchMcpTools']>;
  readonly recentImages: () => Promise<ToolRuntimeImage[]>;
  readonly captureCodeContext: () => Omit<
    ToolRuntimeContext,
    'signal' | 'codeMode' | 'expectedMcpTool' | 'searchMcpTools'
  >;
  readonly codeModeContext: (
    call: ToolCall & { readonly callId: string }
  ) => Promise<Omit<NonNullable<ToolExecutionContext['codeMode']>, 'invoke'>>;
}

/** Shared raw context construction for physical tools and native calls in a real model round. */
export async function createRoundToolRuntimeContext(
  scope: RoundToolScope,
  call: ToolCall & { readonly callId: string },
  signal: AbortSignal
): Promise<ToolRuntimeContext> {
  scope.assertLive();
  signal.throwIfAborted();
  const codeMode = await scope.codeModeContext(call);
  const recentImages =
    scope.extensionToolNames.has(call.name) ||
    call.name === 'code_exec' ||
    call.name === 'code_exec_wait'
      ? await scope.recentImages()
      : undefined;
  scope.assertLive();
  signal.throwIfAborted();
  const assertSessionLive = scope.assertLive;
  const assertExecutionLive = scope.assertExecutionLive;
  const emitCodeEvent = scope.emit;
  const retainSession = codeMode.retainSession?.bind(codeMode);
  let retained = 0;
  const assertDispatchLive = () => {
    assertSessionLive();
    if (retained === 0) assertExecutionLive();
  };
  return {
    ...scope.context,
    ...(scope.expectations.get(call.name)
      ? { expectedMcpTool: scope.expectations.get(call.name)! }
      : {}),
    searchMcpTools: scope.searchMcpTools,
    signal,
    codeMode: {
      ...codeMode,
      ...(retainSession === undefined
        ? {}
        : {
            retainSession: async () => {
              assertDispatchLive();
              const release = await retainSession();
              retained++;
              let released = false;
              return async () => {
                if (released) return;
                released = true;
                retained--;
                await release();
              };
            }
          }),
      invoke: createCodeToolDispatch({
        context: {
          ...scope.captureCodeContext(),
          ...(recentImages === undefined ? {} : { recentImages })
        },
        tools: scope.tools,
        expectations: scope.expectations,
        parentCallId: call.callId,
        schedule: scope.schedule,
        assertLive: assertDispatchLive,
        emit: (event) => emitCodeEvent(event, assertDispatchLive)
      })
    },
    ...(scope.extensionToolNames.has(call.name) && recentImages !== undefined
      ? { recentImages }
      : {})
  };
}

/** Complete every call in model order even if individual execution fails. */
export async function executeRoundTools(
  calls: readonly ClientToolCall[],
  scope: RoundToolScope
): Promise<ExecutedToolCall[]> {
  const executeCall = async (
    call: ClientToolCall,
    signal: AbortSignal = scope.context.signal,
    caller: ToolCaller = 'direct',
    parentCallId?: string
  ): Promise<ExecutedToolCall> => {
    await scope.emit({
      type: 'tool.started',
      toolName: call.name,
      callId: call.callId,
      ...(parentCallId === undefined ? {} : { parentCallId }),
      input: call.arguments
    });
    try {
      if (call.argumentError)
        throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', call.argumentError);
      if (!scope.tools.some((tool) => tool.name === call.name && allowsToolCaller(tool, caller)))
        throw new MarAgentError(
          'MAR_AGENT_TOOL_NOT_AVAILABLE',
          'Tool is unavailable in this execution.'
        );
      const context = await createRoundToolRuntimeContext(scope, call, signal);
      const runTool = () => {
        signal.throwIfAborted();
        return executeRegisteredTool(call.name, call.arguments, call.callId, context);
      };
      const rawOutput =
        call.name === 'code_exec' || call.name === 'code_exec_wait'
          ? await runTool()
          : await scope.schedule(
              scope.tools.find((tool) => tool.name === call.name),
              runTool
            );
      const publishedImages = await publishModelResources(
        scope.context.host,
        rawOutput.images,
        {
          sessionId: scope.context.sessionId,
          executionId: scope.context.executionId
        },
        scope.context.imageStore
      );
      const output =
        publishedImages === rawOutput.images
          ? rawOutput
          : {
              ...rawOutput,
              ...(publishedImages === undefined ? {} : { images: publishedImages })
            };
      const modelOutput = boundedModelToolOutput(call.name, output.content, output.data);
      const eventSummary = toolEventSummary(output.content);
      const structuredData = structuredToolEventData(call.name, output.data);
      const artifacts = structuredToolArtifacts(output.artifacts);
      await scope.emit({
        type: 'tool.completed',
        ...(output.resultExtensions ? { resultExtensions: output.resultExtensions } : {}),
        toolName: call.name,
        callId: call.callId,
        ...(parentCallId === undefined ? {} : { parentCallId }),
        summary: eventSummary.summary,
        truncated: output.truncated === true || modelOutput.truncated || eventSummary.truncated,
        ...(artifacts === undefined ? {} : { artifacts }),
        ...(structuredData === undefined ? {} : { data: structuredData })
      });
      return {
        call,
        output,
        content: modelOutput.content,
        ...(rawOutput.images?.length ? { sourceImages: rawOutput.images } : {}),
        ...(output.calls
          ? { calls: output.calls.map(({ resultExtensions: _evidence, ...call }) => call) }
          : {}),
        ...(output.observations ? { observations: output.observations } : {}),
        ...(output.images?.length ? { images: output.images } : {}),
        failed: false
      };
    } catch (error) {
      const diagnostic = describeMarAgentError(error, 'MAR_AGENT_HOST_OPERATION_FAILED');
      const partialResult = error instanceof CodeCellExecutionError ? error.result : undefined;
      const publishedPartialImages = await publishModelResources(
        scope.context.host,
        partialResult?.images,
        { sessionId: scope.context.sessionId, executionId: scope.context.executionId },
        scope.context.imageStore
      );
      const partial =
        partialResult !== undefined && publishedPartialImages !== partialResult.images
          ? { ...partialResult, images: publishedPartialImages }
          : partialResult;
      const failureData = structuredToolFailureData(call.name, error);
      const eventData =
        failureData ??
        (partial?.data === undefined
          ? undefined
          : (structuredToolEventData(
              call.name,
              partial.data
            ) as import('./contracts.js').CodeCellEventData));
      await scope.emit({
        type: 'tool.failed',
        ...(failedToolResultExtensions(error)
          ? { resultExtensions: failedToolResultExtensions(error)! }
          : {}),
        toolName: call.name,
        callId: call.callId,
        ...(parentCallId === undefined ? {} : { parentCallId }),
        code: diagnostic.code,
        message: diagnostic.message,
        ...(permissionStopFromError(error)
          ? { permissionStop: permissionStopFromError(error)! }
          : {}),
        ...(eventData === undefined ? {} : { data: eventData })
      });
      return {
        call,
        content:
          partial === undefined
            ? boundedModelToolOutput(
                call.name,
                JSON.stringify({
                  error: diagnostic.code,
                  message: diagnostic.message,
                  ...(permissionStopFromError(error)
                    ? { permissionStop: permissionStopFromError(error)! }
                    : {}),
                  ...(failureData === undefined ? {} : { data: failureData }),
                  ...(error instanceof MarAgentError && error.retryable ? { retryable: true } : {})
                }),
                failureData
              ).content
            : boundedModelToolOutput(call.name, partial.content, partial.data).content,
        ...(partial?.images?.length ? { images: partial.images } : {}),
        ...(partialResult?.images?.length ? { sourceImages: partialResult.images } : {}),
        failed: true,
        ...(partial?.calls
          ? { calls: partial.calls.map(({ resultExtensions: _evidence, ...call }) => call) }
          : {}),
        ...(partial?.observations ? { observations: partial.observations } : {}),
        error
      };
    }
  };

  return scheduleToolCallBatch(calls, scope.tools, executeCall);
}
