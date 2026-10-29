import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentNetworkObservations } from '../../src/service/agent-network-observations.js';
import { waitForAgentTargets, type AgentWaitTarget } from '../../src/service/agent-network-wait.js';

function fixture() {
  const network = new AgentNetworkObservations();
  const observations = network.attach('parent');
  const states = new Map([
    ['one', 'RUNNING'],
    ['two', 'RUNNING']
  ]);
  const targets: AgentWaitTarget[] = ['one', 'two'].map((id) => ({
    agentId: id,
    runId: `run-${id}`,
    executionId: `execution-${id}`,
    read: () => ({ status: states.get(id)! })
  }));
  const publish = (
    id: string,
    kind: 'message' | 'terminal',
    value: string,
    executionId = `execution-${id}`
  ) =>
    network.publish({
      parentId: 'parent',
      childId: id,
      runId: `run-${id}`,
      executionId,
      kind,
      value
    });
  return { network, observations, states, targets, publish };
}

afterEach(() => vi.useRealTimers());

describe('Agent Network waiting', () => {
  it.each(['FAILED', 'CANCELLED'] as const)(
    'does not return a final summary when the execution ends as %s',
    async (status) => {
      const f = fixture();
      const base = {
        parentId: 'parent',
        childId: 'one',
        runId: 'run-one',
        executionId: 'execution-one'
      };
      f.network.publish({
        ...base,
        kind: 'message',
        value: 'premature',
        final: true,
        turnId: 'turn'
      });
      f.states.set('one', status);
      f.network.publish({ ...base, kind: 'terminal', value: status });
      const result = await waitForAgentTargets({ ...f, targets: [f.targets[0]!], single: true });
      expect(result).toMatchObject({ status, waitOutcome: 'completion' });
      expect(result).not.toHaveProperty('summary');
    }
  );
  it('returns a terminal projection once, without consuming it for a zero snapshot', async () => {
    const f = fixture();
    const base = {
      parentId: 'parent',
      childId: 'one',
      runId: 'run-one',
      executionId: 'execution-one'
    };
    f.network.publish({ ...base, kind: 'files', paths: ['changed.ts'] });
    f.network.publish({
      ...base,
      kind: 'message',
      value: 'final answer',
      final: true,
      turnId: 'turn'
    });
    f.states.set('one', 'SUCCEEDED');
    f.network.publish({ ...base, kind: 'terminal', value: 'SUCCEEDED' });
    const snapshot = await waitForAgentTargets({
      ...f,
      targets: [f.targets[0]!],
      single: true,
      waitMs: 0
    });
    expect(snapshot).toMatchObject({ status: 'SUCCEEDED', waitOutcome: 'snapshot' });
    expect(snapshot).not.toHaveProperty('summary');
    const result = await waitForAgentTargets({ ...f, targets: [f.targets[0]!], single: true });
    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      summary: 'final answer',
      turnId: 'turn',
      changedFiles: ['changed.ts'],
      updates: [{ kind: 'terminal', value: 'SUCCEEDED' }]
    });
    const repeated = await waitForAgentTargets({ ...f, targets: [f.targets[0]!], single: true });
    expect(repeated).not.toHaveProperty('summary');
    expect(repeated).not.toHaveProperty('changedFiles');
  });

  it('pins the terminal projection for an already waiting caller when another observer acknowledges first', async () => {
    const f = fixture();
    const base = {
      parentId: 'parent',
      childId: 'one',
      runId: 'run-one',
      executionId: 'execution-one'
    };
    f.observations.subscribe((snapshot) => snapshot?.acknowledge());
    const waiting = waitForAgentTargets({ ...f, targets: [f.targets[0]!], single: true });
    f.network.publish({ ...base, kind: 'files', paths: ['changed.ts'] });
    f.network.publish({ ...base, kind: 'message', value: 'finished', final: true });
    f.states.set('one', 'SUCCEEDED');
    f.network.publish({ ...base, kind: 'terminal', value: 'SUCCEEDED' });
    expect(await waiting).toMatchObject({
      status: 'SUCCEEDED',
      summary: 'finished',
      changedFiles: ['changed.ts']
    });
    expect(f.observations.capture('one')).toBeUndefined();
  });

  it('takes a non-consuming zero-wait snapshot', async () => {
    const f = fixture();
    f.publish('one', 'message', 'unread');
    const result = await waitForAgentTargets({ ...f, waitFor: 'message', waitMs: 0 });
    expect(result).toMatchObject({
      waitOutcome: 'snapshot',
      agents: [
        { agentId: 'one', waitOutcome: 'snapshot' },
        { agentId: 'two', waitOutcome: 'snapshot' }
      ]
    });
    expect(f.observations.wake.pending()).toBe(true);
  });

  it('waits for a newly admitted Run before its Execution exists without consuming an older turn', async () => {
    const f = fixture();
    let executionId: string | undefined;
    const target: AgentWaitTarget = {
      agentId: 'one',
      runId: 'new-run',
      get executionId() {
        return executionId;
      },
      read: () => ({ status: 'RUNNING' })
    };
    f.publish('one', 'terminal', 'old terminal');
    const waiting = waitForAgentTargets({
      targets: [target],
      observations: f.observations,
      waitFor: 'message',
      waitMs: 10_000,
      single: true
    });
    executionId = 'new-execution';
    f.network.publish({
      parentId: 'parent',
      childId: 'one',
      runId: 'new-run',
      executionId,
      kind: 'message',
      value: 'new progress'
    });
    expect(await waiting).toMatchObject({
      runId: 'new-run',
      executionId,
      waitOutcome: 'message',
      updates: [{ value: 'new progress' }]
    });
    expect(f.observations.capture('one', 'execution-one')?.updates).toMatchObject([
      { value: 'old terminal' }
    ]);
  });

  it('wakes on an actual message, consuming only that captured execution', async () => {
    const f = fixture();
    const waiting = waitForAgentTargets({ ...f, waitFor: 'message', waitMs: 10_000 });
    f.publish('one', 'message', 'first');
    f.publish('two', 'message', 'new execution', 'later-execution');
    const result = await waiting;
    expect(result).toMatchObject({
      waitFor: 'message',
      waitOutcome: 'message',
      agents: [
        { agentId: 'one', waitOutcome: 'message', updates: [{ value: 'first' }] },
        { agentId: 'two', waitOutcome: 'snapshot' }
      ]
    });
    expect(f.observations.capture('two', 'later-execution')).toBeDefined();
  });

  it('untargeted waits return and consume only the earliest ready child', async () => {
    const f = fixture();
    f.publish('two', 'message', 'first');
    f.publish('one', 'message', 'second');
    expect(
      await waitForAgentTargets({ ...f, single: true, waitFor: 'message', waitMs: 10_000 })
    ).toMatchObject({
      agentId: 'two',
      waitFor: 'message',
      waitOutcome: 'message',
      updates: [{ value: 'first' }]
    });
    expect(f.observations.capture('two')).toBeUndefined();
    expect(f.observations.capture('one')?.updates[0]?.value).toBe('second');
  });

  it('allows an untargeted wait to observe more than eight live children', async () => {
    const f = fixture();
    const targets: AgentWaitTarget[] = Array.from({ length: 12 }, (_, index) => ({
      agentId: String(index),
      runId: `run-${index}`,
      executionId: `execution-${index}`,
      read: () => ({ status: 'RUNNING' })
    }));
    expect(
      await waitForAgentTargets({ targets, observations: f.observations, single: true, waitMs: 0 })
    ).toMatchObject({ agentId: '0', waitOutcome: 'snapshot' });
  });

  it('all waits for both fixed completions under one deadline', async () => {
    const f = fixture();
    const waiting = waitForAgentTargets({ ...f, mode: 'all', waitMs: 10_000 });
    f.states.set('one', 'SUCCEEDED');
    f.publish('one', 'terminal', 'SUCCEEDED');
    f.states.set('two', 'FAILED');
    f.publish('two', 'terminal', 'FAILED');
    const result = await waiting;
    expect(result).toMatchObject({
      waitFor: 'completion',
      waitOutcome: 'completion',
      pendingAgentIds: [],
      agents: [
        { executionId: 'execution-one', waitOutcome: 'completion' },
        { executionId: 'execution-two', waitOutcome: 'completion' }
      ]
    });
  });

  it('defaults to a 30-second completion wait rather than a snapshot', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let settled = false;
    const waiting = waitForAgentTargets({ ...f }).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiting).toMatchObject({ waitFor: 'completion', waitOutcome: 'timeout' });
  });

  it('reports message for an all wait with one nonterminal message and one completion', async () => {
    const f = fixture();
    const waiting = waitForAgentTargets({ ...f, mode: 'all', waitFor: 'message', waitMs: 10_000 });
    f.states.set('one', 'SUCCEEDED');
    f.publish('one', 'terminal', 'SUCCEEDED');
    f.publish('two', 'message', 'progress');
    expect(await waiting).toMatchObject({
      waitFor: 'message',
      waitOutcome: 'message',
      agents: [{ waitOutcome: 'completion' }, { waitOutcome: 'message' }]
    });
  });

  it('timeout carries and consumes unread progress, but cancellation does not', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const timed = waitForAgentTargets({ ...f, waitFor: 'completion', waitMs: 10_000 });
    f.publish('one', 'message', 'progress');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await timed).toMatchObject({
      waitOutcome: 'timeout',
      agents: [
        { agentId: 'one', waitOutcome: 'timeout', updates: [{ value: 'progress' }] },
        { agentId: 'two', waitOutcome: 'timeout' }
      ]
    });
    const abort = new AbortController();
    const cancelled = waitForAgentTargets({ ...f, waitMs: 10_000, signal: abort.signal });
    f.publish('one', 'message', 'still unread');
    abort.abort(new Error('cancelled'));
    await expect(cancelled).rejects.toThrow('cancelled');
    expect(f.observations.capture('one')?.updates[0]?.value).toBe('still unread');
  });

  it('reports a steer interruption and consumes the progress it returns', async () => {
    const f = fixture();
    let pending = false;
    let notify = () => {};
    const waiting = waitForAgentTargets({
      ...f,
      waitMs: 10_000,
      interrupt: {
        pending: () => pending,
        subscribe: (listener) => {
          notify = listener;
          return () => {
            notify = () => {};
          };
        }
      }
    });
    f.publish('one', 'message', 'progress before steer');
    pending = true;
    notify();
    expect(await waiting).toMatchObject({
      waitOutcome: 'interrupted',
      reason: 'steer',
      agents: [
        { waitOutcome: 'interrupted', updates: [{ value: 'progress before steer' }] },
        { waitOutcome: 'interrupted' }
      ]
    });
    expect(f.observations.capture('one')).toBeUndefined();
  });
});
