import { AgentError } from '../error.js';

import type { ExtensionHooks } from './hooks.js';
import type { ExtensionOperationContext } from './operation.js';
import type { ExtensionResourceScope } from './resources.js';

export interface ExtensionProcessInput {
  readonly executable: string;
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string | Uint8Array;
  readonly signal?: AbortSignal;
}
export interface ExtensionProcessRunInput extends ExtensionProcessInput {
  readonly timeoutMs?: number;
  readonly outputLimitBytes?: number;
}
export interface ExtensionProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
}
export interface ExtensionProcessHandle {
  readonly processId: string;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  wait(): Promise<ExtensionProcessExit>;
  cancel(): Promise<void>;
}
export interface ExtensionProcessResult extends ExtensionProcessExit {
  readonly processId: string;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly truncated: boolean;
  readonly timedOut: boolean;
}
export interface ExtensionProcessesApi {
  spawn(input: ExtensionProcessInput): Promise<ExtensionProcessHandle>;
  run(input: ExtensionProcessRunInput): Promise<ExtensionProcessResult>;
}
export interface ExtensionProcessesBackend {
  spawn(
    input: ExtensionProcessInput,
    call: ExtensionOperationContext
  ): Promise<ExtensionProcessHandle>;
}
export interface ExtensionProcessCompletion extends ExtensionProcessExit {
  readonly processId: string;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly truncated?: boolean;
  readonly timedOut?: boolean;
}

export function validateCoreProcessInput(input: ExtensionProcessInput): void {
  if (
    !input ||
    typeof input.executable !== 'string' ||
    !input.executable ||
    input.executable.includes('\0') ||
    (input.argv !== undefined &&
      (!Array.isArray(input.argv) ||
        input.argv.some((value) => typeof value !== 'string' || value.includes('\0')))) ||
    (input.cwd !== undefined && (typeof input.cwd !== 'string' || input.cwd.includes('\0'))) ||
    (input.env !== undefined &&
      (!input.env ||
        typeof input.env !== 'object' ||
        Array.isArray(input.env) ||
        Object.entries(input.env).some(
          ([key, value]) =>
            !key ||
            key.includes('=') ||
            key.includes('\0') ||
            typeof value !== 'string' ||
            value.includes('\0')
        ))) ||
    (input.input !== undefined &&
      typeof input.input !== 'string' &&
      !(input.input instanceof Uint8Array))
  )
    throw new AgentError('MAR_AGENT_PROCESS_INPUT_INVALID', 'Process input is invalid.');
}

function copyProcessInput<Value extends ExtensionProcessInput>(input: Value): Value {
  validateCoreProcessInput(input);
  return {
    ...input,
    ...(input.argv === undefined ? {} : { argv: [...input.argv] }),
    ...(input.env === undefined ? {} : { env: { ...input.env } }),
    ...(input.input instanceof Uint8Array ? { input: new Uint8Array(input.input) } : {})
  };
}

export function bindCoreProcesses(
  backend: ExtensionProcessesBackend,
  run: <Value>(
    operation: (call: ExtensionOperationContext) => Promise<Value>,
    signal?: AbortSignal
  ) => Promise<Value>,
  scope: ExtensionResourceScope,
  hooks: Pick<ExtensionHooks<DomainProcessOperations, DomainProcessFacts>, 'invoke' | 'emit'>,
  diagnose: () => void
): ExtensionProcessesApi {
  const acquire = async (
    input: ExtensionProcessInput,
    call: ExtensionOperationContext,
    emitExit = true
  ) => {
    input = copyProcessInput(input);
    if (typeof backend.spawn !== 'function')
      throw new AgentError(
        'MAR_AGENT_HOST_PORT_UNAVAILABLE',
        'Native process port is unavailable.'
      );
    let closed = false;
    const iterators: AsyncIterator<Uint8Array>[] = [];
    let pending!: Promise<ExtensionProcessHandle>;
    const resource = scope.effect(() => async () => {
      closed = true;
      call.signal.removeEventListener('abort', abort);
      const handle = await pending.catch(() => undefined);
      let firstError: unknown;
      let failed = false;
      try {
        if (typeof handle?.cancel === 'function') await handle.cancel();
      } catch (error) {
        failed = true;
        firstError = error;
      }
      const released = await Promise.allSettled(
        iterators.map((iterator) => Promise.resolve().then(() => iterator.return?.()))
      );
      const failure = released.find((result) => result.status === 'rejected');
      if (failed || failure?.status === 'rejected') {
        const error = failed
          ? firstError
          : failure?.status === 'rejected'
            ? failure.reason
            : undefined;
        throw new AgentError('MAR_AGENT_PROCESS_CLEANUP_FAILED', 'Native process cleanup failed.', {
          details: {
            reasonCode: error instanceof AgentError ? error.code : 'BACKEND_CLEANUP_FAILED'
          }
        });
      }
    });
    const cancel = () => resource.dispose();
    const abort = () => {
      void cancel().catch(() => diagnose());
    };
    pending = Promise.resolve().then(() => backend.spawn(input, call));
    call.signal.addEventListener('abort', abort, { once: true });
    let handle: ExtensionProcessHandle;
    try {
      handle = await pending;
      if (
        !handle ||
        typeof handle.processId !== 'string' ||
        !handle.processId ||
        typeof handle.wait !== 'function' ||
        typeof handle.cancel !== 'function' ||
        typeof handle.stdout?.[Symbol.asyncIterator] !== 'function' ||
        typeof handle.stderr?.[Symbol.asyncIterator] !== 'function'
      )
        throw new AgentError(
          'MAR_AGENT_PROCESS_OUTPUT_INVALID',
          'Native process handle is invalid.'
        );
      await resource.ready;
      call.signal.throwIfAborted();
    } catch (error) {
      try {
        await cancel();
      } catch {
        diagnose();
      }
      call.signal.throwIfAborted();
      throw error;
    }
    const stream = (source: AsyncIterable<Uint8Array>): AsyncIterableIterator<Uint8Array> => {
      const iterator = source[Symbol.asyncIterator]();
      iterators.push(iterator);
      let done = false;
      let tail: Promise<unknown> = Promise.resolve();
      async function pull(): Promise<IteratorResult<Uint8Array>> {
        if (done || closed) return { done: true, value: undefined };
        try {
          return await scope.run(async (signal) => {
            signal.throwIfAborted();
            const next = await iterator.next();
            signal.throwIfAborted();
            if (next.done) {
              done = true;
              return { done: true, value: undefined };
            }
            if (!(next.value instanceof Uint8Array))
              throw new AgentError(
                'MAR_AGENT_PROCESS_OUTPUT_INVALID',
                'Process stream must yield raw bytes.'
              );
            return { done: false, value: new Uint8Array(next.value) };
          }, call.signal);
        } catch (error) {
          done = true;
          try {
            await cancel();
          } catch {
            diagnose();
          }
          throw error;
        }
      }
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next() {
          const pending = tail.then(pull);
          tail = pending.catch(() => undefined);
          return pending;
        },
        async return() {
          done = true;
          await cancel();
          return { done: true, value: undefined };
        }
      };
    };
    let completion: Promise<ExtensionProcessExit> | undefined;
    return {
      processId: handle.processId,
      stdout: stream(handle.stdout),
      stderr: stream(handle.stderr),
      cancel,
      wait: () =>
        (completion ??= scope
          .run(async (signal) => {
            signal.throwIfAborted();
            const exit = await handle.wait();
            signal.throwIfAborted();
            if (
              !exit ||
              (exit.code !== null && !Number.isInteger(exit.code)) ||
              (exit.signal !== null && typeof exit.signal !== 'string')
            )
              throw new AgentError(
                'MAR_AGENT_PROCESS_OUTPUT_INVALID',
                'Native process exit result is invalid.'
              );
            if (emitExit)
              await hooks.emit('process.completed', { processId: handle.processId, ...exit }, call);
            return exit;
          }, call.signal)
          .catch(async (error) => {
            try {
              await cancel();
            } catch {
              diagnose();
            }
            throw error;
          }))
    };
  };
  return {
    spawn: async (input) => {
      input = copyProcessInput(input);
      return run(
        (call) =>
          hooks.invoke('process.spawn', input, call, (input, effective) =>
            acquire(input, effective)
          ),
        input.signal
      );
    },
    run: async (input) => {
      input = copyProcessInput(input);
      return run(
        (call) =>
          hooks.invoke('process.run', input, call, async (input, effective) => {
            const limit = input.outputLimitBytes ?? 4_194_304;
            const timeout = input.timeoutMs ?? 30_000;
            if (
              !Number.isSafeInteger(limit) ||
              limit < 0 ||
              !Number.isSafeInteger(timeout) ||
              timeout <= 0
            )
              throw new AgentError(
                'MAR_AGENT_PROCESS_INPUT_INVALID',
                'Process timeout and output limit are invalid.'
              );
            const handle = await acquire(input, effective, false);
            let timedOut = false;
            const due = performance.now() + timeout;
            let timer: ReturnType<typeof setTimeout>;
            let timeoutWork: Promise<void> | undefined;
            const arm = () => {
              timer = setTimeout(
                () => {
                  if (performance.now() < due) {
                    arm();
                    return;
                  }
                  timedOut = true;
                  timeoutWork = handle.cancel();
                  void timeoutWork.catch(() => undefined);
                },
                Math.min(Math.max(0, due - performance.now()), 2_147_483_647)
              );
              timer.unref();
            };
            arm();
            const collect = async (stream: AsyncIterable<Uint8Array>) => {
              const chunks: Uint8Array[] = [];
              let total = 0;
              let retained = 0;
              for await (const chunk of stream) {
                total += chunk.length;
                const keep = Math.min(chunk.length, limit - retained);
                if (keep > 0) {
                  chunks.push(chunk.slice(0, keep));
                  retained += keep;
                }
              }
              const bytes = new Uint8Array(retained);
              let offset = 0;
              for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.length;
              }
              return { bytes, total };
            };
            let failed = false;
            const work = [handle.wait(), collect(handle.stdout), collect(handle.stderr)] as const;
            try {
              const [exit, stdout, stderr] = await Promise.all(work);
              await timeoutWork;
              await hooks.emit(
                'process.completed',
                {
                  ...exit,
                  processId: handle.processId,
                  stdoutBytes: stdout.total,
                  stderrBytes: stderr.total,
                  truncated: stdout.total > limit || stderr.total > limit,
                  timedOut
                },
                effective
              );
              return {
                ...exit,
                processId: handle.processId,
                stdout: stdout.bytes,
                stderr: stderr.bytes,
                stdoutBytes: stdout.total,
                stderrBytes: stderr.total,
                truncated: stdout.total > limit || stderr.total > limit,
                timedOut
              };
            } catch (error) {
              failed = true;
              try {
                await handle.cancel();
              } catch {
                diagnose();
              }
              await Promise.allSettled(work);
              throw error;
            } finally {
              clearTimeout(timer!);
              try {
                await handle.cancel();
              } catch (error) {
                if (failed) diagnose();
                // eslint-disable-next-line no-unsafe-finally -- Cleanup may fail only when there is no primary failure.
                else throw error;
              }
            }
          }),
        input.signal
      );
    }
  };
}

export interface DomainProcessOperations {
  'process.spawn': { input: ExtensionProcessInput; output: ExtensionProcessHandle };
  'process.run': { input: ExtensionProcessRunInput; output: ExtensionProcessResult };
}
export interface DomainProcessFacts {
  'process.completed': ExtensionProcessCompletion;
}
