import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/settings-layout.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

const sections = [
  { id: 'appearance', selector: '.full', title: 'h2' },
  { id: 'account', selector: '.full', title: 'h2' },
  { id: 'usage', selector: '.usage-content', title: 'h2' },
  { id: 'custom-themes', selector: '.theme-settings', title: 'h2' },
  { id: 'notifications', selector: '.full', title: 'h2' },
  { id: 'quick-prompts', selector: '.quick-prompts-content', title: 'h2' },
  { id: 'personal-instructions', selector: '.personal-instructions', title: 'h2' },
  { id: 'git', selector: '.mar-management-page', title: 'h2' },
  { id: 'registration', selector: '.full', title: 'h2' },
  { id: 'shortcuts', selector: '.full', title: 'h2' },
  { id: 'about', selector: '.about-settings', title: '.system-brand' }
] as const;

for (const theme of ['daylight', 'vscode-dark-2026']) {
  for (const { width, locale } of [
    { width: 1920, locale: 'en-US' },
    { width: 1440, locale: 'zh-CN' },
    { width: 390, locale: 'zh-CN' },
    { width: 320, locale: 'en-US' }
  ]) {
    test(`Personal settings share full-width geometry in ${theme} at ${width}px`, async ({
      page
    }) => {
      test.setTimeout(90_000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize({ width, height: 900 });
      for (const section of sections) {
        await test.step(section.id, async () => {
          await page.goto(
            `${fixture.url}settings-layout.html?section=${section.id}&theme=${theme}&locale=${locale}`
          );
          const content = page.locator('.settings-content');
          const panel = content.locator(section.selector).first();
          const title = panel.locator(section.title).first();
          await expect(title).toBeVisible();
          const inset = await page.evaluate(() =>
            Math.round(
              parseFloat(getComputedStyle(document.documentElement).fontSize) *
                (innerWidth < 768 ? 0.75 : 1)
            )
          );
          await expect
            .poll(async () => {
              const outer = (await content.boundingBox())!;
              const inner = (await panel.boundingBox())!;
              const heading = (await title.boundingBox())!;
              return {
                left: Math.round(inner.x - outer.x),
                right: Math.round(outer.x + outer.width - inner.x - inner.width),
                textInset: Math.round(heading.x - outer.x),
                overflow: await content.evaluate(
                  (element) => element.scrollWidth > element.clientWidth
                )
              };
            })
            .toEqual({ left: 0, right: 0, textInset: inset, overflow: false });

          if (section.id === 'appearance') {
            const row = content.locator('.theme-row').first();
            const control = row.locator('.el-select');
            const label = row.locator('label');
            const bounds = (await row.boundingBox())!;
            const input = (await control.boundingBox())!;
            if (width > 767) {
              const rootFontSize = await page.evaluate(() =>
                parseFloat(getComputedStyle(document.documentElement).fontSize)
              );
              expect(bounds.width).toBeLessThanOrEqual(rootFontSize * 36);
              expect(input.width).toBeLessThan(320);
              expect(Math.abs(bounds.x + bounds.width - input.x - input.width)).toBeLessThan(2);
            } else {
              const text = (await label.boundingBox())!;
              expect(input.y).toBeGreaterThanOrEqual(text.y + text.height);
            }
            for (const select of await content.locator('.theme-row .el-select').all()) {
              expect((await select.boundingBox())!.width).toBeCloseTo(input.width, 0);
            }
          }
          if (section.id === 'custom-themes') {
            const editor = content.locator('.json-editor');
            const preview = content.locator('.editor-layout > aside');
            await expect(editor).toBeVisible();
            const left = (await editor.boundingBox())!;
            const right = (await preview.boundingBox())!;
            if (width < 768) expect(right.y).toBeGreaterThanOrEqual(left.y + left.height);
            else expect(right.x).toBeGreaterThanOrEqual(left.x + left.width);
          }
          if (section.id === 'notifications' && width > 767) {
            const channels = content.locator('.system-notification-control');
            const rootFontSize = await page.evaluate(() =>
              parseFloat(getComputedStyle(document.documentElement).fontSize)
            );
            expect((await channels.boundingBox())!.width).toBeLessThanOrEqual(rootFontSize * 36);
          }
          if (section.id === 'personal-instructions') {
            await expect(content.getByRole('textbox')).toHaveValue(
              'Keep changes focused. Explain important decisions and verify the result.'
            );
          }
          await page.screenshot({
            path: test.info().outputPath(`${section.id}-${theme}-${width}.png`)
          });
        });
      }
      expect(errors).toEqual([]);
    });
  }
}

test('Settings navigation and theme editor respond to the available content width', async ({
  page
}) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto(`${fixture.url}settings-layout.html?section=appearance&theme=daylight`);
  await page.getByRole('button', { name: 'Themes', exact: true }).click();
  const content = page.locator('.settings-content');
  await expect(content.locator('.theme-settings')).toBeVisible();
  const editor = content.locator('.json-editor');
  const preview = content.locator('.editor-layout > aside');
  const containerWidth = await content.locator('.theme-settings').evaluate((element) => {
    const style = getComputedStyle(element);
    return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  });
  // Desktop rem scaling produces fractional widths: both sides of the breakpoint must be covered.
  await page.setViewportSize({ width: Math.floor(1000 - containerWidth + 760), height: 900 });
  await expect
    .poll(async () => {
      const left = (await editor.boundingBox())!;
      const right = (await preview.boundingBox())!;
      return right.y >= left.y + left.height;
    })
    .toBe(true);
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await expect
    .poll(async () => {
      const left = (await editor.boundingBox())!;
      const right = (await preview.boundingBox())!;
      return right.x >= left.x + left.width;
    })
    .toBe(true);
});
