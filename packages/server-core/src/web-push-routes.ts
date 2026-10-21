import type { FastifyInstance } from 'fastify';
import { webPushClientRequestSchema, webPushClientResolveSchema } from '@myagentroam/protocol';
import { isAllowedOrigin } from './auth.js';
import { currentSession, validCsrf, type SessionLookup } from './session.js';
import { sendError } from './http-errors.js';
import { databaseError } from './domain-errors.js';
import type { WebPushClients } from './web-push-clients.js';
import type { WebPushConfiguration } from './web-push-configuration.js';

export function registerWebPushRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: SessionLookup;
  readonly clients: Pick<WebPushClients, 'register' | 'inspect'>;
  readonly configuration: Pick<WebPushConfiguration, 'read'>;
  readonly publicOrigin: string | undefined;
  readonly now?: () => number;
}): void {
  const attempts = new Map<number, { readonly started: number; count: number }>();
  const now = input.now ?? Date.now;
  function admit(userId: number): boolean {
    const timestamp = now();
    for (const [id, attempt] of attempts)
      if (timestamp - attempt.started >= 60_000) attempts.delete(id);
    const attempt = attempts.get(userId);
    if ((attempt?.count ?? 0) >= 30 || (attempt === undefined && attempts.size >= 2048))
      return false;
    if (attempt === undefined) attempts.set(userId, { started: timestamp, count: 1 });
    else attempt.count++;
    return true;
  }
  input.app.get('/api/notifications/push', async (request, reply) => {
    const user = currentSession(input.database, request);
    if (user === undefined || user.mustChangePassword)
      return sendError(reply, 401, 'UNAUTHENTICATED');
    try {
      return reply.send({ ...(await input.configuration.read()), account: user.username });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  input.app.post<{ Body: unknown }>(
    '/api/notifications/push/clients/resolve',
    { bodyLimit: 512 },
    async (request, reply) => {
      if (!isAllowedOrigin(request, input.publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const user = currentSession(input.database, request);
      if (user === undefined || user.mustChangePassword)
        return sendError(reply, 401, 'UNAUTHENTICATED');
      if (!validCsrf(request, user)) return sendError(reply, 403, 'CSRF_INVALID');
      const parsed = webPushClientResolveSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, 'WEB_PUSH_INPUT_INVALID');
      if (parsed.data.expectedAccount !== user.username)
        return sendError(reply, 409, 'WEB_PUSH_SESSION_INVALID');
      if (!admit(user.userId)) return sendError(reply, 429, 'WEB_PUSH_RATE_LIMITED');
      try {
        return reply.send({
          binding: (await input.clients.inspect(user, parsed.data.clientToken)) ?? null
        });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  input.app.post<{ Body: unknown }>(
    '/api/notifications/push/clients',
    { bodyLimit: 4096 },
    async (request, reply) => {
      if (!isAllowedOrigin(request, input.publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const user = currentSession(input.database, request);
      if (user === undefined || user.mustChangePassword)
        return sendError(reply, 401, 'UNAUTHENTICATED');
      if (!validCsrf(request, user)) return sendError(reply, 403, 'CSRF_INVALID');
      const parsed = webPushClientRequestSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, 'WEB_PUSH_INPUT_INVALID');
      if (parsed.data.expectedAccount !== user.username)
        return sendError(reply, 409, 'WEB_PUSH_SESSION_INVALID');
      if (!admit(user.userId)) return sendError(reply, 429, 'WEB_PUSH_RATE_LIMITED');
      try {
        if (parsed.data.enabled) {
          const capability = await input.configuration.read();
          if (!capability.enabled || !capability.available)
            return sendError(reply, 409, 'WEB_PUSH_DISABLED');
        }
        const { expectedAccount: _expected, ...registration } = parsed.data;
        return reply.send({
          ...(await input.clients.register(user, registration)),
          account: user.username
        });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
}
