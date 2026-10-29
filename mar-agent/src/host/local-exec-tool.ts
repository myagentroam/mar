import type { ClientToolDefinition } from '../tools/contracts.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { RuntimeResourceHandles } from '../tools/runtime-resource-handles.js';
import { StringDecoder } from 'node:string_decoder';
import { AgentError } from '../error.js';
import {
  directLocalProcessExecutor,
  signalProcessTree,
  type LocalProcessExecutor,
  type LocalProcessSpawnRequest
} from './local-process-executor.js';

import type { ExecOutputSnapshot, ExecResult, ToolExecutionResult } from '../tools/contracts.js';
import { TOOL_EXECUTION_LIMITS } from '../tools/execution-limits.js';
import { waitForToolCondition, waitMetadata, type ToolWaitInterrupt } from '../tools/wait.js';
import { WorkspacePathResolver } from '../tools/shared/path-resolver.js';
import {
  validateCoreProcessInput,
  type ExtensionProcessInput,
  type ExtensionProcessHandle
} from '../extensions/processes.js';
import type { ExtensionOperationContext } from '../extensions/operation.js';
import { parseExecInput } from '../tools/local/exec.js';

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
  stdoutDisplay: TailBuffer;
  stderrDisplay: TailBuffer;
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
  outputListeners: Set<(channel: 'stdout' | 'stderr', chunk: Buffer) => void>;
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

export class ExecTool {
  readonly #processes = new Map<string, ManagedProcess>();
  readonly #completed = new Map<string, CompletedProcess>();
  readonly #handles = new RuntimeResourceHandles(
    'process',
    (id) => this.#processes.has(id) || this.#completed.has(id)
  );
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
    owner?: NonNullable<import('./local-process-executor.js').LocalProcessSpawnRequest['owner']>,
    waitInterrupt?: ToolWaitInterrupt,
    onOutput?: (output: ExecOutputSnapshot) => Promise<void>
  ): Promise<ExecResult> {
    if (signal?.aborted) throw executionAbortReason(signal);
    const input = parseExecInput(arguments_);
    if ('processId' in input) {
      this.#handles.assertType(input.processId);
      const process = this.#processes.get(input.processId);
      const completed = this.#completed.get(input.processId);
      if (completed) {
        if (owner !== undefined && completed.ownerSessionId !== owner.sessionId)
          throw new AgentError('MAR_AGENT_PROCESS_NOT_FOUND', 'Managed process was not found.');
        if (input.action === 'write')
          throw new AgentError(
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
        throw new AgentError('MAR_AGENT_PROCESS_NOT_FOUND', 'Managed process was not found.');
      let outcome: 'ready' | 'timeout' | 'interrupted' | undefined;
      if (input.action === 'poll' && input.yieldMs)
        outcome = await waitForProcessCompletion(
          input.processId,
          process,
          Math.min(Math.max(input.yieldMs, 0), TOOL_EXECUTION_LIMITS.execMaxPollYieldMs),
          signal,
          waitInterrupt,
          onOutput
        );
      if (input.action === 'write') {
        if (process.status !== 'running')
          throw new AgentError(
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
        : await waitForProcessCompletion(id, managed, yieldMs, signal, waitInterrupt, onOutput);
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
      throw new AgentError(
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
        if (!native || error instanceof AgentError) throw error;
        throw new AgentError(
          'MAR_AGENT_PROCESS_START_FAILED',
          'Native process executor failed to start.',
          {
            details: { reasonCode: (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN' }
          }
        );
      }
      const id = this.#handles.create();
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
        stdoutDisplay: { value: Buffer.alloc(0), droppedBytes: 0 },
        stderrDisplay: { value: Buffer.alloc(0), droppedBytes: 0 },
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
        waiters: new Set(),
        outputListeners: new Set()
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
            appendDisplay(managed[name === 'stdout' ? 'stdoutDisplay' : 'stderrDisplay'], decoded);
            for (const listener of managed.outputListeners) listener(name, decoded);
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
          managed.failure = new AgentError(
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
          appendDisplay(managed.stderrDisplay, message);
          for (const listener of managed.outputListeners) listener('stderr', message);
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

  async spawn(
    input: ExtensionProcessInput,
    call: ExtensionOperationContext
  ): Promise<ExtensionProcessHandle> {
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
        managed.failure = new AgentError(
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
            throw new AgentError('MAR_AGENT_PROCESS_IO_FAILED', 'Native process output failed.', {
              details: {
                stream: name,
                reasonCode: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'
              }
            });
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
        stderrDroppedBytes: stderr.droppedBytes,
        displayOutput: displayOutput(process),
        executionSource: {
          kind: 'SHELL',
          text: process.command.slice(0, 10_000),
          cwd: process.cwd.slice(0, 10_000),
          truncated: process.command.length > 10_000 || process.cwd.length > 10_000
        }
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
      stderrDroppedBytes: stderr.droppedBytes,
      displayOutput: displayOutput(process),
      executionSource: {
        kind: 'SHELL',
        text: process.command.slice(0, 10_000),
        cwd: process.cwd.slice(0, 10_000),
        truncated: process.command.length > 10_000 || process.cwd.length > 10_000
      }
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

interface TailBuffer {
  value: Buffer;
  droppedBytes: number;
}

function appendDisplay(target: TailBuffer, chunk: Buffer): void {
  const combined = Buffer.concat([target.value, chunk]);
  let start = Math.max(0, combined.length - TOOL_EXECUTION_LIMITS.execProgressMaxOutputBytes);
  while (start < combined.length && (combined[start]! & 0xc0) === 0x80) start++;
  target.droppedBytes += start;
  target.value = Buffer.from(combined.subarray(start));
}

function displayOutput(process: ManagedProcess) {
  return {
    stdout: process.stdoutDisplay.value.toString('utf8'),
    stderr: process.stderrDisplay.value.toString('utf8'),
    stdoutDroppedBytes: process.stdoutDisplay.droppedBytes,
    stderrDroppedBytes: process.stderrDisplay.droppedBytes
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
  appendDisplay(managed.stdoutDisplay, stdoutEnd);
  appendDisplay(managed.stderrDisplay, stderrEnd);
  for (const listener of managed.outputListeners) {
    listener('stdout', stdoutEnd);
    listener('stderr', stderrEnd);
  }
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

async function waitForProcessCompletion(
  processId: string,
  managed: ManagedProcess,
  waitMs: number,
  signal?: AbortSignal,
  interrupt?: ToolWaitInterrupt,
  onOutput?: (output: ExecOutputSnapshot) => Promise<void>
) {
  const stopOutput = onOutput && watchProcessOutput(processId, managed, onOutput);
  try {
    return await waitForToolCondition({
      ready: () => managed.finalized,
      subscribe: (notify) => {
        managed.waiters.add(notify);
        return () => {
          managed.waiters.delete(notify);
        };
      },
      waitMs,
      signal,
      interrupt
    });
  } finally {
    stopOutput?.();
  }
}

/** Coalesce decoded chunks into bounded per-call frames without blocking the process. */
function watchProcessOutput(
  processId: string,
  managed: ManagedProcess,
  onOutput: (output: ExecOutputSnapshot) => Promise<void>
) {
  let stopped = false;
  let stdout: TailBuffer = { value: Buffer.alloc(0), droppedBytes: 0 };
  let stderr: TailBuffer = { value: Buffer.alloc(0), droppedBytes: 0 };
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let failed = false;
  let initialSnapshot =
    managed.stdoutDisplay.value.length > 0 || managed.stderrDisplay.value.length > 0;
  const publish = () => {
    const frameOut = stdout;
    const frameErr = stderr;
    stdout = { value: Buffer.alloc(0), droppedBytes: 0 };
    stderr = { value: Buffer.alloc(0), droppedBytes: 0 };
    const snapshot = displayOutput(managed);
    const snapshotFrame = initialSnapshot || frameOut.droppedBytes > 0 || frameErr.droppedBytes > 0;
    initialSnapshot = false;
    inFlight = Promise.resolve()
      .then(() => {
        if (stopped) return;
        return onOutput({
          processId,
          mode: snapshotFrame ? 'snapshot' : 'delta',
          stdout: snapshotFrame ? snapshot.stdout : frameOut.value.toString('utf8'),
          stderr: snapshotFrame ? snapshot.stderr : frameErr.value.toString('utf8'),
          truncated: snapshotFrame
            ? snapshot.stdoutDroppedBytes > 0 || snapshot.stderrDroppedBytes > 0
            : frameOut.droppedBytes > 0 || frameErr.droppedBytes > 0,
          displayOutput: snapshot
        });
      })
      .catch(() => {
        // Display delivery must not change the process result or wait deadline.
        failed = true;
      })
      .finally(() => {
        inFlight = undefined;
        if (stdout.value.length || stderr.value.length) schedule();
      });
  };
  const schedule = () => {
    if (stopped || failed || timer || inFlight) return;
    timer = setTimeout(() => {
      timer = undefined;
      publish();
    }, TOOL_EXECUTION_LIMITS.execProgressIntervalMs);
    timer.unref();
  };
  const changed = (channel: 'stdout' | 'stderr', chunk: Buffer) => {
    if (chunk.length === 0) return;
    appendDisplay(channel === 'stdout' ? stdout : stderr, chunk);
    schedule();
  };
  managed.outputListeners.add(changed);
  if (initialSnapshot) schedule();
  return () => {
    stopped = true;
    managed.outputListeners.delete(changed);
    if (timer) clearTimeout(timer);
  };
}

function executionAbortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new AgentError('MAR_AGENT_EXECUTION_CANCELLED', 'Execution cancelled.');
}
