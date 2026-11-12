import type { FastifyInstance } from 'fastify';
import { isAllowedOrigin } from '@myagentroam/server-core/auth';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { LicenseService } from '../license/license-service.js';
import {
  databaseError,
  protectedManagementAdmin,
  sendError,
  validCsrf
} from '../util/http-request.js';

export function registerLicenseRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: MysqlServerDatabase;
  readonly licenses: LicenseService;
  readonly publicOrigin: string | undefined;
  readonly activationAvailable?: boolean;
  readonly activationVisible?: boolean;
}): void {
  const { app, database, licenses, publicOrigin } = input;
  app.get('/api/license', async (request, reply) => {
    if (protectedManagementAdmin(database, request, reply) === undefined) return;
    return reply.header('cache-control', 'private, no-store').send({
      ...(await licenses.status()),
      activationAvailable: input.activationAvailable !== false,
      activationVisible: input.activationAvailable !== false && input.activationVisible !== false
    });
  });
  if (input.activationAvailable === false) return;
  app.get('/api/license/request-code', async (request, reply) => {
    if (protectedManagementAdmin(database, request, reply) === undefined) return;
    try {
      return reply.header('cache-control', 'private, no-store').send(licenses.requestCode());
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.post<{ Body: { document?: unknown } }>('/api/license/import', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedManagementAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    if (typeof request.body?.document !== 'string')
      return sendError(reply, 400, 'LICENSE_DOCUMENT_INVALID');
    try {
      return reply.send(await licenses.import(request.body.document, admin.userId));
    } catch (error) {
      return databaseError(reply, error);
    }
  });
}
