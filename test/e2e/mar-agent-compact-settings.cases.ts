import { expect, test, type Locator, type Page } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

type EnterpriseRole = 'ADMIN' | 'ORG_ADMIN' | 'MEMBER';

type Identity = {
  readonly role: EnterpriseRole;
  readonly licenseState: 'ENTERPRISE_VALID' | 'ENTERPRISE_FROZEN';
  readonly managementWritable: boolean;
};

type Locale = {
  readonly openConsole: string;
  readonly modelTab: string;
  readonly credentialsTab: string;
  readonly personalOrderTab: string;
  readonly systemConfiguration: string;
  readonly compactTab: string;
  readonly compactEnabled: string;
  readonly compactModel: string;
  readonly compactEffort: string;
  readonly compactSave: string;
  readonly compactSaved: string;
  readonly compactModelRequired: string;
  readonly compactEffortRequired: string;
};

function locale(english: boolean): Locale {
  return english
    ? {
        openConsole: 'Open console',
        modelTab: 'Models',
        credentialsTab: 'OAuth credentials',
        personalOrderTab: 'My model order',
        systemConfiguration: 'System Configuration',
        compactTab: 'Advanced',
        compactEnabled: 'Enable dedicated Compact model',
        compactModel: 'Model',
        compactEffort: 'Reasoning effort',
        compactSave: 'Save',
        compactSaved: 'Compact configuration saved.',
        compactModelRequired: 'Choose an enabled model.',
        compactEffortRequired: 'Choose a reasoning effort supported by this model.'
      }
    : {
        openConsole: '进入控制台',
        modelTab: '模型',
        credentialsTab: 'OAuth 凭据',
        personalOrderTab: '我的模型顺序',
        systemConfiguration: '系统配置',
        compactTab: '高级',
        compactEnabled: '启用专用 Compact 模型',
        compactModel: '模型',
        compactEffort: '思考强度',
        compactSave: '保存',
        compactSaved: 'Compact 配置已保存。',
        compactModelRequired: '请选择已启用的模型。',
        compactEffortRequired: '请选择该模型支持的思考强度。'
      };
}

function model(
  id: string,
  name: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    name,
    protocol: 'OPENAI_RESPONSES',
    baseUrl: 'https://api.openai.com/v1',
    modelId: id,
    contextWindowTokens: 200_000,
    maxOutputTokens: 16_384,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['medium'],
    defaultReasoningEffort: 'medium',
    titleGeneration: false,
    codeMode: false,
    hostedWebSearch: false,
    responsesPreviousResponseId: false,
    enabled: true,
    sortOrder: 0,
    access: 'RESTRICTED',
    credentialType: 'INLINE_API_KEY',
    credentialConfigured: true,
    lastTestedAt: null,
    lastTestStatus: 'UNVERIFIED',
    lastTestCode: null,
    ...overrides
  };
}

const defaultDisabledConfiguration = { enabled: false, modelId: null, reasoningEffort: null };

async function mockMarAgentConsole(page: Page, english: boolean, identity: Identity) {
  if (english) await page.addInitScript(() => localStorage.setItem('mar.locale.v2', 'en-US'));
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);

  const admin = {
    authenticated: true,
    mustChangePassword: false,
    username: 'admin',
    isAdmin: identity.role === 'ADMIN',
    edition: 'ENTERPRISE',
    licenseState: identity.licenseState,
    role: identity.role,
    organizationId: 1,
    managementWritable: identity.managementWritable
  };
  let authenticated = false;
  await page.unroute('**/api/auth/me');
  await page.unroute('**/api/auth/login');
  await page.route('**/api/auth/me', (route) =>
    json(route, authenticated ? admin : { authenticated: false, mustChangePassword: false })
  );
  await page.route('**/api/auth/login', (route) => {
    authenticated = true;
    return json(route, { ...admin, csrfToken: 'csrf-1' });
  });
  await page.route('**/api/license', (route) =>
    json(route, {
      edition: 'ENTERPRISE',
      state: identity.licenseState,
      reason: null,
      licenseId: 'license-1',
      enterpriseName: 'Compact test enterprise',
      expiresAt: null,
      managementWritable: identity.managementWritable
    })
  );
  await page.route('**/api/license/request-code', (route) =>
    json(route, { requestCode: 'MAR1.compact.test' })
  );
  await page.route('**/api/resources*', (route) => json(route, { nodes: [], workspaces: [] }));
  await page.route('**/api/management/nodes', (route) => json(route, { nodes: [] }));
  await page.route('**/api/enterprise/users', (route) => json(route, { users: [] }));
  await page.route('**/api/environment-secrets**', (route) => json(route, { secrets: [] }));
  await page.route('**/api/mar-agent/models', (route) => json(route, { models: [] }));
  await page.route('**/api/admin/mar-agent/prompt-completion', (route) =>
    json(route, { configuration: { enabled: true, modelId: null, reasoningEffort: null } })
  );
  await page.route('**/api/admin/mar-agent/image-generation', (route) =>
    json(route, { configuration: [] })
  );
}

async function mockOrganizations(page: Page): Promise<void> {
  await page.route('**/api/organizations', (route) =>
    json(route, { organizations: [{ id: 1, name: 'Root', parentOrganizationId: null }] })
  );
}

function compactModels(): Record<string, unknown>[] {
  return [
    model('coding-anthropic', 'coding', {
      protocol: 'ANTHROPIC_MESSAGES',
      baseUrl: 'https://api.anthropic.com',
      reasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'high',
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
    }),
    model('luna-responses', 'luna'),
    model('minimal-model', 'minimal', {
      reasoningEfforts: [],
      defaultReasoningEffort: 'low'
    }),
    model('retired-model', 'retired', { enabled: false })
  ];
}

type CompactMock = {
  reads: () => number;
  writes: () => readonly Record<string, unknown>[];
  requests: () => number;
  setConfiguration: (configuration: Record<string, unknown>) => void;
};

async function mockCompactEndpoint(page: Page): Promise<CompactMock> {
  const models = compactModels();
  await page.route(/\/api\/admin\/mar-agent\/models$/u, (route) => json(route, { models }));
  await page.route(/\/api\/admin\/mar-agent\/codex-credentials$/u, (route) =>
    json(route, { credentials: [] })
  );
  let configuration: Record<string, unknown> = { ...defaultDisabledConfiguration };
  let reads = 0;
  let requests = 0;
  const writes: Record<string, unknown>[] = [];
  await page.route(/\/api\/admin\/mar-agent\/compact$/u, (route) => {
    requests += 1;
    if (route.request().method() === 'GET') {
      reads += 1;
      return json(route, { configuration });
    }
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      writes.push(body);
      configuration = body;
      return json(route, { configuration });
    }
    return json(route, {}, 405);
  });
  return {
    reads: () => reads,
    writes: () => writes,
    requests: () => requests,
    setConfiguration: (next) => {
      configuration = next;
    }
  };
}

// Shared hosts occasionally flap network interfaces while Chromium is fetching the dev-server
// module graph, killing in-flight requests with ERR_NETWORK_CHANGED and leaving the SPA shell
// unmounted. A bounded reload recovers that environmental failure; it never retries assertions.
async function gotoConsole(page: Page, management: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    await page.goto(`/console?view=management&management=${management}`);
    try {
      await page.waitForSelector('#app > *', { timeout: 20_000 });
      return;
    } catch (error) {
      if (attempt >= 2) throw error;
    }
  }
}

async function openMarAgentManagement(page: Page, strings: Locale): Promise<void> {
  await gotoConsole(page, 'mar-agent-models');
  await page.getByRole('button', { name: strings.openConsole, exact: true }).click();
}

function compactFormItems(panel: Locator, page: Page, strings: Locale) {
  return {
    enabled: panel.locator('.el-form-item').filter({
      has: page.getByText(strings.compactEnabled, { exact: true })
    }),
    model: panel.locator('.el-form-item').filter({
      has: page.getByText(strings.compactModel, { exact: true })
    }),
    effort: panel.locator('.el-form-item').filter({
      has: page.getByText(strings.compactEffort, { exact: true })
    })
  };
}

async function openCompactTab(
  page: Page,
  strings: Locale,
  writable = true
): Promise<{ readonly panel: Locator; readonly items: ReturnType<typeof compactFormItems> }> {
  const tab = page.getByRole('tab', { name: strings.compactTab, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  const panel = page
    .getByRole('tabpanel', { name: strings.compactTab, exact: true })
    .locator('.compact-settings')
    .first();
  const items = compactFormItems(panel, page, strings);
  if (writable)
    await expect(items.model.locator('.el-select__wrapper')).not.toHaveClass(/is-disabled/u, {
      timeout: 20_000
    });
  return { panel, items };
}

async function selectModel(page: Page, items: ReturnType<typeof compactFormItems>, name: string) {
  await items.model.locator('.el-select__wrapper').click();
  await page.getByRole('option', { name, exact: true }).click();
}

for (const english of [false, true]) {
  const strings = locale(english);
  const language = english ? 'en-US' : 'zh-CN';
  test(`Prompt Tab settings save independently of Compact ${language}`, async ({ page }) => {
    await mockMarAgentConsole(page, english, {
      role: 'ADMIN',
      licenseState: 'ENTERPRISE_VALID',
      managementWritable: true
    });
    await mockOrganizations(page);
    const compact = await mockCompactEndpoint(page);
    const writes: unknown[] = [];
    let configuration = {
      enabled: true,
      modelId: null as string | null,
      reasoningEffort: null as string | null
    };
    await page.route('**/api/admin/mar-agent/prompt-completion', (route) => {
      if (route.request().method() === 'PUT') {
        configuration = route.request().postDataJSON();
        writes.push(configuration);
      }
      return json(route, { configuration });
    });
    await openMarAgentManagement(page, strings);
    await openCompactTab(page, strings);
    const panel = page
      .getByRole('tabpanel', { name: strings.compactTab, exact: true })
      .locator('.compact-settings')
      .nth(1);
    const save = panel.getByRole('button', { name: english ? 'Save' : '保存', exact: true });
    await expect(panel.locator('.el-switch')).toHaveClass(/is-checked/u);
    await save.click();
    await expect(panel.getByText(strings.compactModelRequired, { exact: true })).toBeVisible();
    expect(writes).toHaveLength(0);
    await panel.locator('.el-select__wrapper').first().click();
    await page.getByRole('option', { name: 'luna', exact: true }).click();
    await save.click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toEqual({
      enabled: true,
      modelId: 'luna-responses',
      reasoningEffort: 'medium'
    });
    expect(compact.writes()).toHaveLength(0);
    await panel.getByRole('button', { name: english ? 'Refresh' : '刷新', exact: true }).click();
    await expect(panel.locator('.el-select__wrapper').first()).toContainText('luna');
  });

  test(`Work prompt prediction preference is browser-local in Appearance ${language}`, async ({
    page
  }) => {
    await mockMarAgentConsole(page, english, {
      role: 'ADMIN',
      licenseState: 'ENTERPRISE_VALID',
      managementWritable: true
    });
    await mockOrganizations(page);
    await page.route('**/api/oauth-bindings', (route) => json(route, { bindings: [] }));
    const preferenceRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/prompt-completion/preferences')) {
        preferenceRequests.push(request.method());
      }
    });

    async function openAppearance() {
      await page.getByRole('button', { name: english ? 'Settings' : '设置', exact: true }).click();
      await page
        .getByRole('button', { name: english ? 'Appearance' : '外观', exact: true })
        .click();
    }
    await openMarAgentManagement(page, strings);
    await openAppearance();
    const prediction = page.getByRole('combobox', {
      name: english ? 'Composer Prediction' : '输入预测',
      exact: true
    });
    const row = page.locator('.completion-preferences');
    await expect(row).toContainText(english ? 'On' : '开启');
    expect(
      await page.evaluate(() => localStorage.getItem('mar.prompt-completion.enabled'))
    ).toBeNull();
    await expect(row.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('switch')).toHaveCount(0);
    await expect(prediction).toBeVisible();
    await row.locator('.el-select').click();
    await expect(page.getByRole('option')).toHaveCount(2);
    await page.getByRole('option', { name: english ? 'Off' : '关闭', exact: true }).click();
    await expect(row).toContainText(english ? 'Off' : '关闭');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('mar.prompt-completion.enabled')))
      .toBe('false');
    await page.reload();
    await openAppearance();
    await expect(row).toContainText(english ? 'Off' : '关闭');
    await prediction.focus();
    await prediction.press('Enter');
    await page.getByRole('option', { name: english ? 'On' : '开启', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('mar.prompt-completion.enabled')))
      .toBe('true');
    expect(preferenceRequests).toEqual([]);
  });

  test(`MAR Agent Compact settings support complete editing and required-field validation ${language}`, async ({
    page
  }) => {
    test.setTimeout(180_000);
    await mockMarAgentConsole(page, english, {
      role: 'ADMIN',
      licenseState: 'ENTERPRISE_VALID',
      managementWritable: true
    });
    await mockOrganizations(page);
    const mock = await mockCompactEndpoint(page);

    await openMarAgentManagement(page, strings);
    const { panel, items } = await openCompactTab(page, strings);

    await expect.poll(() => mock.reads()).toBe(1);
    const modelSelect = items.model.locator('.el-select__wrapper');
    const effortSelect = items.effort.locator('.el-select__wrapper');
    const saveButton = panel.getByRole('button', { name: strings.compactSave, exact: true });

    // The Compact section owns exactly the three deployment-wide controls; there is no
    // compact-mode selector and no additional per-model switch.
    await expect(panel.locator('.el-form-item')).toHaveCount(3);
    await expect(panel.locator('.el-switch')).toHaveCount(1);
    await expect(panel.locator('.el-select')).toHaveCount(2);
    await expect(panel.locator('.el-checkbox')).toHaveCount(0);
    await expect(panel.locator('.el-radio')).toHaveCount(0);
    await expect(panel.getByText(/标准|高密度|Standard|High-density/u)).toHaveCount(0);

    // Initial authority: disabled configuration without model or effort.
    await expect(panel.locator('.el-switch')).not.toHaveClass(/is-checked/u);
    await expect(modelSelect).not.toContainText('coding');
    await expect(effortSelect).toHaveClass(/is-disabled/u);

    // Enabling without a model is blocked by the form rules before any request.
    await panel.locator('.el-switch').click();
    await expect(panel.locator('.el-switch')).toHaveClass(/is-checked/u);
    await saveButton.click();
    await expect(page.getByText(strings.compactModelRequired, { exact: true })).toBeVisible();
    await expect(page.getByText(strings.compactEffortRequired, { exact: true })).toBeVisible();
    expect(mock.writes()).toHaveLength(0);

    // Candidates come from the managed model directory; the preferred organization model is
    // offered first and disabled models cannot be picked.
    await modelSelect.click();
    await expect(
      page.locator('.el-select-dropdown:visible .el-select-dropdown__item').first()
    ).toContainText('coding');
    await expect(page.getByRole('option', { name: 'retired', exact: true })).toHaveClass(
      /is-disabled/u
    );
    await page.keyboard.press('Escape');

    // Effort follows each model's public effort list and its declared default.
    await selectModel(page, items, 'coding');
    await expect(modelSelect).toContainText('coding');
    await expect(effortSelect).toContainText('high');
    await effortSelect.click();
    await expect(page.getByRole('option', { name: 'low', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'high', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'medium', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await selectModel(page, items, 'luna');
    await expect(effortSelect).toContainText('medium');
    await effortSelect.click();
    await expect(page.getByRole('option', { name: 'medium', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'low', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await selectModel(page, items, 'minimal');
    await expect(effortSelect).toContainText('low');
    await selectModel(page, items, 'coding');
    await expect(effortSelect).toContainText('high');

    await saveButton.click();
    await expect.poll(() => mock.writes().length).toBe(1);
    expect(mock.writes()[0]).toEqual({
      enabled: true,
      modelId: 'coding-anthropic',
      reasoningEffort: 'high'
    });
    await expect(page.getByText(strings.compactSaved, { exact: true })).toBeVisible();
    await expect(panel.locator('.el-switch')).toHaveClass(/is-checked/u);
    await expect(modelSelect).toContainText('coding');
    await expect(effortSelect).toContainText('high');

    // Reopening the tab re-reads the server state instead of keeping a local copy.
    await page.getByRole('tab', { name: strings.modelTab, exact: true }).click();
    mock.setConfiguration({
      enabled: true,
      modelId: 'luna-responses',
      reasoningEffort: 'medium'
    });
    const readsAfterSave = mock.reads();
    await openCompactTab(page, strings);
    await expect.poll(() => mock.reads()).toBe(readsAfterSave + 1);
    await expect(panel.locator('.el-switch')).toHaveClass(/is-checked/u);
    await expect(modelSelect).toContainText('luna');
    await expect(effortSelect).toContainText('medium');

    // Disabling keeps the selected model but turns the dedicated model off.
    await panel.locator('.el-switch').click();
    await expect(panel.locator('.el-switch')).not.toHaveClass(/is-checked/u);
    await saveButton.click();
    await expect.poll(() => mock.writes().length).toBe(2);
    expect(mock.writes()[1]).toEqual({
      enabled: false,
      modelId: 'luna-responses',
      reasoningEffort: 'medium'
    });

    // Switching to the main model tab and back never rewrites the configuration.
    const writesBeforeTabSwitch = mock.writes().length;
    const readsBeforeTabSwitch = mock.reads();
    await page.getByRole('tab', { name: strings.modelTab, exact: true }).click();
    await openCompactTab(page, strings);
    await expect.poll(() => mock.reads()).toBe(readsBeforeTabSwitch + 1);
    await expect(panel.locator('.el-switch')).not.toHaveClass(/is-checked/u);
    await expect(modelSelect).toContainText('luna');
    await expect(effortSelect).toContainText('medium');
    expect(mock.writes()).toHaveLength(writesBeforeTabSwitch);

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerWidth)
    );
    await page.screenshot({ path: test.info().outputPath(`mar-agent-compact-${language}.png`) });

    // The compact configuration has no entry on the system configuration page.
    const compactRequestsBeforeSystemPage = mock.requests();
    await gotoConsole(page, 'configuration');
    await expect(
      page.getByRole('button', { name: strings.systemConfiguration, exact: true })
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/compact/iu)).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(mock.requests()).toBe(compactRequestsBeforeSystemPage);
  });
}

for (const role of ['ORG_ADMIN', 'MEMBER'] as const) {
  test(`MAR Agent Compact settings are hidden from ${role} without API requests zh-CN`, async ({
    page
  }) => {
    test.setTimeout(150_000);
    await mockMarAgentConsole(page, false, {
      role,
      licenseState: 'ENTERPRISE_VALID',
      managementWritable: true
    });
    await mockOrganizations(page);
    const mock = await mockCompactEndpoint(page);
    const zhStrings = locale(false);

    await openMarAgentManagement(page, zhStrings);
    await expect(page.locator('.el-table__row').filter({ hasText: 'coding' })).toBeVisible();

    await expect(page.getByRole('tab', { name: '高级', exact: true })).toHaveCount(0);
    for (const tabName of [zhStrings.credentialsTab, zhStrings.personalOrderTab]) {
      await page.getByRole('tab', { name: tabName, exact: true }).click();
    }
    await page.getByRole('tab', { name: zhStrings.modelTab, exact: true }).click();
    await page.waitForTimeout(300);
    expect(mock.requests()).toBe(0);
    expect(mock.reads()).toBe(0);
  });
}

test('MAR Agent Compact settings stay read-only under a frozen license en-US', async ({ page }) => {
  test.setTimeout(150_000);
  await mockMarAgentConsole(page, true, {
    role: 'ADMIN',
    licenseState: 'ENTERPRISE_FROZEN',
    managementWritable: false
  });
  await mockOrganizations(page);
  const mock = await mockCompactEndpoint(page);
  const enStrings = locale(true);

  await openMarAgentManagement(page, enStrings);
  const { panel, items } = await openCompactTab(page, enStrings, false);

  await expect.poll(() => mock.reads()).toBe(1);
  await expect(panel.locator('.el-switch')).toHaveClass(/is-disabled/u);
  await expect(items.model.locator('.el-select__wrapper')).toHaveClass(/is-disabled/u);
  await expect(items.effort.locator('.el-select__wrapper')).toHaveClass(/is-disabled/u);
  await expect(
    panel.getByRole('button', { name: enStrings.compactSave, exact: true })
  ).toBeDisabled();
  expect(mock.writes()).toHaveLength(0);
  expect(mock.requests()).toBe(1);
});

test('MAR Agent Compact settings fit a 320px viewport without horizontal overflow zh-CN', async ({
  page
}) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 320, height: 720 });
  await mockMarAgentConsole(page, false, {
    role: 'ADMIN',
    licenseState: 'ENTERPRISE_VALID',
    managementWritable: true
  });
  await mockOrganizations(page);
  const mock = await mockCompactEndpoint(page);
  mock.setConfiguration({ enabled: true, modelId: 'coding-anthropic', reasoningEffort: 'high' });
  const zhStrings = locale(false);

  await openMarAgentManagement(page, zhStrings);
  const { panel, items } = await openCompactTab(page, zhStrings);
  await expect.poll(() => mock.reads()).toBe(1);
  await expect(panel.locator('.el-switch')).toHaveClass(/is-checked/u);
  await expect(items.model.locator('.el-select__wrapper')).toContainText('coding');

  const metrics = await page.evaluate(() => {
    const section = document.querySelector<HTMLElement>('.compact-settings');
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      sectionOverflow: section ? section.scrollWidth - section.clientWidth : 0
    };
  });
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.sectionOverflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: test.info().outputPath('mar-agent-compact-zh-CN-320px.png') });
});

test('MAR Agent Compact settings fit a 390px mobile viewport en-US', async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await mockMarAgentConsole(page, true, {
    role: 'ADMIN',
    licenseState: 'ENTERPRISE_VALID',
    managementWritable: true
  });
  await mockOrganizations(page);
  const mock = await mockCompactEndpoint(page);
  mock.setConfiguration({ enabled: true, modelId: 'coding-anthropic', reasoningEffort: 'high' });
  const enStrings = locale(true);

  await openMarAgentManagement(page, enStrings);
  const { panel, items } = await openCompactTab(page, enStrings);
  await expect.poll(() => mock.reads()).toBe(1);
  await expect(panel.locator('.el-form-item')).toHaveCount(3);
  await expect(items.effort.locator('.el-select__wrapper')).toContainText('high');

  const metrics = await page.evaluate(() => {
    const section = document.querySelector<HTMLElement>('.compact-settings');
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      sectionOverflow: section ? section.scrollWidth - section.clientWidth : 0
    };
  });
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.sectionOverflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: test.info().outputPath('mar-agent-compact-en-US-390px.png') });
});
