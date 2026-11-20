import type { ClientToolDefinition, ExecResult, ToolExecutionResult } from '../contracts.js';
import { AgentError } from '../../error.js';
import { TOOL_EXECUTION_LIMITS } from '../execution-limits.js';
export type { ExecResult } from '../contracts.js';

/** Share the model-facing body across direct calls and original Code Mode observations. */
export function formatExecResult(result: ExecResult): ToolExecutionResult {
  const { displayOutput, executionSource, ...modelResult } = result;
  const visible: Partial<ExecResult> = { ...modelResult };
  if (result.stderr === '') delete visible.stderr;
  if (!result.truncated) {
    delete visible.truncated;
    // Incremental output may be smaller than the cumulative stream counts.
    if (result.stdoutBytes === Buffer.byteLength(result.stdout)) delete visible.stdoutBytes;
    if (result.stderrBytes === Buffer.byteLength(result.stderr)) delete visible.stderrBytes;
  }
  if (result.stdoutDroppedBytes === 0) delete visible.stdoutDroppedBytes;
  if (result.stderrDroppedBytes === 0) delete visible.stderrDroppedBytes;
  if (result.cached === false) delete visible.cached;
  return {
    content: JSON.stringify(visible),
    data: executionSource === undefined && displayOutput === undefined ? result : modelResult,
    ...(displayOutput === undefined && executionSource === undefined
      ? {}
      : { eventData: { ...modelResult, displayOutput, executionSource } }),
    truncated: result.truncated
  };
}

export type ExecInput =
  | {
      action?: 'start';
      command: string;
      cwd?: string;
      login?: boolean;
      timeoutMs?: number;
      yieldMs?: number;
    }
  | { action: 'poll'; processId: string; yieldMs?: number }
  | { action: 'write'; processId: string; data: string }
  | { action: 'cancel'; processId: string };
type ParsedExecInput =
  Exclude<ExecInput, { action: 'poll' }> | { action: 'poll'; processId: string; yieldMs: number };
export const execToolDefinition: ClientToolDefinition = {
  name: 'exec',
  allowedCallers: ['direct', 'programmatic'],
  codeModeExposure: 'both',
  parallelSafety: 'safe',
  description:
    'Start a platform-native command, script, or program in workspace/default cwd. Returns a stable processId (p_ plus 12 lowercase hex characters), status, bounded stdout/stderr, cumulative byte counts, dropped-byte counts, exitCode and truncated. A completed status does not imply exitCode 0; inspect stderr/exitCode. For subsequent waiting, stdin writes or cancellation, use exec_wait with processId, not exec. Truncation does not stop the process. Cancelling the initial wait does not terminate the process. waitOutcome distinguishes completion from a wait timeout. A direct foreground call may return interrupted with reason=steer. Inside a cell, steer interrupts only the outer foreground wait, not the inner exec wait. In either case the process keeps running.',
  outputSchema: {
    type: 'object',
    required: ['content', 'data'],
    properties: {
      content: { type: 'string' },
      data: {
        type: 'object',
        required: [
          'status',
          'stdout',
          'stderr',
          'truncated',
          'stdoutBytes',
          'stderrBytes',
          'stdoutDroppedBytes',
          'stderrDroppedBytes'
        ],
        properties: {
          status: { enum: ['running', 'completed', 'cancelled'] },
          waitOutcome: { enum: ['snapshot', 'completion', 'timeout', 'yield', 'interrupted'] },
          reason: { enum: ['steer'] },
          processId: { type: 'string' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          exitCode: { type: ['number', 'null'] },
          truncated: { type: 'boolean' },
          stdoutBytes: { type: 'number' },
          stderrBytes: { type: 'number' },
          stdoutDroppedBytes: { type: 'number' },
          stderrDroppedBytes: { type: 'number' },
          cached: { type: 'boolean' }
        }
      }
    }
  },
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Platform-native command to start.'
      },
      cwd: {
        type: 'string',
        description:
          'Optional relative/absolute start directory; defaults to workspace. Command-internal relative paths resolve from this directory.'
      },
      login: {
        type: 'boolean',
        default: true,
        description:
          'Use the Shell login/profile initialization. Defaults to true; false skips login startup. Does not force an interactive Shell.'
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        maximum: TOOL_EXECUTION_LIMITS.execMaxTimeoutMs,
        description:
          'Optional process lifetime limit in milliseconds. Omitted means no process timeout; yieldMs only controls waiting.'
      },
      yieldMs: {
        type: 'integer',
        minimum: 0,
        maximum: TOOL_EXECUTION_LIMITS.execMaxYieldMs,
        default: TOOL_EXECUTION_LIMITS.execDefaultYieldMs,
        description: `Initial wait window in milliseconds (default: ${TOOL_EXECUTION_LIMITS.execDefaultYieldMs}; floor: ${TOOL_EXECUTION_LIMITS.execMinYieldMs}).`
      }
    },
    required: ['command'],
    additionalProperties: false
  }
};

export const execWaitToolDefinition: ClientToolDefinition = {
  name: 'exec_wait',
  allowedCallers: ['direct', 'programmatic'],
  codeModeExposure: 'both',
  parallelSafety: 'safe',
  description:
    'Wait for or control a managed process by processId. action defaults to poll: collect output until termination or the wait window ends. New output does not end the wait. Uncached results return and consume incremental stdout/stderr from the process buffer shared by both entry points. write sends data to stdin; cancel terminates the process or removes its cached result. After the terminal result is collected, later polls can replay a bounded snapshot marked cached for up to five minutes. Cancelling a wait does not terminate the process. Uses the same Session-owned processes as exec; cannot start a process or extend its timeout. Inspect stderr/exitCode; completed does not imply success. Poll results include waitOutcome; interrupted with reason=steer ends only a foreground wait, never the process.',
  outputSchema: execToolDefinition.outputSchema!,
  inputSchema: {
    type: 'object',
    properties: {
      processId: {
        type: 'string',
        minLength: 1,
        description:
          'Copy the complete processId returned by exec (p_ followed by 12 lowercase hex characters). Never use a cellId (c_); use code_exec_wait for cells.'
      },
      action: { enum: ['poll', 'write', 'cancel'], default: 'poll' },
      yieldMs: {
        type: 'integer',
        minimum: 0,
        maximum: TOOL_EXECUTION_LIMITS.execMaxYieldMs,
        default: TOOL_EXECUTION_LIMITS.execDefaultPollYieldMs,
        description: `Poll wait window in milliseconds. Values below ${TOOL_EXECUTION_LIMITS.execMinYieldMs} are treated as ${TOOL_EXECUTION_LIMITS.execMinYieldMs}.`
      },
      data: { type: 'string', description: 'Required stdin data for write.' }
    },
    required: ['processId'],
    additionalProperties: false
  }
};

/** Validate the public entry points before delegating to the single process manager. */
export function execToolInput(name: 'exec' | 'exec_wait', value: unknown): ParsedExecInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalidExecInput('Expected an object containing tool arguments.');
  const input = value as Record<string, unknown>;
  const allowed =
    name === 'exec'
      ? ['command', 'cwd', 'login', 'timeoutMs', 'yieldMs']
      : ['processId', 'action', 'yieldMs', 'data'];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    return invalidExecInput(`Unexpected fields; expected only: ${allowed.join(', ')}.`);
  if (name === 'exec') return parseExecInput(input);
  const action = input.action ?? 'poll';
  if (typeof action !== 'string' || !['poll', 'write', 'cancel'].includes(action))
    return invalidExecInput("Field 'action' must be one of: poll, write, cancel.");
  return parseExecInput({ ...input, action });
}

export function parseExecInput(value: unknown): ParsedExecInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalidExecInput('Expected an object containing tool arguments.');
  const input = value as Record<string, unknown>;
  const action = input.action ?? 'start';
  if (typeof action !== 'string' || !['start', 'poll', 'write', 'cancel'].includes(action))
    return invalidExecInput("Field 'action' must be one of: start, poll, write, cancel.");
  const requestedYieldMs = optionalBoundedInteger(
    'yieldMs',
    input.yieldMs,
    0,
    TOOL_EXECUTION_LIMITS.execMaxYieldMs
  );
  const yieldMs =
    requestedYieldMs === undefined
      ? undefined
      : Math.max(requestedYieldMs, TOOL_EXECUTION_LIMITS.execMinYieldMs);
  if (action === 'start') {
    if (typeof input.command !== 'string' || input.command.trim() === '')
      return invalidExecInput("Field 'command' must be a nonblank string.");
    if (input.cwd !== undefined && input.cwd !== null && typeof input.cwd !== 'string')
      return invalidExecInput("Field 'cwd' must be a string.");
    if (input.login !== undefined && input.login !== null && typeof input.login !== 'boolean')
      return invalidExecInput("Field 'login' must be a boolean.");
    const timeoutMs = optionalBoundedInteger(
      'timeoutMs',
      input.timeoutMs,
      1,
      TOOL_EXECUTION_LIMITS.execMaxTimeoutMs
    );
    return {
      ...(input.action === 'start' ? { action: 'start' as const } : {}),
      command: input.command,
      ...(typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
      ...(typeof input.login === 'boolean' ? { login: input.login } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(yieldMs === undefined ? {} : { yieldMs })
    };
  }
  if (typeof input.processId !== 'string' || input.processId === '')
    return invalidExecInput("Field 'processId' must be a nonempty string.");
  if (action === 'poll')
    return {
      action,
      processId: input.processId,
      yieldMs: yieldMs ?? TOOL_EXECUTION_LIMITS.execDefaultPollYieldMs
    };
  if (action === 'write') {
    if (typeof input.data !== 'string')
      return invalidExecInput("Field 'data' must be a string for action 'write'.");
    return { action, processId: input.processId, data: input.data };
  }
  return { action: 'cancel', processId: input.processId };
}

function optionalBoundedInteger(
  field: 'yieldMs' | 'timeoutMs',
  value: unknown,
  minimum: number,
  maximum: number
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum)
    invalidExecInput(`Field '${field}' must be an integer at least ${minimum}.`);
  return Math.min(value as number, maximum);
}

function invalidExecInput(message: string): never {
  throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', message);
}
