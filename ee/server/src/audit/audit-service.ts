import { emitAudit, safeAuditMetadata } from '@myagentroam/server-core/audit';
import { scopedAuditEvent } from './audit-policy.js';
import { createHash, randomUUID } from 'node:crypto';
import type { AuditConversationInputMode, AuditConversationReceipt } from '@myagentroam/protocol';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { AuditEvent } from '@myagentroam/server-core/audit';
import type { SharedConversationAuditInput } from './audit-contracts.js';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { AuthorizationProvider } from '../product/product-policy.js';
import { withMysqlTransaction } from '@myagentroam/server-core/mysql-reference-store';

const DEFAULT_RETENTION_DAYS = 180;
const DEFAULT_CLEANUP_BATCH_SIZE = 1_000;
const MAX_CLEANUP_BATCH_SIZE = 10_000;
const MAX_EXPORT_ROWS = 10_000;
export const AUDIT_PAGE_SIZE = 20;
const MAX_AUDIT_QUERY_LIMIT = 500;

export interface SharedConversationAuditReceipt {
  readonly sessionId?: string;
  readonly conversationTitle?: string;
  readonly runId?: string;
  readonly queueItemId?: string;
  readonly inputMode: AuditConversationInputMode;
}

export class AuditService {
  constructor(
    private readonly database: MysqlServerDatabase,
    private readonly authorization: AuthorizationProvider,
    private readonly now: () => number = Date.now
  ) {}

  async record(input: AuditEvent): Promise<void> {
    const metadata = safeAuditMetadata(input.metadata);
    emitAudit(this.database, { ...input, ...(metadata === undefined ? {} : { metadata }) });
  }

  async recordSharedConversation(input: {
    readonly eventType:
      | 'shared_conversation_input_accepted'
      | 'shared_conversation_input_rejected'
      | 'shared_conversation_queue_updated'
      | 'shared_conversation_queue_deleted'
      | 'shared_conversation_queue_reordered'
      | 'shared_conversation_queue_execute_requested';
    readonly actorUserId: number;
    readonly nodeId: string;
    readonly workspaceId: string;
    readonly receipt: AuditConversationReceipt | SharedConversationAuditReceipt;
    readonly clientMessageId?: string;
    readonly userMessage?: string;
    readonly errorCode?: string;
    readonly result?: 'SUCCESS' | 'DENIED' | 'FAILED';
  }): Promise<void> {
    const event = { ...input, receipt: { ...input.receipt } };
    const occurredAt = this.now();
    this.database.dispatchAudit(() => this.writeSharedConversation(event, occurredAt));
  }

  private async writeSharedConversation(
    input: Parameters<AuditService['recordSharedConversation']>[0],
    occurredAt: number
  ): Promise<void> {
    const [rows] = await this.database.auditRaw.execute<RowDataPacket[]>(
      'SELECT display_name,owner_type,owner_organization_id FROM nodes WHERE id=?',
      [input.nodeId]
    );
    const owner = rows[0];
    const organizationId = Number(owner?.['owner_organization_id']);
    if (owner?.['owner_type'] !== 'ORGANIZATION' || !Number.isSafeInteger(organizationId)) return;
    const receipt = input.receipt;
    const targetId = receipt.sessionId ?? input.workspaceId;
    const record: SharedConversationAuditInput = {
      eventType: input.eventType,
      occurredAt,
      actorUserId: input.actorUserId,
      result:
        input.result ??
        (input.eventType === 'shared_conversation_input_rejected'
          ? 'DENIED'
          : input.errorCode === undefined
            ? 'SUCCESS'
            : 'FAILED'),
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      targetType: receipt.sessionId === undefined ? 'WORKSPACE' : 'SESSION',
      targetId,
      metadata: safeAuditMetadata(
        JSON.stringify({ nodeName: owner['display_name'], sessionName: receipt.conversationTitle })
      ),
      ...(receipt.conversationTitle === undefined ? {} : { targetName: receipt.conversationTitle }),
      organizationId,
      nodeId: input.nodeId,
      workspaceId: input.workspaceId,
      ...(receipt.sessionId === undefined ? {} : { agentSessionId: receipt.sessionId }),
      ...(receipt.runId === undefined ? {} : { runId: receipt.runId }),
      ...(input.clientMessageId === undefined ? {} : { clientMessageId: input.clientMessageId }),
      inputMode: receipt.inputMode,
      idempotencyKey:
        input.clientMessageId === undefined
          ? randomUUID()
          : sharedConversationIdempotencyKey(
              input.nodeId,
              input.workspaceId,
              receipt.sessionId ?? targetId,
              input.clientMessageId,
              input.eventType
            ),
      ...(receipt.sessionId === undefined ? {} : { conversationId: receipt.sessionId }),
      ...(receipt.conversationTitle === undefined
        ? {}
        : { conversationTitle: receipt.conversationTitle }),
      ...(input.userMessage === undefined ||
      input.errorCode !== undefined ||
      input.result === 'FAILED' ||
      input.result === 'DENIED' ||
      input.eventType === 'shared_conversation_input_rejected'
        ? {}
        : { userMessage: input.userMessage }),
      ...(receipt.queueItemId === undefined ? {} : { queueItemId: receipt.queueItemId })
    };
    const scoped = await scopedAuditEvent(this.database.auditRaw, record);
    if (scoped !== undefined) await this.database.recordConversationAudit({ ...record, ...scoped });
  }

  async query(
    actorUserId: number,
    input: {
      readonly cursor?: string;
      readonly limit?: number;
      readonly page?: number;
      readonly from?: number;
      readonly to?: number;
    } = {}
  ): Promise<{
    readonly events: readonly object[];
    readonly nextCursor?: string;
    readonly total?: number;
    readonly page?: number;
  }> {
    const scope = await this.readScope(actorUserId, 'AUDIT_READ');
    const limit = Math.min(Math.max(input.limit ?? AUDIT_PAGE_SIZE, 1), MAX_AUDIT_QUERY_LIMIT);
    if (input.page !== undefined) {
      if (!Number.isSafeInteger(input.page) || input.page < 1)
        throw new Error('AUDIT_QUERY_INVALID');
      return this.queryPage(scope, input.page, limit, input.from, input.to);
    }
    const cursor = decodeCursor(input.cursor);
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (scope !== null) {
      conditions.push('organization_id IN (?)');
      params.push(scope);
    }
    if (input.from !== undefined) {
      conditions.push('occurred_at>=?');
      params.push(input.from);
    }
    if (input.to !== undefined) {
      conditions.push('occurred_at<=?');
      params.push(input.to);
    }
    if (cursor !== undefined) {
      conditions.push('(occurred_at<? OR (occurred_at=? AND id<?))');
      params.push(cursor.occurredAt, cursor.occurredAt, cursor.id);
    }
    params.push(limit + 1);
    const [rows] = await this.database.auditRaw.query<RowDataPacket[]>(
      `${auditListSql(conditions)} LIMIT ?`,
      params
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      events: page.map(publicAuditEvent),
      ...(rows.length > limit && last !== undefined
        ? { nextCursor: encodeCursor(Number(last['occurred_at']), String(last['id'])) }
        : {})
    };
  }

  private async queryPage(
    scope: readonly number[] | null,
    requestedPage: number,
    limit: number,
    from?: number,
    to?: number
  ): Promise<{
    readonly events: readonly object[];
    readonly total: number;
    readonly page: number;
    readonly nextCursor?: string;
  }> {
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (scope !== null) {
      conditions.push('organization_id IN (?)');
      params.push(scope);
    }
    if (from !== undefined) {
      conditions.push('occurred_at>=?');
      params.push(from);
    }
    if (to !== undefined) {
      conditions.push('occurred_at<=?');
      params.push(to);
    }
    return withMysqlTransaction(this.database.auditRaw, async (connection) => {
      const [counts] = await connection.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS total FROM audit_events${auditWhere(conditions)}`,
        params
      );
      const total = Number(counts[0]?.['total'] ?? 0);
      const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / limit)));
      const [rows] = await connection.query<RowDataPacket[]>(
        `${auditListSql(conditions)} LIMIT ? OFFSET ?`,
        [...params, limit + 1, (page - 1) * limit]
      );
      const events = rows.slice(0, limit);
      const last = events.at(-1);
      return {
        events: events.map(publicAuditEvent),
        total,
        page,
        ...(rows.length > limit && last !== undefined
          ? { nextCursor: encodeCursor(Number(last['occurred_at']), String(last['id'])) }
          : {})
      };
    });
  }

  async export(
    actorUserId: number,
    range: { readonly from?: number; readonly to?: number } = {}
  ): Promise<string> {
    const scope = await this.readScope(actorUserId, 'AUDIT_EXPORT');
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (scope !== null) {
      conditions.push('organization_id IN (?)');
      params.push(scope);
    }
    if (range.from !== undefined) {
      conditions.push('occurred_at>=?');
      params.push(range.from);
    }
    if (range.to !== undefined) {
      conditions.push('occurred_at<=?');
      params.push(range.to);
    }
    params.push(MAX_EXPORT_ROWS);
    const [rows] = await this.database.auditRaw.query<RowDataPacket[]>(
      `SELECT id,event_type,occurred_at,result,error_code,actor_user_id,actor_username,
              authentication_method,provider_id,request_id,operation_id,session_public_id,target_type,target_id,target_name,
              organization_id,node_id,workspace_id,agent_session_id,run_id,client_message_id,
              queue_item_id,input_mode,metadata,EXISTS(SELECT 1 FROM audit_conversation_payloads payload
                WHERE payload.audit_event_id=audit_events.id) AS has_conversation_payload
       FROM audit_events ${conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`}
       ORDER BY occurred_at DESC,id DESC LIMIT ?`,
      params
    );
    const events = rows.map(publicAuditEvent);
    const keys = [
      'id',
      'eventType',
      'occurredAt',
      'result',
      'errorCode',
      'actorUserId',
      'actorUsername',
      'authenticationMethod',
      'providerId',
      'requestId',
      'operationId',
      'sessionPublicId',
      'targetType',
      'targetId',
      'targetName',
      'organizationId',
      'nodeId',
      'workspaceId',
      'agentSessionId',
      'runId',
      'clientMessageId',
      'queueItemId',
      'inputMode'
    ] as const;
    return [
      keys.join(','),
      ...events.map((event) =>
        keys.map((key) => csv((event as Record<string, unknown>)[key])).join(',')
      )
    ].join('\n');
  }

  async detail(actorUserId: number, auditEventId: string): Promise<object | undefined> {
    const scope = await this.readScope(actorUserId, 'AUDIT_READ');
    const conditions = ['event.id=?'];
    const params: unknown[] = [auditEventId];
    if (scope !== null) {
      conditions.push('event.organization_id IN (?)');
      params.push(scope);
    }
    const [rows] = await this.database.auditRaw.query<RowDataPacket[]>(
      `SELECT event.id,event.event_type,event.occurred_at,event.result,event.error_code,
              event.actor_user_id,event.actor_username,event.authentication_method,event.provider_id,
              event.request_id,event.operation_id,event.session_public_id,event.target_type,event.target_id,
              event.target_name,event.organization_id,event.node_id,event.workspace_id,event.agent_session_id,
              event.run_id,event.client_message_id,event.queue_item_id,event.input_mode,event.metadata,
              payload.conversation_id,payload.conversation_title,payload.user_message,
              payload.queue_item_id AS payload_queue_item_id,
              payload.audit_event_id IS NOT NULL AS has_conversation_payload
       FROM audit_events event
       LEFT JOIN audit_conversation_payloads payload ON payload.audit_event_id=event.id
       WHERE ${conditions.join(' AND ')} LIMIT 1`,
      params
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const event = publicAuditEvent(row) as Record<string, unknown>;
    if (row['user_message'] !== null && row['user_message'] !== undefined) {
      event['conversationPayload'] = {
        ...(row['conversation_id'] === null
          ? {}
          : { conversationId: String(row['conversation_id']) }),
        conversationTitle: String(row['conversation_title']),
        userMessage: String(row['user_message']),
        ...(row['payload_queue_item_id'] === null
          ? {}
          : { queueItemId: String(row['payload_queue_item_id']) })
      };
    }
    return event;
  }

  async retentionDays(): Promise<number> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      "SELECT setting_value FROM system_settings WHERE setting_key='audit_retention_days'"
    );
    const value = rows[0]?.['setting_value'];
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Number.isSafeInteger(parsed) && Number(parsed) >= 1 && Number(parsed) <= 3650
      ? Number(parsed)
      : DEFAULT_RETENTION_DAYS;
  }

  async readRetentionDays(actorUserId: number): Promise<number> {
    await this.requireSystemSettingsManage(actorUserId);
    return this.retentionDays();
  }

  async setRetentionDays(actorUserId: number, days: number): Promise<void> {
    if (!Number.isSafeInteger(days) || days < 1 || days > 3650)
      throw new Error('AUDIT_RETENTION_INVALID');
    await this.requireSystemSettingsManage(actorUserId);
    await this.database.raw.execute(
      `INSERT INTO system_settings (setting_key,setting_value,updated_at)
       VALUES ('audit_retention_days',CAST(? AS JSON),?)
       ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value),updated_at=VALUES(updated_at)`,
      [JSON.stringify(days), this.now()]
    );
  }

  private async requireSystemSettingsManage(actorUserId: number): Promise<void> {
    const allowed = await this.authorization.authorize(actorUserId, 'SYSTEM_SETTINGS_MANAGE', {
      ownerType: 'SYSTEM'
    });
    if (
      !allowed.allowed &&
      (allowed.reason !== 'RBAC_ACTOR_INVALID' ||
        !(await this.authorization.isPersonalAdmin(actorUserId)))
    )
      throw new Error(allowed.reason ?? 'RBAC_DENIED');
  }

  async cleanupBatch(batchSize = DEFAULT_CLEANUP_BATCH_SIZE): Promise<number> {
    const cutoff = this.now() - (await this.retentionDays()) * 24 * 60 * 60 * 1000;
    const limit = normalizeCleanupBatchSize(batchSize);
    return withMysqlTransaction(this.database.auditRaw, async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT id FROM audit_events
         WHERE occurred_at<? ORDER BY occurred_at,id LIMIT ${limit} FOR UPDATE`,
        [cutoff]
      );
      if (rows.length === 0) return 0;
      const ids = rows.map((row) => String(row['id']));
      const placeholders = ids.map(() => '?').join(',');
      await connection.execute(
        `DELETE FROM audit_conversation_payloads WHERE audit_event_id IN (${placeholders})`,
        ids
      );
      const [result] = await connection.execute<ResultSetHeader>(
        `DELETE FROM audit_events WHERE id IN (${placeholders})`,
        ids
      );
      return result.affectedRows;
    });
  }

  private async readScope(
    actorUserId: number,
    permissionId: 'AUDIT_READ' | 'AUDIT_EXPORT'
  ): Promise<readonly number[] | null> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT role FROM users WHERE id=? AND enabled=TRUE',
      [actorUserId]
    );
    if (rows[0]?.['role'] === 'ADMIN') return null;
    const organizationIds = await this.authorization.managedOrganizationIds(actorUserId);
    if (organizationIds.length === 0) throw new Error('RBAC_DENIED');
    const allowed = await this.authorization.authorize(actorUserId, permissionId, {
      ownerType: 'ORGANIZATION',
      organizationId: organizationIds[0]!
    });
    if (!allowed.allowed) throw new Error(allowed.reason ?? 'RBAC_DENIED');
    return organizationIds;
  }
}

function normalizeCleanupBatchSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CLEANUP_BATCH_SIZE;
  return Math.min(Math.max(Math.floor(value), 1), MAX_CLEANUP_BATCH_SIZE);
}

function auditWhere(conditions: readonly string[]): string {
  return conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
}

function auditListSql(conditions: readonly string[]): string {
  return `SELECT id,event_type,occurred_at,result,error_code,actor_user_id,actor_username,
              authentication_method,provider_id,request_id,operation_id,session_public_id,target_type,target_id,target_name,
              organization_id,node_id,workspace_id,agent_session_id,run_id,client_message_id,
              queue_item_id,input_mode,metadata,EXISTS(SELECT 1 FROM audit_conversation_payloads payload
                WHERE payload.audit_event_id=audit_events.id) AS has_conversation_payload
       FROM audit_events${auditWhere(conditions)}
       ORDER BY occurred_at DESC,id DESC`;
}

function publicAuditEvent(row: RowDataPacket): object {
  const nullable = (key: string): string | null =>
    row[key] === null || row[key] === undefined ? null : String(row[key]);
  return {
    id: String(row['id']),
    eventType: String(row['event_type']),
    occurredAt: Number(row['occurred_at']),
    result: row['result'],
    errorCode: nullable('error_code'),
    actorUserId: row['actor_user_id'] === null ? null : Number(row['actor_user_id']),
    actorUsername: nullable('actor_username'),
    authenticationMethod: row['authentication_method'],
    providerId: nullable('provider_id'),
    requestId: nullable('request_id'),
    operationId: nullable('operation_id'),
    sessionPublicId: nullable('session_public_id'),
    targetType: nullable('target_type'),
    targetId: nullable('target_id'),
    targetName: nullable('target_name'),
    organizationId: row['organization_id'] === null ? null : Number(row['organization_id']),
    nodeId: nullable('node_id'),
    workspaceId: nullable('workspace_id'),
    agentSessionId: nullable('agent_session_id'),
    runId: nullable('run_id'),
    clientMessageId: nullable('client_message_id'),
    queueItemId: nullable('queue_item_id'),
    inputMode: nullable('input_mode'),
    hasConversationPayload: Boolean(row['has_conversation_payload']),
    metadata:
      typeof row['metadata'] === 'string' ? JSON.parse(row['metadata']) : (row['metadata'] ?? {})
  };
}

function sharedConversationIdempotencyKey(
  nodeId: string,
  workspaceId: string,
  sessionId: string,
  messageOrQueueId: string,
  eventType: string
): string {
  return createHash('sha256')
    .update(
      `${nodeId}\u0000${workspaceId}\u0000${sessionId}\u0000${messageOrQueueId}\u0000${eventType}`
    )
    .digest('hex');
}

function encodeCursor(occurredAt: number, id: string): string {
  return Buffer.from(JSON.stringify({ occurredAt, id })).toString('base64url');
}

function decodeCursor(value: string | undefined): { occurredAt: number; id: string } | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Number.isSafeInteger((parsed as { occurredAt?: unknown }).occurredAt) &&
      typeof (parsed as { id?: unknown }).id === 'string'
    )
      return parsed as { occurredAt: number; id: string };
  } catch {
    // Rejected below.
  }
  throw new Error('AUDIT_CURSOR_INVALID');
}

function csv(value: unknown): string {
  if (value === null || value === undefined) return '';
  const raw = String(value);
  const text = typeof value === 'string' && /^[=+\-@\t\r]/u.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
