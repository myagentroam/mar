import type { ClientToolDefinition } from '../contracts.js';

import type { ToolRuntimeContext } from '../runtime-context.js';
import { AgentError } from '../../error.js';

export const agentCancelToolDefinition: ClientToolDefinition = {
  name: 'agent_cancel',
  allowedCallers: ['direct'],
  parallelSafety: 'serial',
  description:
    'Idempotently cancel a child agent using the agentId returned by agent_start. For an exec processId, use exec_wait with action:"cancel" instead (tools.exec_wait in Code Mode). Waits for a running task to reach cancelled and returns its agentId and description.',
  inputSchema: {
    type: 'object',
    properties: { agentId: { type: 'string' } },
    required: ['agentId'],
    additionalProperties: false
  }
};

export async function executeAgentCancel(arguments_: unknown, context: ToolRuntimeContext) {
  if (!arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)) return invalid();
  const input = arguments_ as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => key !== 'agentId') ||
    typeof input.agentId !== 'string' ||
    input.agentId.trim().length === 0
  )
    return invalid();
  if (!context.subagents)
    throw new AgentError('MAR_AGENT_SUBAGENT_RECURSION_DISABLED', 'Subagents cannot recurse.');
  const task = await context.subagents.cancel(input.agentId);
  return { content: JSON.stringify(task), data: task };
}

function invalid(): never {
  throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Agent cancellation input is invalid.');
}
