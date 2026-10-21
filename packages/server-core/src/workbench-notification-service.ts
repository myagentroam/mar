import { withMysqlTransaction, lockMysqlUsers } from './mysql-reference-store.js';
import type { UserLocale } from './auth-contracts.js';
import { readMysqlUserLocale, writeMysqlUserLocale } from './mysql-authentication.js';
import { createHash, randomUUID } from 'node:crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { NotificationStore } from './notification-contracts.js';
import { workbenchNotificationMessages } from './i18n/workbench-notifications.js';
import {
  serverNotificationSchema,
  type NotificationTarget as StoredWorkbenchNotificationTarget,
  type ServerNotification as StoredWorkbenchNotification
} from '@myagentroam/protocol';

export type { UserLocale } from './auth-contracts.js';
export type {
  NotificationTarget as StoredWorkbenchNotificationTarget,
  ServerNotification as StoredWorkbenchNotification
} from '@myagentroam/protocol';

const TTL_MS = 24 * 60 * 60_000;
const CLEANUP_INTERVAL_MS = 5 * 60_000;

export class WorkbenchNotificationService {
  private lastCleanupAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly database: NotificationStore,
    private readonly push: (userId: number, message: object) => void,
    private readonly now: () => number = Date.now,
    private readonly authorizeHostedTarget?: (
      userId: number,
      nodeId: string,
      templateId: string
    ) => Promise<boolean>,
    private readonly offline?: (
      userId: number,
      notification: StoredWorkbenchNotification,
      authorize: () => Promise<boolean>
    ) => void
  ) {}

  async consume(nodeId: string, value: unknown, dispatchOffline = true): Promise<boolean> {
    const payload = parsePayload(value);
    if (payload === undefined) return false;
    if (payload.targetType === 'WORKSPACE_SESSION') {
      const scheduleNotification =
        payload.kind === 'SCHEDULE_SKIPPED' ||
        payload.kind === 'SCHEDULE_FAILED' ||
        payload.kind === 'SCHEDULE_PROPOSAL' ||
        payload.kind === 'SCHEDULE_TERMINAL';
      if (
        !scheduleNotification &&
        !(await this.database.userCanRequestNode(
          payload.userId,
          nodeId,
          'workbench.event.receive',
          value,
          payload.workspaceId
        ))
      )
        return false;
    } else if (
      this.authorizeHostedTarget === undefined ||
      !(await this.authorizeHostedTarget(payload.userId, nodeId, payload.templateId))
    ) {
      return false;
    }
    const timestamp = this.now();
    const createdAt = Math.min(payload.occurredAt, timestamp);
    if (createdAt + TTL_MS <= timestamp) return true;
    await this.cleanup();
    const locale = await this.locale(payload.userId);
    const agent = payload.kind === 'AGENT_MESSAGE';
    const presentation = agent
      ? { kind: 'agent' as const, title: 'MyAgentRoam', detail: '' }
      : present(payload.kind, payload.outcome, locale, payload.targetType);
    const message = agent
      ? payload.agentMessage!
      : notificationMessage(presentation.kind, presentation.title, presentation.detail, locale);
    const id = randomUUID();
    const [result] = await withMysqlTransaction(this.database.raw, async (connection) => {
      await lockMysqlUsers(connection, [payload.userId]);
      return payload.targetType === 'WORKSPACE_SESSION'
        ? await connection.execute<ResultSetHeader>(
            `INSERT INTO workbench_notifications
             (id,user_id,source_id,source_key,kind,title,message,node_id,workspace_id,session_id,
              session_title,run_id,created_at,expires_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE source_key=VALUES(source_key)`,
            [
              id,
              payload.userId,
              payload.notificationId,
              sha256(payload.notificationId),
              presentation.kind,
              agent
                ? payload.agentTitle?.trim() || presentation.title
                : notificationTitle(
                    await this.workspaceTitle(nodeId, payload.workspaceId),
                    payload.sessionTitle,
                    locale
                  ),
              message,
              nodeId,
              payload.workspaceId,
              payload.sessionId,
              payload.sessionTitle,
              payload.runId,
              createdAt,
              createdAt + TTL_MS
            ]
          )
        : await connection.execute<ResultSetHeader>(
            `INSERT INTO workbench_notifications
             (id,user_id,source_id,source_key,kind,title,message,node_id,target_type,workspace_id,
              session_id,session_title,conversation_id,run_id,created_at,expires_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE source_key=VALUES(source_key)`,
            [
              id,
              payload.userId,
              payload.notificationId,
              sha256(payload.notificationId),
              presentation.kind,
              truncateText(payload.conversationTitle, 160),
              message,
              nodeId,
              payload.targetType,
              null,
              null,
              payload.conversationTitle,
              payload.conversationId,
              payload.runId,
              createdAt,
              createdAt + TTL_MS
            ]
          );
    });
    if (result.affectedRows !== 1) return true;
    const notification = await this.get(payload.userId, id);
    if (notification !== undefined) {
      this.push(payload.userId, { type: 'notification.created', notification });
      if (dispatchOffline)
        this.offline?.(payload.userId, notification, () =>
          payload.targetType === 'HOSTED_CONVERSATION'
            ? (this.authorizeHostedTarget?.(payload.userId, nodeId, payload.templateId) ??
              Promise.resolve(false))
            : this.database.userCanRequestNode(
                payload.userId,
                nodeId,
                'workbench.event.receive',
                payload,
                payload.workspaceId
              )
        );
    }
    return true;
  }

  async bySource(
    userId: number,
    sourceId: string
  ): Promise<StoredWorkbenchNotification | undefined> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT * FROM workbench_notifications WHERE user_id=? AND source_key=? AND deleted_at IS NULL AND expires_at>?',
      [userId, sha256(sourceId), this.now()]
    );
    return rows[0] === undefined ? undefined : mapRow(rows[0]);
  }

  async forPush(userId: number, id: string) {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT * FROM workbench_notifications WHERE id=? AND user_id=? AND deleted_at IS NULL AND read_at IS NULL AND expires_at>?',
      [id, userId, this.now()]
    );
    const row = rows[0];
    if (
      row === undefined ||
      row.deleted_at != null ||
      row.read_at != null ||
      Number(row.expires_at) <= this.now()
    )
      return undefined;
    const [users] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT username FROM users WHERE id=? AND enabled=TRUE AND must_change_password=FALSE',
      [userId]
    );
    if (typeof users[0]?.username !== 'string') return undefined;
    return {
      account: users[0].username,
      locale: await this.locale(userId),
      notification: mapRow(row)
    };
  }

  async list(userId: number): Promise<readonly StoredWorkbenchNotification[]> {
    await this.cleanup();
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT * FROM workbench_notifications
       WHERE user_id=? AND deleted_at IS NULL AND expires_at>?
       ORDER BY created_at DESC,id DESC`,
      [userId, this.now()]
    );
    return rows.map(mapRow);
  }

  private async workspaceTitle(nodeId: string, workspaceId: string): Promise<string> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT display_name FROM workspaces WHERE workspace_id=? AND node_id=?',
      [workspaceId, nodeId]
    );
    return String(rows[0]?.['display_name'] ?? workspaceId);
  }

  async markRead(userId: number, id: string): Promise<void> {
    const timestamp = this.now();
    const [result] = await this.database.raw.execute<ResultSetHeader>(
      `UPDATE workbench_notifications SET read_at=?
       WHERE id=? AND user_id=? AND read_at IS NULL AND deleted_at IS NULL AND expires_at>?`,
      [timestamp, id, userId, timestamp]
    );
    if (result.affectedRows > 0)
      this.push(userId, { type: 'notification.read', id, readAt: timestamp });
  }

  async markSessionRead(userId: number, nodeId: string, workspaceId: string, sessionId: string) {
    const timestamp = this.now();
    const [result] = await this.database.raw.execute<ResultSetHeader>(
      `UPDATE workbench_notifications SET read_at=?
       WHERE user_id=? AND node_id=? AND target_type='WORKSPACE_SESSION'
         AND workspace_id=? AND session_id=?
         AND read_at IS NULL AND deleted_at IS NULL AND expires_at>?`,
      [timestamp, userId, nodeId, workspaceId, sessionId, timestamp]
    );
    if (result.affectedRows > 0)
      this.push(userId, {
        type: 'notification.session-read',
        nodeId,
        workspaceId,
        sessionId,
        readAt: timestamp
      });
  }

  async markConversationRead(userId: number, nodeId: string, conversationId: string) {
    const timestamp = this.now();
    const [result] = await this.database.raw.execute<ResultSetHeader>(
      `UPDATE workbench_notifications SET read_at=?
       WHERE user_id=? AND node_id=? AND target_type='HOSTED_CONVERSATION'
         AND conversation_id=? AND read_at IS NULL AND deleted_at IS NULL AND expires_at>?`,
      [timestamp, userId, nodeId, conversationId, timestamp]
    );
    if (result.affectedRows > 0)
      this.push(userId, {
        type: 'notification.conversation-read',
        nodeId,
        conversationId,
        readAt: timestamp
      });
  }

  async markAllRead(userId: number): Promise<void> {
    const timestamp = this.now();
    const [result] = await this.database.raw.execute<ResultSetHeader>(
      `UPDATE workbench_notifications SET read_at=?
       WHERE user_id=? AND read_at IS NULL AND deleted_at IS NULL AND expires_at>?`,
      [timestamp, userId, timestamp]
    );
    if (result.affectedRows > 0)
      this.push(userId, { type: 'notification.all-read', readAt: timestamp });
  }

  async remove(userId: number, id: string): Promise<void> {
    const timestamp = this.now();
    const [result] = await this.database.raw.execute<ResultSetHeader>(
      `UPDATE workbench_notifications SET deleted_at=?
       WHERE id=? AND user_id=? AND deleted_at IS NULL AND expires_at>?`,
      [timestamp, id, userId, timestamp]
    );
    if (result.affectedRows > 0) this.push(userId, { type: 'notification.deleted', id });
  }

  async locale(userId: number): Promise<UserLocale> {
    return readMysqlUserLocale(this.database.raw, userId);
  }

  async setLocale(userId: number, locale: UserLocale): Promise<void> {
    await writeMysqlUserLocale(this.database.raw, userId, locale, this.now);
  }

  private async get(userId: number, id: string): Promise<StoredWorkbenchNotification | undefined> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT * FROM workbench_notifications WHERE id=? AND user_id=?',
      [id, userId]
    );
    return rows[0] === undefined ? undefined : mapRow(rows[0]);
  }

  private async cleanup(): Promise<void> {
    const timestamp = this.now();
    if (timestamp - this.lastCleanupAt < CLEANUP_INTERVAL_MS) return;
    await this.database.raw.execute('DELETE FROM workbench_notifications WHERE expires_at<=?', [
      timestamp
    ]);
    this.lastCleanupAt = timestamp;
  }
}

function mapRow(row: RowDataPacket): StoredWorkbenchNotification {
  const target: StoredWorkbenchNotificationTarget =
    row['target_type'] === 'HOSTED_CONVERSATION'
      ? {
          targetType: 'HOSTED_CONVERSATION',
          nodeId: String(row['node_id']),
          conversationId: String(row['conversation_id']),
          conversationName: String(row['session_title'])
        }
      : {
          targetType: 'WORKSPACE_SESSION',
          nodeId: String(row['node_id']),
          workspaceId: String(row['workspace_id']),
          sessionId: String(row['session_id']),
          sessionName: String(row['session_title'])
        };
  return serverNotificationSchema.parse({
    id: String(row['id']),
    kind: row['kind'],
    title: String(row['title']),
    message: String(row['message']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['created_at']),
    expiresAt: Number(row['expires_at']),
    read: row['read_at'] !== null,
    target
  });
}

function parsePayload(value: unknown) {
  if (!record(value)) return undefined;
  const kind = value.kind;
  const outcome = value.outcome;
  if (
    !Number.isSafeInteger(value.userId) ||
    !bounded(value.notificationId, 512) ||
    !bounded(value.runId, 128) ||
    !Number.isSafeInteger(value.occurredAt) ||
    (value.occurredAt as number) < 0 ||
    ![
      'RUN_TERMINAL',
      'APPROVAL_REQUIRED',
      'PLAN_READY',
      'USER_INPUT_REQUIRED',
      'SCHEDULE_SKIPPED',
      'SCHEDULE_FAILED',
      'SCHEDULE_PROPOSAL',
      'SCHEDULE_TERMINAL',
      'AGENT_MESSAGE'
    ].includes(String(kind)) ||
    (kind === 'RUN_TERMINAL' || kind === 'SCHEDULE_TERMINAL'
      ? !['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(String(outcome))
      : outcome !== undefined)
  )
    return undefined;
  if (
    kind === 'AGENT_MESSAGE' &&
    (!bounded(value.message, 4000) ||
      (value.title !== undefined &&
        (typeof value.title !== 'string' ||
          value.title.length > 160 ||
          /[\r\n]/u.test(value.title))))
  )
    return undefined;
  const base = {
    userId: value.userId as number,
    notificationId: value.notificationId as string,
    runId: value.runId as string,
    occurredAt: value.occurredAt as number,
    kind: kind as
      | 'RUN_TERMINAL'
      | 'APPROVAL_REQUIRED'
      | 'PLAN_READY'
      | 'USER_INPUT_REQUIRED'
      | 'SCHEDULE_SKIPPED'
      | 'SCHEDULE_FAILED'
      | 'SCHEDULE_PROPOSAL'
      | 'SCHEDULE_TERMINAL'
      | 'AGENT_MESSAGE',
    agentMessage: kind === 'AGENT_MESSAGE' ? (value.message as string) : undefined,
    agentTitle: kind === 'AGENT_MESSAGE' ? (value.title as string | undefined) : undefined,
    outcome: typeof outcome === 'string' ? outcome : undefined
  };
  if (value.targetType === 'HOSTED_CONVERSATION') {
    if (
      kind !== 'RUN_TERMINAL' ||
      !bounded(value.templateId, 128) ||
      !bounded(value.conversationId, 128) ||
      !bounded(value.conversationTitle, 160)
    )
      return undefined;
    return {
      ...base,
      targetType: 'HOSTED_CONVERSATION' as const,
      templateId: value.templateId,
      conversationId: value.conversationId,
      conversationTitle: value.conversationTitle
    };
  }
  if (value.targetType !== undefined && value.targetType !== 'WORKSPACE_SESSION') return undefined;
  if (
    !bounded(value.workspaceId, 128) ||
    !bounded(value.sessionId, 128) ||
    !bounded(value.sessionTitle, 160)
  )
    return undefined;
  return {
    ...base,
    targetType: 'WORKSPACE_SESSION' as const,
    workspaceId: value.workspaceId,
    sessionId: value.sessionId,
    sessionTitle: value.sessionTitle
  };
}

function present(
  kind: string,
  outcome: string | undefined,
  locale: UserLocale,
  targetType: 'WORKSPACE_SESSION' | 'HOSTED_CONVERSATION'
) {
  const messages = workbenchNotificationMessages[locale];
  if (kind === 'APPROVAL_REQUIRED') return { kind: 'approval' as const, ...messages.approval };
  if (kind === 'PLAN_READY') return { kind: 'plan' as const, ...messages.plan };
  if (kind === 'USER_INPUT_REQUIRED') return { kind: 'user-input' as const, ...messages.userInput };
  if (kind === 'SCHEDULE_SKIPPED')
    return { kind: 'schedule' as const, ...messages.schedule.skipped };
  if (kind === 'SCHEDULE_FAILED') return { kind: 'schedule' as const, ...messages.schedule.failed };
  if (kind === 'SCHEDULE_PROPOSAL')
    return { kind: 'schedule' as const, ...messages.schedule.proposal };
  const title =
    outcome === 'SUCCEEDED'
      ? messages.run.succeeded
      : outcome === 'FAILED'
        ? messages.run.failed
        : outcome === 'CANCELLED'
          ? messages.run.cancelled
          : messages.run.interrupted;
  return {
    kind: 'run' as const,
    title,
    detail:
      targetType === 'HOSTED_CONVERSATION' ? messages.run.hostedDetail : messages.run.sessionDetail
  };
}

function notificationMessage(
  kind: StoredWorkbenchNotification['kind'],
  title: string,
  detail: string,
  locale: UserLocale
): string {
  if (kind === 'run')
    return `${title}${workbenchNotificationMessages[locale].run.separator}${detail}`;
  return `${title}, ${detail}`;
}

function notificationTitle(
  workspaceTitle: string,
  sessionTitle: string,
  locale: UserLocale
): string {
  const separator = workbenchNotificationMessages[locale].titleSeparator;
  const truncatedTitle = truncateText(sessionTitle, 160);
  const workspaceLimit = 160 - truncatedTitle.length - separator.length;
  if (workspaceLimit <= 0) return truncatedTitle;
  return `${truncateText(workspaceTitle, workspaceLimit)}${separator}${truncatedTitle}`;
}

function truncateText(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join('');
}

function bounded(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
