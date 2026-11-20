import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test as base } from '@playwright/test';

const productRoot = resolve(import.meta.dirname, '../..');
const webRequire = createRequire(resolve(productRoot, 'packages/web-core/package.json'));
const test = base.extend<{ auditUrl: string }>({
  auditUrl: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const [{ createServer }, vue] = await Promise.all([
      import(webRequire.resolve('vite')),
      import(webRequire.resolve('@vitejs/plugin-vue'))
    ]);
    const server = await createServer({
      root: productRoot,
      configFile: false,
      plugins: [vue.default()],
      optimizeDeps: { entries: ['test/e2e/support/audit-detail.html'] },
      resolve: {
        alias: {
          '@': resolve(productRoot, 'ee/web/src'),
          vue: webRequire.resolve('vue/dist/vue.esm-bundler.js')
        }
      },
      server: { host: '127.0.0.1', port: 0, fs: { allow: [productRoot] }, watch: null },
      logLevel: 'error'
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls?.local?.[0];
      if (!origin) throw new Error('Audit detail fixture URL unavailable');
      await use(`${origin}test/e2e/support/audit-detail.html`);
    } finally {
      await server.close();
      expect(errors).toEqual([]);
    }
  }
});

for (const width of [1280, 390, 320]) {
  test(`Audit date range stays readable and marks the interval at ${width}px`, async ({
    page,
    auditUrl
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const [from, to, nextFrom, nextTo] = await page.evaluate(() => [
      new Date(2026, 9, 11, 9, 30).getTime(),
      new Date(2026, 10, 14, 18, 15).getTime(),
      new Date(2026, 9, 13).getTime(),
      new Date(2026, 10, 12).getTime()
    ]);
    await page.goto(`${auditUrl}?audit.from=${from}&audit.to=${to}&theme=dark`);
    const range = page.locator('.audit-range-picker');
    const [start, end] = [range.getByRole('textbox').nth(0), range.getByRole('textbox').nth(1)];
    await expect(start).toHaveValue('2026-10-11 09:30:00');
    await expect(end).toHaveValue('2026-11-14 18:15:00');
    for (const input of [start, end]) {
      expect(
        await input.evaluate((element: HTMLInputElement) => {
          const probe = document.createElement('span');
          probe.style.cssText = `position:absolute;white-space:pre;font:${getComputedStyle(element).font}`;
          probe.textContent = element.value;
          element.after(probe);
          const textWidth = probe.getBoundingClientRect().width;
          probe.remove();
          return element.clientWidth - textWidth;
        })
      ).toBeGreaterThanOrEqual(0);
    }
    await range.getByRole('button').first().click();
    const calendar = range.getByRole('dialog');
    await expect(calendar).toHaveCSS('opacity', '1');
    const months = calendar.locator('.mar-ui-calendar-month');
    const october = months.nth(0);
    const november = months.nth(1);
    const firstMonth = (await october.boundingBox())!;
    const secondMonth = (await november.boundingBox())!;
    if (width === 1280) {
      expect(firstMonth.y).toBeCloseTo(secondMonth.y, 0);
      expect(secondMonth.x).toBeGreaterThan(firstMonth.x);
    } else {
      expect(secondMonth.y).toBeGreaterThan(firstMonth.y);
      expect((await calendar.boundingBox())!.width).toBeLessThan(width);
    }
    const endpoint = october.getByRole('button', { name: '2026-10-11', exact: true });
    await expect(endpoint).toHaveAttribute('aria-pressed', 'true');
    const inside = october.getByRole('button', { name: '2026-10-12', exact: true });
    const repeated = october.getByRole('button', { name: '2026-11-01', exact: true });
    const band = (day: typeof inside) =>
      day.evaluate((element) => getComputedStyle(element, '::before').backgroundColor);
    expect(await band(inside)).not.toBe('rgba(0, 0, 0, 0)');
    expect(await inside.evaluate((element) => getComputedStyle(element, '::before').inset)).toBe(
      '2px 0px'
    );
    expect(await band(repeated)).toBe('rgba(0, 0, 0, 0)');
    await expect(endpoint.locator('.mar-ui-calendar-month__day-number')).toHaveCSS(
      'border-radius',
      '50%'
    );
    await page.screenshot({ path: testInfo.outputPath(`audit-date-range-${width}.png`) });

    await october.getByRole('button', { name: '2026-10-13', exact: true }).click();
    expect(new URL(page.url()).searchParams.get('audit.from')).toBe(String(from));
    const requests = () => page.evaluate(() => window.auditDetailFixture.listRanges());
    expect(await requests()).toEqual([[String(from), String(to)]]);
    await november.getByRole('button', { name: '2026-11-12', exact: true }).click();
    await calendar.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(calendar).toBeHidden();
    await expect.poll(requests).toEqual([
      [String(from), String(to)],
      [String(nextFrom), String(nextTo)]
    ]);
    await expect(start).toHaveValue('2026-10-13 00:00:00');
    await expect(end).toHaveValue('2026-11-12 00:00:00');
    await page.reload();
    await expect(start).toHaveValue('2026-10-13 00:00:00');
    await expect(end).toHaveValue('2026-11-12 00:00:00');
  });
}

test('Audit detail keeps the current target and loading across out-of-order completions', async ({
  page,
  auditUrl
}) => {
  await page.goto(auditUrl);
  const rows = page.locator('.mar-ui-table__row');
  await expect(rows).toHaveCount(2);
  await rows.nth(0).click();
  const dialog = page.getByRole('dialog');
  const loading = dialog.locator('.mar-ui-loading');
  await expect(dialog).toContainText('audit-A');
  await expect(loading).toBeVisible();
  // Deliver the queued activation to a cell, where MarTable handles row clicks.
  await rows.nth(1).getByRole('cell', { includeHidden: true }).last().dispatchEvent('click');
  await expect(dialog).toContainText('audit-B');
  await expect.poll(() => page.evaluate(() => window.auditDetailFixture.count())).toBe(2);
  await page.evaluate(() => window.auditDetailFixture.settle(0, false));
  await expect(loading).toBeVisible();
  await expect(dialog.locator('[aria-busy="true"]')).toHaveCount(1);
  await expect(page.locator('.mar-ui-message')).toHaveCount(0);
  await page.evaluate(() => window.auditDetailFixture.settle(1, true));
  await expect(dialog).toContainText('Payload audit-B request 1');
  await expect(loading).toBeHidden();

  await rows.nth(0).getByRole('cell', { includeHidden: true }).last().dispatchEvent('click');
  await expect(dialog).not.toContainText('Payload audit-B');
  await rows.nth(1).getByRole('cell', { includeHidden: true }).last().dispatchEvent('click');
  await page.evaluate(() => window.auditDetailFixture.settle(3, true));
  await page.evaluate(() => window.auditDetailFixture.settle(2, true));
  await expect(dialog).toContainText('Payload audit-B request 3');
  await expect(dialog).not.toContainText('Payload audit-A');
  await expect(loading).toBeHidden();

  await rows.nth(0).getByRole('cell', { includeHidden: true }).last().dispatchEvent('click');
  await rows.nth(1).getByRole('cell', { includeHidden: true }).last().dispatchEvent('click');
  await page.evaluate(() => window.auditDetailFixture.settle(4, true));
  await expect(loading).toBeVisible();
  await expect(dialog.locator('[aria-busy="true"]')).toHaveCount(1);
  await expect(dialog).not.toContainText('Payload audit-A');
  await page.evaluate(() => window.auditDetailFixture.settle(5, false));
  await expect(loading).toBeHidden();
  await expect(page.locator('.mar-message--error')).toContainText('Failure audit-B request 5');
  await expect(dialog).toContainText('audit-B');
});

for (const close of ['footer', 'escape', 'icon', 'overlay'] as const) {
  test(`Audit detail ${close} close invalidates pending results and permits same-target reopening`, async ({
    page,
    auditUrl
  }) => {
    await page.goto(auditUrl);
    const row = page.locator('.mar-ui-table__row').first();
    await row.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    if (close === 'footer')
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    else if (close === 'escape') await page.keyboard.press('Escape');
    else if (close === 'icon') await dialog.locator('.mar-ui-dialog__close').click();
    else await page.mouse.click(5, 5);
    await expect(dialog).toHaveCount(0);
    await row.click();
    await expect(dialog.locator('.mar-ui-loading')).toBeVisible();
    await page.evaluate(() => window.auditDetailFixture.settle(0, true));
    await expect(dialog).not.toContainText('Payload audit-A request 0');
    await expect(dialog.locator('.mar-ui-loading')).toBeVisible();
    await expect(dialog.locator('[aria-busy="true"]')).toHaveCount(1);
    await page.evaluate(() => window.auditDetailFixture.settle(1, true));
    await expect(dialog).toContainText('Payload audit-A request 1');
    await expect(dialog.locator('.mar-ui-loading')).toBeHidden();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await row.click();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(() => window.auditDetailFixture.settle(2, false));
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.mar-ui-message')).toHaveCount(0);
    await row.click();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(() => window.auditDetailFixture.settle(3, true));
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.mar-ui-message')).toHaveCount(0);
  });
}

test('Audit detail ignores success and failure after page unmount', async ({ page, auditUrl }) => {
  await page.goto(auditUrl);
  const rows = page.locator('.mar-ui-table__row');
  await rows.first().click();
  await rows.nth(1).getByRole('cell', { includeHidden: true }).last().dispatchEvent('click');
  await page.evaluate(() => window.auditDetailFixture.unmount());
  await page.evaluate(() => window.auditDetailFixture.settle(0, true));
  await page.evaluate(() => window.auditDetailFixture.settle(1, false));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.mar-ui-message')).toHaveCount(0);
});
