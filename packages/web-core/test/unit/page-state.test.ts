import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createWorkbenchPageStateService } from '../../src/service/WorkbenchBaseStateService.js';

const captured = vi.hoisted(() => ({
  activeTarget: undefined as (() => unknown) | undefined
}));
vi.mock('../../src/service/WorkbenchNotificationService.js', () => ({
  createWorkbenchNotificationService: (
    _username: unknown,
    options: {
      activeTarget: () => unknown;
    }
  ) => {
    captured.activeTarget = options.activeTarget;
    return { dispose: vi.fn() };
  }
}));
afterEach(() => vi.unstubAllGlobals());

describe('public page state composition', () => {
  it('shares the provided navigation and selects only the foreground notification target', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => null });
    const navigation = { view: ref('nodes'), managementSection: ref('custom-page') };
    const state = createWorkbenchPageStateService({
      sessionPageSize: 30,
      onUnauthenticated: vi.fn(),
      navigation
    });
    expect(state.navigation).toBe(navigation);
    expect(captured.activeTarget?.()).toBeUndefined();
    state.selection.workspaceTarget.value = { nodeId: 'node-a', workspaceId: 'workspace-a' };
    state.selection.selectedSessionId.value = 'session-a';
    state.hostedSelection.selectedNodeId.value = 'hosted-node';
    state.hostedSelection.selectedConversationId.value = 'conversation-a';
    expect(captured.activeTarget?.()).toEqual({
      targetType: 'WORKSPACE_SESSION',
      nodeId: 'node-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a'
    });
    navigation.view.value = 'conversations';
    expect(captured.activeTarget?.()).toEqual({
      targetType: 'HOSTED_CONVERSATION',
      nodeId: 'hosted-node',
      conversationId: 'conversation-a'
    });
    navigation.view.value = 'management';
    expect(captured.activeTarget?.()).toBeUndefined();
    expect(state.selection.workspaceTarget.value?.workspaceId).toBe('workspace-a');
    expect(state.navigation.managementSection.value).toBe('custom-page');
  });
});
