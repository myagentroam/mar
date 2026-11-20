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
      const reasoningEfforts = dialog.getByRole('group').filter({
        has: page.getByRole('checkbox', { name: 'medium', exact: true })
      });
      await expect(reasoningEfforts).toHaveAccessibleName(
        locale === 'zh-CN' ? '支持的思考强度' : 'Supported reasoning efforts'
      );
      await expect(
        reasoningEfforts.getByRole('checkbox', { name: 'medium', exact: true })
      ).toBeChecked();
      const identityFields = dialog.locator('.model-grid').filter({
        hasText: locale === 'zh-CN' ? '协议' : 'Protocol'
      });
      const modelName = identityFields.getByRole('textbox');
      await expect(modelName).toHaveValue(inlineModel.name);
      const inputSurface = identityFields.locator('.mar-ui-input');
      const selectSurface = identityFields.locator('.mar-ui-select__field');
      await page.mouse.move(0, 0);
      await expect
        .poll(async () => {
          const [inputShadow, selectShadow] = await Promise.all(
            [inputSurface, selectSurface].map((surface) =>
              surface.evaluate((element) => getComputedStyle(element).boxShadow)
            )
          );
          return inputShadow !== 'none' && inputShadow === selectShadow;
        })
        .toBe(true);
      const proxyLabel = locale === 'zh-CN' ? 'SOCKS5 代理' : 'SOCKS5 proxy';
      const input = dialog.getByLabel(proxyLabel, { exact: true });
      await expect(input).toHaveValue(proxy);
      await expect(input).toHaveAttribute('type', 'password');
      const proxyField = dialog.locator('.mar-ui-input').filter({
        has: page.getByLabel(proxyLabel, { exact: true })
      });
      const toggle = proxyField.getByRole('button', {
        name: locale === 'zh-CN' ? '显示密码' : 'Show password',
        exact: true
      });
      await toggle.focus();
      await toggle.press('Space');
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await expect(input).toHaveAttribute('type', 'text');
      await toggle.press('Space');
      await expect(input).toHaveAttribute('type', 'password');
      await input.fill('http://proxy.invalid:1080');
      await dialog.getByRole('button', { name: save, exact: true }).click();
      await expect(input).toHaveAttribute('aria-invalid', 'true');
      await expect(dialog.getByRole('alert').filter({ hasText: /socks5/i })).toBeVisible();
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

test('proxy transport tests require a compatible Node and use standard Select states', async ({
  page
}, testInfo) => {
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

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.url}model-proxy.html?locale=en-US&test-node=socks5&theme=dark`);
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const nodeCombobox = { name: 'Execution Node', exact: true };
  const select = dialog.getByRole('combobox', nodeCombobox);
  await select.click();
  const list = dialog.getByRole('listbox');
  const node = list.getByRole('option', { name: 'Fixture Node', exact: true });
  const backup = list.getByRole('option', { name: 'Backup Node', exact: true });
  await expect(backup).toBeVisible();
  await node.hover();
  await expect(node).toHaveAttribute('aria-selected', 'false');
  await expect(node).toHaveCSS('outline-style', 'none');
  const { leftGap, rightGap, fill, hover } = await node.evaluate((row) => {
    const popup = row.closest<HTMLElement>('[role="listbox"]')!;
    const { left, right } = popup.getBoundingClientRect();
    const bounds = row.getBoundingClientRect();
    const style = getComputedStyle(popup);
    const probe = document.createElement('span');
    probe.style.color = 'var(--mar-ui-fill-row-hover)';
    row.append(probe);
    const hover = getComputedStyle(probe).color;
    probe.remove();
    return {
      leftGap: bounds.left - left - parseFloat(style.borderLeftWidth),
      rightGap: right - parseFloat(style.borderRightWidth) - bounds.right,
      fill: getComputedStyle(row).backgroundColor,
      hover
    };
  });
  expect(leftGap).toBeCloseTo(0, 0);
  expect(rightGap).toBeCloseTo(0, 0);
  expect(fill).toBe(hover);
  await page.screenshot({ path: testInfo.outputPath('model-test-node-hover.png') });
  await select.pressSequentially('fixture');
  await expect(select).toHaveValue('fixture');
  await expect(backup).toBeHidden();
  await expect(node).toBeVisible();
  await select.press('ArrowDown');
  await expect(node).toHaveCSS('outline-style', 'solid');
  await expect(select).toHaveAttribute('aria-activedescendant', (await node.getAttribute('id'))!);
  await list.screenshot({ path: testInfo.outputPath('model-test-node-keyboard.png') });
  await node.hover({ position: { x: 12, y: 12 } });
  await expect(node).toHaveCSS('outline-style', 'none');
  await select.press('Escape');
  await expect(list).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(select).toBeFocused();
  await expect(select).toHaveValue('');
  await select.pressSequentially('fixture');
  await select.press('ArrowDown');
  await select.press('Enter');
  await expect(select).toHaveAttribute('placeholder', 'Fixture Node');
  // The non-input end of the field must also open without a keyboard outline.
  const field = dialog.locator('.mar-ui-select__field').filter({
    has: page.getByRole('combobox', nodeCombobox)
  });
  const bounds = (await field.boundingBox())!;
  await field.click({ position: { x: bounds.width - 18, y: bounds.height / 2 } });
  await expect(node).toHaveAttribute('aria-selected', 'true');
  await expect(node).toHaveCSS('outline-style', 'none');
});
