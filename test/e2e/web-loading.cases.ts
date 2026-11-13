import { expect, test, type Page } from '@playwright/test';
import {
  fulfillMockHostedConversationWatch,
  json,
  mockConsoleApi
} from './support/web-console-api.js';
import { hostedConversationSnapshotSchema } from '../../packages/protocol/src/index.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function openWorkspace(page: Page, mobile: boolean): Promise<void> {
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  const work = page.getByRole('button', { name: '工作', exact: true });
  await work.click();
  await page.locator('.workspace-tree .tree-node').first().click();
  if (!(await page.locator('.workspace-tree').isVisible())) await work.click();
  await page.locator('.workspace-branch-button').first().click();
  if (mobile) {
    await expect(page.locator('.conversation-sidebar')).toBeHidden();
    await page.getByRole('button', { name: '打开会话列表' }).click();
  }
  await expect(page.locator('.conversation-sidebar')).toBeVisible();
}

function sessions(start: number, count: number) {
  return Array.from({ length: count }, (_, offset) => ({
    id: `session-${start + offset}`,
    workspaceId: 'workspace-1',
    runner: 'codex',
    externalSessionId: `native-${start + offset}`,
    runnerTitle: `Session ${start + offset}`,
    activity: 'IDLE',
    lastActivityAt: 100_000 - start - offset,
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
  }));
}

for (const theme of ['vscode-dark-2026', 'daylight']) {
  test(`Unified loading: authentication ring consumes the actual theme: ${theme}`, async ({
    page
  }, testInfo) => {
    await page.addInitScript((value) => localStorage.setItem('mar.theme', value), theme);
    await mockConsoleApi(page, 'MANAGED', ['history.read'], []);
    const response = gate();
    await page.route('**/api/auth/me', async (route) => {
      await response.promise;
      await json(route, { authenticated: false, mustChangePassword: false });
    });
    await page.goto('/console');
    const ring = page.locator('.console-shell > .mar-page-loading-state > .mar-busy-indicator');
    await expect(ring).toBeVisible();
    await expect(page.locator('#mar-bootstrap')).toHaveCount(0);
    const actual = await ring.evaluate((element) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--mar-color-brand-text)';
      element.parentElement!.append(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      const style = getComputedStyle(element);
      return {
        color: style.color,
        expected,
        width: parseFloat(style.width),
        rootSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
        animation: style.animationName
      };
    });
    expect(actual.color).toBe(actual.expected);
    expect(actual.width / actual.rootSize).toBeCloseTo(1.25);
    expect(actual.animation).toBe('mar-busy-indicator-spin');
    await page.screenshot({ path: testInfo.outputPath(`page-loading-${theme}.png`) });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(ring).toHaveCSS('animation-name', 'none');
    response.release();
    await expect(page.getByRole('button', { name: '进入控制台' })).toBeVisible();
    await expect(ring).toHaveCount(0);
  });
}

for (const mobile of [false, true]) {
  for (const search of [false, true]) {
    test(`Unified loading: ${search ? 'searched' : 'ordinary'} session directory appends and retries without losing focus (${mobile ? 'mobile' : 'desktop'})`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width: mobile ? 390 : 1280, height: 844 });
      await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
      let attempts = 0;
      const retryResponse = gate();
      await page.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/, async (route) => {
        const query = new URL(route.request().url()).searchParams;
        if (!query.has('cursor')) {
          await json(route, {
            sessions: sessions(1, 30),
            nextCursor: search && !query.has('query') ? null : 'next-page'
          });
          return;
        }
        attempts += 1;
        if (attempts === 1) {
          await json(
            route,
            { code: 'INTERNAL_ERROR', message: 'Unable to read the next page.' },
            503
          );
          return;
        }
        await retryResponse.promise;
        await json(route, { sessions: sessions(31, 30), nextCursor: null });
      });
      await openWorkspace(page, mobile);
      const list = page.locator('.session-list');
      await expect(list.locator('.session-row')).toHaveCount(30);
      const input = page.locator('.session-search input');
      if (search) {
        await input.fill('Session');
        await input.press('Enter');
        await expect(page.locator('.session-search-button')).toBeEnabled();
      }
      await input.focus();
      await list.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const retry = list.locator('.mar-list-append-state button');
      await expect(retry).toBeVisible();
      await expect(retry).toHaveText('加载失败，点击重试');
      await expect(list.locator('.mar-list-append-state')).not.toContainText('Unable to read');
      await expect(input).toBeFocused();
      await expect(list.locator('.session-row')).toHaveCount(30);
      await list.evaluate((element) => {
        element.dispatchEvent(new Event('scroll'));
        element.dispatchEvent(new Event('scroll'));
      });
      expect(attempts).toBe(1);
      await retry.click();
      await expect(retry).toBeFocused();
      await expect(retry).toHaveAttribute('aria-disabled', 'true');
      await expect(retry).toHaveText('');
      await expect(retry).toHaveAccessibleName('正在加载');
      await expect(list.locator('.mar-list-append-state .mar-busy-indicator')).toHaveCount(1);
      await expect(list.locator('.mar-list-append-state .mar-busy-indicator')).toBeVisible();
      expect(
        await list
          .locator('.mar-list-append-state .mar-busy-indicator')
          .evaluate(
            (element) =>
              parseFloat(getComputedStyle(element).width) /
              parseFloat(getComputedStyle(document.documentElement).fontSize)
          )
      ).toBeCloseTo(0.875);
      await expect(list.locator('.mar-list-append-state .mar-busy-indicator')).toHaveCSS(
        'color',
        'rgb(48, 147, 255)'
      );
      if (mobile && !search)
        await page.screenshot({ path: testInfo.outputPath('mobile-pagination-loading.png') });
      await expect(list.locator('.mar-list-append-state .is-loading')).toHaveCount(0);
      await expect(list.locator('.session-row')).toHaveCount(30);
      retryResponse.release();
      await expect(list.locator('.session-row')).toHaveCount(60);
      await expect(retry).toHaveCount(0);
      await expect(list.locator('.mar-list-append-state')).toHaveCount(0);
      expect(attempts).toBe(2);
    });
  }
}

test('Unified loading: a hidden mobile list waits, then fills only the visible directory', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  const cursors: string[] = [];
  await page.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/, async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (cursor) cursors.push(cursor);
    const start = cursor === null ? 1 : cursor === 'second' ? 3 : cursor === 'third' ? 5 : 35;
    await json(route, {
      sessions: sessions(start, start < 5 ? 2 : 30),
      nextCursor:
        cursor === null
          ? 'second'
          : cursor === 'second'
            ? 'third'
            : cursor === 'third'
              ? 'fourth'
              : null
    });
  });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  const work = page.getByRole('button', { name: '工作', exact: true });
  await work.click();
  await page.locator('.workspace-tree .tree-node').first().click();
  if (!(await page.locator('.workspace-tree').isVisible())) await work.click();
  await page.locator('.workspace-branch-button').first().click();
  await expect(page.locator('.conversation-sidebar')).toBeHidden();
  expect(cursors).toEqual([]);
  await page.getByRole('button', { name: '打开会话列表' }).click();
  await expect(page.locator('.session-list .session-row')).toHaveCount(34);
  expect(cursors).toEqual(['second', 'third']);
  await page.locator('.session-list').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.locator('.session-list .session-row')).toHaveCount(64);
  expect(cursors).toEqual(['second', 'third', 'fourth']);
});

test('Unified loading: a successful empty settings page stays ready during refresh', async ({
  page
}, testInfo) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read'], []);
  const first = gate();
  const second = gate();
  let reads = 0;
  await page.route('**/api/me/usage/overview?*', async (route) => {
    reads += 1;
    await (reads === 1 ? first.promise : second.promise);
    const totals = {
      inputTokens: '0',
      outputTokens: '0',
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: '0',
      requests: '0',
      completeRequests: '0',
      partialRequests: '0',
      unknownRequests: '0'
    };
    await json(route, {
      asOf: Date.now(),
      availableFrom: 0,
      firstRecordedAt: null,
      lastReceivedAt: null,
      last24Hours: totals,
      last7Days: totals,
      selected: totals,
      buckets: [],
      runners: [],
      models: [],
      coverage: 'observed-only'
    });
  });
  await page.route('**/api/me/usage/records?*', (route) =>
    json(route, { records: [], total: '0', page: 1, pageSize: 20 })
  );
  await page.goto('/console?view=settings&settings=usage');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page
    .getByRole('navigation', { name: '设置菜单' })
    .getByRole('button', { name: '用量统计', exact: true })
    .click();
  const mask = page.locator('.mar-page-loading:visible').last();
  await expect.poll(() => reads).toBe(1);
  await expect(mask).toBeVisible();
  const ring = mask.locator('.el-loading-spinner');
  expect(
    await ring.evaluate(
      (element) =>
        parseFloat(getComputedStyle(element, '::before').width) /
        parseFloat(getComputedStyle(document.documentElement).fontSize)
    )
  ).toBeCloseTo(1.25);
  await expect(ring.locator('.circular')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('settings-page-loading.png') });
  first.release();
  await expect(mask).toHaveCount(0);
  const refresh = page
    .getByTestId('usage-statistics')
    .getByRole('button', { name: '刷新', exact: true });
  await refresh.click();
  await expect.poll(() => reads).toBe(2);
  await expect(page.locator('.mar-page-loading:visible')).toHaveCount(0);
  await expect(refresh).toHaveClass(/is-loading/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(refresh.locator('.is-loading')).toHaveCSS('animation-name', 'none');
  second.release();
  await expect(refresh).not.toHaveClass(/is-loading/);
});

test('Unified loading: hosted history pauses for a local filter and retains retry focus', async ({
  page
}) => {
  await page.setViewportSize({ width: 1200, height: 600 });
  await mockConsoleApi(page, 'MANAGED', ['history.read'], []);
  await page.route('**/api/conversation-templates', (route) => json(route, { templates: [] }));
  const conversation = (index: number) => ({
    id: `conversation-${index}`,
    nodeId: 'node-1',
    sessionId: `hosted-session-${index}`,
    templateId: 'template-1',
    templateName: 'Loading test',
    activeVersionId: 'version-1',
    title: `History ${index}`,
    titleSource: 'CUSTOM',
    pinnedAt: null,
    status: 'ACTIVE',
    modelId: 'model-1',
    createdAt: index,
    updatedAt: index,
    lastActivityAt: index
  });
  const first = Array.from({ length: 20 }, (_, index) => conversation(index + 1));
  const next = Array.from({ length: 20 }, (_, index) => conversation(index + 21));
  const retryResponse = gate();
  let appends = 0;
  await page.route('**/api/hosted-conversations?*', async (route) => {
    if (!new URL(route.request().url()).searchParams.has('cursor')) {
      await json(route, { items: first, nextCursor: 'second' });
      return;
    }
    appends += 1;
    if (appends === 1) {
      await json(route, { code: 'INTERNAL_ERROR', message: 'Page unavailable.' }, 503);
      return;
    }
    await retryResponse.promise;
    await json(route, { items: next, nextCursor: null });
  });
  const snapshot = hostedConversationSnapshotSchema.parse({
    snapshotSequence: 1,
    conversation: first[0],
    template: {
      id: 'template-1',
      nodeId: 'node-1',
      name: 'Loading test',
      description: '',
      status: 'ACTIVE',
      currentVersionId: 'version-1',
      available: true,
      createdAt: 1,
      updatedAt: 1
    },
    run: null,
    turns: [],
    historyNextCursor: null,
    files: [],
    models: [],
    error: null
  });
  await page.route('**/api/nodes/node-1/hosted-conversations/*/watch', (route) =>
    route.request().method() === 'DELETE'
      ? json(route, { released: true })
      : fulfillMockHostedConversationWatch(
          page,
          route,
          new URL(route.request().url()).pathname.split('/').at(-2)!,
          {
            ...snapshot,
            conversation: {
              ...snapshot.conversation,
              ...conversation(
                Number(new URL(route.request().url()).pathname.split('/').at(-2)!.split('-').at(-1))
              )
            }
          }
        )
  );
  await page.goto('/console?view=conversations');
  await page.getByRole('button', { name: '进入控制台' }).click();
  const list = page.locator('.history-list');
  await expect(list.locator('article')).toHaveCount(20);
  const filter = page.locator('.history-search-row input');
  await filter.fill('not in the loaded directory');
  await expect(list.locator('article')).toHaveCount(0);
  await expect(list).toContainText('已加载的历史中没有匹配对话');
  await expect(list).toContainText('仅筛选已加载的对话');
  expect(appends).toBe(0);
  await filter.clear();
  await expect(list.locator('article')).toHaveCount(20);
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const retry = list.locator('.mar-list-append-state button');
  await expect(retry).toBeVisible();
  await expect(retry).toHaveText('加载失败，点击重试');
  expect(appends).toBe(1);
  await retry.click();
  await expect(retry).toBeFocused();
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).toHaveText('');
  await expect(retry).toHaveAccessibleName('正在加载');
  await expect(list.locator('.mar-list-append-state .mar-busy-indicator')).toHaveCount(1);
  await expect(list.locator('.mar-list-append-state .mar-busy-indicator')).toBeVisible();
  retryResponse.release();
  await expect(list.locator('article')).toHaveCount(40);
  await expect(retry).toHaveCount(0);
  expect(appends).toBe(2);
});

test('Unified loading: installed Skill inspection uses one local mask and retains its rows', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read'], []);
  await page.route('**/api/resources', (route) =>
    json(route, {
      nodes: [{ id: 'node-1', displayName: 'Node 1', connected: true, disabled: false }],
      workspaces: []
    })
  );
  await page.route('**/api/skill-sources', (route) => json(route, { sources: [] }));
  await page.route('**/api/skill-favorites?*', (route) =>
    json(route, { favorites: [], page: 1, pageSize: 20, total: 0, hasMore: false })
  );
  const response = gate();
  let inspections = 0;
  await page.route('**/api/nodes/node-1/skills', async (route) => {
    inspections += 1;
    if (inspections > 1) await response.promise;
    await json(route, {
      targetKind: 'NODE',
      compatibilityMode: 'SYMLINK',
      skills: [{ name: 'target-skill', description: 'Installed', localStatus: 'VALID' }]
    });
  });
  await page.goto('/console?view=management&management=skill-config');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('tab', { name: '当前目标中的技能' }).click();
  const installed = page.locator('.skill-table-section:has(.installed-skill-table)');
  await expect(installed).toContainText('target-skill');
  await expect(installed.locator('.el-loading-mask')).toHaveCount(0);
  const check = page.getByRole('button', { name: '检查环境', exact: true });
  await check.click();
  await expect.poll(() => inspections).toBe(2);
  await expect(installed.locator('.el-loading-mask')).toBeVisible();
  await expect(installed).toContainText('target-skill');
  await expect(check).toBeDisabled();
  await expect(check).not.toHaveClass(/is-loading/);
  await expect(page.locator('.mar-page-loading:visible')).toHaveCount(0);
  response.release();
  await expect(check).toBeEnabled();
  await expect(installed.locator('.el-loading-mask')).toHaveCount(0);
});

test('Unified loading: shared access keeps the password form visible during submission', async ({
  page
}) => {
  const response = gate();
  await page.route('**/api/session-shares/loading-test/auth', async (route) => {
    await response.promise;
    await json(
      route,
      { code: 'SESSION_SHARE_PASSWORD_INVALID', message: 'Invalid password.' },
      403
    );
  });
  await page.goto('/share/loading-test');
  const password = page.locator('input[type="password"]');
  await expect(password).toBeVisible();
  await password.fill('123456');
  const submit = page.locator('.share-entry-panel button[type="submit"]');
  await submit.click();
  await expect(submit).toHaveClass(/is-loading/);
  await expect(password).toBeVisible();
  await expect(password).toHaveValue('123456');
  await expect(page.locator('.mar-page-loading-state')).toHaveCount(0);
  response.release();
  await expect(submit).not.toHaveClass(/is-loading/);
  await expect(password).toHaveValue('123456');
});
