import { describe, expect, it, vi } from 'vitest';
import { WorkbenchNotificationService } from '../../src/workbench-notification-service.js';
import { workbenchNotificationMessages } from '../../src/i18n/workbench-notifications.js';

const zhMessages = workbenchNotificationMessages['zh-CN'];

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
  it('persists explicit Agent messages verbatim without inventing a Run terminal or double-enqueueing Push', async () => {
    let row: Record<string, unknown> | undefined;
    const execute = vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.includes('DELETE FROM')) return [{ affectedRows: 0 }, []];
      if (sql.includes('SELECT locale')) return [[{ locale: 'en-US' }], []];
      if (sql.includes('INSERT INTO workbench_notifications')) {
        row = {
          id: values[0],
          user_id: values[1],
          source_id: values[2],
          source_key: values[3],
          kind: values[4],
          title: values[5],
          message: values[6],
          node_id: values[7],
          target_type: 'WORKSPACE_SESSION',
          workspace_id: values[8],
          session_id: values[9],
          session_title: values[10],
          run_id: values[11],
          created_at: values[12],
          expires_at: values[13],
          read_at: null,
          deleted_at: null
        };
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes('SELECT * FROM')) return [[row], []];
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const database = transactionalDatabase(execute, async () => true);
    const push = vi.fn();
    const offline = vi.fn();
    const service = new WorkbenchNotificationService(
      database as never,
      push,
      () => 1000,
      undefined,
      offline
    );
    const event = {
      userId: 7,
      notificationId: 'mcp:call-1',
      kind: 'AGENT_MESSAGE',
      title: 'Agent report',
      message: '字'.repeat(4000),
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      sessionTitle: 'Session',
      runId: 'run-1',
      occurredAt: 900
    };
    await service.consume('node-1', event, false);
    expect(row).toMatchObject({ kind: 'agent', title: 'Agent report', message: event.message });
    expect(push).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: 'notification.created',
        notification: expect.objectContaining({ kind: 'agent', message: event.message })
      })
    );
    expect(offline).not.toHaveBeenCalled();
    execute.mockClear();
    await service.consume('node-1', { ...event, message: event.message + 'x' }, false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('stores localized final copy by user locale and pushes idempotently by stable source', async () => {
    const rows: Record<string, unknown>[] = [];
    let locale = 'zh-CN';
    const execute = vi.fn(async (sql: string, parameters: unknown[] = []) => {
      if (sql.includes('DELETE FROM workbench_notifications')) return [{ affectedRows: 0 }, []];
      if (sql.includes('SELECT locale FROM users')) return [[{ locale }], []];
      if (sql.includes('SELECT display_name FROM workspaces'))
        return [[{ display_name: 'My Workspace' }], []];
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
    const offline =
      vi.fn<(userId: number, notification: unknown, authorize: () => Promise<boolean>) => void>();
    const service = new WorkbenchNotificationService(
      database as never,
      push,
      () => 1_000,
      undefined,
      offline
    );
    const event = {
      userId: 7,
      notificationId: 'run:workspace-1:run-1',
      kind: 'RUN_TERMINAL',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      sessionTitle: 'Test Session',
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
        title: `My Workspace${zhMessages.titleSeparator}Test Session`,
        message: `${zhMessages.run.succeeded}${zhMessages.run.separator}${zhMessages.run.sessionDetail}`
      })
    );
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(7, expect.objectContaining({ type: 'notification.created' }));
    expect(offline).toHaveBeenCalledOnce();
    expect(offline.mock.invocationCallOrder[0]).toBeGreaterThan(
      database.connection.commit.mock.invocationCallOrder[0]!
    );
    const authorize = offline.mock.calls[0]![2];
    expect(await authorize()).toBe(true);
    vi.mocked(database.userCanRequestNode).mockResolvedValueOnce(false);
    expect(await authorize()).toBe(false);
    expect(
      execute.mock.calls.filter(([sql]) => sql.includes('DELETE FROM workbench_notifications'))
    ).toHaveLength(1);
    const insertSql = execute.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO workbench_notifications')
    )?.[0];
    expect(insertSql).toContain('ON DUPLICATE KEY UPDATE');
    expect(insertSql).not.toContain('IGNORE');
  });

  it('rolls back and releases when notification persistence fails before pushing', async () => {
    const execute = vi.fn(async (sql: string, parameters: unknown[] = []) => {
      if (sql.includes('DELETE FROM workbench_notifications')) return [{ affectedRows: 0 }, []];
      if (sql.includes('SELECT locale FROM users')) return [[{ locale: 'en-US' }], []];
      if (sql.includes('SELECT display_name FROM workspaces'))
        return [[{ display_name: 'Workspace' }], []];
      if (sql.includes('INSERT INTO workbench_notifications')) throw new Error('DB_WRITE_FAILED');
      throw new Error(`UNEXPECTED_SQL:${sql}:${JSON.stringify(parameters)}`);
    });
    const push = vi.fn();
    const database = transactionalDatabase(
      execute,
      vi.fn(async () => true)
    );
    const service = new WorkbenchNotificationService(database as never, push, () => 1_000);

    await expect(
      service.consume('node-1', {
        userId: 7,
        notificationId: 'run:workspace-1:run-failed',
        kind: 'RUN_TERMINAL',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        sessionTitle: 'Session',
        runId: 'run-failed',
        occurredAt: 900,
        outcome: 'FAILED'
      })
    ).rejects.toThrow('DB_WRITE_FAILED');
    expect(database.connection.commit).not.toHaveBeenCalled();
    expect(database.connection.rollback).toHaveBeenCalledOnce();
    expect(database.connection.release).toHaveBeenCalledOnce();
    expect(database.connection.rollback.mock.invocationCallOrder[0]!).toBeLessThan(
      database.connection.release.mock.invocationCallOrder[0]!
    );
    expect(push).not.toHaveBeenCalled();
  });

  it('uses workspace and session titles in English notifications while retaining the post-status open prompt', async () => {
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

  it('rejects notifications without an initiating user or resource access', async () => {
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

  it('records scheduled skip and terminal events for the designated recipient after access is revoked', async () => {
    const execute = vi.fn(async (sql: string, _parameters?: unknown[]) => {
      void _parameters;
      if (sql.includes('DELETE FROM workbench_notifications')) return [{ affectedRows: 0 }, []];
      if (sql.includes('SELECT locale FROM users')) return [[{ locale: 'en-US' }], []];
      if (sql.includes('SELECT display_name FROM workspaces'))
        return [[{ display_name: 'Workspace' }], []];
      if (sql.includes('INSERT INTO workbench_notifications')) return [{ affectedRows: 1 }, []];
      if (sql.includes('SELECT * FROM workbench_notifications WHERE id=')) return [[], []];
      throw new Error(`UNEXPECTED_SQL:${sql}`);
    });
    const userCanRequestNode = vi.fn(async () => false);
    const database = transactionalDatabase(execute, userCanRequestNode);
    const service = new WorkbenchNotificationService(database as never, vi.fn(), () => 1_000);
    expect(
      await service.consume('node-1', {
        userId: 8,
        notificationId: 'schedule:task-1:due-1',
        kind: 'SCHEDULE_SKIPPED',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        sessionTitle: 'Session',
        runId: 'due-1',
        occurredAt: 900
      })
    ).toBe(true);
    expect(
      await service.consume('node-1', {
        userId: 8,
        notificationId: 'schedule-terminal:task-1:due-2',
        kind: 'SCHEDULE_TERMINAL',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        sessionTitle: 'Session',
        runId: 'run-2',
        occurredAt: 900,
        outcome: 'SUCCEEDED'
      })
    ).toBe(true);
    expect(userCanRequestNode).not.toHaveBeenCalled();
    const insertions = execute.mock.calls.filter(([sql]) =>
      sql.includes('INSERT INTO workbench_notifications')
    );
    expect(insertions).toHaveLength(2);
    expect(insertions.map(([, values]) => values?.[1])).toEqual([8, 8]);
    expect(insertions.map(([, values]) => values?.[4])).toEqual(['schedule', 'run']);
  });

  it('limits notification titles with workspace names and separators to fit notification storage', async () => {
    let insertedTitle = '';
    const execute = vi.fn(async (sql: string, parameters: unknown[] = []) => {
      if (sql.includes('DELETE FROM workbench_notifications')) return [{ affectedRows: 0 }, []];
      if (sql.includes('SELECT locale FROM users')) return [[{ locale: 'zh-CN' }], []];
      if (sql.includes('SELECT display_name FROM workspaces'))
        return [[{ display_name: 'W'.repeat(200) }], []];
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
      sessionTitle: 'Test Session',
      runId: 'run-1',
      occurredAt: 900,
      outcome: 'SUCCEEDED'
    });

    expect(insertedTitle).toBe(`${'W'.repeat(147)}${zhMessages.titleSeparator}Test Session`);
    expect(insertedTitle).toHaveLength(160);
  });

  it('rejects Node events whose notification type and terminal outcome do not match', async () => {
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
      await service.consume('node-1', { ...base, kind: 'SCHEDULE_TERMINAL', outcome: 'UNKNOWN' })
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

  it('ignores expired notifications after authorization without accessing notification storage', async () => {
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

  it('stores deep-linkable hosted conversation terminal notifications using template authorization alone', async () => {
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
        conversationTitle: 'Hosted Research',
        runId: 'run-1',
        occurredAt: 900,
        outcome: 'FAILED'
      })
    ).toBe(true);

    expect(authorizeHostedTarget).toHaveBeenCalledWith(7, 'node-1', 'template-1');
    expect(userCanRequestNode).not.toHaveBeenCalled();
    expect(inserted).toMatchObject({
      title: 'Hosted Research',
      message: `${zhMessages.run.failed}${zhMessages.run.separator}${zhMessages.run.hostedDetail}`,
      target_type: 'HOSTED_CONVERSATION',
      workspace_id: null,
      session_id: null,
      session_title: 'Hosted Research',
      conversation_id: 'conversation-1'
    });
    expect(push).toHaveBeenCalledWith(7, {
      type: 'notification.created',
      notification: expect.objectContaining({
        target: {
          targetType: 'HOSTED_CONVERSATION',
          nodeId: 'node-1',
          conversationId: 'conversation-1',
          conversationName: 'Hosted Research'
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

  it('rejects hosted notifications when template authorization fails and synchronizes bulk conversation reads only when they change', async () => {
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

  it('preserves notification timestamps when stored notifications are read and restored', async () => {
    const createdAt = 1_000;
    let now = 10_000;
    const row = {
      id: 'notification-1',
      kind: 'run',
      title: 'Workspace: Session',
      message: 'Scheduled task skipped, open the session for details.',
      node_id: 'node-1',
      workspace_id: 'workspace-1',
      session_id: 'session-1',
      session_title: 'Session',
      created_at: createdAt,
      expires_at: createdAt + 24 * 60 * 60_000,
      read_at: null as number | null
    };
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes('DELETE FROM')) return [{ affectedRows: 0 }, []];
      if (sql.includes('SELECT * FROM')) return [[row], []];
      if (sql.includes('UPDATE workbench_notifications SET read_at=')) {
        row.read_at = now;
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const database = { raw: { execute } };
    const push = vi.fn();
    const service = new WorkbenchNotificationService(database as never, push, () => now);
    expect(await service.list(7)).toEqual([
      expect.objectContaining({ createdAt, updatedAt: createdAt, read: false })
    ]);

    now = 20_000;
    await service.markSessionRead(7, 'node-1', 'workspace-1', 'session-1');
    expect(push).toHaveBeenCalledWith(7, {
      type: 'notification.session-read',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      readAt: now
    });

    const restored = new WorkbenchNotificationService(database as never, vi.fn(), () => now);
    expect(await restored.list(7)).toEqual([
      expect.objectContaining({ createdAt, updatedAt: createdAt, read: true })
    ]);
  });

  it('synchronizes other browsers only when read state actually changes', async () => {
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
