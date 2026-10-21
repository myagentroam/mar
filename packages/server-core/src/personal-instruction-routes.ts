import type { FastifyInstance, FastifyReply } from 'fastify';
import { isAllowedOrigin } from './auth.js';
import type { SessionLookup } from './session.js';
import {
  personalInstructionScope,
  type PersonalInstructionService
} from './personal-instruction-service.js';
import { protectedAdmin, validCsrf } from './session.js';
import { sendError } from './http-errors.js';

export function registerPersonalInstructionRoutes(input: {
  readonly app: FastifyInstance;
  readonly databaseError: (reply: FastifyReply, error: unknown) => FastifyReply;
  readonly database: SessionLookup;
  readonly instructions: PersonalInstructionService;
  readonly publicOrigin: string | undefined;
}): void {
  const { app, database, instructions, publicOrigin, databaseError } = input;
  app.get('/api/personal-instructions', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (actor === undefined) return;
    try {
      return reply.send({ instructions: await instructions.get(actor.userId) });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.put<{ Params: { scope: string }; Body: unknown }>(
    '/api/personal-instructions/:scope',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      const scope = personalInstructionScope(request.params.scope);
      if (actor === undefined) return;
      if (scope === undefined) return sendError(reply, 400, 'PERSONAL_INSTRUCTION_INVALID');
      try {
        return reply.send({
          instructions: await instructions.save(actor.userId, scope, request.body)
        });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.delete<{ Params: { scope: string } }>(
    '/api/personal-instructions/:scope',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      const scope = personalInstructionScope(request.params.scope);
      if (actor === undefined) return;
      if (scope === undefined) return sendError(reply, 400, 'PERSONAL_INSTRUCTION_INVALID');
      try {
        return reply.send({ instructions: await instructions.remove(actor.userId, scope) });
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
