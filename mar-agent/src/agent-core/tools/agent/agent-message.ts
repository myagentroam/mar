import { MarAgentError } from '../../error.js';
import type { ClientToolDefinition } from '../../model/contracts.js';
import type { ToolRuntimeContext } from '../runtime-context.js';
import { TOOL_EXECUTION_LIMITS } from '../execution-limits.js';
import type { SubagentMessageOptions } from '../../subagent/scheduler.js';

export const agentMessageToolDefinition: ClientToolDefinition = {
  name: 'agent_message',
  allowedCallers: ['direct'],
  parallelSafety: 'serial',
  description:
    'Send a real user message to an existing child agent. Default delivery=append inserts guidance into a running child turn at the next safe boundary after the current model response or complete tool batch. Explicit delivery=replace immediately requests cancellation, waits for the old turn to close, then starts a new turn in the same Session. When idle, either mode starts a new turn using persisted history. Returns messageId, turnId, deliveryStatus, current status, and model metadata without repeating the child’s previous latestMessage, latestActivity, summary, or verification evidence. accepted means queued in memory; applied means persisted in model context, not that the guidance has been executed. Use agent_wait for subsequent progress or completion. Does not wait for the new task to complete or roll back existing side effects.',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string' },
      delivery: { type: 'string', enum: ['append', 'replace'], default: 'append' },
      message: {
        type: 'string',
        description: 'Non-empty follow-up message for the existing child Session.'
      }
    },
    required: ['agentId', 'message'],
    additionalProperties: false
  }
};

export async function executeAgentMessage(arguments_: unknown, context: ToolRuntimeContext) {
  const input = parseAgentMessageInput(arguments_);
  if (!context.subagents)
    throw new MarAgentError('MAR_AGENT_SUBAGENT_RECURSION_DISABLED', 'Subagents cannot recurse.');
  const task = await context.subagents.message(input.agentId, input.message, {
    delivery: input.delivery ?? 'append',
    signal: context.signal
  });
  return { content: JSON.stringify(task), data: task };
}

function parseAgentMessageInput(value: unknown): {
  agentId: string;
  message: string;
  delivery?: SubagentMessageOptions['delivery'];
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !['agentId', 'message', 'delivery'].includes(key)) ||
    (input.delivery !== undefined &&
      input.delivery !== null &&
      input.delivery !== 'append' &&
      input.delivery !== 'replace') ||
    typeof input.agentId !== 'string' ||
    input.agentId.trim().length === 0 ||
    typeof input.message !== 'string' ||
    input.message.trim().length === 0 ||
    Buffer.byteLength(input.message) > TOOL_EXECUTION_LIMITS.subagentMessageMaxBytes
  )
    return invalid();
  return {
    agentId: input.agentId.trim(),
    message: input.message,
    ...(input.delivery === 'append' || input.delivery === 'replace'
      ? { delivery: input.delivery }
      : {})
  };
}

function invalid(): never {
  throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Agent message input is invalid.');
}
