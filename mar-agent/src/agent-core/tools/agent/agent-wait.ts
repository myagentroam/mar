import type { ClientToolDefinition } from '../../model/contracts.js';
import type { ToolRuntimeContext } from '../runtime-context.js';
import { MarAgentError } from '../../error.js';
import { TOOL_EXECUTION_LIMITS } from '../execution-limits.js';
import { parseAgentWaitTargets } from '../../subagent/wait.js';

export const agentWaitToolDefinition: ClientToolDefinition = {
  name: 'agent_wait',
  allowedCallers: ['direct'],
  parallelSafety: 'serial',
  description:
    'Read or wait a bounded time for a child agent result. Unread child messages and terminal results are supplied automatically before the next model request. Wait only when the next local step depends on the child result; otherwise continue useful non-overlapping work. waitFor defaults to "completion"; use "message" only when a fresh public commentary/final message would change the next decision. Omit agentId to wait for whichever live child returns first, matching Codex-style untargeted waiting and avoiding UUID transcription; provide the exact agentId returned by agent_start only when observing a specific child. If no child is live, untargeted waiting reads the most recently created child. For an exec processId, use exec_wait instead (tools.exec_wait in Code Mode). Omitting waitMs waits up to 30 seconds by default; waitMs=0 returns the current snapshot immediately. Positive waits range up to 5 minutes, and positive values below 10 seconds are raised to 10 seconds. When blocked on a live child result, prefer one 300000 ms completion wait rather than repeated short waits. Use agentIds with mode any (default) or all to wait for an explicit non-empty set of up to 8 distinct child IDs; never combine agentId and agentIds or use mode without agentIds. mode and waitFor are independent. A group uses one deadline and returns mode, waitFor, waitOutcome, agents in input order, and pendingAgentIds. Failed, cancelled and interrupted turns also satisfy completion; terminal state satisfies message waits too. Group waitMs=0 returns only snapshots without consuming messages. Single-target and untargeted results include waitOutcome as snapshot, message, completion, or timeout plus the real agentId and description. A message or timeout with unread progress includes the newly observed public message; first terminal results follow the result projection below. Snapshots and repeated observations omit previously observed message text. latestActivity can still identify a public message or bounded tool started/completed/failed status. A queued or running result is not completion. A message wait consumes only the latest unread public message in the current Session runtime; tool activity does not wake it, and parent cancellation preserves unread progress for a later Execution. waitOutcome distinguishes snapshot, message, completion, and timeout. A foreground steer may return interrupted with reason=steer without cancelling any child. Do not use message waits as heartbeat checks or request progress merely to confirm that a child is still running. First terminal results retain bounded summary and changedFiles, without automatic command or read records. A final latestMessage fully covered by the complete summary is omitted while its turnId is retained. Use public child conclusions and relevant file references to avoid repeating the full exploration, while independently checking consequential edits and claims.',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string' },
      agentIds: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        maxItems: TOOL_EXECUTION_LIMITS.agentWaitMaxAgents,
        uniqueItems: true,
        description: 'Explicit child-agent set. Mutually exclusive with agentId.'
      },
      mode: {
        type: 'string',
        enum: ['any', 'all'],
        default: 'any',
        description: 'For agentIds only: return when any or all selected children satisfy waitFor.'
      },
      waitFor: {
        type: 'string',
        enum: ['completion', 'message'],
        default: 'completion',
        description:
          'Wait for terminal completion or for the latest unread public message. Terminal state ends either wait.'
      },
      waitMs: {
        type: 'integer',
        minimum: TOOL_EXECUTION_LIMITS.agentWaitMinWaitMs,
        maximum: TOOL_EXECUTION_LIMITS.agentWaitMaxWaitMs,
        default: TOOL_EXECUTION_LIMITS.agentWaitDefaultWaitMs,
        description: `Timeout in milliseconds. Defaults to ${TOOL_EXECUTION_LIMITS.agentWaitDefaultWaitMs}, min ${TOOL_EXECUTION_LIMITS.agentWaitMinWaitMs}, max ${TOOL_EXECUTION_LIMITS.agentWaitMaxWaitMs}. Zero returns immediately. Positive values below ${TOOL_EXECUTION_LIMITS.agentWaitWaitFloorMs} are raised to ${TOOL_EXECUTION_LIMITS.agentWaitWaitFloorMs}.`
      }
    },
    additionalProperties: false
  }
};

export async function executeAgentWait(arguments_: unknown, context: ToolRuntimeContext) {
  const value = parseAgentWaitInput(arguments_);
  const subagents = context.subagents;
  if (!subagents)
    throw new MarAgentError('MAR_AGENT_SUBAGENT_RECURSION_DISABLED', 'Subagents cannot recurse.');
  const options = {
    waitMs: value.waitMs ?? TOOL_EXECUTION_LIMITS.agentWaitDefaultWaitMs,
    waitFor: value.waitFor ?? 'completion',
    signal: context.signal,
    waitInterrupt: context.waitInterrupt
  };
  const task =
    value.agentIds !== undefined
      ? await subagents.outputMany(value.agentIds, { ...options, mode: value.mode ?? 'any' })
      : value.agentId === undefined
        ? await subagents.outputAny(options)
        : await subagents.output(value.agentId, options);
  return { content: JSON.stringify(task), data: task };
}

function parseAgentWaitInput(value: unknown): {
  agentId?: string;
  agentIds?: string[];
  mode?: 'any' | 'all';
  waitFor?: 'completion' | 'message';
  waitMs?: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidAgentWait();
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !['agentId', 'agentIds', 'mode', 'waitFor', 'waitMs'].includes(key)
    ) ||
    (input.agentId !== undefined &&
      input.agentId !== null &&
      (typeof input.agentId !== 'string' || input.agentId.trim().length === 0)) ||
    (input.waitFor !== undefined &&
      input.waitFor !== null &&
      input.waitFor !== 'completion' &&
      input.waitFor !== 'message') ||
    (input.waitMs !== undefined &&
      input.waitMs !== null &&
      (!Number.isInteger(input.waitMs) ||
        (input.waitMs as number) < TOOL_EXECUTION_LIMITS.agentWaitMinWaitMs ||
        (input.waitMs as number) > TOOL_EXECUTION_LIMITS.agentWaitMaxWaitMs))
  )
    return invalidAgentWait();
  return {
    ...parseAgentWaitTargets(input, TOOL_EXECUTION_LIMITS.agentWaitMaxAgents),
    ...(typeof input.agentId === 'string' ? { agentId: input.agentId.trim() } : {}),
    ...(input.waitFor === 'completion' || input.waitFor === 'message'
      ? { waitFor: input.waitFor }
      : {}),
    ...(typeof input.waitMs === 'number' ? { waitMs: input.waitMs } : {})
  };
}

function invalidAgentWait(): never {
  throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Agent wait input is invalid.');
}
