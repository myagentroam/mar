import { test, expect } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
const inlineModel = {
  id: 'inline',
  name: 'Inline model',
  protocol: 'OPENAI_RESPONSES',
  baseUrl: 'https://models.invalid',
  modelId: 'fixture',
  contextWindowTokens: 200000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: ['medium'],
  defaultReasoningEffort: 'medium',
  titleGeneration: false,
  codeMode: true,
  hostedWebSearch: false,
  responsesTransport: { transport: 'HTTP', httpVersion: '1.1' },
  enabled: true,
  sortOrder: 0,
  access: 'PUBLIC',
  credentialType: 'INLINE_API_KEY',
  credentialConfigured: true
};
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const locale of ['zh-CN', 'en-US'] as const) {
  for (const mobile of [false, true]) {
    test(`model SOCKS5 edit and clear ${locale} ${mobile ? 'mobile dark' : 'desktop light'}`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize(
        mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }
      );
      const proxy = 'socks5://user:private-password@proxy.invalid:1080';
      let currentProxy: string | null = proxy;
      const writes: Record<string, unknown>[] = [];
      await page.route('**/api/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        let body: unknown;
        if (path.endsWith('/connection')) body = { details: { socks5Url: currentProxy } };
        else if (route.request().method() === 'PUT' || route.request().method() === 'POST') {
          const input = route.request().postDataJSON() as Record<string, unknown>;
          writes.push(input);
          currentProxy = input.socks5Url as string | null;
          body = {};
        } else if (path.endsWith('/models'))
          body = {
            models: [{ ...inlineModel, proxyConfigured: currentProxy !== null }]
          };
        else body = { credentials: [] };
        await route.fulfill({ json: body });
      });
      await page.goto(
        `${fixture.url}model-proxy.html?locale=${locale}&theme=${mobile ? 'dark' : 'light'}`
      );
      if (mobile)
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'vscode-dark-2026');
      const edit = locale === 'zh-CN' ? '编辑' : 'Edit';
      const copy = locale === 'zh-CN' ? '复制' : 'Duplicate';
      const save = locale === 'zh-CN' ? '保存' : 'Save';
      await page.getByRole('button', { name: edit, exact: true }).click();
      const dialog = page.getByRole('dialog');
      const identityFields = dialog.locator('.model-grid').filter({
        hasText: locale === 'zh-CN' ? '协议' : 'Protocol'
      });
      await expect(identityFields.getByRole('textbox')).toHaveValue(inlineModel.name);
      const modelNameOutline = await identityFields
        .locator('.el-input__wrapper')
        .evaluate((element) => getComputedStyle(element).boxShadow);
      await expect(identityFields.locator('.el-select__wrapper')).toHaveCSS(
        'box-shadow',
        modelNameOutline
      );
      const input = dialog.getByLabel(locale === 'zh-CN' ? 'SOCKS5 代理' : 'SOCKS5 proxy', {
        exact: true
      });
      await expect(input).toHaveValue(proxy);
      await expect(input).toHaveAttribute('type', 'password');
      await input.fill('http://proxy.invalid:1080');
      await dialog.getByRole('button', { name: save, exact: true }).click();
      await expect(dialog.locator('.el-form-item__error')).toBeVisible();
      expect(writes).toEqual([]);
      await input.fill(proxy);
      await page.screenshot({ path: testInfo.outputPath('model-proxy.png'), fullPage: true });
      await dialog.getByRole('button', { name: save, exact: true }).click();
      await expect(dialog).toBeHidden();
      expect(writes).toHaveLength(1);
      expect(writes[0]?.socks5Url).toBe(proxy);
      await page.getByRole('button', { name: copy, exact: true }).click();
      await expect(input).toHaveValue(proxy);
      await input.fill('');
      await dialog.getByRole('button', { name: save, exact: true }).click();
      await expect(dialog).toBeHidden();
      expect(writes[1]?.socks5Url).toBeNull();
      await page.getByRole('button', { name: edit, exact: true }).click();
      await expect(input).toBeEmpty();
      const bounds = await dialog.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.width).toBeLessThanOrEqual(mobile ? 390 : 1280);
    });
  }
}

test('proxy transport tests require a compatible Node before opening the dialog', async ({
  page
}) => {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      json: path.endsWith('/models')
        ? { models: [{ ...inlineModel, proxyConfigured: true }] }
        : { credentials: [] }
    });
  });
  await page.goto(`${fixture.url}model-proxy.html?locale=en-US&test-node=legacy`);
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByText('No online Node supports this model transport configuration.', { exact: true })
  ).toBeVisible();

  await page.goto(`${fixture.url}model-proxy.html?locale=en-US&test-node=socks5`);
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Execution Node', { exact: true }).click();
  await expect(page.getByRole('option', { name: 'Fixture Node', exact: true })).toBeVisible();
});
