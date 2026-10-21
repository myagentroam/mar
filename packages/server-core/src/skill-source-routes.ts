import type { FastifyInstance } from 'fastify';
import { isAllowedOrigin } from './auth.js';
import type { SessionLookup } from './session.js';
import type { SkillSourceService } from './skill-source-service.js';
import type { SkillDiscoveryService } from './skill-discovery-service.js';
import { databaseError } from './domain-errors.js';
import { protectedAdmin, validCsrf } from './session.js';
import { sendError } from './http-errors.js';

export function registerSkillSourceRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: SessionLookup;
  readonly sources: SkillSourceService;
  readonly discovery: SkillDiscoveryService;
  readonly publicOrigin: string | undefined;
}): void {
  const { app, database, sources, discovery, publicOrigin } = input;
  app.get('/api/skill-sources', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (actor === undefined) return;
    try {
      return reply.send({ sources: await sources.list(actor.userId) });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.post<{ Body: unknown }>('/api/skill-sources', async (request, reply) => {
    const actor = writableActor(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    try {
      return reply.code(201).send({ source: await sources.create(actor.userId, request.body) });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.get<{
    Params: { sourceId: string };
    Querystring: { query?: string; limit?: string };
  }>('/api/skill-sources/:sourceId/skills', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (actor === undefined) return;
    const limit = request.query.limit === undefined ? 40 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit)) return sendError(reply, 400, 'SKILL_SOURCE_QUERY_INVALID');
    try {
      const source = await sources.getVisible(actor.userId, request.params.sourceId);
      return reply.send({
        skills: await discovery.search(source, request.query.query ?? '', limit)
      });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.patch<{ Params: { sourceId: string }; Body: { enabled?: unknown } }>(
    '/api/skill-sources/:sourceId',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      if (typeof request.body?.enabled !== 'boolean')
        return sendError(reply, 400, 'SKILL_SOURCE_INPUT_INVALID');
      try {
        await sources.setEnabled(actor.userId, request.params.sourceId, request.body.enabled);
        return reply.code(204).send();
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.delete<{ Params: { sourceId: string } }>(
    '/api/skill-sources/:sourceId',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        await sources.remove(actor.userId, request.params.sourceId);
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
