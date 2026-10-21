import type { FastifyInstance } from 'fastify';
import { isAllowedOrigin } from './auth.js';
import type { SessionLookup } from './session.js';
import type { SkillFavoriteService } from './skill-favorite-service.js';
import { databaseError } from './domain-errors.js';
import { protectedAdmin, validCsrf } from './session.js';
import { sendError } from './http-errors.js';

export function registerSkillFavoriteRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: SessionLookup;
  readonly favorites: SkillFavoriteService;
  readonly publicOrigin: string | undefined;
}): void {
  const { app, database, favorites, publicOrigin } = input;
  app.get<{ Querystring: Record<string, unknown> }>(
    '/api/skill-favorites',
    async (request, reply) => {
      const actor = protectedAdmin(database, request, reply);
      if (actor === undefined) return;
      try {
        return reply.send(
          Object.keys(request.query).length
            ? await favorites.listQuery(actor.userId, request.query)
            : { favorites: await favorites.list(actor.userId) }
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.post<{ Body: unknown }>('/api/skill-favorites', async (request, reply) => {
    const actor = writableActor(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    try {
      return reply.code(201).send({ favorite: await favorites.create(actor.userId, request.body) });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.post<{ Params: { favoriteId: string } }>(
    '/api/skill-favorites/:favoriteId/check-update',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        return reply.send(await favorites.checkUpdate(actor.userId, request.params.favoriteId));
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.post<{ Params: { favoriteId: string } }>(
    '/api/skill-favorites/:favoriteId/upgrade',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        return reply.send({
          favorite: await favorites.upgrade(actor.userId, request.params.favoriteId)
        });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.patch<{ Params: { favoriteId: string }; Body: unknown }>(
    '/api/skill-favorites/:favoriteId',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        await favorites.updatePresentation(actor.userId, request.params.favoriteId, request.body);
        return reply.code(204).send();
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.delete<{ Params: { favoriteId: string } }>(
    '/api/skill-favorites/:favoriteId',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        await favorites.remove(actor.userId, request.params.favoriteId);
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
