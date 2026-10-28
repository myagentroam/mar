import { describe, expect, it, vi } from 'vitest';
import { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import type { AuthorizationService } from '../../ee/server/src/rbac/authorization-service.js';
import { AUDIT_PAGE_SIZE, AuditService } from '../../ee/server/src/audit/audit-service.js';
import { scopedAuditEvent } from '../../ee/server/src/audit/audit-policy.js';

describe('Server structured audit', () => {
  it('captures linked resource names without replacing existing historical snapshots', async () => {
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes('FROM workspaces')) return [[{ display_name: 'Team workspace' }], []];
      if (sql.includes('FROM organizations')) return [[{ name: 'Team organization' }], []];
      if (sql.includes('FROM users')) return [[{ username: 'granted-member' }], []];
      throw new Error('Unexpected name lookup');
    });
    const event = await scopedAuditEvent({ execute } as never, {
      eventType: 'resource.grant.created',
      targetType: 'MODEL',
      targetId: 'model-1',
      targetName: 'Historical model',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      organizationId: 7,
      metadata: JSON.stringify({
        nodeName: 'Historical Node',
        sessionName: 'Historical session',
        targetUserId: 8,
        targetOrganizationId: 9
      })
    });
    expect(event?.targetName).toBe('Historical model');
    expect(JSON.parse(event!.metadata!)).toMatchObject({
      nodeName: 'Historical Node',
      workspaceName: 'Team workspace',
      sessionName: 'Historical session',
      organizationName: 'Team organization',
      targetUserName: 'granted-member',
      targetOrganizationName: 'Team organization'
    });
    expect(execute.mock.calls.some(([sql]) => sql.includes('FROM nodes'))).toBe(false);
  });

  it.each(['MODEL', 'IMAGE_MODEL', 'TEMPLATE', 'USER', 'SKILL_SOURCE', 'MCP_SOURCE'])(
    'fills a missing %s target name without changing frozen ownership',
    async (targetType) => {
      const execute = vi.fn(async (_sql: string) => [
        [{ target_name: 'Friendly target', name: 'Team' }],
        []
      ]);
      const event = await scopedAuditEvent({ execute } as never, {
        eventType: 'resource.grant.created',
        targetType,
        targetId: 'resource-1',
        organizationId: 7
      });
      expect(event).toMatchObject({ targetName: 'Friendly target', organizationId: 7 });
      expect(execute.mock.calls.every((call) => !String(call[0]).includes('owner_type'))).toBe(
        true
      );
    }
  );

  it('does not lose an otherwise scoped event when optional name collection fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const execute = vi.fn(async () => {
        throw new Error('Optional name lookup failed');
      });
      const event = await scopedAuditEvent({ execute } as never, {
        eventType: 'model.updated',
        targetType: 'MODEL',
        targetId: 'model-1',
        organizationId: 7
      });
      expect(event).toMatchObject({ targetName: 'model-1', organizationId: 7 });
      expect(warn).toHaveBeenCalledWith('AUDIT_NAME_SNAPSHOT_FAILED');
    } finally {
      warn.mockRestore();
    }
  });

  it('dispatches audit writes independently from an exhausted business pool', async () => {
    const businessExecute = vi.fn(async () => {
      throw new Error('BUSINESS_POOL_EXHAUSTED');
    });
    const auditExecute = vi.fn(async (_sql: string, _params: readonly unknown[]) => [
      { affectedRows: 1 },
      []
    ]);
    const businessEnd = vi.fn(async () => undefined);
    const auditEnd = vi.fn(async () => undefined);
    const database = new MysqlServerDatabase(
      { execute: businessExecute, end: businessEnd } as never,
      () => 123,
      { execute: auditExecute, end: auditEnd } as never
    );
    await database.audit({
      eventType: 'node_revoked',
      nodeId: 'node-1',
      organizationId: 7,
      targetName: 'Host'
    });
    await vi.waitFor(() =>
      expect(
        auditExecute.mock.calls.filter(([sql]) => sql.includes('INSERT INTO audit_events'))
      ).toHaveLength(1)
    );
    expect(businessExecute).not.toHaveBeenCalled();
    await database.close();
    expect(businessEnd).toHaveBeenCalledOnce();
    expect(auditEnd).toHaveBeenCalledOnce();
  });

  it('whitelists metadata and never persists conversation content', async () => {
    const audit = vi.fn(async () => undefined);
    const dispatchAudit = vi.fn((task: () => Promise<void>) => {
      void Promise.resolve()
        .then(task)
        .catch(() => undefined);
    });
    const service = new AuditService(
      { audit, dispatchAudit } as unknown as MysqlServerDatabase,
      {} as AuthorizationService
    );
    await service.record({
      eventType: 'conversation_input',
      actorUserId: 2,
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      agentSessionId: 'session-1',
      clientMessageId: 'message-1',
      metadata: JSON.stringify({ action: 'SEND', content: 'secret', password: 'secret' })
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: JSON.stringify({ action: 'SEND' }),
        agentSessionId: 'session-1'
      })
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain('secret');
  });

  it('does not propagate record observer failure to its caller', async () => {
    const audit = vi.fn(async () => {
      throw new Error('audit unavailable');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const service = new AuditService(
        { audit } as unknown as MysqlServerDatabase,
        {} as AuthorizationService
      );
      await expect(
        service.record({ eventType: 'user.updated', actorUserId: 2 })
      ).resolves.toBeUndefined();
      await Promise.resolve();
      expect(audit).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith('AUDIT_WRITE_FAILED');
    } finally {
      warn.mockRestore();
    }
  });

  it('filters ORG_ADMIN reads to managed organizations and paginates stably', async () => {
    const query = vi.fn(async (sql: string, params: readonly unknown[]) => {
      void sql;
      void params;
      return [[auditRow('b', 20, 2), auditRow('a', 10, 3), auditRow('overflow', 5, 2)], []];
    });
    const execute = vi.fn(async (sql: string) =>
      sql.includes('SELECT role') ? [[{ role: 'ORG_ADMIN' }], []] : [[], []]
    );
    const authorization = {
      managedOrganizationIds: vi.fn(async () => [2, 3]),
      authorize: vi.fn(async () => ({ allowed: true }))
    };
    const service = new AuditService(
      { raw: { execute }, auditRaw: { query } } as unknown as MysqlServerDatabase,
      authorization as unknown as AuthorizationService
    );
    const result = await service.query(7, { limit: 2, from: 8, to: 21 });
    expect(result.events).toHaveLength(2);
    expect(result.nextCursor).toBeTruthy();
    const queryCall = query.mock.calls[0] as unknown as [string, readonly unknown[]];
    expect(queryCall[0]).not.toContain('user_message');
    expect(queryCall[1]).toEqual([[2, 3], 8, 21, 3]);
  });

  it('returns the requested server page and real total without a client batch', async () => {
    const connection = {
      beginTransaction: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      release: vi.fn(),
      query: vi.fn(async (sql: string) =>
        sql.includes('COUNT(*)')
          ? [[{ total: 45 }], []]
          : [[auditRow('page-2', 30, 2), auditRow('older', 20, 2), auditRow('overflow', 10, 2)], []]
      )
    };
    const service = new AuditService(
      {
        raw: { execute: vi.fn(async () => [[{ role: 'ADMIN' }], []]) },
        auditRaw: { getConnection: vi.fn(async () => connection) }
      } as unknown as MysqlServerDatabase,
      { managedOrganizationIds: vi.fn(), authorize: vi.fn() } as unknown as AuthorizationService
    );

    const result = await service.query(1, { page: 2, limit: 2, from: 8, to: 40 });

    expect(result).toMatchObject({ total: 45, page: 2 });
    expect(result.events.map((event) => (event as { id: string }).id)).toEqual(['page-2', 'older']);
    expect(result.nextCursor).toBeTruthy();
    const countCall = connection.query.mock.calls[0] as unknown as [string, readonly unknown[]];
    const listCall = connection.query.mock.calls[1] as unknown as [string, readonly unknown[]];
    expect(countCall[0]).toContain('COUNT(*)');
    expect(countCall[0]).not.toContain('user_message');
    expect(countCall[1]).toEqual([8, 40]);
    expect(listCall[0]).toContain('OFFSET');
    expect(listCall[1]).toEqual([8, 40, 3, 2]);
    expect(AUDIT_PAGE_SIZE).toBe(20);
  });

  it('defaults an omitted audit page size to 20', async () => {
    const query = vi.fn(async () => [[], []]);
    const service = new AuditService(
      {
        raw: { execute: vi.fn(async () => [[{ role: 'ADMIN' }], []]) },
        auditRaw: { query }
      } as unknown as MysqlServerDatabase,
      { managedOrganizationIds: vi.fn(), authorize: vi.fn() } as unknown as AuthorizationService
    );

    await service.query(1);

    const params = (query.mock.calls[0] as unknown as [string, readonly unknown[]])[1];
    expect(params).toEqual([AUDIT_PAGE_SIZE + 1]);
  });

  it('reads conversation text only from an authorized detail query', async () => {
    const businessQuery = vi.fn();
    const businessExecute = vi.fn(async () => [[{ role: 'ORG_ADMIN' }], []]);
    const query = vi.fn(async (sql: string, params: readonly unknown[]) => {
      void sql;
      void params;
      return [
        [
          {
            ...auditRow('event-1', 20, 2),
            target_name: 'Architecture review',
            has_conversation_payload: 1,
            conversation_id: 'session-1',
            conversation_title: 'Architecture review',
            user_message: 'Inspect the access controls.',
            queue_item_id: null
          }
        ],
        []
      ];
    });
    const authorization = {
      managedOrganizationIds: vi.fn(async () => [2]),
      authorize: vi.fn(async () => ({ allowed: true }))
    };
    const service = new AuditService(
      {
        raw: {
          execute: businessExecute,
          query: businessQuery
        },
        auditRaw: { query }
      } as unknown as MysqlServerDatabase,
      authorization as unknown as AuthorizationService
    );

    await expect(service.detail(7, 'event-1')).resolves.toMatchObject({
      id: 'event-1',
      hasConversationPayload: true,
      conversationPayload: {
        conversationId: 'session-1',
        conversationTitle: 'Architecture review',
        userMessage: 'Inspect the access controls.'
      }
    });
    expect(query.mock.calls[0]?.[0]).toContain('LEFT JOIN audit_conversation_payloads');
    expect(query.mock.calls[0]?.[0]).toContain('AS has_conversation_payload');
    expect(query.mock.calls[0]?.[1]).toEqual(['event-1', [2]]);
    expect(query.mock.calls[0]?.[0]).toContain('LIMIT 1');
    expect(businessExecute).toHaveBeenCalledWith(
      'SELECT role FROM users WHERE id=? AND enabled=TRUE',
      [7]
    );
    expect(authorization.authorize).toHaveBeenCalledWith(7, 'AUDIT_READ', {
      ownerType: 'ORGANIZATION',
      organizationId: 2
    });
    expect(businessQuery).not.toHaveBeenCalled();
  });

  it('keeps a queue item id in the audit event header without a conversation payload', async () => {
    const query = vi.fn(async (sql: string, params: readonly unknown[]) => {
      void sql;
      void params;
      return [
        [
          {
            ...auditRow('event-queue-1', 20, 2),
            queue_item_id: 'queue-1',
            has_conversation_payload: 0,
            conversation_id: null,
            conversation_title: null,
            user_message: null
          }
        ],
        []
      ];
    });
    const service = new AuditService(
      {
        raw: {
          execute: vi.fn(async () => [[{ role: 'ORG_ADMIN' }], []])
        },
        auditRaw: { query }
      } as unknown as MysqlServerDatabase,
      {
        managedOrganizationIds: vi.fn(async () => [2]),
        authorize: vi.fn(async () => ({ allowed: true }))
      } as unknown as AuthorizationService
    );

    await expect(service.detail(7, 'event-queue-1')).resolves.toMatchObject({
      id: 'event-queue-1',
      queueItemId: 'queue-1',
      hasConversationPayload: false
    });
    expect(query.mock.calls[0]?.[0]).toContain('event.queue_item_id');
  });

  it.each(['detail', 'export'] as const)(
    'does not query %s when a MEMBER lacks an audit scope',
    async (operation) => {
      const query = vi.fn();
      const businessQuery = vi.fn();
      const service = new AuditService(
        {
          raw: {
            execute: vi.fn(async () => [[{ role: 'MEMBER' }], []]),
            query: businessQuery
          },
          auditRaw: { query }
        } as unknown as MysqlServerDatabase,
        {
          managedOrganizationIds: vi.fn(async () => []),
          authorize: vi.fn(async () => ({ allowed: false, reason: 'RBAC_DENIED' }))
        } as unknown as AuthorizationService
      );

      const result = operation === 'detail' ? service.detail(8, 'event-1') : service.export(8);
      await expect(result).rejects.toThrow('RBAC_DENIED');
      expect(query).not.toHaveBeenCalled();
      expect(businessQuery).not.toHaveBeenCalled();
    }
  );

  it('defaults retention, normalizes cleanup limits and cleans in batches', async () => {
    const connectionSql: string[] = [];
    const connection = {
      beginTransaction: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      release: vi.fn(),
      execute: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        void params;
        connectionSql.push(sql.replace(/\s+/g, ' ').trim());
        if (sql.startsWith('SELECT id FROM audit_events'))
          return [[{ id: 'event-1' }, { id: 'event-2' }], []];
        if (sql.startsWith('DELETE FROM audit_events')) return [{ affectedRows: 12 }, []];
        return [{ affectedRows: 1 }, []];
      })
    };
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT setting_value')) return [[], []];
      return [{ affectedRows: 1 }, []];
    });
    const businessGetConnection = vi.fn();
    const auditGetConnection = vi.fn(async () => connection);
    const service = new AuditService(
      {
        raw: {
          execute,
          getConnection: businessGetConnection
        },
        auditRaw: { getConnection: auditGetConnection }
      } as unknown as MysqlServerDatabase,
      { authorize: vi.fn(async () => ({ allowed: true })) } as unknown as AuthorizationService,
      () => 200 * 24 * 60 * 60 * 1000
    );
    expect(await service.retentionDays()).toBe(180);
    await expect(service.setRetentionDays(1, 0)).rejects.toThrow('AUDIT_RETENTION_INVALID');
    expect(await service.cleanupBatch()).toBe(12);
    expect(connectionSql).toEqual([
      'SELECT id FROM audit_events WHERE occurred_at<? ORDER BY occurred_at,id LIMIT 1000 FOR UPDATE',
      'DELETE FROM audit_conversation_payloads WHERE audit_event_id IN (?,?)',
      'DELETE FROM audit_events WHERE id IN (?,?)'
    ]);
    expect(connection.execute.mock.calls[0]?.[1]).toEqual([20 * 24 * 60 * 60 * 1000]);
    expect(connection.execute.mock.calls[1]?.[1]).toEqual(['event-1', 'event-2']);
    expect(connection.execute.mock.calls[2]?.[1]).toEqual(['event-1', 'event-2']);
    expect(connection.beginTransaction).toHaveBeenCalledTimes(1);
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(auditGetConnection).toHaveBeenCalledTimes(1);
    expect(businessGetConnection).not.toHaveBeenCalled();
    expect(execute.mock.calls.every(([sql]) => sql.includes('SELECT setting_value'))).toBe(true);

    connectionSql.length = 0;
    connection.execute.mockClear();
    await expect(service.cleanupBatch(Number.NaN)).resolves.toBe(12);
    expect(connectionSql[0]).toBe(
      'SELECT id FROM audit_events WHERE occurred_at<? ORDER BY occurred_at,id LIMIT 1000 FOR UPDATE'
    );
    expect(connection.execute.mock.calls[0]?.[1]).toEqual([20 * 24 * 60 * 60 * 1000]);

    connectionSql.length = 0;
    connection.execute.mockClear();
    await expect(service.cleanupBatch(Number.POSITIVE_INFINITY)).resolves.toBe(12);
    expect(connectionSql[0]).toBe(
      'SELECT id FROM audit_events WHERE occurred_at<? ORDER BY occurred_at,id LIMIT 1000 FOR UPDATE'
    );

    connectionSql.length = 0;
    connection.execute.mockClear();
    await expect(service.cleanupBatch(10_000.75)).resolves.toBe(12);
    expect(connectionSql[0]).toBe(
      'SELECT id FROM audit_events WHERE occurred_at<? ORDER BY occurred_at,id LIMIT 10000 FOR UPDATE'
    );
  });

  it('Only system-configuration managers can read audit retention settings', async () => {
    const execute = vi.fn(async () => [[], []]);
    const authorization = {
      authorize: vi.fn(async () => ({ allowed: false, reason: 'RBAC_DENIED' }))
    };
    const service = new AuditService(
      { raw: { execute } } as unknown as MysqlServerDatabase,
      authorization as unknown as AuthorizationService
    );

    await expect(service.readRetentionDays(7)).rejects.toThrow('RBAC_DENIED');
    expect(authorization.authorize).toHaveBeenCalledWith(7, 'SYSTEM_SETTINGS_MANAGE', {
      ownerType: 'SYSTEM'
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rolls back failed cleanup on the same audit connection', async () => {
    const failure = new Error('AUDIT_DELETE_FAILED');
    const connection = {
      beginTransaction: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      release: vi.fn(),
      execute: vi.fn(async (sql: string) => {
        if (sql.startsWith('SELECT id FROM audit_events')) return [[{ id: 'event-1' }], []];
        throw failure;
      })
    };
    const businessGetConnection = vi.fn();
    const auditGetConnection = vi.fn(async () => connection);
    const service = new AuditService(
      {
        raw: {
          execute: vi.fn(async () => [[{ setting_value: '30' }], []]),
          getConnection: businessGetConnection
        },
        auditRaw: { getConnection: auditGetConnection }
      } as unknown as MysqlServerDatabase,
      {} as AuthorizationService
    );

    await expect(service.cleanupBatch(2)).rejects.toBe(failure);

    expect(auditGetConnection).toHaveBeenCalledOnce();
    expect(businessGetConnection).not.toHaveBeenCalled();
    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    expect(connection.execute).toHaveBeenCalledTimes(2);
    expect(connection.execute.mock.calls[1]?.[0]).toContain(
      'DELETE FROM audit_conversation_payloads'
    );
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it('The fixed Community administrator can read system settings without an activated License', async () => {
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes('is_fixed_admin'))
        return [[{ is_fixed_admin: 1, role: null, organization_id: null }], []];
      if (sql.includes('SELECT setting_value')) return [[{ setting_value: '180' }], []];
      return [[], []];
    });
    const authorization = {
      authorize: vi.fn(async () => ({ allowed: false, reason: 'RBAC_ACTOR_INVALID' })),
      isPersonalAdmin: vi.fn(async () => true)
    };
    const service = new AuditService(
      { raw: { execute } } as unknown as MysqlServerDatabase,
      authorization as unknown as AuthorizationService
    );

    await expect(service.readRetentionDays(1)).resolves.toBe(180);
    expect(authorization.isPersonalAdmin).toHaveBeenCalledWith(1);
  });

  it('CSV exports include only the selected time range and neutralize spreadsheet formula prefixes', async () => {
    const businessQuery = vi.fn();
    const businessExecute = vi.fn(async () => [[{ role: 'ADMIN' }], []]);
    const row = { ...auditRow('event-1', 20, 1), actor_username: '=IMPORTXML("https://bad")' };
    const query = vi.fn(async (sql: string, params: readonly unknown[]) => {
      void sql;
      void params;
      return [[row], []];
    });
    const service = new AuditService(
      {
        raw: {
          execute: businessExecute,
          query: businessQuery
        },
        auditRaw: { query }
      } as unknown as MysqlServerDatabase,
      {} as AuthorizationService
    );

    const csv = await service.export(1, { from: 10, to: 30 });

    expect(csv).toContain('"\'=IMPORTXML(""https://bad"")"');
    expect(csv).not.toContain(',=IMPORTXML');
    expect(query.mock.calls[0]?.[1]).toEqual([10, 30, 10_000]);
    expect(query.mock.calls[0]?.[0]).toContain('ORDER BY occurred_at DESC,id DESC LIMIT ?');
    expect(query.mock.calls[0]?.[0]).not.toContain('user_message');
    expect(businessExecute).toHaveBeenCalledWith(
      'SELECT role FROM users WHERE id=? AND enabled=TRUE',
      [1]
    );
    expect(businessQuery).not.toHaveBeenCalled();
  });

  it('exports only the managed organization scope through the audit pool', async () => {
    const businessQuery = vi.fn();
    const query = vi.fn(async (_sql: string, _params: readonly unknown[]) => [
      [auditRow('scoped-event', 20, 2)],
      []
    ]);
    const authorization = {
      managedOrganizationIds: vi.fn(async () => [2, 3]),
      authorize: vi.fn(async () => ({ allowed: true }))
    };
    const service = new AuditService(
      {
        raw: {
          execute: vi.fn(async () => [[{ role: 'ORG_ADMIN' }], []]),
          query: businessQuery
        },
        auditRaw: { query }
      } as unknown as MysqlServerDatabase,
      authorization as unknown as AuthorizationService
    );

    const csv = await service.export(7, { from: 10, to: 30 });

    expect(csv).toContain('scoped-event');
    expect(query.mock.calls[0]?.[0]).toContain(
      'WHERE organization_id IN (?) AND occurred_at>=? AND occurred_at<=?'
    );
    expect(query.mock.calls[0]?.[1]).toEqual([[2, 3], 10, 30, 10_000]);
    expect(authorization.authorize).toHaveBeenCalledWith(7, 'AUDIT_EXPORT', {
      ownerType: 'ORGANIZATION',
      organizationId: 2
    });
    expect(businessQuery).not.toHaveBeenCalled();
  });

  it('resolves organization ownership through owner_type and scope resource mappings', async () => {
    const execute = vi.fn(async (sql: string, _params: readonly unknown[]) => {
      if (sql.includes('FROM workspaces'))
        return [
          [
            {
              target_name: 'Shared workspace',
              owner_type: 'ORGANIZATION',
              owner_organization_id: 23
            }
          ],
          []
        ];
      if (sql.includes('FROM skill_sources'))
        return [
          [{ target_name: 'Team skills', owner_type: 'ORGANIZATION', owner_organization_id: 23 }],
          []
        ];
      if (sql.includes('FROM nodes')) return [[{ display_name: 'Shared Node' }], []];
      if (sql.includes('FROM organizations')) return [[{ name: 'Shared organization' }], []];
      throw new Error(`Unexpected query: ${sql}`);
    });
    const pool = { execute } as never;

    const sessionEvent = await scopedAuditEvent(pool, {
      eventType: 'session.audit.snapshot',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      targetType: 'SESSION',
      targetId: 'session-1',
      metadata: '{}'
    });
    const skillEvent = await scopedAuditEvent(pool, {
      eventType: 'skill_source.updated',
      targetType: 'SKILL_SOURCE',
      targetId: 'source-1',
      metadata: '{}'
    });

    expect(sessionEvent).toMatchObject({
      targetName: 'session-1',
      organizationId: 23,
      metadata: JSON.stringify({
        workspaceName: 'Shared workspace',
        nodeName: 'Shared Node',
        organizationName: 'Shared organization',
        category: 'ORGANIZATION'
      })
    });
    expect(skillEvent).toMatchObject({
      targetName: 'Team skills',
      organizationId: 23,
      metadata: JSON.stringify({
        organizationName: 'Shared organization',
        category: 'ORGANIZATION'
      })
    });
    expect(execute.mock.calls[0]?.[1]).toEqual(['workspace-1', 'node-1']);
    expect(
      execute.mock.calls.some(
        (call) =>
          call[0].includes('FROM skill_sources') &&
          JSON.stringify(call[1]) === JSON.stringify(['source-1'])
      )
    ).toBe(true);
  });

  it.each(['operation'])('does not persist legacy generic audit event %s', async (eventType) => {
    const execute = vi.fn();
    await expect(
      scopedAuditEvent({ execute } as never, {
        eventType,
        metadata: '{invalid legacy payload'
      })
    ).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    'relay_requested',
    'relay_completed',
    'relay_failed',
    'conversation_hosting_storage_inspected',
    'conversation_hosting_cleanup_previewed'
  ])('filters legacy generic event %s before reading metadata', async (eventType) => {
    const execute = vi.fn();
    await expect(
      scopedAuditEvent({ execute } as never, {
        eventType,
        metadata: '{invalid legacy payload'
      })
    ).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps explicit system mail tests without requiring a Node or organization', async () => {
    const event = {
      eventType: 'mail.test.executed',
      actorUserId: 1,
      targetType: 'MAIL_TEMPLATE',
      targetId: 'notification-en-US',
      targetName: 'notification-en-US'
    };
    const execute = vi.fn(async () => [[], []]);
    const scoped = await scopedAuditEvent({ execute } as never, event);
    expect(scoped).toMatchObject(event);
    expect(execute).not.toHaveBeenCalled();
  });

  it('resolves template ownership through its hosting Node rather than nonexistent template columns', async () => {
    const execute = vi.fn(async (sql: string) => {
      expect(sql).toContain('JOIN nodes');
      expect(sql).toContain('template.source_node_id');
      return [
        [{ target_name: 'Team template', owner_type: 'ORGANIZATION', owner_organization_id: 7 }],
        []
      ];
    });
    await expect(
      scopedAuditEvent({ execute } as never, {
        eventType: 'conversation_template.created',
        targetType: 'TEMPLATE',
        targetId: 'template-1'
      })
    ).resolves.toMatchObject({ targetName: 'Team template', organizationId: 7 });
  });

  it('uses frozen environment-secret ownership instead of querying its later scope', async () => {
    const execute = vi.fn();
    await expect(
      scopedAuditEvent({ execute } as never, {
        eventType: 'environment_secret_deleted',
        targetType: 'ENVIRONMENT_SECRET',
        targetId: 'secret-1',
        targetName: 'TEAM_KEY',
        organizationId: 7,
        metadata: JSON.stringify({
          scope: 'WORKSPACE',
          ownerType: 'ORGANIZATION',
          workspaceId: 'workspace-1',
          nodeId: 'node-1'
        })
      })
    ).resolves.toMatchObject({ organizationId: 7, targetName: 'TEAM_KEY' });
    expect(execute.mock.calls.every((call) => !String(call[0]).includes('owner_type'))).toBe(true);
  });

  it('honors PERSONAL metadata before resolving a resource owner from an organization Node', async () => {
    const execute = vi.fn();
    await expect(
      scopedAuditEvent({ execute } as never, {
        eventType: 'session.audit.snapshot',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        targetType: 'SESSION',
        targetId: 'session-1',
        metadata: JSON.stringify({ scope: 'PERSONAL' })
      })
    ).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['{invalid', 'null', '[]', '"text"', '{"name":"' + 'x'.repeat(65 * 1024) + '"}'])(
    'drops malformed or oversized business metadata without exposing its contents',
    async (metadata) => {
      const execute = vi.fn();
      const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await expect(
          scopedAuditEvent({ execute } as never, {
            eventType: 'model.updated',
            targetType: 'MODEL',
            targetId: 'model-1',
            organizationId: 4,
            metadata
          })
        ).resolves.toBeUndefined();
        expect(execute).not.toHaveBeenCalled();
        expect(diagnostic).toHaveBeenCalledWith('AUDIT_METADATA_INVALID');
      } finally {
        diagnostic.mockRestore();
      }
    }
  );
});

function auditRow(id: string, occurredAt: number, organizationId: number) {
  return {
    id,
    event_type: 'conversation_input',
    occurred_at: occurredAt,
    result: 'SUCCESS',
    error_code: null,
    actor_user_id: 7,
    actor_username: 'actor',
    authentication_method: 'PASSWORD',
    provider_id: null,
    request_id: null,
    operation_id: null,
    target_type: null,
    target_id: null,
    organization_id: organizationId,
    node_id: 'node-1',
    workspace_id: 'workspace-1',
    agent_session_id: 'session-1',
    run_id: null,
    client_message_id: 'message-1',
    input_mode: 'SEND',
    metadata: '{}'
  };
}
