import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  emitMockSessionEvent,
  fulfillMockSessionWatch,
  json,
  mockConsoleApi
} from './support/web-console-api.js';

const sessionIds = ['session-1', 'session-2'] as const;

function createRun(sessionId: string, id: string, startedAt: number) {
  return {
    id,
    sessionId,
    workspaceId: 'workspace-1',
    status: 'RUNNING',
    recoveryState: 'ACTIVE',
    version: 2,
    clientMessageId: `message-${id}`,
    startedAt,
    createdAt: startedAt
  };
}

function historySegment(sessionId: string) {
  const turnId = `history-${sessionId}`;
  return {
    id: `${turnId}:segment:0`,
    turnId,
    sessionId,
    index: 0,
    runId: null,
    status: 'SUCCEEDED',
    startedAt: 1,
    completedAt: 2,
    items: [
      {
        id: `reply-${sessionId}`,
        turnId,
        sessionId,
        runId: null,
        kind: 'assistant_message',
        status: 'COMPLETED',
        parentItemId: null,
        sourceSequence: null,
        revision: 1,
        startedAt: 1,
        completedAt: 2,
        payload: {
          text: `History ${sessionId}`,
          format: 'markdown',
          model: null,
          performance: { latencyMs: 99, tokensPerSecond: 99 }
        }
      }
    ]
  };
}

function runSegment(sessionId: string, run: ReturnType<typeof createRun>) {
  const turnId = `turn-${run.id}`;
  return {
    id: `${turnId}:segment:0`,
    turnId,
    sessionId,
    index: 0,
    runId: run.id,
    status: 'RUNNING',
    startedAt: run.startedAt,
    items: [
      {
        id: `user-${run.id}`,
        kind: 'user_message',
        status: 'COMPLETED',
        startedAt: run.startedAt,
        completedAt: run.startedAt + 1,
        payload: { text: `Current run ${run.id}`, contexts: [], delivery: 'ACCEPTED' }
      },
      {
        id: `reasoning-${run.id}`,
        kind: 'reasoning',
        status: 'COMPLETED',
        startedAt: run.startedAt + 2,
        completedAt: run.startedAt + 3,
        processGroup: { id: `${run.id}-reasoning`, isStart: true },
        payload: {
          representation: 'summary',
          sections: [{ index: 0, text: `Prepare ${run.id}` }]
        }
      },
      {
        id: `tool-${run.id}`,
        kind: 'tool_call',
        status: 'COMPLETED',
        startedAt: run.startedAt + 4,
        completedAt: run.startedAt + 5,
        processGroup: { id: `${run.id}-verification`, isStart: true },
        payload: { toolName: 'read', input: { path: 'src/main.ts' } }
      }
    ]
  };
}

function conversationSegments(sessionId: string, runs: readonly ReturnType<typeof createRun>[]) {
  return [historySegment(sessionId), ...runs.map((run) => runSegment(sessionId, run))];
}

async function expectFullWidthProcessHeading(process: Locator) {
  const processBounds = await process.boundingBox();
  const rowBounds = await process.locator('.process-heading-row').boundingBox();
  expect(processBounds).not.toBeNull();
  expect(rowBounds).not.toBeNull();
  expect(rowBounds!.x).toBeCloseTo(processBounds!.x, 1);
  expect(rowBounds!.width).toBeCloseTo(processBounds!.width, 1);
}

async function expectMetricsAndInfoOnSameLine(metrics: Locator, info: Locator) {
  const metricsBounds = await metrics.boundingBox();
  const infoBounds = await info.boundingBox();
  expect(metricsBounds).not.toBeNull();
  expect(infoBounds).not.toBeNull();
  expect(
    Math.abs(
      metricsBounds!.y + metricsBounds!.height / 2 - (infoBounds!.y + infoBounds!.height / 2)
    )
  ).toBeLessThanOrEqual(2);
  expect(infoBounds!.x).toBeGreaterThanOrEqual(metricsBounds!.x + metricsBounds!.width);
  expect(infoBounds!.height).toBeLessThanOrEqual(metricsBounds!.height);
  const iconBounds = await info.locator('[data-mar-icon="info"]').boundingBox();
  expect(iconBounds).not.toBeNull();
  expect(iconBounds!.width).toBeCloseTo(12, 1);
  expect(iconBounds!.height).toBeCloseTo(12, 1);
  expect(
    Math.abs(iconBounds!.y + iconBounds!.height / 2 - (infoBounds!.y + infoBounds!.height / 2))
  ).toBeLessThanOrEqual(1);
}

async function publishRun(
  page: Page,
  sessionId: string,
  run: ReturnType<typeof createRun>,
  runs: readonly ReturnType<typeof createRun>[]
) {
  await emitMockSessionEvent(page, 'run', { run });
  const turn = {
    id: `turn-${run.id}`,
    sessionId,
    runId: run.id,
    status: 'RUNNING',
    items: []
  };
  await emitMockSessionEvent(page, 'conversation', {
    sessionId,
    turn,
    segments: conversationSegments(sessionId, runs)
  });
}

async function openSessionPerformancePage(
  page: Page,
  theme: string,
  viewport: { width: number; height: number }
) {
  await page.setViewportSize(viewport);
  await page.addInitScript(
    (value) => {
      localStorage.setItem('mar.theme', value.theme);
      localStorage.setItem('mar.locale.v2', 'zh-CN');
    },
    { theme }
  );
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);

  const sessions = sessionIds.map((id, index) => ({
    id,
    workspaceId: 'workspace-1',
    runner: 'codex',
    runnerTitle: id,
    externalSessionId: `native-${id}`,
    nativeControl: 'MAR_MANAGED',
    modelId: 'gpt-5.6-sol',
    effort: 'high',
    access: 'workspace-write',
    activity: 'IDLE',
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
  }));
  const context = {
    model: 'GPT-5.6 Sol',
    usedTokens: 156_000,
    maxTokens: 258_400,
    percentage: 60.4
  };

  await page.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/u, (route) =>
    json(route, { sessions, nextCursor: null })
  );
  for (const session of sessions) {
    const { id } = session;
    await page.route(`**/api/agent-sessions/${id}?nodeId=node-1`, (route) =>
      json(route, { session })
    );
    await page.route(`**/api/agent-sessions/${id}/context?nodeId=node-1`, (route) =>
      json(route, { context })
    );
    await page.route(`**/api/agent-sessions/${id}/watch*`, async (route) => {
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
        context,
        conversation: {
          unit: 'SEGMENT',
          source: 'official',
          readAt: 1,
          latestVisibleAt: 2,
          snapshotSequence: 1,
          nextCursor: null,
          segments: conversationSegments(id, [])
        }
      });
    });
  }

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台', exact: true }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/u })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();
  await expect(page.getByText('History session-1', { exact: true })).toBeVisible();
  return sessionIds.map((id, index) =>
    createRun(id, index === 0 ? 'run-1' : `run-${id}`, index + 3)
  );
}

for (const theme of ['vscode-dark-2026', 'daylight'] as const) {
  test(`Session performance follows the latest Run and keeps independent metrics: ${theme}`, async ({
    browser,
    page
  }, testInfo) => {
    test.setTimeout(60_000);
    const initialRuns = await openSessionPerformancePage(page, theme, {
      width: 1920,
      height: 900
    });
    const initialRun = initialRuns[0]!;
    const processBlocks = page.locator('.conversation-process.is-group');
    const info = page.locator('.session-performance-info');
    await expect(page.locator('.conversation-message-performance')).toHaveCount(0);
    await expect(info).toHaveCount(0);
    await expect(processBlocks).toHaveCount(0);
    await publishRun(page, 'session-1', initialRun, [initialRun]);
    await expect(processBlocks).toHaveCount(2);

    const initialPerformance = {
      runId: initialRun!.id,
      latencyMs: 420,
      tokensPerSecond: 42,
      usage: { inputTokens: '24000', outputTokens: '1280', cacheReadTokens: '19200' }
    };
    await emitMockSessionEvent(page, 'conversation', {
      sessionId: 'session-1',
      performance: initialPerformance
    });

    const latestBlock = processBlocks.last();
    const heading = latestBlock.locator('.process-heading');
    const inline = latestBlock.locator('.process-performance');
    await expect(info).toHaveCount(1);
    await expect(processBlocks.first().locator('.session-performance-info')).toHaveCount(0);
    await expect(latestBlock.locator('.session-performance-info')).toHaveCount(1);
    await expect(page.locator('.conversation-message-performance')).toHaveCount(0);
    await expect(inline).toContainText('Latency: 420 ms · TPS: 42.0');
    await expect(inline).not.toContainText(/Input:|Output:|Cache Hit Rate:/u);
    await expectMetricsAndInfoOnSameLine(inline, info);
    await expectFullWidthProcessHeading(latestBlock);

    const headingRow = latestBlock.locator('.process-heading-row');
    await heading.hover();
    await expect
      .poll(() => headingRow.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe('rgba(0, 0, 0, 0)');
    const rowHoverBackground = await headingRow.evaluate(
      (element) => getComputedStyle(element).backgroundColor
    );
    expect(await heading.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
      'rgba(0, 0, 0, 0)'
    );
    const rowBounds = await headingRow.boundingBox();
    const headingBounds = await heading.boundingBox();
    const infoBounds = await info.boundingBox();
    expect(rowBounds).not.toBeNull();
    expect(headingBounds).not.toBeNull();
    expect(infoBounds).not.toBeNull();
    expect(rowBounds!.height).toBeLessThanOrEqual(headingBounds!.height);
    expect(infoBounds!.x + infoBounds!.width).toBeLessThanOrEqual(rowBounds!.x + rowBounds!.width);
    await page.screenshot({
      path: testInfo.outputPath(`session-performance-row-${theme}.png`),
      animations: 'disabled'
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await expectFullWidthProcessHeading(latestBlock);
    await expectMetricsAndInfoOnSameLine(inline, info);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await heading.hover();
    await page.screenshot({
      path: testInfo.outputPath(`session-performance-row-narrow-${theme}.png`),
      animations: 'disabled'
    });
    await info.hover();
    expect(await headingRow.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
      rowHoverBackground
    );
    expect(await info.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
      'rgba(0, 0, 0, 0)'
    );

    const buttonIsIndependent = await info.evaluate(
      (element) =>
        element instanceof HTMLButtonElement &&
        element.closest('button') === element &&
        element.closest('.process-heading') === null
    );
    expect(buttonIsIndependent).toBe(true);
    const tooltip = page.getByRole('tooltip').filter({ hasText: 'Cache Hit Rate: 80.0%' });
    await heading.click();
    await expect(heading).toHaveAttribute('aria-expanded', 'false');
    await info.click();
    await expect(heading).toHaveAttribute('aria-expanded', 'false');
    await page.mouse.move(5, 5);
    await info.hover();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(
      'Latency: 420 ms · TPS: 42.0\nInput: 24,000 · Output: 1,280 · Cache Hit Rate: 80.0%'
    );
    await page.screenshot({
      path: testInfo.outputPath(`session-performance-${theme}.png`),
      animations: 'disabled'
    });
    await page.mouse.move(5, 5);
    await heading.focus();
    await page.keyboard.press('Tab');
    await expect(info).toBeFocused();
    await expect(info).toHaveAttribute('aria-label', /Latency: 420 ms · TPS: 42\.0/u);
    await page.keyboard.press('Space');
    await expect(heading).toHaveAttribute('aria-expanded', 'false');

    await emitMockSessionEvent(page, 'conversation', {
      sessionId: 'session-1',
      performance: { runId: initialRun!.id, latencyMs: 500 }
    });
    await expect(inline).toContainText('Latency: 500 ms · TPS: 42.0');
    await expect(tooltip).toContainText('Input: 24,000 · Output: 1,280 · Cache Hit Rate: 80.0%');
    await emitMockSessionEvent(page, 'conversation', {
      sessionId: 'session-1',
      performance: { runId: initialRun!.id, tokensPerSecond: 20 }
    });
    await expect(inline).toContainText('Latency: 500 ms · TPS: 20.0');

    const newerRun = createRun('session-1', 'run-1-next', 10);
    await publishRun(page, 'session-1', newerRun, [initialRun, newerRun]);
    await emitMockSessionEvent(page, 'conversation', {
      sessionId: 'session-1',
      performance: { runId: newerRun.id, tokensPerSecond: 24 }
    });

    const updatedBlocks = page.locator('.conversation-process.is-group');
    const newestBlock = updatedBlocks.last();
    const newestInfo = newestBlock.locator('.session-performance-info');
    await expect(updatedBlocks).toHaveCount(4);
    await expect(updatedBlocks.nth(0).locator('.session-performance-info')).toHaveCount(0);
    await expect(updatedBlocks.nth(1).locator('.session-performance-info')).toHaveCount(0);
    await expect(updatedBlocks.nth(2).locator('.session-performance-info')).toHaveCount(0);
    await expect(newestInfo).toHaveCount(1);
    await expect(newestBlock.locator('.process-performance')).toHaveText('· TPS: 24.0');
    await expect(newestInfo).not.toHaveAttribute(
      'aria-label',
      /Latency:|Input:|Output:|Cache Hit Rate:/u
    );
    const newestTooltip = page.getByRole('tooltip').filter({ hasText: 'TPS: 24.0' });
    await newestBlock.locator('.process-heading').focus();
    await page.keyboard.press('Tab');
    await expect(newestInfo).toBeFocused();
    await expect(newestTooltip).toHaveText('TPS: 24.0');

    await emitMockSessionEvent(page, 'conversation', {
      sessionId: 'session-1',
      performance: { runId: newerRun.id, latencyMs: 700 }
    });
    await expect(newestBlock.locator('.process-performance')).toContainText(
      'Latency: 700 ms · TPS: 24.0'
    );
    await expect(newestTooltip).toHaveText('Latency: 700 ms · TPS: 24.0');

    await emitMockSessionEvent(page, 'conversation', {
      sessionId: 'session-1',
      performance: { runId: newerRun.id, usage: { inputTokens: '30000' } }
    });
    await expect(newestBlock.locator('.process-performance')).toContainText(
      'Latency: 700 ms · TPS: 24.0'
    );
    await expect(newestTooltip).toHaveText(
      'Latency: 700 ms · TPS: 24.0\nInput: 30,000 · Output: — · Cache Hit Rate: —'
    );
    const completedRun = {
      ...newerRun,
      status: 'SUCCEEDED',
      version: 3,
      completedAt: 20,
      updatedAt: 20
    };
    await emitMockSessionEvent(page, 'run', { run: completedRun });
    await expect(newestInfo).toBeVisible();
    await expect(newestBlock.locator('.process-performance')).toContainText(
      'Latency: 700 ms · TPS: 24.0'
    );
    await expect(newestTooltip).toHaveText(
      'Latency: 700 ms · TPS: 24.0\nInput: 30,000 · Output: — · Cache Hit Rate: —'
    );

    await page.locator('.session-list .session-link').nth(1).click();
    await expect(page.getByText('History session-2', { exact: true })).toBeVisible();
    await expect(info).toHaveCount(0);
    await publishRun(page, 'session-2', initialRuns[1]!, [initialRuns[1]!]);
    await emitMockSessionEvent(page, 'conversation', {
      sessionId: 'session-2',
      performance: {
        runId: initialRuns[1]!.id,
        usage: { inputTokens: '100', outputTokens: '20', cacheReadTokens: '80' }
      }
    });
    const secondSessionInfo = page.locator('.session-performance-info');
    await expect(secondSessionInfo).toHaveCount(1);
    const secondSessionTooltip = page.getByRole('tooltip').filter({ hasText: 'Input: 100' });
    const secondSessionHeading = page
      .locator('.conversation-process.is-group')
      .last()
      .locator('.process-heading');
    await secondSessionHeading.focus();
    await page.keyboard.press('Tab');
    await expect(secondSessionInfo).toBeFocused();
    await expect(secondSessionTooltip).toHaveText(
      'Input: 100 · Output: 20 · Cache Hit Rate: 80.0%'
    );
    await expect(secondSessionInfo).not.toHaveAttribute('aria-label', /700 ms|24\.0|Latency:/u);
    await expect(page.locator('.process-performance')).toHaveCount(0);
    await page.locator('.session-list .session-link').first().click();
    await expect(page.getByText('History session-1', { exact: true })).toBeVisible();
    await expect(info).toHaveCount(0);

    if (testInfo.project.name === 'chromium') {
      const mobileContext = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        locale: 'zh-CN'
      });
      try {
        const mobilePage = await mobileContext.newPage();
        const mobileRuns = await openSessionPerformancePage(mobilePage, theme, {
          width: 1280,
          height: 844
        });
        await mobilePage.setViewportSize({ width: 390, height: 844 });
        const mobileRun = mobileRuns[0]!;
        await publishRun(mobilePage, 'session-1', mobileRun, [mobileRun]);
        await emitMockSessionEvent(mobilePage, 'conversation', {
          sessionId: 'session-1',
          performance: initialPerformance
        });
        const mobileBlock = mobilePage.locator('.conversation-process.is-group').last();
        const mobileHeading = mobileBlock.locator('.process-heading');
        const mobileInfo = mobileBlock.locator('.session-performance-info');
        const mobileMetrics = mobileBlock.locator('.process-performance');
        await expect(mobileInfo).toBeVisible();
        await expect(mobileMetrics).toContainText('Latency: 420 ms · TPS: 42.0');
        await expectMetricsAndInfoOnSameLine(mobileMetrics, mobileInfo);
        await expectFullWidthProcessHeading(mobileBlock);
        expect(mobileRun.id).toBe(initialPerformance.runId);
        await expect
          .poll(() => mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
          .toBe(true);
        const mobileBounds = await mobileInfo.boundingBox();
        expect(mobileBounds).not.toBeNull();
        expect(mobileBounds!.x).toBeGreaterThanOrEqual(0);
        expect(mobileBounds!.x + mobileBounds!.width).toBeLessThanOrEqual(390);
        await mobileHeading.click();
        await expect(mobileHeading).toHaveAttribute('aria-expanded', 'false');
        await mobilePage.touchscreen.tap(
          mobileBounds!.x + mobileBounds!.width / 2,
          mobileBounds!.y + mobileBounds!.height / 2
        );
        const mobileTooltip = mobilePage
          .getByRole('tooltip')
          .filter({ hasText: 'Cache Hit Rate: 80.0%' });
        await expect(mobileTooltip).toBeVisible();
        await expect(mobileHeading).toHaveAttribute('aria-expanded', 'false');
        await mobilePage.screenshot({
          path: testInfo.outputPath(`session-performance-mobile-${theme}.png`),
          animations: 'disabled'
        });
      } finally {
        await mobileContext.close();
      }
    }
  });
}
