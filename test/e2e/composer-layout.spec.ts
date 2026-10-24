import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});
test.use({ deviceScaleFactor: 3 });

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Composer actions have a single visible circle: ${theme}`, async ({ page }, testInfo) => {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      for (const state of ['empty-input', 'ready', 'interrupt']) {
        await page.goto(
          `${fixture.url}visual-alignment.html?theme=${theme}&${state}${width < 768 ? '&mobile=1' : ''}`
        );
        const button = page.locator(
          state === 'interrupt' ? '.composer-stop-button' : '.composer-send-button'
        );
        await expect(button).toBeVisible();
        if (state === 'empty-input') await expect(button).toBeDisabled();
        else await expect(button).toBeEnabled();
        const style = await button.evaluate((element) => {
          const buttonStyle = getComputedStyle(element);
          const before = getComputedStyle(element, '::before');
          const after = getComputedStyle(element, '::after');
          return {
            background: buttonStyle.backgroundColor,
            radius: buttonStyle.borderRadius,
            width: element.getBoundingClientRect().width,
            height: element.getBoundingClientRect().height,
            before: before.content,
            after: after.content
          };
        });
        expect(style.before).toBe('none');
        expect(style.after).toBe('none');
        expect(style.background).not.toBe('rgba(0, 0, 0, 0)');
        expect(style.radius).toBe('50%');
        expect(style.width).toBe(style.height);
        if (width === 390 && state === 'empty-input') {
          await page.screenshot({ path: testInfo.outputPath('empty-send-mobile.png') });
        }
      }
    }
  });

  test(`New conversations show a centered, responsive welcome: ${theme}`, async ({
    page
  }, testInfo) => {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      for (const locale of ['en-US', 'zh-CN']) {
        for (const mode of ['workspace', 'hosted']) {
          await page.goto(
            `${fixture.url}visual-alignment.html?empty-conversation=${mode}&theme=${theme}&locale=${locale}${width < 768 ? '&mobile=1' : ''}`
          );
          const welcome = page.locator('.conversation-empty');
          const heading = welcome.locator('h2');
          await expect(heading).toHaveText(
            locale === 'zh-CN'
              ? mode === 'workspace'
                ? '想从哪里开始？'
                : '有什么可以帮你？'
              : mode === 'workspace'
                ? 'What would you like to work on?'
                : 'How can I help?'
          );
          await expect(welcome.locator('p')).not.toBeEmpty();
          const region = (await page.locator('.conversation-scroll').boundingBox())!;
          const title = (await heading.boundingBox())!;
          const description = (await welcome.locator('p').boundingBox())!;
          const centerY = (title.y + description.y + description.height) / 2;
          expect(Math.abs(centerY - (region.y + region.height / 2))).toBeLessThan(3);
          expect(title.x).toBeGreaterThanOrEqual(0);
          expect(description.x + description.width).toBeLessThanOrEqual(width);
          const composer = (await page.locator('.composer-host').boundingBox())!;
          expect(description.y + description.height).toBeLessThan(composer.y);
          await page.screenshot({
            path: testInfo.outputPath(`welcome-${mode}-${locale}-${width}.png`)
          });
          await page.getByRole('button', { name: 'Show first message' }).click();
          await expect(welcome).toHaveCount(0);
          await expect(page.getByText('First message', { exact: true })).toBeVisible();
        }
      }
    }
  });

  test(`Composer reserves its exact height without a mobile seam: ${theme}`, async ({
    page
  }, testInfo) => {
    for (const width of [390, 420, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        `${fixture.url}visual-alignment.html?hosted=1&theme=${theme}${width < 768 ? '&mobile=1' : ''}`
      );
      const host = page.locator('.composer-host');
      const composer = host.locator('> .composer');
      await expect(composer).toBeVisible();
      for (const height of [313.1875, 379.3125]) {
        await composer.evaluate((element, value) => {
          element.style.height = `${value}px`;
        }, height);
        await expect
          .poll(async () => {
            const reserved = (await host.boundingBox())!.height;
            const actual = (await composer.boundingBox())!.height;
            return Math.abs(reserved - actual);
          })
          .toBeLessThan(0.02);
      }
      await composer.evaluate((element) => element.style.removeProperty('height'));
      await expect
        .poll(async () => {
          const reserved = (await host.boundingBox())!.height;
          const actual = (await composer.boundingBox())!.height;
          return Math.abs(reserved - actual);
        })
        .toBeLessThan(0.02);
      await page.screenshot({ path: testInfo.outputPath(`composer-${width}.png`) });
    }
  });

  for (const width of [390, 420, 767, 768, 1280]) {
    test.describe(`Workbench Composer at ${width}px in ${theme}`, () => {
      test.use({
        viewport: { width, height: 844 },
        isMobile: width < 768,
        hasTouch: width < 768
      });

      test('keeps the conversation and Composer aligned without a seam', async ({
        page
      }, testInfo) => {
        await page.goto(`${fixture.url}workbench-style.html?composer=1&theme=${theme}`);
        const composer = page.locator('.composer');
        await expect(composer).toBeVisible();
        await expect(composer).toHaveCSS('position', width < 768 ? 'fixed' : 'relative');
        await expect(page.locator('.workspace-grid')).toHaveCSS(
          'border-bottom-width',
          width < 768 ? '0px' : '1px'
        );
        for (const height of [844, 560]) {
          await page.setViewportSize({ width, height });
          for (const composerHeight of [313.1875, 379.3125]) {
            await composer.evaluate((element, value) => {
              element.style.height = `${value}px`;
            }, composerHeight);
            await expect
              .poll(() =>
                composer.evaluate((element) => {
                  const actual = element.getBoundingClientRect();
                  const reserved = element.closest('.composer-host')!.getBoundingClientRect();
                  const reading = element
                    .closest('.conversation-panel')!
                    .querySelector('.conversation-scroll-region')!
                    .getBoundingClientRect();
                  return Math.max(
                    Math.abs(actual.top - reserved.top),
                    Math.abs(actual.bottom - reserved.bottom),
                    Math.abs(actual.top - reading.bottom)
                  );
                })
              )
              .toBeLessThan(0.02);
          }
        }
        await composer.evaluate((element) => element.style.removeProperty('height'));
        await page.setViewportSize({ width, height: 844 });
        await page.screenshot({ path: testInfo.outputPath('workbench-composer.png') });
      });
    });
  }
}
