import { vi } from 'vitest';
import type { MysqlServerDatabase } from '../../../ee/server/src/mysql/server-database.js';
import type { AuthorizationService } from '../../../ee/server/src/rbac/authorization-service.js';
import { CodexCredentialService } from '../../../ee/server/src/service/codex-credential-service.js';

export const NOW = 1_800_000_000_000;

export function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature'
  ].join('.');
}

export function activeCredential(overrides: Record<string, unknown> = {}) {
  return {
    id: 'credential-1',
    name: 'Team Codex',
    type: 'CODEX_OAUTH',
    ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 },
    status: 'ACTIVE',
    accessToken: jwt({ exp: Math.floor((NOW + 60 * 60 * 1000) / 1000) }),
    refreshToken: 'refresh-secret',
    accountId: 'account-secret',
    accessTokenExpiresAt: NOW + 60 * 60 * 1000,
    lastRefreshAt: NOW - 1_000,
    lastCheckedAt: NOW - 1_000,
    proxy: null,
    revision: 1,
    createdAt: NOW - 10_000,
    updatedAt: NOW - 1_000,
    ...overrides
  };
}

export function database(
  credentials: readonly Record<string, unknown>[] = [],
  modelCounts: Readonly<Record<string, number>> = {},
  options: {
    readonly version?: 1 | 2 | 3;
    readonly userOrganizations?: Readonly<Record<number, number>>;
    readonly scopedOrganizationIds?: readonly number[];
    readonly modelGrants?: readonly Record<string, unknown>[];
  } = {}
) {
  let document: unknown = { version: options.version ?? 3, credentials };
  const execute = vi.fn(async (sql: string, parameters: unknown[] = []) => {
    if (sql.includes("setting_key='mar_agent_credentials'"))
      return [[{ setting_value: JSON.stringify(document) }], []];
    if (sql.includes('INSERT INTO system_settings')) {
      document = JSON.parse(String(parameters[0]));
      return [{ affectedRows: 1 }, []];
    }
    if (sql.includes('credential_id') && sql.includes('mar_agent_models'))
      return [
        Object.entries(modelCounts).map(([credential_id, imported_model_count]) => ({
          credential_id,
          imported_model_count
        })),
        []
      ];
    if (sql.includes('SELECT organization_id FROM users WHERE id=?')) {
      const organizationId = options.userOrganizations?.[Number(parameters[0])];
      return [organizationId === undefined ? [] : [{ organization_id: organizationId }], []];
    }
    if (sql.includes('WITH RECURSIVE ancestors')) {
      const organizationId = Number(parameters[0]);
      const ancestorOrganizationId = Number(parameters[1]);
      const allowed =
        organizationId === ancestorOrganizationId ||
        options.scopedOrganizationIds?.includes(organizationId) === true;
      return [allowed ? [{ present: 1 }] : [], []];
    }
    if (sql.includes('FROM resource_grants') && sql.includes('model_id'))
      return [options.modelGrants ?? [], []];
    return [[], []];
  });
  const audit = vi.fn(async (_event: unknown) => undefined);
  return {
    audit,
    database: { raw: { execute }, audit } as unknown as MysqlServerDatabase,
    execute,
    document: () => document
  };
}

export function service(
  database: MysqlServerDatabase,
  request: typeof fetch = vi.fn(),
  now: () => number = () => NOW,
  id: () => string = () => 'generated-id',
  authorization: AuthorizationService = authorizationFixture()
) {
  return new CodexCredentialService(database, {
    authorization,
    request,
    now,
    id,
    authIssuer: 'https://auth.example.test',
    codexBaseUrl: 'https://chatgpt.example.test/backend-api/codex',
    clientId: 'codex-client',
    projectVersion: '0.9.27'
  });
}

export function authorizationFixture(
  contexts: Readonly<
    Record<
      number,
      { readonly role: 'ADMIN' | 'ORG_ADMIN' | 'MEMBER'; readonly organizationId: number }
    >
  > = {
    1: { role: 'ADMIN', organizationId: 1 },
    2: { role: 'ORG_ADMIN', organizationId: 2 },
    7: { role: 'MEMBER', organizationId: 4 },
    8: { role: 'MEMBER', organizationId: 5 }
  }
): AuthorizationService {
  return {
    actorContext: vi.fn(async (userId: number) => contexts[userId]),
    isPersonalAdmin: vi.fn(async (userId: number) => userId === 99),
    authorize: vi.fn(async (userId: number, _permissionId: string, context: object) => {
      const actor = contexts[userId];
      if (actor?.role === 'ADMIN') return { allowed: true };
      const organizationId = (context as { organizationId?: number }).organizationId;
      if (
        actor?.role === 'ORG_ADMIN' &&
        (organizationId === actor.organizationId || organizationId === 4)
      )
        return { allowed: true };
      return { allowed: false, reason: 'RBAC_SCOPE_DENIED' };
    })
  } as unknown as AuthorizationService;
}
