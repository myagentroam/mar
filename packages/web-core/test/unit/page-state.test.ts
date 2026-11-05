import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createWorkbenchPageStateService } from '../../src/service/workbench-base-state-service.js';

const captured = vi.hoisted(() => ({
  activeTargets: undefined as (() => unknown) | undefined
}));
vi.mock('../../src/service/workbench-notification-service.js', () => ({
  createWorkbenchNotificationService: (
    _username: unknown,
    options: {
      activeTargets: () => unknown;
    }
  ) => {
    captured.activeTargets = options.activeTargets;
    return { dispose: vi.fn() };
  }
}));
afterEach(() => vi.unstubAllGlobals());

describe('public page state composition', () => {
  it('shares the provided navigation and selects only the foreground notification target', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => null });
    const navigation = { view: ref('nodes'), managementSection: ref('custom-page') };
    const visible = ref<{ nodeId: string; workspaceId: string; sessionId: string }[]>([]);
    const hosted = ref<{ nodeId: string; conversationId: string }>();
    const state = createWorkbenchPageStateService({
      sessionPageSize: 30,
      onUnauthenticated: vi.fn(),
      navigation,
      visibleWorkspaceTargets: () => visible.value,
      visibleHostedTarget: () => hosted.value
    });
    expect(state.navigation).toBe(navigation);
    expect(captured.activeTargets?.()).toEqual([]);
    visible.value = [
      { nodeId: 'node-a', workspaceId: 'workspace-a', sessionId: 'session-a' },
      { nodeId: 'node-a', workspaceId: 'workspace-a', sessionId: 'session-b' }
    ];
    hosted.value = { nodeId: 'hosted-node', conversationId: 'conversation-a' };
    expect(captured.activeTargets?.()).toEqual([
      {
        targetType: 'WORKSPACE_SESSION',
        nodeId: 'node-a',
        workspaceId: 'workspace-a',
        sessionId: 'session-a'
      },
      {
        targetType: 'WORKSPACE_SESSION',
        nodeId: 'node-a',
        workspaceId: 'workspace-a',
        sessionId: 'session-b'
      }
    ]);
    navigation.view.value = 'conversations';
    expect(captured.activeTargets?.()).toEqual([
      {
        targetType: 'HOSTED_CONVERSATION',
        nodeId: 'hosted-node',
        conversationId: 'conversation-a'
      }
    ]);
    navigation.view.value = 'management';
    expect(captured.activeTargets?.()).toEqual([]);
    expect(visible.value[0]?.workspaceId).toBe('workspace-a');
    expect(state.navigation.managementSection.value).toBe('custom-page');
  });
});
