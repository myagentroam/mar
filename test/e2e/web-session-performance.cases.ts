import { expect, test } from '@playwright/test';
import {
  emitMockSessionEvent,
  fulfillMockSessionWatch,
  json,
  mockConsoleApi
} from './support/web-console-api.js';

for (const theme of ['vscode-dark-2026', 'daylight'] as const) {
  test(`Workspace-wide Info shares utility hover and shows only realtime performance after session switching: ${theme}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript((value) => {
      localStorage.setItem('mar.theme', value);
      localStorage.setItem('mar.locale.v2', 'zh-CN');
    }, theme);
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    const context = {
      model: 'GPT-5.6 Sol',
      usedTokens: 156_000,
      maxTokens: 258_400,
      percentage: 60.4
    };
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
        json(route, { context })
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
          context,
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
                      performance: { latencyMs: 99, tokensPerSecond: 99 }
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
      performance: { runId: 'run-1', latencyMs: 420, tokensPerSecond: 42 }
    });
    await expect(info).toBeVisible();
    await expect(info).toHaveAttribute('aria-label', /420 ms.*42\.0 token\/s/);
    const controls = [
      {
        button: page.locator('.web-performance-indicator'),
        popup: page.locator('.web-performance-panel')
      },
      { button: info, popup: page.getByRole('tooltip').filter({ hasText: '420 ms' }) }
    ];
    const idleColors: string[] = [];
    const hoverColors: string[] = [];
    const focusColors: string[] = [];
    const focusOutlines: string[] = [];
    for (const [index, { button, popup }] of controls.entries()) {
      idleColors.push(await button.evaluate((element) => getComputedStyle(element).color));
      const icon = button.locator('.el-icon');
      await button.hover();
      await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(button).toHaveCSS('border-width', '0px');
      await expect(icon).toHaveCSS('transform', 'none');
      await expect(icon).toHaveCSS('width', '16px');
      await expect(icon).toHaveCSS('height', '16px');
      await expect(icon).toHaveCSS('font-size', '16px');
      hoverColors.push(await button.evaluate((element) => getComputedStyle(element).color));
      await page.mouse.move(600, 5);
      await page.keyboard.press('Tab');
      await button.focus();
      await expect(button).toBeFocused();
      await expect(button).toHaveCSS('outline-style', 'solid');
      await expect(button).toHaveCSS('outline-width', '2px');
      await expect(button).toHaveCSS('outline-offset', '2px');
      await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(icon).toHaveCSS('transform', 'none');
      await expect(popup).toBeVisible();
      if (index === 0) await page.screenshot({ path: testInfo.outputPath('diagnostic-focus.png') });
      focusColors.push(await button.evaluate((element) => getComputedStyle(element).color));
      focusOutlines.push(
        await button.evaluate((element) => getComputedStyle(element).outlineColor)
      );
    }
    expect(idleColors[0]).toBe(idleColors[1]);
    expect(hoverColors[0]).toBe(hoverColors[1]);
    expect(hoverColors[0]).not.toBe(idleColors[0]);
    expect(focusColors).toEqual(hoverColors);
    expect(focusOutlines[0]).toBe(focusOutlines[1]);
    for (const button of [
      page.locator('.composer-context-button'),
      page.locator('.composer-attachment-button'),
      page.locator('.session-search-button')
    ]) {
      await button.focus();
      await expect(button).toBeFocused();
      await expect(button).toHaveCSS('color', hoverColors[0]!);
      await expect(button).toHaveCSS('outline-color', focusOutlines[0]!);
      await expect(button).toHaveCSS('outline-style', 'solid');
      await expect(button).toHaveCSS('outline-width', '2px');
      await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(button).toHaveCSS('transform', 'none');
      await button.hover();
      await expect(button).toHaveCSS('color', hoverColors[0]!);
      await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(button).toHaveCSS('transform', 'none');
      await page.mouse.move(600, 5);
    }
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
    await expect(info).toHaveAttribute('aria-label', /420 ms.*20\.0 token\/s/);
    await emitMockSessionEvent(page, 'conversation', {
      sessionId: 'session-1',
      performance: { runId: 'run-2', tokensPerSecond: 24 }
    });
    await expect(info).toHaveAttribute('aria-label', /24\.0 token\/s/);
    await expect(info).not.toHaveAttribute('aria-label', /420 ms/);
    await page.locator('.session-list .session-link').nth(1).click();
    await expect(page.getByText('History session-2', { exact: true })).toBeVisible();
    await expect(info).toHaveCount(0);
    await page.locator('.session-list .session-link').first().click();
    await expect(page.getByText('History session-1', { exact: true })).toBeVisible();
    await expect(info).toHaveCount(0);
    await emitMockSessionEvent(page, 'conversation', {
      sessionId: 'session-1',
      performance: { runId: 'run-3', latencyMs: 600 }
    });
    await expect(info).toHaveAttribute('aria-label', /600 ms/);
  });
}
