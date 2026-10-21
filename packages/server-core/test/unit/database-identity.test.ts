import { describe, expect, it, vi } from 'vitest';
import { assertDatabaseIdentity } from '../../src/database-identity.js';

function fixture(tables: string[], columns = ['version'], namespaces: unknown[] = []) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('information_schema.tables'))
      return [tables.map((table_name) => ({ table_name })), []];
    if (sql.includes('information_schema.columns'))
      return [columns.map((column_name) => ({ column_name })), []];
    if (sql.includes('SELECT DISTINCT namespace'))
      return [namespaces.map((namespace) => ({ namespace })), []];
    throw new Error('UNEXPECTED_QUERY');
  });
  return { query };
}

describe('database identity preflight', () => {
  it('allows empty databases without writing', async () => {
    for (const edition of ['personal', 'enterprise'] as const) {
      const db = fixture([]);
      await expect(assertDatabaseIdentity(db, { edition, ledger: 'namespaced' })).resolves.toBe(
        'empty'
      );
      expect(db.query).toHaveBeenCalledTimes(1);
    }
  });

  it('allows legacy databases only for the legacy enterprise migrator', async () => {
    const db = fixture(['schema_migrations', 'users']);
    await expect(
      assertDatabaseIdentity(db, { edition: 'enterprise', ledger: 'legacy' })
    ).resolves.toBe('legacy');
    await expect(
      assertDatabaseIdentity(db, { edition: 'personal', ledger: 'namespaced' })
    ).rejects.toThrow('SERVER_DATABASE_EDITION_MISMATCH');
    await expect(
      assertDatabaseIdentity(db, { edition: 'enterprise', ledger: 'namespaced' })
    ).rejects.toThrow('SERVER_DATABASE_LEDGER_UNSUPPORTED');
  });

  it('permits a core ledger for either namespaced product', async () => {
    for (const edition of ['personal', 'enterprise'] as const) {
      await expect(
        assertDatabaseIdentity(fixture(['schema_migrations'], ['version', 'namespace'], ['core']), {
          edition,
          ledger: 'namespaced'
        })
      ).resolves.toBe('personal');
    }
  });

  it('rejects enterprise namespaces for personal regardless of migration status', async () => {
    const db = fixture(['schema_migrations'], ['version', 'namespace'], ['core', 'enterprise']);
    await expect(
      assertDatabaseIdentity(db, { edition: 'personal', ledger: 'namespaced' })
    ).rejects.toThrow('SERVER_DATABASE_EDITION_MISMATCH');
    await expect(
      assertDatabaseIdentity(db, { edition: 'enterprise', ledger: 'namespaced' })
    ).resolves.toBe('enterprise');
    expect(db.query.mock.calls.every(([sql]) => !sql.includes('status'))).toBe(true);
  });

  it('never lets the legacy migrator write into a namespaced ledger', async () => {
    await expect(
      assertDatabaseIdentity(fixture(['schema_migrations'], ['version', 'namespace'], ['core']), {
        edition: 'enterprise',
        ledger: 'legacy'
      })
    ).rejects.toThrow('SERVER_DATABASE_LEDGER_UNSUPPORTED');
  });

  it.each([
    fixture(['users']),
    fixture(['schema_migrations'], []),
    fixture(['schema_migrations'], ['namespace']),
    fixture(['schema_migrations'], ['version', 'namespace']),
    fixture(['schema_migrations'], ['version', 'namespace'], ['unknown']),
    fixture(['schema_migrations'], ['version', 'namespace'], [null]),
    fixture(['schema_migrations'], ['version', 'namespace'], ['enterprise'])
  ])('rejects unidentifiable nonempty databases', async (db) => {
    await expect(
      assertDatabaseIdentity(db, { edition: 'enterprise', ledger: 'namespaced' })
    ).rejects.toThrow('SERVER_DATABASE_IDENTITY_INVALID');
  });

  it('propagates read errors without attempting fallback initialization', async () => {
    const query = vi.fn().mockRejectedValue(new Error('READ_FAILED'));
    await expect(
      assertDatabaseIdentity({ query }, { edition: 'enterprise', ledger: 'legacy' })
    ).rejects.toThrow('READ_FAILED');
    expect(query).toHaveBeenCalledTimes(1);
  });
});
