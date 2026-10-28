import { randomUUID } from 'node:crypto';
import {
  ComputerUseError,
  type ComputerUseInput,
  type ComputerUseResult,
  type ComputerUseTaskResult,
  type ComputerUseWaitInput
} from './contracts.js';
import { PythonWorker } from './worker.js';

export interface ControlIndicator {
  readonly lost?: Promise<Error>;
  assertActive?(): void;
  close(): Promise<void>;
}

type TaskCompletion = { result: ComputerUseResult } | { error: unknown };
interface ComputerUseTask {
  readonly id: string;
  readonly stop: AbortController;
  readonly completion: Promise<TaskCompletion>;
  settled?: TaskCompletion;
}

export class ComputerUseDesktopLeaseService {
  #holder:
    | {
        readonly runId: string;
        readonly leaseId: string;
        readonly acquiredAt: number;
      }
    | undefined;

  acquire(runId: string) {
    if (this.#holder?.runId === runId) return this.#holder;
    if (this.#holder !== undefined)
      throw new ComputerUseError(
        'DESKTOP_BUSY',
        `The desktop is in use by another Run since ${new Date(this.#holder.acquiredAt).toISOString()}.`
      );
    this.#holder = { runId, leaseId: randomUUID(), acquiredAt: Date.now() };
    return this.#holder;
  }

  release(runId: string): void {
    if (this.#holder?.runId === runId) this.#holder = undefined;
  }

  holder():
    { readonly runId: string; readonly leaseId: string; readonly acquiredAt: number } | undefined {
    return this.#holder;
  }
}

export class ComputerUseSessionResources {
  #worker: PythonWorker | undefined;
  #observationId: string | undefined;
  #runtimeGeneration = 1;
  #runId: string | undefined;
  #closed = false;
  #bindingClose: (() => Promise<void>) | undefined;
  #closePromise: Promise<void> | undefined;
  #cleanupError: Error | undefined;
  #task: ComputerUseTask | undefined;
  #bindingStop = new AbortController();
  #unsubscribeExecution: (() => void) | undefined;

  constructor(
    private readonly runtimeExecutable: string,
    private readonly lease: ComputerUseDesktopLeaseService,
    private readonly showControlIndicator: (runtimeExecutable: string) => Promise<ControlIndicator>,
    private readonly validateDesktop: () => Promise<void>
  ) {}

  attach(runId: string, signal?: AbortSignal): void {
    if (this.#cleanupError !== undefined) throw this.#cleanupError;
    if (this.#closed)
      throw new ComputerUseError('COMPUTER_UNAVAILABLE', 'Computer Use resources are closed.');
    if (this.#runId !== undefined)
      throw new ComputerUseError(
        'COMPUTER_SESSION_BUSY',
        'Computer Use Session resources are already attached to another Run.'
      );
    this.#runId = runId;
    this.#observationId = undefined;
    this.#task = undefined;
    this.#bindingStop = new AbortController();
    const abort = () => {
      this.#bindingStop.abort();
      if (this.#task?.settled === undefined) this.#task?.stop.abort();
    };
    signal?.addEventListener('abort', abort, { once: true });
    this.#unsubscribeExecution = () => signal?.removeEventListener('abort', abort);
    if (signal?.aborted) abort();
  }

  async detach(runId: string): Promise<void> {
    if (this.#runId !== runId) return;
    this.#bindingStop.abort();
    this.#unsubscribeExecution?.();
    this.#unsubscribeExecution = undefined;
    if (this.#task?.settled === undefined) this.#task?.stop.abort();
    await this.#task?.completion;
    if (this.#cleanupError !== undefined) throw this.#cleanupError;
    if (this.#closed) return;
    this.#observationId = undefined;
    this.#task = undefined;
    this.lease.release(runId);
    this.#runId = undefined;
    this.#bindingClose = undefined;
  }

  setBindingClose(close: () => Promise<void>): void {
    this.#bindingClose = close;
  }

  async call(input: ComputerUseInput, signal: AbortSignal): Promise<ComputerUseTaskResult> {
    const runId = this.#assertBound();
    if (signal.aborted)
      throw new ComputerUseError('COMPUTER_UNAVAILABLE', 'Computer Use call was cancelled.');
    if (this.#cleanupError !== undefined) throw this.#cleanupError;
    if (this.#task !== undefined && this.#task.settled === undefined)
      throw new ComputerUseError('COMPUTER_SESSION_BUSY', 'Computer Use is already executing.');
    if (
      input.basedOnObservationId !== undefined &&
      input.basedOnObservationId !== this.#observationId
    )
      throw new ComputerUseError(
        'COMPUTER_OBSERVATION_STALE',
        'The desktop observation is stale; observe again before acting.'
      );
    this.lease.acquire(runId);
    this.#observationId = undefined;
    const stop = new AbortController();
    const abort = () => stop.abort();
    signal.addEventListener('abort', abort, { once: true });
    const task: ComputerUseTask = {
      id: `cu_${randomUUID()}`,
      stop,
      // Admission is synchronous; preparation and every failure belong to this slot.
      completion: Promise.resolve()
        .then(() => this.#execute(input, stop.signal, runId))
        .then(
          (result) => (task.settled = { result }),
          (error: unknown) => (task.settled = { error })
        )
    };
    this.#task = task;
    try {
      return await this.#waitTask(task, input.yieldMs);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  async wait(input: ComputerUseWaitInput, signal: AbortSignal): Promise<ComputerUseTaskResult> {
    this.#assertBound();
    if (signal.aborted) throw waitCancelled();
    const task = this.#task;
    if (task === undefined || task.id !== input.taskId)
      throw new ComputerUseError(
        'COMPUTER_TASK_NOT_FOUND',
        'The task is not available in this binding.'
      );
    if (input.action === 'cancel' && task.settled === undefined) task.stop.abort();
    return this.#waitTask(task, input.yieldMs, signal);
  }

  #assertBound(): string {
    if (this.#closed || this.#runId === undefined || this.#bindingStop.signal.aborted)
      throw new ComputerUseError('COMPUTER_UNAVAILABLE', 'Computer Use binding is closed.');
    return this.#runId;
  }

  async #waitTask(
    task: ComputerUseTask,
    yieldMs?: number,
    signal?: AbortSignal
  ): Promise<ComputerUseTaskResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      if (task.settled === undefined && yieldMs !== 0) {
        const waits: Promise<unknown>[] = [task.completion];
        if (yieldMs !== undefined)
          waits.push(
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, yieldMs);
            })
          );
        if (signal !== undefined)
          waits.push(
            new Promise<never>((_, reject) => {
              onAbort = () => reject(waitCancelled());
              signal.addEventListener('abort', onAbort, { once: true });
              if (signal.aborted) onAbort();
            })
          );
        await Promise.race(waits);
      }
      if (this.#task !== task)
        throw new ComputerUseError(
          'COMPUTER_TASK_NOT_FOUND',
          'The task is no longer available in this binding.'
        );
      if (task.settled === undefined)
        return { taskId: task.id, status: task.stop.signal.aborted ? 'STOPPING' : 'RUNNING' };
      if ('error' in task.settled) throw task.settled.error;
      return { ...task.settled.result, taskId: task.id, status: 'COMPLETED' };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    }
  }

  async #execute(
    input: ComputerUseInput,
    signal: AbortSignal,
    runId: string
  ): Promise<ComputerUseResult> {
    this.#assertActive(signal, runId);
    await this.validateDesktop();
    this.#assertActive(signal, runId);
    let indicator: ControlIndicator;
    try {
      indicator = await this.showControlIndicator(this.runtimeExecutable);
    } catch (error) {
      if (error instanceof ComputerUseError && error.code === 'COMPUTER_CLEANUP_FAILED') {
        this.#cleanupError = error;
        throw error;
      }
      throw new ComputerUseError(
        'COMPUTER_CONTROL_INDICATOR_UNAVAILABLE',
        'The desktop control indicator could not be displayed.',
        { cause: error }
      );
    }
    let result: ComputerUseResult | undefined;
    let primaryError: unknown;
    let failed = false;
    try {
      this.#assertActive(signal, runId);
      const worker = await this.#ensureWorker();
      this.#assertActive(signal, runId);
      let executionStarted = false;
      try {
        indicator.assertActive?.();
        executionStarted = true;
        const execution = worker.execute(input.code, input.timeoutMs, signal);
        const executionResult = await (indicator.lost === undefined
          ? execution
          : Promise.race([
              execution,
              indicator.lost.then((error) => {
                throw error;
              })
            ]));
        result = {
          outcome: 'SUCCEEDED',
          observationId: randomUUID(),
          runtimeGeneration: this.#runtimeGeneration,
          logs: executionResult.logs,
          images: executionResult.images
        };
      } catch (error) {
        if (executionStarted && worker.startedRequest) {
          try {
            await this.#resetWorker();
          } catch {
            // The worker owner records cleanup failure; the sent request remains uncertain.
          }
          this.#observationId = undefined;
          const message =
            error instanceof Error ? error.message : 'Computer Use execution ended unexpectedly.';
          result = {
            message,
            outcome: 'OUTCOME_UNKNOWN',
            observationId: '',
            runtimeGeneration: this.#runtimeGeneration,
            logs: []
          };
        } else throw error;
      }
    } catch (error) {
      failed = true;
      primaryError = error;
    }
    try {
      await indicator.close();
    } catch (error) {
      this.#observationId = undefined;
      this.#cleanupError ??= new ComputerUseError(
        'COMPUTER_CLEANUP_FAILED',
        'Computer Use indicator cleanup failed.',
        { cause: error }
      );
    }
    if (failed) {
      if (this.#cleanupError !== undefined)
        throw withCleanupFailure(primaryError, this.#cleanupError);
      throw primaryError;
    }
    if (result === undefined) throw new Error('Computer Use execution returned no result.');
    if (this.#cleanupError !== undefined)
      return { ...result, observationId: '', cleanupFailed: true };
    this.#observationId = result.observationId || undefined;
    return result;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#observationId = undefined;
    this.#closePromise = (async () => {
      let failure: unknown;
      try {
        await this.#bindingClose?.();
      } catch (error) {
        failure = error;
      }
      try {
        await this.#resetWorker();
      } catch (error) {
        failure ??= error;
      }
      if (failure !== undefined) throw failure;
      if (this.#runId !== undefined) this.lease.release(this.#runId);
      this.#runId = undefined;
      this.#bindingClose = undefined;
      this.#task = undefined;
    })();
    return this.#closePromise;
  }

  #assertActive(signal: AbortSignal, runId: string): void {
    if (signal.aborted || this.#closed || this.#runId !== runId)
      throw new ComputerUseError('COMPUTER_UNAVAILABLE', 'Computer Use binding is closed.');
  }

  async #ensureWorker(): Promise<PythonWorker> {
    if (this.#worker !== undefined) return this.#worker;
    try {
      return await PythonWorker.start(this.runtimeExecutable, (worker) => {
        this.#worker = worker;
      });
    } catch (error) {
      if (error instanceof ComputerUseError && error.code === 'COMPUTER_CLEANUP_FAILED')
        this.#cleanupError = error;
      try {
        await this.#resetWorker();
      } catch (cleanupError) {
        throw withCleanupFailure(error, cleanupError);
      }
      throw error;
    }
  }

  async #resetWorker(): Promise<void> {
    const worker = this.#worker;
    if (worker !== undefined) {
      try {
        await worker.close();
      } catch (error) {
        this.#cleanupError = new ComputerUseError(
          'COMPUTER_CLEANUP_FAILED',
          'Computer Use worker cleanup failed.',
          { cause: error }
        );
        throw this.#cleanupError;
      }
      this.#worker = undefined;
      this.#runtimeGeneration++;
    }
  }
}

function waitCancelled(): ComputerUseError {
  return new ComputerUseError(
    'COMPUTER_WAIT_CANCELLED',
    'Waiting was cancelled; use wait to inspect the task.'
  );
}

function withCleanupFailure(primary: unknown, cleanup: unknown): Error {
  const message = `${primary instanceof Error ? primary.message : 'Computer Use execution failed.'} Computer Use cleanup failed; further use is blocked.`;
  const cause = new AggregateError([primary, cleanup], 'Computer Use execution and cleanup failed');
  return primary instanceof ComputerUseError
    ? new ComputerUseError(primary.code, message, { cause })
    : new Error(message, { cause });
}
