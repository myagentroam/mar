import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { createTestMysqlEnvironmentSecretService } from '../support/mysql-environment-secret-service.js';
import { readVisibleCatalog } from '../../ee/server/src/rbac/catalog-list-query.js';
import { ResourceManagementDirectory } from '../../ee/server/src/rbac/resource-management-directory.js';
import { ManagementQueryError } from '../../packages/server-core/src/management-pagination.js';

type FakeRow = Record<string, unknown>;

function transactionPool(
  rowsFor: (sql: string, params: readonly unknown[]) => FakeRow[],
  events: string[] = []
) {
  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    if (sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ') {
      events.push('isolation');
      return [[], []] as const;
    }
    events.push(
      sql.includes('COUNT(*)') ? 'count' : sql.includes('JSON_TABLE') ? 'facets' : 'rows'
    );
    return [rowsFor(sql, params), []] as const;
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
    query,
    getConnection: vi.fn(async () => connection)
  };
  return { pool, connection };
}

describe('management list domain queries', () => {
  it('authorizes Node visibility before the count and applies identical scoped filters to count and page rows', async () => {
    const events: string[] = [];
    const { pool, connection } = transactionPool(
      (sql) => (sql.includes('COUNT(*)') ? [{ total: 25 }] : []),
      events
    );
    const authorization = {
      managedOrganizationIds: vi.fn(async () => {
        events.push('organizations');
        return [3, 4];
      }),
      authorize: vi.fn(async () => {
        events.push('authorize');
        return { allowed: false };
      })
    };
    const service = new ResourceManagementDirectory({ raw: pool } as never, authorization as never);

    const result = await service.listManagedResourcePage(
      8,
      {
        resourceType: 'NODE',
        management: 'all',
        page: '9',
        limit: '10',
        ownerType: 'ORGANIZATION',
        keyword: 'Edge',
        status: 'online',
        sortBy: 'label',
        sortOrder: 'desc'
      },
      ['node-a', 'node-b']
    );

    const scopedParams = [8, [3, 4], 'ORGANIZATION', '%Edge%', '%Edge%', ['node-a', 'node-b']];
    expect(events).toEqual([
      'organizations',
      'authorize',
      'isolation',
      'begin',
      'count',
      'rows',
      'commit',
      'release'
    ]);
    expect(authorization.authorize).toHaveBeenCalledWith(8, 'NODE_MANAGE', { ownerType: 'SYSTEM' });
    expect(connection.query).toHaveBeenCalledTimes(3);
    expect(connection.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("owner_type='PERSONAL'"),
      scopedParams
    );
    expect(connection.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('ORDER BY node.display_name DESC,node.id LIMIT 10 OFFSET 20'),
      scopedParams
    );
    expect(connection.query).toHaveBeenNthCalledWith(
      1,
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'
    );
    expect(connection.query.mock.calls[1]?.[0]).toContain('node.disabled=FALSE AND node.id IN (?)');
    expect(connection.query.mock.calls[1]?.[0]).toContain('node.display_name LIKE ? ESCAPE');
    expect(result).toMatchObject({
      page: 3,
      pageSize: 10,
      total: 25,
      hasMore: false,
      nodes: [],
      workspaces: []
    });
  });

  it('resolves managed secret scopes before counting, then clamps the filtered page with shared scope parameters', async () => {
    const events: string[] = [];
    const { pool, connection } = transactionPool(
      (sql) => (sql.includes('COUNT(*)') ? [{ total: 31 }] : []),
      events
    );
    const managedOrganizationIds = vi.fn(async (userId: number) => {
      events.push('managed-organizations');
      expect(userId).toBe(11);
      return [3, 4];
    });
    const service = createTestMysqlEnvironmentSecretService(
      { raw: pool } as never,
      async () => false,
      async () => false,
      managedOrganizationIds
    );

    const result = await service.listPage(
      { userId: 11, isAdmin: true },
      {
        page: '9',
        limit: '20',
        scopes: 'PERSONAL,ORGANIZATION',
        keyword: 'API%',
        sortBy: 'updatedAt',
        sortOrder: 'desc'
      }
    );

    const scopedParams = [11, [3, 4], ['PERSONAL', 'ORGANIZATION'], '%API!%%'];
    expect(events).toEqual([
      'managed-organizations',
      'isolation',
      'begin',
      'count',
      'rows',
      'commit',
      'release'
    ]);
    expect(connection.query).toHaveBeenCalledTimes(3);
    expect(connection.query).toHaveBeenNthCalledWith(
      1,
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'
    );
    expect(connection.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('COUNT(*)'),
      scopedParams
    );
    expect(connection.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('ORDER BY updated_at DESC,id LIMIT 20 OFFSET 20'),
      scopedParams
    );
    expect(connection.query.mock.calls[1]?.[0]).toContain("name LIKE ? ESCAPE '!'");
    expect(result).toMatchObject({ page: 2, pageSize: 20, total: 31, hasMore: false, secrets: [] });
  });

  it('keeps catalog facets scoped to all visible entries rather than the current row filters', async () => {
    const { pool, connection } = transactionPool((sql) => {
      if (sql.includes('COUNT(*)')) return [{ total: 25 }];
      if (sql.includes('JSON_TABLE'))
        return [{ tag: 'visible-unmatched-tag' }, { tag: 'visible-tag' }];
      return [{ id: 'matched-row' }];
    });

    const result = await readVisibleCatalog(
      pool as unknown as Pool,
      7,
      {
        page: '9',
        limit: '10',
        keyword: 'needle',
        category: 'tooling',
        sourceId: 'source-1',
        scope: 'ORGANIZATION',
        sortBy: 'updatedAt',
        sortOrder: 'desc'
      },
      'SKILL'
    );

    const filteredParams = [
      7,
      7,
      '%needle%',
      '%needle%',
      '%needle%',
      '"tooling"',
      'source-1',
      'ORGANIZATION'
    ];
    expect(result).toMatchObject({
      rows: [{ id: 'matched-row' }],
      metadata: { page: 3, pageSize: 10, total: 25, hasMore: false },
      facets: { tags: ['visible-unmatched-tag', 'visible-tag'] }
    });
    expect(connection.query).toHaveBeenCalledTimes(4);
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
      expect.stringContaining('ORDER BY entry.updated_at DESC,entry.id LIMIT 10 OFFSET 20'),
      filteredParams
    );
    const [facetsSql, facetsParams] = connection.query.mock.calls[3]!;
    expect(facetsSql).toContain("entry.scope='ENTERPRISE' OR entry.owner_user_id=?");
    expect(facetsSql).not.toContain('LIKE ?');
    expect(facetsSql).not.toContain('JSON_CONTAINS');
    expect(facetsSql).not.toContain('source_id=?');
    expect(facetsSql).not.toContain('entry.scope=?');
    expect(facetsParams).toEqual([7, 7]);
  });

  it('uses bounded IDs and names as SQL predicates without loading a full catalog for local filtering', async () => {
    const { pool } = transactionPool(() => [{ id: 'selected-id', server_name: 'selected-name' }]);
    const ids = ['id-1', 'id-2'];
    const names = ['team/one'];

    const result = await readVisibleCatalog(
      pool as unknown as Pool,
      7,
      {
        ids: JSON.stringify(ids),
        names: JSON.stringify(names)
      },
      'MCP'
    );

    expect(pool.query).toHaveBeenCalledOnce();
    const [sql, params] = pool.query.mock.calls[0]!;
    expect(sql).toContain('(entry.id IN (?) OR entry.server_name IN (?))');
    expect(sql).not.toContain('LIMIT');
    expect(params).toEqual([7, 7, ids, names]);
    expect(result.rows).toEqual([{ id: 'selected-id', server_name: 'selected-name' }]);
    for (const key of ['ids', 'names'] as const) {
      const unboundedPool = transactionPool(() => []);
      await expect(
        readVisibleCatalog(
          unboundedPool.pool as unknown as Pool,
          7,
          {
            [key]: JSON.stringify(Array.from({ length: 129 }, (_, index) => `value-${index}`))
          },
          'MCP'
        )
      ).rejects.toThrow(ManagementQueryError);
      expect(unboundedPool.pool.query).not.toHaveBeenCalled();
    }
  });
});
