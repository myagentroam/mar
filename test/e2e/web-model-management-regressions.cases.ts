import { expect, test, type Locator, type Page } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

type Locale = {
  readonly openConsole: string;
  readonly modelTab: string;
  readonly credentialsTab: string;
  readonly add: string;
  readonly edit: string;
  readonly remove: string;
  readonly close: string;
  readonly save: string;
  readonly cancel: string;
  readonly refresh: string;
  readonly test: string;
  readonly testTitle: string;
  readonly modelName: string;
  readonly modelId: string;
  readonly protocol: string;
  readonly modelOwnership: string;
  readonly organizationScope: string;
  readonly codexCredential: string;
  readonly details: string;
  readonly speed: string;
  readonly speedDefault: string;
  readonly speedFast: string;
  readonly speedUltrafast: string;
  readonly loadCatalog: string;
  readonly importCatalog: string;
  readonly created: string;
};

function locale(english: boolean): Locale {
  return english
    ? {
        openConsole: 'Open console',
        modelTab: 'Models',
        credentialsTab: 'OAuth credentials',
        add: 'Add model',
        edit: 'Edit',
        remove: 'Remove',
        close: 'Close',
        save: 'Save',
        cancel: 'Cancel',
        refresh: 'Refresh',
        test: 'Test',
        testTitle: 'Test model transport',
        modelName: 'Model name',
        modelId: 'Model ID',
        protocol: 'Protocol',
        modelOwnership: 'Model ownership',
        organizationScope: 'Organization',
        codexCredential: 'OAuth credential',
        details: 'Details',
        speed: 'Speed',
        speedDefault: 'Default',
        speedFast: 'Fast',
        speedUltrafast: 'Ultrafast',
        loadCatalog: 'Load model catalog',
        importCatalog: 'Import selected models',
        created: 'Created'
      }
    : {
        openConsole: '进入控制台',
        modelTab: '模型',
        credentialsTab: 'OAuth 凭据',
        add: '添加模型',
        edit: '编辑',
        remove: '删除',
        close: '关闭',
        save: '保存',
        cancel: '取消',
        refresh: '刷新',
        test: '测试',
        testTitle: '测试模型传输',
        modelName: '模型名称',
        modelId: '模型 ID',
        protocol: '协议',
        modelOwnership: '模型归属',
        organizationScope: '组织',
        codexCredential: 'OAuth 凭据',
        details: '详情',
        speed: '速度',
        speedDefault: '默认',
        speedFast: 'Fast',
        speedUltrafast: 'Ultrafast',
        loadCatalog: '加载模型目录',
        importCatalog: '导入所选模型',
        created: '已创建'
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
    apiKeyConfigured: true,
    lastTestedAt: null,
    lastTestStatus: 'UNVERIFIED',
    lastTestCode: null,
    ...overrides
  };
}

async function mockEnterpriseConsole(page: Page, english: boolean): Promise<void> {
  if (english) await page.addInitScript(() => localStorage.setItem('mar.locale.v2', 'en-US'));
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);

  let authenticated = false;
  const admin = {
    authenticated: true,
    mustChangePassword: false,
    username: 'admin',
    isAdmin: true,
    edition: 'ENTERPRISE',
    licenseState: 'ENTERPRISE_VALID',
    role: 'ADMIN',
    organizationId: 1,
    managementWritable: true
  };
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
      state: 'ENTERPRISE_VALID',
      reason: null,
      licenseId: 'license-1',
      enterpriseName: 'Model test enterprise',
      expiresAt: null,
      managementWritable: true
    })
  );
  await page.route('**/api/license/request-code', (route) =>
    json(route, { requestCode: 'MAR1.model-management.test' })
  );
  await page.route('**/api/resources*', (route) => json(route, { nodes: [], workspaces: [] }));
  await page.route('**/api/management/nodes', (route) => json(route, { nodes: [] }));
  await page.route('**/api/enterprise/users', (route) => json(route, { users: [] }));
  await page.route('**/api/environment-secrets**', (route) => json(route, { secrets: [] }));
  await page.route('**/api/mar-agent/models', (route) => json(route, { models: [] }));
  await page.route('**/api/admin/mar-agent/image-generation', (route) =>
    json(route, { configuration: [] })
  );
}

async function openModels(page: Page, strings: Locale): Promise<void> {
  await page.goto('/console?view=management&management=mar-agent-models');
  await page.getByRole('button', { name: strings.openConsole, exact: true }).click();
  const tab = page.getByRole('tab', { name: strings.modelTab, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

async function selectOrganization(page: Page, form: Locator, strings: Locale): Promise<void> {
  const ownership = form.locator('.el-form-item').filter({ hasText: strings.modelOwnership });
  await ownership.locator('.el-select__wrapper').click();
  await page.getByRole('option', { name: strings.organizationScope, exact: true }).click();
  const organization = form.locator('.el-cascader input');
  await organization.fill('Platform');
  await page.getByRole('listitem').filter({ hasText: 'Platform' }).click();
}

for (const english of [false, true]) {
  const strings = locale(english);
  const language = english ? 'en-US' : 'zh-CN';

  test(`Model management preserves second-page actions and falls back after deleting the last page ${language}`, async ({
    page
  }) => {
    test.setTimeout(60_000);
    await mockEnterpriseConsole(page, english);
    await page.route('**/api/organizations', (route) =>
      json(route, {
        organizations: [{ id: 1, name: 'Root', parentOrganizationId: null }]
      })
    );

    let models = Array.from({ length: 12 }, (_, index) =>
      model(`model-${index + 1}`, `Model ${index + 1}`, { sortOrder: index })
    );
    let modelReads = 0;
    const modelTests: Record<string, unknown>[] = [];
    const updates: Record<string, unknown>[] = [];
    await page.route(/\/api\/admin\/mar-agent\/models$/u, (route) => {
      if (route.request().method() !== 'GET') return json(route, {}, 405);
      modelReads += 1;
      return json(route, { models });
    });
    await page.route('**/api/nodes', (route) =>
      json(route, {
        nodes: [
          {
            id: 'node-runtime',
            displayName: 'Runtime Node',
            platform: 'linux',
            architecture: 'x64',
            nodeAppVersion: '0.9.31',
            nodeVersion: 'v24.15.0',
            connected: true,
            disabled: false,
            capabilities: { marAgentRuntimeCredentials: { apiVersion: 1 } }
          }
        ]
      })
    );
    await page.route('**/api/admin/mar-agent/codex-credentials', (route) =>
      json(route, { credentials: [] })
    );
    await page.route(/\/api\/admin\/mar-agent\/models\/[^/]+$/u, (route) => {
      const id = new URL(route.request().url()).pathname.split('/').at(-1);
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        updates.push(body);
        models = models.map((entry) => (entry.id === id ? { ...entry, ...body } : entry));
        return json(route, { model: models.find((entry) => entry.id === id) });
      }
      if (route.request().method() === 'DELETE') {
        models = models.filter((entry) => entry.id !== id);
        return route.fulfill({ status: 204 });
      }
      return json(route, {}, 405);
    });
    await page.route(/\/api\/admin\/mar-agent\/models\/[^/]+\/test$/u, (route) => {
      modelTests.push(route.request().postDataJSON() as Record<string, unknown>);
      return json(route, { success: true, code: null, message: null, httpStatus: null });
    });

    await openModels(page, strings);
    const modelPanel = page.getByRole('tabpanel', { name: strings.modelTab });
    await modelPanel.locator('.el-pager li.number').filter({ hasText: /^2$/u }).click();
    const pager = modelPanel.locator('.el-pager li.is-active');
    await expect(pager).toHaveText('2');

    const secondPageModel = page.locator('.el-table__row').filter({ hasText: 'Model 11' });
    await secondPageModel.getByRole('button', { name: strings.edit, exact: true }).click();
    const editDialog = page.getByRole('dialog', { name: strings.edit, exact: true });
    await editDialog.getByRole('textbox', { name: strings.modelName }).fill('Edited Model 11');
    await editDialog.getByRole('button', { name: strings.save, exact: true }).click();
    await expect(
      page.locator('.el-table__row').filter({ hasText: 'Edited Model 11' })
    ).toBeVisible();
    await expect(pager).toHaveText('2');

    const editedRow = page.locator('.el-table__row').filter({ hasText: 'Edited Model 11' });
    await editedRow.getByRole('button', { name: strings.test, exact: true }).click();
    const testDialog = page.getByRole('dialog', { name: strings.testTitle, exact: true });
    await testDialog.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Runtime Node', exact: true }).click();
    await testDialog.getByRole('button', { name: strings.test, exact: true }).click();
    await expect(testDialog).toHaveCount(0);
    await expect(pager).toHaveText('2');

    const readsBeforeRefresh = modelReads;
    await page.getByRole('button', { name: strings.refresh, exact: true }).click();
    await expect.poll(() => modelReads).toBe(readsBeforeRefresh + 1);
    await expect(pager).toHaveText('2');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ name: 'Edited Model 11' });
    expect(modelTests).toHaveLength(1);

    for (const name of ['Model 12', 'Edited Model 11']) {
      const row = page.locator('.el-table__row').filter({ hasText: name });
      await row.getByRole('button', { name: strings.remove, exact: true }).click();
      const confirmation = page.locator('.el-message-box');
      await confirmation.getByRole('button', { name: strings.remove, exact: true }).click();
      await expect(row).toHaveCount(0);
    }
    await expect(pager).toHaveText('1');
    await expect(
      page.locator('.el-table__row').filter({ has: page.getByText('Model 1', { exact: true }) })
    ).toBeVisible();
  });

  test(`Enterprise model ownership covers connection types, ChatGPT credentials, and catalog imports ${language}`, async ({
    page
  }) => {
    test.setTimeout(60_000);
    await mockEnterpriseConsole(page, english);
    await page.route('**/api/organizations', (route) =>
      json(route, {
        organizations: [
          { id: 1, name: 'Root', parentOrganizationId: null },
          { id: 7, name: 'Platform', parentOrganizationId: 1 }
        ]
      })
    );

    let models = [
      model('personal-model', 'Personal model', {
        ownership: { ownerType: 'PERSONAL', ownerUserId: 9 }
      }),
      model('organization-model', 'Organization model', {
        ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 7 }
      })
    ];
    const chatgptCredential = {
      id: 'enterprise-chatgpt',
      name: 'Enterprise ChatGPT',
      type: 'CHATGPT_OAUTH',
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 },
      status: 'ACTIVE',
      accessTokenExpiresAt: null,
      lastRefreshAt: null,
      lastCheckedAt: null,
      proxy: { configured: false },
      authorization: 'AUTHORIZED',
      accountId: 'chatgpt-account',
      revision: 1
    };
    const codexCredential = {
      id: 'organization-codex',
      name: 'Organization Codex',
      type: 'CODEX_OAUTH',
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 7 },
      status: 'ACTIVE',
      accessTokenExpiresAt: null,
      lastRefreshAt: null,
      lastCheckedAt: null,
      proxy: { configured: false },
      accountId: 'codex-account',
      revision: 1
    };
    const createBodies: Record<string, unknown>[] = [];
    const importBodies: Record<string, unknown>[] = [];

    await page.route(/\/api\/admin\/mar-agent\/models$/u, (route) => {
      if (route.request().method() === 'GET') return json(route, { models });
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        createBodies.push(body);
        const credential = body.credential as Record<string, unknown> | undefined;
        const created = model('created-chatgpt-model', String(body.name), {
          ...body,
          id: 'created-chatgpt-model',
          credentialType: credential?.type ?? 'INLINE_API_KEY',
          credentialConfigured: true,
          ownership: body.ownership
        });
        models = [...models, created];
        return json(route, { model: created }, 201);
      }
      return json(route, {}, 405);
    });
    await page.route(/\/api\/admin\/mar-agent\/codex-credentials$/u, (route) =>
      json(route, { credentials: [chatgptCredential, codexCredential] })
    );
    await page.route(/\/api\/admin\/mar-agent\/codex-credentials\/enterprise-chatgpt$/u, (route) =>
      json(route, { details: { credential: chatgptCredential, socks5Url: null } })
    );
    await page.route(/\/api\/admin\/mar-agent\/codex-credentials\/organization-codex$/u, (route) =>
      json(route, {
        details: { credential: codexCredential, socks5Url: null }
      })
    );
    await page.route(
      /\/api\/admin\/mar-agent\/codex-credentials\/organization-codex\/models\/load$/u,
      (route) =>
        json(route, {
          catalog: {
            catalogHash: 'c'.repeat(64),
            fetchedAt: 1_900_000_000_000,
            models: [
              {
                upstreamModelId: 'gpt-catalog-item',
                displayName: 'Catalog model',
                reasoningEfforts: ['medium'],
                unsupportedReasoningEfforts: [],
                inputCapabilities: ['TEXT'],
                hostedWebSearch: false,
                warnings: [],
                requiredInputs: ['contextWindowTokens']
              },
              {
                upstreamModelId: 'gpt-explicit-limits',
                displayName: 'Explicit catalog limits',
                contextWindowTokens: 200_000,
                maxOutputTokens: 16_384,
                reasoningEfforts: ['medium'],
                unsupportedReasoningEfforts: [],
                inputCapabilities: ['TEXT'],
                hostedWebSearch: false,
                warnings: [],
                requiredInputs: []
              }
            ]
          }
        })
    );
    await page.route(
      /\/api\/admin\/mar-agent\/codex-credentials\/organization-codex\/models\/import$/u,
      (route) => {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        importBodies.push(body);
        return json(route, {
          result: {
            items: [
              {
                upstreamModelId: 'gpt-catalog-item',
                status: 'CREATED',
                modelId: 'organization-catalog-model'
              }
            ]
          }
        });
      }
    );
    await page.route('**/api/resource-grants**', (route) => json(route, { grants: [] }));

    await openModels(page, strings);
    const personalRow = page.locator('.el-table__row').filter({ hasText: 'Personal model' });
    const organizationRow = page
      .locator('.el-table__row')
      .filter({ hasText: 'Organization model' });
    await expect(
      personalRow.getByRole('button', { name: english ? 'Grant' : '授权', exact: true })
    ).toHaveCount(0);
    await expect(
      organizationRow.getByRole('button', { name: english ? 'Grant' : '授权', exact: true })
    ).toBeVisible();

    await organizationRow.click();
    const initialDetails = page.getByRole('dialog', { name: strings.details, exact: true });
    await expect(initialDetails).toContainText('Root / Platform');
    await initialDetails.getByRole('button', { name: strings.close, exact: true }).click();

    await page.getByRole('button', { name: strings.add, exact: true }).click();
    const createDialog = page.getByRole('dialog', { name: strings.add, exact: true });
    const ownership = createDialog
      .locator('.el-form-item')
      .filter({ hasText: strings.modelOwnership });
    await expect(ownership).toBeVisible();
    const protocolSelect = createDialog
      .locator('.el-form-item')
      .filter({ hasText: strings.protocol })
      .locator('.el-select__wrapper');
    const protocolOptions = ['Codex (legacy)', 'ChatGPT', 'Anthropic Messages', 'OpenAI Responses'];
    for (const protocol of protocolOptions) {
      await protocolSelect.click();
      await expect(page.getByRole('option', { name: protocol, exact: true })).toBeVisible();
      await page.getByRole('option', { name: protocol, exact: true }).click();
      await expect(ownership).toBeVisible();
    }
    await protocolSelect.click();
    await page.getByRole('option', { name: 'ChatGPT', exact: true }).click();
    await selectOrganization(page, createDialog, strings);

    const credentialSelect = createDialog
      .locator('.el-form-item')
      .filter({ hasText: strings.codexCredential })
      .locator('.el-select__wrapper');
    await credentialSelect.click();
    await expect(
      page.getByRole('option', { name: 'Enterprise ChatGPT', exact: true })
    ).toBeVisible();
    await page.getByRole('option', { name: 'Enterprise ChatGPT', exact: true }).click();
    await createDialog
      .getByRole('textbox', { name: strings.modelName })
      .fill('Organization ChatGPT');
    await createDialog.getByRole('textbox', { name: strings.modelId }).fill('gpt-chatgpt-org');
    await createDialog.getByRole('button', { name: strings.save, exact: true }).click();
    await expect(
      page.locator('.el-table__row').filter({ hasText: 'Organization ChatGPT' })
    ).toBeVisible();
    expect(createBodies).toHaveLength(1);
    expect(createBodies[0]).toMatchObject({
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://api.openai.com/v1',
      credential: { type: 'CREDENTIAL_REF', credentialId: 'enterprise-chatgpt' },
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 7 }
    });

    await page.getByRole('tab', { name: strings.credentialsTab, exact: true }).click();
    await page.locator('.el-table__row').filter({ hasText: 'Enterprise ChatGPT' }).click();
    const chatgptDetails = page.getByRole('dialog');
    const usageLink = chatgptDetails.getByRole('link', {
      name: english ? 'Manage usage' : '管理用量',
      exact: true
    });
    await expect(usageLink).toBeVisible();
    await expect(usageLink).not.toHaveClass(/el-button--primary/u);
    await expect(usageLink).toHaveAttribute('href', 'https://chatgpt.com/settings/usage');
    await expect(usageLink).toHaveAttribute('target', '_blank');
    await expect(usageLink).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(
      chatgptDetails.getByRole('button', {
        name: english ? 'Query usage' : '查询用量',
        exact: true
      })
    ).toHaveCount(0);
    await chatgptDetails.getByRole('button', { name: strings.close, exact: true }).click();
    await page.locator('.el-table__row').filter({ hasText: 'Organization Codex' }).click();
    const credentialDetails = page.getByRole('dialog');
    await expect(
      credentialDetails.getByRole('link', {
        name: english ? 'Manage usage' : '管理用量',
        exact: true
      })
    ).toHaveCount(0);
    await expect(credentialDetails).toContainText('Root / Platform');
    await credentialDetails.getByRole('button', { name: strings.loadCatalog, exact: true }).click();
    const catalogDialog = page.getByRole('dialog').filter({ hasText: 'Catalog model' });
    await expect(catalogDialog).toBeVisible();
    await expect(catalogDialog.getByRole('spinbutton')).toHaveValue('256000');
    await expect(
      catalogDialog.locator('.el-table__row').filter({ hasText: 'Explicit catalog limits' })
    ).toContainText('200000');
    await selectOrganization(page, catalogDialog, strings);
    await catalogDialog
      .locator('.el-table__row')
      .filter({ hasText: 'Catalog model' })
      .locator('.el-checkbox__inner')
      .click();
    await catalogDialog.getByRole('button', { name: strings.importCatalog, exact: true }).click();
    await expect(page.getByText(strings.created, { exact: true })).toBeVisible();
    expect(importBodies).toHaveLength(1);
    expect(importBodies[0]).toMatchObject({
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 7 },
      models: [{ upstreamModelId: 'gpt-catalog-item', contextWindowTokens: 256_000, enabled: true }]
    });
  });

  test(`Model speed settings support edits, details, and legacy Fast compatibility ${language}`, async ({
    page
  }) => {
    test.setTimeout(60_000);
    await mockEnterpriseConsole(page, english);
    await page.route('**/api/organizations', (route) =>
      json(route, {
        organizations: [{ id: 1, name: 'Root', parentOrganizationId: null }]
      })
    );
    let models = [
      model('legacy-speed-model', 'Legacy speed model', {
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        credentialType: 'CREDENTIAL_REF',
        credentialConfigured: true,
        apiKeyConfigured: false,
        fastMode: true
      }),
      model('chatgpt-speed-model', 'ChatGPT speed model', {
        baseUrl: 'https://api.openai.com/v1',
        credentialType: 'CREDENTIAL_REF',
        credentialConfigured: true,
        apiKeyConfigured: false,
        serviceTier: 'default'
      }),
      model('inline-responses-model', 'Inline Responses model', {
        credentialType: 'INLINE_API_KEY',
        serviceTier: 'priority'
      }),
      model('anthropic-model', 'Anthropic model', {
        protocol: 'ANTHROPIC_MESSAGES',
        baseUrl: 'https://api.anthropic.com',
        credentialType: 'INLINE_API_KEY',
        serviceTier: 'ultrafast'
      })
    ];
    const updates: { readonly body: Record<string, unknown> }[] = [];
    await page.route(/\/api\/admin\/mar-agent\/models$/u, (route) => json(route, { models }));
    await page.route(/\/api\/admin\/mar-agent\/models\/[^/]+$/u, (route) => {
      const id = new URL(route.request().url()).pathname.split('/').at(-1);
      if (route.request().method() !== 'PUT') return json(route, {}, 405);
      const body = route.request().postDataJSON() as Record<string, unknown>;
      updates.push({ body });
      models = models.map((entry) => (entry.id === id ? { ...entry, ...body } : entry));
      return json(route, { model: models.find((entry) => entry.id === id) });
    });
    await page.route(/\/api\/admin\/mar-agent\/codex-credentials$/u, (route) =>
      json(route, {
        credentials: [
          {
            id: 'speed-credential',
            name: 'Speed credential',
            type: 'CODEX_OAUTH',
            ownership: { ownerType: 'PERSONAL', ownerUserId: 1 },
            status: 'ACTIVE',
            accessTokenExpiresAt: null,
            lastRefreshAt: null,
            lastCheckedAt: null,
            proxy: { configured: false },
            accountId: 'speed-account',
            revision: 1
          }
        ]
      })
    );

    await openModels(page, strings);

    async function editModel(name: string): Promise<Locator> {
      const row = page.locator('.el-table__row').filter({ hasText: name });
      await row.getByRole('button', { name: strings.edit, exact: true }).click();
      return page.getByRole('dialog', { name: strings.edit, exact: true });
    }

    async function assertSpeedOptions(dialog: Locator): Promise<void> {
      const speedField = dialog.locator('.el-form-item').filter({ hasText: strings.speed });
      await expect(speedField).toBeVisible();
      await speedField.locator('.el-select__wrapper').click();
      for (const label of [strings.speedDefault, strings.speedFast, strings.speedUltrafast])
        await expect(page.getByRole('option', { name: label, exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
    }

    async function saveSpeed(name: string, value: string, label: string): Promise<void> {
      const dialog = await editModel(name);
      const speedField = dialog.locator('.el-form-item').filter({ hasText: strings.speed });
      await expect(speedField).toBeVisible();
      await speedField.locator('.el-select__wrapper').click();
      await page.getByRole('option', { name: label, exact: true }).click();
      await dialog.getByRole('button', { name: strings.save, exact: true }).click();
      await expect.poll(() => updates.at(-1)?.body.serviceTier).toBe(value);
      expect(updates.at(-1)?.body).not.toHaveProperty('highDensityCompaction');
      const row = page.locator('.el-table__row').filter({ hasText: name });
      await row.locator('td').first().click();
      const details = page.getByRole('dialog', { name: strings.details, exact: true });
      const speedDetail = details
        .getByRole('row')
        .filter({ has: page.getByText(strings.speed, { exact: true }) });
      await expect(speedDetail).toContainText(label);
      await details.getByRole('button', { name: strings.close, exact: true }).click();
    }

    const legacyDialog = await editModel('Legacy speed model');
    await expect(legacyDialog.getByText(/高密度压缩|High-density compaction/u)).toHaveCount(0);
    const conversationLabel = english ? 'Conversation model' : '对话模型';
    const conversationCheckbox = legacyDialog.getByRole('checkbox', {
      name: conversationLabel,
      exact: true
    });
    await expect(conversationCheckbox).toBeChecked();
    await legacyDialog.locator('label.el-checkbox').filter({ hasText: conversationLabel }).click();
    await expect(conversationCheckbox).not.toBeChecked();
    const legacySpeedField = legacyDialog
      .locator('.el-form-item')
      .filter({ hasText: strings.speed });
    await expect(legacySpeedField).toBeVisible();
    await expect(legacySpeedField.locator('.el-select__wrapper')).toContainText(strings.speedFast);
    await assertSpeedOptions(legacyDialog);
    await legacySpeedField.locator('.el-select__wrapper').click();
    await page.getByRole('option', { name: strings.speedFast, exact: true }).click();
    await legacyDialog.getByRole('button', { name: strings.save, exact: true }).click();
    await expect.poll(() => updates.at(-1)?.body.serviceTier).toBe('priority');
    expect(updates.at(-1)?.body.conversationModel).toBe(false);
    const legacyRow = page.locator('.el-table__row').filter({ hasText: 'Legacy speed model' });
    await legacyRow.locator('td').first().click();
    const legacyDetails = page.getByRole('dialog', { name: strings.details, exact: true });
    await expect(legacyDetails.getByText(/高密度压缩|High-density compaction/u)).toHaveCount(0);
    await expect(
      legacyDetails.getByRole('row').filter({ has: page.getByText(strings.speed, { exact: true }) })
    ).toContainText(strings.speedFast);
    const conversationDetail = legacyDetails
      .getByRole('row')
      .filter({ has: page.getByText(conversationLabel, { exact: true }) });
    await expect(conversationDetail).toContainText(english ? 'No' : '否');
    await legacyDetails.getByRole('button', { name: strings.close, exact: true }).click();
    const reopened = await editModel('Legacy speed model');
    await expect(
      reopened.getByRole('checkbox', { name: conversationLabel, exact: true })
    ).not.toBeChecked();
    await reopened.getByRole('button', { name: strings.cancel, exact: true }).click();

    const chatgptDialog = await editModel('ChatGPT speed model');
    await assertSpeedOptions(chatgptDialog);
    await chatgptDialog.getByRole('button', { name: strings.cancel, exact: true }).click();
    await saveSpeed('Legacy speed model', 'default', strings.speedDefault);
    await saveSpeed('Legacy speed model', 'ultrafast', strings.speedUltrafast);
    await saveSpeed('ChatGPT speed model', 'default', strings.speedDefault);
    await saveSpeed('ChatGPT speed model', 'priority', strings.speedFast);
    await saveSpeed('ChatGPT speed model', 'ultrafast', strings.speedUltrafast);

    for (const name of ['Inline Responses model', 'Anthropic model']) {
      const dialog = await editModel(name);
      await expect(dialog.locator('.el-form-item').filter({ hasText: strings.speed })).toHaveCount(
        0
      );
      await dialog.getByRole('button', { name: strings.cancel, exact: true }).click();
    }

    expect(updates.map(({ body }) => body.serviceTier)).toEqual([
      'priority',
      'default',
      'ultrafast',
      'default',
      'priority',
      'ultrafast'
    ]);
  });
}
