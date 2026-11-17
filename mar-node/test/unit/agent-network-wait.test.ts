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
  it('keeps explicit wait scoped to its execution while a later execution is unread', async () => {
    const f = fixture();
    f.publish('one', 'message', 'Earlier execution done');
    f.states.set('one', 'SUCCEEDED');
    f.publish('one', 'terminal', 'SUCCEEDED');
    f.network.publish({
      parentId: 'parent',
      childId: 'one',
      runId: 'later-run',
      executionId: 'later-execution',
      kind: 'message',
      value: 'Decision needed in the later execution'
    });
    const result = await waitForAgentTargets({ ...f, targets: [f.targets[0]!], single: true });
    expect(result).toMatchObject({ executionId: 'execution-one', status: 'SUCCEEDED' });
    expect(result).not.toHaveProperty('hasMoreUpdates');
    expect(JSON.stringify(result)).not.toContain('Decision needed');
    const [remaining] = await f.observations.collect(new AbortController().signal);
    expect(remaining!.content).toContain('Decision needed');
    remaining!.acknowledge();
    expect(await f.observations.collect(new AbortController().signal)).toEqual([]);
    f.observations.close();
  });

  it('returns the earliest unread report and leaves later reports for automatic collection', async () => {
    const f = fixture();
    for (const text of ['Decision: choose A or B', 'A second detail', 'Waiting for guidance'])
      f.publish('one', 'message', text);
    const result = await waitForAgentTargets({
      ...f,
      targets: [f.targets[0]!],
      single: true,
      waitFor: 'message',
      waitMs: 1000
    });
    expect(result).toMatchObject({
      hasMoreUpdates: true,
      updates: [{ kind: 'message', value: 'Decision: choose A or B' }]
    });
    const [remaining] = await f.observations.collect(new AbortController().signal);
    expect(remaining!.content).not.toContain('Decision: choose A or B');
    expect(remaining!.content).toContain('A second detail');
    expect(remaining!.content).toContain('Waiting for guidance');
    expect(remaining!.content).not.toContain('hasMoreUpdates');
    remaining!.acknowledge();
    expect(await f.observations.collect(new AbortController().signal)).toEqual([]);
    f.observations.close();
  });

  it('deduplicates only the final reply represented by the returned summary', async () => {
    const f = fixture();
    for (const value of ['Decision in earlier final', 'Latest final'])
      f.network.publish({
        parentId: 'parent',
        childId: 'one',
        runId: 'run-one',
        executionId: 'execution-one',
        kind: 'message',
        value,
        final: true
      });
    f.states.set('one', 'SUCCEEDED');
    f.publish('one', 'terminal', 'SUCCEEDED');
    const result = await waitForAgentTargets({ ...f, targets: [f.targets[0]!], single: true });
    expect(result).toMatchObject({ summary: 'Latest final' });
    expect(result).toMatchObject({
      updates: [
        { kind: 'message', value: 'Decision in earlier final', final: true },
        { kind: 'terminal', value: 'SUCCEEDED' }
      ]
    });
    expect(await f.observations.collect(new AbortController().signal)).toEqual([]);
    f.observations.close();
  });

  it.each([1, 1000])(
    'uses the requested %i ms deadline without a hidden minimum',
    async (waitMs) => {
      vi.useFakeTimers();
      const f = fixture();
      let settled = false;
      const result = waitForAgentTargets({ ...f, targets: [f.targets[0]!], single: true, waitMs });
      void result.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(waitMs - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(await result).toMatchObject({ waitOutcome: 'timeout', status: 'RUNNING' });
      expect(vi.getTimerCount()).toBe(0);
    }
  );

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

  it('keeps a captured terminal result when later executions overflow during a group wait', async () => {
    const f = fixture();
    const waiting = waitForAgentTargets({ ...f, mode: 'all' });
    const identity = {
      parentId: 'parent',
      childId: 'one',
      runId: 'run-one',
      executionId: 'execution-one'
    };
    f.network.publish({ ...identity, kind: 'files', paths: ['done.ts'] });
    f.network.publish({ ...identity, kind: 'message', value: 'Original conclusion', final: true });
    f.states.set('one', 'SUCCEEDED');
    f.publish('one', 'terminal', 'SUCCEEDED');
    for (let index = 0; index < 11; index++)
      f.publish('one', 'message', `later-${index}`, `later-execution-${index}`);
    f.states.set('two', 'SUCCEEDED');
    f.publish('two', 'terminal', 'SUCCEEDED');
    expect(await waiting).toMatchObject({
      agents: [
        {
          agentId: 'one',
          status: 'SUCCEEDED',
          summary: 'Original conclusion',
          changedFiles: ['done.ts'],
          omittedUpdates: 3
        },
        { agentId: 'two', status: 'SUCCEEDED' }
      ]
    });
    expect(f.observations.captureOmissions('one')).toBeUndefined();
    expect(f.observations.capture('one')!.updates[0]!.value).toBe('later-1');
    f.observations.close();
  });

  it('delivers relationship omissions without inventing a snapshot for an evicted execution', async () => {
    const f = fixture();
    for (let index = 0; index < 11; index++)
      f.publish('one', 'message', `later-${index}`, `later-execution-${index}`);
    f.states.set('one', 'SUCCEEDED');
    const result = await waitForAgentTargets({ ...f, targets: [f.targets[0]!], single: true });
    expect(result).toMatchObject({ agentId: 'one', status: 'SUCCEEDED', omittedUpdates: 1 });
    expect(result).not.toHaveProperty('updates');
    expect(result).not.toHaveProperty('summary');
    expect(f.observations.capture('one', 'execution-one')).toBeUndefined();
    expect(f.observations.capture('one')!.updates[0]!.value).toBe('later-1');
    f.observations.close();
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

  it('keeps omitted-update counts through a zero snapshot until a consuming wait acknowledges them', async () => {
    const f = fixture();
    for (let index = 0; index < 11; index++) f.publish('one', 'message', `update-${index}`);
    const target = [f.targets[0]!];
    const snapshot = await waitForAgentTargets({
      ...f,
      targets: target,
      single: true,
      waitFor: 'message',
      waitMs: 0
    });
    expect(snapshot).toMatchObject({ status: 'RUNNING', waitOutcome: 'snapshot' });
    expect(snapshot).not.toHaveProperty('omittedUpdates');
    expect(snapshot).not.toHaveProperty('updates');

    const first = await waitForAgentTargets({
      ...f,
      targets: target,
      single: true,
      waitFor: 'message',
      waitMs: 1000
    });
    expect(first).toMatchObject({
      waitOutcome: 'message',
      omittedUpdates: 1,
      hasMoreUpdates: true,
      updates: [{ value: 'update-1' }]
    });

    const next = await waitForAgentTargets({
      ...f,
      targets: target,
      single: true,
      waitFor: 'message',
      waitMs: 1000
    });
    expect(next).toMatchObject({ updates: [{ value: 'update-2' }] });
    expect(next).not.toHaveProperty('omittedUpdates');
    f.observations.close();
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
