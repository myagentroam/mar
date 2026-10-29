import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/conversation-tool-detail.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const width of [1280, 390]) {
  test(`execution details, copy and terminal replacement at ${width}px`, async ({
    browser
  }, testInfo) => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      permissions: ['clipboard-read', 'clipboard-write']
    });
    try {
      const page = await context.newPage();
      await page.goto(`${fixture.url}conversation-tool-detail.html`);
      const exec = page.getByTestId('exec');
      await exec.locator('summary').click();
      await expect(exec).toContainText('visible stdout');
      await expect(exec).toContainText('visible stderr');
      await expect(exec).not.toContainText('combined should not replace streams');
      const copyButton = exec.getByRole('button', { name: 'Copy public record' });
      await expect(copyButton).toHaveText('');
      await expect(exec).not.toContainText('may be truncated');
      for (const pre of await exec.locator('pre').all()) {
        await expect(pre).toHaveCSS('border-top-width', '0px');
        await expect(pre).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(pre).toHaveCSS('max-height', 'none');
      }
      const detailBox = await exec.locator('.tool-detail').boundingBox();
      const copyBox = await copyButton.boundingBox();
      expect(
        Math.abs(copyBox!.x + copyBox!.width + 8 - detailBox!.x - detailBox!.width)
      ).toBeLessThan(2);
      expect(copyBox!.y - detailBox!.y).toBeLessThan(12);

      await exec.getByRole('button', { name: 'Copy public record' }).click();
      await expect(page.getByTestId('copied')).toContainText('exec-a');
      const copied = JSON.parse((await page.getByTestId('copied').textContent()) ?? '{}');
      expect(copied.id).toBe('exec-a');
      expect(copied.payload.command).toBe('printf test');
      await expect(exec.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
      await page.getByTestId('empty').locator('summary').click();
      await expect(page.getByTestId('empty').locator('pre')).not.toContainText('Output:');
      await expect(page.getByTestId('empty')).not.toContainText('No output');
      await expect(page.getByTestId('empty')).not.toContainText('stderr');
      await page.getByTestId('generic').locator('summary').click();
      await expect(page.getByTestId('generic').locator('pre')).toHaveText(
        'Details: Inspect fixture\nInput: Preserved input\nOutput:\nPartial inspection output\nTruncated\nProgress: Stopped at the last file\nError: INSPECTION_FAILED'
      );
      await page.getByTestId('wait').locator('summary').click();
      await expect(page.getByTestId('wait')).toContainText('Wait failed');
      await page.getByTestId('declined').locator('summary').click();
      await expect(page.getByTestId('declined')).toContainText('Declined');
      await expect(page.getByTestId('declined')).not.toContainText(
        'toolPresentation.detail.DECLINED'
      );
      await page.getByTestId('finish').click();
      await expect(exec).toContainText('TAIL');
      await expect(exec).toContainText('Truncated');
      await expect(exec.locator('pre')).toHaveText(/Truncated\nExit code: 0$/);
      await expect(exec).not.toContainText('visible stdout');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
      await page.screenshot({
        path: testInfo.outputPath(`execution-${width}.png`),
        fullPage: true
      });
      await page.getByTestId('fail-copy').click();
      await exec.getByRole('button', { name: 'Copy public record' }).click();
      await expect(page.getByTestId('copy-error')).toHaveText('true');
    } finally {
      await context.close();
    }
  });
}

for (const width of [1280, 390]) {
  for (const theme of ['daylight', 'dark']) {
    test(`tool details blend into the timeline at ${width}px in ${theme}`, async ({
      browser
    }, testInfo) => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        const page = await context.newPage();
        await page.goto(
          `${fixture.url}conversation-tool-detail.html?timeline=1&long=1&unified=1&theme=${theme}`
        );
        const process = page.locator('.process-heading').first();
        if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
        const group = page.locator('.conversation-record-group').filter({ hasText: 'Command' });
        await group.locator(':scope > summary').click();
        const command = page.locator('.conversation-command-detail');
        await command.locator(':scope > summary').click();
        const detail = command.locator('.tool-detail');
        await expect(detail).toContainText('visible stdout');
        await expect(detail).toContainText('visible stderr');
        await expect(detail.locator('pre')).toHaveCount(1);
        await expect(detail.locator('strong, dl, dt, dd')).toHaveCount(0);
        await expect(detail.locator('pre')).toContainText('Code: observe.result(await tools.exec(');
        await expect(detail.locator('pre')).toContainText(
          'Output:\nvisible stdout\nstderr:\nvisible stderr'
        );
        await expect(detail).not.toContainText('Working directory:');
        await expect(detail).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        const textBounds = await detail.locator('pre').boundingBox();
        const titleBounds = await command.locator('.conversation-command-preview').boundingBox();
        expect(Math.abs(textBounds!.x - titleBounds!.x)).toBeLessThan(3);
        await expect(detail.locator('pre')).toHaveCSS('font-weight', '400');

        await expect
          .poll(() =>
            detail.evaluate((element) => {
              const output = element.querySelector('pre');
              if (!output) return false;
              const bottom = output.getBoundingClientRect().bottom;
              for (let parent = element.parentElement; parent; parent = parent.parentElement) {
                if (
                  ['hidden', 'clip'].includes(getComputedStyle(parent).overflowY) &&
                  parent.getBoundingClientRect().bottom < bottom - 1
                )
                  return false;
              }
              return true;
            })
          )
          .toBe(true);

        const button = detail.getByRole('button', { name: 'Copy public record' });
        await expect(button).toHaveText('');
        const bounds = await detail.boundingBox();
        const copyBounds = await button.boundingBox();
        expect(
          Math.abs(copyBounds!.x + copyBounds!.width + 8 - bounds!.x - bounds!.width)
        ).toBeLessThan(2);
        for (const pre of await detail.locator('pre').all()) {
          await expect(pre).toHaveCSS('border-top-width', '0px');
          await expect(pre).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
          await expect(pre).toHaveCSS('overflow-y', 'visible');
          await expect(pre).toHaveCSS('overflow-x', 'visible');
          await expect(pre).toHaveCSS('max-height', 'none');
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true
        );
        const reasoning = page.locator('.reasoning-group');
        await reasoning.locator('summary').click();
        const thinking = reasoning.locator('.conversation-detail-text');
        const thinkingBounds = await thinking.boundingBox();
        const reasoningTitleBounds = await reasoning.locator('summary strong').boundingBox();
        expect(Math.abs(thinkingBounds!.x - reasoningTitleBounds!.x)).toBeLessThan(3);
        const thinkingStyle = await thinking.evaluate((element) => ({
          fontSize: getComputedStyle(element).fontSize,
          lineHeight: getComputedStyle(element).lineHeight,
          color: getComputedStyle(element).color,
          expectedColor: getComputedStyle(element.closest('.conversation-item')!).color,
          background: getComputedStyle(element.parentElement!).backgroundColor
        }));
        expect(thinkingStyle.color).toBe(thinkingStyle.expectedColor);
        const read = page.locator('[data-tool-presentation="READ"]');
        await read.locator(':scope > summary').click();
        await read.locator('.conversation-tool-detail > summary').click();
        for (const kind of ['WEB_SEARCH', 'WEB_FETCH'])
          await page.locator(`[data-tool-presentation="${kind}"] > summary`).click();
        const subagent = page.locator('.subagent-group');
        await subagent.locator('.conversation-record-group > summary').click();
        await subagent.locator('.conversation-tool-detail > summary').click();
        const generic = page.locator('.tool-group:not(:has([data-tool-presentation="READ"]))');
        await generic.locator('.conversation-record-group > summary').click();
        await generic.locator('.conversation-tool-detail > summary').click();
        await expect(generic.locator('.conversation-detail-text')).toHaveText(
          'Details: Inspect fixture\nInput: Preserved input\nOutput:\nPartial inspection output\nTruncated\nProgress: Stopped at the last file\nError: INSPECTION_FAILED'
        );
        const surfaces = page.locator('.conversation-detail-body');
        await expect(surfaces).toHaveCount(7);
        for (const surface of await surfaces.all()) {
          await expect(surface).toHaveCSS('background-color', thinkingStyle.background);
          const radius = await surface.evaluate((element) =>
            getComputedStyle(element).getPropertyValue('--mar-radius-surface').trim()
          );
          await expect(surface).toHaveCSS('border-radius', radius);
          await expect(surface.locator(':scope > .conversation-detail-text')).toHaveCSS(
            'font-size',
            thinkingStyle.fontSize
          );
          await expect(surface.locator(':scope > .conversation-detail-text')).toHaveCSS(
            'line-height',
            thinkingStyle.lineHeight
          );
          await expect(surface).toHaveCSS('overflow-y', 'visible');
        }
        await expect(page.locator('.conversation-tool-sources a')).toHaveAttribute(
          'href',
          'https://example.com/docs'
        );
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true
        );
        await page.setViewportSize({ width, height: 1600 });
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
        await page.screenshot({
          path: testInfo.outputPath(`timeline-${theme}-${width}.png`),
          fullPage: true
        });
      } finally {
        await context.close();
      }
    });
  }
}
