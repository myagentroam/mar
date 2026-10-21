import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { databaseError } from '../../src/domain-errors.js';
import { SESSION_COOKIE_NAME } from '../../src/auth.js';
import { ConversationTemplateService } from '../../src/conversation-template-service.js';
import { registerConversationTemplateRoutes } from '../../src/conversation-template-routes.js';
import { registerEnvironmentSecretRoutes } from '../../src/environment-secret-routes.js';
import type { EnvironmentSecretActor } from '../../src/environment-secret-contracts.js';

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function pagedPool() {
  const events: string[] = [];
  const query = vi.fn(async (sql: string, _params: readonly unknown[] = []) => {
    if (sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ') {
      events.push('isolation');
      return [[], []] as const;
    }
    events.push(sql.includes('COUNT(*)') ? 'count' : 'rows');
    return [sql.includes('COUNT(*)') ? [{ total: 3 }] : [], []] as const;
  });
  const connection = {
    beginTransaction: vi.fn(async () => {
      events.push('begin');
    }),
    query,
    commit: vi.fn(async () => {
      events.push('commit');
    }),
    rollback: vi.fn(async () => {
      events.push('rollback');
    }),
    release: vi.fn(() => {
      events.push('release');
    })
  };
  const pool = {
    query: vi.fn(async (sql: string, _params: readonly unknown[] = []) => {
      events.push('legacy');
      return [[], []] as const;
    }),
    execute: vi.fn(async () => {
      events.push('legacy-list');
      return [[], []] as const;
    }),
    getConnection: vi.fn(async () => connection)
  };
  return { pool, connection, events };
}

function adminDatabase() {
  return {
    findCurrentUserSession: vi.fn((sessionId: string) =>
      sessionId === 'admin-session'
        ? {
            userId: 1,
            username: 'admin',
            isAdmin: true,
            sessionHash: 'session-hash',
            mustChangePassword: false,
            csrfTokenHash: 'csrf-token-hash'
          }
        : undefined
    )
  };
}

const adminHeaders = { cookie: `${SESSION_COOKIE_NAME}=admin-session` };

describe('management list routes', () => {
  it('preserves the legacy template envelope, returns pages, and maps invalid pagination to HTTP 400', async () => {
    const { pool, connection, events } = pagedPool();
    const app = Fastify();
    apps.push(app);
    const templates = new ConversationTemplateService(
      { raw: pool } as never,
      {} as never,
      {} as never
    );
    registerConversationTemplateRoutes({
      app,
      database: adminDatabase(),
      templates,
      nodeControl: { requestNode: vi.fn() } as never,
      publicOrigin: undefined
    });

    const legacy = await app.inject({
      url: '/api/admin/conversation-templates',
      headers: adminHeaders
    });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json()).toEqual({ templates: [] });
    expect(pool.execute).toHaveBeenCalledOnce();
    expect(pool.query).not.toHaveBeenCalled();

    const page = await app.inject({
      url: '/api/admin/conversation-templates?page=9&limit=2&keyword=needle&status=ARCHIVED&sortBy=name&sortOrder=desc',
      headers: adminHeaders
    });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toEqual({ templates: [], page: 2, pageSize: 2, total: 3, hasMore: false });
    const filteredParams = ['%needle%', '%needle%', 'ARCHIVED'];
    expect(connection.query).toHaveBeenNthCalledWith(
      1,
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'
    );
    expect(connection.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('COUNT(*)'),
      filteredParams
    );
    expect(connection.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('ORDER BY template.name DESC,template.id LIMIT 2 OFFSET 2'),
      filteredParams
    );
    expect(events).toEqual([
      'legacy-list',
      'isolation',
      'begin',
      'count',
      'rows',
      'commit',
      'release'
    ]);
    expect(connection.query.mock.calls[2]?.[0]).toContain('template.status=?');

    const invalid = await app.inject({
      url: '/api/admin/conversation-templates?page=0',
      headers: adminHeaders
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('MANAGEMENT_QUERY_INVALID');
    expect(connection.query).toHaveBeenCalledTimes(3);
  });

  it('keeps legacy environment-secret envelopes while selecting paged reads and rejecting invalid page input', async () => {
    const app = Fastify();
    apps.push(app);
    const list = vi.fn(async () => [{ id: 'legacy-secret' }]);
    const listPage = vi.fn(
      async (_actor: EnvironmentSecretActor, _query: Record<string, unknown>) => ({
        secrets: [{ id: 'page-secret' }],
        page: 1,
        pageSize: 20,
        total: 1,
        hasMore: false
      })
    );
    registerEnvironmentSecretRoutes({
      app,
      database: adminDatabase(),
      databaseError,
      secrets: {
        list,
        listPage,
        create: vi.fn(),
        replace: vi.fn(),
        remove: vi.fn()
      } as never,
      publicOrigin: undefined
    });

    const legacy = await app.inject({ url: '/api/environment-secrets', headers: adminHeaders });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json()).toEqual({ secrets: [{ id: 'legacy-secret' }] });
    expect(list).toHaveBeenCalledOnce();
    expect(listPage).not.toHaveBeenCalled();

    const paged = await app.inject({
      url: '/api/environment-secrets?page=1&limit=20',
      headers: adminHeaders
    });
    expect(paged.statusCode).toBe(200);
    expect(paged.json()).toEqual({
      secrets: [{ id: 'page-secret' }],
      page: 1,
      pageSize: 20,
      total: 1,
      hasMore: false
    });
    expect(listPage).toHaveBeenCalledOnce();
    expect(listPage.mock.calls[0]?.[1]).toEqual({ page: '1', limit: '20' });

    const invalid = await app.inject({
      url: '/api/environment-secrets?page=0',
      headers: adminHeaders
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('MANAGEMENT_QUERY_INVALID');
    expect(list).toHaveBeenCalledOnce();
    expect(listPage).toHaveBeenCalledOnce();
  });
});
