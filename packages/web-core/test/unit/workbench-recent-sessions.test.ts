import { nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeEach(() => vi.stubGlobal('window', new EventTarget()));
afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  vi.unstubAllGlobals();
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
  it('keeps entry running counts and authoritative unread independent', async () => {
    localePreferenceService().setLocale('en-US');
    const runs = ref([run('active', 'MAIN', 1)]);
    const state = ref({
      MAIN: { running: 1, unread: false },
      CHILD: { running: 0, unread: true }
    });
    const service = {
      recentRuns: runs,
      load: vi.fn(async () => undefined),
      sessionGroupState: () => state.value,
      hasUnreadSession: () => false
    };
    const mounted = mountSessionGroupTestComponent(WorkbenchRecentSessions, {
      service,
      mobileMode: true
    });
    mountedApps.push(mounted.app);
    const trigger = mounted.container.findAll(
      (node) => node.props.get('aria-label') === 'Recent Sessions'
    )[0]!;
    const unread = () =>
      trigger.findAll((node) => node.props.get('class') === 'session-state-unread');
    const counts = () =>
      trigger.findAll((node) => node.props.get('class') === 'session-state-count');
    expect(unread()[0]?.textContent).toBe('Unread');
    expect(counts()[0]?.textContent).toBe('1');
    expect(trigger.props.get('aria-description')).toBe('1 active sessions, Unread');
    runs.value = [];
    await nextTick();
    expect(counts()).toHaveLength(0);
    expect(unread()[0]?.textContent).toBe('Unread');
    state.value.CHILD.unread = false;
    await nextTick();
    expect(unread()).toHaveLength(0);
    expect(trigger.props.get('aria-description')).toBe('0 active sessions');
    state.value.MAIN.unread = true;
    await nextTick();
    expect(unread()[0]?.textContent).toBe('Unread');
    runs.value = [run('active', 'MAIN', 2)];
    state.value.MAIN.unread = false;
    await nextTick();
    expect(counts()[0]?.textContent).toBe('1');
    expect(unread()).toHaveLength(0);
    expect(service.load).not.toHaveBeenCalled();
  });

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
      hasUnreadSession: () => false,
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
      sessionGroupState: vi.fn(() => groupState),
      hasUnreadSession: vi.fn(() => true)
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
    expect(trigger?.props.get('aria-description')).toBe('3 active sessions, Unread');
    expect(service.sessionGroupState).toHaveBeenCalledOnce();
    expect(service.hasUnreadSession).toHaveBeenCalledWith('node-1', 'workspace-1', 'main-session');

    const childTab = target.findAll(
      (node) => node.props.get('role') === 'tab' && node.props.get('data-group') === 'CHILD'
    )[0];
    expect(childTab?.props.get('aria-label')).toContain('Child Sessions');
    expect(childTab?.props.get('aria-label')).toContain('Unread');
    childTab?.invoke('onClick');
    await nextTick();

    expect(target.textContent).toContain('child-session');
    expect(target.textContent).not.toContain('main-session');
    expect(trigger?.props.get('aria-description')).toBe('3 active sessions, Unread');
  });

  it.each([false, true])(
    'shows session-scoped unread labels and removes them after reading (mobile=%s)',
    async (mobileMode) => {
      localePreferenceService().setLocale('en-US');
      const unread = ref(true);
      const hasUnreadSession = vi.fn(
        (nodeId: string, workspaceId: string, sessionId: string) =>
          unread.value &&
          nodeId === 'node-1' &&
          workspaceId === 'workspace-1' &&
          sessionId === 'unread'
      );
      const runs: RecentRun[] = [
        { ...run('unread', 'MAIN', 1), status: 'SUCCEEDED' },
        run('read', 'MAIN', 2),
        { ...run('unread', 'MAIN', 3), nodeId: 'other-node' },
        { ...run('unread', 'MAIN', 4), workspaceId: 'other-workspace' }
      ];
      const opened = vi.fn();
      const mounted = mountSessionGroupTestComponent(WorkbenchRecentSessionList, {
        sessionGroup: 'MAIN',
        groupState: { MAIN: { running: 3, unread: true }, CHILD: { running: 0, unread: false } },
        runs,
        hasUnreadSession,
        mobileMode,
        runTime: () => 'Just now',
        onOpenRecentRun: opened
      });
      mountedApps.push(mounted.app);
      const list = mounted.container.findAll(
        (node) => node.props.get('class') === 'recent-sessions-list'
      )[0]!;
      const markers = () =>
        list.findAll(
          (node) => node.props.get('class') === 'recent-session-unread mar-unread-label'
        );
      expect(markers()).toHaveLength(1);
      expect(markers()[0]?.textContent).toBe('Unread');
      expect(hasUnreadSession).toHaveBeenCalledWith('other-node', 'workspace-1', 'unread');
      expect(hasUnreadSession).toHaveBeenCalledWith('node-1', 'other-workspace', 'unread');
      list.findAll((node) => node.type === 'button')[0]!.invoke('onClick');
      expect(opened).toHaveBeenCalledWith(runs[0]);
      unread.value = false;
      await nextTick();
      expect(markers()).toHaveLength(0);
      expect(list.findAll((node) => node.type === 'button')).toHaveLength(4);
    }
  );
});
