import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { CommandStateStore } from '../../src/runner-command-engine.js';
import { GoalRuntime } from '../../src/service/goal-runtime.js';
import { RunnerRegistry } from '../../src/runner/runner-registry.js';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';
import { GoalContinuationCoordinator } from '../../src/service/goal-continuation-coordinator.js';
import type { PreparedExecutionInput } from '../../src/service/continuous-run-coordinator.js';

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const runtime = new NodeRuntimeState(
    () => 'node',
    (id) => ({
      id,
      path: '/workspace',
      kind: 'DIRECTORY',
      gitSummary: null,
      createdAt: 1,
      updatedAt: 1
    })
  );
  const session = runtime.createAgentSession({
    workspaceId: 'workspace',
    cwd: '/workspace',
    runner: 'mar-agent'
  });
  const goals = new GoalRuntime(() => undefined);
  const runners = new RunnerRegistry([new MarAgentRunner()]);
  goals.start(session.id, 'Finish the task');
  const commands = new CommandStateStore();
  const emitSession = vi.fn();
  const submit = vi.fn(async (_input: unknown): Promise<unknown> => ({}));
  let input: PreparedExecutionInput<unknown>;
  const queue = {
    pending: () => input,
    hasExecutionStarted: () => true,
    removeGoalQueue: vi.fn(),
    removePendingQueue: vi.fn(),
    deleteQueueItem: vi.fn()
  };
  const coordinator = new GoalContinuationCoordinator({
    goals,
    runners: () => runners,
    runtime,
    commands,
    queue: () => queue,
    submit,
    emitRun: vi.fn(),
    present: (value) => value,
    emitSession,
    database: () => undefined
  });
  input = {
    sessionId: session.id,
    runId: 'execution',
    goal: coordinator.reference(session.id),
    secretEnvironment: {},
    executionContext: { runner: 'mar-agent' }
  } as PreparedExecutionInput<unknown>;
  return { coordinator, goals, runtime, session, input, commands, emitSession, submit, queue };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Goal transient orchestration', () => {
  it('passes the accepted Runner context unchanged into the next Goal execution', async () => {
    const f = fixture();
    await f.coordinator.maintainGoalContinuation(f.input, true);
    expect(f.submit).toHaveBeenCalledOnce();
    expect((f.submit.mock.calls[0]![0] as { executionContext: unknown }).executionContext).toBe(
      f.input.executionContext
    );
    f.coordinator.dispose();
  });

  it('does not republish a retired Goal when an admitted continuation settles late', async () => {
    const f = fixture();
    const pending = gate<unknown>();
    f.submit.mockImplementation(() => pending.promise);
    const starting = f.coordinator.maintainGoalContinuation(f.input, true);
    expect(f.goals.get(f.session.id)?.turns).toBe(1);
    f.coordinator.clear(f.session);
    f.emitSession.mockClear();
    pending.resolve({});
    await starting;
    expect(f.goals.get(f.session.id)).toBeUndefined();
    expect(f.commands.get(f.session.id, 'goal')).toBeUndefined();
    expect(f.emitSession).not.toHaveBeenCalled();
    expect(f.coordinator.keepRunActive(f.session.id)).toBe(false);
    f.coordinator.dispose();
  });

  it('disposes pending orchestration without publishing late results or scheduling retries', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = gate<unknown>();
    f.submit.mockImplementation(() => pending.promise);
    const starting = f.coordinator.maintainGoalContinuation(f.input, true);
    f.coordinator.dispose();
    pending.resolve({});
    await starting;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.emitSession).not.toHaveBeenCalled();
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.coordinator.keepRunActive(f.session.id)).toBe(false);
    expect(f.coordinator.goalGenerationCurrent(f.session.id, f.input.goal!)).toBe(false);
  });

  it('freezes autonomous retries while preserving references for admitted restore inputs', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.submit.mockRejectedValue(new Error('TEMPORARY_FAILURE'));
    await f.coordinator.maintainGoalContinuation(f.input, false);
    expect(f.coordinator.keepRunActive(f.session.id)).toBe(true);
    f.coordinator.freeze();
    expect(f.coordinator.prepareInsertion(f.session.id, 'restore-input', f.input.goal!)).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.goals.get(f.session.id)?.status).toBe('active');
    f.coordinator.dispose();
  });

  it('does not let an older same-generation success cancel a newer submission retry', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const older = gate<unknown>();
    f.submit.mockImplementationOnce(() => older.promise);
    f.submit.mockRejectedValueOnce(new Error('PREPARATION_FAILED'));
    const first = f.coordinator.maintainGoalContinuation(f.input, false);
    await f.coordinator.maintainGoalContinuation(f.input, false);
    older.resolve({});
    await first;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.submit).toHaveBeenCalledTimes(3);
    f.coordinator.dispose();
  });

  it('invalidates an old execution reference after clear and restoration of the same Goal identity', () => {
    const f = fixture();
    const snapshot = f.goals.restartState(f.session.id)!;
    f.coordinator.clear(f.session);
    f.goals.restoreRestartState(snapshot);
    const restored = f.coordinator.reference(f.session.id);
    expect(restored).toMatchObject({ id: f.input.goal!.id, revision: f.input.goal!.revision });
    expect(restored.epoch).not.toBe(f.input.goal!.epoch);
    expect(f.coordinator.goalGenerationCurrent(f.session.id, f.input.goal!)).toBe(false);
    expect(f.coordinator.goalGenerationCurrent(f.session.id, restored)).toBe(true);
    f.coordinator.dispose();
  });
});
