import { randomUUID } from 'node:crypto';
import { AgentError } from '../error.js';
import { AnthropicMessagesAdapter } from '../model/anthropic-messages.js';
import { OpenAiResponsesAdapter } from '../model/openai-responses.js';
import { projectModelRequest } from '../sdk/model-input-projection.js';
import {
  resolveModelDefaultReasoningEffort,
  type AgentModelConfiguration,
  type AgentReasoningEffort
} from '../model/configuration.js';
import type { ModelAdapter, ModelAttemptDiagnostic, ModelUsage } from '../model/contracts.js';
import type { ExtensionCompactMessage } from '../extensions/compaction.js';
import type { ClientToolDefinition, ToolCall } from '../tools/contracts.js';

export interface GenerateModelTextInput {
  readonly onModelUsage?: (
    usage: import('../model/usage-observer.js').ModelRequestUsage
  ) => Promise<void> | void;
  readonly onModelUsageFailure?: () => void;
  readonly model: AgentModelConfiguration;
  readonly system: string;
  readonly messages: readonly ExtensionCompactMessage[];
  /** Declarative client tools only. Returned calls are never executed or continued here. */
  readonly tools?: readonly ClientToolDefinition[];
  readonly promptCacheKey?: string;
  readonly cachePrefixMessages?: number;
  readonly reasoningEffort?: AgentReasoningEffort;
  readonly outputLimit?: number;
  readonly signal: AbortSignal;
  readonly onAttemptDiagnostic?: (diagnostic: ModelAttemptDiagnostic) => Promise<void> | void;
}

export interface GenerateModelTextResult {
  readonly text: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly usage?: ModelUsage;
}

/** One request using the SDK transports, without tool execution or a Session. */
export async function generateModelText(
  input: GenerateModelTextInput
): Promise<GenerateModelTextResult | undefined> {
  input.signal.throwIfAborted();
  if (!input.model.enabled) return undefined;
  const tools = input.tools ?? [];
  // Standalone calls expose only the caller's declared client tools, never hosted search.
  const model = { ...input.model, hostedWebSearch: false };
  const adapter: ModelAdapter =
    input.model.protocol === 'OPENAI_RESPONSES'
      ? new OpenAiResponsesAdapter(model)
      : new AnthropicMessagesAdapter(model);
  let text = '';
  let completed = false;
  const toolCalls: ToolCall[] = [];
  let usage: ModelUsage | undefined;
  try {
    for await (const event of adapter.start(
      projectModelRequest({
        retryState: { attempts: 0, maxAttempts: 1 },
        usageRequestId: randomUUID(),
        ...(input.onModelUsage === undefined ? {} : { onModelUsage: input.onModelUsage }),
        ...(input.onModelUsageFailure === undefined
          ? {}
          : { onModelUsageFailure: input.onModelUsageFailure }),
        system: input.system,
        ...(input.cachePrefixMessages === undefined
          ? {}
          : { cachePrefixMessages: input.cachePrefixMessages }),
        messages: input.messages,
        tools,
        allowTools: tools.length > 0,
        toolChoice: tools.length > 0 ? 'auto' : 'none',
        reasoningEffort: input.reasoningEffort ?? resolveModelDefaultReasoningEffort(input.model),
        ...(input.promptCacheKey === undefined ? {} : { promptCacheKey: input.promptCacheKey }),
        ...(input.onAttemptDiagnostic ? { onAttemptDiagnostic: input.onAttemptDiagnostic } : {}),
        ...(input.outputLimit === undefined ? {} : { outputLimit: input.outputLimit })
      }),
      input.signal
    )) {
      input.signal.throwIfAborted();
      if (event.type === 'text.completed' && (event.phase ?? 'final_answer') === 'final_answer')
        text = event.text.trim();
      else if (event.type === 'usage') usage = event.usage;
      else if (event.type === 'completed')
        completed =
          event.reason === 'completed' || (event.reason === 'tool_use' && toolCalls.length > 0);
      else if (event.type === 'client_tool.call') {
        if (!tools.some((tool) => tool.name === event.name) || event.argumentError !== undefined)
          throw new AgentError(
            'MAR_AGENT_MODEL_PROTOCOL_ERROR',
            'Standalone generation returned an undeclared tool or invalid tool arguments.'
          );
        toolCalls.push({ name: event.name, callId: event.callId, arguments: event.arguments });
      }
    }
    input.signal.throwIfAborted();
    return completed && (text || toolCalls.length > 0)
      ? {
          text,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          ...(usage === undefined ? {} : { usage })
        }
      : undefined;
  } finally {
    await adapter.close?.();
  }
}
