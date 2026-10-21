import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { MarAgentError } from '../../error.js';
import {
  directLocalProcessExecutor,
  signalProcessTree,
  type LocalProcessExecutor,
  type LocalProcessSpawnRequest
} from '../../host/local-process-executor.js';
import type { ClientToolDefinition } from '../../model/contracts.js';
import type { ExecResult, ToolExecutionResult } from '../contracts.js';
import { TOOL_EXECUTION_LIMITS } from '../execution-limits.js';
import { waitForToolCondition, waitMetadata, type ToolWaitInterrupt } from '../wait.js';
import { WorkspacePathResolver } from '../shared/path-resolver.js';
import {
  validateCoreProcessInput,
  type CoreProcessInput,
  type CoreProcessHandle
} from '../../extensions/processes.js';
import type { CoreOperationContext } from '../../extensions/operation.js';
export type { ExecResult } from '../contracts.js';

/** Share the model-facing body across direct calls and original Code Mode observations. */
export function formatExecResult(result: ExecResult): ToolExecutionResult {
  const visible: Partial<ExecResult> = { ...result };
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
  return { content: JSON.stringify(visible), data: result, truncated: result.truncated };
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
interface OutputBuffer {
  chunks: Buffer[];
  bytes: number;
  totalBytes: number;
  droppedBytes: number;
  /** Contiguous buffer owning the current window; slices of it are zero-copy. */
  window?: Buffer;
  windowOffset: number;
  decoder: StringDecoder;
}
interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  native: boolean;
  failure?: unknown;
  exitSignal?: string | null;
  ownerSessionId?: string;
  command: string;
  cwd: string;
  stdout: OutputBuffer;
  stderr: OutputBuffer;
  stdoutHistory: OutputBuffer;
  stderrHistory: OutputBuffer;
  status: ExecResult['status'];
  exitCode?: number | null;
  timer?: NodeJS.Timeout;
  exited: Promise<void>;
  settled: Promise<void>;
  resolveExited: () => void;
  resolveSettled: () => void;
  exitObserved: boolean;
  finalized: boolean;
  terminalResultReturned: boolean;
  terminate?: Promise<void>;
  waiters: Set<() => void>;
}

interface StartingProcess {
  ownerSessionId?: string;
  settled: Promise<void>;
  resolveSettled: () => void;
}

interface CompletedProcess {
  ownerSessionId?: string;
  command: string;
  cwd: string;
  result: ExecResult;
  timer: NodeJS.Timeout;
}

export const execToolDefinition: ClientToolDefinition = {
  name: 'exec',
  allowedCallers: ['direct', 'programmatic'],
  parallelSafety: 'safe',
  description:
    'Start a platform-native command, script, or program in workspace/default cwd. Returns a stable processId, status, bounded stdout/stderr, cumulative byte counts, dropped-byte counts, exitCode and truncated. A completed status does not imply exitCode 0; inspect stderr/exitCode. For subsequent waiting, stdin writes or cancellation, call exec_wait directly with processId, not exec. Truncation does not stop the process. Cancelling the initial wait does not terminate the process. waitOutcome distinguishes snapshot, completion, timeout, and yield. A foreground wait may return interrupted with reason=steer; the process keeps running.',
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
        description: `Wait before yielding output. Defaults to ${TOOL_EXECUTION_LIMITS.execDefaultYieldMs} ms. Maximum ${TOOL_EXECUTION_LIMITS.execMaxYieldMs} ms. Zero returns immediately. This does not extend the process timeout.`
      }
    },
    required: ['command'],
    additionalProperties: false
  }
};

export const execWaitToolDefinition: ClientToolDefinition = {
  name: 'exec_wait',
  allowedCallers: ['direct', 'programmatic'],
  parallelSafety: 'safe',
  description:
    'Wait for or control a managed process by processId. action defaults to poll: wait for new output or termination and return incremental stdout/stderr. write sends data to stdin; cancel terminates the process or removes its cached result. Terminal polls return a bounded snapshot marked cached for up to five minutes. Cancelling a wait does not terminate the process. Uses the same Session-owned processes as exec; cannot start a process or extend its timeout. Inspect stderr/exitCode; completed does not imply success. Supports direct and programmatic calls; in Code Mode use tools.exec_wait. Poll results include waitOutcome; interrupted with reason=steer ends only a foreground wait, never the process.',
  outputSchema: execToolDefinition.outputSchema!,
  inputSchema: {
    type: 'object',
    properties: {
      processId: {
        type: 'string',
        minLength: 1,
        description: 'Stable processId returned by exec.'
      },
      action: { enum: ['poll', 'write', 'cancel'], default: 'poll' },
      yieldMs: {
        type: 'integer',
        minimum: 0,
        maximum: TOOL_EXECUTION_LIMITS.execMaxPollYieldMs,
        default: TOOL_EXECUTION_LIMITS.execDefaultYieldMs,
        description: `Poll wait window in milliseconds; default ${TOOL_EXECUTION_LIMITS.execDefaultYieldMs}, maximum ${TOOL_EXECUTION_LIMITS.execMaxPollYieldMs}. Zero returns immediately. Not a process timeout.`
      },
      data: { type: 'string', description: 'Required stdin data for write.' }
    },
    required: ['processId'],
    additionalProperties: false
  }
};

/** Validate the public entry points before delegating to the single process manager. */
export function execToolInput(name: 'exec' | 'exec_wait', value: unknown): ExecInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidExecInput();
  const input = value as Record<string, unknown>;
  const allowed =
    name === 'exec'
      ? ['command', 'cwd', 'login', 'timeoutMs', 'yieldMs']
      : ['processId', 'action', 'yieldMs', 'data'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) return invalidExecInput();
  if (name === 'exec') return parseExecInput(input);
  const action = input.action ?? 'poll';
  if (!['poll', 'write', 'cancel'].includes(String(action))) return invalidExecInput();
  return parseExecInput({ ...input, action });
}

export class ExecTool {
  readonly #processes = new Map<string, ManagedProcess>();
  readonly #completed = new Map<string, CompletedProcess>();
  readonly #startingProcesses = new Set<StartingProcess>();
  constructor(
    private readonly paths: WorkspacePathResolver,
    readonly maxOutputBytes: number = TOOL_EXECUTION_LIMITS.execDefaultMaxOutputBytes,
    readonly maxProcesses: number = TOOL_EXECUTION_LIMITS.maxProcesses,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly shell?: string,
    private readonly processExecutor: LocalProcessExecutor = directLocalProcessExecutor
  ) {}
  async execute(
    arguments_: unknown,
    signal?: AbortSignal,
    owner?: NonNullable<
      import('../../host/local-process-executor.js').LocalProcessSpawnRequest['owner']
    >,
    waitInterrupt?: ToolWaitInterrupt
  ): Promise<ExecResult> {
    if (signal?.aborted) throw executionAbortReason(signal);
    const input = parseExecInput(arguments_);
    if ('processId' in input) {
      const process = this.#processes.get(input.processId);
      const completed = this.#completed.get(input.processId);
      if (completed) {
        if (owner !== undefined && completed.ownerSessionId !== owner.sessionId)
          throw new MarAgentError('MAR_AGENT_PROCESS_NOT_FOUND', 'Managed process was not found.');
        if (input.action === 'write')
          throw new MarAgentError(
            'MAR_AGENT_TOOL_INPUT_INVALID',
            'Completed process cannot accept input.'
          );
        if (input.action === 'cancel') this.#removeCompleted(input.processId);
        return {
          ...completed.result,
          cached: true,
          ...(input.action === 'poll'
            ? waitMetadata(input.yieldMs === 0 ? 'snapshot' : 'completion')
            : {})
        };
      }
      if (
        !process ||
        process.native ||
        (owner !== undefined && process.ownerSessionId !== owner.sessionId)
      )
        throw new MarAgentError('MAR_AGENT_PROCESS_NOT_FOUND', 'Managed process was not found.');
      let outcome: 'ready' | 'timeout' | 'interrupted' | undefined;
      if (input.action === 'poll' && input.yieldMs)
        outcome = await waitForProcessChange(
          process,
          Math.min(Math.max(input.yieldMs, 0), TOOL_EXECUTION_LIMITS.execMaxPollYieldMs),
          signal,
          waitInterrupt
        );
      if (input.action === 'write') {
        if (process.status !== 'running')
          throw new MarAgentError(
            'MAR_AGENT_TOOL_INPUT_INVALID',
            'Completed process cannot accept input.'
          );
        process.child.stdin.write(input.data);
      }
      if (input.action === 'cancel') await this.#terminate(process, true);
      const result = this.#result(input.processId, process);
      if (process.status !== 'running') {
        this.#retainCompleted(input.processId, process);
        if (input.action === 'cancel') this.#removeCompleted(input.processId);
      }
      return {
        ...result,
        ...(input.action === 'poll'
          ? waitMetadata(
              input.yieldMs === 0
                ? 'snapshot'
                : result.status !== 'running'
                  ? 'completion'
                  : outcome === 'interrupted'
                    ? 'interrupted'
                    : outcome === 'ready'
                      ? 'yield'
                      : 'timeout'
            )
          : {})
      };
    }
    const { id, managed } = await this.#startManaged(
      async () => {
        const cwd = await this.paths.resolveWithDisplay(input.cwd ?? '.');
        return {
          command: input.command,
          cwd: cwd.physicalPath,
          shell: this.shell ?? true,
          shellLogin: input.login ?? true,
          environment: this.environment,
          displayCwd: cwd.displayPath,
          detached: process.platform !== 'win32',
          ...(owner === undefined ? {} : { owner }),
          ...(signal === undefined ? {} : { signal })
        };
      },
      owner?.sessionId,
      false
    );
    if (input.timeoutMs !== undefined) {
      managed.timer = setTimeout(
        () => {
          void this.#terminate(managed, true).then(() => this.#retainCompleted(id, managed));
        },
        Math.min(input.timeoutMs, TOOL_EXECUTION_LIMITS.execMaxTimeoutMs)
      );
      managed.timer.unref();
    }
    const yieldMs = Math.min(
      input.yieldMs ?? TOOL_EXECUTION_LIMITS.execDefaultYieldMs,
      TOOL_EXECUTION_LIMITS.execMaxYieldMs
    );
    const outcome =
      yieldMs === 0
        ? undefined
        : await waitForToolCondition({
            ready: () => managed.finalized,
            subscribe: (notify) => {
              managed.waiters.add(notify);
              return () => {
                managed.waiters.delete(notify);
              };
            },
            waitMs: yieldMs,
            signal,
            interrupt: waitInterrupt
          });
    const result = this.#result(id, managed);
    if (managed.status !== 'running') this.#retainCompleted(id, managed);
    return {
      ...result,
      ...waitMetadata(
        yieldMs === 0
          ? 'snapshot'
          : result.status !== 'running'
            ? 'completion'
            : outcome === 'interrupted'
              ? 'interrupted'
              : 'timeout'
      )
    };
  }
  async #startManaged(
    request: () => Promise<LocalProcessSpawnRequest & { displayCwd?: string }>,
    ownerSessionId: string | undefined,
    native: boolean
  ): Promise<{ id: string; managed: ManagedProcess }> {
    if (this.#processes.size + this.#startingProcesses.size >= this.maxProcesses)
      throw new MarAgentError(
        'MAR_AGENT_PROCESS_LIMIT',
        `The Local Host shared managed-process limit (${this.maxProcesses}) was reached.`
      );
    let resolveStarting!: () => void;
    const starting: StartingProcess = {
      ...(ownerSessionId === undefined ? {} : { ownerSessionId }),
      settled: new Promise<void>((resolve) => (resolveStarting = resolve)),
      resolveSettled: () => resolveStarting()
    };
    this.#startingProcesses.add(starting);
    try {
      const { displayCwd, ...input } = await request();
      input.signal?.throwIfAborted();
      let child: ChildProcessWithoutNullStreams;
      try {
        child = await this.processExecutor.spawn(input);
      } catch (error) {
        input.signal?.throwIfAborted();
        if (!native || error instanceof MarAgentError) throw error;
        throw new MarAgentError(
          'MAR_AGENT_PROCESS_START_FAILED',
          'Native process executor failed to start.',
          {
            details: { reasonCode: (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN' }
          }
        );
      }
      const id = randomUUID();
      let resolveExited!: () => void;
      let resolveSettled!: () => void;
      const managed: ManagedProcess = {
        child,
        native,
        ...(ownerSessionId === undefined ? {} : { ownerSessionId }),
        command: input.command,
        cwd: displayCwd ?? input.cwd,
        stdout: createOutputBuffer(),
        stderr: createOutputBuffer(),
        stdoutHistory: createOutputBuffer(),
        stderrHistory: createOutputBuffer(),
        status: 'running',
        exited: new Promise<void>((resolve) => (resolveExited = resolve)),
        settled: new Promise<void>((resolve) => (resolveSettled = resolve)),
        resolveExited,
        resolveSettled,
        exitObserved: child.exitCode !== null || child.signalCode != null,
        ...(child.exitCode === null ? {} : { exitCode: child.exitCode }),
        ...(child.signalCode == null ? {} : { exitSignal: child.signalCode }),
        finalized: false,
        terminalResultReturned: false,
        waiters: new Set()
      };
      this.#processes.set(id, managed);
      if (native) {
        // Keep unread bytes in the Readable buffer: Node otherwise resumes unused stdio at exit.
        const readable = () => {};
        child.stdout.on('readable', readable);
        child.stderr.on('readable', readable);
        child.once('close', () => {
          child.stdout.removeListener('readable', readable);
          child.stderr.removeListener('readable', readable);
        });
      }
      if (!native) {
        const listen = (name: 'stdout' | 'stderr') =>
          child[name].on('data', (chunk: Buffer) => {
            if (managed.finalized) return;
            const decoded = Buffer.from(managed[name].decoder.write(chunk));
            appendOutput(managed[name], decoded, this.maxOutputBytes, chunk.length);
            appendOutput(
              managed[name === 'stdout' ? 'stdoutHistory' : 'stderrHistory'],
              decoded,
              this.maxOutputBytes,
              chunk.length
            );
            notifyProcessChange(managed);
          });
        listen('stdout');
        listen('stderr');
      }
      child.once('exit', (code, signal) => {
        managed.exitObserved = true;
        managed.exitCode = code;
        managed.exitSignal = signal;
        managed.resolveExited();
        if (!native)
          void finalizeAfterOutputGrace(managed, this.maxOutputBytes).then(() =>
            this.#retainCompleted(id, managed)
          );
      });
      child.once('close', (code, signal) => {
        managed.exitObserved = true;
        managed.exitSignal = signal;
        managed.resolveExited();
        finalizeManagedProcess(managed, this.maxOutputBytes, code);
        if (native) this.#processes.delete(id);
        else this.#retainCompleted(id, managed);
      });
      child.once('error', (error) => {
        if (managed.finalized) return;
        if (native) {
          managed.failure = new MarAgentError(
            'MAR_AGENT_PROCESS_START_FAILED',
            'Native process failed to start.',
            {
              details: { reasonCode: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' }
            }
          );
          managed.exitObserved = true;
          managed.resolveExited();
        } else {
          const message = Buffer.from(error.message);
          appendOutput(managed.stderr, message, this.maxOutputBytes);
          appendOutput(managed.stderrHistory, message, this.maxOutputBytes);
          notifyProcessChange(managed);
        }
      });
      if (managed.exitObserved) {
        managed.resolveExited();
        if (child.stdout.closed && child.stderr.closed) {
          finalizeManagedProcess(managed, this.maxOutputBytes, child.exitCode);
          if (native) this.#processes.delete(id);
          else this.#retainCompleted(id, managed);
        }
      }
      return { id, managed };
    } finally {
      this.#startingProcesses.delete(starting);
      starting.resolveSettled();
    }
  }

  async spawn(input: CoreProcessInput, call: CoreOperationContext): Promise<CoreProcessHandle> {
    validateCoreProcessInput(input);
    input = {
      ...input,
      ...(input.argv === undefined ? {} : { argv: [...input.argv] }),
      ...(input.env === undefined ? {} : { env: { ...input.env } }),
      ...(input.input instanceof Uint8Array ? { input: new Uint8Array(input.input) } : {})
    };
    const { id, managed } = await this.#startManaged(
      async () => {
        const cwd = await this.paths.resolve(input.cwd ?? '.');
        return {
          command: input.executable,
          args: [...(input.argv ?? [])],
          cwd,
          shell: false,
          environment: { ...this.environment, ...input.env },
          environmentKeys: Object.keys(input.env ?? {}),
          ...(input.env === undefined ? {} : { environmentOverrides: input.env }),
          detached: process.platform !== 'win32',
          signal: call.signal,
          owner: {
            sessionId: call.sessionId,
            operationId: call.operationId,
            ...(call.executionId ? { executionId: call.executionId } : {}),
            ...(call.ownerInstanceId ? { ownerInstanceId: call.ownerInstanceId } : {})
          }
        };
      },
      call.sessionId,
      true
    );
    let cleanup: Promise<void> | undefined;
    const cancel = () =>
      (cleanup ??= (async () => {
        call.signal.removeEventListener('abort', abort);
        await this.#terminate(managed, false);
        destroyManagedStreams(managed);
        this.#processes.delete(id);
      })());
    const abort = () => {
      void cancel().catch(() => undefined);
    };
    call.signal.addEventListener('abort', abort, { once: true });
    managed.child.once('close', () => call.signal.removeEventListener('abort', abort));
    managed.child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && !cleanup)
        managed.failure = new MarAgentError(
          'MAR_AGENT_PROCESS_IO_FAILED',
          'Native process input failed.',
          {
            details: { reasonCode: error.code ?? 'UNKNOWN' }
          }
        );
    });
    managed.child.stdin.end(input.input);
    if (call.signal.aborted) {
      await cancel();
      call.signal.throwIfAborted();
    }
    const opened = new Promise<void>((resolve, reject) => {
      if (managed.child.pid) {
        resolve();
        return;
      }
      if (managed.failure) {
        reject(managed.failure);
        return;
      }
      const spawned = () => {
        managed.child.removeListener('error', failed);
        resolve();
      };
      const failed = () => {
        managed.child.removeListener('spawn', spawned);
        reject(managed.failure);
      };
      managed.child.once('spawn', spawned);
      managed.child.once('error', failed);
    });
    try {
      await opened;
    } catch (error) {
      await cancel();
      throw error;
    }
    const stream = (name: 'stdout' | 'stderr'): AsyncIterable<Uint8Array> => ({
      async *[Symbol.asyncIterator]() {
        try {
          for await (const chunk of managed.child[name]) yield new Uint8Array(chunk as Buffer);
        } catch (error) {
          if (!cleanup && !call.signal.aborted)
            throw new MarAgentError(
              'MAR_AGENT_PROCESS_IO_FAILED',
              'Native process output failed.',
              {
                details: {
                  stream: name,
                  reasonCode: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'
                }
              }
            );
        }
      }
    });
    return {
      processId: id,
      stdout: stream('stdout'),
      stderr: stream('stderr'),
      cancel,
      wait: async () => {
        await managed.exited;
        call.signal.throwIfAborted();
        if (managed.failure) throw managed.failure;
        return { code: managed.exitCode ?? null, signal: managed.exitSignal ?? null };
      }
    };
  }
  listSessionResources(sessionId: string) {
    return [
      ...[...this.#processes.entries()].flatMap(([processId, process]) =>
        !process.native && process.ownerSessionId === sessionId
          ? [{ processId, status: process.status, command: process.command, cwd: process.cwd }]
          : []
      ),
      ...[...this.#completed.entries()].flatMap(([processId, process]) =>
        process.ownerSessionId === sessionId
          ? [
              {
                processId,
                status: process.result.status,
                command: process.command,
                cwd: process.cwd
              }
            ]
          : []
      )
    ];
  }
  async disposeSession(sessionId: string) {
    await Promise.all(
      [...this.#startingProcesses]
        .filter((process) => process.ownerSessionId === sessionId)
        .map((process) => process.settled)
    );
    const owned = [...this.#processes.entries()].filter(
      ([, process]) => process.ownerSessionId === sessionId
    );
    await Promise.all(
      owned.map(([, process]) =>
        process.status === 'running' ? this.#terminate(process, false) : process.settled
      )
    );
    for (const [processId] of owned) this.#processes.delete(processId);
    for (const [processId, process] of this.#completed)
      if (process.ownerSessionId === sessionId) this.#removeCompleted(processId);
  }
  #removeCompleted(id: string) {
    const completed = this.#completed.get(id);
    if (!completed) return;
    clearTimeout(completed.timer);
    this.#completed.delete(id);
  }
  #retainCompleted(id: string, process: ManagedProcess) {
    if (
      process.native ||
      process.status === 'running' ||
      !process.finalized ||
      !process.terminalResultReturned ||
      this.#processes.get(id) !== process
    )
      return;
    this.#processes.delete(id);
    const stdout = consumeOutput(process.stdoutHistory);
    const stderr = consumeOutput(process.stderrHistory);
    const timer = setTimeout(
      () => this.#removeCompleted(id),
      TOOL_EXECUTION_LIMITS.execCompletedRetentionMs
    );
    timer.unref();
    this.#completed.set(id, {
      ...(process.ownerSessionId === undefined ? {} : { ownerSessionId: process.ownerSessionId }),
      command: process.command,
      cwd: process.cwd,
      timer,
      result: {
        status: process.status,
        processId: id,
        stdout: stdout.value,
        stderr: stderr.value,
        ...(process.exitCode === undefined ? {} : { exitCode: process.exitCode }),
        truncated: stdout.droppedBytes > 0 || stderr.droppedBytes > 0,
        stdoutBytes: process.stdout.totalBytes,
        stderrBytes: process.stderr.totalBytes,
        stdoutDroppedBytes: stdout.droppedBytes,
        stderrDroppedBytes: stderr.droppedBytes
      }
    });
    while (this.#completed.size > TOOL_EXECUTION_LIMITS.execMaxCompletedResults)
      this.#removeCompleted(this.#completed.keys().next().value!);
  }
  async #terminate(managed: ManagedProcess, waitForOutputClose: boolean) {
    if (managed.terminate) return managed.terminate;
    managed.terminate = (async () => {
      if (managed.exitObserved || managed.child.exitCode !== null) {
        if (managed.native && !managed.finalized) await signalProcessTree(managed.child, 'SIGKILL');
        if (managed.child.exitCode !== null) managed.exitCode = managed.child.exitCode;
        if (waitForOutputClose) {
          const settled = await waitForExit(
            managed.settled,
            TOOL_EXECUTION_LIMITS.execTerminationGraceMs
          );
          if (settled) return;
        }
        finalizeManagedProcess(managed, this.maxOutputBytes, managed.child.exitCode);
        destroyManagedStreams(managed);
        return;
      }
      managed.status = 'cancelled';
      if (managed.timer) clearTimeout(managed.timer);
      await signalProcessTree(managed.child, 'SIGTERM');
      const exited = await waitForExit(
        managed.exited,
        TOOL_EXECUTION_LIMITS.execTerminationGraceMs
      );
      if (!exited) {
        await signalProcessTree(managed.child, 'SIGKILL');
        await managed.exited;
      }
      // A parent may exit on TERM while descendants ignore it and keep the pipes alive.
      if (managed.native) await signalProcessTree(managed.child, 'SIGKILL');
      if (waitForOutputClose) {
        const settled = await waitForExit(
          managed.settled,
          TOOL_EXECUTION_LIMITS.execTerminationGraceMs
        );
        if (settled) return;
      }
      finalizeManagedProcess(managed, this.maxOutputBytes, managed.exitCode);
      destroyManagedStreams(managed);
    })();
    return managed.terminate;
  }
  #result(id: string, process: ManagedProcess): ExecResult {
    // Uncollected terminal output is a live resource, not an expiring replay.
    if (process.status !== 'running') process.terminalResultReturned = true;
    const stdout = consumeOutput(process.stdout);
    const stderr = consumeOutput(process.stderr);
    return {
      status: process.status,
      processId: id,
      stdout: stdout.value,
      stderr: stderr.value,
      ...(process.exitCode === undefined ? {} : { exitCode: process.exitCode }),
      truncated: stdout.droppedBytes > 0 || stderr.droppedBytes > 0,
      stdoutBytes: process.stdout.totalBytes,
      stderrBytes: process.stderr.totalBytes,
      stdoutDroppedBytes: stdout.droppedBytes,
      stderrDroppedBytes: stderr.droppedBytes
    };
  }
  async dispose() {
    await Promise.all([...this.#startingProcesses].map((process) => process.settled));
    await Promise.all(
      [...this.#processes.values()].map((process) =>
        process.status === 'running' ? this.#terminate(process, false) : process.settled
      )
    );
    this.#processes.clear();
    for (const id of this.#completed.keys()) this.#removeCompleted(id);
  }
}

function createOutputBuffer(): OutputBuffer {
  return {
    chunks: [],
    bytes: 0,
    totalBytes: 0,
    droppedBytes: 0,
    windowOffset: 0,
    decoder: new StringDecoder('utf8')
  };
}

function finalizeManagedProcess(
  managed: ManagedProcess,
  maximumOutputBytes: number,
  exitCode: number | null | undefined
): void {
  if (managed.finalized) return;
  managed.finalized = true;
  const stdoutEnd = Buffer.from(managed.stdout.decoder.end());
  const stderrEnd = Buffer.from(managed.stderr.decoder.end());
  appendOutput(managed.stdout, stdoutEnd, maximumOutputBytes);
  appendOutput(managed.stderr, stderrEnd, maximumOutputBytes);
  appendOutput(managed.stdoutHistory, stdoutEnd, maximumOutputBytes);
  appendOutput(managed.stderrHistory, stderrEnd, maximumOutputBytes);
  managed.status = managed.status === 'cancelled' ? 'cancelled' : 'completed';
  if (exitCode !== undefined) managed.exitCode = exitCode;
  if (managed.timer) clearTimeout(managed.timer);
  notifyProcessChange(managed);
  managed.resolveSettled();
}

async function finalizeAfterOutputGrace(
  managed: ManagedProcess,
  maximumOutputBytes: number
): Promise<void> {
  const settled = await waitForExit(managed.settled, TOOL_EXECUTION_LIMITS.execTerminationGraceMs);
  if (settled) return;
  finalizeManagedProcess(managed, maximumOutputBytes, managed.exitCode);
  destroyManagedStreams(managed);
}

function destroyManagedStreams(managed: ManagedProcess): void {
  managed.child.stdin.destroy();
  managed.child.stdout.destroy();
  managed.child.stderr.destroy();
}

function appendOutput(
  output: OutputBuffer,
  chunk: Buffer,
  maximumBytes: number,
  receivedBytes = chunk.length
) {
  output.totalBytes += receivedBytes;
  if (!chunk.length) return;
  output.chunks.push(chunk);
  output.bytes += chunk.length;
  // Retain the oldest and newest halves symmetrically so early failures stay
  // visible next to the latest progress; droppedBytes makes the discarded
  // middle explicit because it is not recoverable from this bounded buffer.
  const overflow = output.bytes - maximumBytes;
  if (overflow <= 0) return;
  const head = Math.ceil(maximumBytes / 2);
  // Materialize the current window once per overflow so subsequent appends slice
  // it zero-copy instead of re-concatenating the whole retained buffer per chunk.
  let span = output.window;
  if (!span || output.bytes !== span.length - output.windowOffset) {
    span = Buffer.concat(output.chunks, output.bytes);
    output.windowOffset = 0;
  }
  const content = span.subarray(output.windowOffset, output.windowOffset + output.bytes);
  output.chunks = [];
  output.bytes = 0;
  const pushSlice = (start: number, end: number) => {
    while (start < end && (content[start]! & 0xc0) === 0x80) start++;
    while (end > start && end < content.length && (content[end]! & 0xc0) === 0x80) end--;
    if (start >= end) return;
    const slice = content.subarray(start, end);
    output.chunks.push(slice);
    output.bytes += slice.length;
  };
  pushSlice(0, Math.min(head, content.length));
  pushSlice(Math.min(head + overflow, content.length), content.length);
  output.droppedBytes += content.length - output.bytes;
  output.window = span;
}

function consumeOutput(output: OutputBuffer) {
  const value = Buffer.concat(output.chunks, output.bytes).toString('utf8');
  const droppedBytes = output.droppedBytes;
  output.chunks = [];
  output.bytes = 0;
  output.droppedBytes = 0;
  delete output.window;
  output.windowOffset = 0;
  return { value, droppedBytes };
}
function parseExecInput(value: unknown): ExecInput {
  if (!value || typeof value !== 'object') return invalidExecInput();
  const input = value as Record<string, unknown>;
  const action = input.action == null && typeof input.command === 'string' ? 'start' : input.action;
  if (!['start', 'poll', 'write', 'cancel'].includes(String(action))) return invalidExecInput();
  const yieldMs = optionalBoundedInteger(
    input.yieldMs,
    0,
    action === 'poll'
      ? TOOL_EXECUTION_LIMITS.execMaxPollYieldMs
      : TOOL_EXECUTION_LIMITS.execMaxYieldMs
  );
  if (action === 'start') {
    if (typeof input.command !== 'string' || input.command.trim() === '') return invalidExecInput();
    if (input.cwd !== undefined && input.cwd !== null && typeof input.cwd !== 'string')
      return invalidExecInput();
    if (input.login !== undefined && input.login !== null && typeof input.login !== 'boolean')
      return invalidExecInput();
    const timeoutMs = optionalBoundedInteger(
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
  if (typeof input.processId !== 'string' || input.processId === '') return invalidExecInput();
  if (action === 'poll')
    return {
      action,
      processId: input.processId,
      yieldMs: yieldMs ?? TOOL_EXECUTION_LIMITS.execDefaultYieldMs
    };
  if (action === 'write') {
    if (typeof input.data !== 'string') return invalidExecInput();
    return { action, processId: input.processId, data: input.data };
  }
  return { action: 'cancel', processId: input.processId };
}

function optionalBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum) invalidExecInput();
  return Math.min(value as number, maximum);
}

function invalidExecInput(): never {
  throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Exec input is invalid.');
}

async function waitForExit(exited: Promise<void>, delayMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), delayMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function notifyProcessChange(managed: ManagedProcess): void {
  for (const resolve of managed.waiters) resolve();
}

async function waitForProcessChange(
  managed: ManagedProcess,
  waitMs: number,
  signal?: AbortSignal,
  interrupt?: ToolWaitInterrupt
) {
  let changed = false;
  return waitForToolCondition({
    ready: () =>
      managed.status !== 'running' ||
      managed.stdout.bytes > 0 ||
      managed.stderr.bytes > 0 ||
      changed,
    subscribe: (notify) => {
      const listener = () => {
        changed = true;
        notify();
      };
      managed.waiters.add(listener);
      return () => {
        managed.waiters.delete(listener);
      };
    },
    waitMs,
    signal,
    interrupt
  });
}

function executionAbortReason(signal?: AbortSignal): unknown {
  return (
    signal?.reason ?? new MarAgentError('MAR_AGENT_EXECUTION_CANCELLED', 'Execution cancelled.')
  );
}
