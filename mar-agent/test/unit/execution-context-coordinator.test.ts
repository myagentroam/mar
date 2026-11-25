import { expect, it, vi } from 'vitest';
import {
  ExecutionContextCoordinator,
  previousNaturalTurnGc
} from '../../src/sdk/execution-context-coordinator.js';
import type { PreparedExecutionRound } from '../../src/runtime/execution.js';
import type { SessionRecord } from '../../src/session/record-contract.js';
import type { RoundToolScope } from '../../src/tools/execution.js';

const unused = (): never => {
  throw new Error('not used');
};
function basePorts(): ConstructorParameters<typeof ExecutionContextCoordinator>[0] {
  return {
    initialBoundary: 0,
    messages: [],
    resources: {
      hasPendingImages: () => false,
      gcCandidate: unused,
      historyView: (messages) => [...messages]
    },
    execution: { appendBoundary: 0, assertContextValid: () => {} },
    model: { tokens: undefined },
    context: {
      adoptGcCheckpoint: unused,
      syncCatalogWorldState: async () => {},
      recordEnvironment: async () => {}
    },
    compact: { pending: false, checkpoint: async () => false },
    requests: { drain: () => false },
    signal: new AbortController().signal,
    window: 100,
    contextGcMode: 'auto',
    gc: { run: async () => false, skipRollout: () => {} },
    gcBase: {
      store: { readExecutionState: unused, commitContextGc: unused, readPage: unused },
      sessionId: 's',
      modelId: 'm',
      contextWindowTokens: 100,
      workspace: '/tmp',
      platform: 'linux'
    },
    start: unused,
    wait: async () => false,
    activeProcesses: async () => new Set()
  };
}

it('does not treat a missing final answer or a more recent cancellation as a natural boundary', () => {
  const model = { id: 'm', contextWindowTokens: 100 };
  const record = (
    sequence: number,
    executionId: string,
    type: string,
    fields: Record<string, unknown> = {}
  ): SessionRecord => {
    const metadata = { sequence, executionId, sessionId: 's', timestamp: '2026-11-25T00:00:00Z' };
    return {
      ...metadata,
      recordId: `record-${sequence}`,
      type,
      payload: { ...metadata, eventId: `event-${sequence}`, type, ...fields }
    };
  };
  const header = record(1, 'first', 'execution.header', {
    mode: 'run',
    modelId: model.id,
    contextWindowTokens: model.contextWindowTokens
  });
  const usage = record(2, 'first', 'usage.updated', { contextInputTokens: 60 });
  const completed = record(4, 'first', 'execution.completed');
  const answer = record(3, 'first', 'message.completed', { phase: 'final_answer', text: 'Done' });
  expect(previousNaturalTurnGc([header, usage, answer, completed], model)).toEqual({
    usage: { contextInputTokens: 60 }
  });
  const withoutText = record(3, 'first', 'message.completed', { phase: 'final_answer' });
  expect(previousNaturalTurnGc([header, usage, withoutText, completed], model)).toBeUndefined();
  const cancelled = record(5, 'second', 'execution.cancelled');
  expect(
    previousNaturalTurnGc([header, usage, answer, completed, cancelled], model)
  ).toBeUndefined();
});

it('does not adopt a GC candidate without a durable checkpoint', async () => {
  const adoptGcCheckpoint = vi.fn();
  const ports = basePorts();
  const coordinator = new ExecutionContextCoordinator({
    ...ports,
    context: { ...ports.context, adoptGcCheckpoint }
  });
  expect(
    await coordinator.gc(
      { request: { system: 's' }, toolScope: { tools: [] } },
      undefined,
      undefined
    )
  ).toBe(false);
  expect(adoptGcCheckpoint).not.toHaveBeenCalled();
});

it('uses a successful Thought only at the next request boundary without restricting hard-limit GC', async () => {
  const ports = basePorts();
  const run = vi.fn(async () => false);
  const skipRollout = vi.fn();
  const coordinator = new ExecutionContextCoordinator({
    ...ports,
    contextGcMode: 'with_thought',
    gc: { run, skipRollout }
  });
  const round = {
    request: { system: 's' },
    toolScope: { tools: [] }
  } as PreparedExecutionRound<RoundToolScope>;
  const usage = { inputTokens: 60 };
  const hard = { reason: 'HARD_LIMIT' } as NonNullable<Parameters<typeof coordinator.gc>[2]>;
  const soft = { ...hard, reason: 'SOFT_LIMIT' } as const;
  await coordinator.checkpoint(round, usage);
  await coordinator.prepareRequestGc(round, [], usage, soft);
  expect(run).not.toHaveBeenCalled();
  expect(skipRollout).toHaveBeenCalledExactlyOnceWith(usage, ports.window);
  await coordinator.prepareRequestGc(round, [], usage, hard);
  expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ inlineMedia: hard, usage }));

  const thought = {
    role: 'tool_call',
    name: 'thought',
    callId: 't',
    arguments: { title: 'Decision', content: 'Verified A; rejected B.' },
    content: ''
  } as const;
  // The last authoritative usage remains available even if the Thought round reports none.
  await coordinator.checkpoint(round, undefined, [thought.callId]);
  expect(run).toHaveBeenCalledTimes(1);
  await coordinator.prepareRequestGc(round, [thought], usage, hard);
  expect(run).toHaveBeenCalledTimes(2);
  expect(skipRollout).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ inlineMedia: hard, usage }));
  await coordinator.prepareRequestGc(round, [thought], undefined, undefined);
  expect(run).toHaveBeenCalledTimes(2);

  // Request transforms may omit the last call while retaining an earlier successful Thought.
  await coordinator.checkpoint(round, undefined, [thought.callId, 'filtered-thought']);
  await coordinator.prepareRequestGc(round, [thought], usage, soft);
  expect(run).toHaveBeenCalledTimes(3);
  expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ inlineMedia: soft, usage }));
});

it.each(['auto', 'with_thought'] as const)(
  'combines the first request of a new Turn and image pressure in %s',
  async (contextGcMode) => {
    const ports = basePorts();
    const run = vi.fn(async () => false);
    const usage = { contextInputTokens: 60 };
    const coordinator = new ExecutionContextCoordinator({
      ...ports,
      contextGcMode,
      naturalTurnGc: { usage },
      gc: { ...ports.gc, run }
    });
    const round = { request: { system: 's' }, toolScope: { tools: [] } };
    const hard = { reason: 'HARD_LIMIT' } as NonNullable<Parameters<typeof coordinator.gc>[2]>;
    const soft = { ...hard, reason: 'SOFT_LIMIT' } as const;
    await coordinator.prepareRequestGc(round, [], undefined, hard);
    expect(run).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ inlineMedia: hard, usage })
    );
    await coordinator.prepareRequestGc(round, [], undefined, soft);
    expect(run).toHaveBeenCalledTimes(1);
  }
);

it('drops the cross-Turn trigger after Compact adoption without disabling image hard-limit GC', async () => {
  const ports = basePorts();
  const run = vi.fn(async () => false);
  const coordinator = new ExecutionContextCoordinator({
    ...ports,
    naturalTurnGc: { usage: { contextInputTokens: 60 } },
    gc: { ...ports.gc, run }
  });
  const round = { request: { system: 's' }, toolScope: { tools: [] } };
  coordinator.invalidateNaturalTurnGc();
  await coordinator.prepareRequestGc(round, [], undefined, undefined);
  expect(run).not.toHaveBeenCalled();
  const hard = { reason: 'HARD_LIMIT' } as NonNullable<Parameters<typeof coordinator.gc>[2]>;
  await coordinator.prepareRequestGc(round, [], undefined, hard);
  expect(run).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ inlineMedia: hard, usage: {} })
  );
});

it.each([
  { mode: 'off' as const, pending: false },
  { mode: 'auto' as const, pending: true }
])('does not run GC when disabled or Compact is pending: %j', async ({ mode, pending }) => {
  const ports = basePorts();
  const run = vi.fn(async () => false);
  const coordinator = new ExecutionContextCoordinator({
    ...ports,
    contextGcMode: mode,
    compact: { ...ports.compact, pending },
    gc: { ...ports.gc, run }
  });
  expect(
    await coordinator.gc({ request: { system: 's' }, toolScope: { tools: [] } }, {}, undefined)
  ).toBe(false);
  expect(run).not.toHaveBeenCalled();
});

it('prepares input and compact safety points before recording the environment', async () => {
  const order: string[] = [];
  const ports = basePorts();
  const coordinator = new ExecutionContextCoordinator({
    ...ports,
    context: {
      ...ports.context,
      syncCatalogWorldState: async () => {
        order.push('world');
      },
      recordEnvironment: async () => {
        order.push('environment');
      }
    },
    compact: {
      pending: false,
      checkpoint: async (blocking) => {
        order.push(blocking ? 'blocking' : 'adopt');
        return false;
      }
    },
    requests: {
      drain: () => {
        order.push('requests');
        return true;
      }
    }
  });
  await coordinator.prepareInputs({
    includeSessionContext: true,
    appendMailbox: async () => {
      order.push('mailbox');
    },
    appendSessionContext: async () => {
      order.push('session-context');
    },
    refreshTools: () => {
      order.push('tools');
    },
    updateEnvironment: () => {
      order.push('clock');
    }
  });
  expect(order).toEqual([
    'mailbox',
    'session-context',
    'tools',
    'world',
    'requests',
    'blocking',
    'adopt',
    'world',
    'clock',
    'environment'
  ]);
});
