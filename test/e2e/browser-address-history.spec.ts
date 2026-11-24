import { expect, test, type Page } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

const path = 'test/e2e/support/browser-address-history.html';
async function respond(page: Page, text: string, ...urls: string[]): Promise<void> {
  await page.evaluate(
    ({ text, urls }) => {
      const items = urls.map((url, index) => ({ url, title: `Page ${index + 1}`, visitedAt: 1 }));
      document.dispatchEvent(
        new CustomEvent('fixture-history-response', { detail: { text, items } })
      );
    },
    { text, urls }
  );
}

test('Address history selects with keys or touch and keeps unselected Enter as direct navigation', async ({
  browser
}) => {
  const fixture = await startCustomThemeFixture(path);
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 390, height: 700 }
  });
  try {
    const page = await context.newPage();
    await page.goto(`${fixture.url}browser-address-history.html`);
    const address = page.getByRole('combobox', { name: 'Address' });
    const requested = page.getByTestId('requested');
    const navigation = page.getByTestId('navigation');
    const list = page.getByRole('listbox', { name: 'Browsing history' });
    await address.fill('site.test');
    await expect(requested).toHaveText('site.test');
    await respond(page, 'site.test', 'https://site.test/page', 'https://site.test/second');
    await expect(list.getByRole('option')).toHaveCount(2);
    await expect(address).toBeFocused();
    await expect(address).toHaveAttribute('aria-expanded', 'true');
    await address.press('ArrowUp');
    const second = list.getByRole('option', { name: /Page 2/u, selected: true });
    await expect(second).toBeVisible();
    await expect(address).toHaveAttribute(
      'aria-activedescendant',
      (await second.getAttribute('id'))!
    );
    await expect(address).toHaveValue('site.test');
    await address.press('Enter');
    await expect(navigation).toHaveText('https://site.test/second');
    await expect(list).toBeHidden();

    await address.fill('site.test/page');
    await expect(requested).toHaveText('site.test,site.test/page');
    await respond(page, 'site.test/page', 'https://site.test/page');
    const first = list.getByRole('option');
    await expect(first).toBeVisible();
    const bounds = (await list.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await first.tap();
    await expect(navigation).toHaveText('https://site.test/page');

    await address.fill('site.test/direct');
    await expect(requested).toHaveText('site.test,site.test/page,site.test/direct');
    await respond(page, 'site.test/direct', 'https://site.test/direct-match');
    await expect(list).toBeVisible();
    await address.press('Enter');
    await expect(navigation).toHaveText('site.test/direct');
    await expect(list).toBeHidden();
  } finally {
    await context.close();
    await fixture.close();
  }
});

test('Address history drops stale replies on edit, Escape, blur and view change', async ({
  page
}) => {
  const fixture = await startCustomThemeFixture(path);
  try {
    await page.goto(`${fixture.url}browser-address-history.html`);
    const address = page.getByRole('combobox', { name: 'Address' });
    const list = page.getByRole('listbox');
    const requested = page.getByTestId('requested');
    await address.fill('old');
    await expect(requested).toHaveText('old');
    await address.fill('new');
    await expect(requested).toHaveText('old,new');
    await respond(page, 'new', 'https://new.test/');
    await expect(list).toContainText('https://new.test/');
    await respond(page, 'old', 'https://old.test/');
    await expect(list).not.toContainText('https://old.test/');
    await address.press('Escape');
    await expect(list).toBeHidden();
    await expect(address).toBeFocused();
    await expect(address).toHaveValue('new');

    const invalidate = [
      () => address.press('Escape'),
      () => page.getByRole('button', { name: 'Outside' }).click(),
      () => page.evaluate(() => document.dispatchEvent(new Event('fixture-history-context')))
    ];
    for (const [index, action] of invalidate.entries()) {
      const text = `discard${index}`;
      await address.fill(text);
      await expect(requested).toContainText(text);
      await action();
      await respond(page, text, 'https://discard.test/');
      await expect(address).toHaveAttribute('aria-expanded', 'false');
    }
    await address.fill('failure.test');
    await expect(requested).toContainText('failure.test');
    await address.press('Enter');
    await expect(page.getByTestId('navigation')).toHaveText('failure.test');
  } finally {
    await fixture.close();
  }
});

test('Editing the address clears a highlighted suggestion even when the query text is unchanged', async ({
  page
}) => {
  const fixture = await startCustomThemeFixture(path);
  try {
    await page.goto(`${fixture.url}browser-address-history.html`);
    const address = page.getByRole('combobox', { name: 'Address' });
    const requested = page.getByTestId('requested');
    await address.fill('site.test');
    await expect(requested).toHaveText('site.test');
    await respond(page, 'site.test', 'https://site.test/history');
    const suggestion = page.getByRole('option', { name: /site\.test\/history/u });
    await expect(suggestion).toBeVisible();
    await address.press('ArrowDown');
    await expect(suggestion).toHaveAttribute('aria-selected', 'true');
    await address.press('Space');
    await expect(address).toHaveValue('site.test ');
    await expect(suggestion).toHaveAttribute('aria-selected', 'false');
    await expect(requested).toHaveText('site.test');
    await address.press('Enter');
    await expect(page.getByTestId('navigation')).toHaveText('site.test');
  } finally {
    await fixture.close();
  }
});
