import { expect, test } from '@playwright/test';
import {
  emitMockSessionEvent,
  emitMockWorkspaceSnapshot,
  fulfillMockWorkspaceWatch,
  mockConsoleApi,
  json,
  write
} from './support/web-console-api.js';

// Git Changes watch, run transition, and diff interactions

for (const language of [
  {
    locale: 'zh-CN',
    login: '进入控制台',
    work: '工作',
    changes: 'Git 变更',
    refresh: '刷新 Git 变更',
    incoming: '待拉取 3 个提交，待推送 2 个提交'
  },
  {
    locale: 'en-US',
    login: 'Open console',
    work: 'Work',
    changes: 'Git Changes',
    refresh: 'Refresh Git changes',
    incoming: '3 incoming commits, 2 outgoing commits'
  }
]) {
  test(`Git Changes upstream counts and two-row headings: ${language.locale}`, async ({
    page
  }, testInfo) => {
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    await page.addInitScript(
      (locale) => localStorage.setItem('mar.locale.v2', locale),
      language.locale
    );
    let tracking: unknown = { upstream: 'origin/feature/long-branch-name', ahead: 2, behind: 3 };
    let repositoryStatus = 'CLEAN';
    let changesReads = 0;
    const summary = () => ({
      branch: 'feature/long-branch-name',
      changes: [],
      repositories: [
        {
          repositoryPath: '',
          repositoryName: 'a-long-project-directory',
          source: 'ROOT',
          current: true,
          branch: 'feature/long-branch-name',
          status: repositoryStatus,
          tracking,
          changes: []
        },
        {
          repositoryPath: 'child',
          repositoryName: 'child',
          source: 'SUBMODULE',
          branch: 'main',
          status: 'CLEAN',
          tracking: { upstream: 'origin/main', ahead: 4, behind: 0 },
          changes: []
        },
        {
          repositoryPath: '',
          repositoryName: 'linked',
          source: 'WORKTREE',
          worktreePath: '/tmp/linked',
          physicalPath: '/tmp/linked',
          branch: 'review',
          status: 'CLEAN',
          tracking: { upstream: 'origin/review', ahead: 0, behind: 5 },
          changes: []
        }
      ]
    });
    await page.unroute(/\/api\/workspaces\/workspace-1\/changes(?:\?.*)?$/);
    await page.route(/\/api\/workspaces\/workspace-1\/changes(?:\?.*)?$/, (route) => {
      changesReads += 1;
      return json(route, summary());
    });
    await page.route(/\/api\/workspaces\/workspace-1\/watch$/, (route) =>
      fulfillMockWorkspaceWatch(
        page,
        route,
        { id: 'session-1', workspaceId: 'workspace-1' },
        'GIT_WORKSPACE',
        undefined,
        summary()
      )
    );
    await page.goto('/console');
    await page.getByRole('button', { name: language.login, exact: true }).click();
    await page.getByRole('button', { name: language.work, exact: true }).click();
    await page
      .locator('.workspace-tree')
      .getByRole('button', { name: /node-1/ })
      .click();
    await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
    await page.getByRole('tab', { name: language.changes, exact: true }).click();
    const heading = page.locator('.change-repository-heading').first();
    const sync = heading.locator('.repository-sync-tag');
    await expect(sync).toHaveText('↓ 3 ↑ 2');
    await expect(sync).toHaveAttribute('title', new RegExp(language.incoming));
    await expect(sync).toHaveAttribute('aria-label', new RegExp(language.incoming));
    await expect(page.locator('.repository-sync-tag')).toHaveText([
      '↓ 3 ↑ 2',
      '↓ 0 ↑ 4',
      '↓ 5 ↑ 0'
    ]);
    const refresh = heading.getByRole('button', { name: language.refresh, exact: true });
    const refreshChanges = async () => {
      const previousReads = changesReads;
      await refresh.click();
      await expect.poll(() => changesReads).toBeGreaterThan(previousReads);
      await expect(refresh).toBeEnabled();
    };
    const inspector = page.locator('.workspace-inspector');
    await inspector.evaluate((element) =>
      Object.assign((element as HTMLElement).style, {
        width: '260px',
        minWidth: '0',
        maxWidth: '260px'
      })
    );
    const boxes = await Promise.all([
      heading.locator('strong').boundingBox(),
      heading.locator('.repository-branch').boundingBox(),
      refresh.boundingBox(),
      heading.locator('.repository-tags-row').boundingBox(),
      inspector.boundingBox()
    ]);
    const [title, branch, button, tags, panel] = boxes;
    expect(title && branch && button && tags && panel).toBeTruthy();
    expect(Math.abs(title!.y + title!.height / 2 - branch!.y - branch!.height / 2)).toBeLessThan(2);
    expect(Math.abs(title!.y + title!.height / 2 - button!.y - button!.height / 2)).toBeLessThan(2);
    expect(tags!.y).toBeGreaterThanOrEqual(button!.y + button!.height);
    expect(button!.x + button!.width).toBeLessThanOrEqual(panel!.x + panel!.width);
    for (const tag of await heading.locator('.repository-tags-row .el-tag').all()) {
      await expect(tag).not.toHaveClass(/el-zoom-in-center-enter-active/);
    }
    await heading.scrollIntoViewIfNeeded();
    await expect(heading.locator('.repository-title-row')).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`git-counts-${language.locale}.png`),
      clip: (await inspector.boundingBox())!,
      animations: 'disabled'
    });
    for (const value of [
      undefined,
      { upstream: 'origin/main', ahead: 0, behind: 0 },
      { upstream: 'origin/main', ahead: -1, behind: 2 }
    ]) {
      tracking = value;
      await refreshChanges();
      await expect(sync).toHaveCount(0);
    }
    tracking = { upstream: 'origin/main', ahead: 7, behind: 0 };
    repositoryStatus = 'UNAVAILABLE';
    await refreshChanges();
    await expect(sync).toHaveCount(0);
    repositoryStatus = 'CLEAN';
    await refreshChanges();
    await expect(sync).toHaveText('↓ 0 ↑ 7');
  });
}

test('Files Watch snapshots cannot overwrite manually refreshed Git Changes', async ({ page }) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.unroute(/\/api\/workspaces\/workspace-1\/changes(?:\?.*)?$/);
  let changesReads = 0;
  await page.route(/\/api\/workspaces\/workspace-1\/watch$/, async (route) =>
    fulfillMockWorkspaceWatch(
      page,
      route,
      { id: 'session-1', workspaceId: 'workspace-1' },
      'GIT_WORKSPACE',
      undefined,
      {
        branch: 'stale/branch',
        changes: [
          {
            path: 'stale.txt',
            state: 'UNTRACKED',
            change: 'ADDED',
            diffAvailable: false
          }
        ]
      }
    )
  );
  await page.route(/\/api\/workspaces\/workspace-1\/changes(?:\?.*)?$/, (route) => {
    changesReads += 1;
    const fresh = changesReads >= 2;
    return json(route, {
      branch: fresh ? 'fresh/branch' : 'stale/branch',
      changes: [
        {
          path: fresh ? 'fresh.txt' : 'stale.txt',
          state: 'UNTRACKED',
          change: 'ADDED',
          diffAvailable: false
        }
      ],
      repositories: [
        {
          repositoryPath: '',
          repositoryName: '根仓库',
          source: 'ROOT',
          branch: fresh ? 'fresh/branch' : 'stale/branch',
          changes: [
            {
              path: fresh ? 'fresh.txt' : 'stale.txt',
              state: 'UNTRACKED',
              change: 'ADDED',
              diffAvailable: false
            }
          ]
        }
      ]
    });
  });

  await page.goto('/console');
  await page.getByLabel('密码').fill('test-password');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.getByRole('tab', { name: 'Git 变更' }).click();

  await expect(page.getByText('stale.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '刷新 Git 变更', exact: true }).click();
  await expect(page.getByText('fresh.txt', { exact: true })).toBeVisible();
  await expect(page.getByText('stale.txt', { exact: true })).toHaveCount(0);

  await emitMockWorkspaceSnapshot(page, 'files', {
    files: {
      entries: [{ path: 'README.md', name: 'README.md', kind: 'FILE', size: 12, modifiedAt: 2 }],
      nextCursor: null,
      truncated: false
    }
  });

  await expect(page.getByText('fresh.txt', { exact: true })).toBeVisible();
  await expect(page.getByText('stale.txt', { exact: true })).toHaveCount(0);
  await expect(page.locator('.current-changes .current-branch')).toHaveText('fresh/branch');
});

test('Realtime idle updates only session state without refreshing Git Changes', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.unroute(/\/api\/workspaces\/workspace-1\/changes(?:\?.*)?$/);
  let changesReads = 0;
  await page.route(/\/api\/workspaces\/workspace-1\/changes(?:\?.*)?$/, (route) => {
    changesReads += 1;
    return json(route, {
      branch: 'feature/session-refresh',
      changes: [
        {
          path: `after-run-${changesReads}.txt`,
          state: 'UNTRACKED',
          change: 'ADDED',
          diffAvailable: false
        }
      ],
      repositories: [
        {
          repositoryPath: '',
          repositoryName: '根仓库',
          source: 'ROOT',
          branch: 'feature/session-refresh',
          changes: [
            {
              path: `after-run-${changesReads}.txt`,
              state: 'UNTRACKED',
              change: 'ADDED',
              diffAvailable: false
            }
          ]
        }
      ]
    });
  });

  await page.goto('/console');
  await page.getByLabel('密码').fill('test-password');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list button').first().click();
  await page.getByRole('tab', { name: 'Git 变更' }).click();
  await expect.poll(() => changesReads).toBeGreaterThan(0);
  const changesReadsBeforeIdle = changesReads;

  await emitMockSessionEvent(page, 'session', {
    session: {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex',
      externalSessionId: 'vscode-thread-1',
      activity: 'MANAGED_ACTIVE',
      control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
    }
  });
  await expect(page.locator('.session-activity.managed_active').first()).toBeVisible();
  await emitMockSessionEvent(page, 'session', {
    session: {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex',
      externalSessionId: 'vscode-thread-1',
      activity: 'IDLE',
      control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
    }
  });

  await expect(page.locator('.session-activity.managed_active')).toHaveCount(0);
  await expect(
    page.getByText(`after-run-${changesReadsBeforeIdle}.txt`, { exact: true })
  ).toBeVisible();
  expect(changesReads).toBe(changesReadsBeforeIdle);
});

for (const section of ['changes', 'files'] as const) {
  for (const selectSession of [true, false]) {
    test(`Completion notifications from any Workspace session refresh ${section}, ${selectSession ? 'another session selected' : 'no session selected'}`, async ({
      page
    }) => {
      await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
      const endpoint = new RegExp(`/api/workspaces/workspace-1/${section}(?:\\?.*)?$`);
      await page.unroute(endpoint);
      let reads = 0;
      await page.route(endpoint, (route) => {
        reads += 1;
        const path = `notification-refresh-${reads}.txt`;
        return json(
          route,
          section === 'changes'
            ? {
                branch: 'feature/notification-refresh',
                repositories: [
                  {
                    repositoryPath: '',
                    repositoryName: 'project',
                    source: 'ROOT',
                    branch: 'feature/notification-refresh',
                    status: 'DIRTY',
                    changes: [{ path, state: 'UNTRACKED', change: 'ADDED', diffAvailable: false }]
                  }
                ]
              }
            : {
                files: {
                  entries: [{ path, name: path, kind: 'FILE', size: 12 }],
                  nextCursor: null
                }
              }
        );
      });
      await page.goto('/console');
      await page.getByLabel('密码').fill('test-password');
      await page.getByRole('button', { name: '进入控制台' }).click();
      await page.getByRole('button', { name: '工作', exact: true }).click();
      await page
        .locator('.workspace-tree')
        .getByRole('button', { name: /node-1/ })
        .click();
      await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
      if (selectSession) await page.locator('.session-list button').first().click();
      if (section === 'changes') await page.getByRole('tab', { name: 'Git 变更' }).click();
      else await page.getByRole('button', { name: '刷新文件', exact: true }).click();
      await expect.poll(() => reads).toBeGreaterThan(0);
      const before = reads;
      await expect(
        page.getByText(`notification-refresh-${before}.txt`, { exact: true })
      ).toBeVisible();

      const now = Date.now();
      const completed = {
        id: 'background-completed',
        kind: 'run',
        title: 'Run complete',
        message: 'Open the session.',
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 60_000,
        read: true,
        target: {
          targetType: 'WORKSPACE_SESSION',
          nodeId: 'node-1',
          workspaceId: 'workspace-1',
          sessionId: 'session-2'
        }
      };
      const messages = [
        {
          type: 'notification.created',
          notification: {
            ...completed,
            id: 'other-workspace',
            target: { ...completed.target, workspaceId: 'workspace-2' }
          }
        },
        {
          type: 'notification.created',
          notification: {
            ...completed,
            id: 'other-node',
            target: { ...completed.target, nodeId: 'node-2' }
          }
        },
        {
          type: 'notification.created',
          notification: { ...completed, id: 'approval', kind: 'approval' }
        },
        { type: 'notification.updated', notification: completed },
        { type: 'notification.created', notification: completed },
        { type: 'notification.created', notification: completed }
      ];
      await page.evaluate((values) => {
        const mock = (
          window as unknown as {
            __consoleMockWorkbenchWebSocket: { instances: Array<WebSocket & { url: string }> };
          }
        ).__consoleMockWorkbenchWebSocket;
        const socket = mock.instances.find(
          (entry) => entry.url.includes('/api/workbench/live') && entry.readyState === 1
        );
        if (socket === undefined) throw new Error('MOCK_WORKBENCH_SOCKET_NOT_READY');
        for (const message of values)
          socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
      }, messages);
      await expect(
        page.getByText(`notification-refresh-${before + 1}.txt`, { exact: true })
      ).toBeVisible();
      expect(reads).toBe(before + 1);
      const background = {
        id: 'session-2',
        workspaceId: 'workspace-1',
        runner: 'codex',
        activity: 'MANAGED_ACTIVE'
      };
      await emitMockWorkspaceSnapshot(page, 'sessions', {
        sessions: [background],
        nextCursor: null
      });
      expect(reads).toBe(before + 1);
      const idleSnapshot = {
        sessions: [{ ...background, activity: 'IDLE' }],
        nextCursor: null
      };
      await emitMockWorkspaceSnapshot(page, 'sessions', idleSnapshot);
      await emitMockWorkspaceSnapshot(page, 'sessions', idleSnapshot);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      );
      expect(reads).toBe(before + 1);
      await expect(
        page.getByText(`notification-refresh-${before + 1}.txt`, { exact: true })
      ).toBeVisible();
    });
  }
}

test('Realtime and duplicate idle events do not refresh visible Files', async ({ page }) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.unroute(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/);
  let filesReads = 0;
  let filesChanged = false;
  await page.route(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/, (route) => {
    filesReads += 1;
    return json(route, {
      files: {
        entries: [
          {
            path: filesChanged ? 'after-run.txt' : 'before-run.txt',
            name: filesChanged ? 'after-run.txt' : 'before-run.txt',
            kind: 'FILE',
            size: 12
          }
        ],
        nextCursor: null
      }
    });
  });

  await page.goto('/console');
  await page.getByLabel('密码').fill('test-password');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list button').first().click();
  await page.getByRole('button', { name: '刷新文件', exact: true }).click();
  await expect(page.getByText('before-run.txt', { exact: true })).toBeVisible();
  const readsBeforeIdle = filesReads;
  filesChanged = true;

  const session = (activity: 'MANAGED_ACTIVE' | 'IDLE') => ({
    session: {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex',
      externalSessionId: 'vscode-thread-1',
      activity,
      control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
    }
  });
  await emitMockSessionEvent(page, 'session', session('MANAGED_ACTIVE'));
  await expect(page.locator('.session-activity.managed_active').first()).toBeVisible();
  await emitMockSessionEvent(page, 'session', session('IDLE'));
  await expect(page.locator('.session-activity.managed_active')).toHaveCount(0);
  await emitMockSessionEvent(page, 'session', session('IDLE'));
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  await expect(page.getByText('before-run.txt', { exact: true })).toBeVisible();
  await expect(page.getByText('after-run.txt', { exact: true })).toHaveCount(0);
  expect(filesReads).toBe(readsBeforeIdle);
});

test('Git Changes shows branches, file diffs, and confirmed restoration', async ({ page }) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  let fileReads = 0;
  let changeReads = 0;
  let holdChangesRefresh = false;
  let failChangesRefresh = false;
  let releaseChangesRefresh: (() => void) | undefined;
  let childDiffRepositoryPath: string | null = null;
  let linkedDiffWorktreePath: string | null = null;
  let linkedPreviewWorktreePath: string | null = null;
  let linkedContentWorktreePath: string | null = null;
  let holdFileRefresh = false;
  let releaseFileRefresh: (() => void) | undefined;
  let fileMutation: Record<string, unknown> | undefined;
  let includeLinkedWorktree = true;
  await page.route(/\/api\/workspaces\/workspace-1\/files\/mutate$/, async (route) => {
    fileMutation = route.request().postDataJSON() as Record<string, unknown>;
    return json(route, { file: { path: 'created-folder' } });
  });
  await page.route(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/, async (route) => {
    fileReads += 1;
    if (holdFileRefresh) await new Promise<void>((resolve) => (releaseFileRefresh = resolve));
    return json(route, {
      files: {
        entries: [
          { path: 'src/main.ts', name: 'main.ts', kind: 'FILE', size: 25, modifiedAt: 1 },
          {
            path: 'very-long-file-name-that-needs-horizontal-scrolling-in-the-explorer.ts',
            name: 'very-long-file-name-that-needs-horizontal-scrolling-in-the-explorer.ts',
            kind: 'FILE',
            size: 25,
            modifiedAt: 1
          }
        ],
        nextCursor: null,
        truncated: false
      }
    });
  });
  await page.route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get('path');
    if (path === 'notes/linked.txt') {
      linkedPreviewWorktreePath = url.searchParams.get('worktreePath');
      return json(route, {
        file: {
          path,
          encoding: 'utf-8',
          size: Buffer.byteLength('linked worktree preview\n', 'utf8'),
          content: 'linked worktree preview\n',
          truncated: false,
          nextOffset: null
        }
      });
    }
    if (path !== 'scratch.txt') return route.fulfill({ status: 404 });
    return json(route, {
      file: {
        path: 'scratch.txt',
        encoding: 'utf-8',
        size: Buffer.byteLength('未跟踪文件内容\n', 'utf8'),
        content: '未跟踪文件内容\n',
        truncated: false,
        nextOffset: null
      }
    });
  });
  await page.route(/\/api\/workspaces\/workspace-1\/changes(?:\?.*)?$/, async (route) => {
    changeReads += 1;
    if (holdChangesRefresh)
      await new Promise<void>((resolve) => {
        releaseChangesRefresh = resolve;
      });
    if (failChangesRefresh) return json(route, { error: { code: 'CHANGES_REFRESH_FAILED' } }, 503);
    return json(route, {
      branch: 'feature/inspector',
      changes: [
        {
          path: 'src/main.ts',
          state: 'UNSTAGED',
          change: 'MODIFIED',
          diffAvailable: true
        },
        { path: 'src/staged.ts', state: 'STAGED', change: 'MODIFIED', diffAvailable: true },
        { path: 'assets/logo.png', state: 'UNSTAGED', change: 'MODIFIED', diffAvailable: true },
        { path: 'scratch.txt', state: 'UNTRACKED', change: 'ADDED', diffAvailable: false },
        {
          path: 'docs/19-工作台通知中心与非阻塞上传方案的超长文件名.md',
          state: 'UNTRACKED',
          change: 'ADDED',
          diffAvailable: false
        },
        {
          path: 'ee/web/src/workbench/notifications/deeply/nested/short.ts',
          state: 'UNTRACKED',
          change: 'ADDED',
          diffAvailable: false
        }
      ],
      worktrees: [
        {
          directoryName: 'actual-project-directory',
          branch: 'feature/inspector',
          head: 'a'.repeat(40),
          current: true,
          status: 'DIRTY',
          locked: false,
          prunable: false
        },
        {
          directoryName: 'clean-agent',
          branch: 'agent/clean',
          head: 'b'.repeat(40),
          current: false,
          status: 'CLEAN',
          locked: false,
          prunable: false
        },
        {
          directoryName: 'detached-agent',
          branch: null,
          head: 'c'.repeat(40),
          current: false,
          status: 'UNAVAILABLE',
          locked: true,
          prunable: true
        }
      ].filter((worktree) => includeLinkedWorktree || worktree.current),
      worktreesTruncated: includeLinkedWorktree,
      repositories: [
        {
          repositoryPath: '',
          repositoryName: 'actual-project-directory',
          source: 'ROOT',
          physicalPath: '/srv/workspaces/actual-project-directory',
          current: true,
          branch: 'feature/inspector',
          head: 'a'.repeat(40),
          status: 'DIRTY',
          locked: false,
          prunable: false,
          changes: [
            { path: 'src/main.ts', state: 'UNSTAGED', change: 'MODIFIED', diffAvailable: true },
            { path: 'src/staged.ts', state: 'STAGED', change: 'MODIFIED', diffAvailable: true },
            {
              path: 'assets/logo.png',
              state: 'UNSTAGED',
              change: 'MODIFIED',
              diffAvailable: true
            },
            { path: 'scratch.txt', state: 'UNTRACKED', change: 'ADDED', diffAvailable: false },
            {
              path: 'docs/19-工作台通知中心与非阻塞上传方案的超长文件名.md',
              state: 'UNTRACKED',
              change: 'ADDED',
              diffAvailable: false
            },
            {
              path: 'ee/web/src/workbench/notifications/deeply/nested/short.ts',
              state: 'UNTRACKED',
              change: 'ADDED',
              diffAvailable: false
            }
          ]
        },
        {
          repositoryPath: 'packages/child',
          repositoryName: 'child',
          source: 'SUBMODULE',
          branch: 'main',
          changes: [
            { path: 'src/child.ts', state: 'UNSTAGED', change: 'MODIFIED', diffAvailable: true }
          ]
        },
        {
          repositoryPath: 'packages/empty-child',
          repositoryName: 'empty-child',
          status: includeLinkedWorktree ? 'UNAVAILABLE' : 'CLEAN',
          ...(includeLinkedWorktree
            ? {
                error: {
                  code: 'GIT_SUBMODULE_MAPPING_MISSING',
                  message: 'Submodule mapping is missing.',
                  details: 'Check the parent mapping.'
                }
              }
            : {}),
          source: 'SUBMODULE',
          branch: 'develop',
          changes: []
        },
        {
          repositoryPath: '',
          repositoryName: 'linked-review',
          source: 'WORKTREE',
          worktreePath: '/srv/worktrees/linked-review',
          physicalPath: '/srv/worktrees/linked-review',
          current: false,
          branch: 'agent/review',
          head: 'd'.repeat(40),
          status: 'DIRTY',
          locked: false,
          prunable: false,
          changes: [
            {
              path: 'src/linked.ts',
              state: 'UNSTAGED',
              change: 'MODIFIED',
              diffAvailable: true
            },
            {
              path: 'assets/linked.png',
              state: 'UNSTAGED',
              change: 'MODIFIED',
              diffAvailable: true
            },
            {
              path: 'notes/linked.txt',
              state: 'UNTRACKED',
              change: 'ADDED',
              diffAvailable: false
            }
          ]
        }
      ].filter((repository) => includeLinkedWorktree || repository.source !== 'WORKTREE')
    });
  });
  await page.route(/\/api\/workspaces\/workspace-1\/changes\/diff(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get('path');
    if (path === 'src/child.ts') childDiffRepositoryPath = url.searchParams.get('repositoryPath');
    if (path === 'src/linked.ts') {
      linkedDiffWorktreePath = url.searchParams.get('worktreePath');
      return json(route, {
        diff: {
          binary: false,
          afterText: 'export const linked = true;\n',
          text: 'diff --git a/src/linked.ts b/src/linked.ts\n@@ -1 +1 @@\n-export const linked = false;\n+export const linked = true;\n'
        }
      });
    }
    if (path === 'assets/linked.png') {
      linkedDiffWorktreePath = url.searchParams.get('worktreePath');
      return json(route, { diff: { binary: true, truncated: false } });
    }
    if (path === 'src/staged.ts') {
      return json(route, {
        diff: {
          binary: false,
          afterText: 'export const stage = "after";\n',
          text: 'diff --git a/src/staged.ts b/src/staged.ts\n@@ -1 +1 @@\n-export const stage = "before";\n+export const stage = "after";\n'
        }
      });
    }
    if (path === 'assets/logo.png') {
      return json(route, {
        diff: {
          binary: true,
          truncated: false
        }
      });
    }
    return json(route, {
      diff: {
        binary: false,
        afterText: 'export const answer = 42;\nconst stable = true;\nconst tail = "after";\n',
        text: 'diff --git a/src/main.ts b/src/main.ts\n@@ -1 +1 @@\n-export const answer = 41;\n+export const answer = 42;\n@@ -3 +3 @@\n-const tail = "before";\n+const tail = "after";\n'
      }
    });
  });
  await page.route(/\/api\/workspaces\/workspace-1\/files\/content(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('path') === 'assets/linked.png')
      linkedContentWorktreePath = url.searchParams.get('worktreePath');
    return route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0WQAAAABJRU5ErkJggg==',
        'base64'
      )
    });
  });
  await page.route(/\/api\/workspaces\/workspace-1\/changes\/restore(?:\?.*)?$/, (route) =>
    write(route, writes, { restored: true })
  );

  await page.goto('/console');
  await page.getByLabel('密码').fill('test-password');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await expect(page.locator('.explorer-toolbar .workspace-upload-input')).toBeHidden();
  const toolbarItemRows = await page
    .locator('.explorer-toolbar')
    .evaluate((toolbar) =>
      [...toolbar.children]
        .filter((element) => getComputedStyle(element).display !== 'none')
        .map((element) => Math.round(element.getBoundingClientRect().top))
    );
  expect(Math.max(...toolbarItemRows) - Math.min(...toolbarItemRows)).toBeLessThan(8);
  const fileToolbarLayout = await page
    .locator('.file-explorer > .explorer-toolbar')
    .evaluate((toolbar) => {
      const toolbarRect = toolbar.getBoundingClientRect();
      const filter = toolbar.querySelector('.file-display-filter')?.getBoundingClientRect();
      const firstButton = toolbar.querySelector('button')?.getBoundingClientRect();
      return {
        height: Math.round(toolbarRect.height),
        filterOffset: Math.round((filter?.left ?? toolbarRect.left) - toolbarRect.left),
        firstButtonOffset: Math.round((firstButton?.left ?? toolbarRect.left) - toolbarRect.left),
        borderBottomWidth: getComputedStyle(toolbar).borderBottomWidth
      };
    });
  expect(fileToolbarLayout.height).toBeLessThanOrEqual(33);
  expect(fileToolbarLayout.filterOffset).toBe(0);
  expect(fileToolbarLayout.firstButtonOffset).toBeGreaterThan(0);
  expect(fileToolbarLayout.borderBottomWidth).toBe('1px');
  expect(
    await page
      .locator('.explorer-toolbar button')
      .evaluateAll((buttons) =>
        buttons.slice(0, 2).map((button) => button.getAttribute('aria-label'))
      )
  ).toEqual(['刷新文件', '上传文件']);
  await expect(page.getByPlaceholder('按名称或路径过滤')).toBeVisible();
  const refreshFilesButton = page.getByRole('button', { name: '刷新文件', exact: true });
  await expect(refreshFilesButton).toBeVisible();
  await expect(refreshFilesButton).toBeEnabled();
  const fileReadsBeforeRefresh = fileReads;
  await refreshFilesButton.click();
  await expect.poll(() => fileReads).toBe(fileReadsBeforeRefresh + 1);
  const fileTree = page.getByRole('tree', { name: '文件树' });
  await expect(fileTree).toHaveCSS('overflow-x', 'hidden');
  const manuallyOpenedFile = fileTree.getByRole('treeitem', { name: /main\.ts/ }).first();
  await expect(manuallyOpenedFile).toHaveCSS('cursor', 'pointer');
  await manuallyOpenedFile.hover();
  const fileMenu = page.getByRole('button', { name: /main\.ts 更多操作/ });
  await expect(fileMenu).toBeVisible();
  await fileMenu.click();
  await expect(page.getByRole('menuitem', { name: '重命名' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '删除' })).toBeVisible();
  await expect(page.locator('.el-dropdown__popper:visible .el-icon')).toHaveCount(6);
  await page.keyboard.press('Escape');
  const rootDirectory = fileTree.getByRole('treeitem', { name: 'project', exact: true });
  await rootDirectory.hover();
  const rootActions = page.getByRole('button', { name: 'project 更多操作' });
  await rootActions.click();
  const [rootActionsBox, rootMenuBox] = await Promise.all([
    rootActions.boundingBox(),
    page.locator('.el-dropdown__popper:visible').boundingBox()
  ]);
  expect(rootActionsBox).not.toBeNull();
  expect(rootMenuBox).not.toBeNull();
  await expect(page.locator('.el-dropdown__popper:visible .el-icon')).toHaveCount(4);
  expect(rootMenuBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    (rootActionsBox?.y ?? 0) + (rootActionsBox?.height ?? 0) + 24
  );
  await manuallyOpenedFile.hover();
  await expect(page.getByRole('menuitem', { name: '新建文件夹' })).toBeVisible();
  const menuFlashedAtViewportOrigin = page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const startedAt = performance.now();
        let flashed = false;
        const inspect = () => {
          for (const popper of document.querySelectorAll<HTMLElement>('.el-dropdown__popper')) {
            const rect = popper.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.x < 20 && rect.y < 20) flashed = true;
          }
          if (performance.now() - startedAt < 400) requestAnimationFrame(inspect);
          else resolve(flashed);
        };
        requestAnimationFrame(inspect);
      })
  );
  await page.getByPlaceholder('按名称或路径过滤').click();
  expect(await menuFlashedAtViewportOrigin).toBe(false);
  await rootDirectory.hover();
  await rootActions.click();
  await page.getByRole('menuitem', { name: '新建文件夹' }).click();
  const createDirectoryDialog = page.getByRole('dialog', { name: '新建文件夹' });
  await createDirectoryDialog.getByRole('textbox').fill('created-folder');
  await createDirectoryDialog.getByRole('button', { name: '确认' }).click();
  await expect
    .poll(() => fileMutation)
    .toMatchObject({
      action: 'CREATE_DIRECTORY',
      path: 'created-folder'
    });
  await manuallyOpenedFile.click();
  await expect(manuallyOpenedFile).toHaveAttribute('aria-selected', 'true');
  await fileTree.evaluate((tree) =>
    tree.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true }))
  );
  await expect(fileTree).toHaveClass(/is-root-drop-target/);
  await fileTree.evaluate((tree) =>
    tree.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: document.body }))
  );
  await expect(fileTree).not.toHaveClass(/is-root-drop-target/);
  await page.locator('.workspace-file-tabs .workspace-file-tab-close').click();
  await expect(page.locator('.workspace-file-tabs')).toHaveCount(0);
  const changeReadsBeforeOpen = changeReads;
  await page.getByRole('tab', { name: 'Git 变更' }).click();
  await expect.poll(() => changeReads).toBe(changeReadsBeforeOpen + 1);

  await expect(page.locator('.git-worktrees')).toHaveCount(0);
  await expect(page.getByText('仅显示部分 Git 工作树', { exact: true })).toBeVisible();

  const tabGap = await page.locator('.inspector-tabs').evaluate((element) => {
    const tabs = [...element.querySelectorAll<HTMLElement>('[role="tab"]')];
    return (
      (tabs[1]?.getBoundingClientRect().left ?? 0) - (tabs[0]?.getBoundingClientRect().right ?? 0)
    );
  });
  expect(tabGap).toBeGreaterThanOrEqual(0);
  expect(tabGap).toBeLessThanOrEqual(4);
  const refreshChangesButton = page.getByRole('button', {
    name: '刷新 Git 变更',
    exact: true
  });
  await expect(refreshChangesButton).toBeVisible();
  await expect(refreshChangesButton).toHaveAttribute('type', 'button');
  await expect(refreshChangesButton).toHaveClass(/changes-refresh-button/u);
  await expect(refreshChangesButton).toHaveClass(/utility-control/u);
  await expect(refreshChangesButton).not.toHaveClass(/el-button/u);
  holdChangesRefresh = true;
  failChangesRefresh = true;
  const changeReadsBeforeRefresh = changeReads;
  await refreshChangesButton.click();
  await expect.poll(() => changeReads).toBe(changeReadsBeforeRefresh + 1);
  await expect.poll(() => releaseChangesRefresh !== undefined).toBe(true);
  await expect(page.getByRole('button', { name: '查看 src/main.ts 的 Diff' })).toBeEnabled();
  releaseChangesRefresh?.();
  await expect(refreshChangesButton).toBeEnabled();
  await expect(page.getByRole('button', { name: '查看 src/main.ts 的 Diff' })).toBeEnabled();
  holdChangesRefresh = false;
  failChangesRefresh = false;
  await page.getByRole('tab', { name: '文件', exact: true }).click();
  const changeReadsBeforeReopen = changeReads;
  await page.getByRole('tab', { name: 'Git 变更' }).click();
  await expect.poll(() => changeReads).toBe(changeReadsBeforeReopen + 1);
  await expect(page.locator('.change-repository-heading .current-branch').first()).toHaveText(
    'feature/inspector'
  );
  await expect(page.locator('.session-heading-meta .workspace-kind-tag')).toHaveText('Git');
  await expect(page.locator('.session-heading-meta .workspace-branch-tag')).toHaveText(
    'feature/inspector'
  );
  holdFileRefresh = true;
  await page.getByRole('tab', { name: '文件', exact: true }).click();
  await expect(refreshFilesButton).toBeEnabled();
  await refreshFilesButton.click();
  await expect.poll(() => releaseFileRefresh !== undefined).toBe(true);
  await expect(manuallyOpenedFile).toBeVisible();
  await page.getByRole('tab', { name: 'Git 变更' }).click();
  await expect(page.getByRole('button', { name: '查看 src/main.ts 的 Diff' })).toBeEnabled();
  releaseFileRefresh?.();
  holdFileRefresh = false;
  await expect(page.locator('.current-changes .change-list')).toHaveCSS('overflow-y', 'auto');
  await expect(
    page.locator('.change-repository-empty').filter({ hasText: 'GIT_SUBMODULE_MAPPING_MISSING' })
  ).toBeVisible();
  await expect(page.locator('.change-repository-empty')).toContainText('Check the parent mapping.');
  await expect(page.locator('.change-repository-heading strong')).toHaveText([
    'actual-project-directory',
    'child',
    'empty-child',
    'linked-review'
  ]);
  await expect(page.locator('.change-repository-heading .repository-branch')).toHaveText([
    'feature/inspector',
    'main',
    'develop',
    'agent/review'
  ]);
  await expect(page.locator('.change-repository-heading .repository-kind')).toHaveText([
    '根仓库',
    '子模块',
    '子模块',
    '工作树'
  ]);
  await expect(
    page.locator('.change-repository-heading').first().getByText('当前', { exact: true })
  ).toBeVisible();
  await expect(
    page
      .locator('.change-repository-heading')
      .filter({ hasText: 'linked-review' })
      .locator('.repository-physical-path')
  ).toHaveText('/srv/worktrees/linked-review');
  await expect(page.locator('.change-repository-heading .changes-refresh-button')).toHaveCount(1);
  await expect(page.locator('.change-repository-empty')).toContainText(
    'GIT_SUBMODULE_MAPPING_MISSING'
  );
  const rootChangeList = page.locator('.change-list > li.change-entry');
  await expect(rootChangeList.first()).toContainText('main.ts');
  await expect(
    page.getByRole('button', { name: '查看 packages/child/src/child.ts 的 Diff' })
  ).toBeVisible();
  const mainChange = page.getByRole('button', { name: '查看 src/main.ts 的 Diff' });
  await expect(mainChange.locator('.change-file-name')).toHaveText('main.ts');
  await expect(mainChange.locator('.change-directory')).toHaveText('src');
  await expect(mainChange).toHaveAttribute('title', 'src/main.ts');
  await expect(mainChange.locator('.change-directory')).toHaveCSS('margin-left', '7.92px');
  await expect(mainChange.locator('xpath=..')).toHaveCSS('border-top-width', '0px');
  const longChange = page.getByRole('button', {
    name: '预览 docs/19-工作台通知中心与非阻塞上传方案的超长文件名.md'
  });
  await expect(longChange).toHaveAttribute(
    'title',
    'docs/19-工作台通知中心与非阻塞上传方案的超长文件名.md'
  );
  const longPathContent = longChange.locator('.change-path-content');
  await expect(longPathContent).toHaveCSS('text-overflow', 'ellipsis');
  const shortFileInLongDirectory = page.getByRole('button', {
    name: '预览 ee/web/src/workbench/notifications/deeply/nested/short.ts'
  });
  const deepPathContent = shortFileInLongDirectory.locator('.change-path-content');
  await expect(deepPathContent).toHaveCSS('text-overflow', 'ellipsis');
  const deepFileHeading = shortFileInLongDirectory.locator('.change-file-heading');
  const deepFileName = shortFileInLongDirectory.locator('.change-file-name');
  const deepDirectory = shortFileInLongDirectory.locator('.change-directory');
  await expect(deepFileName).toHaveText('short.ts');
  await expect(deepFileHeading).toHaveCSS('flex-shrink', '0');
  await expect(deepDirectory).toHaveCSS('overflow', 'hidden');
  expect((await deepFileName.boundingBox())?.width ?? 0).toBeGreaterThan(24);
  await expect(page.getByTitle('MODIFIED').first()).toHaveText('M');
  await expect(page.getByTitle('STAGED', { exact: true })).toHaveText('S');
  await page.getByRole('button', { name: '预览 scratch.txt' }).click();
  const preview = page.getByRole('dialog', { name: 'scratch.txt 文件预览' });
  await expect(preview.getByLabel('代码编辑器预览')).toContainText('未跟踪文件内容');
  await preview.getByRole('button', { name: '文件内查找' }).click();
  const previewFind = preview.getByRole('search', { name: '文件内查找' });
  await expect(previewFind).toBeVisible();
  await previewFind.getByPlaceholder('查找').fill('文件');
  await expect(previewFind.getByPlaceholder('查找')).toHaveValue('文件');
  await page.keyboard.press('Escape');
  await expect(previewFind).toBeHidden();
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  await expect(page.getByRole('button', { name: '删除 scratch.txt 的修改' })).toBeVisible();
  await page.getByRole('button', { name: '查看 src/main.ts 的 Diff' }).click();
  const diff = page.getByRole('dialog');
  await expect(diff).toHaveAccessibleName('src/main.ts Git 差异');
  await expect(page.locator('html')).toHaveCSS('overflow', 'hidden');
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await expect(diff.locator('.file-preview-content')).toHaveCSS('overflow', 'hidden');
  await expect(diff.getByLabel('工作树文件全文')).toHaveCSS('scrollbar-width', /^(none|thin)$/);
  await expect(diff.locator('.diff-minimap-viewport')).toHaveCSS(
    'background-color',
    /rgba?\(87, 96, 106/
  );
  await expect(diff.locator('.diff-minimap')).toHaveCSS('user-select', 'none');
  await expect(diff.locator('.diff-minimap-viewport')).toHaveCSS('cursor', 'grab');
  const diffBounds = await diff.boundingBox();
  const minimapBounds = await diff.locator('.diff-minimap').boundingBox();
  expect(diffBounds).not.toBeNull();
  expect(minimapBounds).not.toBeNull();
  expect((minimapBounds?.y ?? 0) + (minimapBounds?.height ?? 0)).toBeLessThanOrEqual(
    (diffBounds?.y ?? 0) + (diffBounds?.height ?? 0) + 1
  );
  const workingTree = diff.getByLabel('工作树文件全文');
  await expect(workingTree).toContainText('export const answer = 41;');
  await expect(workingTree).toContainText('export const answer = 42;');
  await expect(diff).toBeFocused();
  await workingTree.click();
  await page.keyboard.press('Control+f');
  const inlineFind = diff.getByRole('search', { name: '文件内查找' });
  await expect(inlineFind.getByPlaceholder('查找')).toBeFocused();
  await inlineFind.getByPlaceholder('查找').fill('answer');
  await expect(inlineFind).toContainText('1 / 2');
  await page.keyboard.press('Enter');
  await expect(inlineFind).toContainText('2 / 2');
  await page.keyboard.press('Shift+Enter');
  await expect(inlineFind).toContainText('1 / 2');
  await workingTree.click();
  await page.keyboard.press('Escape');
  await expect(inlineFind).toBeHidden();
  await expect(diff).toBeVisible();
  await expect(workingTree.locator('.is-deleted')).toHaveCount(2);
  await expect(workingTree.locator('.is-added')).toHaveCount(2);
  await expect(diff.locator('.unified-diff-line.is-active')).toHaveCount(2);
  await expect(diff.getByLabel('Diff 代码缩略图')).toBeVisible();
  await expect(diff.locator('.diff-minimap-row.is-added')).toHaveCount(2);
  await expect(diff.locator('.diff-minimap-row.is-deleted')).toHaveCount(2);
  await expect(diff.locator('.diff-minimap-row.is-context')).toHaveCount(1);
  await expect(diff.locator('.diff-minimap-viewport')).toBeVisible();
  const diffCounter = diff.locator('.diff-preview-toolbar .diff-toolbar-count').nth(1);
  await expect(diffCounter).toHaveText('1 / 2');
  await diff.getByRole('button', { name: '下一个差异' }).click();
  await expect(diffCounter).toHaveText('2 / 2');
  await page.keyboard.press('ArrowUp');
  await expect(diffCounter).toHaveText('1 / 2');
  await diff.getByRole('button', { name: '下一个文件' }).click();
  await expect(diff).toHaveAccessibleName('src/staged.ts Git 差异');
  await diff.getByRole('button', { name: '上一个文件' }).click();
  await expect(diff).toHaveAccessibleName('src/main.ts Git 差异');
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  await page.locator('.workspace-file-tabs .workspace-file-tab-close').click();
  await expect(page.locator('.workspace-file-tabs')).toHaveCount(0);

  await page.getByRole('button', { name: '查看 assets/logo.png 的 Diff' }).click();
  const binaryDiff = page.getByRole('dialog', { name: 'assets/logo.png Git 差异' });
  await expect(binaryDiff.getByText('非文本文件不支持代码比较。')).toBeVisible();
  await binaryDiff.getByRole('button', { name: '打开文件预览' }).click();
  const binaryFilePreview = page.getByRole('dialog', { name: 'assets/logo.png 文件预览' });
  await expect(binaryFilePreview.locator('img')).toBeVisible();
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  await expect(page.locator('.workspace-file-tabs')).toHaveCount(0);

  await page.getByRole('button', { name: '还原 src/main.ts 的修改' }).click();
  await page.getByRole('button', { name: '还原', exact: true }).click();
  await expect
    .poll(() => writes.filter((entry) => entry.url.includes('/changes/restore')).length)
    .toBe(1);
  expect(writes.find((entry) => entry.url.includes('/changes/restore'))).toMatchObject({
    csrf: 'csrf-1',
    body: expect.stringContaining('"state":"UNSTAGED"')
  });
  await page.getByRole('button', { name: '查看 packages/child/src/child.ts 的 Diff' }).click();
  const childDiff = page.getByRole('dialog', {
    name: 'src/child.ts Git 差异'
  });
  await expect(childDiff).toBeVisible();
  expect(childDiffRepositoryPath).toBe('packages/child');
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();

  await page
    .getByRole('button', {
      name: '查看 /srv/worktrees/linked-review/src/linked.ts 的 Diff'
    })
    .click();
  const linkedDiff = page.getByRole('dialog', {
    name: 'src/linked.ts Git 差异'
  });
  await expect(linkedDiff).toBeVisible();
  expect(linkedDiffWorktreePath).toBe('/srv/worktrees/linked-review');
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();

  await page
    .getByRole('button', {
      name: '预览 /srv/worktrees/linked-review/notes/linked.txt'
    })
    .click();
  const linkedPreview = page.getByRole('dialog', {
    name: 'notes/linked.txt 文件预览'
  });
  await expect(linkedPreview.getByLabel('代码编辑器预览')).toContainText('linked worktree preview');
  expect(linkedPreviewWorktreePath).toBe('/srv/worktrees/linked-review');
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();

  await page
    .getByRole('button', {
      name: '查看 /srv/worktrees/linked-review/assets/linked.png 的 Diff'
    })
    .click();
  const linkedBinaryDiff = page.getByRole('dialog', {
    name: 'assets/linked.png Git 差异'
  });
  await linkedBinaryDiff.getByRole('button', { name: '打开文件预览' }).click();
  const linkedBinaryPreview = page.getByRole('dialog', {
    name: 'assets/linked.png 文件预览'
  });
  await expect(linkedBinaryPreview.locator('img')).toBeVisible();
  expect(linkedContentWorktreePath).toBe('/srv/worktrees/linked-review');
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  await expect(page.locator('.workspace-file-tabs')).toHaveCount(0);

  await page
    .getByRole('button', {
      name: '还原 /srv/worktrees/linked-review/src/linked.ts 的修改'
    })
    .click();
  await page.getByRole('button', { name: '还原', exact: true }).click();
  await expect
    .poll(
      () =>
        writes.filter(
          (entry) =>
            entry.url.includes('/changes/restore') &&
            entry.body.includes('/srv/worktrees/linked-review')
        ).length
    )
    .toBe(1);

  includeLinkedWorktree = false;
  await refreshChangesButton.click();
  await expect(page.locator('.change-repository-heading strong')).toHaveText([
    'actual-project-directory',
    'child',
    'empty-child'
  ]);
  await expect(page.locator('.git-worktrees')).toHaveCount(0);
  await expect(page.locator('.change-repository-empty')).toHaveText('暂无未提交的更改');
});
