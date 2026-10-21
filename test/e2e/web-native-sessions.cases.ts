import { expect, test, type Route } from '@playwright/test';
import {
  emitMockSessionEvent,
  emitMockWorkspaceSnapshot,
  fulfillMockSessionWatch,
  mockConsoleApi,
  json,
  write
} from './support/web-console-api.js';

// Native session discovery, first-message activation, and deletion

test('Restored MAR Agent sessions use first-message titles and synchronize automatic and custom titles', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  let session = {
    id: 'session-1',
    workspaceId: 'workspace-1',
    runner: 'mar-agent',
    externalSessionId: 'session-1',
    nativeControl: 'EXTERNAL',
    runnerTitle: '去看升国旗吧 需要五星红旗元素',
    customTitle: null as string | null,
    titleSource: 'AUTO',
    activity: 'IDLE',
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
  };
  await page.route('**/api/agent-sessions?nodeId=node-1*', (route) =>
    json(route, { sessions: [session] })
  );
  await page.route('**/api/agent-sessions/session-1?nodeId=node-1', (route) =>
    json(route, { session })
  );
  await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
    fulfillMockSessionWatch(page, route, session, {
      kind: 'session-watch-snapshot',
      sequence: 1,
      session,
      runs: [],
      queue: { version: 0, paused: false, items: [] },
      context: null,
      conversation: { unit: 'SEGMENT', segments: [], nextCursor: null }
    })
  );
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();
  const title = page.locator('.conversation-title-row h2');
  await expect(title).toHaveText(session.runnerTitle);
  await expect(page.locator('.session-list .session-link').first()).toContainText(
    session.runnerTitle
  );
  await page.reload();
  await expect(title).toHaveText(session.runnerTitle);
  session = { ...session, runnerTitle: '升国旗脚本与五星红旗设计', titleSource: 'RUNNER' };
  await emitMockSessionEvent(page, 'session', { session });
  await expect(title).toHaveText(session.runnerTitle);
  await expect(page.locator('.session-list .session-link').first()).toContainText(
    session.runnerTitle
  );
  session = { ...session, customTitle: '我的升旗项目', titleSource: 'CUSTOM' };
  await emitMockSessionEvent(page, 'session', { session });
  await expect(title).toHaveText(session.customTitle!);
  session = { ...session, runnerTitle: '迟到的自动标题' };
  await emitMockSessionEvent(page, 'session', { session });
  await expect(title).toHaveText('我的升旗项目');
  await expect(page.locator('.session-list .session-link').first()).toContainText('我的升旗项目');
});

test('New MAR Agent first messages appear on the session home and clearing search refreshes the list', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  const older = Array.from({ length: 20 }, (_, index) => ({
    id: `older-${index}`,
    workspaceId: 'workspace-1',
    runner: 'mar-agent',
    externalSessionId: `older-${index}`,
    runnerTitle: `历史会话 ${index}`,
    lastActivityAt: 20 - index
  }));
  const created = {
    id: 'native-created',
    workspaceId: 'workspace-1',
    runner: 'mar-agent',
    externalSessionId: 'native-created',
    runnerTitle: '回显会话',
    lastActivityAt: 21,
    activity: 'IDLE',
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
  };
  let published = false;
  let readsAfterCreation = 0;
  await page.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/, (route) => {
    const query = new URL(route.request().url()).searchParams.get('query');
    if (query !== null) return json(route, { sessions: [], nextCursor: null });
    if (published) readsAfterCreation += 1;
    return json(route, {
      sessions: published ? [created, ...older.slice(0, 19)] : older,
      nextCursor: 'more'
    });
  });
  await page.route(/\/api\/runner-profiles\?.*\bnodeId=node-1(?:&|$)/, (route) =>
    json(route, {
      profiles: [
        {
          runner: 'mar-agent',
          models: [
            {
              id: 'coding',
              label: 'Coding',
              supportedEfforts: ['high'],
              defaultEffort: 'high'
            }
          ],
          accessOptions: [{ id: 'full-access', label: 'Full access' }],
          commands: [],
          capabilities: ['history.read', 'turn.start']
        }
      ]
    })
  );
  await page.route('**/api/agent-sessions/start', (route) => {
    published = true;
    return write(route, writes, {
      session: created,
      run: {
        id: 'run-created',
        sessionId: created.id,
        workspaceId: created.workspaceId,
        status: 'SUCCEEDED',
        recoveryState: 'IDLE'
      }
    });
  });
  await page.route('**/api/agent-sessions/native-created/watch*', (route) =>
    fulfillMockSessionWatch(page, route, created, {
      kind: 'session-watch-snapshot',
      sequence: 1,
      session: created,
      runs: [],
      queue: { version: 0, paused: false, items: [] },
      context: null,
      conversation: { unit: 'SEGMENT', segments: [], nextCursor: null }
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await expect(page.locator('.session-list .session-link')).toHaveCount(20);
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.locator('.composer-runner-select')).toContainText('MAR Agent');
  await page.getByRole('textbox', { name: '输入消息' }).fill('回显会话');
  await page.getByRole('button', { name: '发送' }).click();
  await expect.poll(() => published).toBe(true);
  await expect(page.locator('.conversation-title-row h2')).toHaveText('回显会话');
  await emitMockWorkspaceSnapshot(page, 'sessions', {
    sessions: [created, ...older.slice(0, 19)],
    nextCursor: 'more'
  });
  await expect(page.locator('.session-list .session-link').first()).toContainText('回显会话');
  expect(readsAfterCreation).toBe(0);

  const search = page.locator('.session-search .el-input__inner');
  await search.fill('没有匹配项');
  await search.press('Enter');
  await expect(page.locator('.session-list .session-link')).toHaveCount(0);
  await search.fill('');
  await page.getByRole('button', { name: '刷新当前工作区会话' }).click();
  await expect.poll(() => readsAfterCreation).toBeGreaterThan(0);
  await expect(page.locator('.session-list .session-link').first()).toContainText('回显会话');
});

test('Externally busy sessions display normally and failed first messages create no local projection', async ({
  page
}) => {
  let messageRequests = 0;
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.route('**/api/agent-sessions/session-1/messages', (route) => {
    messageRequests += 1;
    return json(
      route,
      { error: { code: messageRequests === 1 ? 'EXTERNAL_SESSION_ACTIVE' : 'RUNNER_UNAVAILABLE' } },
      409
    );
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();

  const input = page.getByRole('textbox', { name: '输入消息' });
  await expect(input).toBeEnabled();
  await expect(page.locator('.composer-takeover')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '接管', exact: true })).toHaveCount(0);
  await input.fill('稍后继续这个会话');
  await page.getByRole('button', { name: '发送' }).click();
  await expect.poll(() => messageRequests).toBe(1);
  await expect(input).toHaveValue('稍后继续这个会话');
  await expect(page.locator('.conversation-message').getByText('稍后继续这个会话')).toHaveCount(0);
  await expect(page.locator('.composer-working')).toHaveCount(0);

  await page.getByRole('button', { name: '发送' }).click();
  await expect.poll(() => messageRequests).toBe(2);
  await expect(input).toHaveValue('稍后继续这个会话');
  await expect(page.locator('.conversation-message').getByText('稍后继续这个会话')).toHaveCount(0);
});

test('Idle external Codex sessions accept input and let Node resume on the first message', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(
    page,
    'MANAGED',
    ['history.read', 'turn.start'],
    writes,
    'GIT_WORKSPACE',
    true,
    'IDLE'
  );
  let releaseMessageRequest: (() => void) | undefined;
  const messageRequest = new Promise<void>((resolve) => {
    releaseMessageRequest = resolve;
  });
  let markMessageRequested: (() => void) | undefined;
  const messageRequested = new Promise<void>((resolve) => {
    markMessageRequested = resolve;
  });
  await page.route('**/api/agent-sessions/session-1/messages', async (route) => {
    markMessageRequested?.();
    await messageRequest;
    await write(route, writes, {
      session: {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'vscode-thread-1',
        nativeControl: 'MAR_MANAGED',
        activity: 'MANAGED_ACTIVE',
        control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
      },
      run: {
        id: 'run-resumed',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        status: 'RUNNING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'resumed-message'
      }
    });
  });
  await page.route('**/api/agent-sessions/session-1/runs?nodeId=node-1', (route) =>
    json(route, { runs: [] })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();

  const input = page.getByRole('textbox', { name: '输入消息' });
  await expect(input).toBeEnabled();
  await expect(page.locator('.composer-takeover')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '接管', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '接管后继续' })).toHaveCount(0);
  await input.fill('继续这个会话');
  await page.getByRole('button', { name: '发送' }).click();
  await messageRequested;
  await expect(page.locator('.conversation-message').getByText('继续这个会话')).toHaveCount(0);
  await expect(page.locator('.composer-takeover')).toHaveCount(0);
  releaseMessageRequest?.();
  await expect
    .poll(() => writes.filter((entry) => entry.url.includes('/agent-sessions/session-1/messages')))
    .toHaveLength(1);
  await emitMockSessionEvent(page, 'conversation', {
    turn: {
      id: 'resumed-turn',
      sessionId: 'session-1',
      runId: 'run-resumed',
      status: 'RUNNING',
      items: [
        {
          id: 'resumed-user-message',
          kind: 'user_message',
          status: 'COMPLETED',
          payload: { text: '继续这个会话' }
        }
      ]
    },
    segments: [
      {
        id: 'resumed-turn:segment:0',
        sessionId: 'session-1',
        turnId: 'resumed-turn',
        runId: 'run-resumed',
        index: 0,
        status: 'RUNNING',
        items: [
          {
            id: 'resumed-user-message',
            kind: 'user_message',
            status: 'COMPLETED',
            payload: { text: '继续这个会话' }
          }
        ]
      }
    ]
  });
  await expect(page.locator('.conversation-message').getByText('继续这个会话')).toBeVisible();
});

test('External Claude history shows a gray status and accepts a first resume message directly', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  const session = {
    id: 'session-1',
    workspaceId: 'workspace-1',
    runner: 'claude-code',
    externalSessionId: 'claude-history-1',
    nativeControl: 'EXTERNAL' as const,
    activity: 'IDLE',
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
  };
  await page.route('**/api/agent-sessions**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/agent-sessions/session-1/watch')
      return json(route, { session, watch: { expiresAt: 1_900_000_030_000 } });
    if (url.searchParams.get('nodeId') !== 'node-1') return route.fallback();
    if (url.pathname === '/api/agent-sessions') return json(route, { sessions: [session] });
    if (url.pathname === '/api/agent-sessions/session-1') return json(route, { session });
    return route.fallback();
  });
  await page.route('**/api/agent-sessions/session-1/context?nodeId=node-1', (route) =>
    json(route, {
      context: {
        model: 'GPT-5.6 Sol',
        usedTokens: 156_000,
        maxTokens: 258_400,
        percentage: 60.4
      }
    })
  );
  await page.route('**/api/agent-sessions/session-1/runs?nodeId=node-1', (route) =>
    json(route, { runs: [] })
  );
  await page.route('**/api/agent-sessions/session-1/messages', (route) =>
    write(route, writes, {
      session: {
        ...session,
        control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
      },
      run: {
        id: 'run-1',
        status: 'RUNNING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'claude-resume-message'
      }
    })
  );

  await page.goto('/console');
  await page.getByRole('textbox', { name: '密码' }).fill('test-password');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list').locator('.session-link').first().click();

  const input = page.getByRole('textbox', { name: '输入消息' });
  await expect(input).toBeEnabled();
  await expect(page.locator('.composer-takeover')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '接管', exact: true })).toHaveCount(0);
  await input.fill('继续 Claude 历史');
  await page.getByRole('button', { name: '发送' }).click();
  await expect
    .poll(() => writes.filter((entry) => entry.url.includes('/agent-sessions/session-1/messages')))
    .toHaveLength(1);
});

test('Resumed external Claude history is not duplicated by managed projections', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  const externalSession = {
    id: 'external-claude-history',
    workspaceId: 'workspace-1',
    runner: 'claude-code' as const,
    externalSessionId: 'claude-history-1',
    nativeControl: 'EXTERNAL' as const,
    runnerTitle: '同一份 Claude 历史',
    activity: 'IDLE' as const,
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
  };
  const managedSession = {
    ...externalSession,
    id: 'managed-claude-history',
    nativeControl: 'MAR_MANAGED' as const,
    activity: 'MANAGED_ACTIVE' as const,
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
  };
  await page.route('**/api/agent-sessions?nodeId=node-1*', (route) =>
    json(route, { sessions: [externalSession] })
  );
  for (const session of [externalSession, managedSession]) {
    await page.route(`**/api/agent-sessions/${session.id}?nodeId=node-1`, (route) =>
      json(route, { session })
    );
    await page.route(`**/api/agent-sessions/${session.id}/runs?nodeId=node-1`, (route) =>
      json(route, { runs: [] })
    );
    await page.route(`**/api/agent-sessions/${session.id}/turns?nodeId=node-1&limit=10`, (route) =>
      json(route, { turns: [], nextCursor: null })
    );
    await page.route(`**/api/agent-sessions/${session.id}/watch`, (route) =>
      json(route, {
        session,
        watch: { expiresAt: 1_900_000_030_000 },
        snapshot: { turns: [], nextCursor: null }
      })
    );
    await page.route(`**/api/agent-sessions/${session.id}/context?nodeId=node-1`, (route) =>
      json(route, { context: null })
    );
  }
  await page.route('**/api/workspaces/workspace-1/queue?nodeId=node-1&sessionId=*', (route) =>
    json(route, { queue: { version: 0, paused: false, items: [] } })
  );
  await page.route('**/api/agent-sessions/external-claude-history/messages', (route) =>
    write(route, writes, {
      session: managedSession,
      run: {
        id: 'run-1',
        status: 'SUCCEEDED',
        recoveryState: 'COMPLETED',
        clientMessageId: 'resume-claude-history'
      }
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list').locator('.session-link').first().click();
  await page.getByRole('textbox', { name: '输入消息' }).fill('继续 Claude 历史');
  await page.getByRole('button', { name: '发送' }).click();

  await expect
    .poll(() => writes.filter((entry) => entry.url.includes('/external-claude-history/messages')))
    .toHaveLength(1);
  const managedActivity = page.locator('.session-list .session-activity.managed_active');
  await expect(managedActivity).toHaveCount(1);
  await expect(managedActivity.locator('i')).toHaveCSS('animation-name', 'mar-run-glow');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(managedActivity.locator('i')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.session-list .session-link')).toHaveCount(1);
  await expect(page.locator('.session-list .session-link')).toContainText('同一份 Claude 历史');
});

test('Admin Console renames Codex and Claude sessions and confirms native-session deletion', async ({
  page
}) => {
  const nativeSessionId = 'edf770b1-3172-473b-bf16-af5dee3edfbb';
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  const renamedSession = {
    id: nativeSessionId,
    workspaceId: 'workspace-1',
    runner: 'codex' as const,
    externalSessionId: 'vscode-thread-1',
    runnerTitle: '原生标题',
    customTitle: '我的会话',
    activity: 'IDLE' as const,
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
  };
  await page.route('**/api/agent-sessions/session-1/metadata', (route) =>
    write(route, writes, { session: renamedSession })
  );
  await page.route(`**/api/agent-sessions/${nativeSessionId}?nodeId=node-1`, (route) =>
    route.request().method() === 'DELETE'
      ? write(route, writes, { deleted: true })
      : route.fallback()
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();

  const sessionRow = page.locator('.session-list .session-row').first();
  await sessionRow.hover();
  const actions = sessionRow.getByRole('button', { name: /更多会话操作：/ });
  await expect(actions).toHaveCSS('cursor', 'pointer');
  await actions.click();
  await page.getByRole('menuitem', { name: '重命名' }).click();
  const renameDialog = page.locator('.el-message-box');
  await renameDialog.locator('input').fill('我的会话');
  await renameDialog.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('.session-list .session-link strong')).toHaveText('我的会话');
  expect(writes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        url: expect.stringContaining('/api/agent-sessions/session-1/metadata'),
        csrf: 'csrf-1',
        body: expect.stringContaining('"customTitle":"我的会话"')
      })
    ])
  );

  await sessionRow.hover();
  await sessionRow.getByRole('button', { name: '更多会话操作：我的会话' }).click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  const deleteDialog = page.locator('.el-message-box');
  await expect(deleteDialog).toContainText('无法恢复');
  await deleteDialog.getByRole('button', { name: '删除会话' }).click();
  await expect(page.locator('.session-list')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '新建会话' })).toBeVisible();
  expect(writes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        url: expect.stringContaining(`/api/agent-sessions/${nativeSessionId}?nodeId=node-1`),
        csrf: 'csrf-1'
      })
    ])
  );
});

test('Workspace session cleanup defaults to thirty days and refreshes the session list', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(
    page,
    'MANAGED',
    ['history.read', 'turn.start'],
    writes,
    'GIT_WORKSPACE',
    true,
    undefined,
    undefined,
    '0.9.49'
  );
  let sessionListReads = 0;
  await page.route(
    '**/api/agent-sessions?nodeId=node-1&workspaceId=workspace-1&limit=30',
    (route) => {
      sessionListReads += 1;
      return json(route, { sessions: [], nextCursor: null });
    }
  );
  let releaseCleanupRequest!: (route: Route) => void;
  const cleanupRequest = new Promise<Route>((resolve) => {
    releaseCleanupRequest = resolve;
  });
  await page.route('**/api/workspaces/workspace-1/sessions/cleanup', (route) => {
    writes.push({
      url: route.request().url(),
      csrf: route.request().headers()['x-csrf-token'],
      body: route.request().postData() ?? ''
    });
    releaseCleanupRequest(route);
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();

  await page.getByRole('button', { name: '工作区操作', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '清理会话' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '更多工作区操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '清理会话' }).click();
  const dialog = page.getByRole('dialog', { name: '清理会话' });
  await expect(dialog).toContainText('置顶、活动、排队或正在查看的会话会保留');
  await expect(dialog.locator('input')).toHaveValue('30');
  await dialog.getByRole('button', { name: '清理会话' }).click();

  const pendingCleanup = await cleanupRequest;
  await expect(dialog.getByRole('button', { name: '清理中…' })).toBeVisible();
  await expect(dialog.locator('.el-loading-mask')).toBeVisible();
  expect(writes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        url: expect.stringContaining('/api/workspaces/workspace-1/sessions/cleanup'),
        csrf: 'csrf-1',
        body: JSON.stringify({ nodeId: 'node-1', inactiveDays: 30 })
      })
    ])
  );
  await json(pendingCleanup, {
    deleted: 0,
    skipped: 254,
    failed: 0,
    deletedByRunner: {}
  });
  await expect(dialog.getByText('清理完成', { exact: true })).toBeVisible();
  await expect(dialog.locator('.el-alert')).toHaveCount(0);
  await expect(dialog.getByText('254', { exact: true })).toBeVisible();
  await expect(dialog.getByText('按 Agent', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeVisible();
  await expect.poll(() => sessionListReads).toBeGreaterThan(0);
});
