import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { json, mockConsoleApi } from './support/web-console-api.js';

const consoleRoot = resolve(import.meta.dirname, '../../mar-web-console');
const webRequire = createRequire(resolve(consoleRoot, 'package.json'));
let consoleUrl: string;
let closeConsole: () => Promise<void>;

test.beforeAll(async () => {
  const { createServer } = await import(webRequire.resolve('vite'));
  const server = await createServer({
    root: consoleRoot,
    cacheDir: resolve(consoleRoot, `../test/runs/read-feedback-vite-${randomUUID()}`),
    server: { host: '127.0.0.1', port: 0, watch: null },
    logLevel: 'error'
  });
  closeConsole = () => server.close();
  await server.listen();
  consoleUrl = server.resolvedUrls.local[0];
});

test.afterAll(async () => closeConsole?.());

async function setup(page: Page, width: number, enterprise = false): Promise<void> {
  await page.setViewportSize({ width, height: 860 });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.addInitScript((mobile) => {
    localStorage.setItem('mar.locale.v2', 'en-US');
    localStorage.setItem('mar.theme', mobile ? 'daylight' : 'vscode-dark-2026');
  }, width < 768);
  await page.route('**/api/auth/me', (route) =>
    json(route, {
      authenticated: true,
      userId: 1,
      username: 'admin',
      mustChangePassword: false,
      isAdmin: true,
      ...(enterprise
        ? {
            edition: 'ENTERPRISE',
            licenseState: 'ENTERPRISE_VALID',
            role: 'ADMIN',
            managementWritable: true
          }
        : {})
    })
  );
}

async function capture(page: Page, info: TestInfo, state: string): Promise<void> {
  await page.mouse.move(0, 0);
  if ((page.viewportSize()?.width ?? 768) < 768)
    await expect(page.locator('.workspace-tree .settings-nav')).toBeHidden();
  await page.screenshot({ path: info.outputPath(`${state}.png`), animations: 'disabled' });
}

test('Leaving account settings ignores a late OAuth read failure', async ({ page }) => {
  await setup(page, 1280, true);
  const pending = Promise.withResolvers<void>();
  let reads = 0;
  await page.route('**/api/oauth-bindings', async (route) => {
    if (++reads > 1)
      return json(route, {
        bindings: [{ providerKey: 'fresh', name: 'Current provider', bound: false }]
      });
    await pending.promise;
    return json(
      route,
      { error: { code: 'TEMPORARY_FAILURE', message: 'OAuth unavailable.' } },
      503
    );
  });
  await page.route('**/api/quick-prompts', (route) => json(route, { prompts: [] }));
  await page.goto(`${consoleUrl}console?view=settings&settings=account`);
  await expect(page.locator('.oauth-bindings').getByRole('progressbar')).toBeVisible();
  await page.getByRole('button', { name: 'Quick Prompts', exact: true }).click();
  await expect(page.locator('.quick-prompts')).toBeVisible();
  const response = page.waitForResponse('**/api/oauth-bindings');
  pending.resolve();
  await (await response).finished();
  await expect(page.locator('.quick-prompts')).toContainText('No quick prompts yet.');
  await page.getByRole('button', { name: 'Account Security', exact: true }).click();
  await expect(page.locator('.oauth-bindings').getByText('Current provider')).toBeVisible();
  await expect(page.locator('.mar-message--error')).toHaveCount(0);
});

for (const width of [1280, 390]) {
  test(`Sign-in sessions isolate read, refresh and sign-out feedback at ${width}px`, async ({
    page
  }, info) => {
    await setup(page, width);
    let held = Promise.withResolvers<void>();
    let failed = true;
    let devices = [
      {
        id: 'other',
        userAgent: 'Fixture browser',
        ipAddress: '127.0.0.1',
        createdAt: 1,
        expiresAt: 2,
        current: false
      }
    ];
    await page.route('**/api/auth/sessions', async (route) => {
      await held.promise;
      return failed
        ? json(
            route,
            { error: { code: 'TEMPORARY_FAILURE', message: 'Devices unavailable.' } },
            503
          )
        : json(route, { sessions: devices });
    });
    const removal = Promise.withResolvers<void>();
    const afterRemoval = Promise.withResolvers<void>();
    await page.route('**/api/auth/sessions/other', async (route) => {
      await removal.promise;
      devices = [];
      held = afterRemoval;
      return json(route, {});
    });
    await page.goto(`${consoleUrl}console?view=settings&settings=account`);
    await page.locator('.admin-sessions').waitFor({ state: 'visible' });
    const area = page.locator('.admin-sessions');
    const refresh = area.getByRole('button', { name: 'Refresh sign-in sessions' });
    await expect(area.getByRole('progressbar')).toBeVisible();
    await expect(area.getByText('No active sign-in sessions.')).toHaveCount(0);
    await capture(page, info, 'account-loading');
    held.resolve();
    await expect(area.getByText('No data', { exact: true })).toBeVisible();
    await expect(page.locator('.mar-message--error')).toHaveCount(1);
    await capture(page, info, 'account-failed');
    await page.locator('.mar-message--error .mar-message-close').click();
    failed = false;
    held = Promise.withResolvers<void>();
    await refresh.click();
    await expect(refresh).toHaveAttribute('aria-busy', 'true');
    await expect(area.getByRole('progressbar')).toHaveCount(0);
    await capture(page, info, 'account-refreshing');
    held.resolve();
    const signOut = area.getByRole('button', { name: 'Sign out', exact: true });
    await signOut.click();
    const confirm = page.getByRole('dialog');
    await confirm.getByRole('button', { name: 'OK' }).click();
    await expect(signOut).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.account-actions button[aria-busy="true"]')).toHaveCount(0);
    await capture(page, info, 'account-signing-out');
    removal.resolve();
    await expect(area.getByRole('progressbar')).toBeVisible();
    await expect(signOut).not.toHaveAttribute('aria-busy', 'true');
    await expect(signOut).toBeDisabled();
    await expect(refresh).not.toHaveAttribute('aria-busy', 'true');
    await capture(page, info, 'account-rereading');
    afterRemoval.resolve();
    await expect(area.getByText('No active sign-in sessions.')).toBeVisible();
    await expect(page.locator('.mar-message--error')).toBeHidden({ timeout: 10_000 });
    await capture(page, info, 'account-empty');
  });

  test(`Activity Center shows empty only after a successful snapshot at ${width}px`, async ({
    page
  }, info) => {
    await setup(page, width);
    const first = Promise.withResolvers<void>();
    const retry = Promise.withResolvers<void>();
    let failed = true;
    await page.route('**/api/notifications', async (route) => {
      if (failed) {
        await first.promise;
        return json(
          route,
          { error: { code: 'TEMPORARY_FAILURE', message: 'Snapshot unavailable.' } },
          503
        );
      }
      await retry.promise;
      return json(route, { notifications: [], recentRuns: [] });
    });
    await page.goto(`${consoleUrl}console?view=settings&settings=account`);
    await page.locator('.activity-center-trigger').filter({ visible: true }).click();
    const panel = page.locator('.workbench-activity-panel');
    await expect(panel.getByRole('progressbar')).toBeVisible();
    await capture(page, info, 'activity-loading');
    first.resolve();
    const button = panel.getByRole('button', { name: 'Failed to load. Retry' });
    await expect(button).toBeVisible();
    await expect(panel.getByText('No recent sessions')).toHaveCount(0);
    await capture(page, info, 'activity-failed');
    failed = false;
    await button.focus();
    await button.click();
    const busyRetry = panel.getByRole('button', { name: /^Loading…?$/ });
    await expect(busyRetry).toBeFocused();
    await expect(busyRetry).toHaveAttribute('aria-busy', 'true');
    await expect(busyRetry.locator('.mar-read-loading-indicator')).toBeVisible();
    await capture(page, info, 'activity-retrying');
    retry.resolve();
    await expect(panel.getByText('No recent sessions')).toBeVisible();
    await capture(page, info, 'activity-empty');
    await panel.getByRole('tab', { name: 'Notifications' }).click();
    await expect(panel.getByText('No notifications')).toBeVisible();
    await capture(page, info, 'notifications-empty');
  });

  test(`Notification snapshot feedback stays visible with pending uploads at ${width}px`, async ({
    page
  }) => {
    await setup(page, width);
    await page.addInitScript(() => {
      sessionStorage.setItem(
        'mar.account.v1.1.mar.workspace-upload-tasks',
        JSON.stringify([
          {
            id: 'pending-upload',
            nodeId: 'node',
            workspaceId: 'workspace',
            directory: '.',
            name: 'pending-upload.txt',
            size: 10,
            receivedBytes: 2,
            overwrite: false
          }
        ])
      );
    });
    const first = Promise.withResolvers<void>();
    const retry = Promise.withResolvers<void>();
    let failRead = true;
    await page.route('**/api/notifications', async (route) => {
      if (failRead) {
        await first.promise;
        return json(
          route,
          { error: { code: 'TEMPORARY_FAILURE', message: 'Snapshot unavailable.' } },
          503
        );
      }
      await retry.promise;
      return json(route, { notifications: [], recentRuns: [] });
    });
    try {
      await page.goto(`${consoleUrl}console?view=settings&settings=account`);
      await page.locator('.activity-center-trigger').filter({ visible: true }).click();
      const panel = page.locator('.workbench-activity-panel');
      await panel.getByRole('tab', { name: 'Notifications' }).click();
      const upload = panel.getByText('pending-upload.txt', { exact: true });
      const spinner = panel.getByRole('progressbar', { name: /^Loading…?$/ });
      const empty = panel.getByText('No notifications');
      await expect(upload).toBeVisible();
      await expect(spinner).toBeVisible();
      await expect(empty).toHaveCount(0);
      first.resolve();
      const button = panel.getByRole('button', { name: 'Failed to load. Retry' });
      await expect(button).toBeVisible();
      await expect(upload).toBeVisible();
      failRead = false;
      await button.focus();
      await button.click();
      const busyRetry = panel.getByRole('button', { name: /^Loading…?$/ });
      await expect(busyRetry).toBeFocused();
      await expect(busyRetry).toHaveAttribute('aria-busy', 'true');
      await expect(busyRetry.locator('.mar-read-loading-indicator')).toBeVisible();
      await expect(spinner).toHaveCount(0);
      await expect(upload).toBeVisible();
      retry.resolve();
      await expect(busyRetry).toHaveCount(0);
      await expect(upload).toBeVisible();
      await expect(empty).toHaveCount(0);
    } finally {
      first.resolve();
      retry.resolve();
    }
  });

  test(`OAuth table owns read feedback with and without rows at ${width}px`, async ({
    page
  }, info) => {
    await setup(page, width, true);
    const first = Promise.withResolvers<void>();
    const refresh = Promise.withResolvers<void>();
    const populatedRefresh = Promise.withResolvers<void>();
    const provider = { providerKey: 'fixture', name: 'Fixture OAuth', bound: true };
    let reads = 0;
    await page.route('**/api/oauth-bindings', async (route) => {
      if (++reads === 1) {
        await first.promise;
        return json(
          route,
          { error: { code: 'TEMPORARY_FAILURE', message: 'OAuth bindings unavailable.' } },
          503
        );
      }
      if (reads === 2) {
        await refresh.promise;
        return json(route, { bindings: [] });
      }
      if (reads === 4) await populatedRefresh.promise;
      return json(route, { bindings: [provider] });
    });
    await page.goto(`${consoleUrl}console?view=settings&settings=account`);
    const table = page.locator('.oauth-bindings');
    const button = table.getByRole('button', { name: 'Refresh', exact: true });
    const noData = table.getByText('No data', { exact: true });
    await expect(table.getByRole('progressbar')).toBeVisible();
    await expect(noData).toHaveCount(0);
    await expect(table.locator('.mar-ui-loading')).toHaveCount(0);
    await capture(page, info, 'oauth-loading');
    first.resolve();
    const notice = page.locator('.mar-message--error');
    await expect(notice).toHaveCount(1);
    await expect(noData).toBeVisible();
    await expect(table.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await capture(page, info, 'oauth-failed');
    await notice.locator('.mar-message-close').click();
    await expect(notice).toHaveCount(0);
    await button.click();
    await expect(button).toBeDisabled();
    await expect(button.locator('[data-mar-icon="refresh"]')).toBeVisible();
    await expect(table.locator('tbody').getByRole('progressbar')).toBeVisible();
    await expect(noData).toHaveCount(0);
    await capture(page, info, 'oauth-refreshing');
    refresh.resolve();
    await expect(button).toBeEnabled();
    await expect(noData).toBeVisible();
    await expect(notice).toHaveCount(0);
    await capture(page, info, 'oauth-empty');

    await button.click();
    const row = table.getByRole('row').filter({ hasText: provider.name });
    await expect(row).toBeVisible();
    await button.click();
    await expect(table.locator('tbody').getByRole('progressbar')).toBeVisible();
    await expect(row).toBeVisible();
    await expect(button.locator('[data-mar-icon="refresh"]')).toBeVisible();
    await capture(page, info, 'oauth-refreshing-with-rows');
    populatedRefresh.resolve();
    await expect(button).toBeEnabled();
    await expect(table.getByRole('progressbar')).toHaveCount(0);
  });

  test(`Usage initial and manual reads share the table indicator at ${width}px`, async ({
    page
  }, info) => {
    await setup(page, width);
    const first = Promise.withResolvers<void>();
    const refresh = Promise.withResolvers<void>();
    let overviews = 0;
    const totals = {
      requests: '0',
      inputTokens: '0',
      cacheReadTokens: '0',
      cacheWriteTokens: '0',
      outputTokens: '0',
      reasoningTokens: '0',
      totalTokens: '0',
      unreportedRequests: '0'
    };
    await page.route('**/api/me/usage/**', async (route) => {
      if (!new URL(route.request().url()).pathname.endsWith('/overview'))
        return json(route, { records: [], total: '0', page: 1, nextCursor: null });
      if (++overviews === 1) {
        await first.promise;
        return json(
          route,
          { error: { code: 'TEMPORARY_FAILURE', message: 'Usage temporarily unavailable.' } },
          503
        );
      }
      await refresh.promise;
      return json(route, {
        asOf: Date.now(),
        availableFrom: null,
        firstRecordedAt: null,
        lastReceivedAt: null,
        last24Hours: totals,
        last7Days: totals,
        selected: totals,
        coverage: 'observed-only',
        buckets: [],
        runners: [],
        models: []
      });
    });
    await page.goto(`${consoleUrl}console?view=settings&settings=account`);
    if (width < 768) await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Usage statistics', exact: true }).click();
    const panel = page.getByTestId('usage-statistics');
    const button = panel.getByRole('button', { name: 'Refresh', exact: true });
    const records = panel.locator('.records');
    const loading = records.locator('tbody').getByRole('progressbar');
    await expect(loading).toBeVisible();
    await expect(panel.locator('.mar-ui-loading')).toHaveCount(0);
    await loading.scrollIntoViewIfNeeded();
    await capture(page, info, 'usage-loading');
    first.resolve();
    await expect(page.locator('.mar-message--error')).toHaveCount(1);
    await expect(records.getByText('No data', { exact: true })).toBeVisible();
    await expect(panel.getByText(/Select Refresh to try again/)).toHaveCount(0);
    await capture(page, info, 'usage-failed');
    await page.locator('.mar-message--error .mar-message-close').click();
    await button.click();
    await expect(button).toBeDisabled();
    await expect(button.locator('[data-mar-icon="refresh"]')).toBeVisible();
    await expect(loading).toBeVisible();
    await expect(records.getByText('No data', { exact: true })).toHaveCount(0);
    await expect(panel.locator('.mar-ui-loading')).toHaveCount(0);
    await loading.scrollIntoViewIfNeeded();
    await capture(page, info, 'usage-refreshing');
    refresh.resolve();
    await expect(panel.getByText('No recorded requests in this range.').first()).toBeVisible();
    await panel.locator('.records').scrollIntoViewIfNeeded();
    await expect(panel.locator('.records').getByText('No data', { exact: true })).toBeVisible();
    const alignment = await panel
      .locator('.records .mar-ui-table__viewport')
      .evaluate((viewport) => {
        const empty = viewport.querySelector('.mar-ui-table__empty-content')!;
        const offset = () => {
          const outer = viewport.getBoundingClientRect();
          const inner = empty.getBoundingClientRect();
          return Math.abs(outer.left + viewport.clientWidth / 2 - (inner.left + inner.width / 2));
        };
        const initial = offset();
        viewport.scrollLeft = viewport.scrollWidth;
        const scrolled = offset();
        viewport.scrollLeft = 0;
        return [initial, scrolled];
      });
    for (const offset of alignment) expect(offset).toBeLessThan(2);
    await capture(page, info, 'usage-empty');
  });

  for (const target of [
    {
      section: 'quick-prompts',
      label: 'Quick Prompts',
      api: 'quick-prompts',
      selector: '.quick-prompts',
      result: { prompts: [] },
      success: 'No quick prompts yet.'
    },
    {
      section: 'personal-instructions',
      label: 'Personal Instructions',
      api: 'personal-instructions',
      selector: '.personal-instructions',
      result: {
        instructions: {
          common: 'Keep responses concise.',
          codex: '',
          claudeCode: '',
          openCode: '',
          marAgent: ''
        }
      },
      success: 'Keep responses concise.'
    },
    {
      section: 'git',
      label: 'Git configuration',
      api: 'personal-git',
      selector: '.personal-git-settings',
      result: { configuration: { credentials: [] } },
      success: 'Add credential'
    }
  ]) {
    test(`${target.section} shows one in-place retry instead of a second page load at ${width}px`, async ({
      page
    }, info) => {
      await setup(page, width);
      const first = Promise.withResolvers<void>();
      const retry = Promise.withResolvers<void>();
      let reads = 0;
      await page.route(`**/api/${target.api}`, async (route) => {
        if (++reads === 1) {
          await first.promise;
          return json(
            route,
            { error: { code: 'TEMPORARY_FAILURE', message: 'Fixture read failed.' } },
            503
          );
        }
        await retry.promise;
        return json(route, target.result);
      });
      await page.goto(`${consoleUrl}console?view=settings&settings=account`);
      if (width < 768) await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: target.label, exact: true }).click();
      const panel = page.locator(target.selector);
      await expect(panel.locator('.mar-ui-loading')).toBeVisible();
      await capture(page, info, `${target.section}-initial-loading`);
      first.resolve();
      const button = panel.getByRole('button', { name: 'Retry', exact: true });
      await expect(button).toBeVisible();
      if (target.section !== 'personal-instructions') {
        const statusText = panel.getByRole('status').filter({ visible: true });
        await expect(button).toHaveCSS(
          'font-size',
          await statusText.evaluate((element) => getComputedStyle(element).fontSize)
        );
        await expect(button).toHaveCSS('border-top-width', '0px');
      }
      await expect(page.locator('.mar-message--error')).toHaveCount(0);
      await capture(page, info, `${target.section}-failed`);
      await button.focus();
      await button.click();
      const pending = panel.getByRole('button', { name: /^Loading…?$/u });
      await expect(pending).toBeFocused();
      await expect(pending).toHaveAttribute('aria-busy', 'true');
      await expect(pending.locator('.mar-read-loading-indicator')).toBeVisible();
      await pending.press('Enter');
      expect(reads).toBe(2);
      await expect(panel.locator('.mar-ui-loading')).toHaveCount(0);
      await capture(page, info, `${target.section}-retrying`);
      retry.resolve();
      await expect(pending).toHaveCount(0);
      if (target.section === 'personal-instructions') {
        await expect(panel.locator('textarea')).toHaveValue(target.success);
        await capture(page, info, `${target.section}-ready`);
      } else {
        await expect(panel.getByText(target.success, { exact: true })).toBeVisible();
        await capture(page, info, `${target.section}-empty`);
      }
    });
  }
}
