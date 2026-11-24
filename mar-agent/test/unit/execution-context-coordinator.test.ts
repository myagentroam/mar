import { expect, it, vi } from 'vitest';
import { ExecutionContextCoordinator } from '../../src/sdk/execution-context-coordinator.js';
import type { PreparedExecutionRound } from '../../src/runtime/execution.js';
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
  await coordinator.checkpoint(round, usage, [thought.callId, 'filtered-thought']);
  await coordinator.prepareRequestGc(round, [thought], undefined, soft);
  expect(run).toHaveBeenCalledTimes(3);
  expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ inlineMedia: soft, usage }));
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
