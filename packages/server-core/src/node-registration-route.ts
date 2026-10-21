import type { FastifyInstance, FastifyReply } from 'fastify';
import { resourceOwnershipSchema, type ResourceOwnership } from '@myagentroam/protocol';
import { isAllowedOrigin } from './auth.js';
import { protectedAdmin, validCsrf, type SessionLookup } from './session.js';
import { sendError } from './http-errors.js';
export function registerNodeRegistrationRoute(input: {
  readonly app: FastifyInstance;
  readonly sessions: SessionLookup;
  readonly publicOrigin: string | undefined;
  readonly requireDisplayName: boolean;
  readonly authorize: (userId: number, ownership: ResourceOwnership) => void | Promise<void>;
  readonly createToken: (
    userId: number,
    ttlMs: number,
    ownership: ResourceOwnership,
    displayName: string | null
  ) => { token: string; expiresAt: number } | Promise<{ token: string; expiresAt: number }>;
  readonly onError: (reply: FastifyReply, error: unknown) => FastifyReply;
}): void {
  const { app, sessions, publicOrigin, requireDisplayName, authorize, createToken, onError } =
    input;
  app.post<{ Body: { ttlMs?: unknown; ownership?: unknown; displayName?: unknown } }>(
    '/api/node-registration-tokens',
    async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin)) {
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      }
      const admin = protectedAdmin(sessions, request, reply);
      if (admin === undefined) return;
      if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
      const requestedTtl = request.body?.ttlMs;
      const displayName = request.body?.displayName;
      const ttlMs =
        typeof requestedTtl === 'number' && Number.isSafeInteger(requestedTtl)
          ? Math.min(Math.max(requestedTtl, 60_000), 24 * 60 * 60 * 1000)
          : undefined;
      const ownership =
        request.body?.ownership === undefined
          ? { ownerType: 'PERSONAL' as const, ownerUserId: admin.userId }
          : resourceOwnershipSchema.safeParse(request.body.ownership).data;
      if (ownership === undefined) return sendError(reply, 400, 'RESOURCE_OWNERSHIP_INVALID');
      if (
        (requireDisplayName || displayName !== undefined) &&
        (typeof displayName !== 'string' ||
          displayName.trim().length === 0 ||
          displayName.trim().length > 128)
      )
        return sendError(reply, 400, 'NODE_DISPLAY_NAME_INVALID');
      try {
        await authorize(admin.userId, ownership);
        return reply.send(
          await createToken(
            admin.userId,
            ttlMs ?? 10 * 60 * 1000,
            ownership,
            typeof displayName === 'string' ? displayName.trim() : null
          )
        );
      } catch (error) {
        return onError(reply, error);
      }
    }
  );
}
