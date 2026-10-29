import { describe, expect, it, vi } from 'vitest';
import {
  AgentNetworkObservations,
  agentObservationFromRunEvent
} from '../../src/service/agent-network-observations.js';

function publish(
  network: AgentNetworkObservations,
  parentId: string,
  childId: string,
  kind: 'message' | 'terminal',
  value: string,
  executionId = 'execution-1'
) {
  network.publish({ parentId, childId, runId: 'run-1', executionId, kind, value });
}

describe('live Agent Network observations', () => {
  it.each(['FAILED', 'CANCELLED'] as const)(
    'does not project an earlier final message as a summary after %s',
    async (status) => {
      const network = new AgentNetworkObservations();
      const parent = network.attach('parent');
      const identity = {
        parentId: 'parent',
        childId: 'child',
        runId: 'run',
        executionId: 'execution'
      };
      network.publish({
        ...identity,
        kind: 'message',
        value: 'premature',
        final: true,
        turnId: 'turn'
      });
      network.publish({ ...identity, kind: 'terminal', value: status });
      expect(parent.capture('child')?.result).not.toHaveProperty('summary');
      const [item] = await parent.collect(new AbortController().signal);
      const payload = JSON.parse(
        item!.content.slice('<mar_subagent_update>\n'.length, -'\n</mar_subagent_update>'.length)
      );
      expect(payload).not.toHaveProperty('summary');
      parent.close();
    }
  );
  it.each([
    { text: 'a'.repeat(1999) + '😀', expected: 'a'.repeat(1999) },
    { text: '界'.repeat(667), expected: '界'.repeat(666) }
  ])('clips UTF-8 updates without splitting Unicode code points', ({ text, expected }) => {
    const network = new AgentNetworkObservations();
    const parent = network.attach('parent');
    publish(network, 'parent', 'child', 'message', text);
    const update = parent.capture('child')!.updates[0]!;
    expect(update.value).toBe(expected);
    expect(Buffer.byteLength(update.value, 'utf8')).toBeLessThanOrEqual(2000);
    expect(update.truncated).toBe(true);
    parent.close();
  });
  it('bounds the complete escaped automatic observation and marks clipped final content', async () => {
    const network = new AgentNetworkObservations();
    const parent = network.attach('parent');
    const identity = {
      parentId: 'parent',
      childId: 'child',
      runId: 'run',
      executionId: 'execution'
    };
    network.publish({
      ...identity,
      kind: 'message',
      value: '<'.repeat(8192),
      final: true,
      turnId: 'turn'
    });
    network.publish({ ...identity, kind: 'terminal', value: 'SUCCEEDED' });
    const [item] = await parent.collect(new AbortController().signal);
    expect(Buffer.byteLength(item!.content)).toBeLessThanOrEqual(32768);
    const payload = JSON.parse(
      item!.content.slice('<mar_subagent_update>\n'.length, -'\n</mar_subagent_update>'.length)
    );
    expect(payload).toMatchObject({ agentId: 'child', turnId: 'turn', summaryTruncated: true });
    expect(payload.summary.length).toBeLessThan(8192);
    item!.acknowledge();
    expect(parent.capture('child')).toBeUndefined();
    parent.close();
  });
  it('notifies completion waiters but does not wake sleep for terminal-only observations', async () => {
    const network = new AgentNetworkObservations();
    const parent = network.attach('parent');
    const wait = vi.fn();
    const wake = vi.fn();
    parent.subscribe(wait);
    parent.wake.subscribe(wake);
    publish(network, 'parent', 'child', 'terminal', 'SUCCEEDED');
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wake).not.toHaveBeenCalled();
    expect(parent.wake.pending()).toBe(false);
    expect((await parent.collect(new AbortController().signal))[0]?.content).toContain('SUCCEEDED');
    publish(network, 'parent', 'child', 'message', 'progress');
    expect(wake).toHaveBeenCalledTimes(1);
    expect(parent.wake.pending()).toBe(true);
    parent.close();
  });
  it('keeps non-child waits separate from automatic direct-child observations', async () => {
    const network = new AgentNetworkObservations();
    const parent = network.attach('parent');
    const other = network.attach('other');
    const publishChild = (childId: string, parentId?: string) =>
      network.publishChild({
        ...(parentId === undefined ? {} : { parentId }),
        childId,
        runId: `run-${childId}`,
        executionId: `execution-${childId}`,
        kind: 'message',
        value: childId
      });
    publishChild('direct', 'parent');
    publishChild('peer');
    expect(parent.capture('direct')).toBeDefined();
    expect(parent.capture('peer')).toBeUndefined();
    expect(other.wake.pending()).toBe(false);
    const waiter = network.watchExecutions([
      { agentId: 'peer', runId: 'run-peer', executionId: 'execution-peer' }
    ]);
    publishChild('peer');
    expect(waiter.capture('peer')).toBeDefined();
    expect(parent.capture('peer')).toBeUndefined();
    expect(JSON.stringify(await parent.collect(new AbortController().signal))).not.toContain(
      'peer'
    );
    expect(other.wake.pending()).toBe(false);
    waiter.close();
    publishChild('peer');
    expect(waiter.capture('peer')).toBeUndefined();
    parent.close();
    publishChild('peer');
    expect(network.get('parent')).toBeUndefined();
  });
  it('observes only normalized public messages and actual terminal events', () => {
    const item = { kind: 'assistant_message', status: 'COMPLETED', payload: { text: 'answer' } };
    expect(
      agentObservationFromRunEvent({
        eventType: 'conversation.item',
        payload: item,
        terminalStatus: undefined
      })
    ).toEqual({ kind: 'message', value: 'answer' });
    expect(
      agentObservationFromRunEvent({
        eventType: 'conversation.item',
        payload: { ...item, status: 'IN_PROGRESS' },
        terminalStatus: undefined
      })
    ).toBeUndefined();
    expect(
      agentObservationFromRunEvent({
        eventType: 'conversation.item',
        payload: { ...item, kind: 'reasoning' },
        terminalStatus: undefined
      })
    ).toBeUndefined();
    expect(
      agentObservationFromRunEvent({
        eventType: 'run.completed',
        payload: {},
        terminalStatus: 'SUCCEEDED'
      })
    ).toEqual({ kind: 'terminal', value: 'SUCCEEDED' });
  });

  it('projects only explicit final messages and completed normalized file changes', async () => {
    const network = new AgentNetworkObservations();
    const parent = network.attach('parent');
    const base = { parentId: 'parent', childId: 'child', runId: 'run', executionId: 'execution' };
    const publishEvent = (payload: unknown) => {
      const observation = agentObservationFromRunEvent({
        eventType: 'conversation.item',
        payload,
        terminalStatus: undefined
      });
      if (observation) network.publish({ ...base, ...observation });
    };
    publishEvent({
      kind: 'assistant_message',
      status: 'COMPLETED',
      turnId: 'turn',
      payload: { text: 'progress', phase: 'commentary' }
    });
    publishEvent({
      kind: 'file_change',
      status: 'IN_PROGRESS',
      payload: { changes: [{ path: 'not-finished.ts' }] }
    });
    publishEvent({
      kind: 'file_change',
      status: 'COMPLETED',
      payload: { changes: [{ path: 'changed.ts' }, { path: 'changed.ts' }] }
    });
    expect(parent.capture('child')?.result).toBeUndefined();
    publishEvent({
      kind: 'assistant_message',
      status: 'COMPLETED',
      turnId: 'turn',
      payload: { text: 'final answer', phase: 'final_answer' }
    });
    network.publish({ ...base, kind: 'terminal', value: 'SUCCEEDED' });
    const snapshot = parent.capture('child')!;
    expect(snapshot.result).toEqual({
      summary: 'final answer',
      turnId: 'turn',
      changedFiles: ['changed.ts']
    });
    const [automatic] = await parent.collect(new AbortController().signal);
    expect(automatic!.content).toContain('final answer');
    expect(automatic!.content.match(/final answer/g)).toHaveLength(1);
    automatic!.acknowledge();
    expect(parent.capture('child')).toBeUndefined();
    parent.close();
  });

  it('does not infer a final answer from an unclassified public message', () => {
    const network = new AgentNetworkObservations();
    const parent = network.attach('parent');
    publish(network, 'parent', 'child', 'message', 'unclassified');
    publish(network, 'parent', 'child', 'terminal', 'SUCCEEDED');
    expect(parent.capture('child')?.result).toBeUndefined();
    parent.close();
  });

  it('acknowledges only the collected version when a newer message arrives', async () => {
    const network = new AgentNetworkObservations();
    const parent = network.attach('parent');
    const wake = vi.fn();
    const unsubscribe = parent.wake.subscribe(wake);
    publish(network, 'parent', 'child', 'message', 'first');
    const [first] = await parent.collect(new AbortController().signal);
    publish(network, 'parent', 'child', 'message', 'second');
    first!.acknowledge();
    expect(parent.wake.pending()).toBe(true);
    const [second] = await parent.collect(new AbortController().signal);
    expect(second!.content).toContain('second');
    second!.acknowledge();
    expect(parent.wake.pending()).toBe(false);
    expect(wake).toHaveBeenCalledTimes(2);
    unsubscribe();
    parent.close();
  });

  it('keeps message and terminal observations independent and does not replay after close', async () => {
    const network = new AgentNetworkObservations();
    publish(network, 'parent', 'child', 'message', 'before attach');
    const parent = network.attach('parent');
    expect(await parent.collect(new AbortController().signal)).toEqual([]);
    publish(network, 'parent', 'child', 'message', 'answer');
    const captured = await parent.collect(new AbortController().signal);
    publish(network, 'parent', 'child', 'terminal', 'SUCCEEDED');
    expect(captured).toHaveLength(1);
    captured[0]!.acknowledge();
    expect((await parent.collect(new AbortController().signal))[0]!.content).toContain('SUCCEEDED');
    parent.close();
    publish(network, 'parent', 'child', 'terminal', 'FAILED');
    const reopened = network.attach('parent');
    expect(await reopened.collect(new AbortController().signal)).toEqual([]);
    reopened.close();
  });

  it('isolates parents and limits oversized observations', async () => {
    const network = new AgentNetworkObservations();
    const first = network.attach('first');
    const second = network.attach('second');
    publish(network, 'first', 'child', 'message', '\u0000'.repeat(5000));
    expect(second.wake.pending()).toBe(false);
    const [item] = await first.collect(new AbortController().signal);
    expect(Buffer.byteLength(item!.content)).toBeLessThan(32768);
    expect(item!.content).toContain('"truncated":true');
    first.close();
    second.close();
  });

  it('keeps the live subscription across Session identity promotion', async () => {
    const network = new AgentNetworkObservations();
    const parent = network.attach('bootstrap');
    network.promote('bootstrap', 'native');
    publish(network, 'native', 'child', 'message', '</mar_subagent_update>');
    const [item] = await parent.collect(new AbortController().signal);
    expect(item!.content).toContain('\\u003c/mar_subagent_update\\u003e');
    expect(item!.content.match(/<\/mar_subagent_update>/g)).toHaveLength(1);
    parent.close();
    expect(() => network.attach('native')).not.toThrow();
  });

  it('isolates failing listeners and keeps subsequent execution observations distinct', async () => {
    const network = new AgentNetworkObservations();
    const parent = network.attach('parent');
    const notified = vi.fn();
    parent.subscribe(() => {
      throw new Error('observer failure');
    });
    parent.subscribe(notified);
    expect(() => publish(network, 'parent', 'child', 'terminal', 'SUCCEEDED')).not.toThrow();
    const [old] = await parent.collect(new AbortController().signal);
    publish(network, 'parent', 'child', 'message', 'new answer', 'execution-2');
    const both = await parent.collect(new AbortController().signal);
    expect(both).toHaveLength(1);
    expect(both[0]!.content).toContain('execution-1');
    expect(both[0]!.content).not.toContain('new answer');
    old!.acknowledge();
    const next = (await parent.collect(new AbortController().signal))[0]!;
    expect(next.content).toContain('execution-2');
    expect(next.content).toContain('new answer');
    expect(notified).toHaveBeenCalledTimes(2);
    parent.close();
  });

  it('shares version-scoped consumption between explicit capture and automatic context', async () => {
    const network = new AgentNetworkObservations();
    const parent = network.attach('parent');
    publish(network, 'parent', 'child', 'message', 'first');
    const captured = network.get('parent')!.capture('child', 'execution-1')!;
    publish(network, 'parent', 'child', 'message', 'later');
    captured.acknowledge();
    const [automatic] = await parent.collect(new AbortController().signal);
    expect(automatic!.content).toContain('later');
    const explicit = parent.capture('child', 'execution-1')!;
    automatic!.acknowledge();
    explicit.acknowledge();
    expect(parent.wake.pending()).toBe(false);
  });

  it('combines a target execution into one item and leaves unselected targets unread', async () => {
    const network = new AgentNetworkObservations();
    const parent = network.attach('parent');
    publish(network, 'parent', 'child-0', 'message', 'body');
    publish(network, 'parent', 'child-0', 'terminal', 'SUCCEEDED');
    for (let index = 1; index < 9; index++)
      publish(network, 'parent', `child-${index}`, 'message', `body-${index}`);
    const first = await parent.collect(new AbortController().signal);
    expect(first).toHaveLength(8);
    expect(first[0]!.content).toContain('body');
    expect(first[0]!.content).toContain('SUCCEEDED');
    first.forEach((item) => item.acknowledge());
    const last = await parent.collect(new AbortController().signal);
    expect(last).toHaveLength(1);
    expect(last[0]!.content).toContain('child-8');
  });
});
