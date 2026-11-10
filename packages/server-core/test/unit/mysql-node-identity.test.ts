import type { Pool } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { MysqlNodeIdentityStorage } from '../../src/mysql-node-identity.js';

function fixture() {
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    execute: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes('SELECT id FROM users')) return [[{ id: values[0] }], []];
      return [{ affectedRows: 1 }, []];
    }),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn()
  };
  const lockOwnership = vi.fn(async () => undefined);
  const audit = vi.fn(async (_connection: unknown, _event: unknown) => undefined);
  const store = new MysqlNodeIdentityStorage(
    { getConnection: async () => connection } as unknown as Pool,
    { lockOwnership, audit, now: () => 1_000 }
  );
  return { store, connection, lockOwnership, audit };
}

describe('shared Node identity persistence', () => {
  it.each([500, 2000])(
    'recovers only an unused personal token (expiresAt=%s)',
    async (expiresAt) => {
      const { store, connection, audit } = fixture();
      connection.execute.mockResolvedValueOnce([
        [{ expires_at: expiresAt, display_name: 'Local Node' }],
        []
      ] as never);
      const result = await store.recoverPersonalNodeRegistrationToken('previous', 1, 600_000);
      expect(result).toBeDefined();
      if (expiresAt > 1000) {
        expect(result).toEqual({ token: 'previous', expiresAt });
        expect(connection.execute).toHaveBeenCalledTimes(1);
      } else {
        expect(result!.token).not.toBe('previous');
        expect(result!.expiresAt).toBe(601_000);
        expect(
          connection.execute.mock.calls.some(([sql]) =>
            sql.includes('INSERT INTO node_registration_tokens')
          )
        ).toBe(true);
        expect(
          connection.execute.mock.calls.some(([sql]) =>
            /(?:INSERT INTO nodes|DELETE FROM node_registration_tokens)/u.test(sql)
          )
        ).toBe(false);
      }
      const [query, values] = connection.execute.mock.calls[0]!;
      expect(query).toContain('used_at IS NULL');
      expect(query).toContain("owner_type='PERSONAL'");
      expect(query).toContain('FOR UPDATE');
      expect(values.slice(1)).toEqual([1, 1]);
      expect(connection.commit).toHaveBeenCalledOnce();
      expect(connection.beginTransaction).toHaveBeenCalledOnce();
      expect(connection.release).toHaveBeenCalledOnce();
      if (expiresAt > 1000) expect(audit).not.toHaveBeenCalled();
      else {
        expect(audit).toHaveBeenCalledOnce();
        expect(connection.commit.mock.invocationCallOrder[0]).toBeLessThan(
          audit.mock.invocationCallOrder[0]!
        );
      }
    }
  );

  it('refuses recovery of consumed, missing or foreign tokens without creating identities', async () => {
    const { store, connection } = fixture();
    connection.execute.mockResolvedValueOnce([[], []] as never);
    await expect(
      store.recoverPersonalNodeRegistrationToken('unknown', 1, 600_000)
    ).resolves.toBeUndefined();
    expect(connection.execute).toHaveBeenCalledTimes(1);
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
  });

  it('discards replacement audit when recovery commit fails', async () => {
    const { store, connection, audit } = fixture();
    connection.execute.mockResolvedValueOnce([
      [{ expires_at: 500, display_name: 'Local Node' }],
      []
    ] as never);
    connection.commit.mockRejectedValueOnce(new Error('COMMIT_FAILED'));
    await expect(
      store.recoverPersonalNodeRegistrationToken('previous', 1, 600_000)
    ).rejects.toThrow('COMMIT_FAILED');
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
    expect(audit).not.toHaveBeenCalled();
    connection.execute.mockResolvedValueOnce([[{ expires_at: 2000 }], []] as never);
    await store.recoverPersonalNodeRegistrationToken('previous', 1, 600_000);
    expect(audit).not.toHaveBeenCalled();
  });

  it('rolls back recovery when creating the replacement token fails', async () => {
    const { store, connection, lockOwnership } = fixture();
    connection.execute.mockResolvedValueOnce([
      [{ expires_at: 500, display_name: 'Local Node' }],
      []
    ] as never);
    lockOwnership.mockRejectedValueOnce(new Error('ADMISSION_REJECTED'));
    await expect(
      store.recoverPersonalNodeRegistrationToken('previous', 1, 600_000)
    ).rejects.toThrow('ADMISSION_REJECTED');
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it('locks upgrade snapshot updates and rejects disabled nodes before writing', async () => {
    const { store, connection } = fixture();
    connection.execute.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT disabled,upgrade_snapshot'))
        return [[{ id: 'node', disabled: 0, upgrade_snapshot: null }], []];
      return [{ affectedRows: 1 }, []];
    });
    const next = {
      attemptId: 'a',
      targetVersion: '1.0.0',
      state: 'WAITING_FOR_RUNS' as const,
      installed: false,
      targetOnline: false,
      createdAt: 1,
      updatedAt: 1,
      requesterUserId: 1,
      requesterSessionHash: 'session-hash'
    };
    await expect(store.updateNodeUpgrade('node', () => ({ next, result: 'ok' }))).resolves.toBe(
      'ok'
    );
    expect(connection.execute.mock.calls[0]?.[0]).toContain('FOR UPDATE');
    expect(connection.execute.mock.calls[1]?.[1]).toEqual([JSON.stringify(next), 'node']);
    expect(connection.commit).toHaveBeenCalledOnce();
    connection.execute.mockImplementation(async () => [
      [{ id: 'node', disabled: 1, upgrade_snapshot: null }],
      []
    ]);
    await expect(store.updateNodeUpgrade('node', () => ({ next, result: 'bad' }))).rejects.toThrow(
      'NODE_NOT_FOUND'
    );
    expect(connection.rollback).toHaveBeenCalledOnce();
  });

  it('freezes the authorized Node name and rename values before later changes', async () => {
    const { store, connection, audit } = fixture();
    const node = {
      id: 'node-1',
      display_name: 'Original host',
      registered_address: 'host.internal',
      metadata: '{}',
      disabled: 0,
      last_heartbeat_at: 1_000,
      owner_type: 'ORGANIZATION',
      owner_organization_id: 7,
      owner_user_id: null
    };
    connection.execute.mockImplementation(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.startsWith('SELECT * FROM nodes')) return [[{ ...node }], []];
      if (sql.startsWith('UPDATE nodes SET display_name')) {
        node.display_name = String(values[0]);
        return [{ affectedRows: 1 }, []];
      }
      throw new Error('UNEXPECTED_QUERY');
    });
    connection.commit.mockImplementation(async () => {
      node.display_name = 'Later host';
    });
    await expect(store.updateNodeDisplayName('node-1', 'Renamed host', 3)).resolves.toMatchObject({
      displayName: 'Renamed host'
    });
    const event = audit.mock.calls[0]?.[1] as {
      targetName: string;
      organizationId: number;
      metadata: string;
    };
    expect(event).toMatchObject({ targetName: 'Original host', organizationId: 7 });
    expect(JSON.parse(event.metadata)).toMatchObject({
      before: { name: 'Original host' },
      after: { name: 'Renamed host' },
      ownerType: 'ORGANIZATION'
    });
    expect(
      connection.execute.mock.calls.filter(([sql]) => sql.startsWith('SELECT * FROM nodes'))
    ).toHaveLength(1);
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it('checks product admission and writes only a token hash before post-commit audit handoff', async () => {
    const { store, connection, lockOwnership, audit } = fixture();
    const token = await store.createNodeRegistrationToken(1);
    expect(token.expiresAt).toBe(601_000);
    expect(lockOwnership).toHaveBeenCalledWith(connection, {
      ownerType: 'PERSONAL',
      ownerUserId: 1
    });
    expect(lockOwnership.mock.invocationCallOrder[0]).toBeLessThan(
      audit.mock.invocationCallOrder[0]!
    );
    expect(JSON.stringify(connection.execute.mock.calls)).not.toContain(token.token);
    expect(audit.mock.invocationCallOrder[0]).toBeGreaterThan(
      connection.commit.mock.invocationCallOrder[0]!
    );
    expect(connection.release).toHaveBeenCalledOnce();
    expect(connection.commit.mock.invocationCallOrder[0]!).toBeLessThan(
      connection.release.mock.invocationCallOrder[0]!
    );
  });

  it('freezes Node revocation ownership and name before post-commit dispatch', async () => {
    const { store, connection, audit } = fixture();
    const node = {
      id: 'node-1',
      display_name: 'Original host',
      owner_type: 'ORGANIZATION',
      owner_organization_id: 7
    };
    connection.execute.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT')) return [[{ ...node }], []];
      return [{ affectedRows: 1 }, []];
    });
    connection.commit.mockImplementation(async () => {
      node.display_name = 'Later host';
      node.owner_organization_id = 8;
    });
    await expect(store.revokeNode('node-1', 3)).resolves.toBe(true);
    const event = audit.mock.calls[0]?.[1] as { metadata: string };
    expect(event).toMatchObject({
      eventType: 'node_revoked',
      targetName: 'Original host',
      organizationId: 7
    });
    expect(JSON.parse(event.metadata)).toMatchObject({ ownerType: 'ORGANIZATION' });
    expect(audit.mock.invocationCallOrder[0]!).toBeGreaterThan(
      connection.commit.mock.invocationCallOrder[0]!
    );
  });

  it.each(['ownership'])(
    'rolls back %s rejection instead of committing a credential',
    async (failure) => {
      const { store, connection, lockOwnership, audit } = fixture();
      const failing = failure === 'ownership' ? lockOwnership : audit;
      failing.mockRejectedValue(new Error('ADMISSION_REJECTED'));
      await expect(store.createNodeRegistrationToken(1)).rejects.toThrow('ADMISSION_REJECTED');
      expect(connection.commit).not.toHaveBeenCalled();
      expect(connection.rollback).toHaveBeenCalledOnce();
      expect(connection.release).toHaveBeenCalledOnce();
      expect(connection.rollback.mock.invocationCallOrder[0]!).toBeLessThan(
        connection.release.mock.invocationCallOrder[0]!
      );
    }
  );

  it('rejects a consumed or expired token without writing a Node', async () => {
    const { store, connection } = fixture();
    connection.execute.mockResolvedValue([[], []] as never);
    await expect(
      store.registerNode('invalid-fixture', { metadata: '{}' })
    ).resolves.toBeUndefined();
    expect(connection.execute).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledOnce();
  });

  it('commits registration and token consumption even when audit writing fails', async () => {
    const { store, connection, audit } = fixture();
    connection.execute.mockResolvedValueOnce([
      [
        {
          created_by_user_id: 1,
          owner_type: 'PERSONAL',
          owner_user_id: 1,
          owner_organization_id: null,
          display_name: null
        }
      ],
      []
    ] as never);
    audit.mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));
    await expect(store.registerNode('fixture', { metadata: '{}' })).resolves.toBeDefined();
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it('rolls back and releases when the initiating user row is missing', async () => {
    const { store, connection } = fixture();
    connection.execute.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM users')) return [[], []] as never;
      return [{ affectedRows: 1 }, []] as never;
    });

    await expect(store.createNodeRegistrationToken(1)).rejects.toThrow('USER_NOT_FOUND');
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
    expect(connection.rollback.mock.invocationCallOrder[0]!).toBeLessThan(
      connection.release.mock.invocationCallOrder[0]!
    );
  });

  it('protects a Node when a template references one of its workspaces', async () => {
    const { store, connection } = fixture();
    connection.execute.mockImplementation(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes('SELECT id FROM nodes')) return [[{ id: values[0] }], []] as never;
      if (sql.includes('SELECT id FROM conversation_templates')) {
        expect(sql).toContain(
          'source_workspace_id IN (SELECT workspace_id FROM workspaces WHERE node_id=?)'
        );
        expect(values).toEqual(['node-1', 'node-1']);
        return [[{ id: 'template-1' }], []] as never;
      }
      return [{ affectedRows: 1 }, []] as never;
    });

    await expect(store.deleteNode('node-1')).rejects.toThrow('NODE_IN_USE');
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
    expect(connection.rollback.mock.invocationCallOrder[0]!).toBeLessThan(
      connection.release.mock.invocationCallOrder[0]!
    );
  });
});
