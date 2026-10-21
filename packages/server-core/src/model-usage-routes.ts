import type { FastifyInstance } from 'fastify';
import { personalUsageQuerySchema, personalUsagePageSchema } from '@myagentroam/protocol';
import { currentSession, type SessionLookup } from './session.js';
import { sendError } from './http-errors.js';
import { ModelUsageQueryError, type ModelUsageQueryService } from './model-usage-query.js';

export function registerModelUsageRoutes(input: {
  app: FastifyInstance;
  database: SessionLookup;
  usage: ModelUsageQueryService;
}): void {
  for (const kind of ['overview', 'records'] as const) {
    input.app.get(`/api/me/usage/${kind}`, async (request, reply) => {
      const user = currentSession(input.database, request);
      if (!user || user.mustChangePassword) return sendError(reply, 401, 'UNAUTHENTICATED');
      const { cursor, page, ...query } = request.query as Record<string, unknown>;
      const parsed = personalUsageQuerySchema.safeParse(query);
      const parsedPage = page === undefined ? undefined : personalUsagePageSchema.safeParse(page);
      if (
        !parsed.success ||
        (cursor !== undefined && typeof cursor !== 'string') ||
        (parsedPage && !parsedPage.success) ||
        (page !== undefined && (kind !== 'records' || cursor !== undefined))
      )
        return sendError(reply, 400, 'USAGE_QUERY_INVALID', {
          message: 'The usage query is invalid.'
        });
      reply.header('Cache-Control', 'no-store');
      try {
        return kind === 'overview'
          ? await input.usage.overview(user.userId, parsed.data)
          : await input.usage.records(
              user.userId,
              parsed.data,
              cursor as string | undefined,
              parsedPage?.success ? parsedPage.data : undefined
            );
      } catch (error) {
        if (error instanceof ModelUsageQueryError)
          return sendError(reply, 400, error.code, { message: error.message });
        throw error;
      }
    });
  }
}
