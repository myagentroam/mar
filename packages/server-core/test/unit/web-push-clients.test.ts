import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { WebPushClients } from '../../src/web-push-clients.js';

function fixture() {
  let now = 1000;
  const rows = new Map<string, Record<string, unknown>>();
  const sessions = new Map([
    ['session-a', { userId: 1, valid: true }],
    ['session-b', { userId: 1, valid: true }],
    ['session-c', { userId: 2, valid: true }]
  ]);
  const execute = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('SELECT p.* FROM web_push_clients')) {
      const eligible = [...rows.values()].filter((row) => {
        const session = sessions.get(String(row.session_hash));
        return (
          row.user_id === params[0] &&
          row.enabled &&
          session?.valid &&
          session.userId === row.user_id &&
          (row.expiration_time == null || Number(row.expiration_time) > Number(params[2]))
        );
      });
      return [eligible, []];
    }
    if (sql.includes('FROM user_sessions')) {
      const session = sessions.get(String(params[0]));
      return [
        session?.valid && session.userId === params[1] ? [{ user_id: session.userId }] : [],
        []
      ];
    }
    if (sql.includes('SELECT id FROM users')) return [[{ id: params[0] }], []];
    if (sql.startsWith('SELECT * FROM web_push_clients WHERE token_hash='))
      return [[...rows.values()].filter((row) => row.token_hash === params[0]), []];
    if (sql.startsWith('SELECT id FROM web_push_clients WHERE endpoint_hash='))
      return [
        [...rows.values()]
          .filter((row) => row.endpoint_hash === params[0])
          .map((row) => ({ id: row.id })),
        []
      ];
    if (sql.startsWith('SELECT COUNT(*)'))
      return [
        [{ count: [...rows.values()].filter((row) => row.user_id === params[0]).length }],
        []
      ];
    if (sql.startsWith('INSERT INTO web_push_clients')) {
      const columns = [
        'id',
        'user_id',
        'session_hash',
        'token_hash',
        'endpoint_hash',
        'endpoint',
        'p256dh',
        'auth_secret',
        'expiration_time',
        'enabled',
        'binding_version',
        'created_at',
        'updated_at'
      ];
      const row = Object.fromEntries(columns.map((key, index) => [key, params[index]]));
      rows.set(String(row.id), row);
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith('UPDATE web_push_clients SET')) {
      const [
        userId,
        sessionHash,
        endpointHash,
        endpoint,
        p256dh,
        auth,
        expiration,
        enabled,
        version,
        updated,
        id
      ] = params;
      Object.assign(rows.get(String(id))!, {
        user_id: userId,
        session_hash: sessionHash,
        endpoint_hash: endpointHash,
        endpoint,
        p256dh,
        auth_secret: auth,
        expiration_time: expiration,
        enabled,
        binding_version: version,
        updated_at: updated
      });
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith('DELETE FROM web_push_clients WHERE id=')) {
      const row = rows.get(String(params[0]));
      const matches = row?.binding_version === params[1] && row?.endpoint_hash === params[2];
      if (matches) rows.delete(String(params[0]));
      return [{ affectedRows: Number(matches) }, []];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  let snapshot: [string, Record<string, unknown>][];
  const connection = {
    execute,
    beginTransaction: vi.fn(async () => {
      snapshot = structuredClone([...rows]);
    }),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => {
      rows.clear();
      for (const [key, value] of snapshot) rows.set(key, value);
    }),
    release: vi.fn()
  };
  const service = new WebPushClients(
    { raw: { execute, getConnection: async () => connection } } as never,
    () => now
  );
  const input = (n: number) => ({
    clientKind: 'mobile' as const,
    clientToken: createHash('sha256').update(`test-client-token-${n}`).digest('base64url'),
    subscription: {
      endpoint: `https://fcm.googleapis.com/fcm/send/client-${n}`,
      keys: {
        p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, n)]).toString('base64url'),
        auth: Buffer.alloc(16, n).toString('base64url')
      }
    }
  });
  return {
    rows,
    sessions,
    service,
    input,
    connection,
    advance: () => {
      now++;
    }
  };
}

const actor = { userId: 1, sessionHash: 'session-a' };

describe('Web Push client ownership and lifecycle', () => {
  it('retains three independent clients and recovers a lost first response without duplicates', async () => {
    const { service, rows, input } = fixture();
    const first = await service.register(actor, input(1));
    await service.register(actor, input(2));
    await service.register(actor, input(3));
    expect(await service.register(actor, input(1))).toEqual(first);
    expect(rows.size).toBe(3);
    expect(first).toEqual({ subscriptionId: expect.any(String), bindingVersion: 1, enabled: true });
    expect(JSON.stringify([...rows.values()])).not.toContain(input(1).clientToken);
  });

  it.each([true, false])(
    'does not advance an unchanged binding when enabled=%s',
    async (enabled) => {
      const { service, input, connection } = fixture();
      const first = await service.register(actor, { ...input(1), enabled });
      connection.execute.mockClear();
      expect(
        await service.register(actor, {
          ...input(1),
          enabled,
          bindingVersion: first.bindingVersion
        })
      ).toEqual(first);
      expect(
        connection.execute.mock.calls.some(([sql]) => sql.startsWith('UPDATE web_push_clients'))
      ).toBe(false);
    }
  );

  it('keeps a disabled first record disabled when registration arrives late', async () => {
    const { service, input, rows } = fixture();
    const disabled = await service.register(actor, { ...input(1), enabled: false });
    expect(await service.register(actor, input(1))).toEqual(disabled);
    expect([...rows.values()][0]?.enabled).toBe(false);
  });

  it('disables only the selected client and requires an expected version to enable it again', async () => {
    const { service, rows, input } = fixture();
    const a = await service.register(actor, input(1));
    await service.register(actor, input(2));
    const disabled = await service.register(actor, {
      ...input(1),
      enabled: false,
      bindingVersion: a.bindingVersion
    });
    expect(disabled.enabled).toBe(false);
    expect([...rows.values()].filter((row) => row.enabled)).toHaveLength(1);
    const enabled = await service.register(actor, {
      ...input(1),
      bindingVersion: disabled.bindingVersion
    });
    expect(enabled.enabled).toBe(true);
    await expect(
      service.register(actor, { ...input(1), enabled: false, bindingVersion: a.bindingVersion })
    ).rejects.toThrow('WEB_PUSH_BINDING_STALE');
    await expect(service.register(actor, { ...input(1), enabled: false })).rejects.toThrow(
      'WEB_PUSH_BINDING_STALE'
    );
  });

  it('rejects endpoint claims without the original token, even for the same user', async () => {
    const { service, input } = fixture();
    await service.register(actor, input(1));
    await expect(
      service.register(actor, { ...input(2), subscription: input(1).subscription })
    ).rejects.toThrow('WEB_PUSH_CLIENT_CONFLICT');
  });

  it('rejects changing subscription material through first-registration recovery', async () => {
    const { service, input } = fixture();
    await service.register(actor, input(1));
    await expect(
      service.register(actor, { ...input(1), subscription: input(2).subscription })
    ).rejects.toThrow('WEB_PUSH_CLIENT_CONFLICT');
  });

  it('rejects a legacy registration without client kind before opening a transaction', async () => {
    const { service, input, connection, rows } = fixture();
    const { clientKind: _clientKind, ...legacyRegistration } = input(1);
    await expect(service.register(actor, legacyRegistration)).rejects.toThrow(
      'WEB_PUSH_INPUT_INVALID'
    );
    expect(rows.size).toBe(0);
    expect(connection.beginTransaction).not.toHaveBeenCalled();
  });

  it('rebinds to a new login only explicitly and rejects old-session cleanup', async () => {
    const { service, input, rows } = fixture();
    const first = await service.register(actor, input(1));
    await expect(
      service.register({ ...actor, sessionHash: 'session-b' }, input(1))
    ).rejects.toThrow('WEB_PUSH_BINDING_STALE');
    const rebound = await service.register(
      { ...actor, sessionHash: 'session-b' },
      { ...input(1), bindingVersion: first.bindingVersion }
    );
    await expect(
      service.register(actor, { ...input(1), enabled: false, bindingVersion: first.bindingVersion })
    ).rejects.toThrow('WEB_PUSH_BINDING_STALE');
    expect(rebound.bindingVersion).toBe(2);
    expect([...rows.values()][0]?.session_hash).toBe('session-b');
  });

  it('rejects cross-account replay but permits an explicit token-proven versioned rebind', async () => {
    const { service, input } = fixture();
    const first = await service.register(actor, input(1));
    const other = { userId: 2, sessionHash: 'session-c' };
    await expect(service.register(other, input(1))).rejects.toThrow('WEB_PUSH_CLIENT_CONFLICT');
    const rebound = await service.register(other, {
      ...input(1),
      bindingVersion: first.bindingVersion
    });
    expect(rebound.bindingVersion).toBe(2);
    await expect(service.register(actor, input(1))).rejects.toThrow('WEB_PUSH_CLIENT_CONFLICT');
  });

  it('does not let an old 410 response delete rotated subscription material', async () => {
    const { service, input, rows } = fixture();
    const first = await service.register(actor, input(1));
    await service.register(actor, {
      ...input(1),
      subscription: input(2).subscription,
      bindingVersion: first.bindingVersion
    });
    expect(await service.expire({ ...first, endpoint: input(1).subscription.endpoint })).toBe(
      false
    );
    expect(rows.size).toBe(1);
    expect([...rows.values()][0]?.endpoint_hash).toBe(
      createHash('sha256').update(input(2).subscription.endpoint).digest('hex')
    );
  });

  it('rejects a revoked session before mutating a client', async () => {
    const { service, input, sessions, rows } = fixture();
    sessions.get(actor.sessionHash)!.valid = false;
    await expect(service.register(actor, input(1))).rejects.toThrow('WEB_PUSH_SESSION_INVALID');
    expect(rows.size).toBe(0);
  });

  it.each([
    'https://uccm-intl.ucweb.com/wpush/m/fixture',
    'https://updates.push.services.mozilla.com/wpush/v2/fixture',
    'https://push.example.test:8443/up/fixture?token=fixture',
    'https://localhost/a',
    'https://127.0.0.1:8443/a',
    'https://[::1]:8443/a'
  ])(
    'registers a standard HTTPS endpoint without provider or address restrictions: %s',
    async (endpoint) => {
      const { service, input } = fixture();
      const subscription = { ...input(1).subscription, endpoint };
      const binding = await service.register(actor, { ...input(1), subscription });
      const [client] = await service.eligible(actor.userId);
      expect(client?.subscriptionId).toBe(binding.subscriptionId);
      expect(client?.subscription).toEqual({ ...subscription, expirationTime: null });
    }
  );

  it.each([
    'not a URL',
    'http://fcm.googleapis.com/a',
    'https://user:pass@fcm.googleapis.com/a',
    'https://fcm.googleapis.com/a#fragment'
  ])('rejects a malformed or non-HTTPS endpoint %s', async (endpoint) => {
    const { service, input, rows } = fixture();
    await expect(
      service.register(actor, { ...input(1), subscription: { ...input(1).subscription, endpoint } })
    ).rejects.toThrow('WEB_PUSH_INPUT_INVALID');
    expect(rows.size).toBe(0);
  });

  it('rolls back a failed insert without retaining partial registration state', async () => {
    const { service, input, connection, rows } = fixture();
    connection.commit.mockRejectedValueOnce(new Error('commit failed'));
    await expect(service.register(actor, input(1))).rejects.toThrow('commit failed');
    expect(rows.size).toBe(0);
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it('selects only enabled, session-authorized, unexpired clients of the recipient', async () => {
    const { service, input, sessions, rows } = fixture();
    const active = await service.register(actor, input(1));
    await service.register(actor, { ...input(2), enabled: false });
    await service.register({ ...actor, sessionHash: 'session-b' }, input(3));
    await service.register({ userId: 2, sessionHash: 'session-c' }, input(4));
    const expired = await service.register(actor, {
      ...input(5),
      subscription: { ...input(5).subscription, expirationTime: 2000 }
    });
    rows.get(expired.subscriptionId)!.expiration_time = 999;
    sessions.get('session-b')!.valid = false;
    const eligible = await service.eligible(actor.userId);
    expect(eligible.map((entry) => entry.subscriptionId)).toEqual([active.subscriptionId]);
    expect(eligible[0]?.subscription).toEqual({ ...input(1).subscription, expirationTime: null });
  });

  it('rejects a new client at the cap without evicting old clients or blocking recovery', async () => {
    const { service, input, rows } = fixture();
    for (let n = 1; n <= 32; n++) await service.register(actor, input(n));
    await expect(service.register(actor, input(33))).rejects.toThrow('WEB_PUSH_CLIENT_LIMIT');
    expect(rows.size).toBe(32);
    expect((await service.register(actor, input(1))).bindingVersion).toBe(1);
  });

  it('rejects expired subscription material and caller-supplied user identity', async () => {
    const { service, input, rows } = fixture();
    await expect(
      service.register(actor, {
        ...input(1),
        subscription: { ...input(1).subscription, expirationTime: 999 }
      })
    ).rejects.toThrow('WEB_PUSH_INPUT_INVALID');
    await expect(service.register(actor, { ...input(1), userId: 2 })).rejects.toThrow(
      'WEB_PUSH_INPUT_INVALID'
    );
    expect(rows.size).toBe(0);
  });

  it('allows disabling an expired subscription without restoring its delivery eligibility', async () => {
    const { service, input, rows } = fixture();
    const disabled = await service.register(actor, {
      ...input(1),
      subscription: { ...input(1).subscription, expirationTime: 999 },
      enabled: false
    });
    expect(disabled.enabled).toBe(false);
    expect(rows.size).toBe(1);
    expect(await service.eligible(actor.userId)).toEqual([]);
  });
});
