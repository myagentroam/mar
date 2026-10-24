import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

test('Personal instruction saves retain other scope drafts through success, failure and retry', async ({
  page
}) => {
  const fixture = await startCustomThemeFixture();
  const initial = {
    common: 'Common saved',
    marAgent: 'MAR saved',
    codex: 'Codex saved',
    claudeCode: '',
    openCode: ''
  };
  const writes: { path: string; content: string }[] = [];
  let complete: ((status: number) => void) | undefined;
  await page.route('**/api/personal-instructions**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({ json: { instructions: initial } });
      return;
    }
    const body = request.postDataJSON() as { content: string };
    writes.push({ path: new URL(request.url()).pathname, content: body.content });
    const status = await new Promise<number>((resolve) => {
      complete = resolve;
    });
    await route.fulfill({
      status,
      json: { instructions: { ...initial, common: `Saved: ${body.content}` } }
    });
    complete = undefined;
  });
  try {
    await page.goto(`${fixture.url}personal-instructions.html`);
    const panel = page.locator('.personal-instructions');
    const editor = panel.getByRole('textbox');
    const common = panel.getByRole('tab', { name: 'Common', exact: true });
    const mar = panel.getByRole('tab', { name: 'MAR Agent', exact: true });
    const codex = panel.getByRole('tab', { name: 'Codex', exact: true });
    const save = panel.getByRole('button', { name: 'Save', exact: true });
    await expect(editor).toHaveValue(initial.common);
    await codex.click();
    await editor.fill('Codex inactive draft');
    await common.click();
    await editor.fill('Common submitted');
    await save.click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toEqual({
      path: '/api/personal-instructions/COMMON',
      content: 'Common submitted'
    });
    await expect(save).toBeDisabled();
    await mar.click();
    await editor.fill('MAR pending draft');
    complete!(200);
    await expect(save).toBeEnabled();
    await expect(editor).toHaveValue('MAR pending draft');
    await expect(page.locator('.el-message--success')).toBeVisible();
    await common.click();
    await expect(editor).toHaveValue('Saved: Common submitted');
    await codex.click();
    await expect(editor).toHaveValue('Codex inactive draft');
    await common.click();
    await editor.fill('Common retry draft');
    await save.click();
    await expect.poll(() => writes.length).toBe(2);
    await mar.click();
    await editor.fill('MAR failure draft');
    complete!(503);
    await expect(save).toBeEnabled();
    await expect(page.locator('.el-message--error')).toBeVisible();
    await expect(editor).toHaveValue('MAR failure draft');
    await common.click();
    await expect(editor).toHaveValue('Common retry draft');
    await save.click();
    await expect.poll(() => writes.length).toBe(3);
    complete!(200);
    await expect(save).toBeEnabled();
    await expect(editor).toHaveValue('Saved: Common retry draft');
    await mar.click();
    await expect(editor).toHaveValue('MAR failure draft');
    await editor.fill('   ');
    await save.click();
    await expect(panel.locator('.el-form-item__error')).toBeVisible();
    expect(writes).toHaveLength(3);
    await page.screenshot({ path: test.info().outputPath('retained-drafts.png') });
  } finally {
    complete?.(503);
    await page.close();
    await fixture.close();
  }
});
