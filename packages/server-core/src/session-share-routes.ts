import type {} from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import {
  sessionShareCreateInputSchema,
  sessionShareTargetSchema,
  sessionSharePasswordSchema,
  sessionShareVisitorSchema
} from '@myagentroam/protocol';
import { isAllowedOrigin, parseCookies, requestIp } from './auth.js';
import { currentSession, protectedAdmin, validCsrf, type SessionLookup } from './session.js';
import { databaseError } from './domain-errors.js';
import { sendError } from './http-errors.js';
import { isRateLimited, registerFailedLogin, type LoginRateRecord } from './login-rate.js';
import { parseWorkbenchPage } from './run-http-support.js';
import type { SessionRunStore, SessionRunNodeControl } from './session-run-contracts.js';
import type { SessionShares } from './session-shares.js';
import type { SessionChannelService } from './session-channel-service.js';
import type { ShareWorkbenchAccess } from './workbench-relay-service.js';
import type { UserNodeAuthorization } from './node-request-channel.js';
import { prepareRunnerProfileContext, type RunnerModelCatalog } from './runner-profile-context.js';
import type { ProcessSecretResolver } from './session-run-contracts.js';
import { registerSessionShareResourceRoutes } from './session-share-resource-routes.js';

export const SESSION_SHARE_COOKIE = 'mar_session_share';
const messageSchema = z
  .object({
    visitor: sessionShareVisitorSchema.required({ name: true }),
    clientMessageId: z.string().min(1).max(128),
    content: z.string().max(100_000),
    attachmentIds: z.array(z.string().uuid()).max(5).optional(),
    deliveryIntent: z.enum(['SEND', 'QUEUE', 'REPLACE_CURRENT']).optional(),
    model: z.string().min(1).optional(),
    computerUse: z.boolean().optional()
  })
  .strict()
  .refine((value) => value.content.length > 0 || (value.attachmentIds?.length ?? 0) > 0);

export function registerSessionShareRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: SessionRunStore;
  readonly shares: SessionShares;
  readonly channels: SessionChannelService;
  readonly nodeControl: SessionRunNodeControl;
  readonly publicOrigin: string | undefined;
  readonly secureCookies: boolean;
  readonly profiles?: {
    readonly secrets: ProcessSecretResolver;
    readonly models?: Partial<RunnerModelCatalog>;
  };
}): void {
  const { app, database, shares, channels, nodeControl, publicOrigin } = input;
  const attempts = new Map<string, LoginRateRecord>();
  type Params = { sessionId: string; shareId: string };
  type TargetQuery = { nodeId?: string; workspaceId?: string };
  app.get<{ Params: Params; Querystring: TargetQuery }>(
    '/api/agent-sessions/:sessionId/shares',
    async (request, reply) => {
      const user = protectedAdmin(database, request, reply);
      if (user === undefined) return;
      reply.header('cache-control', 'private, no-store');
      const target = sessionShareTargetSchema.safeParse({
        ...request.query,
        sessionId: request.params.sessionId
      });
      if (!target.success) return sendError(reply, 400, 'SESSION_SHARE_INPUT_INVALID');
      try {
        return reply.send({ shares: await shares.list(user.userId, target.data) });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.post<{ Params: Params; Body: unknown }>(
    '/api/agent-sessions/:sessionId/shares',
    async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const user = protectedAdmin(database, request, reply);
      if (user === undefined) return;
      if (!validCsrf(request, user)) return sendError(reply, 403, 'CSRF_INVALID');
      reply.header('cache-control', 'private, no-store');
      const parsed = sessionShareCreateInputSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, 'SESSION_SHARE_INPUT_INVALID');
      try {
        return reply.code(201).send(
          await shares.create(
            user,
            {
              nodeId: parsed.data.nodeId,
              workspaceId: parsed.data.workspaceId,
              sessionId: request.params.sessionId
            },
            parsed.data.expiresAt
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.post<{ Params: Params; Querystring: TargetQuery; Body: unknown }>(
    '/api/agent-sessions/:sessionId/shares/:shareId/copy',
    async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const user = protectedAdmin(database, request, reply);
      if (user === undefined) return;
      if (!validCsrf(request, user)) return sendError(reply, 403, 'CSRF_INVALID');
      reply.header('cache-control', 'private, no-store');
      const target = sessionShareTargetSchema.safeParse({
        ...request.query,
        sessionId: request.params.sessionId
      });
      const body = z
        .object({ password: sessionSharePasswordSchema.optional() })
        .strict()
        .safeParse(request.body);
      if (!target.success || !body.success)
        return sendError(reply, 400, 'SESSION_SHARE_INPUT_INVALID');
      try {
        return reply.send({
          password: await shares.copyPassword(
            user.userId,
            target.data,
            request.params.shareId,
            body.data.password
          )
        });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.delete<{ Params: Params; Querystring: TargetQuery }>(
    '/api/agent-sessions/:sessionId/shares/:shareId',
    async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const user = protectedAdmin(database, request, reply);
      if (user === undefined) return;
      if (!validCsrf(request, user)) return sendError(reply, 403, 'CSRF_INVALID');
      reply.header('cache-control', 'private, no-store');
      const target = sessionShareTargetSchema.safeParse({
        ...request.query,
        sessionId: request.params.sessionId
      });
      if (!target.success) return sendError(reply, 400, 'SESSION_SHARE_INPUT_INVALID');
      try {
        await shares.delete(user.userId, target.data, request.params.shareId);
        return reply.code(204).send();
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  void app.register(
    async (scope) => {
      type ShareRequest = FastifyRequest<{ Params: { shareId: string } }>;
      const resolved = new WeakMap<FastifyRequest, Awaited<ReturnType<SessionShares['resolve']>>>();
      const authorize = async (request: ShareRequest) => {
        resolved.set(
          request,
          await shares.resolve(request.params.shareId, parseCookies(request)[SESSION_SHARE_COOKIE])
        );
      };
      scope.addHook('onRequest', async (request, reply) => {
        reply.header('cache-control', 'private, no-store');
        if (!isAllowedOrigin(request, publicOrigin))
          return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      });
      scope.setErrorHandler((error, _request, reply) => databaseError(reply, error));
      registerSessionShareResourceRoutes({
        app: scope,
        nodeControl,
        resolve: (request) =>
          shares.resolve(request.params.shareId, parseCookies(request)[SESSION_SHARE_COOKIE])
      });
      scope.post<{ Params: { shareId: string }; Body: unknown }>(
        '/auth',
        async (request, reply) => {
          const key = request.params.shareId + ':' + requestIp(request);
          if (isRateLimited(attempts, key, Date.now()))
            return sendError(reply, 429, 'SESSION_SHARE_RATE_LIMITED');
          try {
            const result = await shares.authenticate(request.params.shareId, request.body);
            reply.header(
              'set-cookie',
              `${SESSION_SHARE_COOKIE}=${result.credential}; Path=/api/session-shares/${encodeURIComponent(result.share.id)}/; HttpOnly; SameSite=Strict${input.secureCookies ? '; Secure' : ''}`
            );
            return reply.send(result);
          } catch (error) {
            registerFailedLogin(attempts, key, Date.now());
            throw error;
          }
        }
      );
      scope.post<{ Params: { shareId: string }; Body: unknown }>(
        '/messages',
        { preHandler: authorize },
        async (request, reply) => {
          const parsed = messageSchema.safeParse(request.body);
          if (!parsed.success) return sendError(reply, 400, 'MESSAGE_INVALID');
          const session = resolved.get(request)!;
          const { visitor, ...message } = parsed.data;
          const result = await channels.submitMessage(session.context, {
            origin: {
              source: 'WEB_SHARE',
              channelId: session.record.id,
              senderId: visitor.visitorId,
              name: visitor.name
            },
            message: {
              clientMessageId: message.clientMessageId,
              content: message.content,
              ...(message.attachmentIds === undefined
                ? {}
                : { attachmentIds: message.attachmentIds }),
              ...(message.deliveryIntent === undefined
                ? {}
                : { deliveryIntent: message.deliveryIntent }),
              ...(message.model === undefined ? {} : { model: message.model }),
              ...(message.computerUse === undefined ? {} : { computerUse: message.computerUse })
            }
          });
          return reply.code(202).send(result);
        }
      );
      scope.get<{ Params: { shareId: string } }>(
        '/session',
        { preHandler: authorize },
        async (request, reply) => {
          const { context } = resolved.get(request)!;
          return reply.send(
            await nodeControl.requestNode(
              context.nodeId,
              'session.get',
              { sessionId: context.sessionId, workspaceId: context.workspaceId },
              { ...context.user, workspaceId: context.workspaceId }
            )
          );
        }
      );
      scope.get<{ Params: { shareId: string } }>(
        '/profiles',
        { preHandler: authorize },
        async (request, reply) => {
          const { context } = resolved.get(request)!;
          if (input.profiles === undefined) throw new Error('RUNNER_PROFILES_UNAVAILABLE');
          const profileContext = await prepareRunnerProfileContext({
            userId: context.user.userId,
            nodeId: context.nodeId,
            workspaceId: context.workspaceId,
            ...input.profiles
          });
          return reply.send(
            await nodeControl.requestNode(
              context.nodeId,
              'runner.profiles.list',
              { workspaceId: context.workspaceId, ...profileContext },
              { ...context.user, workspaceId: context.workspaceId }
            )
          );
        }
      );
      scope.post<{ Params: { shareId: string } }>(
        '/interrupt',
        { preHandler: authorize },
        async (request, reply) => {
          return reply.code(202).send(await channels.interrupt(resolved.get(request)!.context));
        }
      );
      scope.post<{ Params: { shareId: string }; Body: unknown }>(
        '/commands',
        { preHandler: authorize },
        async (request, reply) => {
          // Only context compaction is an input-surface action. History and permission controls stay in Console.
          const parsed = z
            .object({
              commandId: z.literal('compact'),
              input: z.string().min(2).max(20_000),
              model: z.string().min(1).optional()
            })
            .strict()
            .safeParse(request.body);
          if (!parsed.success) return sendError(reply, 400, 'RUNNER_COMMAND_INVALID');
          const { commandId, input: commandInput, model } = parsed.data;
          return reply.code(202).send(
            await channels.executeCommand(resolved.get(request)!.context, {
              commandId,
              input: commandInput,
              ...(model === undefined ? {} : { model })
            })
          );
        }
      );
      scope.route<{
        Params: { shareId: string };
        Body: { workbenchConnectionId?: string; watchId?: string; mode?: string; unit?: string };
      }>({
        method: ['POST', 'DELETE'],
        url: '/watch',
        preHandler: authorize,
        handler: async (request, reply) => {
          const { context } = resolved.get(request)!;
          const body = request.body;
          if (
            typeof body?.workbenchConnectionId !== 'string' ||
            !nodeControl.ownsWorkbenchConnection(
              context.user.sessionHash,
              body.workbenchConnectionId
            ) ||
            typeof body.watchId !== 'string' ||
            !/^[A-Za-z0-9_-]{8,128}$/u.test(body.watchId) ||
            (request.method === 'POST' && body.mode !== 'initial' && body.mode !== 'renew') ||
            (body.unit !== undefined && body.unit !== 'SEGMENT')
          )
            return sendError(reply, 400, 'SESSION_WATCH_INVALID');
          const result = await nodeControl.requestNode(
            context.nodeId,
            request.method === 'DELETE' ? 'session.unwatch' : 'session.watch',
            {
              sessionId: context.sessionId,
              workspaceId: context.workspaceId,
              workbenchConnectionId: body.workbenchConnectionId,
              watchId: body.watchId,
              ...(request.method === 'DELETE' ? {} : { mode: body.mode }),
              ...(body.unit === undefined ? {} : { unit: body.unit })
            },
            { ...context.user, workspaceId: context.workspaceId }
          );
          return body.mode === 'renew' ? reply.code(204).send() : reply.send(result);
        }
      });
      scope.get<{
        Params: { shareId: string };
        Querystring: { cursor?: string; after?: string; limit?: string; unit?: string };
      }>('/turns', { preHandler: authorize }, async (request, reply) => {
        const page = parseWorkbenchPage(request.query);
        if (
          page === undefined ||
          (request.query.unit !== undefined && request.query.unit !== 'SEGMENT')
        )
          return sendError(reply, 400, 'EVENT_CURSOR_INVALID');
        const { context } = resolved.get(request)!;
        return reply.send(
          await nodeControl.requestNode(
            context.nodeId,
            'session.turns.list',
            {
              ...page,
              sessionId: context.sessionId,
              workspaceId: context.workspaceId,
              ...(request.query.unit === undefined ? {} : { unit: request.query.unit })
            },
            { ...context.user, workspaceId: context.workspaceId }
          )
        );
      });
    },
    { prefix: '/api/session-shares/:shareId' }
  );
}

/** Installed by the host in the same scope as its sole WebSocket plugin. */
export function registerSessionShareRealtimeRoute(input: {
  app: FastifyInstance;
  database: SessionLookup;
  shares: SessionShares;
  publicOrigin: string | undefined;
  attach: (socket: WebSocket, user: UserNodeAuthorization, access: ShareWorkbenchAccess) => void;
}): void {
  const { shares } = input;
  type ShareRequest = FastifyRequest<{ Params: { shareId: string } }>;
  const resolved = new WeakMap<FastifyRequest, Awaited<ReturnType<SessionShares['resolve']>>>();
  const accounts = new WeakMap<FastifyRequest, { userId: number; name: string }>();
  async function authorize(
    request: ShareRequest,
    reply: import('fastify').FastifyReply
  ): Promise<void> {
    if (!isAllowedOrigin(request, input.publicOrigin)) {
      sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      return;
    }
    try {
      resolved.set(
        request,
        await shares.resolve(request.params.shareId, parseCookies(request)[SESSION_SHARE_COOKIE])
      );
      const user = currentSession(input.database, request);
      if (user !== undefined && !user.mustChangePassword) {
        const account = await shares.participant(user.userId);
        if (account !== undefined) accounts.set(request, account);
      }
    } catch (error) {
      databaseError(reply, error);
    }
  }
  input.app.get<{ Params: { shareId: string }; Querystring: { visitorId?: string } }>(
    '/api/session-shares/:shareId/live',
    { websocket: true, preValidation: authorize },
    (socket, request) => {
      const session = resolved.get(request)!;
      const visitor = sessionShareVisitorSchema.safeParse({ visitorId: request.query.visitorId });
      if (!visitor.success) {
        socket.close(4002, 'SESSION_SHARE_INPUT_INVALID');
        return;
      }
      input.attach(socket, session.context.user, {
        shareId: session.record.id,
        ownerUserId: session.record.userId,
        ...(accounts.has(request) ? { account: accounts.get(request)! } : {}),
        target: {
          nodeId: session.context.nodeId,
          workspaceId: session.context.workspaceId,
          sessionId: session.context.sessionId
        },
        expiresAt: session.record.expiresAt,
        visitor: visitor.data,
        validate: async () => {
          try {
            await shares.resolve(session.record.id, session.record.credential);
            return true;
          } catch {
            return false;
          }
        }
      });
    }
  );
}
