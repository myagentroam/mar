import { describe, expect, it, vi } from 'vitest';
import {
  ManagementQueryError,
  managementOrder,
  managementPageQuery,
  managementSearchPattern,
  managementText,
  readManagementPage
} from '../../src/management-pagination.js';

describe('management pagination query helpers', () => {
  it('keeps legacy requests unpaged and supplies defaults for partial pagination', () => {
    expect(managementPageQuery({})).toBeUndefined();
    expect(managementPageQuery({ page: '4' })).toEqual({ page: 4, limit: 20 });
    expect(managementPageQuery({ limit: '35' })).toEqual({ page: 1, limit: 35 });
    expect(managementPageQuery({ page: '3', limit: '50' })).toEqual({ page: 3, limit: 50 });
  });

  it.each([
    ['repeated page', { page: ['1', '2'] }],
    ['repeated limit', { limit: ['10', '20'] }],
    ['zero page', { page: '0' }],
    ['zero limit', { limit: '0' }],
    ['unsafe page', { page: '9007199254740992' }],
    ['unsafe limit', { limit: '9007199254740992' }],
    ['limit above maximum', { limit: '501' }]
  ])('rejects %s', (_label, query) => {
    expect(() => managementPageQuery(query)).toThrow(ManagementQueryError);
  });

  it('allows only declared order fields and escapes LIKE metacharacters', () => {
    const fields = { created: 'created_at', name: 'display_name' };
    expect(managementOrder({ sortBy: 'created', sortOrder: 'desc' }, fields, 'id ASC')).toBe(
      'created_at DESC'
    );
    expect(managementOrder({}, fields, 'id ASC')).toBe('id ASC');
    expect(() => managementOrder({ sortBy: 'created_at DESC' }, fields, 'id ASC')).toThrow(
      ManagementQueryError
    );
    expect(() =>
      managementOrder({ sortBy: 'name', sortOrder: 'sideways' }, fields, 'id ASC')
    ).toThrow(ManagementQueryError);
    expect(managementSearchPattern('a%_!z')).toBe('%a!%!_!!z%');
    expect(managementText({ keyword: '  term  ' }, 'keyword')).toBe('term');
  });

  it('counts and reads with the same scoped predicates, clamps pages and limits the row query', async () => {
    const events: string[] = [];
    const connection = {
      beginTransaction: vi.fn(async () => {
        events.push('begin');
      }),
      query: vi.fn(async (sql: string, params: unknown[]) => {
        if (sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ') {
          events.push('isolation');
          return [[], []];
        }
        events.push(sql.includes('COUNT(*)') ? 'count' : 'rows');
        if (sql.includes('COUNT(*)')) return [[{ total: 41 }], []];
        return [[{ id: 41 }], []];
      }),
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
    const pool = { getConnection: vi.fn(async () => connection) };
    const statements = {
      countSql: 'SELECT COUNT(*) AS total FROM records WHERE tenant_id=? AND status=?',
      rowsSql: 'SELECT id FROM records WHERE tenant_id=? AND status=? ORDER BY id DESC',
      params: [12, 'active']
    };

    const result = await readManagementPage(pool as never, { page: 9, limit: 20 }, statements);

    expect(result).toEqual({
      rows: [{ id: 41 }],
      page: 3,
      pageSize: 20,
      total: 41,
      hasMore: false
    });
    expect(connection.query).toHaveBeenCalledTimes(3);
    expect(connection.query).toHaveBeenNthCalledWith(
      1,
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'
    );
    expect(connection.query).toHaveBeenNthCalledWith(2, statements.countSql, [12, 'active']);
    expect(connection.query).toHaveBeenNthCalledWith(
      3,
      statements.rowsSql + ' LIMIT 20 OFFSET 40',
      [12, 'active']
    );
    expect(events).toEqual(['isolation', 'begin', 'count', 'rows', 'commit', 'release']);
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it('reads optional facets in the same transaction and defaults facet parameters to the scoped query', async () => {
    const events: string[] = [];
    const query = vi.fn(async (sql: string) => {
      if (sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ') {
        events.push('isolation');
        return [[], []];
      }
      events.push(
        sql.includes('COUNT(*)')
          ? 'count'
          : sql.includes('SELECT id FROM records')
            ? 'rows'
            : 'facets'
      );
      if (sql.includes('COUNT(*)')) return [[{ total: 1 }], []];
      if (sql.includes('SELECT id FROM records')) return [[{ id: 1 }], []];
      return [[{ tag: 'visible' }], []];
    });
    const connection = {
      beginTransaction: vi.fn(async () => {
        events.push('begin');
      }),
      query,
      commit: vi.fn(async () => {
        events.push('commit');
      }),
      rollback: vi.fn(),
      release: vi.fn(() => {
        events.push('release');
      })
    };

    const result = await readManagementPage(
      {
        getConnection: vi.fn(async () => connection)
      } as never,
      { page: 1, limit: 20 },
      {
        countSql: 'SELECT COUNT(*) AS total FROM records WHERE tenant_id=?',
        rowsSql: 'SELECT id FROM records WHERE tenant_id=? ORDER BY id',
        facetsSql: 'SELECT tag FROM record_tags WHERE tenant_id=?',
        params: [12]
      }
    );

    expect(result).toMatchObject({ page: 1, total: 1, facets: { tags: ['visible'] } });
    expect(query).toHaveBeenCalledTimes(4);
    expect(query).toHaveBeenNthCalledWith(1, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    expect(query).toHaveBeenNthCalledWith(4, 'SELECT tag FROM record_tags WHERE tenant_id=?', [12]);
    expect(events).toEqual(['isolation', 'begin', 'count', 'rows', 'facets', 'commit', 'release']);
  });
});
