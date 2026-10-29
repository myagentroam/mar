import { expect, test, type Page } from '@playwright/test';
import {
  XAI_SUBSCRIPTION_BASE_URL,
  type ImageGenerationModel
} from '../../packages/protocol/src/index.js';
import { json, mockConsoleApi } from './support/web-console-api.js';

const credentialId = 'credential-1';
const modelId = 'model-codex-imported';
const firstCatalogHash = 'a'.repeat(64);
const currentCatalogHash = 'b'.repeat(64);
const initialAccessTokenExpiresAt = 2_000_000_000_000;
const refreshedAccessTokenExpiresAt = 2_100_000_000_000;

function credential(overrides: Record<string, unknown> = {}) {
  return {
    id: credentialId,
    name: 'Team Codex',
    type: 'CODEX_OAUTH',
    ownership: { ownerType: 'PERSONAL', ownerUserId: 1 },
    status: 'ACTIVE',
    accessTokenExpiresAt: initialAccessTokenExpiresAt,
    lastRefreshAt: 1_900_000_000_000,
    lastCheckedAt: 1_900_000_000_000,
    accountId: 'account-secret',
    proxy: { configured: false },
    revision: 1,
    ...overrides
  };
}

function importedModel() {
  return {
    id: modelId,
    name: 'GPT Codex Catalog',
    protocol: 'OPENAI_RESPONSES',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    modelId: 'gpt-codex-catalog',
    contextWindowTokens: 200_000,
    maxOutputTokens: 32_000,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['high', 'ultra'],
    hostedWebSearch: true,
    responsesTransport: { transport: 'WEBSOCKET' },
    responsesPreviousResponseId: true,
    enabled: true,
    sortOrder: 0,
    access: 'RESTRICTED',
    credentialType: 'CREDENTIAL_REF',
    credentialConfigured: true,
    lastTestedAt: null,
    lastTestStatus: 'UNVERIFIED',
    lastTestCode: null
  };
}

function inlineResponsesModel() {
  return {
    id: 'model-openai-responses',
    name: 'OpenAI Responses',
    protocol: 'OPENAI_RESPONSES',
    baseUrl: 'https://api.openai.com/v1',
    modelId: 'gpt-responses',
    contextWindowTokens: 200_000,
    maxOutputTokens: 16_384,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['high'],
    hostedWebSearch: false,
    responsesTransport: { transport: 'WEBSOCKET' },
    responsesPreviousResponseId: false,
    enabled: true,
    sortOrder: 0,
    access: 'RESTRICTED',
    credentialType: 'INLINE_API_KEY',
    credentialConfigured: true,
    lastTestedAt: null,
    lastTestStatus: 'UNVERIFIED',
    lastTestCode: null
  };
}

function catalog(hash: string, includeContextWindow: boolean) {
  return {
    catalogHash: hash,
    fetchedAt: 1_900_000_000_000,
    models: [
      {
        upstreamModelId: 'gpt-codex-catalog',
        displayName: 'GPT Codex Catalog',
        description: 'Catalog model',
        ...(includeContextWindow ? { contextWindowTokens: 200_000 } : {}),
        reasoningEfforts: ['high', 'ultra'],
        unsupportedReasoningEfforts: ['extreme'],
        inputCapabilities: ['TEXT'],
        hostedWebSearch: true,
        warnings: ['Unsupported reasoning effort: extreme'],
        requiredInputs: includeContextWindow ? [] : ['contextWindowTokens']
      }
    ]
  };
}

interface ManagementShellIdentity {
  readonly username: string;
  readonly isAdmin: boolean;
  readonly edition: 'COMMUNITY' | 'ENTERPRISE';
  readonly licenseState: 'COMMUNITY' | 'ENTERPRISE_VALID';
  readonly role: 'ADMIN' | 'ORG_ADMIN' | 'MEMBER';
  readonly organizationId: number;
  readonly managementWritable: boolean;
}

async function mockManagementShell(
  page: Page,
  identity: ManagementShellIdentity = {
    username: 'admin',
    isAdmin: true,
    edition: 'COMMUNITY',
    licenseState: 'COMMUNITY',
    role: 'ADMIN',
    organizationId: 1,
    managementWritable: true
  }
): Promise<void> {
  let authenticated = false;
  const authenticatedState = {
    authenticated: true,
    mustChangePassword: false,
    ...identity
  };
  await page.unroute('**/api/auth/me');
  await page.unroute('**/api/auth/login');
  await page.route('**/api/auth/me', (route) =>
    json(
      route,
      authenticated ? authenticatedState : { authenticated: false, mustChangePassword: false }
    )
  );
  await page.route('**/api/auth/login', (route) => {
    authenticated = true;
    return json(route, { ...authenticatedState, csrfToken: 'csrf-1' });
  });
  await page.route('**/api/license', (route) =>
    json(route, {
      edition: identity.edition,
      state: identity.licenseState,
      reason: null,
      licenseId: identity.edition === 'ENTERPRISE' ? 'license-1' : null,
      enterpriseName: identity.edition === 'ENTERPRISE' ? 'Scope Enterprise' : null,
      expiresAt: null,
      managementWritable: identity.managementWritable
    })
  );
  await page.route('**/api/license/request-code', (route) =>
    json(route, { requestCode: 'MAR1.t150-e2e.checksum' })
  );
  await page.route('**/api/resources*', (route) => json(route, { nodes: [], workspaces: [] }));
  await page.route('**/api/management/nodes', (route) => json(route, { nodes: [] }));
  await page.route('**/api/environment-secrets**', (route) => json(route, { secrets: [] }));
}

async function openManagement(page: Page, english = false, canManageModels = true): Promise<void> {
  await page.goto('/console?view=management&management=mar-agent-models');
  await page
    .getByRole('button', { name: english ? 'Open console' : '进入控制台', exact: true })
    .click();
  const targetTab = page.getByRole('tab', {
    name: english
      ? canManageModels
        ? 'Models'
        : 'OAuth credentials'
      : canManageModels
        ? '模型'
        : 'OAuth 凭据',
    exact: true
  });
  await targetTab.click();
  await expect(targetTab).toHaveAttribute('aria-selected', 'true');
}

async function startLogin(
  page: Page,
  name: string,
  english = false
): Promise<ReturnType<Page['getByRole']>> {
  await page
    .getByRole('button', {
      name: english ? 'Add OAuth credential' : '添加 OAuth 凭据',
      exact: true
    })
    .click();
  const dialog = page.getByRole('dialog', {
    name: english ? 'Add OAuth credential' : '添加 OAuth 凭据'
  });
  await dialog.getByRole('textbox').first().fill(name);
  await dialog
    .getByRole('button', {
      name: english ? 'Start device sign-in' : '开始设备登录',
      exact: true
    })
    .click();
  return page.getByRole('dialog', {
    name: english ? 'Codex device sign-in' : 'Codex 设备登录'
  });
}

async function startGrokLogin(page: Page, name: string): Promise<ReturnType<Page['getByRole']>> {
  await page.getByRole('button', { name: '添加 OAuth 凭据', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加 OAuth 凭据' });
  await dialog.getByRole('combobox', { name: '凭据类型', exact: true }).click({ force: true });
  await page.getByRole('option', { name: 'X订阅', exact: true }).click();
  await dialog.getByRole('textbox').first().fill(name);
  await dialog
    .locator('.el-form-item')
    .filter({ hasText: 'SOCKS5 代理' })
    .getByRole('textbox')
    .fill('socks5://grok-user:grok-password@proxy.example.test:1080');
  await expect(dialog.getByText('实验性功能。', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: '开始设备登录', exact: true }).click();
  return page.getByRole('dialog', { name: 'X订阅登录' });
}

async function chooseCatalogModel(
  page: Page,
  options: { fillContextWindow: boolean }
): Promise<void> {
  await chooseNamedCatalogModel(page, 'GPT Codex Catalog', options);
}

async function chooseNamedCatalogModel(
  page: Page,
  displayName: string,
  options: { fillContextWindow: boolean }
): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'OAuth 模型目录' });
  const row = dialog.locator('.el-table__row').filter({ hasText: displayName });
  const selection = row.getByRole('checkbox');
  await row.locator('.el-checkbox__inner').click();
  await expect(selection).toBeChecked();
  if (options.fillContextWindow) await row.getByRole('spinbutton').fill('200000', { force: true });
}

test('Enterprise members can manage their own models and Codex credentials', async ({ page }) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await mockManagementShell(page, {
    username: 'member',
    isAdmin: false,
    edition: 'ENTERPRISE',
    licenseState: 'ENTERPRISE_VALID',
    role: 'MEMBER',
    organizationId: 5,
    managementWritable: true
  });
  let modelReads = 0;
  await page.route(/\/api\/admin\/mar-agent\/models$/, (route) => {
    modelReads += 1;
    return json(route, { models: [] });
  });
  await page.route(/\/api\/mar-agent\/models$/, (route) => json(route, { models: [] }));
  await page.route('**/api/admin/mar-agent/codex-credentials', (route) =>
    json(route, {
      credentials: [
        credential({
          id: 'credential-member',
          name: 'Member Codex',
          ownership: { ownerType: 'PERSONAL', ownerUserId: 42 }
        })
      ]
    })
  );

  await openManagement(page);

  await expect(page.getByRole('tab', { name: '模型', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect.poll(() => modelReads).toBeGreaterThan(0);
  await page.getByRole('tab', { name: 'OAuth 凭据', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'OAuth 凭据', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  const row = page.locator('.el-table__row').filter({ hasText: 'Member Codex' });
  await expect(row).toContainText('个人');

  await page.getByRole('button', { name: '添加 OAuth 凭据', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加 OAuth 凭据' });
  await dialog.getByRole('combobox', { name: '凭据作用域', exact: true }).click({ force: true });
  await expect(page.getByRole('option', { name: '个人', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: '组织', exact: true })).toHaveCount(0);
  await expect(page.getByRole('option', { name: '全企业', exact: true })).toHaveCount(0);
});

test('Codex credentials appear only after device login and support refresh, testing, and reauthentication', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await mockManagementShell(page);
  let models: ReturnType<typeof importedModel>[] = [];
  let credentials: ReturnType<typeof credential>[] = [];
  let loginSequence = 0;
  const modelCreateBodies: unknown[] = [];
  const modelUpdateBodies: unknown[] = [];
  const loginBodies: unknown[] = [];
  const credentialUpdateBodies: unknown[] = [];
  const imageConfigurationBodies: unknown[] = [];
  let finishCredentialTest!: () => void;
  const credentialTestPending = new Promise<void>((resolve) => {
    finishCredentialTest = resolve;
  });

  await page.route('**/api/admin/mar-agent/models', (route) => {
    if (route.request().method() === 'GET') return json(route, { models });
    const body = route.request().postDataJSON();
    modelCreateBodies.push(body);
    models = [
      {
        ...importedModel(),
        name: body.name,
        modelId: body.modelId,
        contextWindowTokens: body.contextWindowTokens,
        maxOutputTokens: body.maxOutputTokens
      }
    ];
    return json(route, { model: models[0] }, 201);
  });
  await page.route(/\/api\/admin\/mar-agent\/models\/model-codex-imported$/, (route) => {
    const body = route.request().postDataJSON();
    modelUpdateBodies.push(body);
    models = [{ ...models[0]!, modelId: body.modelId }];
    return json(route, { model: models[0] });
  });
  await page.route(/\/api\/admin\/mar-agent\/codex-credentials$/, (route) =>
    json(route, { credentials })
  );
  await page.route(/\/api\/admin\/mar-agent\/image-generation$/, (route) => {
    if (route.request().method() === 'GET') return json(route, { configuration: [] });
    imageConfigurationBodies.push(route.request().postDataJSON());
    return json(route, { configuration: route.request().postDataJSON() });
  });
  await page.route(
    new RegExp(`/api/admin/mar-agent/codex-credentials/${credentialId}$`),
    async (route) => {
      if (route.request().method() === 'GET')
        return json(route, {
          details: {
            credential: {
              ...credentials[0]!,
              proxy: {
                configured: true,
                host: 'proxy.example.test',
                port: 1080,
                hasUsername: true
              }
            },
            socks5Url: 'socks5://proxy-user:proxy-password@proxy.example.test:1080'
          }
        });
      credentialUpdateBodies.push(route.request().postDataJSON());
      return json(route, { credential: credentials[0] });
    }
  );
  let catalogReads = 0;
  await page.route(
    new RegExp(`/api/admin/mar-agent/codex-credentials/${credentialId}/models/load$`),
    (route) => {
      catalogReads += 1;
      return json(route, { catalog: catalog(currentCatalogHash, true) });
    }
  );
  await page.route(
    new RegExp(`/api/admin/mar-agent/codex-credentials/${credentialId}/usage$`),
    (route) =>
      json(route, {
        usage: {
          runner: 'codex',
          windows: [
            {
              id: 'five_hour',
              label: '5-hour limit',
              usedPercentage: 25,
              resetsAt: Date.now() + 30 * 60 * 1000
            }
          ],
          fetchedAt: Date.now(),
          cached: false,
          profile: {
            lifetimeTokens: 420_200_000,
            currentDayTokens: 7_000_000,
            lastSevenDaysTokens: 31_000_000,
            statsAsOf: '2026-09-17',
            dailyUsageBuckets: [
              { startDate: '2026-09-15', tokens: 8_000_000 },
              { startDate: '2026-09-16', tokens: 16_000_000 },
              { startDate: '2026-09-17', tokens: 7_000_000 }
            ]
          }
        }
      })
  );
  await page.route(/\/api\/admin\/mar-agent\/codex-login-attempts$/, async (route) => {
    loginSequence += 1;
    loginBodies.push(route.request().postDataJSON());
    await json(route, {
      attempt: {
        id: `attempt-${loginSequence}`,
        status: 'PENDING',
        userCode: `CODE-${loginSequence}`,
        verificationUri: 'https://auth.example.test/codex/device',
        expiresAt: Date.now() + 10_000,
        pollIntervalMs: loginSequence === 1 ? 10_000 : 200
      }
    });
  });
  await page.route(/\/api\/admin\/mar-agent\/codex-login-attempts\/attempt-\d+$/, (route) => {
    if (loginSequence === 1)
      return json(route, {
        attempt: {
          id: 'attempt-1',
          status: 'FAILED',
          code: 'CODEX_DEVICE_AUTH_UNAVAILABLE',
          message: 'Device authorization unavailable.'
        }
      });
    credentials = [credential({ revision: loginSequence })];
    return json(route, {
      attempt: {
        id: `attempt-${loginSequence}`,
        status: 'SUCCEEDED',
        credentialId
      }
    });
  });
  await page.route(
    new RegExp(`/api/admin/mar-agent/codex-credentials/${credentialId}/refresh$`),
    (route) => {
      credentials = [
        credential({
          accessTokenExpiresAt: refreshedAccessTokenExpiresAt,
          lastRefreshAt: 2_050_000_000_000,
          revision: 10
        })
      ];
      return json(route, { credential: credentials[0] });
    }
  );
  await page.route(
    new RegExp(`/api/admin/mar-agent/codex-credentials/${credentialId}/test$`),
    async (route) => {
      await credentialTestPending;
      return json(route, { result: { success: true, code: null } });
    }
  );

  await openManagement(page);
  const modelsTab = page.getByRole('tab', { name: '模型', exact: true });
  await modelsTab.focus();
  await modelsTab.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'OAuth 凭据', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );

  const failedDialog = await startLogin(page, 'Failed Codex');
  await expect(failedDialog).toContainText('CODE-1');
  await failedDialog.getByRole('button', { name: '刷新登录状态', exact: true }).click();
  await expect(failedDialog.getByText('OAuth 登录失败。', { exact: true })).toBeVisible();
  await expect(page.getByText('Codex 设备登录服务暂时不可用。', { exact: true })).toBeVisible();
  await failedDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Team Codex', exact: true })).toHaveCount(0);

  const succeededDialog = await startLogin(page, 'Team Codex');
  await expect(succeededDialog.getByText('OAuth 登录成功。', { exact: true })).toBeVisible();
  await succeededDialog.getByRole('button', { name: '关闭', exact: true }).click();
  const row = page.locator('.el-table__row').filter({ hasText: 'Team Codex' });
  await expect(row).toBeVisible();
  await expect(row.getByText('account-secret', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: '详情', exact: true })).toHaveCount(0);
  await expect(row.getByRole('button', { name: '编辑', exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: '测试', exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: '删除', exact: true })).toBeVisible();

  await row.getByRole('button', { name: '编辑', exact: true }).click();
  const editCredential = page.getByRole('dialog', { name: '编辑 OAuth 凭据' });
  const proxyInput = editCredential
    .locator('.el-form-item')
    .filter({ hasText: 'SOCKS5 代理' })
    .getByRole('textbox');
  const saveCredential = editCredential.getByRole('button', { name: '保存', exact: true });
  await expect(proxyInput).toHaveValue(
    'socks5://proxy-user:proxy-password@proxy.example.test:1080'
  );
  await proxyInput.fill('socks5://next-user:next-password@proxy.example.test:2080');
  await saveCredential.click();
  await expect(page.getByText('OAuth 凭据已更新。', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: '图片生成', exact: true }).click();
  await page.getByRole('button', { name: '添加图片模型', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: /名称$/u }).fill('Codex image');
  await page.getByRole('combobox', { name: /Codex 凭据/u }).click();
  await page.getByRole('option', { name: 'Team Codex', exact: true }).click();
  const imageModelInput = page.getByRole('textbox', { name: /图片生成模型 ID/u });
  await imageModelInput.fill('gpt-image-2.1');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('图片生成配置已保存。', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'OAuth 凭据', exact: true }).click();

  const editButton = row.getByRole('button', { name: '编辑', exact: true });
  const testButton = row.getByRole('button', { name: '测试', exact: true });
  const removeButton = row.getByRole('button', { name: '删除', exact: true });
  await testButton.click();
  await expect(testButton).toHaveClass(/is-loading/u);
  await expect(editButton).not.toHaveClass(/is-loading/u);
  await expect(removeButton).not.toHaveClass(/is-loading/u);
  await expect(editButton).toBeDisabled();
  await expect(removeButton).toBeDisabled();
  finishCredentialTest();
  await expect(page.getByText('OAuth 凭据测试成功。', { exact: true })).toBeVisible();

  await row.click();
  const credentialDetails = page.getByRole('dialog', { name: 'OAuth 凭据详情' });
  await expect(credentialDetails.getByText('OAuth 凭据 ID', { exact: true })).toBeVisible();
  await expect(credentialDetails.getByText('account-secret', { exact: true })).toBeVisible();
  await expect(
    credentialDetails.getByText('socks5://proxy-user:proxy-password@proxy.example.test:1080', {
      exact: true
    })
  ).toBeVisible();
  await expect(credentialDetails.getByText('自定义元数据', { exact: true })).toHaveCount(0);
  await expect(credentialDetails.getByText('已导入模型', { exact: true })).toHaveCount(0);
  await expect(credentialDetails.getByText(/2033年/u)).toBeVisible();
  await credentialDetails.getByRole('button', { name: '刷新凭据', exact: true }).click();
  await expect(page.getByText('OAuth 凭据已刷新。', { exact: true })).toBeVisible();
  await expect(credentialDetails.getByText(/2036年/u)).toBeVisible();
  const queryUsage = credentialDetails.getByRole('button', { name: '查询用量', exact: true });
  await expect(queryUsage.locator('.el-icon')).toBeVisible();
  await queryUsage.click();
  await expect(credentialDetails.getByText('Codex 用量', { exact: true })).toBeVisible();
  await expect(credentialDetails.getByText('5 小时额度', { exact: true })).toBeVisible();
  await expect(credentialDetails.getByText('已用 25%', { exact: true })).toBeVisible();
  await expect(credentialDetails.getByText('总计 Token', { exact: true })).toBeVisible();
  await expect(credentialDetails.getByText('4.2亿', { exact: true })).toBeVisible();
  await expect(credentialDetails.getByText('上一日用量', { exact: true })).toBeVisible();
  await expect(credentialDetails.getByText('7 天用量', { exact: true })).toBeVisible();
  const previousDayMetric = credentialDetails
    .locator('.credential-usage-metric')
    .filter({ hasText: '上一日用量' });
  await expect(previousDayMetric.locator('small')).toHaveText('2026-09-17（UTC-07:00）');
  await expect(credentialDetails.getByText(/上游生成时间（UTC）/u)).toHaveCount(0);
  await expect(credentialDetails.getByText('查询时间', { exact: true })).toBeVisible();

  const reloginButton = credentialDetails.getByRole('button', {
    name: '重新登录',
    exact: true
  });
  await expect(reloginButton.locator('.el-icon')).toBeVisible();
  await reloginButton.click();
  const relogin = page.getByRole('dialog', { name: '重新登录 OAuth 凭据' });
  await expect(relogin.getByRole('textbox').first()).toHaveValue('Team Codex');
  await relogin.getByRole('button', { name: '开始设备登录', exact: true }).click();
  const reloginAttempt = page.getByRole('dialog', { name: 'Codex 设备登录' });
  await expect(reloginAttempt.getByText('OAuth 登录成功。', { exact: true })).toBeVisible();
  await reloginAttempt.getByRole('button', { name: '关闭', exact: true }).click();

  await page.getByRole('tab', { name: '模型', exact: true }).click();
  await page.getByRole('button', { name: '添加模型', exact: true }).click();
  const addModel = page.getByRole('dialog', { name: '添加模型' });
  const contextTokens = addModel.getByRole('spinbutton', { name: '上下文 Token' });
  const maxOutputTokens = addModel.getByRole('spinbutton', { name: '最大输出 Token' });
  await expect(contextTokens).toHaveValue('256000');
  await expect(maxOutputTokens).toHaveValue('32000');
  const protocolSelect = addModel.getByRole('combobox', { name: /协议/u });
  await protocolSelect.click({ force: true });
  await page.getByRole('option', { name: 'OpenAI Responses', exact: true }).click();
  await expect(addModel.locator('.el-form-item').filter({ hasText: 'Responses 传输' })).toHaveCount(
    0
  );
  await protocolSelect.click({ force: true });
  await page.getByRole('option', { name: 'Codex (legacy)', exact: true }).click();
  await expect(contextTokens).toHaveValue('256000');
  await expect(maxOutputTokens).toHaveValue('32000');
  await expect(
    addModel.locator('.el-form-item').filter({ hasText: 'Responses 传输' })
  ).toBeVisible();
  await expect(
    addModel.locator('.el-form-item').filter({ hasText: 'Responses 编码' })
  ).toContainText('Standard');
  const credentialSelect = addModel.getByRole('combobox', {
    name: 'OAuth 凭据',
    exact: true
  });
  const modelIdInput = addModel.getByRole('textbox', { name: /模型 ID$/u });
  await expect(modelIdInput).toBeEnabled();
  await expect(addModel.getByRole('combobox', { name: /模型 ID$/u })).toHaveCount(0);
  await modelIdInput.fill('custom-codex-model');
  await credentialSelect.click({ force: true });
  await expect(page.getByRole('option', { name: 'Team Codex', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Team Codex · 可用', exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: 'Team Codex', exact: true }).click();
  await expect(modelIdInput).toHaveValue('custom-codex-model');
  await addModel.getByRole('textbox', { name: /模型名称$/u }).fill('Custom Codex');
  const enabledField = addModel.locator('.model-enabled');
  await expect(enabledField.getByText('启用', { exact: true })).toBeVisible();
  await expect(enabledField.getByText('停用', { exact: true })).toHaveCount(0);
  await expect(enabledField.getByRole('switch')).toBeChecked();
  expect(catalogReads).toBe(0);
  await expect(addModel.locator('.el-form-item').filter({ hasText: '基础 URL' })).toHaveCount(0);
  await addModel.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('模型配置已保存。', { exact: true })).toBeVisible();
  const modelRow = page.locator('.el-table__row').filter({ hasText: 'Custom Codex' });
  await modelRow.getByRole('button', { name: '编辑', exact: true }).click();
  const editModel = page.getByRole('dialog', { name: '编辑' });
  await expect(editModel.getByRole('spinbutton', { name: '上下文 Token' })).toHaveValue('256000');
  await expect(editModel.getByRole('spinbutton', { name: '最大输出 Token' })).toHaveValue('32000');
  const editModelId = editModel.getByRole('textbox', { name: /模型 ID$/u });
  await expect(editModelId).toHaveValue('custom-codex-model');
  await editModelId.fill('another-unlisted-model');
  await editModel.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('模型配置已保存。', { exact: true }).last()).toBeVisible();
  expect(catalogReads).toBe(0);
  expect(modelUpdateBodies).toHaveLength(1);
  expect(modelUpdateBodies[0]).toMatchObject({ modelId: 'another-unlisted-model' });

  expect(modelCreateBodies).toEqual([
    {
      name: 'Custom Codex',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      credential: { type: 'CREDENTIAL_REF', credentialId },
      modelId: 'custom-codex-model',
      contextWindowTokens: 256_000,
      maxOutputTokens: 32_000,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: [],
      defaultReasoningEffort: 'medium',
      titleGeneration: false,
      codeMode: false,
      serviceTier: 'default',
      hostedWebSearch: false,
      responsesTransport: { transport: 'WEBSOCKET' },
      responsesEncoding: 'STANDARD',
      responsesPreviousResponseId: true,
      enabled: true,
      sortOrder: 0
    }
  ]);
  expect(loginBodies).toHaveLength(3);
  expect(loginBodies[0]).toEqual({
    name: 'Failed Codex',
    ownership: { ownerType: 'PERSONAL' }
  });
  expect(loginBodies[1]).toEqual({
    name: 'Team Codex',
    ownership: { ownerType: 'PERSONAL' }
  });
  expect(loginBodies[2]).toMatchObject({
    name: 'Team Codex',
    ownership: { ownerType: 'PERSONAL', ownerUserId: 1 },
    targetCredentialId: credentialId
  });
  expect(credentialUpdateBodies).toEqual([
    {
      name: 'Team Codex',
      ownership: { ownerType: 'PERSONAL', ownerUserId: 1 },
      socks5Url: 'socks5://next-user:next-password@proxy.example.test:2080'
    }
  ]);
  expect(imageConfigurationBodies).toEqual([
    [
      {
        id: expect.any(String),
        name: 'Codex image',
        enabled: true,
        provider: 'CODEX',
        config: { credentialId, modelId: 'gpt-image-2.1' }
      }
    ]
  ]);
});

test('Grok subscription OAuth keeps provider-specific login, usage, proxy, and model settings', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await mockManagementShell(page);
  let models: Record<string, unknown>[] = [];
  let credentials: Record<string, unknown>[] = [];
  let loginSequence = 0;
  const loginBodies: unknown[] = [];
  const modelBodies: unknown[] = [];

  const grokCredential = () =>
    credential({
      id: 'grok-credential',
      name: 'Grok subscription',
      type: 'XAI_OAUTH',
      accountId: 'xai-account',
      proxy: { configured: false }
    });
  const grokModel = () => ({
    id: 'grok-model',
    name: 'Grok model',
    protocol: 'OPENAI_RESPONSES',
    baseUrl: XAI_SUBSCRIPTION_BASE_URL,
    modelId: 'grok-4',
    contextWindowTokens: 256_000,
    maxOutputTokens: 32_000,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: [],
    hostedWebSearch: true,
    responsesTransport: { transport: 'HTTP', httpVersion: '1.1' },
    responsesPreviousResponseId: false,
    enabled: true,
    sortOrder: 0,
    access: 'RESTRICTED',
    credentialType: 'CREDENTIAL_REF',
    credentialConfigured: true,
    lastTestedAt: null,
    lastTestStatus: 'UNVERIFIED',
    lastTestCode: null
  });

  await page.route('**/api/admin/mar-agent/models', (route) => {
    if (route.request().method() === 'GET') return json(route, { models });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    modelBodies.push(body);
    models = [{ ...grokModel(), ...body }];
    return json(route, { model: models[0] }, 201);
  });
  await page.route(/\/api\/admin\/mar-agent\/models\/grok-model$/, (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    modelBodies.push(body);
    models = [{ ...models[0]!, ...body }];
    return json(route, { model: models[0] });
  });
  await page.route('**/api/admin/mar-agent/codex-credentials', (route) =>
    json(route, { credentials })
  );
  await page.route(
    new RegExp(`/api/admin/mar-agent/codex-credentials/grok-credential$`),
    (route) => {
      if (route.request().method() === 'GET')
        return json(route, {
          details: {
            credential: {
              ...grokCredential(),
              proxy: {
                configured: true,
                host: 'proxy.example.test',
                port: 1080,
                hasUsername: true
              }
            },
            socks5Url: 'socks5://grok-user:grok-password@proxy.example.test:1080'
          }
        });
      return json(route, { credential: credentials[0] });
    }
  );
  await page.route(/\/api\/admin\/mar-agent\/codex-login-attempts$/, (route) => {
    loginSequence += 1;
    loginBodies.push(route.request().postDataJSON());
    return json(route, {
      attempt: {
        id: `grok-attempt-${loginSequence}`,
        type: 'XAI_OAUTH',
        status: 'PENDING',
        userCode: 'GROK-CODE',
        verificationUri: 'https://auth.example.test/grok/device',
        expiresAt: Date.now() + 10_000,
        pollIntervalMs: 10_000
      }
    });
  });
  await page.route(/\/api\/admin\/mar-agent\/codex-login-attempts\/grok-attempt-\d+$/, (route) => {
    credentials = [grokCredential()];
    return json(route, {
      attempt: {
        id: `grok-attempt-${loginSequence}`,
        type: 'XAI_OAUTH',
        status: 'SUCCEEDED',
        credentialId: 'grok-credential'
      }
    });
  });
  let usageQueryCount = 0;
  await page.route(
    /\/api\/admin\/mar-agent\/codex-credentials\/grok-credential\/usage$/,
    (route) => {
      usageQueryCount += 1;
      return json(route, {
        usage: {
          runner: 'codex',
          windows: [],
          fetchedAt: Date.now(),
          cached: false,
          profile: {
            lifetimeTokens: null,
            currentDayTokens: null,
            lastSevenDaysTokens: null,
            statsAsOf: null,
            dailyUsageBuckets: []
          },
          subscription: {
            provider: 'XAI',
            period: 'WEEKLY',
            startsAt: null,
            resetsAt: Date.now() + 30 * 60 * 1000,
            usedPercentage: usageQueryCount === 1 ? 37.5 : null,
            prepaidBalanceCents: usageQueryCount === 1 ? 1_234 : null
          }
        }
      });
    }
  );

  await openManagement(page);
  await page.getByRole('tab', { name: 'OAuth 凭据', exact: true }).click();
  const loginDialog = await startGrokLogin(page, 'Grok subscription');
  await expect(loginDialog.getByText('GROK-CODE', { exact: true })).toBeVisible();
  await loginDialog.getByRole('button', { name: '刷新登录状态', exact: true }).click();
  await expect(loginDialog.getByText('OAuth 登录成功。', { exact: true })).toBeVisible();
  await loginDialog.getByRole('button', { name: '关闭', exact: true }).click();

  expect(loginBodies).toEqual([
    {
      type: 'XAI_OAUTH',
      name: 'Grok subscription',
      ownership: { ownerType: 'PERSONAL' },
      socks5Url: 'socks5://grok-user:grok-password@proxy.example.test:1080'
    }
  ]);
  const row = page.locator('.el-table__row').filter({ hasText: 'Grok subscription' });
  await expect(row).toContainText('X订阅');
  await row.click();
  const details = page.getByRole('dialog', { name: 'OAuth 凭据详情' });
  await details.getByRole('button', { name: '查询用量', exact: true }).click();
  await expect(details.getByText('X订阅额度', { exact: true })).toBeVisible();
  await expect(details.getByText('37.5%', { exact: true })).toBeVisible();
  await expect(details.getByText('62.5%', { exact: true })).toBeVisible();
  await expect(details.getByText('每周', { exact: true })).toBeVisible();
  await expect(details.getByText('$12.34', { exact: true })).toBeVisible();
  await expect(details.getByText('总计 Token', { exact: true })).toHaveCount(0);
  await details.getByRole('button', { name: '关闭', exact: true }).click();
  await row.click();
  const reopenedDetails = page.getByRole('dialog', { name: 'OAuth 凭据详情' });
  await expect(reopenedDetails.getByText('X订阅额度', { exact: true })).toHaveCount(0);
  await reopenedDetails.getByRole('button', { name: '查询用量', exact: true }).click();
  await expect(
    reopenedDetails
      .locator('.credential-usage-metric')
      .filter({ hasText: '剩余比例' })
      .getByText('—', { exact: true })
  ).toBeVisible();
  await reopenedDetails.getByRole('button', { name: '关闭', exact: true }).click();

  await page.getByRole('tab', { name: '模型', exact: true }).click();
  await page.getByRole('button', { name: '添加模型', exact: true }).click();
  const modelDialog = page.getByRole('dialog', { name: '添加模型' });
  await modelDialog.getByRole('combobox', { name: /协议$/u }).click({ force: true });
  await page.getByRole('option', { name: 'X订阅', exact: true }).click();
  await expect(modelDialog.locator('.el-form-item').filter({ hasText: '速度' })).toHaveCount(0);
  await expect(
    modelDialog.locator('.el-form-item').filter({ hasText: 'Responses 传输' })
  ).toBeVisible();
  const transportSelect = modelDialog
    .locator('.el-form-item')
    .filter({ hasText: 'Responses 传输' });
  await expect(transportSelect).toContainText('HTTP/1.1');
  await expect(
    modelDialog.getByRole('checkbox', { name: '支持 Web 搜索', exact: true })
  ).toBeChecked();
  const defaultContinuation = modelDialog.getByRole('checkbox', {
    name: 'Responses 服务端续接',
    exact: true
  });
  await expect(defaultContinuation).not.toBeChecked();
  await expect(defaultContinuation).toBeEnabled();
  await modelDialog
    .getByRole('combobox', { name: 'OAuth 凭据', exact: true })
    .click({ force: true });
  await page.getByRole('option', { name: 'Grok subscription', exact: true }).click();
  await modelDialog.getByRole('textbox', { name: /模型名称$/u }).fill('Grok model');
  await modelDialog.getByRole('textbox', { name: /模型 ID$/u }).fill('grok-4');
  await modelDialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('模型配置已保存。', { exact: true })).toBeVisible();
  expect(modelBodies).toEqual([
    expect.objectContaining({
      protocol: 'OPENAI_RESPONSES',
      baseUrl: XAI_SUBSCRIPTION_BASE_URL,
      credential: { type: 'CREDENTIAL_REF', credentialId: 'grok-credential' },
      responsesTransport: { transport: 'HTTP', httpVersion: '1.1' },
      responsesPreviousResponseId: false,
      hostedWebSearch: true
    })
  ]);
  const modelRow = page.locator('.el-table__row').filter({ hasText: 'Grok model' });
  await modelRow.getByRole('button', { name: '编辑', exact: true }).click();
  const editModel = page.getByRole('dialog', { name: '编辑', exact: true });
  const hostedSearch = editModel.getByRole('checkbox', { name: '支持 Web 搜索', exact: true });
  await expect(hostedSearch).toBeChecked();
  await editModel
    .locator('.el-form-item')
    .filter({ hasText: 'Responses 传输' })
    .getByRole('combobox')
    .click({ force: true });
  await expect(page.getByRole('option', { name: 'HTTP/2', exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: 'WebSocket', exact: true }).click();
  const continuation = editModel.getByRole('checkbox', {
    name: 'Responses 服务端续接',
    exact: true
  });
  await expect(continuation).toBeEnabled();
  await expect(continuation).not.toBeChecked();
  await editModel.getByText('Responses 服务端续接', { exact: true }).click();
  await editModel.getByText('支持 Web 搜索', { exact: true }).click();
  await expect(hostedSearch).not.toBeChecked();
  await editModel.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editModel).not.toBeVisible();
  expect(modelBodies[1]).toMatchObject({
    hostedWebSearch: false,
    baseUrl: 'https://cli-chat-proxy.grok.com/v1',
    responsesTransport: { transport: 'WEBSOCKET' },
    responsesPreviousResponseId: true
  });
  await modelRow.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(hostedSearch).not.toBeChecked();
  await expect(
    editModel.locator('.el-form-item').filter({ hasText: 'Responses 传输' })
  ).toContainText('WebSocket');
  await expect(continuation).toBeChecked();
  await editModel.getByText('Responses 服务端续接', { exact: true }).click();
  await editModel.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editModel).not.toBeVisible();
  expect(modelBodies[2]).toMatchObject({
    hostedWebSearch: false,
    responsesTransport: { transport: 'WEBSOCKET' },
    responsesPreviousResponseId: false
  });
  await modelRow.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(continuation).not.toBeChecked();
  await editModel.getByText('Responses 服务端续接', { exact: true }).click();
  await editModel
    .locator('.el-form-item')
    .filter({ hasText: 'Responses 传输' })
    .getByRole('combobox')
    .click({ force: true });
  await page.getByRole('option', { name: 'HTTP/1.1', exact: true }).click();
  await expect(continuation).toBeEnabled();
  await expect(continuation).toBeChecked();
  await editModel.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editModel).not.toBeVisible();
  expect(modelBodies[3]).toMatchObject({
    responsesTransport: { transport: 'HTTP', httpVersion: '1.1' },
    responsesPreviousResponseId: true
  });
  credentials = [
    grokCredential(),
    credential({ id: 'image-codex', name: 'Image Codex', type: 'CODEX_OAUTH' }),
    credential({ id: 'image-chatgpt', name: 'Image ChatGPT', type: 'CHATGPT_OAUTH' })
  ];
  await page.route(/\/api\/admin\/mar-agent\/image-generation$/, (route) =>
    json(route, { configuration: [] })
  );
  await page.getByRole('tab', { name: '图片生成', exact: true }).click();
  await page.getByRole('button', { name: '添加图片模型', exact: true }).click();
  const imageDialog = page.getByRole('dialog');
  await imageDialog
    .getByRole('combobox', { name: 'Codex 凭据', exact: true })
    .click({ force: true });
  await expect(page.getByRole('option', { name: 'Image Codex', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Grok subscription', exact: true })).toHaveCount(0);
  await expect(page.getByRole('option', { name: 'Image ChatGPT', exact: true })).toHaveCount(0);
});

test('Grok subscription catalog and model tests use only compatible Nodes', async ({ page }) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await mockManagementShell(page);

  const grokCredential = credential({
    id: 'grok-operation-credential',
    name: 'Grok operation',
    type: 'XAI_OAUTH',
    accountId: 'xai-operation-account',
    proxy: {
      configured: true,
      host: 'proxy.example.test',
      port: 1080,
      hasUsername: true
    }
  });
  let models: Record<string, unknown>[] = [];
  const importBodies: unknown[] = [];
  const modelTestBodies: unknown[] = [];
  let modelTestAttempts = 0;
  let finishLateModelTest!: () => void;
  const lateModelTestReady = new Promise<void>((resolve) => {
    finishLateModelTest = resolve;
  });
  const grokCatalog = {
    catalogHash: 'c'.repeat(64),
    fetchedAt: 1_900_000_000_000,
    models: [
      {
        upstreamModelId: 'grok-reasoning',
        displayName: 'Grok Reasoning',
        description: 'Reasoning-capable Grok model',
        contextWindowTokens: 256_000,
        maxOutputTokens: 32_000,
        reasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'high',
        unsupportedReasoningEfforts: [],
        inputCapabilities: ['TEXT'],
        hostedWebSearch: true,
        warnings: [],
        requiredInputs: []
      },
      {
        upstreamModelId: 'grok-basic',
        displayName: 'Grok Basic',
        description: 'Grok model without reasoning choices',
        contextWindowTokens: 256_000,
        maxOutputTokens: 32_000,
        reasoningEfforts: [],
        unsupportedReasoningEfforts: [],
        inputCapabilities: ['TEXT'],
        hostedWebSearch: true,
        warnings: [],
        requiredInputs: []
      }
    ]
  };
  const grokModel = (
    id: string,
    name: string,
    modelId: string,
    reasoningEfforts: string[],
    defaultReasoningEffort?: string
  ) => ({
    id,
    name,
    protocol: 'OPENAI_RESPONSES',
    baseUrl: XAI_SUBSCRIPTION_BASE_URL,
    modelId,
    contextWindowTokens: 256_000,
    maxOutputTokens: 32_000,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts,
    ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
    hostedWebSearch: false,
    responsesTransport: { transport: 'HTTP', httpVersion: '1.1' },
    responsesPreviousResponseId: false,
    enabled: true,
    sortOrder: 0,
    access: 'RESTRICTED',
    credentialType: 'CREDENTIAL_REF',
    credentialConfigured: true,
    lastTestedAt: null,
    lastTestStatus: 'UNVERIFIED',
    lastTestCode: null
  });

  await page.route('**/api/nodes', (route) =>
    json(route, {
      nodes: [
        {
          id: 'node-grok-compatible',
          displayName: 'Grok Compatible Node',
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.9.31',
          nodeVersion: 'v24.15.0',
          connected: true,
          disabled: false,
          capabilities: {
            marAgentRuntimeCredentials: {
              apiVersion: 1,
              websocket: false,
              httpVersions: ['1.1'],
              responsesOptionalParameters: true
            }
          }
        },
        {
          id: 'node-grok-legacy',
          displayName: 'Grok Legacy Node',
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.9.30',
          nodeVersion: 'v24.15.0',
          connected: true,
          disabled: false,
          capabilities: {
            marAgentRuntimeCredentials: {
              apiVersion: 1,
              websocket: false,
              httpVersions: ['1.1']
            }
          }
        }
      ]
    })
  );
  await page.route(/\/api\/admin\/mar-agent\/models$/, (route) => {
    if (route.request().method() === 'GET') return json(route, { models });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    models = [
      grokModel(
        'grok-reasoning-model',
        'Grok Reasoning',
        'grok-reasoning',
        ['low', 'high'],
        'high'
      ),
      grokModel('grok-basic-model', 'Grok Basic', 'grok-basic', [])
    ];
    return json(route, { model: { ...models[0], name: body.name, modelId: body.modelId } }, 201);
  });
  await page.route('**/api/admin/mar-agent/codex-credentials', (route) =>
    json(route, { credentials: [grokCredential] })
  );
  await page.route(
    new RegExp(`/api/admin/mar-agent/codex-credentials/${grokCredential.id}$`),
    (route) =>
      json(route, {
        details: {
          credential: grokCredential,
          socks5Url: 'socks5://grok-user:grok-password@proxy.example.test:1080'
        }
      })
  );
  await page.route(
    new RegExp(`/api/admin/mar-agent/codex-credentials/${grokCredential.id}/models/load$`),
    (route) => json(route, { catalog: grokCatalog })
  );
  await page.route(
    new RegExp(`/api/admin/mar-agent/codex-credentials/${grokCredential.id}/models/import$`),
    (route) => {
      importBodies.push(route.request().postDataJSON());
      models = [
        grokModel(
          'grok-reasoning-model',
          'Grok Reasoning',
          'grok-reasoning',
          ['low', 'high'],
          'high'
        ),
        grokModel('grok-basic-model', 'Grok Basic', 'grok-basic', [])
      ];
      return json(route, {
        result: {
          items: [
            {
              upstreamModelId: 'grok-reasoning',
              status: 'CREATED',
              modelId: 'grok-reasoning-model'
            },
            { upstreamModelId: 'grok-basic', status: 'CREATED', modelId: 'grok-basic-model' }
          ]
        }
      });
    }
  );
  await page.route(
    /\/api\/admin\/mar-agent\/models\/grok-reasoning-model\/test$/,
    async (route) => {
      modelTestBodies.push(route.request().postDataJSON());
      modelTestAttempts += 1;
      if (modelTestAttempts === 3) {
        await lateModelTestReady;
        return json(route, {
          success: false,
          code: 'UPSTREAM_HTTP_426',
          message: 'Late test response',
          httpStatus: 426,
          requestId: 'server-late-grok-response'
        });
      }
      return json(
        route,
        modelTestAttempts === 1
          ? {
              success: false,
              code: 'UPSTREAM_HTTP_426',
              message: 'Grok upstream returned a JSON string error.',
              httpStatus: 426,
              requestId: 'server-grok-request-426',
              response: {
                body: '"<b>Upgrade required</b>"',
                bodyTruncated: true,
                contentType: 'application/json',
                requestId: 'grok-upstream-426',
                retryAfter: '15'
              }
            }
          : {
              success: true,
              code: null,
              message: null,
              httpStatus: null,
              requestId: 'server-grok-request-success'
            }
      );
    }
  );

  await openManagement(page);
  await page.getByRole('tab', { name: 'OAuth 凭据', exact: true }).click();
  const credentialRow = page.locator('.el-table__row').filter({ hasText: 'Grok operation' });
  await credentialRow.click();
  await page
    .getByRole('dialog', { name: 'OAuth 凭据详情' })
    .getByRole('button', { name: '加载模型目录', exact: true })
    .click();

  const catalogDialog = page.getByRole('dialog', { name: 'OAuth 模型目录' });
  const reasoningRow = catalogDialog
    .locator('.el-table__row')
    .filter({ hasText: 'Grok Reasoning' });
  const basicRow = catalogDialog.locator('.el-table__row').filter({ hasText: 'Grok Basic' });
  await expect(reasoningRow).toContainText('low, high');
  await expect(reasoningRow).toContainText('high');
  await expect(basicRow).toContainText('—');
  await chooseNamedCatalogModel(page, 'Grok Reasoning', { fillContextWindow: false });
  await chooseNamedCatalogModel(page, 'Grok Basic', { fillContextWindow: false });
  await catalogDialog.getByRole('button', { name: '导入所选模型', exact: true }).click();
  const importResult = page.getByRole('dialog', { name: 'OAuth 模型导入结果' });
  await expect(importResult).toContainText('已创建');
  await importResult.getByRole('button', { name: '关闭', exact: true }).click();

  await page.getByRole('tab', { name: '模型', exact: true }).click();
  const modelRow = page.locator('.el-table__row').filter({ hasText: 'Grok Reasoning' });
  await expect(modelRow).toContainText('X订阅');
  await modelRow.getByRole('button', { name: '测试', exact: true }).click();
  const modelTest = page.getByRole('dialog', { name: '测试模型传输' });
  await modelTest.getByRole('combobox').click();
  await expect(
    page.getByRole('option', { name: 'Grok Compatible Node', exact: true })
  ).toBeVisible();
  await expect(page.getByRole('option', { name: 'Grok Legacy Node', exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: 'Grok Compatible Node', exact: true }).click();
  await modelTest.getByRole('button', { name: '测试', exact: true }).click();
  await expect(modelTest.getByText('失败', { exact: true })).toBeVisible();
  await expect(modelTest.getByText('UPSTREAM_HTTP_426', { exact: true })).toBeVisible();
  await expect(modelTest.getByText('426', { exact: true })).toBeVisible();
  await expect(modelTest.getByText('server-grok-request-426', { exact: true })).toBeVisible();
  await expect(modelTest.getByText('grok-upstream-426', { exact: true })).toBeVisible();
  await expect(modelTest.getByText('application/json', { exact: true })).toBeVisible();
  await expect(modelTest.getByText('15', { exact: true })).toBeVisible();
  await expect(modelTest.locator('textarea')).toHaveValue('"<b>Upgrade required</b>"');
  await expect(
    modelTest.getByText('响应正文已截断至安全显示上限。', { exact: true })
  ).toBeVisible();
  await expect(modelTest.locator('b')).toHaveCount(0);

  await modelTest.getByRole('button', { name: '测试', exact: true }).click();
  await expect(modelTest.getByText('成功', { exact: true })).toBeVisible();
  await expect(page.getByText('连接测试成功。', { exact: true })).toBeVisible();
  await expect(modelTest.getByText('server-grok-request-success', { exact: true })).toBeVisible();
  await expect(modelTest.locator('textarea')).toHaveCount(0);
  await modelTest.getByRole('button', { name: '测试', exact: true }).click();
  await expect.poll(() => modelTestBodies.length).toBe(3);
  await expect(modelTest.locator('.model-test-result')).toHaveCount(0);
  await modelTest.getByRole('button', { name: '取消', exact: true }).click();
  const otherModelRow = page.locator('.el-table__row').filter({ hasText: 'Grok Basic' });
  await otherModelRow.getByRole('button', { name: '测试', exact: true }).click();
  const lateResponse = page.waitForResponse(/\/grok-reasoning-model\/test$/);
  finishLateModelTest();
  await lateResponse;
  await expect(modelRow.getByRole('button', { name: '测试', exact: true })).not.toHaveClass(
    /is-loading/
  );
  await expect(modelTest.locator('.model-test-result')).toHaveCount(0);
  await modelTest.getByRole('button', { name: '取消', exact: true }).click();

  expect(importBodies).toEqual([
    {
      catalogHash: grokCatalog.catalogHash,
      models: [
        { upstreamModelId: 'grok-reasoning', name: 'Grok Reasoning', enabled: true },
        { upstreamModelId: 'grok-basic', name: 'Grok Basic', enabled: true }
      ]
    }
  ]);
  expect(modelTestBodies).toEqual([
    { nodeId: 'node-grok-compatible' },
    { nodeId: 'node-grok-compatible' },
    { nodeId: 'node-grok-compatible' }
  ]);
});

test('Grok connection failures are shown as network errors instead of device authorization errors', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await mockManagementShell(page);
  const grokCredential = credential({
    id: 'grok-network-error-credential',
    name: 'Grok network error',
    type: 'XAI_OAUTH',
    accountId: 'xai-network-error-account'
  });

  await page.route(/\/api\/admin\/mar-agent\/models$/, (route) => json(route, { models: [] }));
  await page.route(/\/api\/admin\/mar-agent\/codex-credentials$/, (route) =>
    json(route, { credentials: [grokCredential] })
  );
  await page.route(
    new RegExp(`/api/admin/mar-agent/codex-credentials/${grokCredential.id}$`),
    (route) =>
      json(route, {
        details: {
          credential: grokCredential,
          socks5Url: null
        }
      })
  );
  await page.route(
    new RegExp(`/api/admin/mar-agent/codex-credentials/${grokCredential.id}/usage$`),
    (route) =>
      json(
        route,
        {
          error: {
            code: 'XAI_REQUEST_FAILED',
            message:
              'The X subscription service could not be reached. Check the connection and SOCKS5 proxy.'
          }
        },
        502
      )
  );

  await openManagement(page);
  await page.getByRole('tab', { name: 'OAuth 凭据', exact: true }).click();
  await page.locator('.el-table__row').filter({ hasText: 'Grok network error' }).click();
  const details = page.getByRole('dialog', { name: 'OAuth 凭据详情' });
  await details.getByRole('button', { name: '查询用量', exact: true }).click();
  await expect(
    page.getByText('无法连接 X订阅服务，请检查网络连接和 SOCKS5 代理。', { exact: true })
  ).toBeVisible();
  await expect(page.getByText('X订阅设备授权服务暂时不可用。', { exact: true })).toHaveCount(0);
});

for (const english of [false, true]) {
  test(`Image model catalog preserves write-only Ark keys, ordering, enablement, and edits ${english ? 'en-US' : 'zh-CN'}`, async ({
    page
  }, testInfo) => {
    test.setTimeout(60_000);
    if (english) await page.addInitScript(() => localStorage.setItem('mar.locale.v2', 'en-US'));
    else await page.addInitScript(() => localStorage.setItem('mar.theme', 'vscode-dark-2026'));
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    await mockManagementShell(page);
    let catalog: ImageGenerationModel[] = [
      {
        id: 'codex-image',
        name: 'Codex image',
        enabled: true,
        provider: 'CODEX',
        config: { credentialId, modelId: 'gpt-image-2' }
      }
    ];
    const writes: Array<ImageGenerationModel[]> = [];
    let failNextOrderSave = false;
    await page.route('**/api/admin/mar-agent/models', (route) => json(route, { models: [] }));
    await page.route('**/api/admin/mar-agent/codex-credentials', (route) =>
      json(route, { credentials: [credential()] })
    );
    await page.route(/\/api\/admin\/mar-agent\/image-generation$/, (route) => {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON();
        writes.push(body);
        if (failNextOrderSave) {
          failNextOrderSave = false;
          return json(
            route,
            { error: { code: 'IMAGE_ORDER_SAVE_FAILED', message: 'Image order save failed.' } },
            503
          );
        }
        catalog = body.map((item: ImageGenerationModel) =>
          item.provider === 'BYTED_ARK'
            ? {
                ...item,
                config: { url: item.config.url, modelId: item.config.modelId, hasApiKey: true }
              }
            : item
        );
      }
      return json(route, { configuration: catalog });
    });
    await openManagement(page, english);
    await page
      .getByRole('tab', { name: english ? 'Image generation' : '图片生成', exact: true })
      .click();
    const toolbar = page.locator('.image-generation-management .table-actions');
    await expect(toolbar.getByRole('button')).toHaveText(
      english
        ? ['Refresh', 'Adjust order', 'Add image model']
        : ['刷新', '调整排序', '添加图片模型']
    );
    await expect(toolbar.getByRole('button').last()).toHaveClass(/el-button--primary/u);
    await page
      .getByRole('button', { name: english ? 'Add image model' : '添加图片模型', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: english ? 'Image model configuration' : '图片模型配置',
      exact: true
    });
    await dialog
      .getByRole('textbox', { name: english ? /Model name$/u : /名称$/u })
      .fill('Ark image');
    await expect(
      dialog.getByRole('textbox', {
        name: english ? /Image generation model ID$/u : /图片生成模型 ID$/u
      })
    ).toHaveValue('');
    await dialog.getByRole('combobox', { name: 'Provider', exact: true }).press('Enter');
    await page
      .getByRole('option', {
        name: english ? 'Volcengine Ark' : '火山方舟',
        exact: true
      })
      .click();
    await expect(
      dialog.getByRole('textbox', {
        name: english ? /Image generation model ID$/u : /图片生成模型 ID$/u
      })
    ).toHaveValue('');
    await dialog
      .getByRole('textbox', { name: english ? /Image generation model ID$/u : /图片生成模型 ID$/u })
      .fill('explicit-image-model');
    const urlInput = dialog.getByRole('textbox', {
      name: english ? /Image generation URL$/u : /图片生成 URL$/u
    });
    await expect(urlInput).toHaveValue('');
    await dialog.locator('input[type=password]').fill('fixture-ark-api-key');
    await dialog.getByRole('button', { name: english ? 'Save' : '保存', exact: true }).click();
    await expect(dialog.locator('.el-form-item__error')).toBeVisible();
    expect(writes).toHaveLength(0);
    await urlInput.fill('https://images.example.test/custom/generate');
    await dialog.getByRole('button', { name: english ? 'Save' : '保存', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect((writes[0]?.[1]?.config as { apiKey?: string })?.apiKey).toBe('fixture-ark-api-key');
    const rows = page.locator(
      '.image-generation-management .el-table__body-wrapper .el-table__row'
    );
    await expect(rows.first().locator('td').nth(2)).toHaveText('Codex');
    await expect(rows.last().locator('td').nth(2)).toHaveText(
      english ? 'Volcengine Ark' : '火山方舟'
    );
    await expect(
      rows.first().getByRole('button', { name: english ? 'Edit' : '编辑', exact: true })
    ).toHaveClass(/is-link/u);
    await expect(
      rows.first().getByRole('button', { name: english ? 'Remove' : '删除', exact: true })
    ).toHaveClass(/el-button--danger/u);
    await rows.first().locator('td').nth(1).click();
    const details = page.getByRole('dialog', { name: english ? 'Details' : '详情', exact: true });
    await expect(details).toBeVisible();
    await expect(details.locator('code').first()).toHaveText('codex-image');
    await details.getByRole('button', { name: english ? 'Close' : '关闭', exact: true }).click();
    await expect(details).toHaveCount(0);
    const adjustOrder = toolbar.getByRole('button', {
      name: english ? 'Adjust order' : '调整排序',
      exact: true
    });
    const saveOrder = toolbar.getByRole('button', {
      name: english ? 'Save order' : '保存排序',
      exact: true
    });
    await adjustOrder.click();
    await expect(toolbar.getByRole('button').first()).toBeDisabled();
    await expect(
      rows.first().getByRole('button', { name: english ? 'Edit' : '编辑', exact: true })
    ).toHaveCount(0);
    await rows
      .filter({ hasText: 'Ark image' })
      .locator('.order-handle')
      .dragTo(rows.filter({ hasText: 'Codex image' }).locator('.order-handle'));
    await expect(rows.first()).toContainText('Ark image');
    expect(writes).toHaveLength(1);
    await toolbar.getByRole('button', { name: english ? 'Cancel' : '取消', exact: true }).click();
    await expect(rows.first()).toContainText('Codex image');
    expect(writes).toHaveLength(1);
    await adjustOrder.click();
    await rows
      .filter({ hasText: 'Ark image' })
      .locator('.order-handle')
      .dragTo(rows.filter({ hasText: 'Codex image' }).locator('.order-handle'));
    failNextOrderSave = true;
    await saveOrder.click();
    await expect(page.getByText('Image order save failed.', { exact: false })).toBeVisible();
    await expect(saveOrder).toBeVisible();
    await expect(rows.first()).toContainText('Ark image');
    await saveOrder.click();
    await expect(adjustOrder).toBeVisible();
    await expect(rows.first()).toContainText('Ark image');
    expect(writes.at(-1)?.[0]?.provider).toBe('BYTED_ARK');
    expect(writes.at(-1)?.[0]?.config).toMatchObject({
      url: 'https://images.example.test/custom/generate',
      modelId: 'explicit-image-model'
    });
    expect(writes.at(-1)?.[0]?.config).not.toHaveProperty('apiKey');
    await rows.first().locator('.el-switch').click();
    await expect(rows.first().getByRole('switch')).not.toBeChecked();
    await expect(details).toHaveCount(0);
    await rows
      .first()
      .getByRole('button', { name: english ? 'Edit' : '编辑', exact: true })
      .click();
    await expect(dialog.locator('input[type=password]')).toHaveValue('');
    await expect(urlInput).toHaveValue('https://images.example.test/custom/generate');
    await expect(dialog).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(page.locator('.el-message')).toHaveCount(0, { timeout: 10_000 });
    await page.screenshot({
      path: testInfo.outputPath('image-models-ark-config.png'),
      animations: 'disabled'
    });
    await dialog
      .getByRole('textbox', { name: english ? /Model name$/u : /名称$/u })
      .fill('Ark renamed');
    await dialog.getByRole('button', { name: english ? 'Save' : '保存', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(writes.at(-1)?.[0]?.config).not.toHaveProperty('apiKey');
    await expect(page.locator('.image-generation-management .el-loading-mask')).not.toBeVisible();
    await page.mouse.move(0, 0);
    await expect(page.locator('.el-message')).toHaveCount(0, { timeout: 10_000 });
    await page.screenshot({
      path: testInfo.outputPath('image-models-desktop.png'),
      animations: 'disabled'
    });
    await adjustOrder.click();
    await expect(rows.first().locator('.order-handle')).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('image-models-sorting.png'),
      animations: 'disabled'
    });
    await toolbar.getByRole('button', { name: english ? 'Cancel' : '取消', exact: true }).click();
    await page
      .getByRole('button', { name: english ? 'Collapse sidebar' : '收起侧栏', exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(rows.first()).toContainText('Ark renamed');
    await page.mouse.move(0, 843);
    await expect(page.locator('.el-message')).toHaveCount(0, { timeout: 10_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page.screenshot({
      path: testInfo.outputPath('image-models-mobile.png'),
      fullPage: true,
      animations: 'disabled'
    });
  });
}

test('Model tabs support saving and cancelling drag ordering', async ({ page }) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await mockManagementShell(page);
  let models = [
    importedModel(),
    { ...importedModel(), id: 'second-model', name: 'Second model', sortOrder: 1 }
  ];
  const writes: string[][] = [];
  await page.route('**/api/admin/mar-agent/models', (route) => json(route, { models }));
  await page.route('**/api/admin/mar-agent/codex-credentials', (route) =>
    json(route, { credentials: [] })
  );
  await page.route('**/api/admin/mar-agent/models/order', (route) => {
    const { modelIds } = route.request().postDataJSON() as { modelIds: string[] };
    writes.push(modelIds);
    models = modelIds.map((id, sortOrder) => ({
      ...models.find((model) => model.id === id)!,
      sortOrder
    }));
    return route.fulfill({ status: 204 });
  });
  await openManagement(page);
  const rows = page.locator('.el-table__body-wrapper .el-table__row');
  for (const save of [false, true]) {
    await page.getByRole('button', { name: '调整排序', exact: true }).click();
    await rows
      .filter({ hasText: 'Second model' })
      .locator('.order-handle')
      .dragTo(rows.filter({ hasText: 'GPT Codex Catalog' }).locator('.order-handle'));
    await expect(rows.first()).toContainText('Second model');
    await page.getByRole('button', { name: save ? '保存排序' : '取消', exact: true }).click();
    await expect(page.getByRole('button', { name: '调整排序', exact: true })).toBeVisible();
    await expect(rows.first()).toContainText(save ? 'Second model' : 'GPT Codex Catalog');
  }
  expect(writes).toEqual([['second-model', modelId]]);
});

for (const provider of ['CODEX_OAUTH', 'CHATGPT_OAUTH', 'XAI_OAUTH'] as const) {
  test(`${provider} Responses continuation supports HTTP and WebSocket and persists across edits`, async ({
    page
  }) => {
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    await mockManagementShell(page);
    let model = {
      ...importedModel(),
      baseUrl:
        provider === 'CODEX_OAUTH'
          ? 'https://chatgpt.com/backend-api/codex'
          : provider === 'XAI_OAUTH'
            ? XAI_SUBSCRIPTION_BASE_URL
            : 'https://api.openai.com/v1'
    };
    const updates: Record<string, unknown>[] = [];
    await page.route(/\/api\/admin\/mar-agent\/models$/, (route) =>
      json(route, { models: [model] })
    );
    await page.route(/\/api\/admin\/mar-agent\/models\/model-codex-imported$/, (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      updates.push(body);
      model = { ...model, ...body };
      return json(route, { model });
    });
    await page.route(/\/api\/admin\/mar-agent\/codex-credentials$/, (route) =>
      json(route, { credentials: [credential({ type: provider })] })
    );
    await openManagement(page);
    const row = page.locator('.el-table__row').filter({ hasText: model.name });
    const dialog = page.getByRole('dialog', { name: '编辑', exact: true });
    const continuation = dialog.getByRole('checkbox', {
      name: 'Responses 服务端续接',
      exact: true
    });
    const transport = dialog.locator('.el-form-item').filter({ hasText: 'Responses 传输' });
    for (const version of provider === 'XAI_OAUTH' ? ['HTTP/1.1'] : ['HTTP/1.1', 'HTTP/2']) {
      await row.getByRole('button', { name: '编辑', exact: true }).click();
      await expect(continuation).toBeEnabled();
      await expect(continuation).toBeChecked();
      await transport.getByRole('combobox').click({ force: true });
      await page.getByRole('option', { name: version, exact: true }).click();
      await expect(continuation).toBeEnabled();
      await expect(continuation).toBeChecked();
      await dialog.getByRole('button', { name: '保存', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      expect(updates.at(-1)).toMatchObject({
        responsesTransport: { transport: 'HTTP', httpVersion: version.slice(5) },
        responsesPreviousResponseId: true
      });

      await row.getByRole('button', { name: '编辑', exact: true }).click();
      await expect(transport).toContainText(version);
      await expect(continuation).toBeEnabled();
      await expect(continuation).toBeChecked();
      await transport.getByRole('combobox').click({ force: true });
      await page.getByRole('option', { name: 'WebSocket', exact: true }).click();
      await expect(continuation).toBeEnabled();
      await expect(continuation).toBeChecked();
      await dialog.getByRole('button', { name: '保存', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      expect(updates.at(-1)).toMatchObject({
        responsesTransport: { transport: 'WEBSOCKET' },
        responsesPreviousResponseId: true
      });
    }
    await row.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(continuation).toBeEnabled();
    await expect(continuation).toBeChecked();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    expect(updates).toHaveLength(provider === 'XAI_OAUTH' ? 2 : 4);
  });
}

test('Standard OpenAI Responses edits retain transport and HTTP continuation', async ({ page }) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await mockManagementShell(page);
  const model = {
    ...inlineResponsesModel(),
    responsesTransport: { transport: 'HTTP', httpVersion: '1.1' },
    responsesPreviousResponseId: true
  };
  const updateBodies: unknown[] = [];

  await page.route(/\/api\/admin\/mar-agent\/models$/, (route) => json(route, { models: [model] }));
  await page.route(/\/api\/admin\/mar-agent\/models\/model-openai-responses$/, (route) => {
    updateBodies.push(route.request().postDataJSON());
    return json(route, { model });
  });
  await page.route(/\/api\/admin\/mar-agent\/codex-credentials$/, (route) =>
    json(route, { credentials: [] })
  );

  await openManagement(page);
  await page
    .locator('.el-table__row')
    .filter({ hasText: 'OpenAI Responses' })
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  const editModel = page.getByRole('dialog', { name: '编辑' });
  await expect(
    editModel.locator('.el-form-item').filter({ hasText: 'Responses 传输' })
  ).toBeVisible();
  const continuation = editModel.getByRole('checkbox', {
    name: 'Responses 服务端续接',
    exact: true
  });
  await expect(continuation).toBeEnabled();
  await expect(continuation).toBeChecked();
  await editModel.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('模型配置已保存。', { exact: true })).toBeVisible();

  expect(updateBodies).toHaveLength(1);
  expect(updateBodies[0]).toMatchObject({
    responsesTransport: { transport: 'HTTP', httpVersion: '1.1' },
    responsesPreviousResponseId: true
  });
  expect(updateBodies[0]).not.toHaveProperty('responsesEncoding');
});

for (const english of [false, true]) {
  test(`Codex Responses encoding survives switching and reopening edits ${english ? 'en-US' : 'zh-CN'}`, async ({
    page
  }) => {
    if (english) await page.addInitScript(() => localStorage.setItem('mar.locale.v2', 'en-US'));
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    await mockManagementShell(page);
    let model = { ...importedModel(), responsesEncoding: 'LITE' };
    const updates: Record<string, unknown>[] = [];
    await page.route(/\/api\/admin\/mar-agent\/models$/, (route) =>
      json(route, { models: [model] })
    );
    await page.route(/\/api\/admin\/mar-agent\/models\/model-codex-imported$/, (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      updates.push(body);
      model = { ...model, responsesEncoding: String(body.responsesEncoding) };
      return json(route, { model });
    });
    await page.route(/\/api\/admin\/mar-agent\/codex-credentials$/, (route) =>
      json(route, { credentials: [credential()] })
    );
    await openManagement(page, english);
    for (const [before, after] of [
      ['Lite', 'Standard'],
      ['Standard', 'Lite']
    ] as const) {
      await page
        .locator('.el-table__row')
        .filter({ hasText: model.name })
        .getByRole('button', { name: english ? 'Edit' : '编辑', exact: true })
        .click();
      const dialog = page.getByRole('dialog', { name: english ? 'Edit' : '编辑', exact: true });
      const field = dialog
        .locator('.el-form-item')
        .filter({ hasText: english ? 'Responses encoding' : 'Responses 编码' });
      await expect(field).toContainText(before);
      await field.getByRole('combobox').click({ force: true });
      await page.getByRole('option', { name: after, exact: true }).click();
      await dialog.getByRole('button', { name: english ? 'Save' : '保存', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      expect(updates.at(-1)?.responsesEncoding).toBe(after.toUpperCase());
    }
    expect(updates).toHaveLength(2);
  });
}

test('Codex catalog conflicts require reconfirmation and model tests target compatible Nodes only', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await mockManagementShell(page);
  let models: ReturnType<typeof importedModel>[] = [];
  let credentialValue = credential();
  let catalogReads = 0;
  const importBodies: unknown[] = [];
  const modelTestBodies: unknown[] = [];
  let modelTestAttempts = 0;

  await page.route('**/api/nodes', (route) =>
    json(route, {
      nodes: [
        {
          id: 'node-current',
          displayName: 'Runtime Node',
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.9.31',
          nodeVersion: 'v24.15.0',
          connected: true,
          disabled: false,
          capabilities: {
            codex: { available: true, version: '0.146' },
            claudeCode: { available: false },
            marAgentRuntimeCredentials: {
              apiVersion: 1,
              websocket: true,
              httpVersions: ['1.1', '2']
            }
          }
        },
        {
          id: 'node-old',
          displayName: 'Old Node',
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.9.30',
          nodeVersion: 'v24.15.0',
          connected: true,
          disabled: false,
          capabilities: {
            codex: { available: true, version: '0.146' },
            claudeCode: { available: false }
          }
        }
      ]
    })
  );
  await page.route(/\/api\/admin\/mar-agent\/models$/, (route) => json(route, { models }));
  await page.route(/\/api\/admin\/mar-agent\/codex-credentials$/, (route) =>
    json(route, { credentials: [credentialValue] })
  );
  await page.route(new RegExp(`/api/admin/mar-agent/codex-credentials/${credentialId}$`), (route) =>
    json(route, {
      details: {
        credential: credentialValue,
        socks5Url: null
      }
    })
  );
  await page.route(
    new RegExp(`/api/admin/mar-agent/codex-credentials/${credentialId}/models/load$`),
    (route) => {
      catalogReads += 1;
      return json(route, {
        catalog:
          catalogReads === 1 ? catalog(firstCatalogHash, false) : catalog(currentCatalogHash, true)
      });
    }
  );
  await page.route(
    new RegExp(`/api/admin/mar-agent/codex-credentials/${credentialId}/models/import$`),
    async (route) => {
      importBodies.push(route.request().postDataJSON());
      if (importBodies.length === 1)
        return json(
          route,
          { error: { code: 'CODEX_CATALOG_CHANGED', message: 'Catalog changed.' } },
          409
        );
      models = [importedModel()];
      credentialValue = credential({ revision: 2 });
      return json(route, {
        result: {
          items: [
            {
              upstreamModelId: 'gpt-codex-catalog',
              status: importBodies.length === 2 ? 'CREATED' : 'UNCHANGED',
              modelId
            }
          ]
        }
      });
    }
  );
  await page.route(new RegExp(`/api/admin/mar-agent/models/${modelId}/test$`), (route) => {
    modelTestBodies.push(route.request().postDataJSON());
    modelTestAttempts += 1;
    return json(
      route,
      modelTestAttempts === 1
        ? {
            success: false,
            code: 'invalid_request_error',
            message: 'Store must be set to false',
            httpStatus: 400
          }
        : { success: true, code: null, message: null, httpStatus: null }
    );
  });

  await openManagement(page);
  await page.getByRole('tab', { name: 'OAuth 凭据', exact: true }).click();
  const credentialRow = page.locator('.el-table__row').filter({ hasText: 'Team Codex' });
  await credentialRow.click();
  await page
    .getByRole('dialog', { name: 'OAuth 凭据详情' })
    .getByRole('button', { name: '加载模型目录', exact: true })
    .click();
  await expect(page.getByText('支持的思考强度', { exact: true })).toBeVisible();
  await expect(page.getByText('当前系统未支持的思考强度', { exact: true })).toBeVisible();
  await expect(page.getByText('high, ultra', { exact: true })).toBeVisible();
  await expect(page.getByText('extreme', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('dialog', { name: 'OAuth 模型目录' }).getByText('可用状态', { exact: true })
  ).toHaveCount(0);
  await chooseCatalogModel(page, { fillContextWindow: true });
  await page
    .getByRole('dialog', { name: 'OAuth 模型目录' })
    .getByRole('button', { name: '导入所选模型', exact: true })
    .click();

  await expect(
    page.getByText('OAuth 模型目录已变化，已重新加载，请再次确认。', { exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('dialog', { name: 'OAuth 模型目录' }).getByText('已选择 0 个模型')
  ).toBeVisible();
  await chooseCatalogModel(page, { fillContextWindow: false });
  await page
    .getByRole('dialog', { name: 'OAuth 模型目录' })
    .getByRole('button', { name: '导入所选模型', exact: true })
    .click();
  const importResult = page.getByRole('dialog', { name: 'OAuth 模型导入结果' });
  await expect(importResult.getByText('已创建', { exact: true })).toBeVisible();
  await importResult.getByRole('button', { name: '关闭', exact: true }).click();

  await page.getByRole('tab', { name: '模型', exact: true }).click();
  const modelRow = page.locator('.el-table__row').filter({ hasText: 'GPT Codex Catalog' });
  await expect(modelRow).not.toContainText('Codex OAuth 凭据');
  await expect(modelRow).not.toContainText('WebSocket');
  await modelRow.getByRole('button', { name: '测试', exact: true }).click();
  const modelTest = page.getByRole('dialog', { name: '测试模型传输' });
  await modelTest.getByRole('combobox').click();
  await expect(page.getByRole('option', { name: 'Runtime Node', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Old Node', exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: 'Runtime Node', exact: true }).click();
  await modelTest.getByRole('button', { name: '测试', exact: true }).click();
  await expect(modelTest.getByText('Store must be set to false', { exact: true })).toBeVisible();
  await expect(modelTest.getByText('400', { exact: true })).toBeVisible();
  await expect(modelTest.getByText('响应正文', { exact: true })).toHaveCount(0);
  await modelTest.getByRole('button', { name: '取消', exact: true }).click();

  await modelRow.getByRole('button', { name: '测试', exact: true }).click();
  const successfulModelTest = page.getByRole('dialog', { name: '测试模型传输' });
  await successfulModelTest.getByRole('combobox').click();
  await page.getByRole('option', { name: 'Runtime Node', exact: true }).click();
  await successfulModelTest.getByRole('button', { name: '测试', exact: true }).click();
  await expect(page.getByText('连接测试成功。', { exact: true })).toBeVisible();
  await expect(successfulModelTest).toBeVisible();
  await expect(successfulModelTest.getByText('响应正文', { exact: true })).toHaveCount(0);
  await successfulModelTest.getByRole('button', { name: '取消', exact: true }).click();

  await page.getByRole('tab', { name: 'OAuth 凭据', exact: true }).click();
  await page.locator('.el-table__row').filter({ hasText: 'Team Codex' }).click();
  await page
    .getByRole('dialog', { name: 'OAuth 凭据详情' })
    .getByRole('button', { name: '加载模型目录', exact: true })
    .click();
  await chooseCatalogModel(page, { fillContextWindow: false });
  await page
    .getByRole('dialog', { name: 'OAuth 模型目录' })
    .getByRole('button', { name: '导入所选模型', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'OAuth 模型导入结果' }).getByText('未变化', {
      exact: true
    })
  ).toBeVisible();

  expect(importBodies).toHaveLength(3);
  expect(importBodies[0]).toMatchObject({
    catalogHash: firstCatalogHash,
    models: [
      {
        upstreamModelId: 'gpt-codex-catalog',
        contextWindowTokens: 200_000
      }
    ]
  });
  expect(importBodies[1]).toMatchObject({ catalogHash: currentCatalogHash });
  expect(importBodies[2]).toMatchObject({ catalogHash: currentCatalogHash });
  expect(modelTestBodies).toEqual([{ nodeId: 'node-current' }, { nodeId: 'node-current' }]);
});

for (const english of [false, true]) {
  test(`ChatGPT credentials show both refresh times and distinguish extension from token rotation ${english ? 'en-US' : 'zh-CN'}`, async ({
    page
  }) => {
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    await mockManagementShell(page);
    await page.addInitScript(
      (locale) => localStorage.setItem('mar.locale.v2', locale),
      english ? 'en-US' : 'zh-CN'
    );
    let current = credential({
      name: 'New ChatGPT',
      type: 'CHATGPT_OAUTH',
      authorization: 'AUTHORIZED',
      earliestRefreshAt: initialAccessTokenExpiresAt - 1_800_000
    });
    let refreshCalls = 0;
    let credentialUpdates = 0;
    await page.route('**/api/admin/mar-agent/models', (route) =>
      json(route, {
        models: [
          {
            ...importedModel(),
            id: 'chatgpt-model',
            name: 'ChatGPT model',
            baseUrl: 'https://api.openai.com/v1'
          },
          { ...importedModel(), id: 'legacy-model', name: 'Legacy model' }
        ]
      })
    );
    await page.route(/\/api\/admin\/mar-agent\/codex-credentials$/, (route) =>
      json(route, { credentials: [current] })
    );
    await page.route(
      new RegExp(`/api/admin/mar-agent/codex-credentials/${credentialId}$`),
      (route) => {
        if (route.request().method() === 'PATCH') credentialUpdates += 1;
        return json(route, { details: { credential: current, socks5Url: null } });
      }
    );
    await page.route(
      new RegExp(`/api/admin/mar-agent/codex-credentials/${credentialId}/models/load$`),
      (route) => json(route, { catalog: catalog(currentCatalogHash, true) })
    );
    await page.route(
      new RegExp(`/api/admin/mar-agent/codex-credentials/${credentialId}/refresh$`),
      (route) => {
        if (++refreshCalls > 1)
          current = credential({
            ...current,
            accessTokenExpiresAt: refreshedAccessTokenExpiresAt,
            earliestRefreshAt: refreshedAccessTokenExpiresAt - 1_800_000,
            lastRefreshAt: initialAccessTokenExpiresAt,
            revision: 2
          });
        return json(route, { credential: current });
      }
    );

    await openManagement(page, english);
    await expect(
      page
        .locator('.el-table__row')
        .filter({ hasText: 'ChatGPT model' })
        .getByRole('cell', { name: 'ChatGPT', exact: true })
    ).toBeVisible();
    await expect(
      page
        .locator('.el-table__row')
        .filter({ hasText: 'Legacy model' })
        .getByRole('cell', { name: 'Codex (legacy)', exact: true })
    ).toBeVisible();
    await page
      .getByRole('tab', { name: english ? 'OAuth credentials' : 'OAuth 凭据', exact: true })
      .click();
    await expect(
      page.getByRole('columnheader', {
        name: english ? 'Earliest token refresh' : '最早可刷新时间',
        exact: true
      })
    ).toBeVisible();
    const row = page.locator('.el-table__row').filter({ hasText: 'New ChatGPT' });
    await expect(
      page.getByRole('columnheader', {
        name: english ? 'Credential name' : '凭据名称',
        exact: true
      })
    ).toBeVisible();
    await expect(row.getByText(/2033/u)).toHaveCount(2);
    await row.getByRole('cell', { name: 'New ChatGPT', exact: true }).click();
    const details = page.getByRole('dialog', {
      name: english ? 'OAuth credential details' : 'OAuth 凭据详情'
    });
    await expect(
      details.getByText(english ? 'Earliest token refresh' : '最早可刷新时间', {
        exact: true
      })
    ).toBeVisible();
    await expect(details.getByText(/2033/u)).toHaveCount(2);
    await expect(
      details.getByText(english ? 'OAuth credential ID' : 'OAuth 凭据 ID', {
        exact: true
      })
    ).toBeVisible();
    await expect(
      details.getByText(english ? 'Credential name' : '凭据名称', {
        exact: true
      })
    ).toBeVisible();
    const refresh = details.getByRole('button', {
      name: english ? 'Refresh credential' : '刷新凭据',
      exact: true
    });
    await refresh.click();
    await expect(
      page.getByText(english ? /^Refresh is not available before /u : /^尚未到可刷新时间/u)
    ).toBeVisible();
    await expect(
      page.getByText(english ? 'OAuth credential refreshed.' : 'OAuth 凭据已刷新。', {
        exact: true
      })
    ).toHaveCount(0);
    await expect(details.getByText(/2033/u)).toHaveCount(2);
    await refresh.click();
    await expect(
      page.getByText(english ? 'OAuth credential refreshed.' : 'OAuth 凭据已刷新。', {
        exact: true
      })
    ).toBeVisible();
    await expect(details.getByText(/2036/u)).toHaveCount(2);
    expect(refreshCalls).toBe(2);
    await details.getByRole('button', { name: english ? 'Close' : '关闭', exact: true }).click();
    await row.getByRole('button', { name: english ? 'Edit' : '编辑', exact: true }).click();
    const edit = page.getByRole('dialog', {
      name: english ? 'Edit OAuth credential' : '编辑 OAuth 凭据'
    });
    const credentialName = edit.getByRole('textbox', {
      name: english ? /Credential name$/u : /凭据名称$/u
    });
    await expect(credentialName).toHaveValue('New ChatGPT');
    await expect(
      edit.getByRole('combobox', {
        name: english ? 'Credential type' : '凭据类型',
        exact: true
      })
    ).toBeDisabled();
    await expect(
      edit.locator('.el-form-item').filter({
        hasText: english ? 'Credential type' : '凭据类型'
      })
    ).toContainText('ChatGPT');
    await credentialName.fill('');
    await edit.getByRole('button', { name: english ? 'Save' : '保存', exact: true }).click();
    await expect(
      edit.getByText(english ? 'Enter a credential name.' : '请输入凭据名称。', {
        exact: true
      })
    ).toBeVisible();
    expect(credentialUpdates).toBe(0);
    await edit.getByRole('button', { name: english ? 'Cancel' : '取消', exact: true }).click();
    await row.getByRole('cell', { name: 'New ChatGPT', exact: true }).click();
    await details
      .getByRole('button', {
        name: english ? 'Sign in again' : '重新登录',
        exact: true
      })
      .click();
    const relogin = page.getByRole('dialog', {
      name: english ? 'Sign in again with OAuth' : '重新登录 OAuth 凭据'
    });
    await expect(
      relogin.getByRole('textbox', {
        name: english ? /Credential name$/u : /凭据名称$/u
      })
    ).toHaveValue('New ChatGPT');
    await relogin.getByRole('button', { name: english ? 'Cancel' : '取消', exact: true }).click();
    await row.getByRole('cell', { name: 'New ChatGPT', exact: true }).click();
    await details
      .getByRole('button', {
        name: english ? 'Load model catalog' : '加载模型目录',
        exact: true
      })
      .click();
    await expect(
      page.getByRole('dialog', {
        name: english ? 'OAuth model catalog' : 'OAuth 模型目录'
      })
    ).toBeVisible();
  });
}

test('English Codex credentials preserve keyboard tab semantics and stable reauthentication error codes', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await mockManagementShell(page);
  await page.addInitScript(() => localStorage.setItem('mar.locale.v2', 'en-US'));
  await page.route('**/api/admin/mar-agent/models', (route) => json(route, { models: [] }));
  await page.route(/\/api\/admin\/mar-agent\/codex-credentials$/, (route) =>
    json(route, { credentials: [credential()] })
  );
  await page.route(new RegExp(`/api/admin/mar-agent/codex-credentials/${credentialId}$`), (route) =>
    json(route, {
      details: {
        credential: credential(),
        socks5Url: null
      }
    })
  );
  await page.route(
    new RegExp(`/api/admin/mar-agent/codex-credentials/${credentialId}/refresh$`),
    (route) =>
      json(
        route,
        {
          error: {
            code: 'CODEX_CREDENTIAL_REAUTH_REQUIRED',
            message: 'The credential requires reauthentication.'
          }
        },
        409
      )
  );

  await openManagement(page, true);
  const modelsTab = page.getByRole('tab', { name: 'Models', exact: true });
  await modelsTab.focus();
  await modelsTab.press('ArrowRight');
  const credentialsTab = page.getByRole('tab', { name: 'OAuth credentials', exact: true });
  await expect(credentialsTab).toHaveAttribute('aria-selected', 'true');

  const row = page.locator('.el-table__row').filter({ hasText: 'Team Codex' });
  await row.getByRole('cell', { name: 'Team Codex', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'OAuth credential details' })
    .getByRole('button', { name: 'Refresh credential', exact: true })
    .click();
  await expect(
    page.getByText('The OAuth credential is no longer valid. Sign in again.', { exact: true })
  ).toBeVisible();
});

test('Enterprise model grants and organization credential ownership reuse shared pages and block invalid requests', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await mockManagementShell(page, {
    username: 'admin',
    isAdmin: true,
    edition: 'ENTERPRISE',
    licenseState: 'ENTERPRISE_VALID',
    role: 'ADMIN',
    organizationId: 1,
    managementWritable: true
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let grant: { id: string; targetType: string; targetOrganizationId: number } | undefined;
  const writes: unknown[] = [];
  const loginWrites: unknown[] = [];
  await page.route('**/api/organizations', (route) =>
    json(route, {
      organizations: [
        { id: 1, name: 'Root', parentOrganizationId: null },
        { id: 7, name: 'Platform', parentOrganizationId: 1 }
      ]
    })
  );
  await page.route('**/api/enterprise/users', (route) => json(route, { users: [] }));
  await page.route('**/api/admin/mar-agent/models', (route) =>
    json(route, { models: [{ ...importedModel(), access: grant ? 'PUBLIC' : 'RESTRICTED' }] })
  );
  await page.route(/\/api\/admin\/mar-agent\/codex-credentials$/, (route) =>
    json(route, { credentials: [] })
  );
  await page.route('**/api/resource-grants**', (route) => {
    if (route.request().method() === 'POST') {
      writes.push(route.request().postDataJSON());
      grant = { id: 'grant-1', targetType: 'ORGANIZATION', targetOrganizationId: 7 };
      return json(route, { grant }, 201);
    }
    if (route.request().method() === 'DELETE') {
      grant = undefined;
      return json(route, { success: true });
    }
    return json(route, { grants: grant ? [grant] : [] });
  });
  await page.route('**/api/admin/mar-agent/codex-login-attempts', (route) => {
    loginWrites.push(route.request().postDataJSON());
    return json(route, {
      attempt: {
        id: 'scope-attempt',
        status: 'FAILED',
        code: 'CODEX_DEVICE_AUTH_UNAVAILABLE',
        message: 'Device authorization unavailable.'
      }
    });
  });
  await openManagement(page);
  const row = page.locator('.el-table__row').filter({ hasText: 'GPT Codex Catalog' });
  await row.getByRole('button', { name: '授权', exact: true }).click();
  const grantDialog = page.getByRole('dialog');
  await grantDialog.locator('.el-select__wrapper').first().click();
  await page.getByRole('option', { name: '组织', exact: true }).click();
  await grantDialog.locator('.el-cascader input').fill('Platform');
  await page.getByRole('listitem').filter({ hasText: 'Platform' }).click();
  await grantDialog.getByRole('button', { name: '授权', exact: true }).click();
  await expect(grantDialog.getByRole('button', { name: '撤销', exact: true })).toBeVisible();
  expect(writes).toEqual([
    { resourceType: 'MODEL', modelId, targetType: 'ORGANIZATION', targetOrganizationId: 7 }
  ]);
  await grantDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(row).toContainText('公共');
  await page.getByRole('tab', { name: 'OAuth 凭据', exact: true }).click();
  await page.getByRole('button', { name: '添加 OAuth 凭据', exact: true }).click();
  const credentialDialog = page.getByRole('dialog', { name: '添加 OAuth 凭据', exact: true });
  await credentialDialog.getByRole('button', { name: '开始设备登录', exact: true }).click();
  await expect(credentialDialog.locator('.el-form-item__error')).toBeVisible();
  expect(loginWrites).toHaveLength(0);
  await credentialDialog.getByRole('textbox').first().fill('Organization Codex');
  await credentialDialog.locator('.el-select__wrapper').click();
  await page.getByRole('option', { name: '组织', exact: true }).click();
  await credentialDialog.locator('.el-cascader input').fill('Platform');
  await page.getByRole('listitem').filter({ hasText: 'Platform' }).click();
  await credentialDialog.getByRole('button', { name: '开始设备登录', exact: true }).click();
  await expect.poll(() => loginWrites.length).toBe(1);
  expect(loginWrites).toEqual([
    { name: 'Organization Codex', ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 7 } }
  ]);
  expect(pageErrors).toEqual([]);
});
