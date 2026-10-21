import { expect, test, type Page } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

async function prepare(page: Page) {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.route('**/api/auth/me', (route) =>
    json(route, {
      authenticated: true,
      mustChangePassword: false,
      username: 'admin',
      isAdmin: true
    })
  );
  await page.addInitScript(() => localStorage.setItem('mar.locale.v2', 'en-US'));
}

async function openSettings(page: Page) {
  await page.goto('/console?view=settings&settings=quick-prompts');
  await page.getByRole('button', { name: 'Quick Prompts', exact: true }).click();
  await expect(page.locator('.quick-prompts')).toHaveAttribute('aria-busy', 'false');
}

async function edit(page: Page, phrase: string) {
  await page
    .locator('.prompt-item')
    .filter({ hasText: '#' + phrase })
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('textbox', { name: /Phrase$/ })).toHaveValue(phrase);
  return dialog;
}

test('Quick prompt settings create, edit, and retain failed drafts for retry', async ({ page }) => {
  await prepare(page);
  const prompts: { id: string; phrase: string; prompt: string; updatedAt: number }[] = [];
  const writes: { method: string; path: string; body: unknown }[] = [];
  let fail = false;
  await page.route('**/api/quick-prompts**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') return json(route, { prompts });
    const body = request.postDataJSON() as { phrase: string; prompt: string };
    writes.push({ method: request.method(), path: new URL(request.url()).pathname, body });
    if (fail) return route.fulfill({ status: 503, json: { error: 'Save unavailable' } });
    const prompt = { id: 'saved', ...body, updatedAt: writes.length };
    prompts.splice(0, prompts.length, prompt);
    return json(route, { prompt });
  });
  await openSettings(page);
  await page.getByRole('button', { name: 'Add prompt', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: /Phrase$/ }).fill('created');
  await dialog.getByRole('textbox', { name: /Prompt$/ }).fill('Created body');
  await dialog.getByRole('textbox', { name: /Phrase$/ }).press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.prompt-item')).toContainText('Created body');
  expect(writes[0]).toEqual({
    method: 'POST',
    path: '/api/quick-prompts',
    body: { phrase: 'created', prompt: 'Created body' }
  });
  await edit(page, 'created');
  await dialog.getByRole('textbox', { name: /Prompt$/ }).fill('Retained edit');
  fail = true;
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.el-message--error')).toContainText('Unable to save quick prompt');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: /Prompt$/ })).toHaveValue('Retained edit');
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect(page.locator('.prompt-item')).toContainText('Created body');
  fail = false;
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.prompt-item')).toContainText('Retained edit');
  expect(writes[2]).toEqual({
    method: 'PATCH',
    path: '/api/quick-prompts/saved',
    body: { phrase: 'created', prompt: 'Retained edit' }
  });
});

for (const outcome of ['success', 'failure'] as const) {
  test(
    'Quick prompt settings ignore late save ' + outcome + ' while a new editor saves',
    async ({ page }) => {
      await prepare(page);
      const old = gate();
      const current = gate();
      const oldStarted = gate();
      const currentStarted = gate();
      const prompts = [
        { id: 'first', phrase: 'first', prompt: 'First body', updatedAt: 1 },
        { id: 'second', phrase: 'second', prompt: 'Second body', updatedAt: 2 }
      ];
      let reads = 0;
      await page.route('**/api/quick-prompts**', async (route) => {
        if (route.request().method() === 'GET') {
          reads += 1;
          return json(route, { prompts });
        }
        if (new URL(route.request().url()).pathname.endsWith('/first')) {
          oldStarted.release();
          await old.promise;
          if (outcome === 'failure')
            return route.fulfill({ status: 503, json: { error: 'Old save failed' } });
        } else {
          currentStarted.release();
          await current.promise;
        }
        return json(route, { prompt: prompts[1] });
      });
      try {
        await openSettings(page);
        const initialReads = reads;
        let dialog = await edit(page, 'first');
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await oldStarted.promise;
        if (outcome === 'success')
          await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        else await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        dialog = await edit(page, 'second');
        const save = dialog.getByRole('button', { name: 'Save', exact: true });
        await expect(save).not.toHaveClass(/is-loading/);
        await save.click();
        await currentStarted.promise;
        await expect(save).toHaveClass(/is-loading/);
        const response = page.waitForResponse((value) =>
          value.url().endsWith('/api/quick-prompts/first')
        );
        old.release();
        await (await response).finished();
        // Flush response handlers and Vue rendering, rather than sleeping for an arbitrary duration.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            )
        );
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('textbox', { name: /Phrase$/ })).toHaveValue('second');
        await expect(dialog.getByRole('textbox', { name: /Prompt$/ })).toHaveValue('Second body');
        await expect(save).toHaveClass(/is-loading/);
        await expect(page.locator('.el-message')).toHaveCount(0);
        expect(reads).toBe(initialReads);
        const saved = page.waitForRequest(
          (value) => value.method() === 'GET' && value.url().endsWith('/api/quick-prompts')
        );
        current.release();
        await saved;
        await expect(dialog).toHaveCount(0);
        await expect(page.locator('.el-message--success')).toContainText('Quick prompt saved.');
      } finally {
        old.release();
        current.release();
      }
    }
  );
}

for (const outcome of ['success', 'failure'] as const) {
  test(
    'Quick prompt settings ignore late refresh ' + outcome + ' after closing the editor',
    async ({ page }) => {
      await prepare(page);
      const refresh = gate();
      const refreshStarted = gate();
      let holdRefresh = false;
      const prompts = [{ id: 'first', phrase: 'first', prompt: 'First body', updatedAt: 1 }];
      await page.route('**/api/quick-prompts**', async (route) => {
        if (route.request().method() !== 'GET') return json(route, { prompt: prompts[0] });
        if (holdRefresh) {
          refreshStarted.release();
          await refresh.promise;
          if (outcome === 'failure')
            return route.fulfill({ status: 503, json: { error: 'Refresh unavailable' } });
        }
        return json(route, { prompts });
      });
      try {
        await openSettings(page);
        const dialog = await edit(page, 'first');
        holdRefresh = true;
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await refreshStarted.promise;
        await dialog.locator('.el-dialog__headerbtn').click();
        await expect(dialog).toHaveCount(0);
        refresh.release();
        await expect(page.locator('.quick-prompts')).toHaveAttribute('aria-busy', 'false');
        await expect(page.locator('.el-message')).toHaveCount(0);
        if (outcome === 'failure') {
          await expect(page.locator('.quick-prompts')).toContainText(
            'Unable to load quick prompts'
          );
          await page.getByRole('button', { name: 'Add prompt', exact: true }).click();
          await expect(dialog.getByRole('textbox', { name: /Phrase$/ })).toHaveValue('');
          await expect(dialog.getByRole('textbox', { name: /Prompt$/ })).toHaveValue('');
        } else {
          await edit(page, 'first');
          await expect(dialog.getByRole('textbox', { name: /Prompt$/ })).toHaveValue('First body');
        }
        await expect(dialog.getByRole('button', { name: 'Save', exact: true })).not.toHaveClass(
          /is-loading/
        );
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      } finally {
        refresh.release();
      }
    }
  );
}
