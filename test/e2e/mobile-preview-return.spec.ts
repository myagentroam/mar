import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

test('A mobile file window traps focus and Back closes the whole window rather than one tab', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture.url}file-tabs.html`);
  const window = page.locator('.workspace-file-tabs');
  await expect(window).toBeVisible();
  await expect(window.getByRole('tab')).toHaveCount(12);
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.textContent = 'Background action';
    document.body.append(button);
  });
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    expect(await window.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  const route = page.url();
  await page.goBack();
  await expect(window).toHaveCount(0);
  await expect(page).toHaveURL(route);
  await expect(page.getByRole('button', { name: 'Background action', exact: true })).toBeVisible();
});

for (const dirty of [false, true]) {
  test(`Mobile Aside and ${dirty ? 'guarded' : 'clean'} file returns never make browser Back skip layers`, async ({
    page,
    browserName
  }, testInfo) => {
    test.skip(browserName !== 'chromium', 'Chromium history intervention is reported through CDP.');
    const issues: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const session = await page.context().newCDPSession(page);
    await session.send('Audits.enable');
    session.on('Audits.issueAdded', ({ issue }) => {
      if (issue.details.genericIssueDetails?.errorType === 'NavigationEntryMarkedSkippable') {
        issues.push(issue.details.genericIssueDetails.errorType);
      }
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${fixture.url}mobile-preview-return.html`);
    const route = page.url();
    const initialState = await page.evaluate(() => history.state);
    await page.getByRole('button', { name: 'Open Aside', exact: true }).click();
    const aside = page.getByRole('complementary', { name: 'Aside' });
    const parentState = await page.evaluate(() => history.state);
    if (dirty) await page.getByRole('checkbox', { name: 'Unsaved changes' }).check();
    await page.getByRole('button', { name: 'Open file', exact: true }).click();
    const file = page.locator('.workspace-file-tabs');
    await expect(file).toBeVisible();
    await page.goBack();
    if (dirty) {
      const confirmation = page.getByRole('dialog', { name: 'Unsaved file', exact: true });
      await expect(confirmation).toBeVisible();
      expect(issues).toEqual([]);
      await page.goBack();
      await expect(confirmation).not.toBeVisible();
      await expect(file).toBeVisible();
      await expect(page.getByRole('checkbox', { name: 'Unsaved changes' })).toBeChecked();
      await page.goBack();
      await expect(confirmation).toBeVisible();
      await confirmation.getByRole('button', { name: 'Keep editing', exact: true }).click();
      await expect(confirmation).not.toBeVisible();
      await expect(file).toBeVisible();
      await page.goBack();
      await expect(confirmation).toBeVisible();
      await confirmation.getByRole('button', { name: 'Discard', exact: true }).click();
    }
    await expect(file).toHaveCount(0);
    await expect(aside).toBeVisible();
    await expect.poll(() => page.evaluate(() => history.state)).toEqual(parentState);
    expect(issues).toEqual([]);
    await page.goBack();
    await expect(aside).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => history.state)).toEqual(initialState);
    await expect(page).toHaveURL(route);
    if (!dirty) {
      await page.getByRole('button', { name: 'Open Aside', exact: true }).click();
      await page.getByRole('button', { name: 'Open file', exact: true }).click();
      await expect(file).toBeVisible();
      await page.evaluate(() => {
        history.back();
        history.back();
      });
      await expect(file).toHaveCount(0);
      await expect(aside).toBeVisible();
      await page.goBack();
      await expect(aside).toHaveCount(0);
      await expect(page).toHaveURL(route);
    }
    expect(issues).toEqual([]);
    expect(errors).toEqual([]);
    await testInfo.attach('browser-history-audit.json', {
      body: JSON.stringify({ issues, errors }),
      contentType: 'application/json'
    });
  });
}
