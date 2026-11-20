import { expect, test, type Locator } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

async function requestUncancelableClose(dialog: Locator): Promise<void> {
  await dialog.evaluate((element: HTMLDialogElement) => {
    // Model the native default action when preventDefault() cannot stop the close.
    if (element.dispatchEvent(new Event('cancel', { cancelable: false }))) element.close();
  });
}

test('A File changes diff closes on a mobile platform close request and can reopen immediately', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture.url}mobile-preview-return.html`);
  const url = page.url();
  const state = await page.evaluate(() => history.state);
  const baseLength = await page.evaluate(() => history.length);
  const entry = page.getByRole('button', { name: 'notes.txt', exact: true });
  const dialog = page.getByRole('dialog', { name: /^notes\.txt / });
  for (const close of ['platform', 'history', 'uncancelable platform request', 'platform']) {
    await entry.click();
    await expect(dialog).toContainText('new contents');
    expect(await page.evaluate(() => history.length)).toBe(baseLength + 1);
    if (close === 'platform')
      await dialog.evaluate((element: HTMLDialogElement) => element.requestClose());
    else if (close === 'uncancelable platform request') await requestUncancelableClose(dialog);
    else await page.goBack();
    await expect(page.locator('.workspace-file-tabs')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => history.state)).toEqual(state);
    await expect(page).toHaveURL(url);
  }
  await page.goForward();
  await expect(page).toHaveURL(url);
  await expect(page.locator('.workspace-file-tabs')).toHaveCount(0);
});

test('An uncancelable mobile close request still respects the unsaved file guard', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture.url}mobile-preview-return.html`);
  await page.getByRole('button', { name: 'Open Aside', exact: true }).click();
  const aside = page.getByRole('complementary', { name: 'Aside' });
  const asideState = await page.evaluate(() => history.state);
  const dirty = page.getByRole('checkbox', { name: 'Unsaved changes' });
  await dirty.check();
  await page.getByRole('button', { name: 'Open file', exact: true }).click();
  const file = page.locator('dialog:has(.workspace-file-tabs)');
  const confirm = page.getByRole('dialog', { name: 'Unsaved file', exact: true });
  await requestUncancelableClose(file);
  await expect(confirm).toBeVisible();
  await expect(file).toHaveAttribute('open', '');
  await confirm.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(file).toBeVisible();
  await page.goBack();
  await confirm.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(file).toHaveCount(0);
  await expect(aside).toBeVisible();
  await expect(dirty).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => history.state)).toEqual(asideState);
});

test('A mobile file window traps focus and Back closes the whole window rather than one tab', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture.url}file-tabs.html?start-closed`);
  const opener = page.getByRole('button', { name: 'Reopen file previews' });
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.textContent = 'Background action';
    button.id = 'background-action';
    document.body.append(button);
  });
  await opener.click();
  const window = page.locator('.workspace-file-tabs');
  await expect(window).toBeVisible();
  await expect(window.getByRole('tab')).toHaveCount(12);
  const background = page.locator('#background-action');
  expect(
    await background.evaluate((button: HTMLButtonElement) => {
      button.focus();
      return document.activeElement === button;
    })
  ).toBe(false);
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    expect(
      await window.evaluate((element) => {
        const focused = document.activeElement;
        return !document.hasFocus() || element.closest('dialog')?.contains(focused);
      })
    ).toBe(true);
  }
  const route = page.url();
  await page.goBack();
  await expect(window).toHaveCount(0);
  await expect(page).toHaveURL(route);
  await expect(opener).toBeVisible();
  await expect(background).toBeVisible();
  await background.focus();
  await expect(background).toBeFocused();
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
