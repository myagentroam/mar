import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import type { FastifyReply } from '../../ee/server/node_modules/fastify/fastify.js';
import { hashOpaque } from '../../ee/server/src/database.js';
import { describe, expect, it, vi } from 'vitest';
import {
  CORE_MYSQL_MIGRATIONS,
  CORE_MYSQL_SCHEMA
} from '../../packages/server-core/src/mysql-schema.js';
import { PromptCompletionSettings } from '../../packages/server-core/src/prompt-completion-settings.js';
import { registerPromptCompletionSettingsRoutes } from '../../packages/server-core/src/prompt-completion-settings-routes.js';

const csrfToken = 'prompt-completion-csrf';
const publicOrigin = 'http://localhost';

describe('Server prompt completion settings', () => {
  it('defaults the global setting to enabled but unrunnable until a model is configured', async () => {
    const pool = settingsPool();
    const settings = new PromptCompletionSettings(pool as never, managedModels([]) as never);

    await expect(settings.readConfiguration()).resolves.toEqual({
      enabled: true,
      modelId: null,
      reasoningEffort: null
    });
  });

  it('requires an enabled model the actor can manage and a supported effort when enabling', async () => {
    const settings = new PromptCompletionSettings(
      settingsPool() as never,
      managedModels([model({ reasoningEfforts: ['low', 'high'] })]) as never
    );

    await expect(
      settings.writeConfiguration(7, { enabled: true, modelId: null, reasoningEffort: null })
    ).rejects.toThrow('MAR_AGENT_PROMPT_COMPLETION_MODEL_REQUIRED');
    await expect(
      settings.writeConfiguration(7, {
        enabled: true,
        modelId: 'hidden-model',
        reasoningEffort: 'high'
      })
    ).rejects.toThrow('MAR_AGENT_PROMPT_COMPLETION_MODEL_UNAVAILABLE');
    const disabledModelSettings = new PromptCompletionSettings(
      settingsPool() as never,
      managedModels([model({ enabled: false })]) as never
    );
    await expect(
      disabledModelSettings.writeConfiguration(7, {
        enabled: true,
        modelId: 'managed-model',
        reasoningEffort: 'high'
      })
    ).rejects.toThrow('MAR_AGENT_PROMPT_COMPLETION_MODEL_UNAVAILABLE');
    await expect(
      settings.writeConfiguration(7, {
        enabled: true,
        modelId: 'managed-model',
        reasoningEffort: 'medium'
      })
    ).rejects.toThrow('MAR_AGENT_PROMPT_COMPLETION_EFFORT_INVALID');
  });

  it('persists only the configuration DTO and returns no model credentials', async () => {
    const pool = settingsPool();
    const settings = new PromptCompletionSettings(
      pool as never,
      managedModels([
        model({
          credential: { type: 'INLINE_API_KEY', value: 'not-for-the-response' },
          reasoningEfforts: ['low', 'high']
        })
      ]) as never,
      () => 123
    );

    await expect(
      settings.writeConfiguration(7, {
        enabled: true,
        modelId: 'managed-model',
        reasoningEffort: 'high'
      })
    ).resolves.toEqual({ enabled: true, modelId: 'managed-model', reasoningEffort: 'high' });
    expect(pool.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO system_settings'),
      [
        'mar_agent_prompt_completion',
        JSON.stringify({
          enabled: true,
          modelId: 'managed-model',
          reasoningEffort: 'high'
        }),
        123
      ]
    );
  });

  it('does not expose browser preferences and keeps global configuration admin-only', async () => {
    const pool = settingsPool();
    const database = routeDatabase(pool, {
      userId: 7,
      username: 'member',
      isAdmin: false
    });
    const app = Fastify();
    registerPromptCompletionSettingsRoutes({
      app,
      database: database as never,
      databaseError: databaseError(),
      models: managedModels([]) as never,
      publicOrigin
    });

    const get = await app.inject({
      method: 'GET',
      url: '/api/prompt-completion/preferences',
      headers: memberHeaders()
    });
    const put = await app.inject({
      method: 'PUT',
      url: '/api/prompt-completion/preferences',
      headers: memberHeaders(),
      payload: { work: true }
    });
    const adminOnly = await app.inject({
      method: 'GET',
      url: '/api/admin/mar-agent/prompt-completion',
      headers: memberHeaders()
    });
    const adminOnlyWrite = await app.inject({
      method: 'PUT',
      url: '/api/admin/mar-agent/prompt-completion',
      headers: memberHeaders(),
      payload: { enabled: false, modelId: null, reasoningEffort: null }
    });

    expect(get.statusCode).toBe(404);
    expect(put.statusCode).toBe(404);
    expect(pool.execute).not.toHaveBeenCalled();
    expect(adminOnly.statusCode).toBe(403);
    expect(adminOnlyWrite.statusCode).toBe(403);
    expect(database.findCurrentUserSession).toHaveBeenCalledWith('member-session');
    await app.close();
  });

  it('requires origin and CSRF for global configuration writes', async () => {
    const pool = settingsPool();
    const database = routeDatabase(pool, {
      userId: 1,
      username: 'admin',
      isAdmin: true
    });
    const app = Fastify();
    registerPromptCompletionSettingsRoutes({
      app,
      database: database as never,
      databaseError: databaseError(),
      models: managedModels([model({ reasoningEfforts: ['high'] })]) as never,
      publicOrigin
    });

    const crossOrigin = await app.inject({
      method: 'PUT',
      url: '/api/admin/mar-agent/prompt-completion',
      headers: {
        cookie: 'mar_user_session=admin-session',
        origin: 'http://attacker.example',
        'x-csrf-token': csrfToken
      },
      payload: { enabled: true, modelId: 'managed-model', reasoningEffort: 'high' }
    });
    const noCsrf = await app.inject({
      method: 'PUT',
      url: '/api/admin/mar-agent/prompt-completion',
      headers: { cookie: 'mar_user_session=admin-session', origin: publicOrigin },
      payload: { enabled: true, modelId: 'managed-model', reasoningEffort: 'high' }
    });
    const valid = await app.inject({
      method: 'PUT',
      url: '/api/admin/mar-agent/prompt-completion',
      headers: adminHeaders(),
      payload: { enabled: true, modelId: 'managed-model', reasoningEffort: 'high' }
    });

    expect(crossOrigin.statusCode).toBe(403);
    expect(noCsrf.statusCode).toBe(403);
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({
      configuration: { enabled: true, modelId: 'managed-model', reasoningEffort: 'high' }
    });
    expect(database.findCurrentUserSession).toHaveBeenCalledWith('admin-session');
    await app.close();
  });

  it('appends an idempotent Core v24 table migration and validates the installed shape', async () => {
    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 24);
    expect(CORE_MYSQL_MIGRATIONS.at(-1)?.version).toBe(24);
    expect(CORE_MYSQL_SCHEMA).toHaveProperty('user_prompt_completion_preferences');
    expect(migration?.name).toBe('user_prompt_completion_preferences');

    const definitions = new Map<string, string>();
    const query = vi.fn(async (sql: string) => {
      const create = /^CREATE TABLE IF NOT EXISTS `([^`]+)`/u.exec(sql);
      if (create) definitions.set(create[1]!, sql.replace(' IF NOT EXISTS', ''));
      const name = /^SHOW CREATE TABLE `([^`]+)`/u.exec(sql)?.[1];
      return name === undefined ? [[], []] : [[{ 'Create Table': definitions.get(name) }], []];
    });
    const connection = { query };

    await migration!.up(connection as never);
    await migration!.up(connection as never);

    expect(definitions.size).toBe(1);
    expect(definitions.get('user_prompt_completion_preferences')).toContain(
      '`work_enabled` tinyint(1) NOT NULL'
    );
    expect(
      query.mock.calls.filter(([sql]) => sql.startsWith('CREATE TABLE IF NOT EXISTS'))
    ).toHaveLength(2);
    expect(query.mock.calls.filter(([sql]) => sql.startsWith('SHOW CREATE TABLE'))).toHaveLength(2);
  });

  it('rejects an incompatible pre-existing preferences table during v24 migration', async () => {
    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 24)!;
    const expected = CORE_MYSQL_SCHEMA.user_prompt_completion_preferences!;
    const query = vi.fn(async (sql: string) =>
      sql.startsWith('SHOW CREATE TABLE')
        ? [[{ 'Create Table': expected.replace('work_enabled', 'other_column') }], []]
        : [[], []]
    );

    await expect(migration.up({ query } as never)).rejects.toThrow(
      'SERVER_DATABASE_SCHEMA_MISMATCH'
    );
  });
});

function settingsPool() {
  const execute = vi.fn(async (sql: string) => {
    if (sql.includes('FROM system_settings')) return [[], []];
    return [[], []];
  });
  return { execute };
}

function managedModels(values: readonly Record<string, unknown>[]) {
  return { listManagedForUser: vi.fn(async () => values) };
}

function model(overrides: Record<string, unknown> = {}) {
  return {
    id: 'managed-model',
    enabled: true,
    reasoningEfforts: ['high'],
    defaultReasoningEffort: 'high',
    ...overrides
  };
}

function routeDatabase(raw: unknown, user: { userId: number; username: string; isAdmin: boolean }) {
  const sessions = {
    'admin-session': { ...user, userId: 1, isAdmin: true },
    'member-session': { ...user, userId: 7, isAdmin: false }
  };
  return {
    raw,
    findCurrentUserSession: vi.fn((sessionId: string) => {
      const current = sessions[sessionId as keyof typeof sessions];
      return current === undefined
        ? undefined
        : {
            ...current,
            sessionHash: `${sessionId}-hash`,
            mustChangePassword: false,
            csrfTokenHash: hashOpaque(csrfToken)
          };
    })
  };
}

function databaseError() {
  return (reply: FastifyReply, error: unknown): FastifyReply =>
    reply.code(400).send({ error: { code: error instanceof Error ? error.message : 'ERROR' } });
}

function memberHeaders() {
  return {
    cookie: 'mar_user_session=member-session',
    origin: publicOrigin,
    'x-csrf-token': csrfToken
  };
}

function adminHeaders() {
  return {
    cookie: 'mar_user_session=admin-session',
    origin: publicOrigin,
    'x-csrf-token': csrfToken
  };
}
