import { waitForToolCondition } from '../tools/wait.js';
import { MarAgentError } from '../error.js';
import type { SubagentWaitMode } from './contracts.js';

/** Validate the entire target set before any observation can be consumed. */
export function parseAgentWaitTargets(
  input: { agentId?: unknown; agentIds?: unknown; mode?: unknown },
  maxAgents = Infinity
): { agentIds?: string[]; mode?: SubagentWaitMode } {
  if (input.agentIds === undefined || input.agentIds === null) {
    if (input.mode !== undefined && input.mode !== null) invalid();
    return {};
  }
  if (
    (input.agentId !== undefined && input.agentId !== null) ||
    !Array.isArray(input.agentIds) ||
    input.agentIds.length === 0 ||
    input.agentIds.length > maxAgents ||
    input.agentIds.some((id) => typeof id !== 'string' || !id.trim()) ||
    (input.mode !== undefined &&
      input.mode !== null &&
      input.mode !== 'any' &&
      input.mode !== 'all')
  )
    invalid();
  const agentIds = (input.agentIds as string[]).map((id) => id.trim());
  if (new Set(agentIds).size !== agentIds.length) invalid();
  return { agentIds, mode: input.mode === 'all' ? 'all' : 'any' };
}

function invalid(): never {
  throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Agent wait targets are invalid.');
}

export { waitDeadline } from '../tools/wait.js';

/** A group owns one listener and one deadline; readiness never consumes observations. */
export async function waitForAgentCondition(
  input: Parameters<typeof waitForToolCondition>[0]
): Promise<boolean> {
  return (await waitForToolCondition(input)) === 'ready';
}
