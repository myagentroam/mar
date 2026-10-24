import type { Pool } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';

function fakePool() {
  const end = vi.fn<Pool['end']>().mockResolvedValue(undefined);
  return { pool: { end } as unknown as Pool, end };
}

describe('MySQL database pool close', () => {
  it.each([
    { scenario: 'both pools succeed', auditFails: false, businessFails: false },
    { scenario: 'only the audit pool fails', auditFails: true, businessFails: false },
    { scenario: 'only the business pool fails', auditFails: false, businessFails: true },
    { scenario: 'both pools fail', auditFails: true, businessFails: true }
  ])(
    'attempts both independent pools when $scenario and preserves failures',
    async ({ auditFails, businessFails }) => {
      const business = fakePool();
      const audit = fakePool();
      const auditFailure = new Error('AUDIT_POOL_CLOSE_FAILED');
      const businessFailure = new Error('BUSINESS_POOL_CLOSE_FAILED');
      if (auditFails) audit.end.mockRejectedValueOnce(auditFailure);
      if (businessFails) business.end.mockRejectedValueOnce(businessFailure);
      const database = new MysqlServerDatabase(business.pool, undefined, audit.pool);

      const closing = database.close();
      if (auditFails && businessFails) {
        const failure = await closing.catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([auditFailure, businessFailure]);
        expect((failure as AggregateError).cause).toBe(auditFailure);
      } else if (auditFails || businessFails) {
        await expect(closing).rejects.toBe(auditFails ? auditFailure : businessFailure);
      } else {
        await expect(closing).resolves.toBeUndefined();
      }
      expect(audit.end).toHaveBeenCalledTimes(1);
      expect(business.end).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    { scenario: 'default shared pool succeeds', explicit: false, fails: false },
    { scenario: 'default shared pool fails', explicit: false, fails: true },
    { scenario: 'explicit shared pool succeeds', explicit: true, fails: false },
    { scenario: 'explicit shared pool fails', explicit: true, fails: true }
  ])('closes once and preserves the result when the $scenario', async ({ explicit, fails }) => {
    const shared = fakePool();
    const failure = new Error('SHARED_POOL_CLOSE_FAILED');
    if (fails) shared.end.mockRejectedValueOnce(failure);
    const database = explicit
      ? new MysqlServerDatabase(shared.pool, undefined, shared.pool)
      : new MysqlServerDatabase(shared.pool);

    if (fails) {
      await expect(database.close()).rejects.toBe(failure);
    } else {
      await expect(database.close()).resolves.toBeUndefined();
    }
    expect(shared.end).toHaveBeenCalledTimes(1);
  });
});
