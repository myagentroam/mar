import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool } from 'mysql2/promise';
import type { MarAgentModelService } from './mar-agent-model-service.js';
import { PromptCompletionSettings } from './prompt-completion-settings.js';
import { isAllowedOrigin } from './auth.js';
import { protectedManagementAdmin, validCsrf, type SessionLookup } from './session.js';
import { sendError } from './http-errors.js';

type PromptCompletionSettingsStore = SessionLookup & { readonly raw: Pool };

export function registerPromptCompletionSettingsRoutes(input: {
  readonly app: FastifyInstance;
  readonly databaseError: (reply: FastifyReply, error: unknown) => FastifyReply;
  readonly database: PromptCompletionSettingsStore;
  readonly models: Pick<MarAgentModelService, 'listManagedForUser'>;
  readonly publicOrigin: string | undefined;
}): void {
  const { app, database, databaseError, models, publicOrigin } = input;
  const settings = new PromptCompletionSettings(database.raw, models);

  app.get('/api/admin/mar-agent/prompt-completion', async (request, reply) => {
    const actor = protectedManagementAdmin(database, request, reply);
    if (actor === undefined) return;
    try {
      return reply
        .header('Cache-Control', 'private, no-store')
        .send({ configuration: await settings.readConfiguration() });
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.put<{ Body: unknown }>('/api/admin/mar-agent/prompt-completion', async (request, reply) => {
    const actor = writableManagementActor(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    try {
      return reply
        .header('Cache-Control', 'private, no-store')
        .send({ configuration: await settings.writeConfiguration(actor.userId, request.body) });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
}

function writableManagementActor(
  database: PromptCompletionSettingsStore,
  request: Parameters<typeof protectedManagementAdmin>[1],
  reply: Parameters<typeof protectedManagementAdmin>[2],
  publicOrigin: string | undefined
) {
  if (!isAllowedOrigin(request, publicOrigin)) {
    void sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    return undefined;
  }
  const actor = protectedManagementAdmin(database, request, reply);
  if (actor === undefined) return undefined;
  if (!validCsrf(request, actor)) {
    void sendError(reply, 403, 'CSRF_INVALID');
    return undefined;
  }
  return actor;
}
