import { expect, test } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

for (const viewport of [
  { width: 1440, height: 900, locale: 'en-US', theme: 'vscode-dark-2026' },
  { width: 1440, height: 900, locale: 'en-US', theme: 'daylight' },
  { width: 390, height: 844, locale: 'zh-CN', theme: 'daylight' },
  { width: 390, height: 844, locale: 'en-US', theme: 'vscode-dark-2026' }
]) {
  test(`Personal instructions keep a bounded editor and scope drafts at ${viewport.width}px in ${viewport.theme}`, async ({
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
    const scopes = panel.getByRole('tab');
    const common = scopes.first();
    const marAgent = panel.getByRole('tab', { name: 'MAR Agent', exact: true });
    const colors = await panel.evaluate((element) => {
      const probe = document.createElement('span');
      element.append(probe);
      probe.style.backgroundColor = 'var(--mar-fill-selection)';
      probe.style.color = 'var(--mar-text-primary)';
      const selected = getComputedStyle(probe).backgroundColor;
      const foreground = getComputedStyle(probe).color;
      probe.style.backgroundColor = 'var(--mar-fill-row-hover)';
      const hover = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { selected, foreground, hover };
    });
    await expect(common).toHaveAttribute('aria-selected', 'true');
    await expect(common).toHaveAttribute('tabindex', '0');
    await expect(panel.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
    await expect(common).toHaveCSS('background-color', colors.selected);
    await expect(common).toHaveCSS('color', colors.foreground);
    await common.hover();
    await expect(common).toHaveCSS('background-color', colors.selected);
    await expect(common).toHaveCSS('border-radius', '6px');
    const codex = panel.getByRole('tab', { name: 'Codex', exact: true });
    await codex.hover();
    await expect(codex).toHaveCSS('background-color', colors.hover);
    const logoBefore = await marAgent.locator('img').getAttribute('src');
    await common.focus();
    await common.press('ArrowRight');
    await expect(marAgent).toBeFocused();
    await expect(marAgent).toHaveAttribute('aria-selected', 'true');
    await expect(common).toHaveAttribute('aria-selected', 'false');
    await expect(marAgent).toHaveCSS('background-color', colors.selected);
    await expect(marAgent).toHaveCSS('color', colors.foreground);
    await expect(marAgent).toHaveCSS('outline-style', 'solid');
    await expect(marAgent).toHaveCSS('outline-width', '2px');
    await expect(marAgent.locator('img')).toHaveAttribute('src', logoBefore!);
    await marAgent.press('End');
    await expect(scopes.last()).toBeFocused();
    await scopes.last().press('ArrowRight');
    await expect(common).toBeFocused();
    await common.press('ArrowLeft');
    await expect(scopes.last()).toBeFocused();
    await scopes.last().press('Home');
    await expect(common).toBeFocused();
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
    await marAgent.click();
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
