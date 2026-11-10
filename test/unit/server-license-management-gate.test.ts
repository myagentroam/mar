import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import type { FastifyInstance } from '../../ee/server/node_modules/fastify/fastify.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashOpaque } from '../../ee/server/src/database.js';
import {
  managementRequirement,
  registerManagementLicenseGate
} from '../../ee/server/src/license/management-gate.js';
import type { LicenseService } from '../../ee/server/src/license/license-service.js';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';

const publicOrigin = 'http://localhost';
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Server License management gate', () => {
  it('separates enterprise management, personal management and runtime operations', () => {
    expect(managementRequirement('POST', '/api/management/users')).toBe('ENTERPRISE_WRITABLE');
    expect(managementRequirement('DELETE', '/api/organizations/:organizationId')).toBe(
      'ENTERPRISE_WRITABLE'
    );
    expect(managementRequirement('POST', '/api/node-registration-tokens')).toBe('WRITABLE');
    expect(managementRequirement('PATCH', '/api/system-settings/:settingKey')).toBe('WRITABLE');
    expect(managementRequirement('PATCH', '/api/workspaces/:workspaceId')).toBe('WRITABLE');
    expect(managementRequirement('DELETE', '/api/nodes/:nodeId')).toBe('WRITABLE');
    expect(managementRequirement('POST', '/api/management/nodes/:nodeId/upgrade')).toBe('WRITABLE');
    expect(managementRequirement('POST', '/api/mcp-sources')).toBe('WRITABLE');
    expect(managementRequirement('DELETE', '/api/mcp-catalog/:entryId')).toBe('WRITABLE');
    expect(managementRequirement('POST', '/api/workspaces/:workspaceId/mcps')).toBe('WRITABLE');
    expect(managementRequirement('PUT', '/api/admin/mar-agent/compact')).toBe('WRITABLE');
    expect(managementRequirement('DELETE', '/api/admin/mar-agent/compact')).toBe('WRITABLE');
    expect(managementRequirement('GET', '/api/admin/mar-agent/compact')).toBe('NONE');
    expect(managementRequirement('POST', '/api/license/import')).toBe('NONE');
    expect(managementRequirement('POST', '/api/runner-commands')).toBe('NONE');
    expect(managementRequirement('POST', '/api/agent-sessions/:sessionId/messages')).toBe('NONE');
    expect(managementRequirement('GET', '/api/management/users')).toBe('NONE');
  });

  it.each([
    ['COMMUNITY', 200],
    ['ENTERPRISE_VALID', 200],
    ['ENTERPRISE_FROZEN', 403]
  ] as const)(
    'gates deployment setting writes under %s without enabling enterprise operations',
    async (state, status) => {
      const app = Fastify();
      apps.push(app);
      registerManagementLicenseGate(app, licenseStub(state), sessionDatabaseStub(), publicOrigin);
      const write = vi.fn(async () => ({ saved: true }));
      app.patch('/api/system-settings/:settingKey', write);
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/system-settings/skill-tls',
        headers: managementHeaders(),
        payload: { verificationDisabled: false }
      });
      expect(response.statusCode).toBe(status);
      expect(write).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
      if (state === 'ENTERPRISE_FROZEN')
        expect(response.json()).toMatchObject({ error: { code: 'LICENSE_MANAGEMENT_FROZEN' } });
    }
  );
});

describe('Server License management gate for the MAR Agent compact configuration', () => {
  it('rejects frozen compact writes for both enabled states without running the handler', async () => {
    const { app, handlerCalls } = await compactGateApp('ENTERPRISE_FROZEN');

    for (const configuration of [
      { enabled: true, modelId: 'coding-anthropic', reasoningEffort: 'high' },
      { enabled: false, modelId: null, reasoningEffort: null }
    ]) {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/mar-agent/compact',
        headers: managementHeaders(),
        payload: configuration
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'LICENSE_MANAGEMENT_FROZEN' } });
    }
    expect(handlerCalls).toEqual([]);
  });

  it('keeps the compact configuration readable while the license is frozen', async () => {
    const { app, handlerCalls } = await compactGateApp('ENTERPRISE_FROZEN');

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/mar-agent/compact',
      headers: managementHeaders()
    });
    expect(response.statusCode).toBe(200);
    expect(handlerCalls).toEqual(['GET']);
  });

  it('allows compact writes under a valid enterprise license and the community edition', async () => {
    for (const state of ['ENTERPRISE_VALID', 'COMMUNITY'] as const) {
      const { app, handlerCalls } = await compactGateApp(state);
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/mar-agent/compact',
        headers: managementHeaders(),
        payload: { enabled: true, modelId: 'coding-anthropic', reasoningEffort: 'high' }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        handled: { enabled: true, modelId: 'coding-anthropic', reasoningEffort: 'high' }
      });
      expect(handlerCalls).toEqual(['PUT']);
    }
  });
});

function managementHeaders() {
  return {
    cookie: 'mar_user_session=admin-session',
    origin: publicOrigin,
    'x-csrf-token': 'csrf-gate'
  };
}

function licenseStub(
  state: 'COMMUNITY' | 'ENTERPRISE_VALID' | 'ENTERPRISE_FROZEN'
): LicenseService {
  return {
    status: vi.fn(async () => ({
      edition: state === 'COMMUNITY' ? ('COMMUNITY' as const) : ('ENTERPRISE' as const),
      state,
      reason: null,
      licenseId: 'license-gate',
      enterpriseName: 'Gate test enterprise',
      expiresAt: null,
      managementWritable: state !== 'ENTERPRISE_FROZEN'
    }))
  } as unknown as LicenseService;
}

function sessionDatabaseStub(): MysqlServerDatabase {
  const sessions: Record<string, unknown> = {
    'admin-session': {
      userId: 1,
      username: 'admin',
      isAdmin: true,
      sessionHash: hashOpaque('admin-session'),
      mustChangePassword: false,
      csrfTokenHash: hashOpaque('csrf-gate')
    }
  };
  return {
    findCurrentUserSession: (sessionId: string) => sessions[sessionId]
  } as unknown as MysqlServerDatabase;
}

async function compactGateApp(
  state: 'COMMUNITY' | 'ENTERPRISE_VALID' | 'ENTERPRISE_FROZEN'
): Promise<{ app: FastifyInstance; handlerCalls: string[] }> {
  const app = Fastify();
  apps.push(app);
  registerManagementLicenseGate(app, licenseStub(state), sessionDatabaseStub(), publicOrigin);
  const handlerCalls: string[] = [];
  app.get('/api/admin/mar-agent/compact', async () => {
    handlerCalls.push('GET');
    return { configuration: { enabled: false, modelId: null, reasoningEffort: null } };
  });
  app.put('/api/admin/mar-agent/compact', async (request) => {
    handlerCalls.push('PUT');
    return { handled: request.body };
  });
  await app.ready();
  return { app, handlerCalls };
}
