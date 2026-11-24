import { expect, test } from '@playwright/test';
import type { BrowserFindOperation } from '../../packages/protocol/src/browser-attachment.js';
import { BrowserPageFind } from '../../mar-node/src/browser/browser-page-find.js';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

test('Find coalesces typing while an earlier request still awaits the Node', async ({ page }) => {
  const app = await startCustomThemeFixture('test/e2e/support/browser-find.html');
  const calls: string[] = [];
  const older = Promise.withResolvers<void>();
  const closing = Promise.withResolvers<void>();
  try {
    await page.clock.install();
    await page.exposeFunction('fixtureFind', async (operation: BrowserFindOperation) => {
      if (operation.action !== 'start') {
        calls.push(operation.action);
        return;
      }
      calls.push(operation.query);
      if (operation.query === 'first') await older.promise;
      if (operation.query === 'closing') await closing.promise;
      return { index: 1, total: operation.query === 'latest' ? 2 : 1, limited: false };
    });
    await page.goto(`${app.url}browser-find.html`);
    await page.getByRole('button', { name: 'Browser commands', exact: true }).press('Control+f');
    const finder = page.getByRole('search', { name: 'Find in page' });
    const query = finder.getByRole('textbox');
    await query.fill('first');
    await page.clock.runFor(200);
    await expect.poll(() => calls).toEqual(['first']);
    await query.fill('intermediate');
    await page.clock.runFor(200);
    await query.fill('latest');
    await page.clock.runFor(200);
    await expect(finder.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    older.resolve();
    await expect(finder.getByRole('status')).toHaveText('1/2');
    expect(calls).toEqual(['first', 'latest']);
    await query.fill('closing');
    await page.clock.runFor(200);
    await expect.poll(() => calls.at(-1)).toBe('closing');
    await query.press('Escape');
    await expect(finder).toBeHidden();
    expect(calls.at(-1)).toBe('closing');
    closing.resolve();
    await expect.poll(() => calls.at(-1)).toBe('clear');
    await expect(finder).toBeHidden();
  } finally {
    older.resolve();
    closing.resolve();
    await app.close();
  }
});

test('Find bar hands off focus from More and uses Enter without hijacking composition', async ({
  page,
  context
}) => {
  const remote = await context.newPage();
  const app = await startCustomThemeFixture('test/e2e/support/browser-find.html');
  try {
    await remote.setContent('<p>Light</p><p>light</p>');
    const find = new BrowserPageFind(remote);
    const owner = {};
    const calls: BrowserFindOperation[] = [];
    await page.exposeFunction('fixtureFind', async (operation: BrowserFindOperation) => {
      calls.push(operation);
      return find.update(owner, operation);
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    await page.goto(`${app.url}browser-find.html`);
    const more = page.getByRole('button', { name: 'Browser commands', exact: true });
    await expect(more, 'Browser controls should mount')
      .toBeVisible()
      .catch((error: unknown) => {
        throw new Error(JSON.stringify(errors), { cause: error });
      });
    await more.click();
    await page.getByRole('menuitem', { name: 'Find in page' }).click();
    const finder = page.getByRole('search', { name: 'Find in page' });
    const query = finder.getByRole('textbox');
    await expect(query).toBeFocused();
    await query.fill('light');
    await expect(finder.getByRole('status')).toHaveText('1/2');
    await query.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    expect(calls).toEqual([{ action: 'start', query: 'light' }]);
    await query.press('Shift+Enter');
    await expect(finder.getByRole('status')).toHaveText('2/2');
    await query.press('Escape');
    await expect(finder).toBeHidden();
    await expect(more).toBeFocused();
    await expect.poll(() => remote.evaluate(() => CSS.highlights.size)).toBe(0);
    await more.press('Meta+f');
    await expect(query).toBeFocused();
    await expect(query).toHaveValue('light');
  } finally {
    await remote.close();
    await app.close();
  }
});

test('Remote find paints literal text and reveals matches across visible frames', async ({
  page
}) => {
  await page.setContent(`
    <p>Signal <b>light.</b></p><p hidden>signal light.</p>
    <p style="visibility:hidden">signal light.</p>
    <div style="height:110vh"></div><p>signal light.</p>
    <iframe srcdoc="<p>SIGNAL LIGHT.</p>"></iframe>
    <iframe hidden srcdoc="<p>signal light.</p><iframe srcdoc='<p>signal light.</p>'></iframe>"></iframe>
  `);
  const find = new BrowserPageFind(page);
  const owner = {};
  const other = {};
  const start = await find.update(owner, { action: 'start', query: 'signal light.' });
  expect(start).toEqual({ index: 1, total: 3, limited: false });
  await expect.poll(() => page.evaluate(() => CSS.highlights.get('mar-page-find')?.size)).toBe(2);
  const next = await find.update(owner, { action: 'next' });
  expect(next?.index).toBe(2);
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
  expect((await find.update(owner, { action: 'next' }))?.index).toBe(3);
  expect((await find.update(owner, { action: 'next' }))?.index).toBe(1);
  await find.update(other, { action: 'clear' });
  expect(await page.evaluate(() => CSS.highlights.has('mar-page-find'))).toBe(true);
  await find.update(owner, { action: 'clear' });
  expect(await page.evaluate(() => CSS.highlights.has('mar-page-find'))).toBe(false);
  expect(await find.update(owner, { action: 'start', query: 'signal light?' })).toEqual({
    index: 0,
    total: 0,
    limited: false
  });
});

test('Remote find caps very large result sets and does not rewrite page text or selection', async ({
  page
}) => {
  await page.setContent(`<p id="sample">${'match '.repeat(550)}</p>`);
  await page.evaluate(() => {
    const range = new Range();
    range.setStart(document.querySelector('#sample')!.firstChild!, 0);
    range.setEnd(document.querySelector('#sample')!.firstChild!, 5);
    getSelection()!.addRange(range);
  });
  const find = new BrowserPageFind(page);
  const owner = {};
  expect(await find.update(owner, { action: 'start', query: 'match' })).toEqual({
    index: 1,
    total: 500,
    limited: true
  });
  expect(
    await page.evaluate(() => [
      getSelection()!.toString(),
      document.querySelector('#sample')!.childNodes.length
    ])
  ).toEqual(['match', 1]);
  await find.update(owner, { action: 'clear' });
  expect(await page.evaluate(() => document.adoptedStyleSheets.length)).toBe(0);
});
