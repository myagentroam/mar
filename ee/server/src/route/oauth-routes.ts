import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { oauthProviderInputSchema } from '@myagentroam/protocol';
import {
  isAllowedOrigin,
  parseCookies,
  requestIp,
  serializeSessionCookie
} from '@myagentroam/server-core/auth';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { OAuthService } from '../oauth/oauth-service.js';
import type { NodeControl } from '../node-control.js';
import type { WorkbenchNotificationService } from '../service/workbench-notification-service.js';
import {
  boundedUserAgent,
  currentSession,
  databaseError,
  isNonEmptyString,
  protectedAdmin,
  safeErrorCode,
  sendError,
  validCsrf
} from '../util/http-request.js';

export function registerOAuthRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: MysqlServerDatabase;
  readonly oauth: OAuthService;
  readonly nodeControl: NodeControl;
  readonly publicOrigin: string | undefined;
  readonly secureCookies: boolean;
  readonly notifications?: WorkbenchNotificationService;
}): void {
  const { app, database, oauth, nodeControl, publicOrigin, secureCookies, notifications } = input;

  app.get('/api/oauth/providers', async (_request, reply) =>
    reply.send({ providers: await oauth.enabledProviders() })
  );

  app.get('/api/oauth-bindings', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (actor === undefined) return;
    return reply.send({ bindings: await oauth.bindings(actor.userId) });
  });

  app.post<{ Params: { providerKey: string } }>(
    '/api/oauth-bindings/:providerKey/begin',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        const flow = await oauth.begin(
          request.params.providerKey,
          callbackUri(request, request.params.providerKey, publicOrigin),
          actor.userId
        );
        reply.header(
          'Set-Cookie',
          serializeFlowCookie(request.params.providerKey, flow.browserFlowId, secureCookies)
        );
        return reply.send({ authorizationUrl: flow.authorizationUrl });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.delete<{ Params: { providerKey: string } }>(
    '/api/oauth-bindings/:providerKey',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        await oauth.removeBinding(actor.userId, request.params.providerKey);
        await database.audit({
          eventType: 'oauth_identity_unbound',
          actorUserId: actor.userId,
          authenticationMethod: 'PASSWORD',
          providerId: request.params.providerKey,
          result: 'SUCCESS'
        });
        return reply.code(204).send();
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.get('/api/oauth-providers', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (actor === undefined) return;
    try {
      return reply.send({ providers: await oauth.list(actor.userId) });
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.post<{ Body: unknown }>('/api/oauth-providers', async (request, reply) => {
    const actor = writableActor(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    const parsed = oauthProviderInputSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'OAUTH_PROVIDER_INVALID');
    try {
      return reply.code(201).send({ provider: await oauth.create(actor.userId, parsed.data) });
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.put<{ Params: { providerKey: string }; Body: unknown }>(
    '/api/oauth-providers/:providerKey',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      const parsed = oauthProviderInputSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, 'OAUTH_PROVIDER_INVALID');
      try {
        return reply.send({
          provider: await oauth.update(actor.userId, request.params.providerKey, parsed.data)
        });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.delete<{ Params: { providerKey: string } }>(
    '/api/oauth-providers/:providerKey',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        await oauth.remove(actor.userId, request.params.providerKey);
        return reply.code(204).send();
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.post<{ Params: { providerKey: string } }>(
    '/api/oauth-providers/:providerKey/test',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        await oauth.test(actor.userId, request.params.providerKey);
        return reply.code(204).send();
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.post<{ Params: { providerKey: string }; Body: { enabled?: unknown } }>(
    '/api/oauth-providers/:providerKey/enabled',
    async (request, reply) => {
      const actor = writableActor(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      if (typeof request.body?.enabled !== 'boolean')
        return sendError(reply, 400, 'OAUTH_PROVIDER_ENABLED_INVALID');
      try {
        await oauth.setEnabled(actor.userId, request.params.providerKey, request.body.enabled);
        return reply.code(204).send();
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.get<{ Params: { providerKey: string }; Querystring: { locale?: string } }>(
    '/api/oauth/:providerKey/login',
    async (request, reply) => {
      if (!validProviderKey(request.params.providerKey))
        return redirectOAuthCallbackFailure(reply, 'LOGIN', 'OAUTH_PROVIDER_INVALID');
      try {
        const redirectUri = callbackUri(request, request.params.providerKey, publicOrigin);
        const flow = await oauth.begin(request.params.providerKey, redirectUri);
        reply.header('Set-Cookie', [
          serializeFlowCookie(request.params.providerKey, flow.browserFlowId, secureCookies),
          serializeLocaleCookie(request.query.locale === 'en-US' ? 'en-US' : 'zh-CN', secureCookies)
        ]);
        return reply.redirect(flow.authorizationUrl);
      } catch (error) {
        return redirectOAuthCallbackFailure(reply, 'LOGIN', safeErrorCode(error));
      }
    }
  );

  app.get<{
    Params: { providerKey: string };
    Querystring: { state?: string; code?: string; error?: string };
  }>('/api/oauth/:providerKey/callback', async (request, reply) => {
    const { providerKey } = request.params;
    if (!validProviderKey(providerKey))
      return redirectOAuthCallbackFailure(reply, 'LOGIN', 'OAUTH_PROVIDER_INVALID');
    const browserFlowId = parseCookies(request)[flowCookieName(providerKey)];
    const flowType = browserFlowId?.startsWith('BIND.') ? 'BIND' : 'LOGIN';
    if (
      request.query.error !== undefined ||
      !isNonEmptyString(request.query.state) ||
      !isNonEmptyString(request.query.code)
    )
      return oauthCallbackFailure(
        reply,
        providerKey,
        secureCookies,
        flowType,
        'OAUTH_CALLBACK_INVALID'
      );
    if (browserFlowId === undefined)
      return oauthCallbackFailure(
        reply,
        providerKey,
        secureCookies,
        'LOGIN',
        'OAUTH_STATE_INVALID'
      );
    if (browserFlowId.startsWith('BIND.')) {
      const actor = currentSession(database, request);
      if (actor === undefined)
        return oauthCallbackFailure(reply, providerKey, secureCookies, 'LOGIN', 'UNAUTHENTICATED');
      if (actor.mustChangePassword)
        return oauthCallbackFailure(
          reply,
          providerKey,
          secureCookies,
          'LOGIN',
          'PASSWORD_CHANGE_REQUIRED'
        );
      const bindingUserId = Number(/^BIND\.([1-9][0-9]*)\./.exec(browserFlowId)?.[1]);
      if (!Number.isSafeInteger(bindingUserId) || bindingUserId !== actor.userId)
        return oauthCallbackFailure(
          reply,
          providerKey,
          secureCookies,
          'BIND',
          'OAUTH_BINDING_USER_MISMATCH'
        );
    }
    try {
      const result = await oauth.callback({
        providerKey,
        state: request.query.state,
        code: request.query.code,
        browserFlowId,
        redirectUri: callbackUri(request, providerKey, publicOrigin)
      });
      if (result.flowType === 'BIND') {
        await database.audit({
          eventType: 'oauth_identity_bound',
          actorUserId: result.userId,
          authenticationMethod: 'OAUTH2',
          providerId: providerKey,
          result: 'SUCCESS'
        });
        reply.header('Set-Cookie', clearFlowCookie(providerKey, secureCookies));
        return reply.redirect('/console?view=settings&settings=account&oauthBinding=success');
      }
      const userId = result.userId;
      await notifications?.setLocale(
        userId,
        oauthLocale(parseCookies(request)['mar_oauth_locale'])
      );
      const session = await database.createUserSession(userId, {
        ipAddress: requestIp(request),
        userAgent: boundedUserAgent(request.headers['user-agent'])
      });
      for (const sessionHash of session.evictedSessionHashes) {
        nodeControl.closeUserTerminals(sessionHash);
        nodeControl.closeUserWorkbench(sessionHash);
      }
      await database.audit({
        eventType: 'login_succeeded',
        actorUserId: userId,
        authenticationMethod: 'OAUTH2',
        providerId: providerKey,
        ipAddress: requestIp(request),
        result: 'SUCCESS'
      });
      reply.header('Set-Cookie', [
        serializeSessionCookie(session.sessionId, secureCookies),
        clearFlowCookie(providerKey, secureCookies),
        clearLocaleCookie(secureCookies)
      ]);
      return reply.redirect('/console');
    } catch (error) {
      return oauthCallbackFailure(
        reply,
        providerKey,
        secureCookies,
        flowType,
        safeErrorCode(error)
      );
    }
  });
}

function oauthCallbackFailure(
  reply: Parameters<typeof redirectOAuthCallbackFailure>[0],
  providerKey: string,
  secureCookies: boolean,
  flowType: 'LOGIN' | 'BIND',
  code: string
) {
  reply.header('Set-Cookie', clearFlowCookie(providerKey, secureCookies));
  return redirectOAuthCallbackFailure(reply, flowType, code);
}

function redirectOAuthCallbackFailure(
  reply: FastifyReply,
  flowType: 'LOGIN' | 'BIND',
  code: string
) {
  const query = new URLSearchParams();
  if (flowType === 'BIND') {
    query.set('view', 'settings');
    query.set('settings', 'account');
  }
  query.set('oauthError', code);
  return reply.redirect(`/console?${query.toString()}`);
}

function validProviderKey(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
}

function writableActor(
  database: MysqlServerDatabase,
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

function callbackUri(
  request: FastifyRequest,
  providerKey: string,
  publicOrigin: string | undefined
): string {
  const origin = publicOrigin ?? `${request.protocol}://${request.headers.host ?? 'localhost'}`;
  return `${origin}/api/oauth/${encodeURIComponent(providerKey)}/callback`;
}

function flowCookieName(providerKey: string): string {
  return `mar_oauth_flow_${providerKey}`;
}

function serializeFlowCookie(providerKey: string, flowId: string, secure: boolean): string {
  return `${flowCookieName(providerKey)}=${encodeURIComponent(flowId)}; Path=/api/oauth/${providerKey}/callback; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`;
}

function clearFlowCookie(providerKey: string, secure: boolean): string {
  return `${flowCookieName(providerKey)}=; Path=/api/oauth/${providerKey}/callback; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

function serializeLocaleCookie(locale: 'zh-CN' | 'en-US', secure: boolean): string {
  return `mar_oauth_locale=${locale}; Path=/api/oauth/; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`;
}

function clearLocaleCookie(secure: boolean): string {
  return `mar_oauth_locale=; Path=/api/oauth/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

function oauthLocale(value: string | undefined): 'zh-CN' | 'en-US' {
  return value === 'en-US' ? 'en-US' : 'zh-CN';
}
