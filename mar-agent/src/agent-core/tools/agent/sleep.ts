import { MarAgentError } from '../../error.js';
import type { ClientToolDefinition } from '../../model/contracts.js';
import { TOOL_EXECUTION_LIMITS } from '../execution-limits.js';
import type { ToolRuntimeContext } from '../runtime-context.js';
import { waitForToolCondition } from '../wait.js';

export interface SleepResult {
  durationMs: number;
  elapsedMs: number;
  wakeReason: 'elapsed' | 'steer' | 'subagent_message';
}

export const sleepToolDefinition: ClientToolDefinition = {
  name: 'sleep',
  allowedCallers: ['direct'],
  parallelSafety: 'serial',
  description:
    'Pause for up to durationMs milliseconds. Returns early when user input or a new public subagent message is available. Returns elapsed time and the wake reason.',
  inputSchema: {
    type: 'object',
    properties: {
      durationMs: {
        type: 'integer',
        minimum: 1,
        maximum: TOOL_EXECUTION_LIMITS.sleepMaxDurationMs
      }
    },
    required: ['durationMs'],
    additionalProperties: false
  }
};

export async function executeSleep(
  arguments_: unknown,
  context: ToolRuntimeContext,
  callId: string
) {
  const durationMs =
    arguments_ && typeof arguments_ === 'object' && !Array.isArray(arguments_)
      ? (arguments_ as Record<string, unknown>).durationMs
      : undefined;
  if (
    typeof durationMs !== 'number' ||
    !Number.isInteger(durationMs) ||
    durationMs < 1 ||
    durationMs > TOOL_EXECUTION_LIMITS.sleepMaxDurationMs
  )
    throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Sleep duration is out of range.');

  context.signal.throwIfAborted();
  const started = performance.now();
  await context.emit({
    type: 'sleep.started',
    callId,
    durationMs,
    startedAt: new Date().toISOString()
  });
  const messages = context.subagentMessages;
  const outcome = await waitForToolCondition({
    ready: () => messages?.pending() ?? false,
    subscribe: (notify) => messages?.subscribe(notify) ?? (() => {}),
    waitMs: Math.max(0, durationMs - (performance.now() - started)),
    signal: context.signal,
    interrupt: context.waitInterrupt
  });
  context.signal.throwIfAborted();
  const data: SleepResult = {
    durationMs,
    elapsedMs: Math.round(performance.now() - started),
    wakeReason:
      outcome === 'ready' ? 'subagent_message' : outcome === 'interrupted' ? 'steer' : 'elapsed'
  };
  return { content: JSON.stringify(data), data };
}
