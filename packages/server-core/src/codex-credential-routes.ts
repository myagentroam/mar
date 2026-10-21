import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isAllowedOrigin } from './auth.js';
import type { SessionLookup } from './session.js';
import type { CodexCredentialService } from './codex-credential-service.js';
import type { MarAgentModelService } from './mar-agent-model-service.js';
import { currentSession, protectedAdmin, validCsrf } from './session.js';
import { errorResponseOptions, safePublicError, sendError } from './http-errors.js';
import type { SessionRunNodeControl } from './session-run-contracts.js';

export function registerCodexCredentialRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: SessionLookup;
  readonly credentials: CodexCredentialService;
  readonly models: MarAgentModelService;
  readonly nodeControl?: Pick<SessionRunNodeControl, 'requestNode'>;
  readonly publicOrigin?: string;
}): void {
  const { app, database, credentials, models, publicOrigin } = input;
  if (input.nodeControl) {
    credentials.configureChatgptLogin((actor, nodeId, operation, data) =>
      input.nodeControl!.requestNode(
        nodeId,
        operation,
        data,
        { userId: actor.userId, sessionHash: actor.sessionFingerprint },
        45_000
      )
    );
  }
  app.addHook('onClose', async () => {
    credentials.closeChatgptLogins();
  });
  app.post<{ Body: unknown }>(
    '/api/admin/mar-agent/codex-login-attempts',
    async (request, reply) => {
      const actor = writable(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        return reply
          .header('cache-control', 'private, no-store')
          .code(201)
          .send({
            attempt: await credentials.startLogin(loginActor(actor), request.body)
          });
      } catch (error) {
        return codexError(reply, error);
      }
    }
  );
  app.get<{ Params: { attemptId: string } }>(
    '/api/admin/mar-agent/codex-login-attempts/:attemptId',
    async (request, reply) => {
      const actor = readable(database, request, reply);
      if (actor === undefined) return;
      try {
        return reply.header('cache-control', 'private, no-store').send({
          attempt: await credentials.loginAttempt(
            loginActor(actor),
            request.params.attemptId,
            () => {
              const current = currentSession(database, request);
              if (
                current?.userId !== actor.userId ||
                current.sessionHash !== actor.sessionHash ||
                current.mustChangePassword
              )
                throw new Error('CHATGPT_LOGIN_FORBIDDEN');
            }
          )
        });
      } catch (error) {
        return codexError(reply, error);
      }
    }
  );
  app.delete<{ Params: { attemptId: string } }>(
    '/api/admin/mar-agent/codex-login-attempts/:attemptId',
    async (request, reply) => {
      const actor = writable(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        await credentials.cancelLogin(loginActor(actor), request.params.attemptId);
        return reply.code(204).send();
      } catch (error) {
        return codexError(reply, error);
      }
    }
  );
  app.get('/api/admin/mar-agent/codex-credentials', async (request, reply) => {
    const actor = readable(database, request, reply);
    if (actor === undefined) return;
    try {
      return reply.send({ credentials: await credentials.list(actor.userId) });
    } catch (error) {
      return codexError(reply, error);
    }
  });
  app.get<{ Params: { credentialId: string } }>(
    '/api/admin/mar-agent/codex-credentials/:credentialId',
    async (request, reply) => {
      const actor = readable(database, request, reply);
      if (actor === undefined) return;
      try {
        return reply
          .header('cache-control', 'private, no-store')
          .send({ details: await credentials.details(actor.userId, request.params.credentialId) });
      } catch (error) {
        return codexError(reply, error);
      }
    }
  );
  app.get<{ Params: { credentialId: string } }>(
    '/api/admin/mar-agent/codex-credentials/:credentialId/usage',
    async (request, reply) => {
      const actor = readable(database, request, reply);
      if (actor === undefined) return;
      try {
        return reply
          .header('cache-control', 'private, no-store')
          .send({ usage: await credentials.usage(actor.userId, request.params.credentialId) });
      } catch (error) {
        return codexError(reply, error);
      }
    }
  );
  app.patch<{ Params: { credentialId: string }; Body: unknown }>(
    '/api/admin/mar-agent/codex-credentials/:credentialId',
    async (request, reply) => {
      const actor = writable(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        return reply.send({
          credential: await credentials.update(
            actor.userId,
            request.params.credentialId,
            request.body
          )
        });
      } catch (error) {
        return codexError(reply, error);
      }
    }
  );
  app.delete<{ Params: { credentialId: string } }>(
    '/api/admin/mar-agent/codex-credentials/:credentialId',
    async (request, reply) => {
      const actor = writable(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        return reply.send(await credentials.remove(actor.userId, request.params.credentialId));
      } catch (error) {
        return codexError(reply, error);
      }
    }
  );
  app.post<{ Params: { credentialId: string } }>(
    '/api/admin/mar-agent/codex-credentials/:credentialId/refresh',
    async (request, reply) => {
      const actor = writable(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        return reply.send({
          credential: await credentials.refresh(actor.userId, request.params.credentialId)
        });
      } catch (error) {
        return codexError(reply, error);
      }
    }
  );
  app.post<{ Params: { credentialId: string } }>(
    '/api/admin/mar-agent/codex-credentials/:credentialId/test',
    async (request, reply) => {
      const actor = writable(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        return reply.send({
          result: await credentials.test(actor.userId, request.params.credentialId)
        });
      } catch (error) {
        return codexError(reply, error);
      }
    }
  );
  app.post<{ Params: { credentialId: string } }>(
    '/api/admin/mar-agent/codex-credentials/:credentialId/models/load',
    async (request, reply) => {
      const actor = writable(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        return reply.send({
          catalog: await credentials.loadCatalog(actor.userId, request.params.credentialId)
        });
      } catch (error) {
        return codexError(reply, error);
      }
    }
  );
  app.post<{ Params: { credentialId: string }; Body: unknown }>(
    '/api/admin/mar-agent/codex-credentials/:credentialId/models/import',
    async (request, reply) => {
      const actor = writable(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        const catalog = await credentials.loadCatalog(actor.userId, request.params.credentialId);
        return reply.send({
          result: await models.importCodexModels(
            actor.userId,
            request.params.credentialId,
            catalog,
            request.body
          )
        });
      } catch (error) {
        return codexError(reply, error);
      }
    }
  );
}

function readable(database: SessionLookup, request: FastifyRequest, reply: FastifyReply) {
  return protectedAdmin(database, request, reply);
}

function writable(
  database: SessionLookup,
  request: FastifyRequest,
  reply: FastifyReply,
  publicOrigin: string | undefined
) {
  if (!isAllowedOrigin(request, publicOrigin)) {
    void sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    return undefined;
  }
  const actor = readable(database, request, reply);
  if (actor === undefined) return undefined;
  if (!validCsrf(request, actor)) {
    void sendError(reply, 403, 'CSRF_INVALID');
    return undefined;
  }
  return actor;
}

function loginActor(actor: { readonly userId: number; readonly sessionHash: string }) {
  return {
    userId: actor.userId,
    sessionFingerprint: actor.sessionHash
  };
}

function codexError(reply: FastifyReply, error: unknown): FastifyReply {
  const failure = safePublicError(error);
  const code = failure.code;
  const status =
    code === 'CODEX_CREDENTIAL_NOT_FOUND' || code === 'CODEX_LOGIN_ATTEMPT_NOT_FOUND'
      ? 404
      : code === 'CODEX_CREDENTIAL_IN_USE' ||
          code === 'CODEX_CREDENTIAL_NAME_CONFLICT' ||
          code === 'CODEX_CATALOG_CHANGED' ||
          code === 'CODEX_CREDENTIAL_SCOPE_CONFLICT' ||
          code === 'XAI_LOGIN_CONFLICT'
        ? 409
        : code === 'CODEX_CREDENTIAL_SCOPE_FORBIDDEN' || code === 'XAI_ENTITLEMENT_REQUIRED'
          ? 403
          : code === 'CODEX_USAGE_RATE_LIMITED' || code === 'XAI_USAGE_RATE_LIMITED'
            ? 429
            : code === 'CODEX_DEVICE_AUTH_UNAVAILABLE' ||
                code === 'CODEX_CATALOG_LOAD_FAILED' ||
                code === 'CODEX_CREDENTIAL_CHECK_FAILED' ||
                code === 'CODEX_CREDENTIAL_REFRESH_TRANSIENT' ||
                code === 'CODEX_USAGE_LOAD_FAILED' ||
                code === 'CODEX_USAGE_RESPONSE_INVALID' ||
                code === 'XAI_DEVICE_AUTH_UNAVAILABLE' ||
                code === 'XAI_REQUEST_FAILED' ||
                code === 'XAI_REFRESH_FAILED' ||
                code === 'XAI_RESPONSE_INVALID' ||
                code === 'XAI_USAGE_LOAD_FAILED' ||
                code === 'XAI_CATALOG_LOAD_FAILED'
              ? 502
              : code === 'INTERNAL_ERROR'
                ? 500
                : 400;
  return sendError(reply, status, code, errorResponseOptions(failure));
}
