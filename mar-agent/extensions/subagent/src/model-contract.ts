import { AgentError } from '@myagentroam/agent';
import { boundedUtf8 } from './snapshot.js';

/** Reject retired arguments before compatibility normalization can discard them. */
export function assertModelArguments(call: {
  readonly name: string;
  readonly arguments: unknown;
}): void {
  const retired =
    call.name === 'agent_start'
      ? ['prompt', 'reasoningEffort']
      : call.name === 'agent_wait'
        ? ['agentId']
        : call.name === 'agent_stop'
          ? ['executionId']
          : [];
  if (!call.arguments || typeof call.arguments !== 'object') return;
  for (const key of retired)
    if (Object.hasOwn(call.arguments, key))
      throw new AgentError(
        'MAR_AGENT_TOOL_INPUT_INVALID',
        `Unsupported argument '${key}' for ${call.name}.`
      );
}

/** Model adapters share receipt vocabulary without changing Session or native SDK contracts. */
export function modelStatus(status: string): string {
  switch (status) {
    case 'completed':
      return 'SUCCEEDED';
    case 'failed':
      return 'FAILED';
    case 'cancelled':
      return 'CANCELLED';
    case 'interrupted':
      return 'INTERRUPTED';
    case 'running':
      return 'RUNNING';
    case 'idle':
      return 'IDLE';
    default:
      return status;
  }
}

export function modelReceipt(
  action: 'start' | 'send' | 'stop',
  input: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { agentId: input.agentId };
  const errors = {
    ...(input.errorCode === undefined ? {} : { code: input.errorCode }),
    ...(typeof input.errorMessage === 'string'
      ? { message: boundedUtf8(input.errorMessage, 1000).value }
      : {})
  };
  if (action === 'start') {
    result.start = {
      status: input.status === 'not-started' ? 'failed' : 'accepted',
      ...(input.status === 'not-started'
        ? {}
        : { executionStatus: modelStatus(String(input.status)) }),
      ...errors
    };
  } else if (action === 'send') {
    result.message = {
      status: input.delivery === 'notAccepted' ? 'notAccepted' : 'accepted',
      ...(input.delivery === 'duplicate' ? { idempotent: true } : {})
    };
  } else {
    result.cancel = {
      executionStatus: modelStatus(String(input.status)),
      ...errors,
      ...(input.permissionStop === undefined ? {} : { permissionStop: input.permissionStop })
    };
  }
  return result;
}
