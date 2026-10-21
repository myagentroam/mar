import { describe, expect, it, vi } from 'vitest';
import { WorkbenchNotificationService } from '../../ee/server/src/service/workbench-notification-service.js';

function transactionalDatabase(
  execute: (sql: string, parameters?: unknown[]) => Promise<unknown>,
  userCanRequestNode: () => Promise<boolean>
) {
  const transactionalExecute = vi.fn(async (sql: string, parameters: unknown[] = []) => {
    if (sql.includes('SELECT id FROM users')) return [[{ id: parameters[0] }], []];
    return execute(sql, parameters);
  });
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    execute: transactionalExecute,
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn()
  };
  return {
    raw: { execute: transactionalExecute, getConnection: vi.fn(async () => connection) },
    userCanRequestNode,
    connection
  };
}

describe('Server Workbench notification service', () => {
  it('Persists final text in the user language and pushes idempotently by stable source', async () => {
    const rows: Record<string, unknown>[] = [];
    let locale = 'zh-CN';
    const execute = vi.fn(async (sql: string, parameters: unknown[] = []) => {
      if (sql.includes('DELETE FROM workbench_notifications')) return [{ affectedRows: 0 }, []];
      if (sql.includes('SELECT locale FROM users')) return [[{ locale }], []];
      if (sql.includes('SELECT display_name FROM workspaces'))
        return [[{ display_name: '我的工作区' }], []];
      if (sql.includes('UPDATE users SET locale')) {
        locale = String(parameters[0]);
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes('INSERT INTO workbench_notifications')) {
        const sourceKey = String(parameters[3]);
        if (rows.some((row) => row.source_key === sourceKey)) return [{ affectedRows: 0 }, []];
        rows.push({
          id: parameters[0],
          user_id: parameters[1],
          source_id: parameters[2],
          source_key: sourceKey,
          kind: parameters[4],
          title: parameters[5],
          message: parameters[6],
          node_id: parameters[7],
          workspace_id: parameters[8],
          session_id: parameters[9],
          session_title: parameters[10],
          run_id: parameters[11],
          created_at: parameters[12],
          expires_at: parameters[13],
          read_at: null,
          deleted_at: null
        });
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes('SELECT * FROM workbench_notifications WHERE id='))
        return [[rows.find((row) => row.id === parameters[0])], []];
      throw new Error(`UNEXPECTED_SQL:${sql}`);
    });
    const push = vi.fn();
    const database = transactionalDatabase(
      execute,
      vi.fn(async () => true)
    );
    const service = new WorkbenchNotificationService(database as never, push, () => 1_000);
    const event = {
      userId: 7,
      notificationId: 'run:workspace-1:run-1',
      kind: 'RUN_TERMINAL',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      sessionTitle: '测试会话',
      runId: 'run-1',
      occurredAt: 900,
      outcome: 'SUCCEEDED'
    };
    await service.consume('node-1', event);
    await service.setLocale(7, 'en-US');
    await service.consume('node-1', event);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        title: '我的工作区：测试会话',
        message: '运行已完成，点击查看相关会话。'
      })
    );
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(7, expect.objectContaining({ type: 'notification.created' }));
    expect(
      execute.mock.calls.filter(([sql]) => sql.includes('DELETE FROM workbench_notifications'))
    ).toHaveLength(1);
    const insertSql = execute.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO workbench_notifications')
    )?.[0];
    expect(insertSql).toContain('ON DUPLICATE KEY UPDATE');
    expect(insertSql).not.toContain('IGNORE');
  });

  it('English notifications include Workspace and session titles and an open hint after the status', async () => {
    let inserted: Record<string, unknown> | undefined;
    const execute = vi.fn(async (sql: string, parameters: unknown[] = []) => {
      if (sql.includes('DELETE FROM workbench_notifications')) return [{ affectedRows: 0 }, []];
      if (sql.includes('SELECT locale FROM users')) return [[{ locale: 'en-US' }], []];
      if (sql.includes('SELECT display_name FROM workspaces'))
        return [[{ display_name: 'Workspace' }], []];
      if (sql.includes('INSERT INTO workbench_notifications')) {
        inserted = {
          id: parameters[0],
          kind: parameters[4],
          title: parameters[5],
          message: parameters[6],
          node_id: parameters[7],
          workspace_id: parameters[8],
          session_id: parameters[9],
          session_title: parameters[10],
          created_at: parameters[12],
          expires_at: parameters[13],
          read_at: null
        };
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes('SELECT * FROM workbench_notifications WHERE id=')) return [[inserted], []];
      throw new Error(`UNEXPECTED_SQL:${sql}`);
    });
    const database = transactionalDatabase(
      execute,
      vi.fn(async () => true)
    );
    const service = new WorkbenchNotificationService(database as never, vi.fn(), () => 1_000);

    await service.consume('node-1', {
      userId: 7,
      notificationId: 'run:workspace-1:run-1',
      kind: 'RUN_TERMINAL',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      sessionTitle: 'Session',
      runId: 'run-1',
      occurredAt: 900,
      outcome: 'SUCCEEDED'
    });

    expect(inserted).toEqual(
      expect.objectContaining({
        title: 'Workspace: Session',
        message: 'Run completed. Open the related session.'
      })
    );
  });

  it('Rejects notifications without an initiating user or resource authorization', async () => {
    const execute = vi.fn();
    const database = {
      raw: { execute },
      userCanRequestNode: vi.fn(async () => false)
    };
    const service = new WorkbenchNotificationService(database as never, vi.fn(), () => 1_000);
    expect(await service.consume('node-1', { notificationId: 'missing-user' })).toBe(false);
    expect(
      await service.consume('node-1', {
        userId: 7,
        notificationId: 'run:1',
        kind: 'RUN_TERMINAL',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        sessionTitle: 'Session',
        runId: 'run-1',
        occurredAt: 900,
        outcome: 'SUCCEEDED'
      })
    ).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('Bounds titles including Workspace names and separators to fit notification storage', async () => {
    let insertedTitle = '';
    const execute = vi.fn(async (sql: string, parameters: unknown[] = []) => {
      if (sql.includes('DELETE FROM workbench_notifications')) return [{ affectedRows: 0 }, []];
      if (sql.includes('SELECT locale FROM users')) return [[{ locale: 'zh-CN' }], []];
      if (sql.includes('SELECT display_name FROM workspaces'))
        return [[{ display_name: '工'.repeat(200) }], []];
      if (sql.includes('INSERT INTO workbench_notifications')) {
        insertedTitle = String(parameters[5]);
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes('SELECT * FROM workbench_notifications WHERE id=')) return [[], []];
      throw new Error(`UNEXPECTED_SQL:${sql}`);
    });
    const database = transactionalDatabase(
      execute,
      vi.fn(async () => true)
    );
    const service = new WorkbenchNotificationService(database as never, vi.fn(), () => 1_000);

    await service.consume('node-1', {
      userId: 7,
      notificationId: 'run:workspace-1:run-1',
      kind: 'RUN_TERMINAL',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      sessionTitle: '测试会话',
      runId: 'run-1',
      occurredAt: 900,
      outcome: 'SUCCEEDED'
    });

    expect(insertedTitle).toBe(`${'工'.repeat(155)}：测试会话`);
    expect(insertedTitle).toHaveLength(160);
  });

  it('Rejects Node events whose notification type and terminal result disagree', async () => {
    const database = {
      raw: { execute: vi.fn() },
      userCanRequestNode: vi.fn(async () => true)
    };
    const service = new WorkbenchNotificationService(database as never, vi.fn(), () => 1_000);
    const base = {
      userId: 7,
      notificationId: 'run:1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      sessionTitle: 'Session',
      runId: 'run-1',
      occurredAt: 900
    };
    expect(
      await service.consume('node-1', { ...base, kind: 'RUN_TERMINAL', outcome: 'UNKNOWN' })
    ).toBe(false);
    expect(
      await service.consume('node-1', {
        ...base,
        kind: 'APPROVAL_REQUIRED',
        outcome: 'SUCCEEDED'
      })
    ).toBe(false);
    expect(database.userCanRequestNode).not.toHaveBeenCalled();
    expect(database.raw.execute).not.toHaveBeenCalled();
  });

  it('Authorized but expired notifications are ignored without accessing notification storage', async () => {
    const database = {
      raw: { execute: vi.fn() },
      userCanRequestNode: vi.fn(async () => true)
    };
    const service = new WorkbenchNotificationService(
      database as never,
      vi.fn(),
      () => 24 * 60 * 60_000 + 1
    );

    expect(
      await service.consume('node-1', {
        userId: 7,
        notificationId: 'run:expired',
        kind: 'RUN_TERMINAL',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        sessionTitle: 'Session',
        runId: 'run-expired',
        occurredAt: 0,
        outcome: 'SUCCEEDED'
      })
    ).toBe(true);
    expect(database.userCanRequestNode).toHaveBeenCalledOnce();
    expect(database.raw.execute).not.toHaveBeenCalled();
  });

  it('Template authorization alone permits deep-linked hosted conversation completion notifications', async () => {
    let inserted: Record<string, unknown> | undefined;
    let locale: 'zh-CN' | 'en-US' = 'zh-CN';
    const execute = vi.fn(async (sql: string, parameters: unknown[] = []) => {
      if (sql.includes('DELETE FROM workbench_notifications')) return [{ affectedRows: 0 }, []];
      if (sql.includes('SELECT locale FROM users')) return [[{ locale }], []];
      if (sql.includes('INSERT INTO workbench_notifications')) {
        inserted = {
          id: parameters[0],
          user_id: parameters[1],
          source_id: parameters[2],
          source_key: parameters[3],
          kind: parameters[4],
          title: parameters[5],
          message: parameters[6],
          node_id: parameters[7],
          target_type: parameters[8],
          workspace_id: parameters[9],
          session_id: parameters[10],
          session_title: parameters[11],
          conversation_id: parameters[12],
          run_id: parameters[13],
          created_at: parameters[14],
          expires_at: parameters[15],
          read_at: null,
          deleted_at: null
        };
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes('SELECT * FROM workbench_notifications WHERE id=')) return [[inserted], []];
      throw new Error(`UNEXPECTED_SQL:${sql}`);
    });
    const authorizeHostedTarget = vi.fn(async () => true);
    const userCanRequestNode = vi.fn(async () => false);
    const push = vi.fn();
    const database = transactionalDatabase(execute, userCanRequestNode);
    const service = new WorkbenchNotificationService(
      database as never,
      push,
      () => 1_000,
      authorizeHostedTarget
    );

    expect(
      await service.consume('node-1', {
        targetType: 'HOSTED_CONVERSATION',
        userId: 7,
        templateId: 'template-1',
        notificationId: 'run:node-1:conversation-1:run-1',
        kind: 'RUN_TERMINAL',
        conversationId: 'conversation-1',
        conversationTitle: '托管研究',
        runId: 'run-1',
        occurredAt: 900,
        outcome: 'FAILED'
      })
    ).toBe(true);

    expect(authorizeHostedTarget).toHaveBeenCalledWith(7, 'node-1', 'template-1');
    expect(userCanRequestNode).not.toHaveBeenCalled();
    expect(inserted).toMatchObject({
      title: '托管研究',
      message: '运行失败，点击查看对话。',
      target_type: 'HOSTED_CONVERSATION',
      workspace_id: null,
      session_id: null,
      session_title: '托管研究',
      conversation_id: 'conversation-1'
    });
    expect(push).toHaveBeenCalledWith(7, {
      type: 'notification.created',
      notification: expect.objectContaining({
        target: {
          targetType: 'HOSTED_CONVERSATION',
          nodeId: 'node-1',
          conversationId: 'conversation-1',
          conversationName: '托管研究'
        }
      })
    });

    locale = 'en-US';
    await service.consume('node-1', {
      targetType: 'HOSTED_CONVERSATION',
      userId: 7,
      templateId: 'template-1',
      notificationId: 'run:node-1:conversation-1:run-2',
      kind: 'RUN_TERMINAL',
      conversationId: 'conversation-1',
      conversationTitle: 'Hosted research',
      runId: 'run-2',
      occurredAt: 950,
      outcome: 'SUCCEEDED'
    });

    expect(inserted).toMatchObject({
      title: 'Hosted research',
      message: 'Run completed. Open the conversation.'
    });
  });

  it('Failed template authorization rejects hosted notifications and bulk read updates synchronize only real changes', async () => {
    const execute = vi.fn(async () => [{ affectedRows: 2 }, []]);
    const push = vi.fn();
    const service = new WorkbenchNotificationService(
      {
        raw: { execute },
        userCanRequestNode: vi.fn(async () => true)
      } as never,
      push,
      () => 1_000,
      vi.fn(async () => false)
    );

    expect(
      await service.consume('node-1', {
        targetType: 'HOSTED_CONVERSATION',
        userId: 7,
        templateId: 'template-1',
        notificationId: 'run:node-1:conversation-1:run-1',
        kind: 'RUN_TERMINAL',
        conversationId: 'conversation-1',
        conversationTitle: 'Hosted',
        runId: 'run-1',
        occurredAt: 900,
        outcome: 'SUCCEEDED'
      })
    ).toBe(false);
    expect(execute).not.toHaveBeenCalled();

    await service.markConversationRead(7, 'node-1', 'conversation-1');
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("target_type='HOSTED_CONVERSATION'"),
      [1_000, 7, 'node-1', 'conversation-1', 1_000]
    );
    expect(push).toHaveBeenCalledWith(7, {
      type: 'notification.conversation-read',
      nodeId: 'node-1',
      conversationId: 'conversation-1',
      readAt: 1_000
    });
  });

  it('Other browsers synchronize only when read state actually changes', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ affectedRows: 0 }, []])
      .mockResolvedValueOnce([{ affectedRows: 0 }, []])
      .mockResolvedValueOnce([{ affectedRows: 2 }, []])
      .mockResolvedValueOnce([{ affectedRows: 3 }, []]);
    const push = vi.fn();
    const service = new WorkbenchNotificationService(
      { raw: { execute } } as never,
      push,
      () => 1_000
    );

    await service.markSessionRead(7, 'node-1', 'workspace-1', 'session-1');
    await service.markAllRead(7);
    expect(push).not.toHaveBeenCalled();

    await service.markSessionRead(7, 'node-1', 'workspace-1', 'session-1');
    await service.markAllRead(7);
    expect(push).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenNthCalledWith(
      1,
      7,
      expect.objectContaining({ type: 'notification.session-read' })
    );
    expect(push).toHaveBeenNthCalledWith(
      2,
      7,
      expect.objectContaining({ type: 'notification.all-read' })
    );
  });
});
