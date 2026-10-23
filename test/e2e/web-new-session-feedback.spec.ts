import { expect, test } from '@playwright/test';
import { fulfillMockSessionWatch, json, mockConsoleApi } from './support/web-console-api.js';

for (const { width, theme, lateSuccess } of [
  { width: 1280, theme: 'daylight', lateSuccess: false },
  { width: 390, theme: 'vscode-dark-2026', lateSuccess: true }
]) {
  test(`New session feedback preserves the Composer through submission and recovery at ${width}px`, async ({
    page
  }, testInfo) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width, height: 844 });
    if (width === 390) await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript((value) => localStorage.setItem('mar.theme', value), theme);
    await mockConsoleApi(
      page,
      'MANAGED',
      ['history.read', 'turn.start'],
      [],
      'GIT_WORKSPACE',
      true,
      'IDLE'
    );
    const session = {
      id: 'feedback-session',
      workspaceId: 'workspace-1',
      runner: 'codex',
      externalSessionId: 'feedback-native-session',
      activity: 'MANAGED_ACTIVE',
      control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start', 'turn.interrupt'] }
    };
    const run = {
      id: 'feedback-run',
      sessionId: session.id,
      workspaceId: session.workspaceId,
      status: 'STARTING',
      recoveryState: 'ACTIVE',
      startedAt: Date.now(),
      clientMessageId: 'feedback-message'
    };
    const requests: ((success: boolean) => void)[] = [];
    const bodies: unknown[] = [];
    await page.route('**/api/agent-sessions/start', async (route) => {
      bodies.push(route.request().postDataJSON());
      const success = await new Promise<boolean>((resolve) => requests.push(resolve));
      return success
        ? json(route, { session, run, delivery: 'STARTED' })
        : json(
            route,
            { error: { code: 'RUNNER_UNAVAILABLE', message: 'Runner unavailable' } },
            503
          );
    });
    let releaseWatch!: () => void;
    const watchReady = new Promise<void>((resolve) => (releaseWatch = resolve));
    await page.route('**/api/agent-sessions/feedback-session/watch*', async (route) => {
      await watchReady;
      return fulfillMockSessionWatch(page, route, session, {
        kind: 'session-watch-snapshot',
        sequence: 1,
        session,
        runs: [run],
        queue: { version: 0, paused: false, items: [] },
        context: null,
        conversation: {
          unit: 'SEGMENT',
          source: 'official',
          readAt: 1,
          latestVisibleAt: 2,
          nextCursor: null,
          snapshotSequence: 1,
          segments: [
            {
              id: 'feedback-turn:segment:0',
              sessionId: session.id,
              turnId: 'feedback-turn',
              runId: run.id,
              index: 0,
              status: 'RUNNING',
              startedAt: run.startedAt,
              completedAt: null,
              items: [
                {
                  id: 'feedback-user',
                  sessionId: session.id,
                  turnId: 'feedback-turn',
                  runId: run.id,
                  parentItemId: null,
                  sourceSequence: null,
                  revision: 1,
                  kind: 'user_message',
                  status: 'COMPLETED',
                  startedAt: run.startedAt,
                  completedAt: run.startedAt,
                  payload: { text: 'First message feedback', format: 'plain' }
                }
              ]
            }
          ]
        }
      });
    });
    await page.goto('/console');
    await page.getByRole('button', { name: '进入控制台' }).click();
    await page.getByRole('button', { name: '工作', exact: true }).click();
    const tree = page.locator('.workspace-tree');
    await tree.getByRole('button', { name: /node-1/ }).click();
    await tree.getByRole('button', { name: 'project', exact: true }).click();
    if (theme === 'daylight') await expect(page.locator('html')).not.toHaveClass(/dark/u);
    else await expect(page.locator('html')).toHaveClass(/dark/u);
    const input = page.getByRole('textbox', { name: '输入消息' });
    const send = page.locator('.composer-send-button');
    const shell = page.locator('.composer-shell');
    await input.fill('First message feedback');
    const before = await shell.boundingBox();
    const background = await shell.evaluate((element) => getComputedStyle(element).backgroundColor);

    for (const success of [false, true]) {
      const count = requests.length;
      await send.click();
      await expect.poll(() => requests.length).toBe(count + 1);
      await expect(input).toBeEditable();
      await expect(input).toHaveValue('First message feedback');
      await expect(send).toBeVisible();
      await expect(send).toBeDisabled();
      await expect(send).toHaveAttribute('aria-busy', 'true');
      await expect(send.locator('.is-loading')).toBeVisible();
      if (width === 390)
        await expect(send.locator('.is-loading')).toHaveCSS('animation-name', 'none');
      await expect(page.locator('.composer-runner-select')).toBeVisible();
      await expect(page.locator('.composer-runner-select .el-select__wrapper')).toHaveClass(
        /is-disabled/u
      );
      await expect(page.locator('.composer-working')).toHaveCount(0);
      await expect(page.locator('.conversation-message')).toHaveCount(0);
      await expect(shell).toHaveCSS('background-color', background);
      const pending = await shell.boundingBox();
      expect(pending!.height).toBeCloseTo(before!.height, 0);
      expect(pending!.width).toBeCloseTo(before!.width, 0);
      expect(pending!.y).toBeCloseTo(before!.y, 0);
      await page.screenshot({
        path: testInfo.outputPath(`sending-${success ? 'retry' : 'first'}.png`)
      });
      if (width === 390) {
        await input.press('Enter');
        await expect(input).toHaveValue('First message feedback\n');
        await input.fill('First message feedback');
      } else await input.press('Enter');
      expect(requests).toHaveLength(count + 1);
      let requestIndex = count;
      if (success) {
        await expect(page.locator('.el-message').filter({ hasText: '发送确认超时' })).toBeVisible({
          timeout: 7_000
        });
        await expect(input).toBeEditable();
        await expect(send).toBeEnabled();
        await expect(page.locator('.composer-runner-select .el-select__wrapper')).toHaveClass(
          /is-disabled/u
        );
        await send.click();
        await expect.poll(() => requests.length).toBe(count + 2);
        expect(bodies[count + 1]).toEqual(bodies[count]);
        const lateResponse = page.waitForResponse((candidate) =>
          candidate.url().endsWith('/api/agent-sessions/start')
        );
        requests[count]!(lateSuccess);
        expect((await lateResponse).status()).toBe(lateSuccess ? 200 : 503);
        await expect(send).toHaveAttribute('aria-busy', 'true');
        await expect(input).toHaveValue(lateSuccess ? '' : 'First message feedback');
        await expect(page.locator('.el-message').filter({ hasText: '无法发送消息' })).toHaveCount(
          0
        );
        requestIndex = count + 1;
      }
      const response = page.waitForResponse(
        (candidate) =>
          candidate.url().endsWith('/api/agent-sessions/start') &&
          candidate.request().method() === 'POST'
      );
      requests[requestIndex]!(success);
      expect((await response).status()).toBe(success ? 200 : 503);
      if (!success) {
        await expect(send).not.toHaveAttribute('aria-busy', 'true');
        expect(pageErrors).toEqual([]);
        const failure = page.locator('.el-message').filter({ hasText: '无法发送消息' });
        await expect(failure).toBeVisible();
        await expect(failure).toContainText('RUNNER_UNAVAILABLE');
        await expect(input).toHaveValue('First message feedback');
        await expect(send).toBeEnabled();
      }
    }
    await expect(input).toHaveValue('');
    await expect(page.locator('.composer-working')).toBeVisible();
    await expect(page.locator('.composer-working')).toContainText('同步');
    await expect(page.locator('.conversation-message')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('syncing-before-snapshot.png') });
    releaseWatch();
    await expect(page.locator('.conversation-message')).toContainText('First message feedback');
    await expect(page.locator('.composer-working')).toBeVisible();
    await expect(page.locator('.composer-working')).not.toContainText('同步');
  });
}

test('Session activity does not hide synchronization feedback before the initial Watch snapshot', async ({
  page
}) => {
  await mockConsoleApi(
    page,
    'MANAGED',
    ['history.read', 'turn.start'],
    [],
    'GIT_WORKSPACE',
    true,
    'MANAGED_ACTIVE'
  );
  let releaseWatch!: () => void;
  const watchReady = new Promise<void>((resolve) => (releaseWatch = resolve));
  await page.route('**/api/agent-sessions/session-1/watch*', async (route) => {
    await watchReady;
    return route.fallback();
  });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  const tree = page.locator('.workspace-tree');
  await tree.getByRole('button', { name: /node-1/ }).click();
  await tree.getByRole('button', { name: 'project', exact: true }).click();
  await page.locator('.session-list .session-link').first().click();
  await expect(page.locator('.composer-working')).toContainText('同步');
  await expect(page.locator('.composer-elapsed')).toHaveCount(0);
  releaseWatch();
  await expect(page.locator('.composer-working')).toBeVisible();
  await expect(page.locator('.composer-working')).not.toContainText('同步');
});
