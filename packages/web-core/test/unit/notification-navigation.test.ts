import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceTarget } from '../../src/model/workbench.js';
import { navigateWorkbenchNotification } from '../../src/service/WorkbenchNotificationNavigationService.js';

function fixture() {
  const workspaceTarget = ref<WorkspaceTarget>();
  const activateWorkspace = vi.fn(async (target: WorkspaceTarget) => {
    workspaceTarget.value = { ...target };
    return true;
  });
  const synchronizeSessions = vi.fn<() => Promise<void>>(async () => {});
  const openSession = vi.fn(async () => undefined);
  const options = {
    workspaceTarget: () => workspaceTarget.value,
    activateWorkspace,
    hasSession: vi.fn(() => false),
    showNodes: vi.fn(),
    showConversations: vi.fn(),
    synchronizeSessions,
    openSession,
    openHostedConversation: vi.fn(async () => undefined)
  };
  return { workspaceTarget, activateWorkspace, synchronizeSessions, openSession, options };
}
const notification = {
  targetType: 'WORKSPACE_SESSION' as const,
  nodeId: 'node-2',
  workspaceId: 'workspace-2',
  sessionId: 'session-2'
};

describe('Workspace notification navigation', () => {
  it('activates the target Workspace before synchronizing and opening its session', async () => {
    const f = fixture();
    const calls: string[] = [];
    f.activateWorkspace.mockImplementation(async (value) => {
      calls.push('workspace');
      f.workspaceTarget.value = { ...value };
      return true;
    });
    f.synchronizeSessions.mockImplementation(async () => {
      calls.push('sessions');
    });
    f.openSession.mockImplementation(async () => {
      calls.push('open');
    });
    await navigateWorkbenchNotification(notification, f.options);
    expect(calls).toEqual(['workspace', 'sessions', 'open']);
    expect(f.activateWorkspace).toHaveBeenCalledWith({
      nodeId: 'node-2',
      workspaceId: 'workspace-2'
    });
  });
  it('opens an already cached session without synchronizing', async () => {
    const f = fixture();
    f.options.hasSession.mockReturnValue(true);
    await navigateWorkbenchNotification(notification, f.options);
    expect(f.synchronizeSessions).not.toHaveBeenCalled();
    expect(f.openSession).toHaveBeenCalledWith('session-2');
  });
  it('does not read sessions when activation fails', async () => {
    const f = fixture();
    f.activateWorkspace.mockResolvedValue(false);
    await expect(navigateWorkbenchNotification(notification, f.options)).rejects.toThrow(
      'NOTIFICATION_TARGET_NOT_SELECTED'
    );
    expect(f.synchronizeSessions).not.toHaveBeenCalled();
  });
  it('does not open an old notification session after A to B to A', async () => {
    const f = fixture();
    let finish!: () => void;
    f.synchronizeSessions.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const navigation = navigateWorkbenchNotification(notification, f.options);
    await Promise.resolve();
    f.workspaceTarget.value = { nodeId: 'node-1', workspaceId: 'workspace-1' };
    f.workspaceTarget.value = { nodeId: 'node-2', workspaceId: 'workspace-2' };
    finish();
    await navigation;
    expect(f.openSession).not.toHaveBeenCalled();
  });
  it('never creates a host-only foreground selection for incomplete targets', async () => {
    const f = fixture();
    await navigateWorkbenchNotification(
      { targetType: 'WORKSPACE_SESSION', nodeId: 'node-2' } as never,
      f.options
    );
    expect(f.workspaceTarget.value).toBeUndefined();
    expect(f.activateWorkspace).not.toHaveBeenCalled();
  });
  it('keeps hosted-conversation navigation independent', async () => {
    const f = fixture();
    await navigateWorkbenchNotification(
      {
        targetType: 'HOSTED_CONVERSATION',
        nodeId: 'node-2',
        conversationId: 'conversation-2',
        conversationName: 'Research'
      },
      f.options
    );
    expect(f.options.showConversations).toHaveBeenCalledOnce();
    expect(f.options.openHostedConversation).toHaveBeenCalledWith('node-2', 'conversation-2');
    expect(f.activateWorkspace).not.toHaveBeenCalled();
  });
});
