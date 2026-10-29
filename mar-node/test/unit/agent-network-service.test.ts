import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeAgentSession } from '../../src/session/contracts.js';
import { AgentNetworkObservations } from '../../src/service/agent-network-observations.js';
import { AgentNetworkService } from '../../src/service/agent-network-service.js';
import { invokeAgentNetwork } from '../../src/service/agent-network-invoke.js';
import type { ExtensionOperationContext } from '@myagentroam/agent/extensions';

function fixture(parentSessionId: string | null = 'parent') {
  const observations = new AgentNetworkObservations();
  const parent = observations.attach('parent');
  const target = {
    id: 'child',
    workspaceId: 'workspace',
    parentSessionId
  } as NodeAgentSession;
  let goal: unknown = { objective: 'old' };
  const setGoal = vi.fn(async (_actor, _session, change) => {
    goal = change.kind === 'clear' ? undefined : { objective: change.objective };
    return goal;
  });
  const message = vi.fn(async () => ({ delivery: 'ACCEPTED' }));
  const approval = vi.fn(async () => ({
    status: 'applied' as const,
    result: { approvalId: 'approval', decision: 'approve' }
  }));
  const validateApproval = vi.fn(async () => {});
  const stop = vi.fn(() => {
    goal = undefined;
    return { accepted: true };
  });
  const resolveTarget = vi.fn(async (_actor, _id: string) => target);
  const children = vi.fn(async () => [target]);
  const observe = vi.fn(() => {
    if (!observations.get('parent')) observations.attach('parent');
  });
  const freezeExecution = vi.fn((session: NodeAgentSession) => ({
    agentId: session.id,
    runId: 'run',
    executionId: 'execution',
    read: () => ({ status: 'RUNNING' })
  }));
  const start = vi.fn(async (_actor, _input) => ({
    session: target,
    result: { delivery: 'STARTED' }
  }));
  const service = new AgentNetworkService({
    observations,
    target: resolveTarget,
    children,
    observe,
    freezeExecution,
    authorize: async () => {},
    start,
    setGoal,
    message,
    approval,
    validateApproval,
    stop,
    goal: () => goal,
    list: async () => ({}),
    view: async () => ({})
  });
  const actor = { sessionId: 'parent', requestUserId: 7 };
  const publish = (value: string) =>
    observations.publish({
      parentId: 'parent',
      childId: 'child',
      runId: 'run',
      executionId: 'execution',
      kind: 'message',
      value
    });
  return {
    actor,
    service,
    observations,
    target,
    parent,
    publish,
    setGoal,
    message,
    approval,
    validateApproval,
    stop,
    goal: () => goal,
    resolveTarget,
    children,
    observe,
    freezeExecution,
    start
  };
}

afterEach(() => vi.useRealTimers());

describe('Agent Network send and stop', () => {
  it.each(['message', 'goal', 'failed message'])(
    'does not subscribe to a non-child after sending %s',
    async (operation) => {
      const f = fixture('other-parent');
      if (operation === 'failed message')
        f.message.mockRejectedValueOnce(new Error('DELIVERY_FAILED'));
      await f.service.send(f.actor, {
        agentId: f.target.id,
        ...(operation === 'goal' ? { goal: { clear: true } } : { content: 'work' })
      });
      expect(f.observe).not.toHaveBeenCalled();
      f.observations.publishChild({
        parentId: 'other-parent',
        childId: f.target.id,
        runId: 'run',
        executionId: 'execution',
        kind: 'message',
        value: 'peer update'
      });
      expect(await f.parent.collect(new AbortController().signal)).toEqual([]);
      expect(f.parent.wake.pending()).toBe(false);
    }
  );

  it.each(['send', 'wait'] as const)(
    'repairs a missing direct-parent observation channel through %s',
    async (operation) => {
      const f = fixture();
      f.parent.close();
      if (operation === 'send')
        await f.service.send(f.actor, { agentId: f.target.id, content: 'continue' });
      else await f.service.wait(f.actor, { agentId: f.target.id, waitMs: 0 });
      f.observations.publishChild({
        parentId: f.actor.sessionId,
        childId: f.target.id,
        runId: 'run',
        executionId: 'execution',
        kind: 'message',
        value: 'child update'
      });
      const repaired = f.observations.get(f.actor.sessionId)!;
      expect((await repaired.collect(new AbortController().signal))[0]?.content).toContain(
        'child update'
      );
      repaired.close();
    }
  );

  it('does not subscribe to a non-child for a zero-duration snapshot', async () => {
    const f = fixture(null);
    const watch = vi.spyOn(f.observations, 'watchExecutions');
    expect(await f.service.wait(f.actor, { agentId: f.target.id, waitMs: 0 })).toMatchObject({
      waitOutcome: 'snapshot',
      status: 'RUNNING'
    });
    expect(f.observe).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
  });

  it.each(['message', 'completion', 'timeout', 'cancel', 'interrupt', 'failure'] as const)(
    'releases a non-child wait on %s without automatic context or wake delivery',
    async (outcome) => {
      vi.useFakeTimers();
      const f = fixture('other-parent');
      // A horizontal wait must also work without a Session-level observation channel.
      f.parent.close();
      const watch = vi.spyOn(f.observations, 'watchExecutions');
      let status = 'RUNNING';
      let failure = false;
      let interrupted = false;
      let interrupt = () => {};
      f.freezeExecution.mockReturnValue({
        agentId: f.target.id,
        runId: 'run',
        executionId: 'execution',
        read: () => {
          if (failure) throw new Error('READ_FAILED');
          return { status };
        }
      });
      const abort = new AbortController();
      const waiting = f.service.wait(f.actor, {
        agentId: f.target.id,
        waitFor: outcome === 'message' ? 'message' : 'completion',
        waitMs: 10_000,
        signal: abort.signal,
        interrupt: {
          pending: () => interrupted,
          subscribe: (listener) => {
            interrupt = listener;
            return () => {
              interrupt = () => {};
            };
          }
        }
      });
      // Handle rejections before advancing the fake clock.
      const result = waiting.then(
        (value) => ({ value }),
        (error: Error) => ({ error })
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(watch).toHaveBeenCalledOnce();
      const temporary = watch.mock.results[0]!.value;
      const publish = (kind: 'message' | 'terminal', value: string, executionId = 'execution') =>
        f.observations.publishChild({
          parentId: 'other-parent',
          childId: f.target.id,
          runId: 'run',
          executionId,
          kind,
          value
        });
      publish('message', 'different execution', 'next-execution');
      expect(temporary.capture(f.target.id)).toBeUndefined();
      publish('message', 'progress');
      expect(f.observations.get(f.actor.sessionId)).toBeUndefined();
      expect(f.parent.wake.pending()).toBe(false);
      expect(await f.parent.collect(abort.signal)).toEqual([]);
      if (outcome === 'completion') {
        status = 'SUCCEEDED';
        publish('terminal', status);
      } else if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(10_000);
      else if (outcome === 'cancel') abort.abort(new Error('CANCELLED'));
      else if (outcome === 'interrupt') {
        interrupted = true;
        interrupt();
      } else if (outcome === 'failure') {
        failure = true;
        await vi.advanceTimersByTimeAsync(10_000);
      }
      const settled = await result;
      if (outcome === 'cancel' || outcome === 'failure')
        expect(settled).toMatchObject({
          error: { message: outcome === 'cancel' ? 'CANCELLED' : 'READ_FAILED' }
        });
      else
        expect(settled).toMatchObject({
          value: {
            waitOutcome: outcome === 'interrupt' ? 'interrupted' : outcome,
            updates: expect.arrayContaining([expect.objectContaining({ value: 'progress' })])
          }
        });
      const deliveredAfterClose = vi.spyOn(temporary, 'publish');
      publish('message', 'after wait');
      expect(deliveredAfterClose).not.toHaveBeenCalled();
      expect(temporary.capture(f.target.id)).toBeUndefined();
      expect(f.observe).not.toHaveBeenCalled();
    }
  );

  it('keeps concurrent mixed waits independent while only direct children enter automatic context', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const peer = { ...f.target, id: 'peer', parentSessionId: null };
    f.resolveTarget.mockImplementation(async (_actor, id) => (id === 'peer' ? peer : f.target));
    const watch = vi.spyOn(f.observations, 'watchExecutions');
    const mixed = f.service.wait(f.actor, {
      agentIds: [f.target.id, peer.id],
      mode: 'all',
      waitFor: 'message'
    });
    const single = f.service.wait(f.actor, { agentId: peer.id, waitFor: 'message' });
    await vi.advanceTimersByTimeAsync(0);
    f.observations.publishChild({
      childId: peer.id,
      runId: 'run',
      executionId: 'execution',
      kind: 'message',
      value: 'peer reply'
    });
    expect(await single).toMatchObject({ agentId: peer.id, waitOutcome: 'message' });
    expect(await f.parent.collect(new AbortController().signal)).toEqual([]);
    f.publish('child reply');
    expect(await mixed).toMatchObject({
      waitOutcome: 'message',
      agents: [
        { agentId: f.target.id, updates: [{ value: 'child reply' }] },
        { agentId: peer.id, updates: [{ value: 'peer reply' }] }
      ]
    });
    expect(watch).toHaveBeenCalledTimes(2);
    expect(f.parent.capture(peer.id)).toBeUndefined();
    f.publish('later child reply');
    expect((await f.parent.collect(new AbortController().signal))[0]?.content).toContain(
      'later child reply'
    );
  });

  it('rejects missing or blank execution titles before admission while terminal titles remain optional', async () => {
    const f = fixture();
    const executionActor = { ...f.actor, executionId: 'execution' };
    for (const title of [undefined, '', '  ']) {
      await expect(
        invokeAgentNetwork(f.service, executionActor, 'start', { content: 'child', title })
      ).rejects.toThrow('AGENT_START_INVALID');
    }
    expect(f.start).not.toHaveBeenCalled();
    expect(f.observe).not.toHaveBeenCalled();
    await invokeAgentNetwork(f.service, executionActor, 'start', {
      content: 'child',
      title: '  Review  '
    });
    expect(f.start).toHaveBeenCalledWith(
      executionActor,
      expect.objectContaining({ title: 'Review' }),
      undefined
    );
    await invokeAgentNetwork(f.service, f.actor, 'start', { content: 'manual' });
    await invokeAgentNetwork(f.service, f.actor, 'start', { content: 'manual', title: '   ' });
    expect(f.start).toHaveBeenCalledTimes(3);
    expect(f.start).toHaveBeenLastCalledWith(
      f.actor,
      expect.not.objectContaining({ title: expect.anything() }),
      undefined
    );
  });

  it('rejects native and broker cancellation before start or send admission', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    const context = { signal: controller.signal } as ExtensionOperationContext;
    await expect(
      invokeAgentNetwork(f.service, f.actor, 'start', { content: 'child', title: 'Child' }, context)
    ).rejects.toThrow();
    await expect(
      invokeAgentNetwork(
        f.service,
        f.actor,
        'send',
        { agentId: 'child', content: 'message' },
        undefined,
        controller.signal
      )
    ).rejects.toThrow();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.message).not.toHaveBeenCalled();
    expect(f.observe).not.toHaveBeenCalled();
  });

  it('rechecks cancellation after asynchronous target resolution before observing or sending', async () => {
    const f = fixture();
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.resolveTarget.mockImplementationOnce(async () => {
      await gate;
      return {
        id: 'child',
        workspaceId: 'workspace'
      } as NodeAgentSession;
    });
    const pending = invokeAgentNetwork(
      f.service,
      f.actor,
      'send',
      { agentId: 'child', content: 'message' },
      undefined,
      controller.signal
    );
    controller.abort();
    release();
    await expect(pending).rejects.toThrow();
    expect(f.message).not.toHaveBeenCalled();
    expect(f.observe).not.toHaveBeenCalled();
  });

  it('retains an accepted start or send when cancellation arrives after handoff', async () => {
    const f = fixture();
    const starting = new AbortController();
    f.start.mockImplementationOnce(async () => {
      starting.abort();
      return {
        session: { id: 'child', workspaceId: 'workspace' } as NodeAgentSession,
        result: { delivery: 'STARTED' }
      };
    });
    expect(await f.service.start(f.actor, { content: 'child' }, starting.signal)).toMatchObject({
      agentId: 'child',
      start: { delivery: 'STARTED' }
    });
    const sending = new AbortController();
    f.message.mockImplementationOnce(async () => {
      sending.abort();
      return { delivery: 'ACCEPTED' };
    });
    expect(
      await f.service.send(f.actor, { agentId: 'child', content: 'message' }, sending.signal)
    ).toMatchObject({ message: { status: 'accepted', result: { delivery: 'ACCEPTED' } } });
    expect(f.stop).not.toHaveBeenCalled();
  });

  it('preserves an applied approval when cancellation prevents the subsequent send', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.approval.mockImplementationOnce(async () => {
      controller.abort();
      return {
        status: 'applied' as const,
        result: { approvalId: 'approval', decision: 'approve' }
      };
    });
    expect(
      await f.service.send(
        f.actor,
        {
          agentId: 'child',
          content: 'message',
          approval: { approvalId: 'approval', decision: 'approve' }
        },
        controller.signal
      )
    ).toMatchObject({ approval: { status: 'applied' }, message: { status: 'not_attempted' } });
    expect(f.message).not.toHaveBeenCalled();
  });

  it('reports an uncertain handoff instead of treating cancellation as proof of rejection', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.message.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('DELIVERY_UNKNOWN');
    });
    expect(
      await f.service.send(f.actor, { agentId: 'child', content: 'message' }, controller.signal)
    ).toMatchObject({ message: { status: 'unknown', code: 'DELIVERY_UNKNOWN' } });
  });

  it('does not observe or decide when approval validation rejects', async () => {
    const f = fixture();
    f.validateApproval.mockRejectedValueOnce(new Error('AGENT_TARGET_NOT_AUTHORIZED'));
    await expect(
      f.service.send(f.actor, {
        agentId: 'child',
        approval: { approvalId: 'approval', decision: 'approve' }
      })
    ).rejects.toThrow('AGENT_TARGET_NOT_AUTHORIZED');
    expect(f.observe).not.toHaveBeenCalled();
    expect(f.approval).not.toHaveBeenCalled();
    expect(f.parent.capture('child')).toBeUndefined();
  });
  it('submits an approval alone without consuming unread messages', async () => {
    const f = fixture();
    f.publish('unread');
    expect(
      await f.service.send(f.actor, {
        agentId: 'child',
        approval: { approvalId: 'approval', decision: 'approve' }
      })
    ).toMatchObject({
      approval: { status: 'applied', result: { approvalId: 'approval' } },
      message: null
    });
    expect(f.approval).toHaveBeenCalledOnce();
    expect(f.setGoal).not.toHaveBeenCalled();
    expect(f.message).not.toHaveBeenCalled();
    expect(f.parent.wake.pending()).toBe(true);
  });

  it('reports a completed approval when a following Goal update fails', async () => {
    const f = fixture();
    f.setGoal.mockRejectedValueOnce(new Error('GOAL_FAILED'));
    expect(
      await f.service.send(f.actor, {
        agentId: 'child',
        goal: { objective: 'new' },
        approval: { approvalId: 'approval', decision: 'approve' }
      })
    ).toMatchObject({
      approval: { status: 'applied' },
      goal: { status: 'failed', code: 'GOAL_FAILED' },
      message: { status: 'not_attempted' }
    });
  });

  it('submits a start with Goal and content in one owner operation', async () => {
    const f = fixture();
    expect(
      await f.service.start(f.actor, {
        content: 'start work',
        goal: { objective: 'finish' }
      })
    ).toMatchObject({ agentId: 'child', start: { delivery: 'STARTED' } });
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.start).toHaveBeenCalledWith(
      f.actor,
      expect.objectContaining({
        content: 'start work',
        goal: { kind: 'set', objective: 'finish' }
      }),
      undefined
    );
    expect(f.setGoal).not.toHaveBeenCalled();
    expect(f.message).not.toHaveBeenCalled();
    expect(f.observe).toHaveBeenCalledWith(f.actor, expect.objectContaining({ id: 'child' }));
  });

  it('retains the accepted identity when observation setup fails', async () => {
    const f = fixture();
    f.observe.mockImplementation(() => {
      throw new Error('SUBSCRIPTION_FAILED');
    });
    expect(await f.service.start(f.actor, { content: 'start work' })).toMatchObject({
      agentId: 'child',
      start: { delivery: 'STARTED' },
      observation: { status: 'failed' }
    });
  });

  it('keeps null Goal unchanged and acknowledges only versions before accepted delivery', async () => {
    const f = fixture();
    f.publish('old');
    f.message.mockImplementation(async () => {
      f.publish('during delivery');
      return { delivery: 'ACCEPTED' };
    });
    const result = await f.service.send(f.actor, {
      agentId: 'child',
      content: 'continue',
      goal: null
    });
    expect(result).toMatchObject({ message: { status: 'accepted' } });
    expect(f.setGoal).not.toHaveBeenCalled();
    expect(f.observe).toHaveBeenCalledOnce();
    expect((await f.parent.collect(new AbortController().signal))[0]!.content).toContain(
      'during delivery'
    );
  });

  it('does not consume unread data if combined Goal submission becomes uncertain', async () => {
    const f = fixture();
    f.publish('unread');
    const set = f.setGoal.getMockImplementation()!;
    f.setGoal.mockImplementation(async (...args) => {
      await set(...args);
      throw new Error('MESSAGE_REJECTED');
    });
    const result = await f.service.send(f.actor, {
      agentId: 'child',
      content: 'continue',
      goal: { objective: 'new' }
    });
    expect(result).toMatchObject({ goal: { status: 'failed' }, message: { status: 'unknown' } });
    expect(f.parent.wake.pending()).toBe(true);
    expect(f.goal()).toEqual({ objective: 'new' });
    expect(f.message).not.toHaveBeenCalled();
  });

  it('combines Goal replacement with message delivery in one operation', async () => {
    const f = fixture();
    await f.service.send(f.actor, {
      agentId: 'child',
      content: 'continue once',
      goal: { objective: 'new' },
      clientMessageId: 'delivery-1'
    });
    expect(f.setGoal).toHaveBeenCalledOnce();
    expect(f.setGoal).toHaveBeenCalledWith(
      f.actor,
      expect.anything(),
      { kind: 'set', objective: 'new' },
      expect.objectContaining({
        clientMessageId: 'delivery-1',
        content: 'continue once',
        deliveryIntent: 'SEND'
      }),
      undefined
    );
    expect(f.message).not.toHaveBeenCalled();
  });

  it('updates or clears only the Goal without delivering or consuming a message', async () => {
    const f = fixture();
    f.publish('unread');
    await f.service.send(f.actor, { agentId: 'child', goal: { clear: true } });
    expect(f.goal()).toBeUndefined();
    expect(f.message).not.toHaveBeenCalled();
    expect(f.parent.wake.pending()).toBe(true);
  });

  it('reports uncertain delivery without consuming observations when no Goal was changed', async () => {
    const f = fixture();
    f.publish('unread');
    f.message.mockRejectedValue(new Error('TRANSPORT_FAILED'));
    expect(await f.service.send(f.actor, { agentId: 'child', content: 'continue' })).toMatchObject({
      message: { status: 'unknown' }
    });
    expect(f.parent.wake.pending()).toBe(true);
  });

  it('reports a partial stop if cancellation fails after Goal cleanup', async () => {
    const f = fixture();
    f.stop.mockImplementation(() => {
      f.setGoal(f.actor, {} as NodeAgentSession, { kind: 'clear' });
      throw new Error('RUN_CANCEL_FAILED');
    });
    expect(
      await f.service.stop(f.actor, { agentId: 'child', executionId: 'execution' })
    ).toMatchObject({ cancel: { status: 'unknown' }, goal: { status: 'cleared' } });
  });

  it('rejects an obsolete execution without clearing the current Goal', async () => {
    const f = fixture();
    f.stop.mockImplementation(() => {
      throw new Error('RUN_EXECUTION_STALE');
    });
    await expect(f.service.stop(f.actor, { agentId: 'child', executionId: 'old' })).rejects.toThrow(
      'RUN_EXECUTION_STALE'
    );
    expect(f.goal()).toEqual({ objective: 'old' });
  });

  it('validates the complete wait target set before registering observers', async () => {
    const f = fixture();
    f.resolveTarget.mockImplementation(async (_actor, id) => {
      if (id === 'missing') throw new Error('SESSION_NOT_FOUND');
      return { id, workspaceId: 'workspace' } as NodeAgentSession;
    });
    await expect(
      f.service.wait(f.actor, { agentIds: ['child', 'missing'], waitMs: 0 })
    ).rejects.toThrow('SESSION_NOT_FOUND');
    expect(f.observe).not.toHaveBeenCalled();
  });

  it('wait snapshot and natural context share the same non-consumed observation', async () => {
    const f = fixture();
    f.publish('unread');
    expect(
      await f.service.wait(f.actor, { agentId: 'child', waitFor: 'message', waitMs: 0 })
    ).toMatchObject({ waitOutcome: 'snapshot', agentId: 'child' });
    expect(f.observe).toHaveBeenCalledOnce();
    expect((await f.parent.collect(new AbortController().signal))[0]!.content).toContain('unread');
  });

  it('rejects a mode without an explicit target set before subscribing', async () => {
    const f = fixture();
    await expect(
      f.service.wait(f.actor, { agentId: 'child', mode: 'all', waitMs: 0 })
    ).rejects.toThrow('AGENT_WAIT_INVALID');
    expect(f.observe).not.toHaveBeenCalled();
  });

  it('snapshots the newest live direct child without the explicit-set limit', async () => {
    const f = fixture();
    f.children.mockResolvedValue(
      Array.from(
        { length: 12 },
        (_, index) =>
          ({
            id: `child-${index}`,
            workspaceId: 'workspace',
            parentSessionId: 'parent',
            createdAt: index
          }) as NodeAgentSession
      )
    );
    f.freezeExecution.mockImplementation((session) => ({
      agentId: session.id,
      runId: `run-${session.id}`,
      executionId: `execution-${session.id}`,
      read: () => ({ status: 'RUNNING' })
    }));
    expect(await f.service.wait(f.actor, { waitMs: 0 })).toMatchObject({
      agentId: 'child-11',
      waitOutcome: 'snapshot'
    });
    expect(f.observe).toHaveBeenCalledTimes(12);
  });
});
