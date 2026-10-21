import type { FastifyInstance, FastifyReply } from 'fastify';
import { isAllowedOrigin } from './auth.js';
import type { SessionLookup } from './session.js';
import type { QuickPromptService } from './quick-prompt-service.js';
import { protectedAdmin, validCsrf } from './session.js';
import { sendError } from './http-errors.js';

export function registerQuickPromptRoutes(input: {
  readonly app: FastifyInstance;
  readonly databaseError: (reply: FastifyReply, error: unknown) => FastifyReply;
  readonly database: SessionLookup;
  readonly prompts: QuickPromptService;
  readonly publicOrigin: string | undefined;
}): void {
  const { app, database, prompts, publicOrigin, databaseError } = input;
  app.get('/api/quick-prompts', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (actor === undefined) return;
    try {
      return reply.send({ prompts: await prompts.list(actor.userId) });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.post<{ Body: unknown }>('/api/quick-prompts', async (request, reply) => {
    const actor = writableActor(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    try {
      return reply.code(201).send({ prompt: await prompts.create(actor.userId, request.body) });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.patch<{ Params: { promptId: string }; Body: unknown }>(
    '/api/quick-prompts/:promptId',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        return reply.send({
          prompt: await prompts.update(actor.userId, request.params.promptId, request.body)
        });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.delete<{ Params: { promptId: string } }>(
    '/api/quick-prompts/:promptId',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        await prompts.remove(actor.userId, request.params.promptId);
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
