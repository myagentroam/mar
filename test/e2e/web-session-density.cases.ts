import { expect, test, type Page } from '@playwright/test';
import { fulfillMockSessionWatch, json, mockConsoleApi } from './support/web-console-api.js';

async function measureRows(page: Page) {
  return page.locator('.session-list > li').evaluateAll((items) =>
    items.map((item) => {
      const row = item.querySelector<HTMLElement>('.session-row')!;
      const link = row.querySelector<HTMLElement>('.session-link')!;
      const title = row.querySelector<HTMLElement>('strong')!;
      const bounds = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      return {
        title: title.textContent,
        first: item.matches(':first-child'),
        item: bounds(item),
        row: bounds(row),
        minHeight: getComputedStyle(link).minHeight,
        paddingBlock: getComputedStyle(link).paddingBlock,
        fontSize: getComputedStyle(title).fontSize,
        fontWeight: getComputedStyle(title).fontWeight,
        titleBounds: bounds(title),
        titleScrollWidth: title.scrollWidth,
        titleClientWidth: title.clientWidth,
        parts: Array.from(
          row.querySelectorAll(
            '.mar-runner-brand-icon, .session-pin-indicator, .session-unread-label, .mar-session-activity i, time, .session-more-button'
          )
        ).map((part) => ({
          className: part.getAttribute('class'),
          bounds: bounds(part),
          fontSize: getComputedStyle(part).fontSize
        }))
      };
    })
  );
}

for (const locale of ['zh-CN', 'en-US']) {
  for (const theme of ['daylight', 'vscode-dark-2026']) {
    test(
      'Session list desktop density preserves states and mobile bounds: ' + locale + ', ' + theme,
      async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start', 'session.pin'], []);
        await page.addInitScript(
          ({ locale, theme }) => {
            localStorage.setItem('mar.locale.v2', locale);
            localStorage.setItem('mar.theme', theme);
          },
          { locale, theme }
        );
        const longTitle =
          locale === 'zh-CN'
            ? '检查工作区的长会话标题、运行状态及完整标题提示，确认单行省略仍然可读'
            : 'Inspect a long workspace session title, running status and the complete title tooltip';
        const now = Date.now();
        const sessions = [
          {
            id: 'session-1',
            runnerTitle: longTitle,
            runner: 'codex',
            pinOrder: 0,
            activity: 'MANAGED_ACTIVE'
          },
          {
            id: 'unread',
            runnerTitle: locale === 'zh-CN' ? '待阅读的会话' : 'Unread session',
            runner: 'claude-code',
            pinOrder: 1
          },
          {
            id: 'scheduled',
            runnerTitle: locale === 'zh-CN' ? '定时检查' : 'Scheduled check',
            runner: 'mar-agent',
            pinOrder: 2,
            schedule: { enabled: true, nextRunAt: now + 60_000 }
          },
          {
            id: 'plain',
            runnerTitle: locale === 'zh-CN' ? '普通会话' : 'Normal session',
            runner: 'opencode',
            pinOrder: null
          },
          { id: 'long-idle', runnerTitle: longTitle, runner: 'mar-agent', pinOrder: null }
        ].map((session) => ({
          workspaceId: 'workspace-1',
          externalSessionId: 'native:' + session.id,
          activity: 'IDLE',
          lastActivityAt: now - 300_000,
          control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] },
          runtime: {
            level: 'MANAGED',
            capabilities: ['history.read', 'turn.start', 'session.pin']
          },
          ...session
        }));
        await page.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/, (route) =>
          json(route, { sessions, nextCursor: null })
        );
        await page.route('**/api/agent-sessions/session-1?nodeId=node-1', (route) =>
          json(route, { session: sessions[0] })
        );
        await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
          fulfillMockSessionWatch(page, route, sessions[0]!, {
            kind: 'session-watch-snapshot',
            sequence: 1,
            session: sessions[0],
            runs: [
              {
                id: 'run-1',
                sessionId: 'session-1',
                workspaceId: 'workspace-1',
                status: 'RUNNING',
                recoveryState: 'ACTIVE'
              }
            ],
            queue: { version: 0, paused: false, items: [] },
            context: null,
            conversation: {
              unit: 'SEGMENT',
              source: 'official',
              segments: [],
              nextCursor: null,
              snapshotSequence: 1
            }
          })
        );
        await page.route('**/api/notifications', (route) =>
          json(route, {
            notifications: [
              {
                id: 'density-unread',
                kind: 'run',
                title: 'Completed',
                message: 'Ready to read',
                createdAt: now,
                updatedAt: now,
                expiresAt: now + 60_000,
                read: false,
                target: {
                  targetType: 'WORKSPACE_SESSION',
                  nodeId: 'node-1',
                  workspaceId: 'workspace-1',
                  sessionId: 'unread'
                }
              }
            ]
          })
        );
        await page.goto('/console');
        await page
          .getByRole('button', { name: locale === 'zh-CN' ? '进入控制台' : 'Open console' })
          .click();
        await page
          .getByRole('button', { name: locale === 'zh-CN' ? '工作' : 'Work', exact: true })
          .click();
        await page.locator('.workspace-tree .tree-node').first().click();
        await page.locator('.workspace-branch-button').first().click();
        const rows = page.locator('.session-row');
        const links = page.locator('.session-list .session-link');
        await expect(rows).toHaveCount(sessions.length);
        await links.first().click();
        await expect(rows.first()).toHaveClass(/selected/);
        await expect(rows.nth(1).locator('.session-unread-label')).toBeVisible();
        await expect(rows.first().locator('.mar-session-activity.managed_active')).toBeVisible();
        await expect(rows.nth(2).locator('.session-pin-indicator')).toBeVisible();
        await expect(links.first().locator('strong')).toHaveAttribute('title', longTitle);
        await expect(links.first().locator('strong')).toHaveCSS('text-overflow', 'ellipsis');
        await page.mouse.move(1279, 899);
        const environment = await page.evaluate(() => ({
          viewport: { width: innerWidth, height: innerHeight },
          devicePixelRatio,
          rootFontSize: getComputedStyle(document.documentElement).fontSize,
          bodyFontSize: getComputedStyle(document.body).fontSize,
          theme: document.documentElement.dataset.theme,
          lang: document.documentElement.lang
        }));
        const desktop = await measureRows(page);
        await page.screenshot({ path: testInfo.outputPath('desktop.png') });
        await page
          .locator('.conversation-sidebar')
          .screenshot({ path: testInfo.outputPath('desktop-list.png') });

        // Hover-only actions must not expand the compact row.
        await rows.nth(3).hover();
        const more = rows.nth(3).locator('.session-more-button');
        await expect(more).toBeVisible();
        const hovered = await measureRows(page);
        await more.click();
        await expect(page.locator('.session-action-menu:visible')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('desktop-menu.png') });
        await page.locator('.session-action-menu:visible').getByRole('menuitem').first().focus();
        await page.keyboard.press('Escape');
        await expect(page.locator('.session-action-menu:visible')).toHaveCount(0);
        await links.nth(3).focus();
        await page.keyboard.press('Tab');
        await expect(rows.nth(3).locator('.session-more-button')).toBeFocused();
        expect(
          await rows
            .nth(3)
            .locator('.session-more-button')
            .evaluate((button) => ({
              visible: button.matches(':focus-visible'),
              outline: getComputedStyle(button).outlineStyle
            }))
        ).toMatchObject({ visible: true, outline: 'solid' });
        await page.screenshot({ path: testInfo.outputPath('desktop-focus.png') });

        const mobile = [];
        for (const width of [767, 390]) {
          await page.setViewportSize({ width, height: 844 });
          await page
            .getByRole('button', {
              name: locale === 'zh-CN' ? '打开会话列表' : 'Open session list',
              exact: true
            })
            .click();
          await expect(links.first()).toBeVisible();
          // Visibility alone can pass while the drawer is still translated offscreen.
          await expect
            .poll(async () => (await page.locator('.conversation-sidebar').boundingBox())?.x)
            .toBe(0);
          await expect(page.locator('.conversation-sidebar')).toBeInViewport({ ratio: 1 });
          mobile.push({ width, rows: await measureRows(page) });
          await page.screenshot({ path: testInfo.outputPath('mobile-' + width + '.png') });
          await links.first().click();
          await expect(links.first()).toBeHidden();
        }
        await page.setViewportSize({ width: 768, height: 900 });
        await expect(links.first()).toBeVisible();
        const breakpoint = await measureRows(page);
        await testInfo.attach('render-measurements', {
          body: JSON.stringify(
            { locale, theme, environment, desktop, hovered, mobile, breakpoint },
            null,
            2
          ),
          contentType: 'application/json'
        });

        expect(environment.rootFontSize).toBe('17.6px');
        expect(environment.bodyFontSize).toBe('14px');
        for (const row of [...desktop, ...hovered, ...breakpoint]) {
          expect(row.minHeight).toBe('32px');
          expect(row.fontSize).toBe('14px');
          expect(row.fontWeight).toBe('400');
          expect(row.row.height).toBeCloseTo(32, 1);
          expect(row.item.height).toBeCloseTo(row.first ? 37 : 34, 1);
          for (const part of row.parts) {
            expect(part.bounds.x).toBeGreaterThanOrEqual(row.row.x);
            expect(part.bounds.x + part.bounds.width).toBeLessThanOrEqual(
              row.row.x + row.row.width
            );
            expect(part.bounds.y).toBeGreaterThanOrEqual(row.row.y);
            expect(part.bounds.y + part.bounds.height).toBeLessThanOrEqual(
              row.row.y + row.row.height
            );
            expect(
              Math.abs(part.bounds.y + part.bounds.height / 2 - (row.row.y + row.row.height / 2))
            ).toBeLessThanOrEqual(1);
            if (part.className === 'session-relative-time') expect(part.fontSize).toBe('12px');
            if (part.className?.includes('mar-runner-brand-icon'))
              expect(part.bounds.height).toBeCloseTo(14.42, 1);
          }
          const time = row.parts.find((part) => part.className === 'session-relative-time')!;
          expect(row.titleBounds.width).toBeGreaterThan(0);
          expect(row.titleBounds.x + row.titleBounds.width).toBeLessThanOrEqual(time.bounds.x);
        }
        expect(desktop[0]!.titleScrollWidth).toBeGreaterThan(desktop[0]!.titleClientWidth);
        for (const sample of mobile) {
          for (const row of sample.rows) {
            expect(row.minHeight).toBe('32px');
            expect(row.fontSize).toBe('13px');
            expect(row.fontWeight).toBe('400');
            expect(row.row.height).toBeCloseTo(32, 1);
            expect(row.item.height).toBeCloseTo(row.first ? 37 : 34, 1);
          }
        }
      }
    );
  }
}
