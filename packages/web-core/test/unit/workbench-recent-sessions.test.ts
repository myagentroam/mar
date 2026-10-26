import { nextTick, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionGroup } from '@myagentroam/protocol';
import type { RecentRun } from '../../src/service/workbench-notification-service.js';
import WorkbenchRecentSessions from '../../src/view/workbench/WorkbenchRecentSessions.vue?unit-render';
import WorkbenchRecentSessionList from '../../src/view/workbench/WorkbenchRecentSessionList.vue?unit-render';
import { localePreferenceService } from '../../src/service/locale-preference-service.js';
import {
  mountSessionGroupTestComponent,
  SessionGroupTestNode
} from './support/session-group-tabs-renderer.js';

const originalLocale = localePreferenceService().locale.value;
const mountedApps: { unmount(): void }[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  localePreferenceService().setLocale(originalLocale);
});

function run(sessionId: string, sessionGroup: SessionGroup, runIndex: number): RecentRun {
  return {
    nodeId: 'node-1',
    workspaceId: 'workspace-1',
    workspaceName: 'Workspace',
    runId: `run-${sessionId}-${runIndex}`,
    sessionId,
    sessionGroup,
    sessionTitle: sessionId,
    userMessage: `Message for ${sessionId}`,
    runner: 'codex',
    status: 'RUNNING',
    createdAt: 100,
    startedAt: 110,
    completedAt: null,
    sortAt: 110,
    updatedAt: 110,
    version: 1
  };
}

describe('Workbench recent session groups', () => {
  it.each([
    {
      locale: 'en-US' as const,
      mobileMode: false,
      canceled: 'Canceled',
      interrupted: 'Interrupted'
    },
    {
      locale: 'en-US' as const,
      mobileMode: true,
      canceled: 'Canceled',
      interrupted: 'Interrupted'
    },
    { locale: 'zh-CN' as const, mobileMode: false, canceled: '已取消', interrupted: '已中断' },
    { locale: 'zh-CN' as const, mobileMode: true, canceled: '已取消', interrupted: '已中断' }
  ])(
    'distinguishes user stops from other interruptions in $locale mobile=$mobileMode',
    ({ locale, mobileMode, canceled, interrupted }) => {
      localePreferenceService().setLocale(locale);
      const mounted = mountSessionGroupTestComponent(WorkbenchRecentSessionList, {
        sessionGroup: 'MAIN',
        groupState: { MAIN: { running: 0, unread: false }, CHILD: { running: 0, unread: false } },
        runs: [
          {
            ...run('manual-stop', 'MAIN', 1),
            status: 'INTERRUPTED',
            interruptionReason: 'USER_STOP'
          },
          { ...run('other-interruption', 'MAIN', 2), status: 'INTERRUPTED' },
          { ...run('legacy-cancellation', 'MAIN', 3), status: 'CANCELLED' }
        ],
        hasUnreadSession: () => false,
        mobileMode,
        runTime: () => 'Just now'
      });
      mountedApps.push(mounted.app);
      const list = mounted.container.findAll(
        (node) => node.props.get('class') === 'recent-sessions-list'
      )[0]!;
      const tags = list.findAll((node) => node.type === 'span' && node.props.has('type'));
      expect(tags.map((node) => node.textContent)).toEqual([canceled, interrupted, canceled]);
      expect(tags.map((node) => node.props.get('type'))).toEqual(['info', 'warning', 'info']);
    }
  );

  it('uses primary for ongoing runs, success for completion, and preserves other status semantics', () => {
    localePreferenceService().setLocale('en-US');
    const statuses: RecentRun['status'][] = [
      'STARTING',
      'RUNNING',
      'SUCCEEDED',
      'FAILED',
      'CANCELLING',
      'INTERRUPTED',
      'CANCELLED'
    ];
    const mounted = mountSessionGroupTestComponent(WorkbenchRecentSessionList, {
      sessionGroup: 'MAIN',
      groupState: { MAIN: { running: 2, unread: false }, CHILD: { running: 0, unread: false } },
      runs: statuses.map((status, index) => ({ ...run(status, 'MAIN', index), status })),
      mobileMode: false,
      runTime: () => 'Just now'
    });
    mountedApps.push(mounted.app);
    const list = mounted.container.findAll(
      (node) => node.props.get('class') === 'recent-sessions-list'
    )[0]!;
    const tags = list.findAll((node) => node.type === 'span' && node.props.has('type'));
    expect(tags.map((node) => node.props.get('type'))).toEqual([
      'primary',
      'primary',
      'success',
      'danger',
      'warning',
      'warning',
      'info'
    ]);
    expect(tags.map((node) => node.textContent)).toEqual([
      'Starting',
      'Running',
      'Completed',
      'Failed',
      'Stopping',
      'Interrupted',
      'Canceled'
    ]);
  });

  it('defaults to Main, filters runs on selection, and preserves the combined entry count', async () => {
    localePreferenceService().setLocale('en-US');
    const runs = ref([
      run('main-session', 'MAIN', 1),
      run('main-session', 'MAIN', 2),
      run('child-session', 'CHILD', 1)
    ]);
    const groupState = {
      MAIN: { running: 1, unread: true },
      CHILD: { running: 1, unread: true }
    };
    const service = {
      recentRuns: runs,
      load: vi.fn(async () => undefined),
      sessionGroupState: vi.fn(() => groupState)
    };
    const target = new SessionGroupTestNode('mobile-panel');
    const mounted = mountSessionGroupTestComponent(WorkbenchRecentSessions, {
      service,
      mobileMode: true,
      mobileOpen: true,
      mobilePresented: true,
      mobilePanelTarget: target as unknown as HTMLElement
    });
    mountedApps.push(mounted.app);

    expect(target.textContent).toContain('main-session');
    expect(target.textContent).not.toContain('child-session');
    const trigger = mounted.container.findAll(
      (node) => node.props.get('aria-label') === 'Recent Sessions'
    )[0];
    expect(trigger?.props.get('aria-description')).toBe('3 active sessions');
    expect(service.sessionGroupState).toHaveBeenCalledOnce();

    const childTab = target.findAll(
      (node) => node.props.get('role') === 'tab' && node.props.get('data-group') === 'CHILD'
    )[0];
    expect(childTab?.props.get('aria-label')).toContain('Child Sessions');
    expect(childTab?.props.get('aria-label')).toContain('Unread');
    childTab?.invoke('onClick');
    await nextTick();

    expect(target.textContent).toContain('child-session');
    expect(target.textContent).not.toContain('main-session');
    expect(trigger?.props.get('aria-description')).toBe('3 active sessions');
  });
});
