import type { FastifyInstance } from 'fastify';
import type { LicenseService } from './license-service.js';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import { isAllowedOrigin } from '@myagentroam/server-core/auth';
import { currentSession, sendError, validCsrf } from '../util/http-request.js';

export type ManagementRequirement = 'NONE' | 'WRITABLE' | 'ENTERPRISE_WRITABLE';

export function managementRequirement(method: string, route: string): ManagementRequirement {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || route === '/api/license/import')
    return 'NONE';
  if (
    route.startsWith('/api/management/users') ||
    route.startsWith('/api/enterprise/users') ||
    route.startsWith('/api/organizations') ||
    route.startsWith('/api/resource-grants') ||
    route.startsWith('/api/oauth-providers')
  ) {
    return 'ENTERPRISE_WRITABLE';
  }
  if (
    route === '/api/node-registration-tokens' ||
    route === '/api/admin/mar-agent/compact' ||
    route.startsWith('/api/management/nodes') ||
    route === '/api/workspaces' ||
    (route === '/api/workspaces/:workspaceId' && (method === 'PATCH' || method === 'DELETE')) ||
    route.startsWith('/api/workspaces/:workspaceId/mcps') ||
    route.startsWith('/api/nodes/:nodeId') ||
    route.startsWith('/api/environment-secrets') ||
    route.startsWith('/api/system-settings') ||
    route.startsWith('/api/mcp-sources') ||
    route.startsWith('/api/mcp-catalog')
  ) {
    return 'WRITABLE';
  }
  return 'NONE';
}

export function registerManagementLicenseGate(
  app: FastifyInstance,
  licenses: LicenseService,
  database: MysqlServerDatabase,
  publicOrigin: string | undefined
): void {
  app.addHook('preHandler', async (request, reply) => {
    const requirement = managementRequirement(request.method, request.routeOptions.url ?? '');
    if (requirement === 'NONE') return;
    const current = currentSession(database, request);
    if (
      current === undefined ||
      current.mustChangePassword ||
      !isAllowedOrigin(request, publicOrigin) ||
      !validCsrf(request, current)
    ) {
      return;
    }
    const status = await licenses.status();
    if (status.state === 'ENTERPRISE_FROZEN') {
      return sendError(reply, 403, 'LICENSE_MANAGEMENT_FROZEN');
    }
    if (requirement === 'ENTERPRISE_WRITABLE' && status.state !== 'ENTERPRISE_VALID') {
      return sendError(reply, 403, 'ENTERPRISE_LICENSE_REQUIRED');
    }
  });
}
