import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/session-groups.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const { width, locale, description, count } of [
  {
    width: 1280,
    locale: 'en-US',
    description: 'Workspace has an active task',
    count: 'Active tasks: 2'
  },
  { width: 390, locale: 'zh-CN', description: '工作区有活动任务', count: '活动任务：2' }
]) {
  test(`Stopping tasks use green activity markers and accurate descriptions: ${locale}`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.goto(`${fixture.url}session-groups.html?locale=${locale}&theme=dark&cancelling`);
    const activity = page.locator('.activity-center-trigger');
    await expect(activity).toHaveAccessibleDescription(new RegExp(`^${count},`));
    await expect(activity.locator('.activity-entry-running')).toHaveCSS(
      'background-color',
      'rgb(53, 213, 110)'
    );
    const workspace = page.getByRole('tab', { name: 'Project', exact: true });
    await expect(workspace).toHaveAccessibleDescription(description);
    await expect(workspace.locator('.workspace-tab-running i')).toHaveCSS(
      'background-color',
      'rgb(53, 213, 110)'
    );
    await activity.click();
    await page
      .locator('.activity-tabs:visible')
      .getByRole('tab', { name: locale === 'zh-CN' ? '最近会话' : 'Recent Sessions', exact: true })
      .click();
    await expect(page.locator('.activity-running-count')).toHaveText(count);

    await page.goto(`${fixture.url}session-groups.html?locale=${locale}&theme=dark&stop-statuses`);
    await expect(activity.locator('.activity-entry-running')).toHaveCount(0);
    await expect(workspace.locator('.workspace-tab-running')).toHaveCount(0);
  });
}

for (const theme of ['daylight', 'dark', 'custom']) {
  test(`Session and Workspace running markers match the static activity badge: ${theme}`, async ({
    page
  }, testInfo) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 850 });
      await page.goto(`${fixture.url}session-groups.html?locale=en-US&theme=${theme}`);
      const session = page.locator('.session-row .mar-session-activity');
      const workspace = page.locator('.workspace-tab-running');
      const badge = page.locator('.activity-entry-running');
      await expect(session).toHaveAttribute('aria-label', 'Working');
      await expect(
        page.getByRole('tab', { name: 'Project', exact: true })
      ).toHaveAccessibleDescription('Workspace has an active task');
      await expect(badge).toBeVisible();

      if (theme === 'custom') {
        await page.evaluate(() => {
          document.documentElement.style.setProperty('--mar-conversation-activity-fg', '#854e9a');
          document.documentElement.style.setProperty('--mar-control-color-success', '#23834a');
        });
        await expect(badge).toHaveCSS('background-color', 'rgb(35, 131, 74)');
      }
      const badgeStyle = await badge.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          color: style.backgroundColor,
          width: style.width,
          height: style.height,
          radius: style.borderRadius,
          shadow: style.boxShadow
        };
      });
      expect(badgeStyle.width).toBe('6px');
      expect(badgeStyle.height).toBe('6px');
      expect(badgeStyle.shadow).not.toBe('none');

      for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        await page.emulateMedia({ reducedMotion });
        for (const marker of [session.locator('i'), workspace.locator('i'), badge]) {
          await expect(marker).toBeVisible();
          await expect(marker).toHaveCSS('background-color', badgeStyle.color);
          await expect(marker).toHaveCSS('width', badgeStyle.width);
          await expect(marker).toHaveCSS('height', badgeStyle.height);
          await expect(marker).toHaveCSS('border-radius', badgeStyle.radius);
          await expect(marker).toHaveCSS('animation-name', 'none');
          await expect(marker).toHaveCSS('opacity', '1');
        }
        for (const marker of [session.locator('i'), workspace.locator('i')]) {
          await expect(marker).toHaveCSS('box-shadow', 'none');
        }
      }

      await page.locator('.session-row').hover();
      await expect(session.locator('i')).toHaveCSS('background-color', badgeStyle.color);
      await page
        .locator('.conversation-sidebar')
        .getByRole('radio', { name: 'Child Sessions', exact: true })
        .click();
      await expect(page.locator('.session-row')).toHaveCount(1);
      await expect(session).toHaveAttribute('aria-label', 'Working');
      await expect(session.locator('i')).toHaveCSS('animation-name', 'none');
      await expect(session.locator('i')).toHaveCSS('box-shadow', 'none');
      await page.locator('.fixture').screenshot({
        path: testInfo.outputPath(`static-running-markers-${width}.png`)
      });
    }
  });
}
