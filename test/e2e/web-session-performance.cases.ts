import { expect, test } from '@playwright/test';
import {
  emitMockSessionEvent,
  fulfillMockSessionWatch,
  json,
  mockConsoleApi
} from './support/web-console-api.js';

test('Workspace-wide Info shows only realtime performance and does not reopen after session switching', async ({
  page
}, testInfo) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  const sessions = ['session-1', 'session-2'].map((id) => ({
    id,
    workspaceId: 'workspace-1',
    runner: 'codex',
    runnerTitle: id,
    externalSessionId: `native-${id}`,
    nativeControl: 'MAR_MANAGED',
    model: 'gpt-5.6-sol',
    effort: 'high',
    access: 'workspace-write',
    activity: 'IDLE',
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
  }));
  await page.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/, (route) =>
    json(route, { sessions, nextCursor: null })
  );
  for (const session of sessions) {
    await page.route(`**/api/agent-sessions/${session.id}?nodeId=node-1`, (route) =>
      json(route, { session })
    );
    await page.route(`**/api/agent-sessions/${session.id}/context?nodeId=node-1`, (route) =>
      json(route, { context: null })
    );
    await page.route(`**/api/agent-sessions/${session.id}/watch*`, async (route) => {
      if (route.request().method() === 'DELETE') {
        await json(route, { unwatched: true });
        return;
      }
      await fulfillMockSessionWatch(page, route, session, {
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
          snapshotSequence: 1,
          nextCursor: null,
          segments: [
            {
              id: `turn-${session.id}:segment:0`,
              turnId: `turn-${session.id}`,
              sessionId: session.id,
              index: 0,
              runId: null,
              status: 'SUCCEEDED',
              startedAt: 1,
              completedAt: 2,
              items: [
                {
                  id: `reply-${session.id}`,
                  turnId: `turn-${session.id}`,
                  sessionId: session.id,
                  runId: null,
                  kind: 'assistant_message',
                  status: 'COMPLETED',
                  parentItemId: null,
                  sourceSequence: null,
                  revision: 1,
                  startedAt: 1,
                  completedAt: 2,
                  payload: {
                    text: `History ${session.id}`,
                    format: 'markdown',
                    model: null,
                    performance: { ttftMs: 99, tokensPerSecond: 99 }
                  }
                }
              ]
            }
          ]
        }
      });
    });
  }
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();
  await expect(page.getByText('History session-1', { exact: true })).toBeVisible();
  const info = page.locator('.session-performance-info');
  await expect(info).toHaveCount(0);
  await expect(page.locator('.conversation-message-performance')).toHaveCount(0);

  await emitMockSessionEvent(page, 'conversation', {
    sessionId: 'session-1',
    performance: { runId: 'run-1', ttftMs: 420, tokensPerSecond: 42 }
  });
  await expect(info).toBeVisible();
  await expect(info).toHaveAttribute('aria-label', /420 ms.*42\.0 token\/s/);
  await info.focus();
  await expect(page.getByRole('tooltip').filter({ hasText: '420 ms' })).toBeVisible();
  expect(
    await info.evaluate((element) => {
      const icon = element.getBoundingClientRect();
      const region = element.closest('.conversation-scroll-region')!.getBoundingClientRect();
      return (
        icon.width <= 32 &&
        icon.height <= 32 &&
        region.right - icon.right >= 0 &&
        region.right - icon.right <= 25 &&
        region.bottom - icon.bottom >= 0 &&
        region.bottom - icon.bottom <= 25
      );
    })
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('session-performance.png') });

  await emitMockSessionEvent(page, 'conversation', {
    sessionId: 'session-1',
    performance: { runId: 'run-1', tokensPerSecond: 20 }
  });
  await expect(info).toHaveAttribute('aria-label', /20\.0 token\/s/);
  await expect(info).not.toHaveAttribute('aria-label', /420 ms/);
  await page.locator('.session-list .session-link').nth(1).click();
  await expect(page.getByText('History session-2', { exact: true })).toBeVisible();
  await expect(info).toHaveCount(0);
  await page.locator('.session-list .session-link').first().click();
  await expect(page.getByText('History session-1', { exact: true })).toBeVisible();
  await expect(info).toHaveCount(0);
  await emitMockSessionEvent(page, 'conversation', {
    sessionId: 'session-1',
    performance: { runId: 'run-2', ttftMs: 600 }
  });
  await expect(info).toHaveAttribute('aria-label', /600 ms/);
});
