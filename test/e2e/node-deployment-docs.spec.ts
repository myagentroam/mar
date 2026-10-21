import { expect, test } from '@playwright/test';

test('Public documentation requires no login and supports stable deep links', async ({
  page,
  request
}) => {
  const response = await request.get('/docs/getting-started/overview');
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toContain('text/html');
  const logo = await request.get('/docs/logo.png');
  expect(logo.ok()).toBe(true);
  expect(logo.headers()['content-type']).toContain('image/png');

  await page.goto('/docs/');
  await expect(page).toHaveURL(/\/docs\/getting-started\/overview$/u);
  await expect(page.getByRole('heading', { name: 'MyAgentRoam 是什么' })).toBeVisible();
  await expect(page.getByRole('button', { name: '搜索文档' })).toBeVisible();
  await expect(page.locator('.VPNavBarTitle a')).toHaveText('Documentation');
  await expect(page.locator('.VPNavBarTitle a')).toHaveAttribute('href', '/');
  const consoleLink = page.getByRole('link', { name: '控制台', exact: true });
  await expect(consoleLink).toHaveAttribute('href', '/console');
  await expect(consoleLink).toHaveAttribute('target', '_self');
  await expect(page.getByText(/^最后更新：\s*\d{4}-\d{2}-\d{2}$/u)).toBeVisible();
  await page.getByRole('button', { name: '复制本页内容' }).click();
  await expect(page.getByRole('button', { name: '已复制' })).toBeVisible();

  await consoleLink.click();
  await expect(page).toHaveURL(/\/console$/u);
  await expect(page.getByRole('button', { name: '进入控制台' })).toBeVisible();

  await page.goto('/docs/deployment/node-installation');
  await expect(page.getByRole('heading', { name: '安装与注册 Node' })).toBeVisible();
  await expect(page.locator('code').filter({ hasText: '>=22.13' }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: '前置条件' })).toBeVisible();
  const nodeInstallCommand = page.locator('pre').filter({
    hasText: '@myagentroam/node@${common_version}'
  });
  await expect(nodeInstallCommand).toBeVisible();
  await expect(nodeInstallCommand).toContainText(
    "common_version='<产品发布清单中的 commonVersion>'"
  );
  await expect(nodeInstallCommand).toContainText(
    'npm install --global "@myagentroam/node@${common_version}"'
  );
  await expect(nodeInstallCommand).toContainText(
    'npm list --global "@myagentroam/node@${common_version}" --depth=0'
  );

  await page.goto('/docs/deployment/node-linux');
  await expect(page.getByRole('heading', { name: 'Linux Node 与 systemd' })).toBeVisible();
  await expect(
    page.locator('pre').filter({ hasText: 's|^User=mar-node$|User=ubuntu|' })
  ).toBeVisible();

  await page.goto('/docs/deployment/node-windows');
  await expect(page.getByRole('heading', { name: 'Windows Node 与任务计划' })).toBeVisible();
  await expect(page.getByText('Register-ScheduledTask', { exact: true })).toBeVisible();

  await page.goto('/docs/runners/opencode');
  await expect(page.getByRole('heading', { name: '安装、配置和使用 OpenCode' })).toBeVisible();
  await expect(page.getByText('npm install -g opencode-ai', { exact: true })).toBeVisible();

  await page.goto('/docs/runners/codex');
  await expect(page.getByRole('heading', { name: '安装、配置和使用 Codex' })).toBeVisible();
  await expect(page.getByText('npm install -g @openai/codex', { exact: true })).toBeVisible();

  await page.goto('/docs/runners/claude-code');
  await expect(page.getByRole('heading', { name: '安装、配置和使用 Claude Code' })).toBeVisible();
  await expect(
    page.getByText('npm install -g @anthropic-ai/claude-code', { exact: true })
  ).toBeVisible();
});

test('Documentation language switching preserves deep links and browser preference', async ({
  page,
  context,
  request
}) => {
  const english = '/docs/en-US/getting-started/overview';
  expect((await request.get(english)).ok()).toBe(true);

  await page.goto('/docs/getting-started/overview');
  const desktopLanguages = page.locator('.VPNavBarTranslations');
  await expect(desktopLanguages).toBeVisible();
  await expect(page.locator('.docs-language-select')).toHaveCount(0);
  await desktopLanguages.getByRole('button', { name: '切换语言' }).click();
  await desktopLanguages.getByRole('link', { name: 'English' }).click();
  await expect(page).toHaveURL(new RegExp(`${english}$`, 'u'));
  await expect(page.getByRole('heading', { name: 'What Is MyAgentRoam?' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('mar.locale.v2'))).toBe('en-US');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'What Is MyAgentRoam?' })).toBeVisible();
  await page.goto('/docs/en-US/getting-started/prerequisites');
  await expect(page.locator('.VPNavBarTitle a')).toHaveText('Documentation');
  await expect(page.locator('.VPNavBarTitle a')).toHaveAttribute('href', '/');
  await expect(page.getByRole('button', { name: 'Search Documentation' })).toBeVisible();
  await expect(page.locator('.VPDocAsideOutline .outline-title')).toHaveText('On This Page');
  await expect(page.locator('.VPDocFooter .pager-link.prev .desc')).toHaveText('Previous');
  await expect(page.locator('.VPDocFooter .pager-link.next .desc')).toHaveText('Next');
  await desktopLanguages.getByRole('button', { name: 'Switch language' }).click();
  await desktopLanguages.getByRole('link', { name: '简体中文' }).click();
  await expect(page).toHaveURL(/\/docs\/getting-started\/prerequisites$/u);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('mar.locale.v2'))).toBe('zh-CN');
  await page.goto(english);
  const otherPage = await context.newPage();
  await otherPage.goto('/');
  await expect(otherPage.locator('html')).toHaveAttribute('lang', 'en-US');
  await otherPage
    .getByRole('combobox', { name: 'Switch to Chinese' })
    .locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " el-select ")][1]'
    )
    .click();
  await otherPage.getByRole('option', { name: '简体中文' }).click();
  await expect(page).toHaveURL(/\/docs\/getting-started\/overview$/u);
  await expect(page.getByRole('heading', { name: 'MyAgentRoam 是什么' })).toBeVisible();
  await page.goto(english);
  await expect(page.getByRole('heading', { name: 'What Is MyAgentRoam?' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('mar.locale.v2'))).toBe('en-US');
  await otherPage.close();
});

test('Documentation mobile headers and menus avoid overflow in both languages', async ({
  page
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/docs/getting-started/overview');

  const assertFitsViewport = async () => {
    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    expect(horizontalOverflow).toBe(false);
    for (const selector of ['.VPNavBarTitle a', '.VPNavBarSearch button', '.VPNavBarHamburger']) {
      const bounds = await page.locator(selector).first().boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    }
  };

  await expect(page.locator('.VPNavBarTitle a')).toHaveText('Documentation');
  await expect(page).toHaveTitle(/MyAgentRoam Documentation/u);
  await assertFitsViewport();
  await page.locator('.VPNavBarHamburger').click();
  const mobileMenu = page.locator('#VPNavScreen');
  const mobileLanguages = mobileMenu.locator('.VPNavScreenTranslations');
  await expect(mobileLanguages).toBeVisible();
  await expect(mobileMenu.getByRole('link', { name: '控制台' })).toBeVisible();
  await assertFitsViewport();
  await mobileLanguages.locator('button.title').click();
  await mobileLanguages.getByRole('link', { name: 'English' }).click();
  await expect(page).toHaveURL(/\/docs\/en-US\/getting-started\/overview$/u);
  await expect(page.locator('.VPNavBarTitle a')).toHaveText('Documentation');
  await expect(page.locator('.VPLocalNav .menu')).toHaveText('Menu');
  await assertFitsViewport();
  await page.locator('.VPNavBarHamburger').click();
  await expect(page.locator('#VPNavScreen').getByRole('link', { name: 'Console' })).toBeVisible();
  await assertFitsViewport();

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator('.VPNavBarTranslations')).toBeVisible();
  await expect(
    page.locator('.VPNavBarTranslations').getByRole('button', { name: 'Switch language' })
  ).toBeVisible();
  await expect(
    page.locator('.docs-desktop-actions').getByRole('link', { name: 'Console' })
  ).toBeVisible();

  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(page.locator('.VPNavBarTranslations')).toBeHidden();
  const compactLanguages = page.locator('.VPNavBarExtra');
  await expect(compactLanguages).toBeVisible();
  await compactLanguages.getByRole('button', { name: 'extra navigation' }).click();
  await compactLanguages.getByRole('link', { name: '简体中文' }).click();
  await expect(page).toHaveURL(/\/docs\/getting-started\/overview$/u);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('mar.locale.v2'))).toBe('zh-CN');
});
