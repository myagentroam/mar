import { randomUUID } from 'node:crypto';
import { MarAgentError, describeMarAgentError } from '../../error.js';
import type { ClientToolDefinition } from '../../model/contracts.js';
import type { MarAgentEvent } from '../../runtime/events.js';
import { toolEventSummary } from '../../runtime/event-projection.js';
import { allowsToolCaller } from '../callers.js';
import type { McpToolCallContext, ToolCall, ToolExecutionResult } from '../contracts.js';
import {
  boundedModelToolOutput,
  structuredToolEventData,
  structuredToolFailureData
} from '../output-projection.js';
import type { ToolRuntimeContext } from '../runtime-context.js';
import { executeRegisteredTool } from '../runtime.js';
import { failedToolResultExtensions } from '../result-extensions.js';
import { permissionStopFromError } from '../permissions.js';
import type { createSessionToolScheduler } from '../scheduler.js';

type ToolEvent = Extract<
  MarAgentEvent,
  { type: 'tool.started' | 'tool.completed' | 'tool.failed' }
>;
type Payload<T = ToolEvent> = T extends ToolEvent
  ? Omit<T, 'eventId' | 'sequence' | 'timestamp' | 'sessionId' | 'executionId' | 'turnId'>
  : never;

/** Capture only the cell's immutable dispatch identity, never the model loop or its AbortSignal. */
export function createCodeToolDispatch(input: {
  context: Omit<ToolRuntimeContext, 'signal' | 'codeMode' | 'expectedMcpTool' | 'searchMcpTools'>;
  tools: readonly ClientToolDefinition[];
  expectations: ReadonlyMap<string, McpToolCallContext['expectedTool']>;
  parentCallId: string;
  schedule: ReturnType<typeof createSessionToolScheduler>;
  assertLive: () => void;
  emit: (event: Payload) => Promise<void>;
}) {
  const definitions = new Map(input.tools.map((tool) => [tool.name, tool]));
  return async (call: ToolCall, signal: AbortSignal): Promise<ToolExecutionResult> => {
    input.assertLive();
    const definition = definitions.get(call.name);
    if (!definition || !allowsToolCaller(definition, 'programmatic'))
      throw new MarAgentError(
        'MAR_AGENT_TOOL_NOT_AVAILABLE',
        'The requested nested tool is unavailable.'
      );
    return input.schedule(definition, async () => {
      input.assertLive();
      signal.throwIfAborted();
      const callId = call.callId ?? randomUUID();
      const identity = { toolName: call.name, callId, parentCallId: input.parentCallId };
      await input.emit({ type: 'tool.started', ...identity, input: call.arguments });
      try {
        input.assertLive();
        signal.throwIfAborted();
        const expected = input.expectations.get(call.name);
        const result = await executeRegisteredTool(
          call.name,
          call.arguments,
          callId,
          {
            ...input.context,
            parentCallId: input.parentCallId,
            signal,
            ...(expected ? { expectedMcpTool: expected } : {})
          },
          'programmatic'
        );
        const bounded = boundedModelToolOutput(call.name, result.content, result.data);
        const data = structuredToolEventData(call.name, result.data);
        const preview = toolEventSummary(result.content);
        input.assertLive();
        await input.emit({
          type: 'tool.completed',
          ...(result.resultExtensions ? { resultExtensions: result.resultExtensions } : {}),
          ...identity,
          summary: preview.summary,
          ...(data === undefined ? {} : { data }),
          truncated: result.truncated === true || bounded.truncated || preview.truncated,
          ...(result.artifacts ? { artifacts: result.artifacts } : {})
        });
        return {
          ...result,
          content: bounded.content,
          truncated: result.truncated === true || bounded.truncated
        };
      } catch (error) {
        // Retirement must not enqueue a failure event into the replacement Session epoch.
        try {
          input.assertLive();
        } catch {
          throw error;
        }
        const diagnostic = describeMarAgentError(error, 'MAR_AGENT_HOST_OPERATION_FAILED');
        const data = structuredToolFailureData(call.name, error);
        await input.emit({
          type: 'tool.failed',
          ...(failedToolResultExtensions(error)
            ? { resultExtensions: failedToolResultExtensions(error)! }
            : {}),
          ...identity,
          code: diagnostic.code,
          message: diagnostic.message,
          ...(permissionStopFromError(error)
            ? { permissionStop: permissionStopFromError(error)! }
            : {}),
          ...(data === undefined ? {} : { data })
        });
        throw error;
      }
    });
  };
}
