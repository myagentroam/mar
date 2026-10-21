import type { FastifyInstance } from 'fastify';
import { isAllowedOrigin } from './auth.js';
import type { SessionLookup } from './session.js';
import type { WorkbenchNotificationService } from './workbench-notification-service.js';
import type { RecentRunService } from './recent-run-service.js';
import { currentSession, validCsrf } from './session.js';
import { sendError } from './http-errors.js';

export function registerNotificationRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: SessionLookup;
  readonly notifications: WorkbenchNotificationService;
  readonly recentRuns?: RecentRunService;
  readonly publicOrigin: string | undefined;
}): void {
  const { app, database, notifications, recentRuns, publicOrigin } = input;
  app.get('/api/notifications', async (request, reply) => {
    const user = currentSession(database, request);
    if (user === undefined || user.mustChangePassword)
      return sendError(reply, 401, 'UNAUTHENTICATED');
    const [notificationItems, runItems] = await Promise.all([
      notifications.list(user.userId),
      recentRuns?.list(user.userId) ?? Promise.resolve([])
    ]);
    return reply.send({ notifications: notificationItems, recentRuns: runItems });
  });
  app.post<{ Params: { id: string } }>('/api/notifications/:id/read', async (request, reply) => {
    const user = writable(request, reply);
    if (user === undefined) return;
    await notifications.markRead(user.userId, request.params.id);
    return reply.code(204).send();
  });
  app.post<{ Body: unknown }>('/api/notifications/session/read', async (request, reply) => {
    const user = writable(request, reply);
    if (user === undefined) return;
    const body = request.body as Record<string, unknown> | null;
    if (
      body === null ||
      typeof body !== 'object' ||
      typeof body.nodeId !== 'string' ||
      typeof body.workspaceId !== 'string' ||
      typeof body.sessionId !== 'string'
    )
      return sendError(reply, 400, 'NOTIFICATION_TARGET_INVALID');
    await notifications.markSessionRead(user.userId, body.nodeId, body.workspaceId, body.sessionId);
    return reply.code(204).send();
  });
  app.post<{ Body: unknown }>('/api/notifications/conversation/read', async (request, reply) => {
    const user = writable(request, reply);
    if (user === undefined) return;
    const body = request.body as Record<string, unknown> | null;
    if (
      body === null ||
      typeof body !== 'object' ||
      typeof body.nodeId !== 'string' ||
      typeof body.conversationId !== 'string'
    )
      return sendError(reply, 400, 'NOTIFICATION_TARGET_INVALID');
    await notifications.markConversationRead(user.userId, body.nodeId, body.conversationId);
    return reply.code(204).send();
  });
  app.post('/api/notifications/read-all', async (request, reply) => {
    const user = writable(request, reply);
    if (user === undefined) return;
    await notifications.markAllRead(user.userId);
    return reply.code(204).send();
  });
  app.delete<{ Params: { id: string } }>('/api/notifications/:id', async (request, reply) => {
    const user = writable(request, reply);
    if (user === undefined) return;
    await notifications.remove(user.userId, request.params.id);
    return reply.code(204).send();
  });

  function writable(
    request: Parameters<typeof currentSession>[1],
    reply: Parameters<typeof sendError>[0]
  ) {
    if (!isAllowedOrigin(request, publicOrigin)) {
      void sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      return undefined;
    }
    const user = currentSession(database, request);
    if (user === undefined || user.mustChangePassword) {
      void sendError(reply, 401, 'UNAUTHENTICATED');
      return undefined;
    }
    if (!validCsrf(request, user)) {
      void sendError(reply, 403, 'CSRF_INVALID');
      return undefined;
    }
    return user;
  }
}
