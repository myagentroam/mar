import { nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionGroup } from '@myagentroam/protocol';
import type { RecentRun } from '../../src/service/workbench-notification-service.js';
import WorkbenchRecentSessionList from '../../src/view/workbench/WorkbenchRecentSessionList.vue?unit-render';
import { localePreferenceService } from '../../src/service/locale-preference-service.js';
import { mountSessionGroupTestComponent } from './support/session-group-tabs-renderer.js';

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
  it.each([
    { locale: 'en-US' as const, canceled: 'Canceled', interrupted: 'Interrupted' },
    { locale: 'zh-CN' as const, canceled: '已取消', interrupted: '已中断' }
  ])(
    'distinguishes user stops from other interruptions in $locale',
    ({ locale, canceled, interrupted }) => {
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
        runTime: () => 'Just now'
      });
      mountedApps.push(mounted.app);
      const list = mounted.container.findAll((node) => node.type === 'ul')[0]!;
      const tags = list.findAll(
        (node) => node.type === 'span' && node.props.get('class') === 'mar-ui-tag'
      );
      expect(tags.map((node) => node.textContent)).toEqual([canceled, interrupted, canceled]);
      expect(tags.map((node) => node.props.get('data-type'))).toEqual(['info', 'warning', 'info']);
    }
  );

  it('keeps completed neutral, running green, and preserves other status semantics', () => {
    localePreferenceService().setLocale('en-US');
    const statuses: RecentRun['status'][] = [
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
      runTime: () => 'Just now'
    });
    mountedApps.push(mounted.app);
    const list = mounted.container.findAll((node) => node.type === 'ul')[0]!;
    const tags = list.findAll(
      (node) => node.type === 'span' && node.props.get('class') === 'mar-ui-tag'
    );
    expect(tags.map((node) => node.props.get('data-type'))).toEqual([
      'success',
      'info',
      'danger',
      'warning',
      'warning',
      'info'
    ]);
    expect(tags.map((node) => node.textContent)).toEqual([
      'Running',
      'Completed',
      'Failed',
      'Stopping',
      'Interrupted',
      'Canceled'
    ]);
  });

  it('shows session-scoped unread labels and removes them after reading', async () => {
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
      runTime: () => 'Just now',
      onOpenRecentRun: opened
    });
    mountedApps.push(mounted.app);
    const list = mounted.container.findAll((node) => node.type === 'ul')[0]!;
    const markers = () =>
      list.findAll((node) => node.props.get('class') === 'recent-session-unread mar-unread-label');
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
  });
});
