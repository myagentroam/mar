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
        expect(style.width).toBe(width < 768 ? 28 : 24);
        if (width >= 768) {
          const buttonBox = (await button.boundingBox())!;
          const toolbarBox = (await page.locator('.composer-toolbar').boundingBox())!;
          expect(
            toolbarBox.x + toolbarBox.width - buttonBox.x - buttonBox.width
          ).toBeGreaterThanOrEqual(12);
        }
        if (width === 390 && state === 'empty-input') {
          await page.screenshot({ path: testInfo.outputPath('empty-send-mobile.png') });
        }
        if (width === 1280 && state === 'interrupt') {
          await page.screenshot({ path: testInfo.outputPath('interrupt-desktop.png') });
        }
      }
    }
  });

  test(`New conversations show a responsive Composer startup layout: ${theme}`, async ({
    page
  }, testInfo) => {
    for (const width of [320, 390, 1280]) {
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
                ? 'Where to start?'
                : 'How can I help?'
          );
          await expect(welcome.locator('p')).not.toBeEmpty();
          const region = (await page.locator('.conversation-scroll').boundingBox())!;
          const title = (await heading.boundingBox())!;
          const titleLineHeight = await heading.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).lineHeight)
          );
          expect(title.height).toBeLessThanOrEqual(titleLineHeight + 1);
          const description = (await welcome.locator('p').boundingBox())!;
          const composerHost = (await page.locator('.composer-host').boundingBox())!;
          const composer = (await page.locator('.composer').boundingBox())!;
          if (width < 768) {
            const centerY = (title.y + description.y + description.height) / 2;
            expect(Math.abs(centerY - (region.y + region.height / 2))).toBeLessThan(3);
            expect(composer.y + composer.height).toBe(844);
          } else {
            const header = (await page.locator('header').boundingBox())!;
            const availableCenter = (header.y + header.height + 844) / 2;
            const startupCenter = (region.y + composerHost.y + composerHost.height) / 2;
            expect(Math.abs(startupCenter - availableCenter)).toBeLessThan(3);
            expect(composerHost.width).toBeLessThanOrEqual(800);
            expect(composerHost.x).toBeGreaterThan(0);
            await expect(page.locator('.conversation-scroll-region')).toHaveClass(/is-empty/);
          }
          expect(title.x).toBeGreaterThanOrEqual(0);
          expect(description.x + description.width).toBeLessThanOrEqual(width);
          expect(description.y + description.height).toBeLessThan(composerHost.y);
          await page.screenshot({
            path: testInfo.outputPath(`welcome-${mode}-${locale}-${width}.png`)
          });
          await page.locator('.composer-input').fill('Keep this draft');
          await page.getByRole('button', { name: 'Show first message' }).click();
          const composerLocator = page.locator('.composer-host');
          if (width >= 768) {
            const moving = await page.waitForFunction(() => {
              const host = document.querySelector('.composer-host');
              const animation = host?.getAnimations()[0];
              if (!(host instanceof HTMLElement) || animation === undefined) return false;
              animation.pause();
              animation.currentTime = 90;
              return true;
            });
            await moving.dispose();
            const during = (await composerLocator.boundingBox())!;
            expect(during.y).toBeGreaterThan(composerHost.y + 1);
            expect(during.y + during.height).toBeLessThan(844);
            await composerLocator.evaluate((element) => {
              for (const animation of element.getAnimations()) void animation.play();
            });
          } else {
            expect(
              await composerLocator.evaluate((element) => element.getAnimations().length)
            ).toBe(0);
          }
          await expect(welcome).toHaveCount(0);
          await expect(page.getByText('First message', { exact: true })).toBeVisible();
          await expect(page.locator('.conversation-scroll-region')).not.toHaveClass(/is-empty/);
          await expect(page.locator('.composer-input')).toHaveValue('Keep this draft');
          await expect
            .poll(async () => {
              const bounds = (await composerLocator.boundingBox())!;
              return bounds.y + bounds.height;
            })
            .toBe(844);
        }
      }
    }
  });

  test(`Composer startup respects reduced motion: ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const mode of ['workspace', 'hosted']) {
      await page.goto(
        `${fixture.url}visual-alignment.html?empty-conversation=${mode}&theme=${theme}`
      );
      await page.getByRole('button', { name: 'Show first message' }).click();
      await expect(page.locator('.conversation-empty')).toHaveCount(0);
      expect(
        await page.locator('.composer-host').evaluate((element) => element.getAnimations().length)
      ).toBe(0);
    }
  });

  test(`Composer startup cancels motion when returning to draft: ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.goto(
      `${fixture.url}visual-alignment.html?empty-conversation=workspace&theme=${theme}`
    );
    const composer = page.locator('.composer-host');
    await page.getByRole('button', { name: 'Show first message' }).click();
    await page.waitForFunction(() => {
      return document.querySelector('.composer-host')?.getAnimations().length === 1;
    });
    await page.getByRole('button', { name: 'Show empty draft' }).click();
    await expect(page.locator('.conversation-empty')).toBeVisible();
    expect(await composer.evaluate((element) => element.getAnimations().length)).toBe(0);
    const header = (await page.locator('header').boundingBox())!;
    const region = (await page.locator('.conversation-scroll').boundingBox())!;
    const host = (await composer.boundingBox())!;
    const availableCenter = (header.y + header.height + 844) / 2;
    expect(Math.abs((region.y + host.y + host.height) / 2 - availableCenter)).toBeLessThan(3);
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
