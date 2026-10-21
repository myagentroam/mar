import type { Pool } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { MysqlAuthenticationStorage } from '../../src/mysql-authentication.js';
import { hashOpaque } from '../../src/session-token.js';

function fixture() {
  const row = {
    id: 1,
    username: 'admin',
    nickname: null as string | null,
    role: 'ADMIN',
    is_fixed_admin: 1,
    must_change_password: 0,
    session_hash: hashOpaque('cookie'),
    csrf_token_hash: hashOpaque('csrf'),
    expires_at: 10_000
  };
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    execute: vi.fn(async () => [{ affectedRows: 1 }, []]),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn()
  };
  const pool = {
    execute: vi.fn(async () => [[row], []]),
    getConnection: vi.fn(async () => connection)
  };
  const audit = vi.fn(async () => undefined);
  const store = new MysqlAuthenticationStorage(pool as unknown as Pool, {
    now: () => 1_000,
    auditPasswordChange: audit,
    acceptsSession: (identity) => identity.isFixedAdmin
  });
  return { store, pool, connection, audit, row };
}

describe('shared MySQL authentication storage', () => {
  it('resolves a recipient nickname with an account-name fallback', async () => {
    const { store, pool, row } = fixture();
    pool.execute.mockResolvedValueOnce([[{ ...row, username: 'owner', nickname: ' 张三 ' }], []]);
    expect(await store.userDisplayName(7)).toBe('张三');
    expect(pool.execute).toHaveBeenCalledWith(
      'SELECT username,nickname FROM users WHERE id=?',
      [7]
    );
    pool.execute.mockResolvedValueOnce([[{ ...row, username: 'owner', nickname: ' ' }], []]);
    expect(await store.userDisplayName(7)).toBe('owner');
    pool.execute.mockResolvedValueOnce([[], []]);
    expect(await store.userDisplayName(8)).toBeUndefined();
  });

  it('restores admitted sessions and invalidates only the target user', async () => {
    const { store, pool, row } = fixture();
    await store.reloadSessions();
    expect(store.findCurrentUserSession('cookie')?.userId).toBe(1);
    store.invalidateUserSessions(2);
    expect(store.findCurrentUserSession('cookie')?.userId).toBe(1);
    store.invalidateUserSessions(1);
    expect(store.findCurrentUserSession('cookie')).toBeUndefined();
    pool.execute.mockResolvedValue([[{ ...row, is_fixed_admin: 0 }], []]);
    await store.reloadSessions();
    expect(store.findCurrentUserSession('cookie')).toBeUndefined();
  });

  it('commits password and revocation before handing audit off', async () => {
    const { store, audit, connection } = fixture();
    await store.reloadSessions();
    await store.changePassword(1, 'fixture-password', 'password_changed', '127.0.0.1');
    expect(audit).toHaveBeenCalledWith(connection, {
      eventType: 'password_changed',
      actorUserId: 1,
      ipAddress: '127.0.0.1'
    });
    expect(audit.mock.invocationCallOrder[0]).toBeGreaterThan(
      connection.commit.mock.invocationCallOrder[0]!
    );
    expect(store.findCurrentUserSession('cookie')).toBeUndefined();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it('invalidates the projection without rollback when audit writing fails', async () => {
    const { store, audit, connection } = fixture();
    await store.reloadSessions();
    audit.mockRejectedValue(new Error('AUDIT_WRITE_FAILED'));
    await expect(
      store.changePassword(1, 'fixture-password', 'password_changed', '127.0.0.1')
    ).resolves.toBeUndefined();
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(store.findCurrentUserSession('cookie')).toBeUndefined();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it('does not replace restored state with partially loaded data after a read failure', async () => {
    const { store, pool } = fixture();
    await store.reloadSessions();
    pool.execute.mockRejectedValueOnce(new Error('DATABASE_UNAVAILABLE'));
    await expect(store.reloadSessions()).rejects.toThrow('DATABASE_UNAVAILABLE');
    expect(store.findCurrentUserSession('cookie')?.userId).toBe(1);
  });

  it('expires restored sessions without issuing an access-time write', async () => {
    const { store, pool, row } = fixture();
    pool.execute.mockResolvedValue([[{ ...row, expires_at: 1_000 }], []]);
    await store.reloadSessions();
    pool.execute.mockClear();
    expect(store.findCurrentUserSession('cookie')).toBeUndefined();
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('invalidates the projection rather than leaving a rejected access-time write unhandled', async () => {
    const { store, pool } = fixture();
    await store.reloadSessions();
    pool.execute.mockRejectedValueOnce(new Error('DATABASE_UNAVAILABLE'));
    expect(store.findCurrentUserSession('cookie')?.userId).toBe(1);
    await Promise.resolve();
    expect(store.findCurrentUserSession('cookie')).toBeUndefined();
  });
});
