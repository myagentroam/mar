import { randomUUID } from 'node:crypto';
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type APIResponse
} from '@playwright/test';
import mysql from 'mysql2/promise';
import type { RuntimeCredentialTicket } from '../../packages/protocol/src/index.js';
import { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { AuthorizationService } from '../../ee/server/src/rbac/authorization-service.js';
import { ResourceAccessService } from '../../ee/server/src/rbac/resource-access-service.js';
import { CodexCredentialService } from '../../ee/server/src/service/codex-credential-service.js';
import { MarAgentModelService } from '../../ee/server/src/service/mar-agent-model-service.js';
import { RuntimeCredentialService } from '../../packages/server-core/src/runtime-credential-service.js';
import { createPlaywrightTestLicenseDocument } from './support/playwright-test-license.js';
import { createEnterpriseTestServer } from './support/enterprise-test-server.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';

type AuthenticatedContext = {
  readonly context: APIRequestContext;
  readonly csrfToken: string;
};

test('Codex credential scope governs management, model grants, visibility, and runtime revalidation', async ({
  browserName
}) => {
  test.skip(browserName !== 'chromium', 'The shared credential document is exercised once.');
  const server = await createEnterpriseTestServer('credential-scope');
  const baseURL = server.baseURL;
  const database = new MysqlServerDatabase(mysql.createPool(server.databaseUrl));
  const contexts: AuthenticatedContext[] = [];

  try {
    const admin = await login(baseURL, 'admin', INITIAL_ADMIN_PASSWORD, 'CredentialScopeAdmin123!');
    contexts.push(admin);
    await writeJson(admin, 'POST', '/api/license/import', {
      document: createPlaywrightTestLicenseDocument()
    });
    const [adminRows] = await database.raw.execute<mysql.RowDataPacket[]>(
      'SELECT id,organization_id FROM users WHERE is_fixed_admin=TRUE'
    );
    const adminUserId = Number(adminRows[0]?.['id']);
    const rootOrganizationId = Number(adminRows[0]?.['organization_id']);

    const organizationA = await createOrganization(admin, 'Credential Scope A', rootOrganizationId);
    const organizationAChild = await createOrganization(
      admin,
      'Credential Scope A Child',
      organizationA
    );
    const organizationB = await createOrganization(admin, 'Credential Scope B', rootOrganizationId);
    const orgAdminRecord = await createUser(
      admin,
      'credential-scope-org-admin',
      'ORG_ADMIN',
      organizationA
    );
    const memberARecord = await createUser(
      admin,
      'credential-scope-member-a',
      'MEMBER',
      organizationAChild
    );
    const memberBRecord = await createUser(
      admin,
      'credential-scope-member-b',
      'MEMBER',
      organizationB
    );
    const orgAdmin = await login(
      baseURL,
      'credential-scope-org-admin',
      orgAdminRecord.temporaryPassword,
      'CredentialScopeOrgAdmin123!'
    );
    const memberA = await login(
      baseURL,
      'credential-scope-member-a',
      memberARecord.temporaryPassword,
      'CredentialScopeMemberA123!'
    );
    const memberB = await login(
      baseURL,
      'credential-scope-member-b',
      memberBRecord.temporaryPassword,
      'CredentialScopeMemberB123!'
    );
    contexts.push(orgAdmin, memberA, memberB);

    const now = Date.now();
    await saveCredentialDocument(database, {
      version: 3,
      credentials: [
        credential(
          'credential-enterprise',
          'Root Organization Codex',
          { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 },
          now
        ),
        credential(
          'credential-org-a',
          'Organization A Codex',
          { ownerType: 'ORGANIZATION', ownerOrganizationId: organizationA },
          now
        ),
        credential(
          'credential-org-b',
          'Organization B Codex',
          { ownerType: 'ORGANIZATION', ownerOrganizationId: organizationB },
          now
        ),
        credential(
          'credential-member-a',
          'Member A Codex',
          { ownerType: 'PERSONAL', ownerUserId: memberARecord.id },
          now
        )
      ]
    });

    expect(await credentialIds(admin.context)).toEqual([
      'credential-enterprise',
      'credential-org-a',
      'credential-org-b'
    ]);
    expect(await credentialIds(orgAdmin.context)).toEqual(['credential-org-a']);
    expect(await credentialIds(memberA.context)).toEqual(['credential-member-a']);
    expect(await credentialIds(memberB.context)).toEqual([]);

    await writeJson(orgAdmin, 'PATCH', '/api/admin/mar-agent/codex-credentials/credential-org-a', {
      name: 'Organization A Codex Updated'
    });
    await expectError(
      orgAdmin,
      'PATCH',
      '/api/admin/mar-agent/codex-credentials/credential-org-b',
      { name: 'Forbidden Rename' },
      404,
      'CODEX_CREDENTIAL_NOT_FOUND'
    );

    const organizationModelId = await createModel(
      admin,
      'credential-org-a',
      'Organization Scoped',
      { ownerType: 'ORGANIZATION', ownerOrganizationId: organizationA }
    );
    await writeJson(
      admin,
      'POST',
      '/api/resource-grants',
      {
        resourceType: 'MODEL',
        modelId: organizationModelId,
        targetType: 'ORGANIZATION',
        targetOrganizationId: organizationAChild
      },
      201
    );
    await writeJson(
      admin,
      'POST',
      '/api/resource-grants',
      {
        resourceType: 'MODEL',
        modelId: organizationModelId,
        targetType: 'USER',
        targetUserId: memberARecord.id
      },
      201
    );
    await expectError(
      admin,
      'POST',
      '/api/resource-grants',
      {
        resourceType: 'MODEL',
        modelId: organizationModelId,
        targetType: 'ORGANIZATION',
        targetOrganizationId: organizationB
      },
      403,
      'CODEX_CREDENTIAL_SCOPE_FORBIDDEN'
    );

    const enterpriseModelId = await createModel(
      admin,
      'credential-enterprise',
      'Enterprise Scoped',
      { ownerType: 'ORGANIZATION', ownerOrganizationId: organizationB }
    );
    await writeJson(
      admin,
      'POST',
      '/api/resource-grants',
      {
        resourceType: 'MODEL',
        modelId: enterpriseModelId,
        targetType: 'ORGANIZATION',
        targetOrganizationId: organizationB
      },
      201
    );
    await expectError(
      admin,
      'PATCH',
      '/api/admin/mar-agent/codex-credentials/credential-enterprise',
      { ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: organizationA } },
      409,
      'CODEX_CREDENTIAL_SCOPE_CONFLICT'
    );

    const authorization = new AuthorizationService(database);
    const credentials = new CodexCredentialService(database, {
      authorization,
      now: () => now,
      request: async () => {
        throw new Error('Unexpected external credential request');
      }
    });
    const resources = new ResourceAccessService(database, authorization, () => now, credentials);
    const models = new MarAgentModelService(
      database,
      () => now,
      randomUUID,
      resources,
      credentials
    );
    const visibleToMemberA = await models.listForUser(memberARecord.id);
    expect(visibleToMemberA.map((model) => model.id)).toContain(organizationModelId);
    expect(visibleToMemberA[0]).not.toHaveProperty('credentialId');
    expect(visibleToMemberA[0]).not.toHaveProperty('credential');
    expect((await models.listForUser(memberBRecord.id)).map((model) => model.id)).not.toContain(
      organizationModelId
    );

    let nonce = 0;
    const runtimeCredentials = new RuntimeCredentialService({
      resolveCredential: (credentialId, reason) => credentials.resolve(credentialId, reason),
      readModel: (modelId) => models.stored(modelId),
      canUseModel: (userId, modelId) => resources.canUseModel(userId, modelId),
      now: () => now,
      nonce: () => `scope-nonce-${++nonce}`,
      hmacKey: Buffer.alloc(32, 7)
    });
    const nodeId = 'credential-scope-node';
    runtimeCredentials.activateNodeConnection(nodeId);
    const ticket = await runtimeCredentials.issue({
      userId: memberARecord.id,
      credentialId: 'credential-org-a',
      nodeId,
      workspaceId: 'credential-scope-workspace',
      runtimeScopeId: 'credential-scope-runtime',
      allowedModelIds: [organizationModelId]
    });
    await expect(
      runtimeCredentials.issue({
        userId: memberBRecord.id,
        credentialId: 'credential-org-a',
        nodeId,
        workspaceId: 'credential-scope-workspace',
        runtimeScopeId: 'credential-scope-runtime-b',
        allowedModelIds: [organizationModelId]
      })
    ).rejects.toThrow('MAR_AGENT_RUNTIME_MODEL_FORBIDDEN');
    expect(
      await resolveRuntime(runtimeCredentials, nodeId, ticket, organizationModelId)
    ).toMatchObject({
      credential: { bearer: 'access-credential-org-a' }
    });

    await writeJson(admin, 'PATCH', `/api/enterprise/users/${memberARecord.id}/membership`, {
      role: 'MEMBER',
      organizationId: organizationB
    });
    expect(
      await resolveRuntime(runtimeCredentials, nodeId, ticket, organizationModelId)
    ).toMatchObject({
      error: { code: 'MAR_AGENT_RUNTIME_MODEL_FORBIDDEN' }
    });
    await writeJson(admin, 'PATCH', `/api/enterprise/users/${memberARecord.id}/membership`, {
      role: 'MEMBER',
      organizationId: organizationAChild
    });

    await database.raw.execute(
      'UPDATE mar_agent_models SET credential=CAST(? AS JSON),updated_at=? WHERE id=?',
      [
        JSON.stringify({ type: 'CREDENTIAL_REF', credentialId: 'credential-enterprise' }),
        now,
        organizationModelId
      ]
    );
    expect(
      await resolveRuntime(runtimeCredentials, nodeId, ticket, organizationModelId)
    ).toMatchObject({
      error: { code: 'MAR_AGENT_RUNTIME_MODEL_CREDENTIAL_CHANGED' }
    });
    await database.raw.execute(
      'UPDATE mar_agent_models SET credential=CAST(? AS JSON),updated_at=? WHERE id=?',
      [
        JSON.stringify({ type: 'CREDENTIAL_REF', credentialId: 'credential-org-a' }),
        now,
        organizationModelId
      ]
    );
    await updateCredentialStatus(database, 'credential-org-a', 'REAUTH_REQUIRED');
    expect(
      await resolveRuntime(runtimeCredentials, nodeId, ticket, organizationModelId)
    ).toMatchObject({
      error: { code: 'CODEX_CREDENTIAL_REAUTH_REQUIRED' }
    });
    expect(Number.isSafeInteger(adminUserId)).toBe(true);
  } finally {
    await Promise.all(contexts.map((value) => value.context.dispose()));
    await database.close();
    await server.close();
  }
});

type CredentialOwnership =
  | { readonly ownerType: 'PERSONAL'; readonly ownerUserId: number }
  | { readonly ownerType: 'ORGANIZATION'; readonly ownerOrganizationId: number };

function credential(id: string, name: string, ownership: CredentialOwnership, now: number) {
  return {
    id,
    name,
    type: 'CODEX_OAUTH',
    ownership,
    status: 'ACTIVE',
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    accountId: `account-${id}`,
    accessTokenExpiresAt: now + 60 * 60 * 1000,
    lastRefreshAt: now,
    lastCheckedAt: now,
    proxy: null,
    revision: 1,
    createdAt: now,
    updatedAt: now
  };
}

async function createOrganization(
  actor: AuthenticatedContext,
  name: string,
  parentOrganizationId: number
): Promise<number> {
  const result = await writeJson<{ organization: { id: number } }>(
    actor,
    'POST',
    '/api/organizations',
    { name, parentOrganizationId },
    201
  );
  return result.organization.id;
}

async function createUser(
  actor: AuthenticatedContext,
  username: string,
  role: 'ORG_ADMIN' | 'MEMBER',
  organizationId: number
): Promise<{ readonly id: number; readonly temporaryPassword: string }> {
  const result = await writeJson<{
    user: { id: number };
    temporaryPassword: string;
  }>(actor, 'POST', '/api/enterprise/users', { username, role, organizationId }, 201);
  return { id: result.user.id, temporaryPassword: result.temporaryPassword };
}

async function createModel(
  actor: AuthenticatedContext,
  credentialId: string,
  name: string,
  ownership: { readonly ownerType: 'ORGANIZATION'; readonly ownerOrganizationId: number }
): Promise<string> {
  const result = await writeJson<{ model: { id: string } }>(
    actor,
    'POST',
    '/api/admin/mar-agent/models',
    {
      name,
      ownership,
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      credential: { type: 'CREDENTIAL_REF', credentialId },
      modelId: `${credentialId}-model`,
      contextWindowTokens: 200_000,
      maxOutputTokens: 16_384,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: ['high'],
      defaultReasoningEffort: 'high',
      hostedWebSearch: false,
      responsesTransport: { transport: 'WEBSOCKET' },
      responsesPreviousResponseId: true,
      enabled: true,
      sortOrder: 0
    },
    201
  );
  return result.model.id;
}

async function saveCredentialDocument(
  database: MysqlServerDatabase,
  document: Readonly<Record<string, unknown>>
): Promise<void> {
  await database.raw.execute(
    `INSERT INTO system_settings (setting_key,setting_value,updated_at)
     VALUES ('mar_agent_credentials',CAST(? AS JSON),?)
     ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value),updated_at=VALUES(updated_at)`,
    [JSON.stringify(document), Date.now()]
  );
}

async function updateCredentialStatus(
  database: MysqlServerDatabase,
  credentialId: string,
  status: 'ACTIVE' | 'DEGRADED' | 'REAUTH_REQUIRED'
): Promise<void> {
  const [rows] = await database.raw.execute<mysql.RowDataPacket[]>(
    "SELECT setting_value FROM system_settings WHERE setting_key='mar_agent_credentials'"
  );
  const raw = rows[0]?.['setting_value'];
  const document = (
    typeof raw === 'string'
      ? JSON.parse(raw)
      : Buffer.isBuffer(raw)
        ? JSON.parse(raw.toString())
        : raw
  ) as { credentials: Array<Record<string, unknown>> };
  const target = document.credentials.find((value) => value['id'] === credentialId);
  if (target === undefined) throw new Error('CREDENTIAL_FIXTURE_NOT_FOUND');
  target['status'] = status;
  target['revision'] = Number(target['revision']) + 1;
  target['updatedAt'] = Date.now();
  await saveCredentialDocument(database, document);
}

async function credentialIds(context: APIRequestContext): Promise<readonly string[]> {
  const response = await context.get('/api/admin/mar-agent/codex-credentials');
  const body = await expectJson<{ credentials: Array<{ id: string }> }>(response, 200);
  return body.credentials.map((credential) => credential.id);
}

function resolveRuntime(
  service: RuntimeCredentialService,
  nodeId: string,
  ticket: RuntimeCredentialTicket,
  modelId: string
) {
  return service.resolve(nodeId, {
    ticket,
    modelId,
    runtimeScopeId: ticket.runtimeScopeId,
    executionId: 'credential-scope-execution',
    reason: 'REQUEST'
  });
}

async function login(
  baseURL: string,
  username: string,
  currentPassword: string,
  password: string
): Promise<AuthenticatedContext> {
  const bootstrap = await playwrightRequest.newContext({ baseURL });
  const loginResponse = await bootstrap.post('/api/auth/login', {
    data: { username, password: currentPassword }
  });
  const loginBody = await expectJson<{ csrfToken: string }>(loginResponse, 200);
  const loginCookie = responseCookie(loginResponse);
  await bootstrap.dispose();
  const passwordContext = await playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: { cookie: loginCookie }
  });
  const changed = await passwordContext.post('/api/auth/change-password', {
    headers: { 'x-csrf-token': loginBody.csrfToken },
    data: { currentPassword, password }
  });
  const changedBody = await expectJson<{ csrfToken: string }>(changed, 200);
  const changedCookie = responseCookie(changed);
  await passwordContext.dispose();
  return {
    context: await playwrightRequest.newContext({
      baseURL,
      extraHTTPHeaders: { cookie: changedCookie }
    }),
    csrfToken: changedBody.csrfToken
  };
}

async function writeJson<T = unknown>(
  actor: AuthenticatedContext,
  method: 'POST' | 'PATCH',
  path: string,
  data: unknown,
  expectedStatus = 200
): Promise<T> {
  const response = await actor.context.fetch(path, {
    method,
    headers: { 'x-csrf-token': actor.csrfToken },
    data
  });
  return expectJson<T>(response, expectedStatus);
}

async function expectError(
  actor: AuthenticatedContext,
  method: 'POST' | 'PATCH',
  path: string,
  data: unknown,
  expectedStatus: number,
  code: string
): Promise<void> {
  const response = await actor.context.fetch(path, {
    method,
    headers: { 'x-csrf-token': actor.csrfToken },
    data
  });
  const body = await expectJson<{ error: { code: string } }>(response, expectedStatus);
  expect(body.error.code).toBe(code);
}

async function expectJson<T>(response: APIResponse, expectedStatus: number): Promise<T> {
  const body = (await response.json()) as T;
  expect(response.status(), JSON.stringify(body)).toBe(expectedStatus);
  return body;
}

function responseCookie(response: APIResponse): string {
  const raw = response.headers()['set-cookie'];
  if (raw === undefined) throw new Error('SESSION_COOKIE_MISSING');
  return raw.split(';', 1)[0]!;
}
