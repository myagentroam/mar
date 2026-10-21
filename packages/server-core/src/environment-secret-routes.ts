import { managementPageQuery, ManagementQueryError } from './management-pagination.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { isAllowedOrigin } from './auth.js';
import type { SessionLookup } from './session.js';
import type {
  EnvironmentSecretScope,
  EnvironmentSecretOperations
} from './environment-secret-contracts.js';
import { protectedAdmin, validCsrf } from './session.js';
import { sendError } from './http-errors.js';

export function registerEnvironmentSecretRoutes(input: {
  readonly app: FastifyInstance;
  readonly databaseError: (reply: FastifyReply, error: unknown) => FastifyReply;
  readonly database: SessionLookup;
  readonly secrets: EnvironmentSecretOperations;
  readonly publicOrigin: string | undefined;
}): void {
  const { app, database, secrets, publicOrigin, databaseError } = input;

  app.get<{ Querystring: Record<string, unknown> & { nodeId?: string; workspaceId?: string } }>(
    '/api/environment-secrets',
    async (request, reply) => {
      const user = protectedAdmin(database, request, reply);
      if (user === undefined) return;
      try {
        if (managementPageQuery(request.query) !== undefined) {
          if (secrets.listPage === undefined) throw new ManagementQueryError();
          return reply.send(await secrets.listPage(user, request.query));
        }
        return reply.send({
          secrets: await secrets.list(user, request.query.nodeId, request.query.workspaceId)
        });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.post<{
    Body: {
      scope?: unknown;
      name?: unknown;
      value?: unknown;
      nodeId?: unknown;
      workspaceId?: unknown;
      organizationId?: unknown;
      visibility?: unknown;
    };
  }>('/api/environment-secrets', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const user = protectedAdmin(database, request, reply);
    if (user === undefined) return;
    if (!validCsrf(request, user)) return sendError(reply, 403, 'CSRF_INVALID');
    const body = request.body ?? {};
    if (!isScope(body.scope) || typeof body.name !== 'string' || typeof body.value !== 'string')
      return sendError(reply, 400, 'SECRET_INPUT_INVALID');
    if (body.nodeId !== undefined && typeof body.nodeId !== 'string')
      return sendError(reply, 400, 'SECRET_INPUT_INVALID');
    if (body.workspaceId !== undefined && typeof body.workspaceId !== 'string')
      return sendError(reply, 400, 'SECRET_INPUT_INVALID');
    if (body.organizationId !== undefined && !Number.isSafeInteger(body.organizationId))
      return sendError(reply, 400, 'SECRET_INPUT_INVALID');
    if (
      body.visibility !== undefined &&
      body.visibility !== 'PRIVATE' &&
      body.visibility !== 'PUBLIC'
    )
      return sendError(reply, 400, 'SECRET_INPUT_INVALID');
    try {
      return reply.code(201).send({
        secret: await secrets.create(user, {
          scope: body.scope,
          name: body.name,
          value: body.value,
          ...(typeof body.nodeId === 'string' ? { nodeId: body.nodeId } : {}),
          ...(typeof body.workspaceId === 'string' ? { workspaceId: body.workspaceId } : {}),
          ...(typeof body.organizationId === 'number'
            ? { organizationId: body.organizationId }
            : {}),
          ...(body.visibility === 'PRIVATE' || body.visibility === 'PUBLIC'
            ? { visibility: body.visibility }
            : {})
        })
      });
    } catch (error) {
      return databaseError(reply, normalizeConstraint(error));
    }
  });

  app.put<{ Params: { secretId: string }; Body: { value?: unknown } }>(
    '/api/environment-secrets/:secretId',
    async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const user = protectedAdmin(database, request, reply);
      if (user === undefined) return;
      if (!validCsrf(request, user)) return sendError(reply, 403, 'CSRF_INVALID');
      if (typeof request.body?.value !== 'string')
        return sendError(reply, 400, 'SECRET_INPUT_INVALID');
      try {
        return reply.send({
          secret: await secrets.replace(user, request.params.secretId, request.body.value)
        });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.delete<{ Params: { secretId: string } }>(
    '/api/environment-secrets/:secretId',
    async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const user = protectedAdmin(database, request, reply);
      if (user === undefined) return;
      if (!validCsrf(request, user)) return sendError(reply, 403, 'CSRF_INVALID');
      try {
        await secrets.remove(user, request.params.secretId);
        return reply.code(204).send();
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
}

function isScope(value: unknown): value is EnvironmentSecretScope {
  return (
    value === 'PERSONAL' || value === 'ORGANIZATION' || value === 'NODE' || value === 'WORKSPACE'
  );
}

function normalizeConstraint(error: unknown): unknown {
  return error instanceof Error &&
    (error.message.includes('UNIQUE constraint failed') ||
      ('code' in error && error.code === 'ER_DUP_ENTRY'))
    ? new Error('SECRET_ALREADY_EXISTS')
    : error;
}
