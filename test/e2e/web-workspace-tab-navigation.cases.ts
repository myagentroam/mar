import { expect, test } from '@playwright/test';
import {
  fulfillMockSessionWatch,
  mockConsoleApi,
  mockEmptyWorkspaceFiles,
  json
} from './support/web-console-api.js';

for (const locale of ['zh-CN', 'en-US'] as const) {
  test(
    'Workspace Tab clicks choose unread then active then last session without background navigation: ' +
      locale,
    async ({ page }) => {
      test.setTimeout(60_000);
      const english = locale === 'en-US';
      await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
      await page.addInitScript((value) => localStorage.setItem('mar.locale.v2', value), locale);
      await mockEmptyWorkspaceFiles(
        page,
        Array.from({ length: 7 }, (_, i) => 'workspace-' + (i + 2))
      );
      await page.route('**/api/workspaces?nodeId=node-1', (route) =>
        json(route, {
          workspaces: Array.from({ length: 8 }, (_, index) => index + 1).map((i) => ({
            id: 'workspace-' + i,
            path: '/project-' + i,
            kind: 'DIRECTORY'
          }))
        })
      );
      const session = (id: string) => ({
        id,
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'native-' + id,
        customTitle: 'Priority ' + id,
        activity: 'IDLE',
        nativeControl: 'EXTERNAL',
        control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
      });
      await page.route('**/api/agent-sessions?*', (route) =>
        json(route, {
          sessions:
            new URL(route.request().url()).searchParams.get('workspaceId') === 'workspace-1'
              ? [session('session-1')]
              : [],
          nextCursor: null
        })
      );
      let failIdentity = false;
      let failRead = false;
      const identityReads: string[] = [];
      await page.route('**/api/agent-sessions/*?nodeId=node-1', (route) => {
        const id = new URL(route.request().url()).pathname.split('/').pop()!;
        identityReads.push(id);
        if (failIdentity)
          return route.fulfill({
            status: 403,
            contentType: 'application/json',
            body: JSON.stringify({ code: 'FORBIDDEN', message: 'Session access denied' })
          });
        return json(route, { session: session(id) });
      });
      await page.route('**/api/agent-sessions/*/watch*', (route) => {
        const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
        return fulfillMockSessionWatch(page, route, session(id), {
          kind: 'session-watch-snapshot',
          sequence: 1,
          session: session(id),
          runs: [],
          queue: { version: 0, paused: false, items: [] },
          context: null,
          conversation: {
            unit: 'SEGMENT',
            source: 'official',
            readAt: 1,
            latestVisibleAt: 1,
            nextCursor: null,
            snapshotSequence: 1,
            segments: []
          }
        });
      });
      const now = Date.now();
      const entry = (id: string, sessionId: string) => ({
        id,
        kind: 'run',
        title: 'Task complete',
        message: 'Open the session',
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 3_600_000,
        read: false,
        target: {
          targetType: 'WORKSPACE_SESSION',
          nodeId: 'node-1',
          workspaceId: 'workspace-1',
          sessionId
        }
      });
      const run = (id: string, status: string, startedAt: number) => ({
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        runId: id,
        sessionId: id,
        sessionTitle: id,
        runner: 'codex',
        status,
        createdAt: startedAt,
        startedAt,
        sortAt: startedAt,
        updatedAt: startedAt,
        completedAt: null,
        version: 1
      });
      let notifications: ReturnType<typeof entry>[] = [];
      let recentRuns: ReturnType<typeof run>[] = [];
      const reads: string[] = [];
      const controls: string[] = [];
      page.on('request', (request) => {
        if (
          request.method() === 'POST' &&
          ['messages', 'cancel', 'stop', 'resume'].includes(
            new URL(request.url()).pathname.split('/').pop()!
          )
        )
          controls.push(request.url());
      });
      await page.route('**/api/notifications', (route) =>
        json(route, { notifications, recentRuns })
      );
      await page.route('**/api/notifications/session/read', (route) => {
        const target = route.request().postDataJSON() as {
          nodeId: string;
          workspaceId: string;
          sessionId: string;
        };
        reads.push(target.sessionId);
        if (failRead)
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ code: 'UNAVAILABLE', message: 'Read temporarily unavailable' })
          });
        notifications = notifications.map((value) =>
          value.target.nodeId === target.nodeId &&
          value.target.workspaceId === target.workspaceId &&
          value.target.sessionId === target.sessionId
            ? { ...value, read: true }
            : value
        );
        return json(route, {});
      });
      const refresh = async () => {
        const response = page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/api/notifications'
        );
        await page.evaluate(() => {
          const socket = (
            window as unknown as {
              __consoleMockWorkbenchWebSocket: {
                instances: { url: string; readyState: number; dispatchEvent(event: Event): void }[];
              };
            }
          ).__consoleMockWorkbenchWebSocket.instances.find(
            (value) => value.url.includes('/api/workbench/live') && value.readyState === 1
          )!;
          socket.dispatchEvent(
            new MessageEvent('message', { data: JSON.stringify({ type: 'recent-run.updated' }) })
          );
        });
        await response;
      };
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto('/console');
      await page.getByRole('button', { name: english ? 'Open console' : '进入控制台' }).click();
      await page.getByRole('button', { name: english ? 'Work' : '工作', exact: true }).click();
      const tree = page.locator('.workspace-tree');
      await tree.getByRole('button', { name: /node-1/ }).click();
      await tree.getByRole('button', { name: 'project-1', exact: true }).click();
      await page.locator('.session-list button').first().click();
      const header = page.locator('.conversation-header');
      await expect(header).toContainText('Priority session-1');
      await tree.getByRole('button', { name: 'project-2', exact: true }).click();
      const first = page.locator('.workspace-tab[data-tab-id="node-1:workspace-1"]');
      const second = page.locator('.workspace-tab[data-tab-id="node-1:workspace-2"]');
      notifications = [
        entry('one', 'outside-1'),
        entry('duplicate', 'outside-1'),
        entry('two', 'outside-2'),
        entry('cached', 'session-1')
      ];
      recentRuns = [
        run('active-first', 'STARTING', now + 2),
        run('active-second', 'CANCELLING', now + 1),
        run('terminal', 'SUCCEEDED', now + 3)
      ];
      await refresh();
      await expect(first.locator('.workspace-tab-unread')).toBeVisible();
      await expect(second.getByRole('tab')).toHaveAttribute('aria-selected', 'true');
      reads.length = 0;
      await first.getByRole('tab').click();
      await expect(header).toContainText('Priority outside-1');
      await expect.poll(() => notifications[0]?.read).toBe(true);
      expect(reads).toEqual(['outside-1']);
      expect(notifications[1]?.read).toBe(true);
      expect(notifications[2]?.read).toBe(false);
      expect(notifications[3]?.read).toBe(false);
      await expect(first.locator('.workspace-tab-unread')).toBeVisible();
      await first.getByRole('tab').click();
      await expect(header).toContainText('Priority outside-2');
      await expect.poll(() => notifications[2]?.read).toBe(true);
      await first.getByRole('tab').click();
      await expect(header).toContainText('Priority session-1');
      await expect(first.locator('.workspace-tab-unread')).toHaveCount(0);
      await first.getByRole('tab').click();
      await expect(header).toContainText('Priority active-first');
      const opened = identityReads.length;
      await first.getByRole('tab').click();
      expect(identityReads).toHaveLength(opened);
      recentRuns = [
        run('active-first', 'SUCCEEDED', now + 2),
        run('active-second', 'RUNNING', now + 1)
      ];
      await refresh();
      await expect(header).toContainText('Priority active-first');
      await first.getByRole('tab').click();
      await expect(header).toContainText('Priority active-second');
      recentRuns = [
        run('active-first', 'RUNNING', now + 3),
        run('active-second', 'RUNNING', now + 1)
      ];
      await refresh();
      const retained = identityReads.length;
      await first.getByRole('tab').click();
      await expect(header).toContainText('Priority active-second');
      expect(identityReads).toHaveLength(retained);
      await second.getByRole('tab').click();
      await first.getByRole('tab').click();
      await expect(header).toContainText('Priority active-second');
      recentRuns = [];
      await refresh();
      await expect(first.locator('.workspace-tab-running')).toHaveCount(0);
      await second.getByRole('tab').click();
      await first.getByRole('tab').click();
      await expect(header).toContainText('Priority active-second');
      await second.getByRole('tab').click();
      notifications = [entry('failed', 'outside-1')];
      failIdentity = true;
      await refresh();
      await expect(first.locator('.workspace-tab-unread')).toBeVisible();
      const beforeFailure = reads.length;
      await first.getByRole('tab').click();
      await expect(page.locator('.conversation-reload')).toBeVisible();
      expect(reads).toHaveLength(beforeFailure);
      expect(notifications[0]?.read).toBe(false);
      await expect(first.locator('.workspace-tab-unread')).toBeVisible();
      failIdentity = false;
      failRead = true;
      await first.getByRole('tab').click();
      await expect(header).toContainText('Priority outside-1');
      await expect.poll(() => reads.length).toBeGreaterThan(beforeFailure);
      await expect(first.locator('.workspace-tab-unread')).toBeVisible();
      expect(notifications[0]?.read).toBe(false);
      failRead = false;
      await first.getByRole('tab').click();
      await expect(first.locator('.workspace-tab-unread')).toHaveCount(0);
      await tree.getByRole('button', { name: 'project-3', exact: true }).click();
      for (let i = 4; i <= 8; i += 1)
        await tree.getByRole('button', { name: 'project-' + i, exact: true }).click();
      notifications = [entry('menu', 'outside-2')];
      await refresh();
      await expect(first.locator('.workspace-tab-unread')).toBeVisible();
      await page.setViewportSize({ width: 1024, height: 900 });
      await page
        .getByRole('button', {
          name: english ? 'All open workspaces' : '全部已打开工作区',
          exact: true
        })
        .click();
      await page
        .locator('.workspace-tab-menu-list .el-dropdown-menu__item')
        .filter({ hasText: 'project-1' })
        .click();
      await expect(header).toContainText('Priority outside-2');
      await expect(first.locator('.workspace-tab-unread')).toHaveCount(0);
      notifications = [entry('mobile', 'outside-1')];
      await refresh();
      await expect(first.locator('.workspace-tab-unread')).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      await first.getByRole('tab').click();
      await expect(header).toContainText('Priority outside-1');
      await expect(first.locator('.workspace-tab-unread')).toHaveCount(0);
      expect(controls).toEqual([]);
      await page.screenshot({ path: test.info().outputPath('tab-priority-' + locale + '.png') });
    }
  );
}

for (const locale of ['zh-CN', 'en-US'] as const) {
  test(
    'Workspace Tab preserves unread until history opens across the live connection ID gap: ' +
      locale,
    async ({ page }) => {
      const english = locale === 'en-US';
      await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
      await page.addInitScript((value) => {
        localStorage.setItem('mar.locale.v2', value);
        const gap = {
          hold: true,
          ready: undefined as undefined | { socket: EventTarget; event: Event }
        };
        Object.assign(window, { __workspaceTabLiveGap: gap });
        const dispatch = EventTarget.prototype.dispatchEvent;
        EventTarget.prototype.dispatchEvent = function (event: Event): boolean {
          if (event instanceof MessageEvent && typeof event.data === 'string') {
            const message = JSON.parse(event.data) as { type?: string };
            if (gap.hold && message.type === 'workbench.ready') {
              gap.ready = { socket: this, event };
              return true;
            }
          }
          return dispatch.call(this, event);
        };
      }, locale);
      await page.route('**/api/workspaces?nodeId=node-1', (route) =>
        json(route, { workspaces: [{ id: 'workspace-1', path: '/project', kind: 'DIRECTORY' }] })
      );
      const now = Date.now();
      let read = false;
      const readPosts: string[] = [];
      const session = {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'gap-session',
        activity: 'IDLE',
        control: { level: 'MANAGED', capabilities: ['history.read'] }
      };
      await page.route('**/api/notifications', (route) =>
        json(route, {
          notifications: [
            {
              id: 'gap-unread',
              kind: 'run',
              title: 'Completed',
              message: 'Open session',
              createdAt: now,
              updatedAt: now,
              expiresAt: now + 60_000,
              read,
              target: {
                targetType: 'WORKSPACE_SESSION',
                nodeId: 'node-1',
                workspaceId: 'workspace-1',
                sessionId: 'session-1'
              }
            }
          ],
          recentRuns: []
        })
      );
      await page.route('**/api/notifications/session/read', (route) => {
        readPosts.push((route.request().postDataJSON() as { sessionId: string }).sessionId);
        read = true;
        return json(route, {});
      });
      let release!: () => void;
      const snapshotGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let watchPosts = 0;
      await page.route('**/api/agent-sessions/session-1/watch*', async (route) => {
        if (route.request().method() === 'DELETE') return json(route, {});
        watchPosts += 1;
        await snapshotGate;
        return fulfillMockSessionWatch(page, route, session, {
          kind: 'session-watch-snapshot',
          sequence: 1,
          session,
          runs: [],
          queue: { version: 0, paused: false, items: [] },
          context: null,
          conversation: {
            unit: 'SEGMENT',
            source: 'official',
            readAt: 1,
            latestVisibleAt: 1,
            nextCursor: null,
            snapshotSequence: 1,
            segments: [
              {
                id: 'gap-turn:segment:0',
                sessionId: 'session-1',
                turnId: 'gap-turn',
                runId: null,
                index: 0,
                status: 'SUCCEEDED',
                startedAt: 1,
                completedAt: 1,
                items: [
                  {
                    id: 'gap-item',
                    sessionId: 'session-1',
                    turnId: 'gap-turn',
                    runId: null,
                    parentItemId: null,
                    sourceSequence: null,
                    revision: 1,
                    kind: 'assistant_message',
                    status: 'COMPLETED',
                    startedAt: 1,
                    completedAt: 1,
                    payload: { text: 'Gap recovery history', format: 'markdown', model: null }
                  }
                ]
              }
            ]
          }
        });
      });
      try {
        await page.goto('/console');
        await page.getByRole('button', { name: english ? 'Open console' : '进入控制台' }).click();
        await page.getByRole('button', { name: english ? 'Work' : '工作', exact: true }).click();
        const tree = page.locator('.workspace-tree');
        await tree.getByRole('button', { name: /node-1/ }).click();
        await tree.getByRole('button', { name: 'project', exact: true }).click();
        const tab = page.locator('.workspace-tab[data-tab-id="node-1:workspace-1"]');
        await expect(tab.locator('.workspace-tab-unread')).toBeVisible();
        await tab.getByRole('tab').click();
        await expect(page.locator('.conversation-reload')).toBeVisible();
        expect(watchPosts).toBe(0);
        expect(readPosts).toEqual([]);
        await expect(page.getByText('Gap recovery history', { exact: true })).toHaveCount(0);
        await page.locator('.el-message__closeBtn').click();
        await expect(page.locator('.el-message')).toHaveCount(0);
        await tab.getByRole('tab').click();
        await expect(page.locator('.conversation-reload')).toBeVisible();
        expect(watchPosts).toBe(0);
        expect(readPosts).toEqual([]);
        await expect(tab.locator('.workspace-tab-unread')).toBeVisible();
        await page.locator('.el-message__closeBtn').click();
        await expect(page.locator('.el-message')).toHaveCount(0);
        await page.evaluate(() => {
          const gap = (
            window as unknown as {
              __workspaceTabLiveGap: {
                hold: boolean;
                ready: { socket: EventTarget; event: Event };
              };
            }
          ).__workspaceTabLiveGap;
          gap.hold = false;
          gap.ready.socket.dispatchEvent(gap.ready.event);
        });
        await expect.poll(() => watchPosts).toBe(1);
        expect(readPosts).toEqual([]);
        await expect(tab.locator('.workspace-tab-unread')).toBeVisible();
        release();
        await expect(page.getByText('Gap recovery history', { exact: true })).toBeVisible();
        await expect(page.locator('.conversation-loading-initial')).toHaveCount(0);
        expect(readPosts).toEqual([]);
        await tab.getByRole('tab').click();
        await expect(tab.locator('.workspace-tab-unread')).toHaveCount(0);
        expect(readPosts).toEqual(['session-1']);
        expect(watchPosts).toBe(1);
        await page.screenshot({ path: test.info().outputPath('live-gap-' + locale + '.png') });
      } finally {
        release();
      }
    }
  );
}
