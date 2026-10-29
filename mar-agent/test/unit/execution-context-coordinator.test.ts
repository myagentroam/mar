import { expect, it, vi } from 'vitest';
import { ExecutionContextCoordinator } from '../../src/sdk/execution-context-coordinator.js';

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
      syncMcpWorldState: async () => {},
      recordEnvironment: async () => {}
    },
    compact: { pending: false, checkpoint: async () => false },
    requests: { drain: () => false },
    signal: new AbortController().signal,
    window: 100,
    gc: { run: async () => false },
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

it('prepares input and compact safety points before recording the environment', async () => {
  const order: string[] = [];
  const ports = basePorts();
  const coordinator = new ExecutionContextCoordinator({
    ...ports,
    context: {
      ...ports.context,
      syncMcpWorldState: async () => {
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
