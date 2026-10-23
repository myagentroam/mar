import { expect, test } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

for (const viewport of [
  { width: 1440, height: 900, locale: 'en-US', theme: 'vscode-dark-2026' },
  { width: 390, height: 844, locale: 'zh-CN', theme: 'daylight' }
]) {
  test(`Personal instructions keep a bounded editor and scope drafts at ${viewport.width}px`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: viewport.height });
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    await page.route('**/api/auth/me', (route) =>
      json(route, {
        authenticated: true,
        mustChangePassword: false,
        username: 'admin',
        isAdmin: true
      })
    );
    await page.addInitScript(({ locale, theme }) => {
      localStorage.setItem('mar.locale.v2', locale);
      localStorage.setItem('mar.theme', theme);
    }, viewport);
    const instructions = {
      common: 'Common instructions',
      marAgent: 'MAR Agent instructions',
      codex: '',
      claudeCode: '',
      openCode: ''
    };
    const writes: { method: string; path: string; body: unknown }[] = [];
    await page.route('**/api/personal-instructions**', (route) => {
      const request = route.request();
      if (request.method() !== 'GET') {
        writes.push({
          method: request.method(),
          path: new URL(request.url()).pathname,
          body: request.postDataJSON()
        });
        instructions.common = (request.postDataJSON() as { content: string }).content;
      }
      return json(route, { instructions });
    });
    await page.goto('/console?view=settings&settings=personal-instructions');
    await page
      .getByRole('button', {
        name: viewport.locale === 'zh-CN' ? '个性化提示词' : 'Personal Instructions',
        exact: true
      })
      .click();
    const panel = page.locator('.personal-instructions');
    await expect(panel).toHaveAttribute('aria-busy', 'false');
    await expect(panel.locator('header p')).toBeVisible();
    await expect(panel.locator('header p')).toContainText('AGENTS.md');
    await page.setViewportSize(viewport);
    const editor = panel.getByRole('textbox');
    await expect(editor).toHaveValue(instructions.common);
    const dimensions = await editor.boundingBox();
    expect(dimensions!.height).toBeGreaterThanOrEqual(192);
    expect(dimensions!.height).toBeLessThanOrEqual(448);
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true
    );
    const save = panel.getByRole('button', { name: /^(Save|保存)$/ });
    const clear = panel.getByRole('button', { name: /^(Clear|清空)$/ });
    await expect(save).toBeInViewport();
    await expect(clear).toBeInViewport();
    expect((await clear.boundingBox())!.x).toBeLessThan((await save.boundingBox())!.x);
    const saveBounds = (await save.boundingBox())!;
    const editorBounds = (await editor.boundingBox())!;
    expect(
      Math.abs(saveBounds.x + saveBounds.width - editorBounds.x - editorBounds.width)
    ).toBeLessThan(2);
    await page.screenshot({
      path: testInfo.outputPath('personal-instructions.png'),
      animations: 'disabled'
    });
    await editor.fill('Retained common draft');
    await panel.getByRole('tab', { name: 'MAR Agent', exact: true }).click();
    await expect(editor).toHaveValue(instructions.marAgent);
    await panel.getByRole('tab').first().click();
    await expect(editor).toHaveValue('Retained common draft');
    await save.click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toEqual({
      method: 'PUT',
      path: '/api/personal-instructions/COMMON',
      body: { content: 'Retained common draft' }
    });
    await clear.click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^(Cancel|取消)$/ })
      .click();
    expect(writes).toHaveLength(1);
    await expect(editor).toHaveValue('Retained common draft');
  });
}
