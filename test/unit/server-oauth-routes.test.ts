import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { describe, expect, it, vi } from 'vitest';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import type { NodeControl } from '../../ee/server/src/node-control.js';
import type { OAuthService } from '../../ee/server/src/oauth/oauth-service.js';
import { registerOAuthRoutes } from '../../ee/server/src/route/oauth-routes.js';

describe('Server OAuth routes', () => {
  it('still installs the OAuth login session when audit persistence fails', async () => {
    const app = Fastify();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const audit = vi.fn(async () => {
      throw new Error('audit failed');
    });
    const createUserSession = vi.fn(async () => ({
      sessionId: 'session-id',
      csrfToken: 'csrf',
      evictedSessionHashes: []
    }));
    registerOAuthRoutes({
      app,
      database: { audit, createUserSession } as unknown as MysqlServerDatabase,
      oauth: {
        callback: vi.fn(async () => ({ userId: 2, flowType: 'LOGIN' as const }))
      } as unknown as OAuthService,
      nodeControl: {
        closeUserTerminals: vi.fn(),
        closeUserWorkbench: vi.fn()
      } as unknown as NodeControl,
      publicOrigin: 'https://mar.example',
      secureCookies: true
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/oauth/feishu/callback?state=state&code=code',
        headers: { cookie: 'mar_oauth_flow_feishu=flow' }
      });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/console');
      expect(String(response.headers['set-cookie'])).toContain('mar_user_session=session-id');
      expect(createUserSession).toHaveBeenCalledOnce();
      expect(audit).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith('AUDIT_WRITE_FAILED');
    } finally {
      warning.mockRestore();
      await app.close();
    }
  });

  it('derives provider-specific login and callback URLs', async () => {
    const app = Fastify();
    const oauth = {
      enabledProviders: vi.fn(async () => []),
      begin: vi.fn(async () => ({
        authorizationUrl: 'https://login.example/authorize?state=state',
        browserFlowId: 'flow'
      })),
      callback: vi.fn(async () => ({ userId: 2, flowType: 'LOGIN' as const }))
    };
    const database = {
      audit: vi.fn(async () => undefined),
      createUserSession: vi.fn(async () => ({
        sessionId: 'session-id',
        csrfToken: 'csrf',
        evictedSessionHashes: []
      }))
    };
    registerOAuthRoutes({
      app,
      database: database as unknown as MysqlServerDatabase,
      oauth: oauth as unknown as OAuthService,
      nodeControl: {
        closeUserTerminals: vi.fn(),
        closeUserWorkbench: vi.fn()
      } as unknown as NodeControl,
      publicOrigin: 'https://mar.example',
      secureCookies: true
    });

    const login = await app.inject({ method: 'GET', url: '/api/oauth/feishu/login' });
    expect(login.statusCode).toBe(302);
    expect(oauth.begin).toHaveBeenCalledWith(
      'feishu',
      'https://mar.example/api/oauth/feishu/callback'
    );
    expect(String(login.headers['set-cookie'])).toContain('mar_oauth_flow_feishu=flow');
    expect(String(login.headers['set-cookie'])).toContain('mar_oauth_locale=zh-CN');

    const callback = await app.inject({
      method: 'GET',
      url: '/api/oauth/feishu/callback?state=state&code=code',
      headers: { cookie: 'mar_oauth_flow_feishu=flow' }
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/console');
    expect(oauth.callback).toHaveBeenCalledWith(
      expect.objectContaining({
        providerKey: 'feishu',
        browserFlowId: 'flow',
        redirectUri: 'https://mar.example/api/oauth/feishu/callback'
      })
    );
    expect(callback.headers['set-cookie']).toEqual(
      expect.arrayContaining([
        expect.stringContaining('mar_user_session=session-id'),
        expect.stringContaining('mar_oauth_flow_feishu=')
      ])
    );
    const invalidLogin = await app.inject({ method: 'GET', url: '/api/oauth/Feishu/login' });
    expect(invalidLogin.statusCode).toBe(302);
    expect(invalidLogin.headers.location).toBe('/console?oauthError=OAUTH_PROVIDER_INVALID');
    await app.close();
  });

  it('redirects OAuth callback failures to the Console instead of exposing API JSON', async () => {
    const app = Fastify();
    const oauth = {
      enabledProviders: vi.fn(async () => []),
      begin: vi.fn(),
      callback: vi.fn(async () => {
        throw new Error('OAUTH_IDENTITY_ALREADY_BOUND');
      })
    };
    const database = {
      findCurrentUserSession: vi.fn(() => ({
        userId: 2,
        mustChangePassword: false,
        csrfTokenHash: 'csrf',
        isAdmin: false
      }))
    };
    registerOAuthRoutes({
      app,
      database: database as unknown as MysqlServerDatabase,
      oauth: oauth as unknown as OAuthService,
      nodeControl: {
        closeUserTerminals: vi.fn(),
        closeUserWorkbench: vi.fn()
      } as unknown as NodeControl,
      publicOrigin: 'https://mar.example',
      secureCookies: true
    });

    const callback = await app.inject({
      method: 'GET',
      url: '/api/oauth/feishu/callback?state=state&code=code',
      headers: { cookie: 'mar_oauth_flow_feishu=BIND.2.flow; mar_user_session=session-id' }
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(
      '/console?view=settings&settings=account&oauthError=OAUTH_IDENTITY_ALREADY_BOUND'
    );
    expect(callback.headers['content-type']).toBeUndefined();
    await app.close();
  });

  it('redirects OAuth login initialization failures to the Console', async () => {
    const app = Fastify();
    const oauth = {
      enabledProviders: vi.fn(async () => []),
      begin: vi.fn(async () => {
        throw new Error('OAUTH_PROVIDER_NOT_FOUND');
      })
    };
    registerOAuthRoutes({
      app,
      database: {} as MysqlServerDatabase,
      oauth: oauth as unknown as OAuthService,
      nodeControl: {} as NodeControl,
      publicOrigin: 'https://mar.example',
      secureCookies: true
    });

    const login = await app.inject({ method: 'GET', url: '/api/oauth/feishu/login' });
    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toBe('/console?oauthError=OAUTH_PROVIDER_NOT_FOUND');
    await app.close();
  });
});
