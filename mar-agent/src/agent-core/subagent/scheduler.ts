import { randomUUID } from 'node:crypto';
import { describeMarAgentError, MarAgentError } from '../error.js';
import { marAgentReasoningEffortSchema } from '../model/configuration.js';
import { TOOL_EXECUTION_LIMITS } from '../tools/execution-limits.js';
import { parseAgentWaitTargets, waitForAgentCondition } from './wait.js';
import type { SubagentManyOutput, SubagentManyOutputOptions } from './contracts.js';
import type {
  SubagentController,
  SubagentOutputOptions,
  SubagentRunOptions,
  SubagentTaskInput,
  SubagentTaskResult,
  SubagentTaskSnapshot
} from './contracts.js';
export type {
  SubagentController,
  SubagentLatestActivity,
  SubagentLatestMessage,
  SubagentMessageOptions,
  SubagentManyOutput,
  SubagentManyOutputOptions,
  SubagentOutputOptions,
  SubagentRunOptions,
  SubagentTaskInput,
  SubagentTaskResult,
  SubagentTaskSnapshot,
  SubagentWaitFor,
  SubagentWaitOutcome
} from './contracts.js';

interface TaskState {
  agentId: string;
  input: SubagentTaskInput;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  controller: AbortController;
  result?: SubagentTaskResult;
  errorCode?: string;
  errorMessage?: string;
  completion: Promise<void>;
  resolve: () => void;
  runner: (task: SubagentTaskInput, signal: AbortSignal) => Promise<SubagentTaskResult>;
}

export class SubagentScheduler implements SubagentController {
  readonly #tasks = new Map<string, TaskState>();
  readonly #queue: TaskState[] = [];
  readonly #completionWaiters = new Set<(task: TaskState) => void>();
  #running = 0;
  #disposed = false;
  #createdInExecution = 0;
  #runner: (task: SubagentTaskInput, signal: AbortSignal) => Promise<SubagentTaskResult>;
  constructor(
    runner: (task: SubagentTaskInput, signal: AbortSignal) => Promise<SubagentTaskResult>,
    readonly limits = { maxTasks: 16, maxConcurrent: 16 }
  ) {
    this.#runner = runner;
  }
  beginExecution(
    runner: (task: SubagentTaskInput, signal: AbortSignal) => Promise<SubagentTaskResult>
  ) {
    if (this.#disposed)
      throw new MarAgentError('MAR_AGENT_SUBAGENT_LIMIT', 'Subagent scheduler is disposed.');
    this.#runner = runner;
    this.#createdInExecution = 0;
  }
  async run(input: SubagentTaskInput, options: SubagentRunOptions = {}) {
    options.signal?.throwIfAborted();
    const reasoningEffort = (input as { reasoningEffort?: unknown }).reasoningEffort;
    const parsedReasoningEffort =
      typeof reasoningEffort === 'string'
        ? marAgentReasoningEffortSchema.safeParse(reasoningEffort.trim())
        : undefined;
    if (input.parentSubagentId)
      throw new MarAgentError(
        'MAR_AGENT_SUBAGENT_RECURSION_DISABLED',
        'Subagents cannot create subagents.'
      );
    if (this.#disposed || this.#createdInExecution >= this.limits.maxTasks)
      throw new MarAgentError('MAR_AGENT_SUBAGENT_LIMIT', 'Subagent task limit was reached.');
    if (
      !input.description.trim() ||
      input.description.length > TOOL_EXECUTION_LIMITS.subagentDescriptionMaxCharacters ||
      !input.prompt.trim() ||
      Buffer.byteLength(input.prompt) > TOOL_EXECUTION_LIMITS.subagentPromptMaxBytes ||
      (reasoningEffort !== undefined &&
        (parsedReasoningEffort === undefined || !parsedReasoningEffort.success))
    )
      throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Subagent task is invalid.');
    const agentId = randomUUID();
    let resolve!: () => void;
    const completion = new Promise<void>((done) => (resolve = done));
    const task: TaskState = {
      agentId,
      input: {
        ...input,
        description: input.description.trim(),
        ...(parsedReasoningEffort?.success ? { reasoningEffort: parsedReasoningEffort.data } : {})
      },
      status: 'queued',
      controller: new AbortController(),
      completion,
      resolve,
      runner: this.#runner
    };
    this.#createdInExecution++;
    this.#tasks.set(agentId, task);
    this.#queue.push(task);
    this.#drain();
    try {
      await options.onCreated?.(this.#public(task));
    } catch (error) {
      this.#cancelTask(task, error);
      if (task.status === 'running') await task.completion;
      throw error;
    }
    if (!input.background) await waitForPromise(completion, options.signal);
    return this.#public(task);
  }
  async output(agentId: string, options: SubagentOutputOptions = {}) {
    options.signal?.throwIfAborted();
    rejectUnsupportedMessageWait(options);
    const task = this.#tasks.get(agentId);
    if (!task)
      throw new MarAgentError('MAR_AGENT_SUBAGENT_NOT_FOUND', 'Subagent task was not found.');
    validateOutputOptions(options);
    const terminal = ['completed', 'failed', 'cancelled'].includes(task.status);
    if (options.waitMs === undefined || options.waitMs === 0)
      return { ...this.#public(task), waitOutcome: 'snapshot' as const };
    if (terminal) return { ...this.#public(task), waitOutcome: 'completion' as const };
    const waitMs = Math.max(options.waitMs, TOOL_EXECUTION_LIMITS.agentWaitWaitFloorMs);
    const completed = await this.#waitForCompletion(task, waitMs, options.signal);
    options.signal?.throwIfAborted();
    return {
      ...this.#public(task),
      waitOutcome: completed ? ('completion' as const) : ('timeout' as const)
    };
  }
  async outputAny(options: SubagentOutputOptions = {}) {
    options.signal?.throwIfAborted();
    validateOutputOptions(options);
    rejectUnsupportedMessageWait(options);
    const tasks = [...this.#tasks.values()];
    if (tasks.length === 0)
      throw new MarAgentError('MAR_AGENT_SUBAGENT_NOT_FOUND', 'Subagent task was not found.');
    const live = tasks.filter((task) => task.status === 'queued' || task.status === 'running');
    if (options.waitMs === undefined || options.waitMs === 0)
      return { ...this.#public(live.at(-1) ?? tasks.at(-1)!), waitOutcome: 'snapshot' as const };
    if (live.length === 0)
      return { ...this.#public(tasks.at(-1)!), waitOutcome: 'completion' as const };
    const waitMs = Math.max(options.waitMs, TOOL_EXECUTION_LIMITS.agentWaitWaitFloorMs);
    const completed = await this.#waitForAnyCompletion(live, waitMs, options.signal);
    options.signal?.throwIfAborted();
    return {
      ...this.#public(completed ?? live.at(-1)!),
      waitOutcome: completed ? ('completion' as const) : ('timeout' as const)
    };
  }
  async outputMany(
    agentIds: readonly string[],
    options: SubagentManyOutputOptions = {}
  ): Promise<SubagentManyOutput> {
    options.signal?.throwIfAborted();
    const { agentIds: ids, mode = 'any' } = parseAgentWaitTargets({ agentIds, mode: options.mode });
    validateOutputOptions(options);
    rejectUnsupportedMessageWait(options);
    if (!ids || 'untilSettled' in options)
      throw new MarAgentError(
        'MAR_AGENT_TOOL_INPUT_INVALID',
        'Group waits require explicit targets and a bounded deadline.'
      );
    const tasks = ids.map((id) => {
      const task = this.#tasks.get(id);
      if (!task)
        throw new MarAgentError('MAR_AGENT_SUBAGENT_NOT_FOUND', 'Subagent task was not found.');
      return task;
    });
    const terminal = (task: TaskState) => task.status !== 'queued' && task.status !== 'running';
    const snapshot = options.waitMs === undefined || options.waitMs === 0;
    const satisfied =
      !snapshot &&
      (await waitForAgentCondition({
        ready: () => (mode === 'all' ? tasks.every(terminal) : tasks.some(terminal)),
        subscribe: (notify) => {
          this.#completionWaiters.add(notify);
          return () => this.#completionWaiters.delete(notify);
        },
        waitMs: Math.max(options.waitMs!, TOOL_EXECUTION_LIMITS.agentWaitWaitFloorMs),
        signal: options.signal
      }));
    options.signal?.throwIfAborted();
    return {
      mode,
      waitFor: 'completion',
      waitOutcome: snapshot ? 'snapshot' : satisfied ? 'completion' : 'timeout',
      pendingAgentIds: tasks.filter((task) => !terminal(task)).map((task) => task.agentId),
      agents: tasks.map((task) => ({
        ...this.#public(task),
        waitOutcome: snapshot
          ? 'snapshot'
          : terminal(task)
            ? 'completion'
            : satisfied
              ? 'snapshot'
              : 'timeout'
      }))
    };
  }
  async cancel(agentId: string) {
    const task = this.#tasks.get(agentId);
    if (!task)
      throw new MarAgentError('MAR_AGENT_SUBAGENT_NOT_FOUND', 'Subagent task was not found.');
    this.#cancelTask(
      task,
      new MarAgentError('MAR_AGENT_CANCELLED', 'Subagent task was cancelled.')
    );
    if (task.status === 'running') await task.completion;
    return this.#public(task);
  }
  async message(_agentId: string, _message: string): Promise<SubagentTaskSnapshot> {
    throw new MarAgentError(
      'MAR_AGENT_SUBAGENT_FAILED',
      'The in-memory compatibility scheduler does not support follow-up messages.'
    );
  }
  #cancelTask(task: TaskState, reason: unknown) {
    if (task.status === 'queued') {
      task.status = 'cancelled';
      const index = this.#queue.indexOf(task);
      if (index >= 0) this.#queue.splice(index, 1);
      task.controller.abort(reason);
      task.resolve();
      this.#notifyCompletion(task);
      this.#drain();
    } else if (task.status === 'running') task.controller.abort(reason);
  }
  #drain() {
    while (!this.#disposed && this.#running < this.limits.maxConcurrent && this.#queue.length) {
      const task = this.#queue.shift()!;
      if (task.status !== 'queued') continue;
      task.status = 'running';
      this.#running++;
      void task
        .runner(task.input, task.controller.signal)
        .then(
          (result) => {
            if (task.controller.signal.aborted) task.status = 'cancelled';
            else {
              task.result = normalizeResult(result);
              task.status = 'completed';
            }
          },
          (error: unknown) => {
            task.status = task.controller.signal.aborted ? 'cancelled' : 'failed';
            const diagnostic = describeMarAgentError(error, 'MAR_AGENT_SUBAGENT_FAILED');
            task.errorCode = diagnostic.code;
            task.errorMessage = diagnostic.message;
          }
        )
        .finally(() => {
          this.#running--;
          task.resolve();
          this.#notifyCompletion(task);
          this.#drain();
        });
    }
  }
  #public(task: TaskState): SubagentTaskSnapshot {
    return {
      agentId: task.agentId,
      description: task.input.description,
      status: task.status,
      ...(task.result
        ? { summary: task.result.summary, changedFiles: [...task.result.changedFiles] }
        : {}),
      ...(task.errorCode ? { errorCode: task.errorCode } : {}),
      ...(task.errorMessage ? { errorMessage: task.errorMessage } : {})
    };
  }
  listSessionResources() {
    return [...this.#tasks.values()].map((task) => ({
      agentId: task.agentId,
      status: task.status,
      description: task.input.description
    }));
  }
  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const task of this.#tasks.values()) {
      if (task.status === 'queued') {
        task.status = 'cancelled';
        task.controller.abort();
        task.resolve();
        this.#notifyCompletion(task);
      } else if (task.status === 'running') task.controller.abort();
    }
    await Promise.all([...this.#tasks.values()].map((task) => task.completion));
    this.#queue.length = 0;
    this.#tasks.clear();
  }

  #waitForAnyCompletion(
    candidates: readonly TaskState[],
    waitMs: number,
    signal?: AbortSignal
  ): Promise<TaskState | undefined> {
    return waitForCompletionNotification(
      this.#completionWaiters,
      (task) => candidates.includes(task),
      waitMs,
      signal
    );
  }

  #waitForCompletion(
    task: TaskState,
    waitMs: number,
    signal?: AbortSignal
  ): Promise<TaskState | undefined> {
    return waitForCompletionNotification(
      this.#completionWaiters,
      (completed) => completed === task,
      waitMs,
      signal
    );
  }

  #notifyCompletion(task: TaskState): void {
    for (const waiter of this.#completionWaiters) waiter(task);
  }
}

function normalizeResult(result: SubagentTaskResult): SubagentTaskResult {
  return {
    summary: truncateUtf8(result.summary, TOOL_EXECUTION_LIMITS.subagentSummaryMaxBytes),
    changedFiles: [...new Set(result.changedFiles)]
      .filter((path) => typeof path === 'string' && path.length > 0 && path.length <= 4096)
      .slice(0, TOOL_EXECUTION_LIMITS.subagentChangedFilesMaxItems),
    verification: result.verification
      .filter((item) => typeof item === 'string')
      .slice(0, TOOL_EXECUTION_LIMITS.subagentVerificationMaxItems)
      .map((item) => truncateUtf8(item, 2_000)),
    evidence: (result.evidence ?? [])
      .filter(
        (item) =>
          item && typeof item.path === 'string' && item.path.length > 0 && item.path.length <= 4096
      )
      .slice(0, TOOL_EXECUTION_LIMITS.subagentEvidenceMaxItems)
      .map((item) => ({
        path: item.path,
        ...(Number.isInteger(item.startLine) && item.startLine! >= 1
          ? { startLine: item.startLine }
          : {}),
        ...(Number.isInteger(item.endLine) && item.endLine! >= 1 ? { endLine: item.endLine } : {})
      }))
  };
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (typeof value !== 'string') return '';
  const bytes = Buffer.from(value);
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function waitForCompletionNotification<T>(
  waiters: Set<(value: T) => void>,
  accepts: (value: T) => boolean,
  waitMs: number,
  signal?: AbortSignal
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      waiters.delete(notify);
      if (error === undefined) resolve(undefined);
      else reject(error);
    };
    const notify = (value: T) => {
      if (accepts(value)) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        waiters.delete(notify);
        resolve(value);
      }
    };
    const abort = () =>
      finish(
        signal?.reason ?? new MarAgentError('MAR_AGENT_EXECUTION_CANCELLED', 'Execution cancelled.')
      );
    const timer = setTimeout(finish, waitMs);
    timer.unref();
    waiters.add(notify);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function validateOutputOptions(options: SubagentOutputOptions): void {
  if (
    (options.waitFor !== undefined &&
      options.waitFor !== 'completion' &&
      options.waitFor !== 'message') ||
    (options.waitMs !== undefined &&
      (!Number.isInteger(options.waitMs) ||
        options.waitMs < TOOL_EXECUTION_LIMITS.agentWaitMinWaitMs ||
        options.waitMs > TOOL_EXECUTION_LIMITS.agentWaitMaxWaitMs))
  )
    throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Task wait is invalid.');
}

function rejectUnsupportedMessageWait(options: SubagentOutputOptions): void {
  if (options.waitFor === 'message')
    throw new MarAgentError(
      'MAR_AGENT_TOOL_NOT_AVAILABLE',
      'Message waits require a session-backed subagent controller.'
    );
}

function waitForPromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (result: { value: T } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if ('error' in result) reject(result.error);
      else resolve(result.value);
    };
    const abort = () =>
      finish({
        error:
          signal.reason ??
          new MarAgentError('MAR_AGENT_EXECUTION_CANCELLED', 'Execution cancelled.')
      });
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => finish({ value }),
      (error: unknown) => finish({ error })
    );
    if (signal.aborted) abort();
  });
}
