import { describe, expect, it, vi } from 'vitest';
import { createWorkbenchViewWatchService as createWorkbenchNavigationWatchService } from '../../src/service/workbench-view-watch-service.js';

describe('Web Workbench Navigation Watch Convergence', () => {
  it('Restores the unique Workspace and Session Watches when returning from a hosted conversation through another view', async () => {
    let currentView: 'nodes' | 'conversations' | 'settings' = 'nodes';
    const coordinator = {
      stopWorkspace: vi.fn(),
      stopSession: vi.fn(),
      beginHostedConversation: vi.fn().mockResolvedValue(undefined),
      stopHostedConversation: vi.fn(),
      startWorkspace: vi.fn().mockResolvedValue(undefined),
      beginSession: vi.fn()
    };
    const service = createWorkbenchNavigationWatchService({
      coordinator: () => coordinator,
      currentView: () => currentView,
      workspaceTarget: () => ({ nodeId: 'node-1', workspaceId: 'workspace-1' }),
      selectedSessionId: () => 'session-1',
      selectedHostedConversationId: () => 'conversation-1'
    });

    currentView = 'conversations';
    service.transition('nodes', currentView);
    expect(coordinator.stopWorkspace).toHaveBeenCalledOnce();
    expect(coordinator.stopSession).toHaveBeenCalledOnce();
    expect(coordinator.beginHostedConversation).toHaveBeenCalledOnce();

    currentView = 'settings';
    service.transition('conversations', currentView);
    expect(coordinator.stopHostedConversation).toHaveBeenCalledOnce();
    expect(coordinator.startWorkspace).not.toHaveBeenCalled();

    currentView = 'nodes';
    service.transition('settings', currentView);
    await vi.waitFor(() => expect(coordinator.startWorkspace).toHaveBeenCalledWith('workspace-1'));
    expect(coordinator.beginSession).toHaveBeenCalledWith('session-1');

    service.transition('settings', 'nodes');
    expect(coordinator.startWorkspace).toHaveBeenCalledOnce();
    expect(coordinator.beginSession).toHaveBeenCalledOnce();
  });

  it('Restores Watches when the page initially shows a hosted conversation and returns directly to the Workspace', async () => {
    let currentView: 'nodes' | 'conversations' = 'conversations';
    const coordinator = {
      stopWorkspace: vi.fn(),
      stopSession: vi.fn(),
      beginHostedConversation: vi.fn().mockResolvedValue(undefined),
      stopHostedConversation: vi.fn(),
      startWorkspace: vi.fn().mockResolvedValue(undefined),
      beginSession: vi.fn()
    };
    const service = createWorkbenchNavigationWatchService({
      coordinator: () => coordinator,
      currentView: () => currentView,
      workspaceTarget: () => ({ nodeId: 'node-1', workspaceId: 'workspace-1' }),
      selectedSessionId: () => 'session-1',
      selectedHostedConversationId: () => 'conversation-1'
    });

    currentView = 'nodes';
    service.transition('conversations', currentView);

    await vi.waitFor(() => expect(coordinator.startWorkspace).toHaveBeenCalledWith('workspace-1'));
    expect(coordinator.stopHostedConversation).toHaveBeenCalledOnce();
    expect(coordinator.beginSession).toHaveBeenCalledWith('session-1');
  });
});
