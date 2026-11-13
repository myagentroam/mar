import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;

for (const [width, theme] of [
  [1280, 'daylight'],
  [390, 'dark']
] as const) {
  test(`latest file changes follow the final reply and disappear on the next round (${width}px, ${theme})`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${fixture.url}conversation-style.html?file-change-result&theme=${theme}`);
    const process = page.locator('[data-process-id="result-process"]');
    const heading = process.locator(':scope > .process-heading');
    await expect(heading).toBeVisible();
    if ((await heading.getAttribute('aria-expanded')) === 'false') await heading.click();
    await expect(process.locator('.conversation-file-change-details')).toBeVisible();
    await process.locator('.file-change-group').evaluate((element) => {
      (element as HTMLElement).dataset.originalFileCard = 'preserved';
    });
    await page.getByTestId('finish-file-result').click();
    const reply = page
      .locator('.assistant_message')
      .filter({ hasText: 'File-change result final reply' });
    const changes = reply.locator('..').locator('.file-change-group');
    await expect(reply).toBeVisible();
    await expect(changes).toHaveCount(1);
    await expect(process.locator('.file-change-group')).toHaveAttribute(
      'data-original-file-card',
      'preserved'
    );
    expect(
      await reply.evaluate((element) =>
        element.nextElementSibling?.classList.contains('file-change-group')
      )
    ).toBe(true);
    const details = changes.locator('.conversation-file-change-details');
    if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open)))
      await details.locator(':scope > summary').click();
    await changes.getByRole('button', { name: /src\/current\.ts/u }).click();
    await expect(page.getByTestId('result-opened-file')).toHaveText('src/current.ts');
    if ((await heading.getAttribute('aria-expanded')) === 'true') await heading.click();
    await expect(changes.locator('.conversation-file-change-list')).toBeVisible();
    await page.mouse.move(0, 0);
    await page
      .locator('.conversation-timeline')
      .screenshot({ path: testInfo.outputPath(`file-change-result-${width}-${theme}.png`) });
    await page.getByTestId('backfill-file-result').click();
    await expect(changes).toHaveCount(1);
    await expect(changes.getByRole('button', { name: /src\/older\.ts/u })).toBeVisible();
    await expect(changes.getByRole('button', { name: /src\/current\.ts/u })).toHaveCount(1);
    await page.getByTestId('next-file-result-round').click();
    await expect(page.getByText('Next round request', { exact: true })).toBeVisible();
    await expect(reply.locator('..').locator('.file-change-group')).toHaveCount(0);
    await heading.click();
    await expect(process.locator('.conversation-file-change-details')).toBeVisible();
    await expect(page.locator('.file-change-group')).toHaveCount(1);
  });
}

test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/conversation-style.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const [width, reducedMotion] of [
  [1280, 'no-preference'],
  [390, 'reduce']
] as const) {
  test(`collapsing a parent releases only its descendants' disclosure state (${width}px, ${reducedMotion})`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion });
    await page.goto(`${fixture.url}conversation-style.html?disclosure-reset=1`);
    const first = page.locator('[data-process-id="first"]');
    const second = page.locator('[data-process-id="second"]');
    for (const process of [first, second]) {
      await process.locator(':scope > .process-heading').click();
      await expect(process.locator('.conversation-record-group')).toHaveCount(4);
      for (const group of await process.locator('.conversation-record-group').all()) {
        await group.locator(':scope > summary').click();
        const child = group.locator(':scope > details');
        await expect(child).toHaveCount(1);
        await child.locator(':scope > summary').click();
        await expect(child).toHaveAttribute('open', '');
        await expect(child.locator('.tool-detail')).toHaveCount(1);
      }
      await process.locator('.reasoning-group > details > summary').click();
      await expect(process.locator('.reasoning-group .mar-conversation-detail-body')).toHaveCount(
        1
      );
      await process.locator('.conversation-file-change-details > summary').click();
      await expect(process.locator('.conversation-file-change-list')).toHaveCount(1);
    }

    const groups = first.locator('.conversation-record-group');
    for (const group of await groups.all()) {
      await group.locator(':scope > summary').click();
      await expect(group.locator(':scope > details')).toHaveCount(0);
      await group.locator(':scope > summary').click();
      await expect(group.locator(':scope > details')).toHaveCount(1);
      await expect(group.locator(':scope > details[open]')).toHaveCount(0);
      await expect(group.locator('.tool-detail')).toHaveCount(0);
      await group.locator(':scope > details > summary').click();
      await expect(group.locator('.tool-detail')).toHaveCount(1);
    }

    await first.locator(':scope > .process-heading').click();
    await expect(first.locator('.process-content')).toHaveCount(0);
    await expect(second.locator('details[open]')).toHaveCount(10);
    await first.locator(':scope > .process-heading').click();
    await expect(first.locator('.conversation-record-group')).toHaveCount(4);
    await expect(first.locator('details[open]')).toHaveCount(0);
    await expect(first.locator('.tool-detail, .mar-conversation-detail-body')).toHaveCount(0);
    await expect(first.locator('.conversation-file-change-list')).toHaveCount(0);
    for (const group of await first.locator('.conversation-record-group').all()) {
      await group.locator(':scope > summary').click();
      await expect(group.locator(':scope > details')).toHaveCount(1);
      await expect(group.locator(':scope > details[open]')).toHaveCount(0);
      await expect(group.locator('.tool-detail')).toHaveCount(0);
    }
    await expect(second.locator('details[open]')).toHaveCount(10);
  });
}

test('automatic process collapse also releases its reasoning disclosure state', async ({
  page
}) => {
  await page.goto(`${fixture.url}conversation-style.html?reasoning-preview=1`);
  const process = page.locator('[data-process-id="preview-process"]');
  await expect(process.locator(':scope > .process-heading')).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await process.locator('.reasoning-group > details > summary').click();
  await expect(process.locator('.reasoning-group .mar-conversation-detail-body')).toHaveCount(1);
  await page.getByTestId('finish-reasoning-process').click();
  await expect(process.locator('.process-content')).toHaveCount(0);
  await process.locator(':scope > .process-heading').click();
  await expect(process.locator('.reasoning-group > details')).toHaveCount(1);
  await expect(process.locator('details[open]')).toHaveCount(0);
  await expect(process.locator('.reasoning-group .mar-conversation-detail-body')).toHaveCount(0);
});

for (const [width, theme] of [
  [1280, 'daylight'],
  [390, 'vscode-dark-2026']
] as const) {
  test(`structured details share the tool surface without changing their content (${width}px, ${theme})`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${fixture.url}conversation-style.html?detail-surfaces=1&theme=${theme}`);

    const tasks = page.locator('.task-list');
    await expect(tasks).toHaveAttribute('open', '');
    const taskIcon = tasks.locator(':scope > summary > [data-mar-icon="task-list"]');
    await expect(taskIcon).toHaveCount(1);
    await expect(tasks.locator(':scope > summary > .conversation-record-icon')).toHaveCount(1);
    await expect(taskIcon).toBeVisible();
    await expect(taskIcon).toHaveAttribute('aria-hidden', 'true');
    const fileIcon = page.locator(
      '.conversation-file-change-details > summary > .conversation-record-icon'
    );
    const iconStyle = await fileIcon.evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: style.width, height: style.height, color: style.color };
    });
    for (const [property, value] of Object.entries(iconStyle))
      await expect(taskIcon).toHaveCSS(property, value);
    await tasks.locator(':scope > summary').screenshot({
      path: testInfo.outputPath('task-list-heading.png')
    });
    await expect(tasks.locator('.task-list-items > li')).toHaveCount(3);
    await tasks.locator(':scope > summary').click();
    await expect(tasks.locator('.mar-conversation-detail-body')).toHaveCount(0);
    await expect(taskIcon).toHaveCount(1);
    await expect(taskIcon).toBeVisible();
    await tasks.locator(':scope > summary').click();
    await expect(tasks.locator('.task-list-items > li')).toHaveCount(3);

    const files = page.locator('.conversation-file-change-details');
    await files.locator(':scope > summary').click();
    await expect(files.locator('.conversation-file-change-list > li')).toHaveCount(2);
    await expect(files.getByRole('button', { name: /src\/a\.ts/u })).toBeVisible();
    await expect(files.getByRole('button', { name: /src\/b\.ts/u })).toBeVisible();

    const plan = page.locator('.conversation-item.plan');
    await expect(plan.locator('.plan-step-list > li')).toHaveCount(2);
    const image = page.locator('[data-entry-key$=":generated-detail"]');
    await image.locator(':scope > details > summary').click();
    await expect(image.locator('.conversation-content-detail')).toContainText(
      'Preserve the image prompt'
    );
    await expect(image.locator('img')).toBeVisible();
    expect(
      await image
        .locator('img')
        .evaluate((element) => element.closest('.mar-conversation-detail-body') === null)
    ).toBe(true);

    const fallback = page.locator('[data-entry-key$=":fallback-detail"]');
    await fallback.locator('summary').click();
    await expect(fallback.locator('.conversation-content-detail')).toContainText(
      'Preserve the fallback detail'
    );

    await page.locator('.conversation-item.command_execution summary').click();
    await page.locator('.command_execution .conversation-command-detail > summary').click();
    const toolSurface = await page
      .locator('.command_execution .tool-detail')
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          background: style.backgroundColor,
          radius: style.borderRadius,
          paddingTop: style.paddingTop,
          paddingBottom: style.paddingBottom,
          paddingLeft: style.paddingLeft
        };
      });
    expect(toolSurface.background).not.toBe('rgba(0, 0, 0, 0)');
    for (const owner of [tasks, files, plan, image, fallback]) {
      const surface = owner.locator('.conversation-content-detail');
      await expect(surface).toBeVisible();
      await surface.scrollIntoViewIfNeeded();
      await expect(surface).toBeInViewport({ ratio: 1 });
      await expect(surface.locator('..')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      expect(
        await surface.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            background: style.backgroundColor,
            radius: style.borderRadius,
            paddingTop: style.paddingTop,
            paddingBottom: style.paddingBottom,
            paddingLeft: style.paddingLeft
          };
        })
      ).toEqual(toolSurface);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page
      .locator('.conversation-timeline')
      .screenshot({ path: testInfo.outputPath('detail-surfaces.png') });
    await fallback.screenshot({ path: testInfo.outputPath('fallback-detail.png') });
  });
}
