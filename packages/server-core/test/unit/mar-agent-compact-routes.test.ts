import Fastify from 'fastify';
import type { Pool } from 'mysql2/promise';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerMarAgentModelRoutes } from '../../src/mar-agent-model-routes.js';
import { hashOpaque } from '../../src/session-token.js';
import { SESSION_COOKIE_NAME } from '../../src/auth.js';
import type { CurrentUserSession } from '../../src/session.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

type Role = 'admin' | 'user' | 'anonymous';

function fixture(role: Role = 'admin') {
  const app = Fastify();
  apps.push(app);
  const settings = new Map<string, unknown>();
  const execute = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.startsWith('SELECT setting_value FROM system_settings')) {
      const value = settings.get(String(params[0]));
      return [value === undefined ? [] : [{ setting_value: value }]];
    }
    if (sql.startsWith('INSERT INTO system_settings')) {
      settings.set(String(params[0]), JSON.parse(String(params[1])));
      return [{ affectedRows: 1 }];
    }
    return [[]];
  });
  const sessions: Record<string, CurrentUserSession | undefined> = {
    'admin-session': {
      userId: 1,
      username: 'admin',
      isAdmin: true,
      sessionHash: hashOpaque('admin-session'),
      mustChangePassword: false,
      csrfTokenHash: hashOpaque('csrf')
    },
    'user-session': {
      userId: 7,
      username: 'alice',
      isAdmin: false,
      sessionHash: hashOpaque('user-session'),
      mustChangePassword: false,
      csrfTokenHash: hashOpaque('csrf')
    }
  };
  registerMarAgentModelRoutes({
    app,
    authorizeNodeRequest: async () => true,
    databaseError: (reply, error) =>
      reply
        .status(error instanceof Error && error.message.startsWith('MAR_AGENT_') ? 400 : 500)
        .send({ code: error instanceof Error ? error.message : 'INTERNAL_ERROR' }),
    database: {
      findCurrentUserSession: (token: string) => sessions[token],
      raw: { execute } as unknown as Pool
    },
    models: {
      listManagedForUser: vi.fn(async () => [
        {
          id: 'coding-compact',
          enabled: true,
          reasoningEfforts: ['high'],
          defaultReasoningEffort: 'high'
        }
      ])
    } as never,
    runtimeModels: { prepareTest: vi.fn() } as never,
    nodeControl: { requestNode: vi.fn() } as never,
    publicOrigin: 'http://localhost'
  });
  const headers = {
    cookie: `${SESSION_COOKIE_NAME}=${role === 'admin' ? 'admin-session' : role === 'user' ? 'user-session' : 'missing-session'}`,
    origin: 'http://localhost',
    'x-csrf-token': 'csrf'
  };
  return { app, headers, settings };
}

describe('MAR Agent compact management routes', () => {
  it('serves the stored configuration only to management admins without caching', async () => {
    const { app, headers, settings } = fixture('admin');
    settings.set('mar_agent_compact', { enabled: false, modelId: null, reasoningEffort: null });
    const response = await app.inject({ url: '/api/admin/mar-agent/compact', headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toEqual({
      configuration: { enabled: false, modelId: null, reasoningEffort: null }
    });
    expect(response.body).not.toMatch(/apiKey|credential|secret/iu);
  });

  it.each([
    ['unauthenticated', 'anonymous', 401],
    ['non-admin', 'user', 403]
  ])('rejects compact reads for a %s caller', async (_name, role, status) => {
    const { app, headers } = fixture(role as Role);
    const response = await app.inject({ url: '/api/admin/mar-agent/compact', headers });
    expect(response.statusCode).toBe(status);
  });

  it.each([
    ['a cross-origin write', { origin: 'https://elsewhere.invalid' }, 403, 'ORIGIN_NOT_ALLOWED'],
    ['an unauthenticated write', { cookie: '' }, 401, 'UNAUTHENTICATED'],
    ['a non-admin write', { cookie: `${SESSION_COOKIE_NAME}=user-session` }, 403, 'ADMIN_REQUIRED'],
    ['a missing csrf token', { 'x-csrf-token': '' }, 403, 'CSRF_INVALID']
  ])('rejects %s before touching system_settings', async (_name, override, status, code) => {
    const { app, headers, settings } = fixture('admin');
    const response = await app.inject({
      method: 'PUT',
      url: '/api/admin/mar-agent/compact',
      headers: { ...headers, ...override },
      payload: { enabled: false, modelId: null, reasoningEffort: null }
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
    expect(settings.size).toBe(0);
  });

  it('persists a valid write for a management admin and returns only the configuration', async () => {
    const { app, headers, settings } = fixture('admin');
    const payload = { enabled: true, modelId: 'coding-compact', reasoningEffort: 'high' };
    const response = await app.inject({
      method: 'PUT',
      url: '/api/admin/mar-agent/compact',
      headers,
      payload
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toEqual({ configuration: payload });
    expect(settings.get('mar_agent_compact')).toEqual(payload);
    expect(response.body).not.toMatch(/apiKey|credential|secret/iu);
    const reloaded = await app.inject({ url: '/api/admin/mar-agent/compact', headers });
    expect(reloaded.statusCode).toBe(200);
    expect(reloaded.json()).toEqual({ configuration: payload });
  });

  it('surfaces stable write rejections without persisting partial state', async () => {
    const { app, headers, settings } = fixture('admin');
    const response = await app.inject({
      method: 'PUT',
      url: '/api/admin/mar-agent/compact',
      headers,
      payload: { enabled: true, modelId: 'removed-model', reasoningEffort: 'high' }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'MAR_AGENT_COMPACT_MODEL_UNAVAILABLE' });
    expect(settings.size).toBe(0);
  });
});
