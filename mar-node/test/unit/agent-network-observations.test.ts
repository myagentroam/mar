import { describe, expect, it, vi } from 'vitest';
import {
  AgentNetworkObservations,
  agentObservationFromRunEvent
} from '../../src/orchestration/agent-network/agent-network-observations.js';

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

function observationPayload(content: string) {
  return JSON.parse(
    content.slice('<mar_subagent_update>\n'.length, -'\n</mar_subagent_update>'.length)
  );
}

describe('live Agent Network observations', () => {
  it('retains ten updates per relationship across executions and reports eviction until acknowledged', async () => {
    const network = new AgentNetworkObservations();
    const parent = network.attach('parent');
    for (let index = 0; index < 10; index++)
      publish(network, 'parent', 'child', 'message', `message-${index}`, `execution-${index}`);
    const withinLimit = parent.capture('child', 'execution-0');
    expect(withinLimit).toBeDefined();
    expect(withinLimit).not.toHaveProperty('omittedUpdates');
    publish(network, 'parent', 'child', 'message', 'message-10', 'execution-10');
    publish(network, 'parent', 'sibling', 'message', 'Independent report');
    expect(parent.capture('child', 'execution-0')).toBeUndefined();
    const [first, sibling] = await parent.collect(new AbortController().signal);
    expect(observationPayload(first!.content)).toMatchObject({
      executionId: 'execution-1',
      omittedUpdates: 1,
      hasMoreUpdates: true,
      updates: [{ value: 'message-1' }]
    });
    expect(sibling!.content).toContain('Independent report');
    expect(observationPayload(sibling!.content)).not.toHaveProperty('omittedUpdates');
    expect((await parent.collect(new AbortController().signal))[0]!.content).toBe(first!.content);
    first!.acknowledge();
    sibling!.acknowledge();
    expect(parent.capture('child')?.omittedUpdates).toBeUndefined();
    // An old acknowledgment must not clear a new overflow notice.
    for (const index of [11, 12])
      publish(network, 'parent', 'child', 'message', `message-${index}`, `execution-${index}`);
    first!.acknowledge();
    const [next] = await parent.collect(new AbortController().signal);
    expect(observationPayload(next!.content)).toMatchObject({
      executionId: 'execution-3',
      omittedUpdates: 1
    });
    next!.acknowledge();
    for (let index = 4; index <= 12; index++) {
      const [item] = await parent.collect(new AbortController().signal);
      const payload = observationPayload(item!.content);
      expect(payload.executionId).toBe(`execution-${index}`);
      expect(payload).not.toHaveProperty('omittedUpdates');
      if (index === 12) expect(payload).not.toHaveProperty('hasMoreUpdates');
      item!.acknowledge();
    }
    expect(await parent.collect(new AbortController().signal)).toEqual([]);
    parent.close();
  });

  it('preserves overflow facts arriving between capture and acknowledgment', async () => {
    const network = new AgentNetworkObservations();
    const parent = network.attach('parent');
    for (let index = 0; index < 11; index++)
      publish(network, 'parent', 'child', 'message', `message-${index}`);
    const snapshot = parent.capture('child')!;
    expect(snapshot).toMatchObject({ omittedUpdates: 1 });
    publish(network, 'parent', 'child', 'message', 'newest');
    snapshot.acknowledge();
    snapshot.acknowledge();
    const [remaining] = await parent.collect(new AbortController().signal);
    expect(observationPayload(remaining!.content)).toMatchObject({ omittedUpdates: 1 });
    expect(remaining!.content).toContain('newest');
    remaining!.acknowledge();
    expect(await parent.collect(new AbortController().signal)).toEqual([]);
    parent.close();
  });

  it('bounds file-only execution caches and reports evicted updates without reviving their result', () => {
    const network = new AgentNetworkObservations();
    const parent = network.attach('parent');
    for (let index = 0; index < 11; index++) {
      network.publish({
        parentId: 'parent',
        childId: 'child',
        runId: 'run-1',
        executionId: `execution-${index}`,
        kind: 'files',
        paths: [`file-${index}`]
      });
    }
    // A later terminal must not resurrect an evicted execution's file snapshot.
    publish(network, 'parent', 'child', 'terminal', 'SUCCEEDED', 'execution-0');
    const evicted = parent.capture('child', 'execution-0');
    expect(evicted?.result).toBeUndefined();
    expect(evicted?.omittedUpdates).toBe(1);
    parent.close();
  });

  it.each([false, true])(
    'reports automatic continuation across executions without widening explicit capture (new Run=%s)',
    async (newRun) => {
      const network = new AgentNetworkObservations();
      const parent = network.attach('parent');
      publish(network, 'parent', 'child', 'message', 'Earlier execution done');
      publish(network, 'parent', 'child', 'terminal', 'SUCCEEDED');
      network.publish({
        parentId: 'parent',
        childId: 'child',
        runId: newRun ? 'run-2' : 'run-1',
        executionId: 'execution-2',
        kind: 'message',
        value: 'Decision needed in the next execution'
      });
      expect(parent.capture('child', 'execution-1')).not.toHaveProperty('hasMoreUpdates');
      const [first] = await parent.collect(new AbortController().signal);
      expect(observationPayload(first!.content)).toMatchObject({
        executionId: 'execution-1',
        hasMoreUpdates: true
      });
      expect(first!.content).not.toContain('Decision needed');
      first!.acknowledge();
      const [next] = await parent.collect(new AbortController().signal);
      expect(next!.content).toContain('Decision needed');
      expect(observationPayload(next!.content)).not.toHaveProperty('hasMoreUpdates');
      next!.acknowledge();
      expect(await parent.collect(new AbortController().signal)).toEqual([]);
      parent.close();
    }
  );

  it.each([false, true])(
    'retains an unread decision request before a later reply (final=%s)',
    async (final) => {
      const network = new AgentNetworkObservations();
      const parent = network.attach('parent');
      const identity = {
        parentId: 'parent',
        childId: 'child',
        runId: 'run',
        executionId: 'execution'
      };
      network.publish({ ...identity, kind: 'message', value: 'Choose A or B before I proceed' });
      network.publish({ ...identity, kind: 'message', value: 'Waiting for guidance', final });
      if (final) network.publish({ ...identity, kind: 'terminal', value: 'SUCCEEDED' });
      const [item] = await parent.collect(new AbortController().signal);
      expect(item!.content).toContain('Choose A or B before I proceed');
      expect(item!.content.match(/Waiting for guidance/g)).toHaveLength(1);
      const [retry] = await parent.collect(new AbortController().signal);
      expect(retry!.content).toBe(item!.content);
      item!.acknowledge();
      expect(await parent.collect(new AbortController().signal)).toEqual([]);
      parent.close();
    }
  );

  it('does not evict retained message records to make room for file-only caches', async () => {
    const network = new AgentNetworkObservations();
    const parent = network.attach('parent');
    network.publish({
      parentId: 'parent',
      childId: 'child',
      runId: 'run',
      executionId: 'reported',
      kind: 'message',
      value: 'Decision required',
      final: true
    });
    network.publish({
      parentId: 'parent',
      childId: 'child',
      runId: 'run',
      executionId: 'reported',
      kind: 'terminal',
      value: 'SUCCEEDED'
    });
    for (let index = 0; index < 12; index++)
      network.publish({
        parentId: 'parent',
        childId: 'child',
        runId: 'run',
        executionId: `files-${index}`,
        kind: 'files',
        paths: [`file-${index}`]
      });
    const [item] = await parent.collect(new AbortController().signal);
    expect(item!.content).toContain('Decision required');
    expect(observationPayload(item!.content).omittedUpdates).toBeGreaterThan(0);
    item!.acknowledge();
    parent.close();
  });

  it('keeps overflow separate from execution identity after a complete update group was evicted', () => {
    const network = new AgentNetworkObservations();
    const parent = network.attach('parent');
    for (let index = 0; index < 11; index++)
      network.publish({
        parentId: 'parent',
        childId: 'child',
        runId: 'run',
        executionId: `execution-${index}`,
        kind: 'message',
        value: `message-${index}`
      });
    expect(parent.capture('child', 'execution-0')).toBeUndefined();
    const evicted = parent.captureOmissions('child');
    expect(evicted).toMatchObject({ omittedUpdates: 1 });
    expect(evicted).not.toHaveProperty('executionId');
    evicted!.acknowledge();
    expect(parent.captureOmissions('child')).toBeUndefined();
    expect(parent.capture('child')!.updates).toHaveLength(1);
    expect(parent.capture('child')).not.toHaveProperty('omittedUpdates');
    parent.close();
  });

  it('retains earlier final replies instead of treating every final as the summary', async () => {
    const network = new AgentNetworkObservations();
    const parent = network.attach('parent');
    const identity = {
      parentId: 'parent',
      childId: 'child',
      runId: 'run',
      executionId: 'execution'
    };
    for (const value of ['Decision: choose A or B', 'Latest final'])
      network.publish({ ...identity, kind: 'message', value, final: true });
    network.publish({ ...identity, kind: 'terminal', value: 'SUCCEEDED' });
    const [item] = await parent.collect(new AbortController().signal);
    expect(item!.content).toContain('Decision: choose A or B');
    expect(item!.content.match(/Latest final/g)).toHaveLength(1);
    item!.acknowledge();
    expect(await parent.collect(new AbortController().signal)).toEqual([]);
    parent.close();
  });

  it.each([false, true])(
    'batches escaped unread messages without consuming later batches (terminal=%s)',
    async (terminal) => {
      const network = new AgentNetworkObservations();
      const parent = network.attach('parent');
      const expected = Array.from({ length: 12 }, (_, index) => `${index}:` + '<'.repeat(1900));
      for (const value of expected) publish(network, 'parent', 'child', 'message', value);
      if (terminal) {
        network.publish({
          parentId: 'parent',
          childId: 'child',
          runId: 'run-1',
          executionId: 'execution-1',
          kind: 'message',
          value: 'Final summary',
          final: true
        });
        publish(network, 'parent', 'child', 'terminal', 'SUCCEEDED');
      }
      const delivered: string[] = [];
      const summaries: string[] = [];
      const retained = expected.slice(terminal ? -8 : -10);
      for (let batch = 0; batch < retained.length; batch++) {
        const [item] = await parent.collect(new AbortController().signal);
        if (!item) break;
        expect(Buffer.byteLength(item.content)).toBeLessThanOrEqual(32768);
        const payload = JSON.parse(
          item.content.slice('<mar_subagent_update>\n'.length, -'\n</mar_subagent_update>'.length)
        );
        expect(payload).not.toHaveProperty('updatesTruncated');
        if (batch < retained.length - 1) expect(payload.hasMoreUpdates).toBe(true);
        else expect(payload).not.toHaveProperty('hasMoreUpdates');
        if (batch === 0) expect(payload.omittedUpdates).toBe(expected.length - retained.length);
        else expect(payload).not.toHaveProperty('omittedUpdates');
        if (payload.summary) summaries.push(payload.summary);
        for (const update of payload.updates) {
          expect(update).not.toHaveProperty('truncated');
          if (update.kind === 'message') delivered.push(update.value);
        }
        expect((await parent.collect(new AbortController().signal))[0]!.content).toBe(item.content);
        item.acknowledge();
      }
      expect(delivered).toEqual(retained);
      expect(summaries).toEqual(terminal ? ['Final summary'] : []);
      expect(await parent.collect(new AbortController().signal)).toEqual([]);
      parent.close();
    }
  );

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

  it.each([8, 9, 17])(
    'continues batches across %i child targets without imposing a child limit',
    async (count) => {
      const network = new AgentNetworkObservations();
      const parent = network.attach('parent');
      publish(network, 'parent', 'child-0', 'message', 'body');
      publish(network, 'parent', 'child-0', 'terminal', 'SUCCEEDED');
      for (let index = 1; index < count; index++)
        publish(network, 'parent', `child-${index}`, 'message', `body-${index}`);
      const delivered: string[] = [];
      for (let offset = 0; offset < count; offset += 8) {
        const batch = await parent.collect(new AbortController().signal);
        expect(batch).toHaveLength(Math.min(8, count - offset));
        if (offset === 0) {
          expect(batch[0]!.content).toContain('body');
          expect(batch[0]!.content).toContain('SUCCEEDED');
        }
        for (const item of batch) {
          const payload = observationPayload(item.content);
          if (count - offset > 8) expect(payload.hasMoreAgents).toBe(true);
          else expect(payload).not.toHaveProperty('hasMoreAgents');
          expect(payload).not.toHaveProperty('hasMoreUpdates');
          delivered.push(payload.agentId);
        }
        batch.forEach((item) => item.acknowledge());
      }
      expect(delivered).toEqual(Array.from({ length: count }, (_, index) => `child-${index}`));
      expect(await parent.collect(new AbortController().signal)).toEqual([]);
      parent.close();
    }
  );

  it('keeps batch continuation visible when only the first candidate is installed', async () => {
    const network = new AgentNetworkObservations();
    const parent = network.attach('parent');
    for (let index = 0; index < 9; index++)
      publish(network, 'parent', `child-${index}`, 'message', `body-${index}`);
    const first = await parent.collect(new AbortController().signal);
    expect(first.every((item) => observationPayload(item.content).hasMoreAgents === true)).toBe(
      true
    );
    first[0]!.acknowledge();
    const next = await parent.collect(new AbortController().signal);
    expect(next).toHaveLength(8);
    expect(next.some((item) => observationPayload(item.content).agentId === 'child-8')).toBe(true);
    expect(next.every((item) => !('hasMoreAgents' in observationPayload(item.content)))).toBe(true);
    next.forEach((item) => item.acknowledge());
    expect(await parent.collect(new AbortController().signal)).toEqual([]);
    parent.close();
  });
});
