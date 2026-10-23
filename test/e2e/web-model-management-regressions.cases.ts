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

async function selectModelProtocol(
  page: Page,
  form: Locator,
  strings: Locale,
  label: string
): Promise<void> {
  const protocol = form.locator('.el-form-item').filter({ hasText: strings.protocol });
  await protocol.locator('.el-select__wrapper').click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

for (const english of [false, true]) {
  const strings = locale(english);
  const language = english ? 'en-US' : 'zh-CN';

  test(`Model management preserves all models and actions without pagination ${language}`, async ({
    page
  }) => {
    test.setTimeout(60_000);
    await mockEnterpriseConsole(page, english);
    await page.route('**/api/organizations', (route) =>
      json(route, {
        organizations: [{ id: 1, name: 'Root', parentOrganizationId: null }]
      })
    );

    let models = Array.from({ length: 21 }, (_, index) =>
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
    const modelRows = modelPanel.locator('.el-table__row');
    await expect(modelRows).toHaveCount(21);
    await expect(modelPanel.locator('.el-pagination')).toHaveCount(0);
    await expect(modelRows.last()).toContainText('Model 21');
    const actionsBounds = await modelPanel.locator('.table-actions').boundingBox();
    const tableBounds = await modelPanel.locator('.el-table').boundingBox();
    expect(actionsBounds).not.toBeNull();
    expect(tableBounds).not.toBeNull();
    expect(tableBounds!.y - actionsBounds!.y - actionsBounds!.height).toBeGreaterThan(0);

    const lastModel = page.locator('.el-table__row').filter({ hasText: 'Model 21' });
    await lastModel.getByRole('button', { name: strings.edit, exact: true }).click();
    const editDialog = page.getByRole('dialog', { name: strings.edit, exact: true });
    await editDialog.getByRole('textbox', { name: strings.modelName }).fill('Edited Model 21');
    await editDialog.getByRole('button', { name: strings.save, exact: true }).click();
    await expect(
      page.locator('.el-table__row').filter({ hasText: 'Edited Model 21' })
    ).toBeVisible();
    await expect(modelRows).toHaveCount(21);
    await expect(modelPanel.locator('.el-pagination')).toHaveCount(0);

    const editedRow = page.locator('.el-table__row').filter({ hasText: 'Edited Model 21' });
    await editedRow.getByRole('button', { name: strings.test, exact: true }).click();
    const testDialog = page.getByRole('dialog', { name: strings.testTitle, exact: true });
    await testDialog.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Runtime Node', exact: true }).click();
    await testDialog.getByRole('button', { name: strings.test, exact: true }).click();
    await expect(testDialog.locator('.model-test-result .el-tag')).toHaveText(
      english ? 'Success' : '成功'
    );
    await testDialog.getByRole('button', { name: strings.cancel, exact: true }).click();
    await expect(testDialog).toHaveCount(0);
    await expect(modelRows).toHaveCount(21);
    await expect(modelPanel.locator('.el-pagination')).toHaveCount(0);

    const readsBeforeRefresh = modelReads;
    await page.getByRole('button', { name: strings.refresh, exact: true }).click();
    await expect.poll(() => modelReads).toBe(readsBeforeRefresh + 1);
    await expect(modelRows).toHaveCount(21);
    await expect(modelPanel.locator('.el-pagination')).toHaveCount(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ name: 'Edited Model 21' });
    expect(modelTests).toHaveLength(1);

    for (const [index, name] of ['Edited Model 21', 'Model 20'].entries()) {
      const row = page.locator('.el-table__row').filter({ hasText: name });
      await row.getByRole('button', { name: strings.remove, exact: true }).click();
      const confirmation = page.locator('.el-message-box');
      await confirmation.getByRole('button', { name: strings.remove, exact: true }).click();
      await expect(row).toHaveCount(0);
      await expect(modelRows).toHaveCount(index === 0 ? 20 : 19);
      await expect(modelPanel.locator('.el-pagination')).toHaveCount(0);
    }
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

  test(`Model duplication preserves configuration without changing its source ${language}`, async ({
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
    const source = model('source-inline-model', 'Shared source model', {
      baseUrl: 'https://gateway.example/v1',
      modelId: 'source-model-id',
      contextWindowTokens: 262_144,
      maxOutputTokens: 32_768,
      inputCapabilities: ['TEXT', 'IMAGE'],
      reasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'high',
      conversationModel: true,
      titleGeneration: true,
      codeMode: true,
      responsesTransport: { transport: 'HTTP', httpVersion: '2' },
      responsesPreviousResponseId: true,
      sortOrder: 12,
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 7 },
      lastTestStatus: 'SUCCEEDED',
      lastTestedAt: 1_900_000_000_000
    });
    let models = [model('earlier-model', 'Earlier model', { sortOrder: 4 }), source];
    const duplicateBodies: Record<string, unknown>[] = [];
    const sourceWrites: string[] = [];
    await page.route(/\/api\/admin\/mar-agent\/models$/u, (route) => json(route, { models }));
    await page.route(/\/api\/admin\/mar-agent\/models\/source-inline-model$/u, (route) => {
      sourceWrites.push(route.request().method());
      return json(route, {}, 405);
    });
    await page.route(
      /\/api\/admin\/mar-agent\/models\/source-inline-model\/duplicate$/u,
      (route) => {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        duplicateBodies.push(body);
        const created = model('source-inline-copy', String(body.name), {
          ...body,
          id: 'source-inline-copy',
          credentialType: 'INLINE_API_KEY',
          credentialConfigured: true,
          apiKeyConfigured: true,
          lastTestStatus: 'UNVERIFIED',
          lastTestedAt: null
        });
        models = [...models, created];
        return json(route, { model: created }, 201);
      }
    );
    await page.route(/\/api\/admin\/mar-agent\/codex-credentials$/u, (route) =>
      json(route, { credentials: [] })
    );
    await page.route('**/api/resource-grants**', (route) => json(route, { grants: [] }));

    await openModels(page, strings);
    const duplicateLabel = english ? 'Duplicate' : '复制';
    const copyName = english ? 'Shared source model (copy)' : 'Shared source model（副本）';
    const openCopy = async (): Promise<Locator> => {
      await page
        .locator('.el-table__row')
        .filter({ hasText: 'Shared source model' })
        .first()
        .getByRole('button', { name: duplicateLabel, exact: true })
        .click();
      return page.getByRole('dialog', { name: duplicateLabel, exact: true });
    };
    const firstCopy = await openCopy();
    await expect(firstCopy.getByRole('textbox', { name: strings.modelName })).toHaveValue(copyName);
    await expect(firstCopy.getByRole('textbox', { name: strings.modelId })).toHaveValue(
      'source-model-id'
    );
    const contextField = firstCopy
      .locator('.el-form-item')
      .filter({ hasText: english ? 'Context tokens' : '上下文 Token' });
    const outputField = firstCopy
      .locator('.el-form-item')
      .filter({ hasText: english ? 'Maximum output tokens' : '最大输出 Token' });
    await expect(contextField.getByRole('spinbutton')).toHaveValue('262144');
    await expect(outputField.getByRole('spinbutton')).toHaveValue('32768');
    await expect(
      firstCopy.getByRole('checkbox', { name: english ? 'Image input' : '图片输入', exact: true })
    ).toBeChecked();
    await expect(
      firstCopy
        .locator('.el-form-item')
        .filter({ hasText: english ? 'Supported reasoning efforts' : '支持的思考强度' })
        .getByRole('checkbox', { name: 'high', exact: true })
    ).toBeChecked();
    const keyField = firstCopy
      .locator('.el-form-item')
      .filter({ hasText: english ? 'API key' : 'API Key' })
      .getByRole('textbox');
    await expect(keyField).toHaveValue('');
    await expect(keyField).toHaveAttribute(
      'placeholder',
      english ? 'Leave blank while editing to keep the current key.' : '编辑时留空可保留当前 Key。'
    );
    const ownership = firstCopy
      .locator('.el-form-item')
      .filter({ hasText: strings.modelOwnership });
    await expect(ownership.locator('.el-select__wrapper')).toContainText(
      english ? 'Personal' : '个人'
    );
    await expect(duplicateBodies).toHaveLength(0);
    await firstCopy.getByRole('textbox', { name: strings.modelId }).fill('cancelled-copy-draft');
    await firstCopy.getByRole('button', { name: strings.cancel, exact: true }).click();
    await expect(page.getByRole('dialog', { name: duplicateLabel, exact: true })).toHaveCount(0);
    expect(duplicateBodies).toHaveLength(0);

    const reopenedCopy = await openCopy();
    await expect(reopenedCopy.getByRole('textbox', { name: strings.modelName })).toHaveValue(
      copyName
    );
    await expect(reopenedCopy.getByRole('textbox', { name: strings.modelId })).toHaveValue(
      'source-model-id'
    );
    await expect(
      reopenedCopy
        .locator('.el-form-item')
        .filter({ hasText: strings.modelOwnership })
        .locator('.el-select__wrapper')
    ).toContainText(english ? 'Personal' : '个人');
    await selectOrganization(page, reopenedCopy, strings);
    await reopenedCopy.getByRole('button', { name: strings.save, exact: true }).click();

    await expect(
      page.getByRole('tabpanel', { name: strings.modelTab }).locator('.el-table__row').last()
    ).toContainText(copyName);
    expect(duplicateBodies).toHaveLength(1);
    expect(duplicateBodies[0]).toMatchObject({
      name: copyName,
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://gateway.example/v1',
      modelId: 'source-model-id',
      contextWindowTokens: 262_144,
      maxOutputTokens: 32_768,
      inputCapabilities: ['TEXT', 'IMAGE'],
      reasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'high',
      titleGeneration: true,
      codeMode: true,
      sortOrder: 13,
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 7 }
    });
    expect(duplicateBodies[0]).not.toHaveProperty('credential');
    expect(duplicateBodies[0]).not.toHaveProperty('lastTestStatus');
    expect(duplicateBodies[0]).not.toHaveProperty('access');
    expect(sourceWrites).toEqual([]);
    expect(models.find((entry) => entry.id === source.id)).toEqual(source);
  });

  test(`Model protocol switching retains inline draft settings across OAuth ${language}`, async ({
    page
  }) => {
    test.setTimeout(60_000);
    await mockEnterpriseConsole(page, english);
    await page.route('**/api/organizations', (route) => json(route, { organizations: [] }));
    const createBodies: Record<string, unknown>[] = [];
    let models: Record<string, unknown>[] = [];
    await page.route(/\/api\/admin\/mar-agent\/models$/u, (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        createBodies.push(body);
        const created = model('protocol-switch-model', String(body.name), {
          ...body,
          id: 'protocol-switch-model',
          credentialType: 'INLINE_API_KEY',
          credentialConfigured: true,
          apiKeyConfigured: true
        });
        models = [created];
        return json(route, { model: created }, 201);
      }
      return json(route, { models });
    });
    await page.route(/\/api\/admin\/mar-agent\/codex-credentials$/u, (route) =>
      json(route, { credentials: [] })
    );

    await openModels(page, strings);
    await page.getByRole('button', { name: strings.add, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: strings.add, exact: true });
    const urlLabel = english ? 'Base URL' : '基础 URL';
    const urlField = dialog
      .locator('.el-form-item')
      .filter({ hasText: urlLabel })
      .getByRole('textbox');
    await expect(urlField).toHaveValue('https://api.anthropic.com');
    await selectModelProtocol(page, dialog, strings, 'OpenAI Responses');
    await expect(urlField).toHaveValue('https://api.openai.com/v1');
    await selectModelProtocol(page, dialog, strings, 'Anthropic Messages');
    await expect(urlField).toHaveValue('https://api.anthropic.com');
    await selectModelProtocol(page, dialog, strings, 'OpenAI Responses');
    await expect(urlField).toHaveValue('https://api.openai.com/v1');

    const customUrl = 'https://gateway.example/custom';
    const apiKey = 'inline-test-key';
    await urlField.fill(customUrl);
    await dialog.getByRole('textbox', { name: strings.modelName }).fill('Protocol switch model');
    await dialog.getByRole('textbox', { name: strings.modelId }).fill('switch-model-id');
    const keyField = dialog
      .locator('.el-form-item')
      .filter({ hasText: english ? 'API key' : 'API Key' })
      .getByRole('textbox');
    await keyField.fill(apiKey);
    await dialog
      .locator('.el-form-item')
      .filter({ hasText: english ? 'Context tokens' : '上下文 Token' })
      .getByRole('spinbutton')
      .fill('262144');
    await dialog
      .locator('.el-form-item')
      .filter({ hasText: english ? 'Maximum output tokens' : '最大输出 Token' })
      .getByRole('spinbutton')
      .fill('32768');
    await dialog.getByText(english ? 'Image input' : '图片输入', { exact: true }).click();
    await dialog
      .locator('.el-form-item')
      .filter({ hasText: english ? 'Supported reasoning efforts' : '支持的思考强度' })
      .getByText('high', { exact: true })
      .click();
    const defaultReasoning = dialog
      .locator('.el-form-item')
      .filter({ hasText: english ? 'Default reasoning effort' : '默认思考强度' });
    await defaultReasoning.locator('.el-select__wrapper').click();
    await page.getByRole('option', { name: 'high', exact: true }).click();
    await dialog
      .getByText(english ? 'Session title generation' : '会话标题命名', { exact: true })
      .click();
    await dialog.getByText('Code Mode', { exact: true }).click();

    await selectModelProtocol(page, dialog, strings, 'Anthropic Messages');
    await expect(urlField).toHaveValue(customUrl);
    await selectModelProtocol(page, dialog, strings, 'ChatGPT');
    await expect(urlField).toHaveCount(0);
    await selectModelProtocol(page, dialog, strings, 'OpenAI Responses');
    await expect(urlField).toHaveValue(customUrl);
    await expect(keyField).toHaveValue(apiKey);
    await selectModelProtocol(page, dialog, strings, 'Anthropic Messages');
    await expect(urlField).toHaveValue(customUrl);
    await expect(dialog.getByRole('textbox', { name: strings.modelId })).toHaveValue(
      'switch-model-id'
    );
    await expect(
      dialog.getByRole('checkbox', { name: english ? 'Image input' : '图片输入', exact: true })
    ).toBeChecked();

    await dialog.getByRole('button', { name: strings.save, exact: true }).click();
    await expect(
      page.locator('.el-table__row').filter({ hasText: 'Protocol switch model' })
    ).toBeVisible();
    expect(createBodies).toHaveLength(1);
    expect(createBodies[0]).toMatchObject({
      protocol: 'ANTHROPIC_MESSAGES',
      baseUrl: customUrl,
      modelId: 'switch-model-id',
      contextWindowTokens: 262_144,
      maxOutputTokens: 32_768,
      inputCapabilities: ['TEXT', 'IMAGE'],
      defaultReasoningEffort: 'high',
      reasoningEfforts: ['high'],
      titleGeneration: true,
      codeMode: true,
      credential: { type: 'INLINE_API_KEY', value: apiKey }
    });
    expect(createBodies[0]).not.toHaveProperty('responsesTransport');
    expect(createBodies[0]).not.toHaveProperty('serviceTier');
  });

  test(`Model duplication keeps or replaces OAuth references only for a matching protocol ${language}`, async ({
    page
  }) => {
    test.setTimeout(60_000);
    await mockEnterpriseConsole(page, english);
    await page.route('**/api/organizations', (route) => json(route, { organizations: [] }));
    const source = model('source-codex-model', 'Source Codex model', {
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      credentialType: 'CREDENTIAL_REF',
      credentialConfigured: true,
      apiKeyConfigured: false,
      credentialId: 'source-codex-credential',
      sortOrder: 5
    });
    let models: Record<string, unknown>[] = [source];
    const duplicateBodies: Record<string, unknown>[] = [];
    await page.route(/\/api\/admin\/mar-agent\/models$/u, (route) => json(route, { models }));
    await page.route(
      /\/api\/admin\/mar-agent\/models\/source-codex-model\/duplicate$/u,
      (route) => {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        duplicateBodies.push(body);
        const created = model(`codex-copy-${duplicateBodies.length}`, String(body.name), {
          ...body,
          id: `codex-copy-${duplicateBodies.length}`,
          credentialType: 'CREDENTIAL_REF',
          credentialConfigured: true,
          apiKeyConfigured: false
        });
        models = [...models, created];
        return json(route, { model: created }, 201);
      }
    );
    await page.route(/\/api\/admin\/mar-agent\/codex-credentials$/u, (route) =>
      json(route, {
        credentials: [
          {
            id: 'compatible-chatgpt-credential',
            name: 'Compatible ChatGPT credential',
            type: 'CHATGPT_OAUTH',
            ownership: { ownerType: 'PERSONAL', ownerUserId: 1 },
            status: 'ACTIVE',
            accessTokenExpiresAt: null,
            lastRefreshAt: null,
            lastCheckedAt: null,
            proxy: { configured: false },
            accountId: 'chatgpt-account',
            revision: 1
          },
          {
            id: 'source-codex-credential',
            name: 'Source Codex credential',
            type: 'CODEX_OAUTH',
            ownership: { ownerType: 'PERSONAL', ownerUserId: 1 },
            status: 'ACTIVE',
            accessTokenExpiresAt: null,
            lastRefreshAt: null,
            lastCheckedAt: null,
            proxy: { configured: false },
            accountId: 'codex-account',
            revision: 1
          }
        ]
      })
    );

    await openModels(page, strings);
    const duplicateLabel = english ? 'Duplicate' : '复制';
    const openCopy = async (): Promise<Locator> => {
      await page
        .locator('.el-table__row')
        .filter({ hasText: 'Source Codex model' })
        .first()
        .getByRole('button', { name: duplicateLabel, exact: true })
        .click();
      return page.getByRole('dialog', { name: duplicateLabel, exact: true });
    };
    const sameProtocolCopy = await openCopy();
    const credentialField = sameProtocolCopy
      .locator('.el-form-item')
      .filter({ hasText: strings.codexCredential });
    await expect(credentialField.locator('.el-select__wrapper')).toContainText(
      english ? 'leave blank to keep the current reference' : '留空可保留当前引用'
    );
    await sameProtocolCopy.getByRole('button', { name: strings.save, exact: true }).click();
    await expect(
      page.getByRole('tabpanel', { name: strings.modelTab }).locator('.el-table__row').last()
    ).toContainText(english ? 'Source Codex model (copy)' : 'Source Codex model（副本）');
    expect(duplicateBodies).toHaveLength(1);
    expect(duplicateBodies[0]).toMatchObject({
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://chatgpt.com/backend-api/codex'
    });
    expect(duplicateBodies[0]).not.toHaveProperty('credential');

    const changedProtocolCopy = await openCopy();
    await selectModelProtocol(page, changedProtocolCopy, strings, 'ChatGPT');
    const changedCredentialField = changedProtocolCopy
      .locator('.el-form-item')
      .filter({ hasText: strings.codexCredential });
    await changedProtocolCopy.getByRole('button', { name: strings.save, exact: true }).click();
    await expect(changedCredentialField.locator('.el-form-item__error')).toHaveText(
      english ? 'Select an OAuth credential.' : '请选择 OAuth 凭据。'
    );
    expect(duplicateBodies).toHaveLength(1);
    await changedCredentialField.locator('.el-select__wrapper').click();
    await expect(
      page.getByRole('option', { name: 'Compatible ChatGPT credential', exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole('option', { name: 'Source Codex credential', exact: true })
    ).toHaveCount(0);
    await page.getByRole('option', { name: 'Compatible ChatGPT credential', exact: true }).click();
    await changedProtocolCopy.getByRole('button', { name: strings.save, exact: true }).click();
    await expect(
      page.getByRole('tabpanel', { name: strings.modelTab }).locator('.el-table__row').last()
    ).toContainText(english ? 'Source Codex model (copy)' : 'Source Codex model（副本）');
    expect(duplicateBodies).toHaveLength(2);
    expect(duplicateBodies[1]).toMatchObject({
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://api.openai.com/v1',
      credential: { type: 'CREDENTIAL_REF', credentialId: 'compatible-chatgpt-credential' }
    });
  });
}
