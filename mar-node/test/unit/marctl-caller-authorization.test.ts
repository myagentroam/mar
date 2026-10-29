import { describe, expect, it, vi } from 'vitest';
import type { NodeRuntimeState } from '../../src/runtime-state.js';
import type { NodeAgentSession } from '../../src/session/contracts.js';
import { authorizeMarctlExecutionOperation } from '../../src/service/marctl-caller.js';

describe('marctl execution operation authorization', () => {
  const sessions = new Map([
    ['parent', { id: 'parent', workspaceId: 'workspace', parentSessionId: null }],
    ['child', { id: 'child', workspaceId: 'workspace', parentSessionId: 'parent' }],
    ['sibling', { id: 'sibling', workspaceId: 'workspace', parentSessionId: 'other' }],
    ['foreign', { id: 'foreign', workspaceId: 'other', parentSessionId: 'parent' }]
  ]);
  const runtime = {
    getAgentSession: (id: string) => sessions.get(id),
    activeSessionRun: () => undefined,
    sessionQueue: () => ({ itemIds: [] })
  } as unknown as NodeRuntimeState;
  const caller = { type: 'execution', sessionId: 'parent', executionId: 'exec' };
  function check(operation: string, sessionId: string, identity: unknown = caller) {
    return authorizeMarctlExecutionOperation({
      caller: identity,
      operation,
      data: { sessionId, workspaceId: 'workspace' },
      userId: 7,
      runtime,
      resolveSession: vi.fn(async () => undefined as NodeAgentSession | undefined)
    });
  }

  it.each(['session.metadata.update', 'session.config.update', 'session.schedule.agent.save'])(
    'allows %s for self and a direct child but rejects siblings and foreign Sessions',
    async (operation) => {
      await expect(check(operation, 'parent')).resolves.toBeUndefined();
      await expect(check(operation, 'child')).resolves.toBeUndefined();
      await expect(check(operation, 'sibling')).rejects.toThrow('AGENT_TARGET_NOT_AUTHORIZED');
      await expect(check(operation, 'foreign')).rejects.toThrow('AGENT_TARGET_NOT_AUTHORIZED');
    }
  );

  it.each([
    'run.cancel',
    'session.command.execute',
    'session.start',
    'session.send',
    'run.approval.decide'
  ])('rejects legacy execution write %s', async (operation) => {
    await expect(check(operation, 'sibling')).rejects.toThrow('MARCTL_AGENT_NETWORK_REQUIRED');
    await expect(check(operation, 'child')).rejects.toThrow('MARCTL_AGENT_NETWORK_REQUIRED');
    await expect(check(operation, 'sibling', { type: 'terminal' })).resolves.toBeUndefined();
  });

  it('checks active Run ownership for permitted management targets', async () => {
    const otherOwner = {
      ...runtime,
      getAgentSession: runtime.getAgentSession.bind(runtime),
      activeSessionRun: () => ({ initiatedByUserId: 42 })
    } as unknown as NodeRuntimeState;
    await expect(
      authorizeMarctlExecutionOperation({
        caller,
        operation: 'session.config.update',
        data: { sessionId: 'child', workspaceId: 'workspace' },
        userId: 7,
        runtime: otherOwner,
        resolveSession: vi.fn()
      })
    ).rejects.toThrow('RUN_OWNED_BY_ANOTHER_USER');
  });
});
