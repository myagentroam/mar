import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { SessionShares } from '../../src/session-shares.js';
import { MysqlSessionShares } from '../../src/mysql-session-shares.js';
import { sessionShareStore } from './support/session-share-store.js';

function fixture() {
  const { rows, store } = sessionShareStore();
  let now = 1_800_000_000_000;
  const authorize = vi.fn(async () => true);
  const requestNode = vi.fn(async () => ({
    session: { id: 'session-one', workspaceId: 'workspace-one' }
  }));
  const invalidate = vi.fn();
  const service = new SessionShares({
    store,
    authorize,
    nodeControl: { requestNode },
    invalidate,
    now: () => now
  });
  const target = { nodeId: 'node-one', workspaceId: 'workspace-one', sessionId: 'session-one' };
  const actor = { userId: 7, username: 'owner', sessionHash: 'account-fingerprint' };
  return {
    rows,
    store,
    service,
    target,
    actor,
    requestNode,
    authorize,
    invalidate,
    advance: (ms: number) => {
      now += ms;
    }
  };
}

describe('Work Session shares', () => {
  it('copies the unchanged password after reopening and requires target authorization', async () => {
    const f = fixture();
    const created = await f.service.create(f.actor, f.target, null);
    expect(await f.service.copyPassword(f.actor.userId, f.target, created.share.id)).toBe(
      created.password
    );
    expect(await f.service.list(f.actor.userId, f.target)).toEqual([created.share]);
    await expect(
      f.service.copyPassword(f.actor.userId, { ...f.target, sessionId: 'other' }, created.share.id)
    ).rejects.toThrow('SESSION_SHARE_NOT_FOUND');
    f.authorize.mockResolvedValue(false);
    await expect(
      f.service.copyPassword(f.actor.userId, f.target, created.share.id)
    ).rejects.toThrow('NODE_NOT_AUTHORIZED');
  });

  it('restores a legacy password only after verifying it without rotating any credentials', async () => {
    const f = fixture();
    const created = await f.service.create(f.actor, f.target, null);
    const old = f.rows.get(created.share.id)!;
    f.rows.set(old.id, { ...old, password: null });
    expect(await f.service.copyPassword(f.actor.userId, f.target, old.id)).toBeNull();
    const wrong = created.password === '000000' ? '111111' : '000000';
    await expect(f.service.copyPassword(f.actor.userId, f.target, old.id, wrong)).rejects.toThrow(
      'SESSION_SHARE_CREDENTIAL_INVALID'
    );
    expect(f.store.savePassword).not.toHaveBeenCalled();
    expect(await f.service.copyPassword(f.actor.userId, f.target, old.id, created.password)).toBe(
      created.password
    );
    expect(f.rows.get(old.id)).toEqual(old);
    expect(await f.service.copyPassword(f.actor.userId, f.target, old.id)).toBe(created.password);
    expect((await f.service.authenticate(old.id, { credential: old.credential })).credential).toBe(
      old.credential
    );
    await f.service.delete(f.actor.userId, f.target, old.id);
    await expect(f.service.copyPassword(f.actor.userId, f.target, old.id)).rejects.toThrow(
      'SESSION_SHARE_NOT_FOUND'
    );
  });

  it('encrypts recoverable passwords using the persistent application key and rejects corruption', async () => {
    const f = fixture();
    const created = await f.service.create(f.actor, f.target, null);
    const stored = f.rows.get(created.share.id)!;
    let encrypted: unknown;
    const row = {
      id: stored.id,
      user_id: 7,
      node_id: f.target.nodeId,
      workspace_id: f.target.workspaceId,
      session_id: f.target.sessionId,
      password_hash: stored.passwordHash,
      access_credential: stored.credential,
      created_at: stored.createdAt,
      expires_at: null,
      encrypted_password: null as unknown
    };
    const execute = vi.fn(async (sql: string, args?: unknown[]) => {
      if (sql.startsWith('UPDATE')) {
        encrypted = args![0];
        row.encrypted_password = encrypted;
        return [{ affectedRows: 1 }, []];
      }
      return [[row], []];
    });
    const database = { raw: { execute } as unknown as Pool };
    const key = Buffer.alloc(32, 5);
    const store = new MysqlSessionShares(database, key);
    expect(await store.savePassword(stored.id, created.password)).toBe(true);
    expect(typeof encrypted).toBe('string');
    expect(encrypted).not.toBe(created.password);
    expect((await new MysqlSessionShares(database, key).get(stored.id))?.password).toBe(
      created.password
    );
    await expect(
      new MysqlSessionShares(database, Buffer.alloc(32, 9)).get(stored.id)
    ).rejects.toThrow('SESSION_SHARE_PASSWORD_CORRUPT');
    row.encrypted_password = String(encrypted).slice(0, -4) + 'AAAA';
    await expect(store.get(stored.id)).rejects.toThrow('SESSION_SHARE_PASSWORD_CORRUPT');
    row.encrypted_password = null;
    expect((await store.get(stored.id))?.password).toBeNull();
  });

  it('uses the authoritative nickname with a username fallback', async () => {
    const f = fixture();
    f.store.executionUser.mockResolvedValue({ username: 'owner', displayName: '  ' });
    const created = await f.service.create(f.actor, f.target, null);
    expect(
      (await f.service.authenticate(created.share.id, { password: created.password })).sharerName
    ).toBe('owner');
    expect(await f.service.participant(7)).toEqual({ userId: 7, name: 'owner' });
    f.store.executionUser.mockResolvedValue({ username: 'owner', displayName: 'Owner Name' });
    expect(await f.service.participant(7)).toEqual({ userId: 7, name: 'Owner Name' });
  });
  it('creates six-digit string passwords and authenticates persistently without exposing secrets in listings', async () => {
    const f = fixture();
    const created = await f.service.create(f.actor, f.target, null);
    expect(created.password).toMatch(/^[0-9]{6}$/u);
    expect(created.share.expiresAt).toBeNull();
    const stored = f.rows.get(created.share.id)!;
    expect(stored.passwordHash).not.toBe(created.password);
    expect(stored.credential).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const authenticated = await f.service.authenticate(stored.id, { password: created.password });
    expect(authenticated).toEqual({
      share: created.share,
      credential: stored.credential,
      sharerName: 'Owner',
      workspaceName: 'Project Alpha'
    });
    expect(
      await f.service.authenticate(stored.id, { credential: authenticated.credential })
    ).toEqual(authenticated);
    expect(await f.service.list(f.actor.userId, f.target)).toEqual([created.share]);
    expect(JSON.stringify(await f.service.list(f.actor.userId, f.target))).not.toContain(
      stored.credential
    );
    expect(f.requestNode).toHaveBeenCalledTimes(1);
    expect(f.store.workspaceName).toHaveBeenCalledWith('node-one', 'workspace-one');
    f.store.workspaceName.mockResolvedValue('Renamed Project');
    expect(
      await f.service.authenticate(stored.id, { credential: authenticated.credential })
    ).toMatchObject({
      workspaceName: 'Renamed Project'
    });
  });

  it('omits unavailable workspace names rather than substituting an ID or filesystem path', async () => {
    const f = fixture();
    f.store.workspaceName.mockResolvedValue(undefined);
    const created = await f.service.create(f.actor, f.target, null);
    expect(
      await f.service.authenticate(created.share.id, { password: created.password })
    ).not.toHaveProperty('workspaceName');
  });

  it('reads only the registered name for the bound Node and Workspace', async () => {
    const execute = vi.fn().mockResolvedValue([[{ display_name: 'Project Alpha' }], []]);
    const store = new MysqlSessionShares(
      { raw: { execute } as unknown as Pool },
      Buffer.alloc(32, 1)
    );
    expect(await store.workspaceName('node-one', 'workspace-one')).toBe('Project Alpha');
    expect(execute).toHaveBeenCalledWith(
      'SELECT display_name FROM workspaces WHERE node_id=? AND workspace_id=?',
      ['node-one', 'workspace-one']
    );
    execute.mockResolvedValue([[], []]);
    expect(await store.workspaceName('node-one', 'workspace-one')).toBeUndefined();
  });

  it('rejects bad credentials, malformed passwords, expired shares and revoked execution access', async () => {
    const f = fixture();
    const created = await f.service.create(f.actor, f.target, '2027-01-15T09:00:00Z');
    const stored = f.rows.get(created.share.id)!;
    for (const input of [
      { password: '12345' },
      { password: 123456 },
      { credential: 'x'.repeat(43) },
      { password: '000000', credential: stored.credential }
    ])
      await expect(f.service.authenticate(stored.id, input)).rejects.toThrow(
        'SESSION_SHARE_CREDENTIAL_INVALID'
      );
    expect(f.store.workspaceName).not.toHaveBeenCalled();
    f.authorize.mockResolvedValue(false);
    await expect(f.service.resolve(stored.id, stored.credential)).rejects.toThrow(
      'NODE_NOT_AUTHORIZED'
    );
    f.authorize.mockResolvedValue(true);
    f.advance(400 * 24 * 3600_000);
    await expect(f.service.resolve(stored.id, stored.credential)).rejects.toThrow(
      'SESSION_SHARE_EXPIRED'
    );
  });

  it('deletes after authorization, invalidates before returning, and never cancels a task', async () => {
    const f = fixture();
    const created = await f.service.create(f.actor, f.target, null);
    const stored = f.rows.get(created.share.id)!;
    f.requestNode.mockClear();
    await f.service.delete(f.actor.userId, f.target, stored.id);
    expect(f.store.delete).toHaveBeenCalledWith(stored.id);
    expect(f.invalidate).toHaveBeenCalledWith(stored.id, 'SESSION_SHARE_NOT_FOUND');
    await expect(f.service.resolve(stored.id, stored.credential)).rejects.toThrow(
      'SESSION_SHARE_NOT_FOUND'
    );
    expect(f.requestNode).not.toHaveBeenCalled();
  });

  it('rejects wrong targets and past expiration without inserting or deleting shares', async () => {
    const f = fixture();
    await expect(f.service.create(f.actor, f.target, '2020-01-01T00:00:00Z')).rejects.toThrow(
      'SESSION_SHARE_INPUT_INVALID'
    );
    expect(f.store.insert).not.toHaveBeenCalled();
    f.requestNode.mockResolvedValueOnce({ session: { id: 'session-one', workspaceId: 'other' } });
    await expect(f.service.create(f.actor, f.target, null)).rejects.toThrow('SESSION_NOT_FOUND');
    const created = await f.service.create(f.actor, f.target, null);
    await expect(
      f.service.delete(f.actor.userId, { ...f.target, sessionId: 'other' }, created.share.id)
    ).rejects.toThrow('SESSION_SHARE_NOT_FOUND');
    expect(f.store.delete).not.toHaveBeenCalled();
  });
});
