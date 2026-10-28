import type { FastifyInstance } from 'fastify';
import { isAllowedOrigin } from '@myagentroam/server-core/auth';
import type { SessionLookup } from '@myagentroam/server-core/session';
import type { OrganizationService } from '../rbac/organization-service.js';
import {
  databaseError,
  normalizedOptionalText,
  positiveId,
  protectedAdmin,
  sendError,
  validCsrf
} from '../util/http-request.js';

export function registerOrganizationRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: SessionLookup;
  readonly organizations: OrganizationService;
  readonly publicOrigin: string | undefined;
  readonly nodeControl: { closeUserSessions(userId: number): void };
}): void {
  const { app, database, organizations, publicOrigin, nodeControl } = input;
  app.get('/api/organizations', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (actor === undefined) return;
    try {
      return reply.send({ organizations: await organizations.list(actor.userId) });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.post<{ Body: { name?: unknown; parentOrganizationId?: unknown } }>(
    '/api/organizations',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      const name = normalizedOptionalText(request.body?.name, 128);
      const parentOrganizationId = request.body?.parentOrganizationId;
      if (typeof name !== 'string' || !positiveNumber(parentOrganizationId))
        return sendError(reply, 400, 'ORGANIZATION_INPUT_INVALID');
      try {
        return reply.code(201).send({
          organization: await organizations.create(actor.userId, name, parentOrganizationId)
        });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.patch<{
    Params: { organizationId: string };
    Body: { name?: unknown; parentOrganizationId?: unknown };
  }>('/api/organizations/:organizationId', async (request, reply) => {
    const actor = writableActor(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    const organizationId = positiveId(request.params.organizationId);
    if (organizationId === undefined) return sendError(reply, 400, 'ORGANIZATION_ID_INVALID');
    try {
      if (request.body?.parentOrganizationId !== undefined) {
        if (!positiveNumber(request.body.parentOrganizationId))
          return sendError(reply, 400, 'ORGANIZATION_INPUT_INVALID');
        const organization = await organizations.move(
          actor.userId,
          organizationId,
          request.body.parentOrganizationId
        );
        for (const userId of await organizations.memberUserIds(organizationId))
          nodeControl.closeUserSessions(userId);
        return reply.send({ organization });
      }
      const name = normalizedOptionalText(request.body?.name, 128);
      if (typeof name !== 'string') return sendError(reply, 400, 'ORGANIZATION_INPUT_INVALID');
      return reply.send({
        organization: await organizations.rename(actor.userId, organizationId, name)
      });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.delete<{ Params: { organizationId: string } }>(
    '/api/organizations/:organizationId',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      const organizationId = positiveId(request.params.organizationId);
      if (organizationId === undefined) return sendError(reply, 400, 'ORGANIZATION_ID_INVALID');
      try {
        await organizations.remove(actor.userId, organizationId);
        return reply.code(204).send();
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
}

function writableActor(
  database: SessionLookup,
  request: Parameters<typeof protectedAdmin>[1],
  reply: Parameters<typeof protectedAdmin>[2],
  publicOrigin: string | undefined
) {
  if (!isAllowedOrigin(request, publicOrigin)) {
    void sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    return undefined;
  }
  const actor = protectedAdmin(database, request, reply);
  if (actor === undefined) return undefined;
  if (!validCsrf(request, actor)) {
    void sendError(reply, 403, 'CSRF_INVALID');
    return undefined;
  }
  return actor;
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
