import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentSession } from '@myagentroam/agent';
import { SessionObservations } from '../src/observations.js';

function event(type: 'message.completed', text: string): AgentEvent {
  return {
    type,
    text,
    itemId: 'item',
    phase: 'commentary',
    modelId: 'model',
    modelName: 'model',
    eventId: 'event',
    sequence: 1,
    timestamp: '2026-01-01T00:00:00Z',
    sessionId: 'child',
    executionId: 'execution'
  };
}

describe('warm Session observations', () => {
  it('round-trips public whitespace and Unicode without allowing message text to create markup', () => {
    let publish!: (event: AgentEvent) => void;
    const observations = new SessionObservations();
    observations.observe({
      id: 'child',
      subscribe(listener) {
        publish = listener;
        return { unsubscribe() {} };
      }
    });
    const text = '  中文 & <mar_subagent_update>\n🚀 </message>  ';
    publish(event('message.completed', text));
    const content = observations.collect(new AbortController().signal)[0]!.content;
    expect(content.match(/<mar_subagent_update>/g)).toHaveLength(1);
    const payload = JSON.parse(content.slice(content.indexOf('\n') + 1, content.lastIndexOf('\n')));
    expect(payload.updates[0].value).toBe(text);
    observations.close();
  });
  it('releases consumed bodies only after the same terminal is confirmed in history', async () => {
    let publish!: (event: AgentEvent) => void;
    let resolve!: (value: unknown) => void;
    const history = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const observations = new SessionObservations(true, { sessionHistory: history } as never);
    observations.observe({
      id: 'child',
      subscribe(listener) {
        publish = listener;
        return { unsubscribe() {} };
      }
    });
    const terminal = {
      type: 'execution.completed',
      sessionId: 'child',
      executionId: 'execution',
      eventId: 'terminal',
      sequence: 2,
      timestamp: 'now'
    } as AgentEvent;
    publish({ ...event('message.completed', 'durable result'), phase: 'final_answer' });
    publish(terminal);
    observations.capture('child')!.acknowledge();
    expect(observations.snapshot('child', 'execution')).toHaveProperty('summary', 'durable result');
    resolve({ entries: [{ kind: 'event', event: terminal }] });
    await vi.waitFor(() =>
      expect(observations.snapshot('child', 'execution')).not.toHaveProperty('summary')
    );
    expect(observations.terminal('child')).toBeUndefined();
    observations.close();
  });
  it('does not let a delayed durability check release or consume a newer terminal', async () => {
    let publish!: (event: AgentEvent) => void;
    let resolve!: (value: unknown) => void;
    const history = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const observations = new SessionObservations(true, { sessionHistory: history } as never);
    const session = {
      id: 'child',
      subscribe(listener: typeof publish) {
        publish = listener;
        return { unsubscribe() {} };
      }
    };
    const old = {
      type: 'execution.completed',
      sessionId: 'child',
      executionId: 'old',
      eventId: 'old-terminal',
      sequence: 2,
      timestamp: 'now'
    } as AgentEvent;
    const current = {
      type: 'execution.failed',
      code: 'FAILED',
      sessionId: 'child',
      executionId: 'new',
      eventId: 'new-terminal',
      sequence: 2,
      timestamp: 'now'
    } as AgentEvent;
    observations.observe(session);
    publish(old);
    observations.capture('child', 'old')!.acknowledge();
    observations.observe(session);
    publish(current);
    resolve({ entries: [{ kind: 'event', event: old }] });
    await Promise.resolve();
    expect(observations.terminal('child')).toEqual(current);
    expect(observations.capture('child', 'new')?.updates).toMatchObject([
      { kind: 'terminal', value: 'execution.failed' }
    ]);
    observations.close();
  });
  it('bounds escaped automatic terminal content without losing its identity', () => {
    const observations = new SessionObservations();
    const listeners = new Set<(event: AgentEvent) => void>();
    const session = {
      id: 'child',
      subscribe(listener: (event: AgentEvent) => void) {
        listeners.add(listener);
        return { activeExecutionId: 'execution', unsubscribe: () => listeners.delete(listener) };
      }
    } as unknown as AgentSession;
    observations.observe(session);
    const emit = (event: Partial<AgentEvent>) => {
      for (const listener of listeners)
        listener({
          sessionId: 'child',
          executionId: 'execution',
          eventId: 'event',
          sequence: 1,
          timestamp: 'now',
          ...event
        } as AgentEvent);
    };
    emit({
      type: 'message.completed',
      text: '<'.repeat(8192),
      phase: 'final_answer',
      turnId: 'turn'
    });
    emit({ type: 'execution.completed' });
    const [item] = observations.collect(new AbortController().signal);
    expect(Buffer.byteLength(item!.content)).toBeLessThanOrEqual(32768);
    const payload = JSON.parse(
      item!.content.slice('<mar_subagent_update>\n'.length, -'\n</mar_subagent_update>'.length)
    );
    expect(payload).toMatchObject({
      agentId: 'child',
      executionId: 'execution',
      turnId: 'turn',
      summaryTruncated: true
    });
    item!.acknowledge();
    expect(observations.capture('child')).toBeUndefined();
    observations.close();
  });
  it('keeps failure information while bounding escaped changed paths', () => {
    let publish!: (event: AgentEvent) => void;
    const observations = new SessionObservations();
    observations.observe({
      id: 'child',
      subscribe(listener) {
        publish = listener;
        return { unsubscribe() {} };
      }
    });
    const common = {
      sessionId: 'child',
      executionId: 'execution',
      eventId: 'event',
      sequence: 1,
      timestamp: 'now'
    };
    publish({
      ...common,
      type: 'tool.completed',
      toolName: 'apply_patch',
      callId: 'call',
      summary: 'changed',
      data: {
        files: Array.from({ length: 200 }, (_, index) => ({ path: `${index}-${'<&'.repeat(500)}` }))
      }
    } as AgentEvent);
    publish({ ...common, type: 'execution.failed', code: 'FAILED', message: 'Failed <safely>.' });
    const content = observations.collect(new AbortController().signal)[0]!.content;
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(32768);
    const payload = JSON.parse(content.slice(content.indexOf('\n') + 1, content.lastIndexOf('\n')));
    expect(payload.changedFilesTruncated).toBe(true);
    expect(payload.updates).toContainEqual(
      expect.objectContaining({ errorCode: 'FAILED', errorMessage: 'Failed <safely>.' })
    );
    observations.close();
  });
  it('makes a terminal permission stop available to automatic collection', () => {
    let listener!: (event: AgentEvent) => void;
    const session = {
      id: 'child',
      subscribe(next: typeof listener) {
        listener = next;
        return { activeExecutionId: 'execution', unsubscribe() {} };
      }
    } as AgentSession;
    const observations = new SessionObservations();
    observations.observe(session);
    const permissionStop = {
      action: 'ask',
      reason: 'Confirm action.',
      source: {
        sessionId: 'child',
        executionId: 'execution',
        callId: 'call',
        toolName: 'effect'
      }
    };
    listener({
      ...event('message.completed', ''),
      type: 'execution.completed',
      permissionStop
    } as AgentEvent);
    expect(observations.capture('child', 'execution')?.updates).toMatchObject([
      { kind: 'terminal', permissionStop }
    ]);
    const content = observations.collect(new AbortController().signal)[0]?.content;
    expect(content).toContain('Confirm action.');
    observations.close();
  });
  it('retains a terminal for natural collection without waking a sleeping parent', () => {
    const observations = new SessionObservations();
    const wake = vi.fn();
    observations.wake.subscribe(wake);
    let publish!: (event: AgentEvent) => void;
    observations.observe({
      id: 'child',
      subscribe(listener) {
        publish = listener;
        return { unsubscribe() {} };
      }
    });
    publish({
      type: 'execution.completed',
      sessionId: 'child',
      executionId: 'execution',
      eventId: 'terminal',
      sequence: 1,
      timestamp: '2026-01-01T00:00:00Z'
    });
    expect(wake).not.toHaveBeenCalled();
    expect(observations.wake.pending()).toBe(false);
    expect(observations.collect(new AbortController().signal)[0]?.content).toContain(
      'execution.completed'
    );
    observations.close();
  });
  it('retains the stable failure code and bounded public message', () => {
    const observations = new SessionObservations();
    let publish!: (event: AgentEvent) => void;
    observations.observe({
      id: 'child',
      subscribe(listener) {
        publish = listener;
        return { unsubscribe() {} };
      }
    });
    publish({
      type: 'execution.failed',
      code: 'MODEL_UNAVAILABLE',
      message: 'Model failed.',
      sessionId: 'child',
      executionId: 'execution',
      eventId: 'failure',
      sequence: 2,
      timestamp: '2026-01-01T00:00:00Z'
    });
    expect(observations.capture('child')?.updates).toContainEqual({
      kind: 'terminal',
      value: 'execution.failed',
      errorCode: 'MODEL_UNAVAILABLE',
      errorMessage: 'Model failed.'
    });
  });
  it('clips public failure and permission text without splitting UTF-8 characters', () => {
    const value = 'a'.repeat(999) + '🚀';
    const observe = (terminal: AgentEvent) => {
      let publish!: (event: AgentEvent) => void;
      const observations = new SessionObservations();
      observations.observe({
        id: 'child',
        subscribe(listener) {
          publish = listener;
          return { unsubscribe() {} };
        }
      });
      publish(terminal);
      const update = observations.capture('child')!.updates[0]!;
      observations.close();
      return update;
    };
    const common = {
      sessionId: 'child',
      executionId: 'execution',
      eventId: 'terminal',
      sequence: 1,
      timestamp: 'now'
    };
    const failure = observe({
      ...common,
      type: 'execution.failed',
      code: 'FAILED',
      message: value
    });
    const stopped = observe({
      ...common,
      type: 'execution.completed',
      permissionStop: {
        action: 'ask',
        reason: value,
        source: { sessionId: 'child', executionId: 'execution', callId: 'call', toolName: 'exec' }
      }
    });
    expect(failure.errorMessage).toBe('a'.repeat(999));
    expect(stopped.permissionStop?.reason).toBe('a'.repeat(999));
  });
  it('acknowledges only captured versions and closes subscriptions', () => {
    let listener!: (event: AgentEvent) => void;
    const unsubscribe = vi.fn();
    const session = {
      id: 'child',
      subscribe(callback: typeof listener) {
        listener = callback;
        return { activeExecutionId: 'execution', unsubscribe };
      }
    } as AgentSession;
    const observations = new SessionObservations();
    observations.observe(session);
    listener(event('message.completed', 'first'));
    const first = observations.collect(new AbortController().signal)[0]!;
    listener(event('message.completed', 'second'));
    first.acknowledge();
    expect(observations.collect(new AbortController().signal)[0]?.content).toContain('second');
    observations.close();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(observations.wake.pending()).toBe(false);
  });

  it('captures the requested execution without consuming an older terminal', () => {
    let listener!: (event: AgentEvent) => void;
    const unsubscribe = vi.fn();
    const session = {
      id: 'child',
      subscribe(callback: typeof listener) {
        listener = callback;
        return { unsubscribe };
      }
    } as AgentSession;
    const observations = new SessionObservations();
    observations.observe(session);
    listener({
      ...event('message.completed', 'old'),
      executionId: 'old',
      type: 'execution.completed'
    } as unknown as AgentEvent);
    expect(unsubscribe).toHaveBeenCalledOnce();
    observations.observe(session);
    listener({ ...event('message.completed', 'new progress'), executionId: 'new' });
    const captured = observations.capture('child', 'new');
    expect(captured?.updates).toEqual([{ kind: 'message', value: 'new progress' }]);
    captured?.acknowledge();
    expect(observations.capture('child', 'old')?.updates).toEqual([
      { kind: 'terminal', value: 'execution.completed' }
    ]);
    observations.close();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('acknowledges only pre-send versions, including across executions', () => {
    let listener!: (event: AgentEvent) => void;
    const observations = new SessionObservations();
    const session = {
      id: 'child',
      subscribe(callback: typeof listener) {
        listener = callback;
        return { unsubscribe() {} };
      }
    } as AgentSession;
    observations.observe(session);
    listener({ ...event('message.completed', 'old'), executionId: 'old' });
    listener({
      ...event('message.completed', ''),
      executionId: 'old',
      type: 'execution.completed'
    } as unknown as AgentEvent);
    observations.observe(session);
    listener({ ...event('message.completed', 'before'), executionId: 'new' });
    const acknowledge = observations.acknowledgement('child');
    listener({ ...event('message.completed', 'after'), executionId: 'new' });
    acknowledge();
    expect(observations.capture('child', 'old')).toBeUndefined();
    expect(observations.capture('child', 'new')?.updates).toEqual([
      { kind: 'message', value: 'after' }
    ]);
    observations.close();
  });

  it('keeps upward reports for natural collection without waking a waiting parent', () => {
    const observations = new SessionObservations();
    const wake = vi.fn();
    observations.wake.subscribe(wake);
    expect(observations.report('child', 'execution', 'report')).toBe(true);
    expect(observations.wake.pending()).toBe(false);
    expect(wake).not.toHaveBeenCalled();
    expect(observations.collect(new AbortController().signal)[0]?.content).toContain('report');
    observations.close();
    expect(observations.report('child', 'execution', 'late')).toBe(false);
  });
});
