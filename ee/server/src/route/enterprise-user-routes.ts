import type { FastifyInstance } from 'fastify';
import { isAllowedOrigin } from '@myagentroam/server-core/auth';
import { ManagementQueryError } from '@myagentroam/server-core/management-pagination';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { EnterpriseUserService } from '../rbac/enterprise-user-service.js';
import type { NodeControl } from '../node-control.js';
import {
  databaseError,
  normalizedOptionalText,
  positiveId,
  protectedAdmin,
  sendError,
  validCsrf
} from '../util/http-request.js';

type EnterpriseRole = 'ADMIN' | 'ORG_ADMIN' | 'MEMBER';

export function registerEnterpriseUserRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: MysqlServerDatabase;
  readonly users: EnterpriseUserService;
  readonly publicOrigin: string | undefined;
  readonly nodeControl: NodeControl;
}): void {
  const { app, database, users, publicOrigin, nodeControl } = input;
  app.get<{ Querystring: Record<string, unknown> }>(
    '/api/enterprise/users',
    async (request, reply) => {
      const actor = protectedAdmin(database, request, reply);
      if (actor === undefined) return;
      try {
        return reply.send(await users.list(actor.userId, request.query));
      } catch (error) {
        if (error instanceof ManagementQueryError) return sendError(reply, 400, error.code);
        return databaseError(reply, error);
      }
    }
  );
  app.post<{
    Body: {
      username?: unknown;
      email?: unknown;
      nickname?: unknown;
      role?: unknown;
      organizationId?: unknown;
    };
  }>('/api/enterprise/users', async (request, reply) => {
    const actor = writableActor(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    const values = userInput(request.body);
    if (values === undefined) return sendError(reply, 400, 'USER_INPUT_INVALID');
    try {
      return reply.code(201).send(await users.create(actor.userId, values));
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.patch<{
    Params: { userId: string };
    Body: { role?: unknown; organizationId?: unknown };
  }>('/api/enterprise/users/:userId/membership', async (request, reply) => {
    const actor = writableActor(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    const userId = positiveId(request.params.userId);
    const role = enterpriseRole(request.body?.role);
    const organizationId = request.body?.organizationId;
    if (userId === undefined || role === undefined || !positiveNumber(organizationId))
      return sendError(reply, 400, 'USER_MEMBERSHIP_INVALID');
    try {
      const user = await users.assign(actor.userId, userId, role, organizationId);
      nodeControl.closeUserSessions(userId);
      return reply.send({ user });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.patch<{
    Params: { userId: string };
    Body: { email?: unknown; nickname?: unknown; role?: unknown; organizationId?: unknown };
  }>('/api/enterprise/users/:userId', async (request, reply) => {
    const actor = writableActor(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    const userId = positiveId(request.params.userId);
    const values = editableUserInput(request.body);
    if (userId === undefined || values === undefined)
      return sendError(reply, 400, 'USER_INPUT_INVALID');
    try {
      const user = await users.update(actor.userId, userId, values);
      // Fixed-admin profile updates cannot change authorization.
      if (!user.fixedAdmin) nodeControl.closeUserSessions(userId);
      return reply.send({ user });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
}

function editableUserInput(body: {
  email?: unknown;
  nickname?: unknown;
  role?: unknown;
  organizationId?: unknown;
}) {
  const email = normalizedOptionalText(body?.email, 254);
  const nickname = normalizedOptionalText(body?.nickname, 80);
  const role = enterpriseRole(body?.role);
  if (
    (body.email !== undefined && email === undefined) ||
    (body.nickname !== undefined && nickname === undefined) ||
    (typeof email === 'string' && !email.includes('@')) ||
    role === undefined ||
    !positiveNumber(body?.organizationId)
  )
    return undefined;
  return {
    email: email ?? null,
    nickname: nickname ?? null,
    role,
    organizationId: body.organizationId
  };
}

function userInput(body: {
  username?: unknown;
  email?: unknown;
  nickname?: unknown;
  role?: unknown;
  organizationId?: unknown;
}) {
  const username = normalizedOptionalText(body?.username, 80);
  const email = normalizedOptionalText(body?.email, 254);
  const nickname = normalizedOptionalText(body?.nickname, 80);
  const role = enterpriseRole(body?.role);
  if (
    typeof username !== 'string' ||
    (body.email !== undefined && email === undefined) ||
    (body.nickname !== undefined && nickname === undefined) ||
    (typeof email === 'string' && !email.includes('@')) ||
    role === undefined ||
    !positiveNumber(body?.organizationId)
  ) {
    return undefined;
  }
  return {
    username,
    email: email ?? null,
    nickname: nickname ?? null,
    role,
    organizationId: body.organizationId
  };
}

function writableActor(
  database: MysqlServerDatabase,
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

function enterpriseRole(value: unknown): EnterpriseRole | undefined {
  return value === 'ADMIN' || value === 'ORG_ADMIN' || value === 'MEMBER' ? value : undefined;
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
