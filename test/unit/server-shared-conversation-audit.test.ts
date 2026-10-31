import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { describe, expect, it, vi } from 'vitest';
import { hashOpaque } from '../../ee/server/src/database.js';
import { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import type { NodeControl } from '../../ee/server/src/node-control.js';
import type { AuthorizationService } from '../../ee/server/src/rbac/authorization-service.js';
import { AuditService } from '../../ee/server/src/audit/audit-service.js';
import { sharedConversationFailureResult } from '../../packages/server-core/src/conversation-audit.js';
import { registerAuditRoutes } from '../../ee/server/src/route/audit-routes.js';
import { registerRunControlRoutes } from '../../ee/server/src/route/run-control-routes.js';
import { registerSessionRunRoutes } from '../../ee/server/src/route/session-run-routes.js';
import { auditedRelayOperation } from '../../ee/server/src/service/node-request-broker.js';
import type { EnvironmentSecretService } from '../../ee/server/src/service/environment-secret-service.js';

const csrfToken = 'audit-csrf-token';
const headers = {
  cookie: 'mar_user_session=audit-session',
  'x-csrf-token': csrfToken
};

describe('Server shared conversation audit', () => {
  it('persists accepted input only for the target organization-shared Node', async () => {
    const recordConversationAudit = vi.fn<(input: Record<string, unknown>) => Promise<void>>(
      async () => undefined
    );
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes('FROM workspaces')) return [[{ display_name: 'Team workspace' }], []];
      if (sql.includes('FROM organizations')) return [[{ name: 'Team organization' }], []];
      return [
        [{ display_name: 'Shared Node', owner_type: 'ORGANIZATION', owner_organization_id: 23 }],
        []
      ];
    });
    const service = new AuditService(
      {
        auditRaw: { execute },
        dispatchAudit,
        recordConversationAudit
      } as unknown as MysqlServerDatabase,
      {} as AuthorizationService
    );

    await service.recordSharedConversation({
      eventType: 'shared_conversation_input_accepted',
      actorUserId: 7,
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      receipt: {
        sessionId: 'session-1',
        conversationTitle: 'Architecture review',
        runId: 'run-1',
        inputMode: 'SEND'
      },
      clientMessageId: 'message-1',
      userMessage: 'Review the current architecture.'
    });

    await vi.waitFor(() =>
      expect(recordConversationAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 23,
          targetType: 'SESSION',
          targetId: 'session-1',
          targetName: 'Architecture review',
          userMessage: 'Review the current architecture.'
        })
      )
    );
    expect(JSON.stringify(execute.mock.calls)).not.toContain('Review the current architecture.');
    expect(JSON.parse(String(recordConversationAudit.mock.calls[0]![0]['metadata']))).toMatchObject(
      {
        nodeName: 'Shared Node',
        workspaceName: 'Team workspace',
        sessionName: 'Architecture review',
        organizationName: 'Team organization'
      }
    );
  });

  it('does not persist messages for a personal Node and records denied results without text', async () => {
    const recordConversationAudit = vi.fn<(input: Record<string, unknown>) => Promise<void>>(
      async () => undefined
    );
    const execute = vi
      .fn()
      .mockResolvedValueOnce([[{ owner_type: 'PERSONAL', owner_organization_id: null }], []])
      .mockResolvedValueOnce([[{ owner_type: 'ORGANIZATION', owner_organization_id: 23 }], []]);
    const service = new AuditService(
      {
        auditRaw: { execute },
        dispatchAudit,
        recordConversationAudit
      } as unknown as MysqlServerDatabase,
      {} as AuthorizationService
    );

    await service.recordSharedConversation({
      eventType: 'shared_conversation_input_accepted',
      actorUserId: 7,
      nodeId: 'personal-node',
      workspaceId: 'workspace-1',
      receipt: {
        sessionId: 'session-1',
        conversationTitle: 'Private',
        inputMode: 'SEND'
      },
      clientMessageId: 'message-1',
      userMessage: 'must not persist'
    });
    await service.recordSharedConversation({
      eventType: 'shared_conversation_input_rejected',
      actorUserId: 7,
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      receipt: {
        sessionId: 'session-1',
        conversationTitle: 'Shared',
        inputMode: 'SEND'
      },
      clientMessageId: 'message-2',
      errorCode: 'MESSAGE_INVALID'
    });

    await vi.waitFor(() => expect(recordConversationAudit).toHaveBeenCalledTimes(1));
    const denied = recordConversationAudit.mock.calls.at(-1)?.[0];
    expect(denied).toMatchObject({
      eventType: 'shared_conversation_input_rejected',
      result: 'DENIED',
      errorCode: 'MESSAGE_INVALID'
    });
    expect(denied).not.toHaveProperty('userMessage');
  });

  it('keeps retries of one message idempotent but records separate queue edits', async () => {
    const recordConversationAudit = vi.fn<(input: Record<string, unknown>) => Promise<void>>(
      async () => undefined
    );
    const service = new AuditService(
      {
        auditRaw: {
          execute: vi.fn(async () => [
            [{ owner_type: 'ORGANIZATION', owner_organization_id: 23 }],
            []
          ])
        },
        dispatchAudit,
        recordConversationAudit
      } as unknown as MysqlServerDatabase,
      {} as AuthorizationService
    );
    const message = {
      eventType: 'shared_conversation_input_accepted' as const,
      actorUserId: 7,
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      receipt: {
        sessionId: 'session-1',
        conversationTitle: 'Architecture review',
        inputMode: 'SEND' as const
      },
      clientMessageId: 'message-1',
      userMessage: 'Review the current architecture.'
    };
    const queueEdit = {
      eventType: 'shared_conversation_queue_updated' as const,
      actorUserId: 7,
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      receipt: {
        sessionId: 'session-1',
        conversationTitle: 'Architecture review',
        queueItemId: 'queue-1',
        inputMode: 'EDIT_QUEUE' as const
      },
      userMessage: 'Update the queued prompt.'
    };

    await service.recordSharedConversation(message);
    await service.recordSharedConversation(message);
    await service.recordSharedConversation(queueEdit);
    await service.recordSharedConversation(queueEdit);

    await vi.waitFor(() => expect(recordConversationAudit).toHaveBeenCalledTimes(4));
    const [firstMessage, secondMessage, firstEdit, secondEdit] =
      recordConversationAudit.mock.calls.map(([input]) => input);
    expect(firstMessage?.['idempotencyKey']).toBe(secondMessage?.['idempotencyKey']);
    expect(firstEdit?.['idempotencyKey']).not.toBe(secondEdit?.['idempotencyKey']);
  });

  it('writes the audit event and protected payload in one transaction', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([[{ id: 'audit-event-1' }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const connection = {
      beginTransaction: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      release: vi.fn(),
      execute
    };
    const database = new MysqlServerDatabase(
      {
        getConnection: vi.fn(async () => {
          throw new Error('BUSINESS_POOL_EXHAUSTED');
        })
      } as never,
      () => 123,
      { getConnection: vi.fn(async () => connection) } as never
    );

    await database.recordConversationAudit({
      eventType: 'shared_conversation_input_accepted',
      actorUserId: 7,
      organizationId: 23,
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      targetType: 'SESSION',
      targetId: 'session-1',
      targetName: 'Architecture review',
      agentSessionId: 'session-1',
      runId: 'run-1',
      clientMessageId: 'message-1',
      inputMode: 'SEND',
      idempotencyKey: 'a'.repeat(64),
      conversationId: 'session-1',
      conversationTitle: 'Architecture review',
      userMessage: 'Review the current architecture.'
    });

    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toContain('idempotency_key)');
    expect(execute.mock.calls[0]?.[0]).toContain(
      'COALESCE(?,(SELECT username FROM users WHERE id=?)'
    );
    expect(execute.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        'shared_conversation_input_accepted',
        123,
        'Architecture review',
        'a'.repeat(64)
      ])
    );
    expect(execute.mock.calls[1]?.[0]).toContain(
      'SELECT id FROM audit_events WHERE idempotency_key=? FOR UPDATE'
    );
    expect(execute.mock.calls[2]?.[0]).toContain('INSERT INTO audit_conversation_payloads');
    expect(execute.mock.calls[2]?.[1]).toEqual([
      'audit-event-1',
      'session-1',
      'Architecture review',
      'Review the current architecture.',
      null
    ]);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it('records rejected start and queue-edit attempts without request text', async () => {
    const database = routeDatabase();
    const nodeControl = {
      requestNode: vi
        .fn()
        .mockRejectedValueOnce(new Error('NODE_OFFLINE'))
        .mockRejectedValueOnce(new Error('QUEUE_INVALID'))
    } as unknown as NodeControl;
    const recordSharedConversation = vi.fn(async () => undefined);
    const audits = { recordSharedConversation } as unknown as AuditService;
    const app = Fastify();
    registerSessionRunRoutes({
      app,
      database,
      nodeControl,
      secrets: { resolve: vi.fn(async () => ({})) } as unknown as EnvironmentSecretService,
      audits,
      publicOrigin: undefined
    });
    registerRunControlRoutes({
      authorizeNodeRequest: async () => true,
      app,
      database,
      nodeControl,
      secrets: { resolve: vi.fn(async () => ({})) } as unknown as EnvironmentSecretService,
      audits,
      publicOrigin: undefined
    });

    const start = await app.inject({
      method: 'POST',
      url: '/api/agent-sessions/start',
      headers,
      payload: {
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        cwd: '/workspace',
        clientMessageId: 'message-1',
        content: 'Do not retain this rejected text.'
      }
    });
    const edit = await app.inject({
      method: 'PATCH',
      url: '/api/queue-items/queue-1',
      headers,
      payload: {
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        content: 'Do not retain this rejected queue edit.'
      }
    });
    const invalidMessage = await app.inject({
      method: 'POST',
      url: '/api/agent-sessions/session-1/messages',
      headers,
      payload: {
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        clientMessageId: 'message-invalid',
        content: ''
      }
    });

    expect(start.statusCode).toBe(409);
    expect(edit.statusCode).toBe(400);
    expect(invalidMessage.statusCode).toBe(400);
    expect(recordSharedConversation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        eventType: 'shared_conversation_input_rejected',
        result: 'FAILED',
        errorCode: 'NODE_OFFLINE',
        receipt: { inputMode: 'NEW_SESSION' }
      })
    );
    expect(recordSharedConversation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        eventType: 'shared_conversation_queue_updated',
        result: 'DENIED',
        errorCode: 'QUEUE_INVALID',
        receipt: {
          sessionId: 'session-1',
          queueItemId: 'queue-1',
          inputMode: 'EDIT_QUEUE'
        }
      })
    );
    expect(recordSharedConversation).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        eventType: 'shared_conversation_input_rejected',
        result: 'DENIED',
        errorCode: 'MESSAGE_INVALID',
        receipt: { sessionId: 'session-1', inputMode: 'SEND' }
      })
    );
    expect(JSON.stringify(recordSharedConversation.mock.calls)).not.toContain('Do not retain');
    await app.close();
  });

  it('audits organization writes and controls but excludes reads and hosted conversations', () => {
    const auditedWrites = [
      'node.upgrade.request',
      'session.interrupt',
      'session.metadata.update',
      'session.config.update',
      'session.pin.move',
      'session.schedule.save',
      'session.schedule.remove',
      'session.schedule.proposal.resolve',
      'session.rewind',
      'session.rollback',
      'session.remove',
      'session.command.execute',
      'run.cancel',
      'run.interrupt',
      'run.approval.decide',
      'workspace.queue.pause',
      'workspace.queue.resume',
      'workspace.file.write',
      'workspace.files.mutate',
      'workspace.git.settings.update',
      'workspace.change.restore',
      'workspace.files.upload.complete',
      'workspace.files.upload.cancel',
      'runner.command.execute',
      'runner.defaults.save',
      'computer.use.enable',
      'computer.use.disable',
      'node.skills.install',
      'node.skills.remove',
      'workspace.skills.install',
      'workspace.skills.remove',
      'workspace.skills.git-exclude-repair',
      'node.mcps.install',
      'node.mcps.remove',
      'workspace.mcps.install',
      'workspace.mcps.remove',
      'terminal.open',
      'terminal.command.open',
      'conversation.hosting.enable',
      'conversation.hosting.disable',
      'conversation.hosting.cleanup.execute'
    ];
    const excludedReads = [
      'session.list',
      'session.get',
      'run.get',
      'workspace.queue.get',
      'workspace.file.read',
      'workspace.files.list',
      'workspace.git.refs.list',
      'workspace.git.commit.files',
      'workspace.git.history.list',
      'node.skills.inspect',
      'workspace.skills.inspect',
      'node.mcps.inspect',
      'workspace.mcps.inspect',
      'terminal.list',
      'conversation.hosting.storage.inspect',
      'conversation.hosting.cleanup.preview',
      'conversation.template.source.inspect',
      'conversation.template.publish.status'
    ];
    const excludedHosted = [
      'conversation.hosted.get',
      'conversation.hosted.history',
      'conversation.hosted.message',
      'conversation.hosted.config.update',
      'conversation.hosted.files.list',
      'conversation.hosted.file.delete'
    ];
    const excludedConversation = [
      'session.start',
      'session.message',
      'workspace.queue.reorder',
      'workspace.queue.message.update',
      'workspace.queue.message.delete',
      'workspace.queue.message.execute'
    ];

    for (const operation of auditedWrites)
      expect(auditedRelayOperation(operation), operation).toBe(true);
    for (const operation of [...excludedReads, ...excludedHosted, ...excludedConversation])
      expect(auditedRelayOperation(operation), operation).toBe(false);
  });

  it('does not write a generic audit event for regular run controls', async () => {
    const audit = vi.fn(async () => undefined);
    const database = {
      ...routeDatabase(),
      audit
    } as unknown as MysqlServerDatabase;
    const app = Fastify();
    registerRunControlRoutes({
      authorizeNodeRequest: async () => true,
      app,
      database,
      nodeControl: {
        requestNode: vi.fn(async () => ({}))
      } as unknown as NodeControl,
      secrets: { resolve: vi.fn(async () => ({})) } as unknown as EnvironmentSecretService,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/agent-runs/run-1/cancel',
      headers,
      payload: { nodeId: 'node-1' }
    });

    expect(response.statusCode).toBe(202);
    expect(audit).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns audit-detail 404s and excludes hosted messages from HTTP and relay audit paths', async () => {
    const app = Fastify();
    registerAuditRoutes({
      app,
      database: routeDatabase(),
      audits: { detail: vi.fn(async () => undefined) } as unknown as AuditService
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/audit-events/audit-missing',
      headers
    });

    expect(response.statusCode).toBe(404);
    expect(auditedRelayOperation('conversation.hosted.message')).toBe(false);
    expect(sharedConversationFailureResult('NODE_REQUEST_TIMEOUT')).toBe('FAILED');
    await app.close();
  });

  it('accepts only audit page queries and rejects legacy cursors before reading', async () => {
    const app = Fastify();
    const query = vi.fn(async () => ({
      events: [],
      page: 2,
      pageSize: 20,
      total: 21,
      hasMore: false
    }));
    registerAuditRoutes({
      app,
      database: routeDatabase(),
      audits: { query } as unknown as AuditService
    });
    const valid = await app.inject({
      method: 'GET',
      url: '/api/audit-events?page=2&limit=20&from=1&to=3',
      headers
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({ events: [], page: 2, pageSize: 20, total: 21, hasMore: false });
    expect(query).toHaveBeenCalledWith(7, { page: 2, limit: 20, from: 1, to: 3 });
    for (const queryString of [
      'cursor=old',
      'page=0',
      'page=2&cursor=old',
      'page=2&page=3',
      'limit=20&limit=30',
      'limit=501',
      'from=-1'
    ]) {
      const invalid = await app.inject({
        method: 'GET',
        url: `/api/audit-events?${queryString}`,
        headers
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: { code: 'AUDIT_QUERY_INVALID' } });
    }
    expect(query).toHaveBeenCalledOnce();
    await app.close();
  });

  it('marks successful audit details as private and non-cacheable', async () => {
    const app = Fastify();
    registerAuditRoutes({
      app,
      database: routeDatabase(),
      audits: {
        detail: vi.fn(async () => ({
          id: 'audit-detail',
          conversationPayload: { userMessage: 'Protected audit text.' }
        }))
      } as unknown as AuditService
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/audit-events/audit-detail',
      headers
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    await app.close();
  });
});

function routeDatabase(): MysqlServerDatabase {
  return {
    findCurrentUserSession: vi.fn(() => ({
      userId: 7,
      username: 'auditor',
      isAdmin: true,
      sessionHash: 'session-hash',
      mustChangePassword: false,
      csrfTokenHash: hashOpaque(csrfToken)
    }))
  } as unknown as MysqlServerDatabase;
}

function dispatchAudit(task: () => Promise<void>): void {
  void Promise.resolve()
    .then(task)
    .catch(() => undefined);
}
