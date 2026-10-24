import type { ServerNotification } from '@myagentroam/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkbenchNotificationService,
  parseStoredWorkbenchNotifications,
  sweepExpiredNotificationIds,
  type NotificationTarget,
  type RecentRun,
  type WorkbenchNotification
} from '../../src/service/workbench-notification-service';
import {
  activeRecentRunStatus,
  elapsedDurationLabel,
  recentRunTimeReference
} from '../../src/util/notification-presentation';
import { ApiError } from '../../src/util/api-error';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function notification(
  id: string,
  sessionId = 'session-1'
): ServerNotification & {
  readonly target: Extract<NotificationTarget, { targetType: 'WORKSPACE_SESSION' }>;
} {
  const now = Date.now();
  return {
    id,
    kind: 'run',
    title: 'Run completed',
    message: 'Session: Test Session. Open the related session.',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 86_400_000,
    read: false,
    target: {
      targetType: 'WORKSPACE_SESSION',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId,
      sessionName: 'Test Session'
    }
  };
}

function hostedNotification(id: string, conversationId = 'conversation-1'): ServerNotification {
  const now = Date.now();
  return {
    id,
    kind: 'run',
    title: 'Hosted run completed',
    message: 'Run completed. Open the conversation.',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 86_400_000,
    read: false,
    target: {
      targetType: 'HOSTED_CONVERSATION',
      nodeId: 'node-1',
      conversationId,
      conversationName: 'Research Conversation'
    }
  };
}

function workspaceRun(status: RecentRun['status'] = 'RUNNING'): RecentRun {
  return {
    nodeId: 'node-1',
    workspaceId: 'workspace-1',
    runId: 'workspace-run',
    sessionId: 'session-1',
    sessionTitle: 'Workspace task',
    runner: 'codex',
    status,
    createdAt: 100,
    startedAt: 110,
    completedAt: null,
    sortAt: 110,
    updatedAt: 110,
    version: 1
  };
}

function recoveryFixture(
  entries: ServerNotification[],
  onNotificationClick?: (notification: WorkbenchNotification) => Promise<void>
) {
  const active = { target: notification('active').target as NotificationTarget | undefined };
  const server = {
    entries,
    recentRuns: [] as RecentRun[],
    readError: undefined as Error | undefined,
    readGate: undefined as (() => Promise<void>) | undefined
  };
  const request = vi.fn(async (path: string, init?: RequestInit): Promise<unknown> => {
    if (path === '/api/notifications')
      return { notifications: server.entries, recentRuns: server.recentRuns };
    if (path.endsWith('/read') && init?.method === 'POST') {
      await server.readGate?.();
      if (server.readError !== undefined) throw server.readError;
      const target = JSON.parse(String(init.body ?? '{}')) as Record<string, string>;
      server.entries = server.entries.map((entry) => {
        const current = entry.target;
        const matches =
          path === '/api/notifications/session/read'
            ? current?.targetType === 'WORKSPACE_SESSION' &&
              current.nodeId === target.nodeId &&
              current.workspaceId === target.workspaceId &&
              current.sessionId === target.sessionId
            : path === '/api/notifications/conversation/read'
              ? current?.targetType === 'HOSTED_CONVERSATION' &&
                current.nodeId === target.nodeId &&
                current.conversationId === target.conversationId
              : path === `/api/notifications/${encodeURIComponent(entry.id)}/read`;
        return matches ? { ...entry, read: true } : entry;
      });
      return {};
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  const onWorkspaceRunCompleted = vi.fn();
  const username = { value: 'admin' };
  const state = createWorkbenchNotificationService(username as never, {
    request: request as never,
    activeTarget: () => active.target,
    onWorkspaceRunCompleted,
    ...(onNotificationClick === undefined ? {} : { onNotificationClick })
  });
  return {
    active,
    server,
    request,
    state,
    onWorkspaceRunCompleted,
    username,
    reads: () => request.mock.calls.filter(([, init]) => init?.method === 'POST')
  };
}

describe('Workspace session unread queries', () => {
  it('isolates session identities and excludes read, expired, local and hosted notifications', () => {
    const state = createWorkbenchNotificationService({ value: 'admin' } as never);
    const target = notification('target').target;
    state.notifications.value = [
      { ...notification('read', 'read-only'), source: 'server', read: true },
      { ...notification('expired', 'expired-only'), source: 'server', expiresAt: Date.now() },
      { ...hostedNotification('hosted', 'hosted-only'), source: 'server' },
      {
        ...notification('local'),
        source: 'local',
        kind: 'upload',
        target: { nodeId: 'node-1', workspaceId: 'workspace-1', sessionId: 'local-only' }
      },
      { ...notification('match'), source: 'server' },
      {
        ...notification('scoped'),
        source: 'server',
        target: { ...target, nodeId: 'node:one', workspaceId: 'workspace' }
      }
    ];
    expect(state.hasUnreadSession('node-1', 'workspace-1', 'session-1')).toBe(true);
    for (const id of ['read-only', 'expired-only', 'local-only', 'hosted-only', 'missing']) {
      expect(state.hasUnreadSession('node-1', 'workspace-1', id)).toBe(false);
    }
    expect(state.hasUnreadSession('node-2', 'workspace-1', 'session-1')).toBe(false);
    expect(state.hasUnreadSession('node-1', 'workspace-2', 'session-1')).toBe(false);
    expect(state.hasUnreadSession('node:one', 'workspace', 'session-1')).toBe(true);
    expect(state.hasUnreadSession('node', 'one:workspace', 'session-1')).toBe(false);
  });

  it.each([false, true])(
    'keeps a session unread until its last unread notification expires without a refresh: reversed=%s',
    (reversed) => {
      vi.useFakeTimers();
      const now = 1_800_000_000_000;
      vi.setSystemTime(now);
      const state = createWorkbenchNotificationService({ value: 'admin' } as never);
      const entries: WorkbenchNotification[] = [
        { ...notification('short'), source: 'server', expiresAt: now + 10 },
        { ...notification('long'), source: 'server', expiresAt: now + 20 },
        { ...notification('already-read'), source: 'server', read: true, expiresAt: now + 30 }
      ];
      state.notifications.value = reversed ? entries.reverse() : entries;
      expect(state.hasUnreadSession('node-1', 'workspace-1', 'session-1')).toBe(true);
      vi.setSystemTime(now + 10);
      expect(state.hasUnreadSession('node-1', 'workspace-1', 'session-1')).toBe(true);
      vi.setSystemTime(now + 20);
      expect(state.hasUnreadSession('node-1', 'workspace-1', 'session-1')).toBe(false);
    }
  );

  it('reacts to appended and removed entries and authoritative read, refresh and disposal', async () => {
    const f = recoveryFixture([notification('initial')]);
    await f.state.load();
    expect(f.state.hasUnreadSession('node-1', 'workspace-1', 'session-1')).toBe(true);
    f.state.notifications.value.push({
      ...notification('appended', 'session-2'),
      source: 'server'
    });
    expect(f.state.hasUnreadSession('node-1', 'workspace-1', 'session-2')).toBe(true);
    f.state.notifications.value.pop();
    expect(f.state.hasUnreadSession('node-1', 'workspace-1', 'session-2')).toBe(false);
    await f.state.markSessionRead('node-1', 'workspace-1', 'session-1');
    expect(f.state.hasUnreadSession('node-1', 'workspace-1', 'session-1')).toBe(false);
    f.server.entries = [notification('replacement', 'session-2')];
    await f.state.load();
    expect(f.state.hasUnreadSession('node-1', 'workspace-1', 'session-1')).toBe(false);
    expect(f.state.hasUnreadSession('node-1', 'workspace-1', 'session-2')).toBe(true);
    f.state.dispose();
    expect(f.state.hasUnreadSession('node-1', 'workspace-1', 'session-2')).toBe(false);
    expect(f.request.mock.calls.filter(([path]) => path === '/api/notifications')).toHaveLength(3);
  });

  it.each([false, true])(
    'does not rescan unchanged notification records for each visible session: allRead=%s',
    (allRead) => {
      const state = createWorkbenchNotificationService({ value: 'admin' } as never);
      let recordReads = 0;
      state.notifications.value = Array.from({ length: 300 }, (_, index) => ({
        ...notification(`notification-${index}`, `session-${index % 150}`),
        source: 'server' as const,
        get read() {
          recordReads += 1;
          return allRead || index !== 299;
        }
      }));
      expect(state.hasUnreadSession('node-1', 'workspace-1', 'session-149')).toBe(!allRead);
      const initialReads = recordReads;
      for (let round = 0; round < 3; round += 1) {
        for (let index = 0; index < 150; index += 1) {
          expect(state.hasUnreadSession('node-1', 'workspace-1', `session-${index}`)).toBe(
            !allRead && index === 149
          );
        }
      }
      expect(recordReads).toBe(initialReads);
    }
  );
});

describe('expired notification ID cleanup', () => {
  it('reclaims expired IDs while preserving IDs whose server expiry is still in the future', () => {
    const now = 10_000;
    const ids = new Map<string, number>();
    for (let index = 0; index < 1_000; index += 1)
      ids.set(`notification-${index}`, now + (index % 4) - 1);

    sweepExpiredNotificationIds(ids, now);

    expect(ids.size).toBe(500);
    expect(ids.has('notification-0')).toBe(false);
    expect(ids.has('notification-1')).toBe(false);
    expect(ids.has('notification-2')).toBe(true);
    expect(ids.get('notification-2')).toBe(now + 1);
    expect(ids.has('notification-3')).toBe(true);
  });
});

describe('Web Workbench notification state', () => {
  it.each(['workspace', 'hosted'] as const)(
    'reads only the foreground %s target on focus without reconnecting and detaches on disposal',
    async (kind) => {
      const window = Object.assign(new EventTarget(), {
        location: { href: 'https://example.test/console' }
      });
      let focused = false;
      vi.stubGlobal('window', window);
      vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => focused });
      vi.stubGlobal('localStorage', {
        getItem: () => null,
        setItem: vi.fn(),
        removeItem: vi.fn()
      });
      const entry = kind === 'workspace' ? notification : hostedNotification;
      const current = entry('current');
      const f = recoveryFixture([current, entry('other', 'other-target')]);
      f.active.target = current.target as NotificationTarget;
      try {
        await f.state.start();
        f.state.notify({ id: 'update', kind: 'web-update', title: 'Update', message: 'Update' });
        await f.state.recover();
        expect(f.reads()).toHaveLength(0);
        expect(f.state.unreadCount.value).toBe(3);
        focused = true;
        window.dispatchEvent(new Event('focus'));
        await vi.waitFor(() => expect(f.state.unreadCount.value).toBe(2));
        expect(f.reads().map(([path]) => path)).toEqual([
          `/api/notifications/${kind === 'workspace' ? 'session' : 'conversation'}/read`
        ]);
        expect(f.state.notifications.value.find((item) => item.id === 'other')?.read).toBe(false);
        expect(f.state.notifications.value.find((item) => item.id === 'update')?.read).toBe(false);
        f.state.dispose();
        const calls = f.request.mock.calls.length;
        window.dispatchEvent(new Event('focus'));
        await Promise.resolve();
        expect(f.request).toHaveBeenCalledTimes(calls);
      } finally {
        f.state.dispose();
      }
    }
  );

  it.each(['hidden', 'unfocused', 'inactive'] as const)(
    'does not read notifications on a focus event while %s',
    async (state) => {
      const window = Object.assign(new EventTarget(), {
        location: { href: 'https://example.test/console' }
      });
      vi.stubGlobal('window', window);
      vi.stubGlobal('document', {
        visibilityState: state === 'hidden' ? 'hidden' : 'visible',
        hasFocus: () => state !== 'unfocused'
      });
      vi.stubGlobal('localStorage', {
        getItem: () => null,
        setItem: vi.fn(),
        removeItem: vi.fn()
      });
      const f = recoveryFixture([notification('current')]);
      if (state === 'inactive') f.active.target = undefined;
      try {
        await f.state.start();
        window.dispatchEvent(new Event('focus'));
        await f.state.load();
        expect(f.reads()).toHaveLength(0);
        expect(f.state.unreadCount.value).toBe(1);
      } finally {
        f.state.dispose();
      }
    }
  );

  it.each(['workspace', 'hosted'] as const)(
    'reads only a clicked %s notification while navigation invokes selection and recovery',
    async (kind) => {
      const entry = kind === 'workspace' ? notification : hostedNotification;
      const clicked = entry('clicked');
      const f = recoveryFixture([clicked, entry('same-target')], async () => {
        if (kind === 'workspace') f.state.markSessionRead('node-1', 'workspace-1', 'session-1');
        else f.state.markConversationRead('node-1', 'conversation-1');
        await f.state.recover();
      });
      f.active.target = clicked.target as NotificationTarget;
      try {
        await f.state.load();
        await f.state.openNotification({ ...clicked, source: 'server' });
        await f.state.load();
        expect(f.reads().map(([path]) => path)).toEqual(['/api/notifications/clicked/read']);
        expect(f.state.notifications.value.find((item) => item.id === 'same-target')?.read).toBe(
          false
        );
        await f.state.recover();
        expect(f.state.unreadCount.value).toBe(0);
      } finally {
        f.state.dispose();
      }
    }
  );

  it('keeps target-wide reads suppressed until overlapping notification navigations finish', async () => {
    const finish: (() => void)[] = [];
    const entries = [notification('first'), notification('second'), notification('remaining')];
    const f = recoveryFixture(entries, () => new Promise<void>((resolve) => finish.push(resolve)));
    try {
      await f.state.load();
      const first = f.state.openNotification({ ...entries[0]!, source: 'server' });
      await vi.waitFor(() => expect(finish).toHaveLength(1));
      const second = f.state.openNotification({ ...entries[1]!, source: 'server' });
      await vi.waitFor(() => expect(finish).toHaveLength(2));
      finish[0]!();
      await first;
      await f.state.recover();
      expect(f.reads().map(([path]) => path)).toEqual([
        '/api/notifications/first/read',
        '/api/notifications/second/read'
      ]);
      expect(f.state.unreadCount.value).toBe(1);
      finish[1]!();
      await second;
      await f.state.recover();
      expect(f.state.unreadCount.value).toBe(0);
    } finally {
      for (const resolve of finish) resolve();
      f.state.dispose();
    }
  });

  it('releases notification navigation suppression after a failed navigation', async () => {
    const clicked = notification('clicked');
    const f = recoveryFixture([clicked, notification('remaining')], async () => {
      throw new Error('Navigation failed');
    });
    try {
      await f.state.load();
      await expect(f.state.openNotification({ ...clicked, source: 'server' })).rejects.toThrow(
        'Navigation failed'
      );
      await f.state.recover();
      expect(f.state.unreadCount.value).toBe(0);
    } finally {
      f.state.dispose();
    }
  });

  it('recovers only the foreground target from authoritative snapshots without clearing other unread notifications', async () => {
    const f = recoveryFixture([notification('current'), notification('other', 'session-2')]);
    try {
      f.state.notify({
        id: 'local-update',
        kind: 'web-update',
        title: 'Update',
        message: 'Update'
      });
      await f.state.load();
      expect(f.reads()).toHaveLength(0);
      expect(f.state.unreadCount.value).toBe(3);
      await f.state.recover();
      expect(f.reads()).toHaveLength(1);
      expect(f.state.hasUnreadSession('node-1', 'workspace-1', 'session-1')).toBe(false);
      expect(f.state.hasUnreadSession('node-1', 'workspace-1', 'session-2')).toBe(true);
      expect(f.state.unreadCount.value).toBe(2);
      expect(f.onWorkspaceRunCompleted).not.toHaveBeenCalled();
    } finally {
      f.state.dispose();
    }
  });

  it('recovers a failed realtime auto-read even when its notification ID is already deduplicated', async () => {
    const current = notification('failed-current');
    const f = recoveryFixture([current]);
    try {
      f.server.readError = new Error('Temporary read failure');
      f.state.projectServerMessage({ type: 'notification.created', notification: current });
      await vi.waitFor(() => {
        expect(f.reads()).toHaveLength(2);
        expect(f.state.unreadCount.value).toBe(1);
      });
      f.server.readError = undefined;
      await f.state.recover();
      expect(f.reads()).toHaveLength(3);
      expect(f.state.unreadCount.value).toBe(0);
      expect(f.state.notificationRevision.value).toBe(0);
    } finally {
      f.state.dispose();
    }
  });

  it('coalesces concurrent recovery writes and waits for Server confirmation before clearing the badge', async () => {
    const f = recoveryFixture([notification('current')]);
    let release!: () => void;
    f.server.readGate = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    try {
      const first = f.state.recover();
      const second = f.state.recover();
      expect(second).toBe(first);
      await vi.waitFor(() => expect(f.reads()).toHaveLength(1));
      expect(f.state.unreadCount.value).toBe(1);
      release();
      await Promise.all([first, second]);
      expect(f.reads()).toHaveLength(1);
      expect(f.state.unreadCount.value).toBe(0);
    } finally {
      f.state.dispose();
    }
  });

  it('retains a new reconnect request when an older recovery snapshot fails in flight', async () => {
    const f = recoveryFixture([notification('current')]);
    let reject!: (error: Error) => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        })
    );
    try {
      const first = f.state.recover();
      const second = f.state.recover();
      reject(new Error('Previous connection failed'));
      await expect(Promise.all([first, second])).resolves.toBeDefined();
      expect(f.reads()).toHaveLength(1);
      expect(f.state.unreadCount.value).toBe(0);
    } finally {
      f.state.dispose();
    }
  });

  it('bounds failed recovery retries and leaves unread state retryable on the next recovery', async () => {
    const f = recoveryFixture([notification('current')]);
    try {
      f.server.readError = new Error('Read unavailable');
      await f.state.recover();
      expect(f.reads()).toHaveLength(2);
      expect(f.state.unreadCount.value).toBe(1);
      f.server.readError = undefined;
      await f.state.recover();
      expect(f.reads()).toHaveLength(3);
      expect(f.state.unreadCount.value).toBe(0);
    } finally {
      f.state.dispose();
    }
  });

  it('uses the target captured by the latest queued reconnect rather than reading the old target', async () => {
    const f = recoveryFixture([notification('current'), notification('other', 'session-2')]);
    let release!: (value: unknown) => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    try {
      const first = f.state.recover();
      f.active.target = notification('other', 'session-2').target as NotificationTarget;
      const second = f.state.recover();
      release({ notifications: f.server.entries });
      await Promise.all([first, second]);
      expect(f.reads()).toHaveLength(1);
      expect(JSON.parse(String(f.reads()[0]?.[1]?.body))).toEqual({
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-2'
      });
      expect(f.state.hasUnreadSession('node-1', 'workspace-1', 'session-1')).toBe(true);
      expect(f.state.hasUnreadSession('node-1', 'workspace-1', 'session-2')).toBe(false);
    } finally {
      f.state.dispose();
    }
  });

  it.each([
    new ApiError('UNAUTHENTICATED', 'Not signed in'),
    Object.assign(new Error('Context changed'), { name: 'AbortError' })
  ])(
    'does not retry recovery writes after authentication or cancellation failure %s',
    async (failure) => {
      const f = recoveryFixture([notification('current')]);
      f.server.readError = failure;
      try {
        await f.state.recover();
        expect(f.reads()).toHaveLength(1);
        expect(f.state.unreadCount.value).toBe(1);
      } finally {
        f.state.dispose();
      }
    }
  );

  it.each([
    'target-switch',
    'inactive-view',
    'hidden-page',
    'unfocused-page',
    'account-switch',
    'logout'
  ] as const)(
    'does not issue recovery writes after %s while the snapshot is pending',
    async (change) => {
      const f = recoveryFixture([notification('current'), notification('other', 'session-2')]);
      let release!: (value: unknown) => void;
      f.request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      );
      try {
        const recovering = f.state.recover();
        if (change === 'target-switch')
          f.active.target = notification('other', 'session-2').target as NotificationTarget;
        else if (change === 'inactive-view') f.active.target = undefined;
        else if (change === 'hidden-page') vi.stubGlobal('document', { visibilityState: 'hidden' });
        else if (change === 'unfocused-page')
          vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => false });
        else if (change === 'account-switch') f.username.value = 'another-account';
        else f.state.dispose();
        release({ notifications: f.server.entries });
        await recovering;
        expect(f.reads()).toHaveLength(0);
        expect(f.state.unreadCount.value).toBe(change === 'logout' ? 0 : 2);
      } finally {
        f.state.dispose();
      }
    }
  );

  it('does not retry a recovery write when its target changes during the failed write', async () => {
    const f = recoveryFixture([notification('current'), notification('other', 'session-2')]);
    f.server.readGate = async () => {
      f.active.target = notification('other', 'session-2').target as NotificationTarget;
      throw new Error('Target changed');
    };
    try {
      await f.state.recover();
      expect(f.reads()).toHaveLength(1);
      expect(f.state.unreadCount.value).toBe(2);
    } finally {
      f.state.dispose();
    }
  });

  it('recovers the active HostedConversation without reading Workspace notifications', async () => {
    const current = hostedNotification('hosted');
    const f = recoveryFixture([current, notification('workspace')]);
    f.active.target = current.target as NotificationTarget;
    try {
      await f.state.recover();
      expect(f.reads()[0]?.[0]).toBe('/api/notifications/conversation/read');
      expect(f.state.hasUnreadConversation('node-1', 'conversation-1')).toBe(false);
      expect(f.state.hasUnreadSession('node-1', 'workspace-1', 'session-1')).toBe(true);
      expect(f.state.unreadCount.value).toBe(1);
    } finally {
      f.state.dispose();
    }
  });

  it('does not post recovery reads when the active target has no unexpired unread notifications', async () => {
    const f = recoveryFixture([
      { ...notification('expired'), expiresAt: Date.now() - 1 },
      notification('other', 'session-2')
    ]);
    try {
      await f.state.recover();
      expect(f.reads()).toHaveLength(0);
      expect(f.state.unreadCount.value).toBe(1);
    } finally {
      f.state.dispose();
    }
  });

  it('invalidates Workspace files for each new Run notification regardless of selection or read state', async () => {
    const onWorkspaceRunCompleted = vi.fn();
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: vi.fn(async () => ({ notifications: [] })) as never,
      activeTarget: () => ({
        targetType: 'WORKSPACE_SESSION',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1'
      }),
      onWorkspaceRunCompleted
    });
    try {
      const current = notification('current');
      const background = notification('background', 'session-2');
      const read = { ...notification('read', 'session-3'), read: true };
      for (const entry of [current, background, read]) {
        state.projectServerMessage({ type: 'notification.created', notification: entry });
        state.projectServerMessage({ type: 'notification.created', notification: entry });
      }
      expect(onWorkspaceRunCompleted.mock.calls).toEqual([
        ['node-1', 'workspace-1'],
        ['node-1', 'workspace-1'],
        ['node-1', 'workspace-1']
      ]);
      await state.load();
      state.projectServerMessage({ type: 'notification.created', notification: background });
      for (const kind of ['approval', 'plan', 'user-input', 'schedule', 'upload', 'web-update']) {
        state.projectServerMessage({
          type: 'notification.created',
          notification: { ...notification(kind), kind }
        });
      }
      state.projectServerMessage({
        type: 'notification.created',
        notification: hostedNotification('hosted')
      });
      state.projectServerMessage({ type: 'notification.updated', notification: current });
      state.projectServerMessage({ type: 'notification.created', notification: { kind: 'run' } });
      state.projectServerMessage({ type: 'recent-run.updated' });
      expect(onWorkspaceRunCompleted).toHaveBeenCalledTimes(3);
    } finally {
      state.dispose();
    }
  });

  it('formats elapsed runtime compactly', () => {
    expect(elapsedDurationLabel(59_999)).toBe('<1m');
    expect(elapsedDurationLabel(61_000)).toBe('1m');
    expect(elapsedDurationLabel((2 * 60 + 7) * 60_000)).toBe('2h 7m');
    expect(elapsedDurationLabel((3 * 24 + 4) * 60 * 60_000)).toBe('3d 4h');
  });

  it('accumulates elapsed time for active states and uses completion time for terminal states', () => {
    const base = { startedAt: 100, completedAt: null, updatedAt: 300 };
    expect(activeRecentRunStatus('STARTING')).toBe(true);
    expect(activeRecentRunStatus('CANCELLING')).toBe(true);
    expect(recentRunTimeReference({ ...base, status: 'CANCELLING' })).toBe(100);
    expect(recentRunTimeReference({ ...base, status: 'SUCCEEDED', completedAt: 250 })).toBe(250);
  });

  it.each([
    ['STARTING', true],
    ['RUNNING', true],
    ['CANCELLING', true],
    ['SUCCEEDED', false],
    ['FAILED', false],
    ['CANCELLED', false],
    ['INTERRUPTED', false]
  ] as const)(
    'queries Workspace activity from the full recent-task list: %s',
    async (status, active) => {
      const request = vi.fn().mockResolvedValue({
        notifications: [],
        recentRuns: [
          { ...workspaceRun(), nodeId: 'node-2', runId: 'other-node' },
          { ...workspaceRun(), workspaceId: 'workspace-2', runId: 'other-workspace' },
          workspaceRun(status)
        ]
      });
      const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
        request: request as never
      });
      expect(state.hasActiveWorkspaceRun('node-1', 'workspace-1')).toBe(false);
      await state.load();
      expect(state.hasActiveWorkspaceRun('node-1', 'workspace-1')).toBe(active);
      expect(state.hasActiveWorkspaceRun('node-2', 'workspace-1')).toBe(true);
      expect(state.hasActiveWorkspaceRun('node-1', 'workspace-2')).toBe(true);
      expect(state.hasActiveWorkspaceRun('node-2', 'workspace-2')).toBe(false);
    }
  );

  it('queries Workspace unread state without counting expired, local, read, or hosted entries', async () => {
    const state = createWorkbenchNotificationService({ value: 'admin' } as never);
    const target = notification('target').target as Extract<
      NotificationTarget,
      { targetType: 'WORKSPACE_SESSION' }
    >;
    state.notifications.value = [
      { ...notification('read'), source: 'server', read: true },
      { ...notification('expired'), source: 'server', expiresAt: Date.now() },
      {
        id: 'local',
        kind: 'web-update',
        source: 'local',
        title: 'Local',
        message: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expiresAt: Date.now() + 60000,
        read: false
      },
      { ...hostedNotification('hosted'), source: 'server' },
      { ...notification('other-node'), source: 'server', target: { ...target, nodeId: 'node-2' } },
      {
        ...notification('other-workspace'),
        source: 'server',
        target: { ...target, workspaceId: 'workspace-2' }
      }
    ];
    expect(state.hasUnreadWorkspace('node-1', 'workspace-1')).toBe(false);
    expect(state.hasUnreadWorkspace('node-2', 'workspace-1')).toBe(true);
    expect(state.hasUnreadWorkspace('node-1', 'workspace-2')).toBe(true);
    expect(state.hasUnreadWorkspace('node-2', 'workspace-2')).toBe(false);
    state.notifications.value.push({
      ...notification('tail', 'unloaded-session'),
      source: 'server'
    });
    expect(state.hasUnreadWorkspace('node-1', 'workspace-1')).toBe(true);
    expect(state.workspaceTabSession('node-1', 'workspace-1')).toBe('unloaded-session');
    state.notifications.value = state.notifications.value.map((entry) =>
      entry.id === 'tail' ? { ...entry, read: true } : entry
    );
    expect(state.hasUnreadWorkspace('node-1', 'workspace-1')).toBe(false);
  });

  it('chooses unread sessions once each before active tasks in the existing order', async () => {
    const f = recoveryFixture([
      { ...notification('expired'), expiresAt: Date.now() },
      { ...notification('already-read'), read: true },
      hostedNotification('hosted'),
      { ...notification('other-node'), target: { ...notification('n').target!, nodeId: 'node-2' } },
      notification('first', 'unloaded'),
      notification('duplicate', 'unloaded'),
      notification('second', 'second')
    ]);
    f.server.recentRuns = [workspaceRun()];
    await f.state.load();
    expect(f.state.workspaceTabSession('node-1', 'workspace-1')).toBe('unloaded');
    await f.state.markSessionRead('node-1', 'workspace-1', 'unloaded');
    expect(f.state.workspaceTabSession('node-1', 'workspace-1')).toBe('second');
    expect(f.state.hasUnreadWorkspace('node-1', 'workspace-1')).toBe(true);
    await f.state.markSessionRead('node-1', 'workspace-1', 'second');
    expect(f.state.workspaceTabSession('node-1', 'workspace-1')).toBe('session-1');
  });

  it('chooses same-identity active Run sessions and follows authoritative terminal changes', async () => {
    let recentRuns = [
      { ...workspaceRun('SUCCEEDED'), runId: 'terminal', sortAt: 500 },
      { ...workspaceRun(), nodeId: 'node-2', runId: 'other-node', sortAt: 400 },
      { ...workspaceRun(), workspaceId: 'workspace-2', runId: 'other-workspace', sortAt: 300 },
      {
        ...workspaceRun('STARTING'),
        runId: 'first',
        sessionId: 'first-session',
        startedAt: 200,
        sortAt: 200
      },
      {
        ...workspaceRun(),
        runId: 'duplicate',
        sessionId: 'first-session',
        startedAt: 190,
        sortAt: 190
      },
      { ...workspaceRun('CANCELLING'), runId: 'second', sessionId: 'second-session', sortAt: 100 }
    ];
    const request = vi.fn(async () => ({ notifications: [], recentRuns }));
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never
    });
    await state.load();
    expect(state.workspaceTabSession('node-1', 'workspace-1')).toBe('first-session');
    recentRuns = recentRuns.map((run) =>
      run.sessionId === 'first-session' ? { ...run, status: 'SUCCEEDED' as const } : run
    );
    await state.load();
    expect(state.workspaceTabSession('node-1', 'workspace-1')).toBe('second-session');
    recentRuns = [];
    await state.load();
    expect(state.workspaceTabSession('node-1', 'workspace-1')).toBeUndefined();
  });

  it.each(['STARTING', 'RUNNING', 'CANCELLING'] as const)(
    'keeps the last session with a %s Run unless an unread session takes priority',
    async (status) => {
      const f = recoveryFixture([]);
      f.server.recentRuns = [
        { ...workspaceRun(), runId: 'newer', sessionId: 'newer', sortAt: 200 },
        { ...workspaceRun(status), runId: 'last', sessionId: 'last', sortAt: 100 }
      ];
      await f.state.load();
      expect(f.state.workspaceTabSession('node-1', 'workspace-1', 'last')).toBe('last');
      expect(f.state.workspaceTabSession('node-1', 'workspace-1', 'idle')).toBe('newer');
      expect(f.state.workspaceTabSession('node-2', 'workspace-1', 'last')).toBeUndefined();
      expect(f.state.workspaceTabSession('node-1', 'workspace-2', 'last')).toBeUndefined();

      f.server.entries = [notification('unread', 'unread-session')];
      await f.state.load();
      expect(f.state.workspaceTabSession('node-1', 'workspace-1', 'last')).toBe('unread-session');
      await f.state.markSessionRead('node-1', 'workspace-1', 'unread-session');
      expect(f.state.workspaceTabSession('node-1', 'workspace-1', 'last')).toBe('last');

      f.server.recentRuns = f.server.recentRuns.map((run) =>
        run.sessionId === 'last' ? { ...run, status: 'SUCCEEDED' as const } : run
      );
      await f.state.load();
      expect(f.state.workspaceTabSession('node-1', 'workspace-1', 'last')).toBe('newer');
    }
  );

  it('keeps Workspace activity independent of remaining unread sessions through authoritative refreshes', async () => {
    let entries = [notification('first', 'session-1'), notification('second', 'session-2')];
    let runs: RecentRun[] = [
      workspaceRun(),
      { ...workspaceRun(), runId: 'second-run', sessionId: 'session-2' }
    ];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/notifications') return { notifications: entries, recentRuns: runs };
      if (path === '/api/notifications/session/read') {
        const { sessionId } = JSON.parse(String(init?.body)) as { sessionId: string };
        entries = entries.map((entry) =>
          entry.target?.targetType === 'WORKSPACE_SESSION' && entry.target.sessionId === sessionId
            ? { ...entry, read: true }
            : entry
        );
        return {};
      }
      throw new Error('Unexpected notification request');
    });
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never
    });
    await state.load();
    expect(state.hasActiveWorkspaceRun('node-1', 'workspace-1')).toBe(true);
    expect(state.hasUnreadWorkspace('node-1', 'workspace-1')).toBe(true);
    state.markSessionRead('node-1', 'workspace-1', 'session-1');
    await vi.waitFor(() =>
      expect(state.hasUnreadSession('node-1', 'workspace-1', 'session-1')).toBe(false)
    );
    expect(state.hasUnreadWorkspace('node-1', 'workspace-1')).toBe(true);
    state.markSessionRead('node-1', 'workspace-1', 'session-2');
    await vi.waitFor(() => expect(state.hasUnreadWorkspace('node-1', 'workspace-1')).toBe(false));
    expect(state.hasActiveWorkspaceRun('node-1', 'workspace-1')).toBe(true);
    runs = [{ ...workspaceRun('SUCCEEDED'), completedAt: 200 }, runs[1]!];
    state.projectServerMessage({ type: 'recent-run.updated', run: runs[0] });
    await state.load();
    expect(state.hasActiveWorkspaceRun('node-1', 'workspace-1')).toBe(true);
    runs = [];
    state.projectServerMessage({
      type: 'recent-run.removed',
      nodeId: 'node-1',
      runId: 'second-run'
    });
    await state.load();
    expect(state.hasActiveWorkspaceRun('node-1', 'workspace-1')).toBe(false);
    expect(state.hasUnreadWorkspace('node-1', 'workspace-1')).toBe(false);
  });

  it('loads authoritative recent tasks and keeps active tasks ahead of completed tasks on refresh', async () => {
    const run = (runId: string, sortAt: number, status = 'RUNNING') => ({
      nodeId: 'node-1',
      runId,
      workspaceId: 'workspace-1',
      workspaceName: 'Workspace',
      sessionId: `session-${runId}`,
      sessionTitle: `Session ${runId}`,
      userMessage: `Message ${runId}`,
      runner: 'codex',
      status,
      createdAt: sortAt - 10,
      startedAt: sortAt,
      completedAt: null,
      sortAt,
      updatedAt: sortAt,
      version: 1
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        notifications: [],
        recentRuns: [run('older', 100), run('newer', 200)]
      })
      .mockResolvedValueOnce({
        notifications: [],
        recentRuns: [
          { ...run('older', 100, 'SUCCEEDED'), completedAt: 300, updatedAt: 300, version: 2 },
          run('newer', 200)
        ]
      })
      .mockResolvedValueOnce({
        notifications: [],
        recentRuns: [{ ...run('replacement', 300), sessionId: 'session-older' }, run('newer', 200)]
      })
      .mockResolvedValueOnce({
        notifications: [],
        recentRuns: [{ ...run('replacement', 300), sessionId: 'session-older' }]
      });
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never
    });
    await state.load();
    expect(request).toHaveBeenCalledOnce();
    expect(state.recentRuns.value.map((item) => item.runId)).toEqual(['newer', 'older']);
    expect(state.recentRuns.value[0]?.userMessage).toBe('Message newer');

    state.projectServerMessage({
      type: 'recent-run.updated',
      run: { ...run('older', 100, 'SUCCEEDED'), completedAt: 300, updatedAt: 300, version: 2 }
    });
    expect(state.recentRuns.value.map((item) => item.runId)).toEqual(['newer', 'older']);
    await vi.waitFor(() => expect(state.recentRuns.value[1]?.status).toBe('SUCCEEDED'));
    state.projectServerMessage({
      type: 'recent-run.updated',
      run: { ...run('replacement', 300), sessionId: 'session-older' }
    });
    expect(state.recentRuns.value.map((item) => item.runId)).toEqual(['newer', 'older']);
    await vi.waitFor(() =>
      expect(state.recentRuns.value.map((item) => item.runId)).toEqual(['replacement', 'newer'])
    );
    state.projectServerMessage({ type: 'recent-run.removed', nodeId: 'node-1', runId: 'newer' });
    expect(state.recentRuns.value.map((item) => item.runId)).toEqual(['replacement', 'newer']);
    await vi.waitFor(() =>
      expect(state.recentRuns.value.map((item) => item.runId)).toEqual(['replacement'])
    );
    state.dispose();
    expect(state.recentRuns.value).toEqual([]);
  });

  it('orders active tasks first and terminal tasks by completion time with a last-update fallback', async () => {
    const recentRuns = [
      ['completed-early', 'SUCCEEDED', 900, 300, 1000],
      ['running', 'RUNNING', 100, null, 100],
      ['completed-late', 'FAILED', 200, 600, 600],
      ['starting', 'STARTING', 150, null, 150],
      ['cancelling', 'CANCELLING', 50, null, 50],
      ['no-completion', 'INTERRUPTED', 300, null, 500],
      ['cancelled', 'CANCELLED', 800, 400, 400]
    ].map(([runId, status, startedAt, completedAt, updatedAt]) => ({
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: `session-${runId}`,
      sessionTitle: `Session ${runId}`,
      userMessage: '',
      runner: 'codex',
      runId,
      status,
      createdAt: startedAt,
      startedAt,
      sortAt: startedAt,
      completedAt,
      updatedAt,
      version: 1
    }));
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: async <T>() => ({ notifications: [], recentRuns }) as T
    });
    await state.load();
    expect(state.recentRuns.value.map((run) => run.runId)).toEqual([
      'starting',
      'running',
      'cancelling',
      'completed-late',
      'no-completion',
      'cancelled',
      'completed-early'
    ]);
    state.dispose();
  });

  it('refreshes authoritative lists for Server messages and updates the unread badge afterward', async () => {
    const running = {
      nodeId: 'node-1',
      runId: 'run-1',
      workspaceId: 'workspace-1',
      workspaceName: 'Workspace',
      sessionId: 'session-1',
      sessionTitle: 'Session 1',
      userMessage: 'Check status',
      runner: 'codex',
      status: 'RUNNING',
      createdAt: 100,
      startedAt: 110,
      completedAt: null,
      sortAt: 110,
      updatedAt: 110,
      version: 1
    } as const;
    const completed = {
      ...running,
      status: 'SUCCEEDED' as const,
      completedAt: 200,
      updatedAt: 200,
      version: 2
    };
    const created = notification('server-created');
    const request = vi
      .fn()
      .mockResolvedValueOnce({ notifications: [], recentRuns: [running] })
      .mockResolvedValueOnce({ notifications: [created], recentRuns: [running] })
      .mockResolvedValueOnce({ notifications: [created], recentRuns: [completed] });
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never
    });
    await state.load();

    state.projectServerMessage({ type: 'notification.created', notification: created });

    expect(state.notifications.value).toEqual([]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(state.notifications.value.map((item) => item.id)).toEqual(['server-created']);
    expect(state.unreadCount.value).toBe(1);
    expect(state.notificationRevision.value).toBe(1);

    state.projectServerMessage({
      type: 'recent-run.updated',
      run: { ...completed, status: 'FAILED' }
    });
    expect(state.recentRuns.value[0]?.status).toBe('RUNNING');
    await vi.waitFor(() => expect(state.recentRuns.value[0]?.status).toBe('SUCCEEDED'));
    expect(request).toHaveBeenCalledTimes(3);
    state.dispose();
  });

  it('coalesces bursts of invalidations into one in-flight request and one trailing refresh', async () => {
    let resolveFirst!: (value: { notifications: []; recentRuns: [] }) => void;
    let resolveSecond!: (value: { notifications: []; recentRuns: [] }) => void;
    const request = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ notifications: []; recentRuns: [] }>((resolveRequest) => {
            resolveFirst = resolveRequest;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<{ notifications: []; recentRuns: [] }>((resolveRequest) => {
            resolveSecond = resolveRequest;
          })
      );
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never
    });

    const loading = state.load();
    expect(request).toHaveBeenCalledOnce();
    expect(state.projectServerMessage({ type: 'recent-run.invalidated' })).toBe(true);
    expect(state.projectServerMessage({ type: 'notification.read', id: 'notification-1' })).toBe(
      true
    );
    expect(state.projectServerMessage({ type: 'recent-run.removed' })).toBe(true);
    expect(request).toHaveBeenCalledOnce();

    resolveFirst({ notifications: [], recentRuns: [] });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    resolveSecond({ notifications: [], recentRuns: [] });
    await loading;
    expect(state.notifications.value).toEqual([]);
    expect(request).toHaveBeenCalledTimes(2);
    state.dispose();
  });

  it('restores only valid file and application-update notifications from local storage', async () => {
    const now = Date.now();
    const stored = [
      { ...notification('run-1'), createdAt: now - 1_000, expiresAt: now + 1_000 },
      { ...notification('invalid-upload'), kind: 'upload', expiresAt: now + 1_000 },
      {
        ...notification('invalid-update'),
        kind: 'web-update',
        target: undefined,
        action: 'UNKNOWN',
        expiresAt: now + 1_000
      },
      {
        ...notification('upload:1'),
        kind: 'upload' as const,
        target: { nodeId: 'node-1', workspaceId: 'workspace-1' },
        expiresAt: now + 1_000
      },
      {
        ...notification('web-update:0.9.5'),
        kind: 'web-update' as const,
        target: undefined,
        expiresAt: now + 1_000
      }
    ];
    expect(parseStoredWorkbenchNotifications(stored, now).map((item) => item.id)).toEqual([
      'upload:1',
      'web-update:0.9.5'
    ]);
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify(stored),
      setItem: vi.fn(),
      removeItem: vi.fn()
    });
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: vi.fn(async () => ({ notifications: [] })) as never
    });
    await state.start();
    expect(state.notifications.value.map((item) => item.id)).toEqual([
      'upload:1',
      'web-update:0.9.5'
    ]);
    expect(state.notifications.value[0]?.read).toBe(true);
    expect(state.unreadCount.value).toBe(1);
    expect(JSON.parse(String(vi.mocked(localStorage.setItem).mock.calls.at(-1)?.[1]))[0].read).toBe(
      true
    );
    state.dispose();
  });

  it('synchronizes the unread count to the browser application badge', async () => {
    const setAppBadge = vi.fn(async () => undefined);
    const clearAppBadge = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { setAppBadge, clearAppBadge });
    vi.stubGlobal('localStorage', {
      getItem: () => '[]',
      setItem: vi.fn(),
      removeItem: vi.fn()
    });
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: vi.fn(async () => ({ notifications: [] })) as never
    });

    await state.start();
    const initialClears = clearAppBadge.mock.calls.length;
    expect(initialClears).toBeGreaterThan(0);

    state.notify({
      id: 'badge-notification',
      kind: 'web-update',
      title: 'Badge',
      message: 'Unread'
    });
    await vi.waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(1));

    state.markRead('badge-notification');
    await vi.waitFor(() => expect(clearAppBadge).toHaveBeenCalledTimes(initialClears + 1));

    state.dispose();
    await vi.waitFor(() => expect(clearAppBadge).toHaveBeenCalledTimes(initialClears + 2));
  });

  it('reconciles a failed badge clear after an unchanged authoritative refresh', async () => {
    let badge = 1;
    const clearAppBadge = vi
      .fn()
      .mockRejectedValueOnce(new Error('Badge unavailable'))
      .mockImplementation(async () => {
        badge = 0;
      });
    vi.stubGlobal('navigator', { clearAppBadge });
    vi.stubGlobal('localStorage', {
      getItem: () => '[]',
      setItem: vi.fn(),
      removeItem: vi.fn()
    });
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('Notifications unavailable'))
      .mockResolvedValue({ notifications: [] });
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never
    });

    await state.start();
    expect(state.unreadCount.value).toBe(0);
    expect(badge).toBe(1);

    await state.load();
    await vi.waitFor(() => expect(badge).toBe(0));
    expect(clearAppBadge).toHaveBeenCalledTimes(2);
    state.dispose();
  });

  it('applies the latest badge after an earlier write finishes', async () => {
    let finishSetting!: () => void;
    const writes: number[] = [];
    const setAppBadge = vi.fn(
      (count: number) =>
        new Promise<void>((resolveBadge) => {
          finishSetting = () => {
            writes.push(count);
            resolveBadge();
          };
        })
    );
    const clearAppBadge = vi.fn(async () => {
      writes.push(0);
    });
    vi.stubGlobal('navigator', { setAppBadge, clearAppBadge });
    vi.stubGlobal('localStorage', {
      getItem: () => '[]',
      setItem: vi.fn(),
      removeItem: vi.fn()
    });
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: vi.fn(async () => ({ notifications: [] })) as never
    });

    await state.start();
    const initialClears = clearAppBadge.mock.calls.length;
    state.notify({
      id: 'badge-notification',
      kind: 'web-update',
      title: 'Badge',
      message: 'Unread'
    });
    await vi.waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(1));

    state.markRead('badge-notification');
    await vi.waitFor(() => expect(state.unreadCount.value).toBe(0));
    finishSetting();
    await vi.waitFor(() => expect(writes.at(-1)).toBe(0));
    expect(clearAppBadge).toHaveBeenCalledTimes(initialClears + 1);
    state.dispose();
  });

  it('reconciles an unchanged zero badge on focus and detaches on dispose', async () => {
    const window = Object.assign(new EventTarget(), {
      location: { href: 'https://example.test/console' }
    });
    const clearAppBadge = vi.fn(async () => undefined);
    vi.stubGlobal('window', window);
    vi.stubGlobal('navigator', { clearAppBadge });
    vi.stubGlobal('localStorage', {
      getItem: () => '[]',
      setItem: vi.fn(),
      removeItem: vi.fn()
    });
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: vi.fn(async () => ({ notifications: [] })) as never
    });

    await state.start();
    const beforeFocus = clearAppBadge.mock.calls.length;
    window.dispatchEvent(new Event('focus'));
    await state.recover();
    expect(clearAppBadge.mock.calls.length).toBeGreaterThan(beforeFocus);

    const beforeDispose = clearAppBadge.mock.calls.length;
    state.dispose();
    await vi.waitFor(() => expect(clearAppBadge).toHaveBeenCalledTimes(beforeDispose + 1));
    const afterDispose = clearAppBadge.mock.calls.length;
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(clearAppBadge).toHaveBeenCalledTimes(afterDispose);
  });

  it('does not toast or persist notifications loaded from Server', async () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => '[]', setItem, removeItem: vi.fn() });
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: vi.fn(async () => ({ notifications: [notification('server-1')] })) as never
    });
    await state.start();
    expect(state.notifications.value[0]).toEqual(
      expect.objectContaining({ id: 'server-1', source: 'server' })
    );
    expect(state.notificationRevision.value).toBe(0);
    expect(JSON.parse(String(setItem.mock.calls.at(-1)?.[1] ?? '[]'))).toEqual([]);
    state.dispose();
  });

  it('toasts once after authoritative refresh when a create event follows an earlier refresh', async () => {
    const created = notification('loaded-before-event');
    const request = vi.fn(async () => ({ notifications: [created], recentRuns: [] }));
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never
    });

    await state.load();
    expect(state.notificationRevision.value).toBe(0);

    state.projectServerMessage({ type: 'notification.created', notification: created });
    await vi.waitFor(() => expect(state.notificationRevision.value).toBe(1));

    state.projectServerMessage({ type: 'notification.created', notification: created });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(state.notificationRevision.value).toBe(1);
  });

  it('refreshes the authoritative list for an expired create without creation side effects', async () => {
    const expired = { ...notification('expired-create'), expiresAt: Date.now() - 1 };
    const request = vi.fn(async (path: string) => {
      if (path !== '/api/notifications') throw new Error(`unexpected request: ${path}`);
      return { notifications: [expired] };
    });
    const onWorkspaceRunCompleted = vi.fn();
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never,
      onWorkspaceRunCompleted
    });

    expect(
      state.projectServerMessage({ type: 'notification.created', notification: expired })
    ).toBe(true);
    await state.load();

    expect(request).toHaveBeenCalled();
    expect(request.mock.calls.every(([path]) => path === '/api/notifications')).toBe(true);
    expect(onWorkspaceRunCompleted).not.toHaveBeenCalled();
    expect(state.notificationRevision.value).toBe(0);
    expect(request.mock.calls.some(([path]) => path.endsWith('/read'))).toBe(false);
    state.dispose();
  });

  it('does not confirm a pending create when its authoritative refresh returns after expiry', async () => {
    vi.useFakeTimers();
    const now = 1_800_000_000_000;
    vi.setSystemTime(now);
    const created = { ...notification('late-create'), expiresAt: now + 100 };
    let resolveSnapshot!: (value: { notifications: ServerNotification[] }) => void;
    const request = vi.fn(
      () =>
        new Promise<{ notifications: ServerNotification[] }>((resolve) => {
          resolveSnapshot = resolve;
        })
    );
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never
    });

    state.projectServerMessage({ type: 'notification.created', notification: created });
    expect(request).toHaveBeenCalledOnce();
    vi.setSystemTime(now + 101);
    resolveSnapshot({ notifications: [created] });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(state.notificationRevision.value).toBe(0);
    state.dispose();
  });

  it('does not confirm a pending create from an already expired authoritative record', async () => {
    vi.useFakeTimers();
    const now = 1_800_000_000_000;
    vi.setSystemTime(now);
    const created = { ...notification('stale-record'), expiresAt: now + 10_000 };
    const expiredSnapshot = { ...created, expiresAt: now - 1 };
    const request = vi.fn(async () => ({ notifications: [expiredSnapshot] }));
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never
    });

    state.projectServerMessage({ type: 'notification.created', notification: created });
    await state.load();

    expect(state.notificationRevision.value).toBe(0);
    state.dispose();
  });

  it('does not retry an automatic read after the notification expires during the failed request', async () => {
    vi.useFakeTimers();
    const now = 1_800_000_000_000;
    vi.setSystemTime(now);
    const current = { ...notification('expired-read-retry'), expiresAt: now + 100 };
    let rejectRead!: (error: Error) => void;
    let resolveRefresh!: () => void;
    let readRequests = 0;
    const refreshObserved = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    const request = vi.fn((path: string) => {
      if (path === '/api/notifications/expired-read-retry/read') {
        readRequests += 1;
        if (readRequests > 1) return Promise.reject(new Error('Retry should not be necessary'));
        return new Promise((_resolve, reject) => {
          rejectRead = reject;
        });
      }
      if (path === '/api/notifications') {
        resolveRefresh();
        return Promise.resolve({ notifications: [current] });
      }
      throw new Error(`unexpected request: ${path}`);
    });
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never,
      activeTarget: () => ({
        targetType: 'WORKSPACE_SESSION',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1'
      })
    });

    state.projectServerMessage({ type: 'notification.created', notification: current });
    expect(readRequests).toBe(1);
    vi.setSystemTime(now + 101);
    rejectRead(new Error('Temporary read failure'));
    await refreshObserved;

    expect(readRequests).toBe(1);
    expect(state.notificationRevision.value).toBe(0);
    state.dispose();
  });

  it('does not reinstall the sweep timer when start resolves after disposal', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', { getItem: () => '[]', setItem: vi.fn(), removeItem: vi.fn() });
    let resolveFirstRequest!: (value: { notifications: ServerNotification[] }) => void;
    const request = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ notifications: ServerNotification[] }>((resolve) => {
            resolveFirstRequest = resolve;
          })
      )
      .mockResolvedValue({ notifications: [] });
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never
    });

    const staleStart = state.start();
    state.dispose();
    resolveFirstRequest({ notifications: [] });
    await staleStart;

    expect(vi.getTimerCount()).toBe(0);
    await state.start();
    expect(vi.getTimerCount()).toBe(1);
    state.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the hosted-conversation unread state returned by Server without a local override', async () => {
    const request = vi.fn(async () => ({
      notifications: [hostedNotification('hosted-current', 'conversation-current')]
    }));
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never,
      activeTarget: () => ({
        targetType: 'HOSTED_CONVERSATION',
        nodeId: 'node-1',
        conversationId: 'conversation-current'
      })
    });

    await state.load();

    expect(state.notifications.value[0]?.read).toBe(false);
    expect(state.hasUnreadConversation('node-1', 'conversation-current')).toBe(true);
    expect(request).toHaveBeenCalledOnce();
  });

  it('confirms one new-notification toast on a later refresh after the create refresh fails', async () => {
    const created = notification('retry-created');
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary unavailable'))
      .mockResolvedValueOnce({ notifications: [created] });
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never
    });

    state.projectServerMessage({ type: 'notification.created', notification: created });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(state.notificationRevision.value).toBe(0);
    await state.load().catch(() => undefined);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(state.notifications.value.map((item) => item.id)).toEqual(['retry-created']);
    expect(state.notificationRevision.value).toBe(1);
  });

  it('does not overwrite realtime notifications received during a reconnect list request', async () => {
    let resolveRequest!: (value: { notifications: ServerNotification[] }) => void;
    const live = notification('live');
    const offline = notification('offline', 'session-offline');
    const request = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ notifications: ServerNotification[] }>((resolve) => {
            resolveRequest = resolve;
          })
      )
      .mockResolvedValueOnce({ notifications: [offline, live] });
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never
    });
    const loading = state.load();
    state.projectServerMessage({
      type: 'notification.created',
      notification: live
    });
    resolveRequest({ notifications: [] });
    await loading;
    expect(state.notifications.value.map((item) => item.id)).toEqual(['offline', 'live']);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('ignores an in-flight recent-task list after logout disposal', async () => {
    let resolveRequest!: (value: { notifications: []; recentRuns: unknown[] }) => void;
    const request = vi.fn(
      () =>
        new Promise<{ notifications: []; recentRuns: unknown[] }>((resolve) => {
          resolveRequest = resolve;
        })
    );
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never
    });
    const loading = state.load();
    state.dispose();
    resolveRequest({
      notifications: [],
      recentRuns: [
        {
          nodeId: 'node-1',
          runId: 'run-1',
          workspaceId: 'workspace-1',
          sessionId: 'session-1',
          sessionTitle: 'Previous Account Session',
          runner: 'codex',
          status: 'RUNNING',
          createdAt: 100,
          startedAt: 110,
          completedAt: null,
          sortAt: 110,
          updatedAt: 110,
          version: 1
        }
      ]
    });
    await loading;
    expect(state.recentRuns.value).toEqual([]);
  });

  it('toasts realtime notifications once per stable ID and marks the active session read before refresh', async () => {
    const current = notification('current', 'session-current');
    const background = notification('background', 'session-background');
    let serverNotifications: ServerNotification[] = [];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/notifications/current/read' && init?.method === 'POST') {
        serverNotifications = [{ ...current, read: true }];
        return undefined;
      }
      if (path === '/api/notifications')
        return { notifications: serverNotifications, recentRuns: [] };
      throw new Error(`unexpected request: ${path}`);
    });
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never,
      activeTarget: () => ({
        targetType: 'WORKSPACE_SESSION',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-current'
      })
    });
    expect(
      state.projectServerMessage({ type: 'notification.created', notification: current })
    ).toBe(true);
    expect(state.notifications.value).toEqual([]);
    await vi.waitFor(() =>
      expect(state.notifications.value.find((item) => item.id === 'current')?.read).toBe(true)
    );

    serverNotifications = [background, { ...current, read: true }];
    state.projectServerMessage({ type: 'notification.created', notification: background });
    await vi.waitFor(() => expect(state.notificationRevision.value).toBe(1));
    state.projectServerMessage({ type: 'notification.created', notification: background });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    expect(state.notifications.value).toHaveLength(2);
    expect(state.notifications.value.find((item) => item.id === 'current')?.read).toBe(true);
    expect(state.unreadCount.value).toBe(1);
    expect(state.notificationRevision.value).toBe(1);
    expect(request).toHaveBeenCalledWith('/api/notifications/current/read', expect.any(Object));
  });

  it('retries a transient active-session notification read and refreshes the authoritative unread badge', async () => {
    const current = notification('transient-read');
    let serverNotifications: ServerNotification[] = [current];
    let writes = 0;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/notifications/transient-read/read' && init?.method === 'POST') {
        if (++writes === 1) throw new Error('Temporary read failure');
        serverNotifications = [{ ...current, read: true }];
        return undefined;
      }
      if (path === '/api/notifications') return { notifications: serverNotifications };
      throw new Error(`unexpected request: ${path}`);
    });
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never,
      activeTarget: () => ({
        targetType: 'WORKSPACE_SESSION',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1'
      })
    });

    state.projectServerMessage({ type: 'notification.created', notification: current });
    await vi.waitFor(() => expect(state.notifications.value[0]?.read).toBe(true));
    expect(writes).toBe(2);
    expect(state.unreadCount.value).toBe(0);
    expect(state.notificationRevision.value).toBe(0);
  });

  it('keeps a permanently failed auto-read unread without an optimistic badge clear or toast', async () => {
    const current = notification('failed-read');
    const request = vi.fn(async (path: string) => {
      if (path === '/api/notifications/failed-read/read') throw new Error('Read unavailable');
      if (path === '/api/notifications') return { notifications: [current] };
      throw new Error(`unexpected request: ${path}`);
    });
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never,
      activeTarget: () => ({
        targetType: 'WORKSPACE_SESSION',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1'
      })
    });

    state.projectServerMessage({ type: 'notification.created', notification: current });
    await vi.waitFor(() => expect(state.notifications.value[0]?.read).toBe(false));
    await vi.waitFor(() =>
      expect(
        request.mock.calls.filter(([path]) => path === '/api/notifications/failed-read/read')
      ).toHaveLength(2)
    );
    expect(state.unreadCount.value).toBe(1);
    expect(state.notificationRevision.value).toBe(0);
  });

  it.each([
    ['authentication failure', new ApiError('UNAUTHENTICATED', 'Not signed in')],
    [
      'cancelled authentication context',
      Object.assign(new Error('Context changed'), { name: 'AbortError' })
    ]
  ])('does not retry an auto-read after %s', async (_description, failure) => {
    const current = notification('cancelled-read');
    const request = vi.fn(async (path: string) => {
      if (path === '/api/notifications/cancelled-read/read') throw failure;
      if (path === '/api/notifications') return { notifications: [current] };
      throw new Error(`unexpected request: ${path}`);
    });
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never,
      activeTarget: () => ({
        targetType: 'WORKSPACE_SESSION',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1'
      })
    });

    state.projectServerMessage({ type: 'notification.created', notification: current });
    await vi.waitFor(() => expect(state.notifications.value[0]?.read).toBe(false));
    expect(
      request.mock.calls.filter(([path]) => path === '/api/notifications/cancelled-read/read')
    ).toHaveLength(1);
  });

  it.each(['workspace', 'hosted'] as const)(
    'recovers only the selected %s target when returning from another view',
    async (kind) => {
      const entry = kind === 'workspace' ? notification : hostedNotification;
      const current = entry('current');
      const f = recoveryFixture([current, entry('other', 'other-target')]);
      try {
        f.active.target = undefined;
        await f.state.recover();
        expect(f.reads()).toHaveLength(0);
        f.active.target = current.target as NotificationTarget;
        await f.state.recover();
        expect(f.reads().map(([path]) => path)).toEqual([
          `/api/notifications/${kind === 'workspace' ? 'session' : 'conversation'}/read`
        ]);
        expect(f.state.notifications.value.find((item) => item.id === 'current')?.read).toBe(true);
        expect(f.state.notifications.value.find((item) => item.id === 'other')?.read).toBe(false);
        expect(f.state.unreadCount.value).toBe(1);
      } finally {
        f.state.dispose();
      }
    }
  );

  it('silently marks the active hosted conversation read and converges conversation-wide reads from snapshots', async () => {
    const current = hostedNotification('hosted-current', 'conversation-current');
    const background = hostedNotification('hosted-background', 'conversation-background');
    let serverNotifications: ServerNotification[] = [];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/notifications/hosted-current/read' && init?.method === 'POST') {
        serverNotifications = [{ ...current, read: true }];
        return undefined;
      }
      if (path === '/api/notifications/conversation/read' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { conversationId: string };
        serverNotifications = serverNotifications.map((item) =>
          item.target?.targetType === 'HOSTED_CONVERSATION' &&
          item.target.conversationId === body.conversationId
            ? { ...item, read: true }
            : item
        );
        return undefined;
      }
      if (path === '/api/notifications')
        return { notifications: serverNotifications, recentRuns: [] };
      throw new Error(`unexpected request: ${path}`);
    });
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never,
      activeTarget: () => ({
        targetType: 'HOSTED_CONVERSATION',
        nodeId: 'node-1',
        conversationId: 'conversation-current'
      })
    });
    state.projectServerMessage({
      type: 'notification.created',
      notification: current
    });
    await vi.waitFor(() =>
      expect(state.notifications.value.find((item) => item.id === 'hosted-current')?.read).toBe(
        true
      )
    );

    serverNotifications = [{ ...current, read: true }, background];
    state.projectServerMessage({
      type: 'notification.created',
      notification: background
    });
    await vi.waitFor(() =>
      expect(state.hasUnreadConversation('node-1', 'conversation-background')).toBe(true)
    );
    expect(state.hasUnreadConversation('node-1', 'conversation-background')).toBe(true);
    state.markConversationRead('node-1', 'conversation-background');
    expect(state.hasUnreadConversation('node-1', 'conversation-background')).toBe(true);
    await vi.waitFor(() =>
      expect(state.hasUnreadConversation('node-1', 'conversation-background')).toBe(false)
    );
    expect(request).toHaveBeenCalledWith('/api/notifications/conversation/read', {
      method: 'POST',
      body: JSON.stringify({
        nodeId: 'node-1',
        conversationId: 'conversation-background'
      })
    });
    state.markConversationRead('node-1', 'conversation-not-loaded');
    expect(request).toHaveBeenCalledWith('/api/notifications/conversation/read', {
      method: 'POST',
      body: JSON.stringify({
        nodeId: 'node-1',
        conversationId: 'conversation-not-loaded'
      })
    });
  });

  it('still toasts after authoritative refresh when the session remains selected outside Workbench', async () => {
    const created = notification('settings-page');
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: vi.fn(async () => ({ notifications: [created] })) as never,
      activeTarget: () => undefined
    });
    state.projectServerMessage({
      type: 'notification.created',
      notification: created
    });
    await vi.waitFor(() => expect(state.notificationRevision.value).toBe(1));
    expect(state.notifications.value[0]?.read).toBe(false);
    expect(state.notificationRevision.value).toBe(1);
  });

  it('converges Server read, session-read, and delete messages only through list refresh', async () => {
    const one = notification('one');
    const two = notification('two', 'session-2');
    const request = vi
      .fn()
      .mockResolvedValueOnce({ notifications: [one, two] })
      .mockResolvedValueOnce({ notifications: [{ ...one, read: true }, two] })
      .mockResolvedValueOnce({
        notifications: [
          { ...one, read: true },
          { ...two, read: true }
        ]
      })
      .mockResolvedValueOnce({ notifications: [{ ...two, read: true }] });
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never
    });
    await state.load();

    state.projectServerMessage({ type: 'notification.read', id: 'one' });
    expect(state.notifications.value.find((item) => item.id === 'one')?.read).toBe(false);
    await vi.waitFor(() =>
      expect(state.notifications.value.find((item) => item.id === 'one')?.read).toBe(true)
    );
    state.projectServerMessage({
      type: 'notification.session-read',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-2'
    });
    expect(state.notifications.value.find((item) => item.id === 'two')?.read).toBe(false);
    await vi.waitFor(() =>
      expect(state.notifications.value.find((item) => item.id === 'two')?.read).toBe(true)
    );
    expect(state.notifications.value.find((item) => item.id === 'one')?.read).toBe(true);
    state.projectServerMessage({ type: 'notification.deleted', id: 'one' });
    expect(state.notifications.value.map((item) => item.id)).toEqual(['one', 'two']);
    await vi.waitFor(() =>
      expect(state.notifications.value.map((item) => item.id)).toEqual(['two'])
    );
  });

  it('converges individual read and delete writes through Server snapshots', async () => {
    const one = notification('one');
    const two = notification('two', 'session-2');
    let serverNotifications: ServerNotification[] = [one, two];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/notifications/one/read' && init?.method === 'POST') {
        serverNotifications = serverNotifications.map((item) =>
          item.id === 'one' ? { ...item, read: true } : item
        );
        return undefined;
      }
      if (path === '/api/notifications/one' && init?.method === 'DELETE') {
        serverNotifications = serverNotifications.filter((item) => item.id !== 'one');
        return undefined;
      }
      if (path === '/api/notifications')
        return { notifications: serverNotifications, recentRuns: [] };
      throw new Error(`unexpected request: ${path}`);
    });
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never
    });
    await state.load();

    state.markRead('one');
    expect(state.notifications.value.find((item) => item.id === 'one')?.read).toBe(false);
    await vi.waitFor(() =>
      expect(state.notifications.value.find((item) => item.id === 'one')?.read).toBe(true)
    );

    state.remove('one');
    expect(state.notifications.value.map((item) => item.id)).toContain('one');
    await vi.waitFor(() =>
      expect(state.notifications.value.map((item) => item.id)).toEqual(['two'])
    );
  });

  it('always writes mark-all and session-read to Server without optimistic Server-notification updates', async () => {
    const server = notification('server');
    let serverNotifications: ServerNotification[] = [];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/notifications/read-all' && init?.method === 'POST') {
        serverNotifications = serverNotifications.map((item) => ({ ...item, read: true }));
        return undefined;
      }
      if (path === '/api/notifications/session/read' && init?.method === 'POST') return undefined;
      if (path === '/api/notifications')
        return { notifications: serverNotifications, recentRuns: [] };
      throw new Error(`unexpected request: ${path}`);
    });
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never
    });
    state.notify({
      id: 'local',
      title: 'Local',
      message: '',
      kind: 'web-update',
      source: 'local',
      action: 'RELOAD_PAGE'
    });
    state.markAllRead();
    expect(state.notifications.value.every((item) => item.read)).toBe(true);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('/api/notifications/read-all', expect.any(Object))
    );

    serverNotifications = [server];
    await state.load();
    state.markAllRead();
    expect(state.notifications.value.find((item) => item.id === 'server')?.read).toBe(false);
    await vi.waitFor(() =>
      expect(state.notifications.value.find((item) => item.id === 'server')?.read).toBe(true)
    );

    state.markSessionRead('node-1', 'workspace-1', 'session-not-loaded');
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('/api/notifications/session/read', {
        method: 'POST',
        body: JSON.stringify({
          nodeId: 'node-1',
          workspaceId: 'workspace-1',
          sessionId: 'session-not-loaded'
        })
      })
    );
  });

  it('keeps file notifications on the browser-local path', () => {
    const state = createWorkbenchNotificationService({ value: 'admin' } as never);
    const task = {
      id: 'upload-1',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      directory: '.',
      name: 'log.txt',
      size: 10,
      overwrite: false,
      receivedBytes: 3,
      status: 'UPLOADING' as const,
      cancelled: false
    };
    state.recordUpload(task);
    expect(state.notifications.value[0]).toEqual(
      expect.objectContaining({ id: 'upload:upload-1', source: 'local', read: true })
    );
    expect(state.unreadCount.value).toBe(0);
    expect(state.notificationRevision.value).toBe(1);
    state.recordUpload({ ...task, status: 'COMPLETED' });
    expect(state.notifications.value[0]?.read).toBe(true);
    expect(state.unreadCount.value).toBe(0);
    expect(state.notificationRevision.value).toBe(1);
    state.recordUpload({ ...task, status: 'FAILED' });
    expect(state.notifications.value[0]?.read).toBe(true);
    expect(state.notificationRevision.value).toBe(1);
    state.recordUpload({ ...task, status: 'CANCELLED' });
    expect(state.notifications.value).toEqual([]);
  });

  it('suppresses duplicate Web-version notifications for 24 hours and notifies again after expiration', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T00:00:00.000Z'));
    const state = createWorkbenchNotificationService({ value: 'admin' } as never);
    const input = {
      id: 'web-update:0.9.5',
      kind: 'web-update' as const,
      source: 'local' as const,
      title: 'Application version updated',
      message: 'Reload the application from this notification.',
      action: 'RELOAD_PAGE' as const
    };

    state.notify(input);
    state.markRead(input.id);
    state.notify(input);
    expect(state.notificationRevision.value).toBe(1);
    expect(state.notifications.value).toHaveLength(1);

    vi.advanceTimersByTime(24 * 60 * 60_000 + 1);
    state.notify(input);
    expect(state.notificationRevision.value).toBe(2);
    expect(state.notifications.value).toHaveLength(1);
    expect(state.notifications.value[0]?.read).toBe(false);
  });

  it('keeps only the latest Web-version notification and clears it when versions match', () => {
    const state = createWorkbenchNotificationService({ value: 'admin' } as never);
    const input = {
      kind: 'web-update' as const,
      source: 'local' as const,
      title: 'Application version updated',
      message: 'Reload the application from this notification.',
      action: 'RELOAD_PAGE' as const
    };

    state.notify({ ...input, id: 'web-update:0.9.5' });
    state.notify({ ...input, id: 'web-update:0.9.6' });
    expect(state.notifications.value.map((item) => item.id)).toEqual(['web-update:0.9.6']);

    state.clearWebUpdate();
    expect(state.notifications.value).toEqual([]);
  });
});
