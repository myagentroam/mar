import { createHash } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import {
  notificationChannelsRequestSchema,
  notificationChannelsResultSchema,
  type NotificationChannelsRequest,
  type NotificationChannelsResult
} from '@myagentroam/protocol';
import type { NotificationStore } from './notification-contracts.js';
import type { MailNotificationService } from './mail-notification-service.js';
import type { WorkbenchNotificationService } from './workbench-notification-service.js';
import { withMysqlTransaction } from './mysql-reference-store.js';
import { emptyPushResult, type WebPushDispatcher } from './web-push-dispatcher.js';
import type { NodeEnvelope, NotificationChannelsResponse } from '@myagentroam/protocol';

const errors: Readonly<Record<string, string>> = {
  NOTIFICATION_INPUT_INVALID: 'The notification channels or input parameters are invalid.',
  NOTIFICATION_ACCESS_DENIED:
    'The notification execution is no longer authorized for this user and target.',
  NOTIFICATION_CALL_CONFLICT: 'This notification call ID is already bound to different input.',
  NOTIFICATION_RATE_LIMITED: 'This execution has reached its notification call limit.',
  NOTIFICATION_UNAVAILABLE: 'The Server notification channel service is unavailable.',
  NOTIFICATION_DELIVERY_UNCERTAIN:
    'The notification result could not be confirmed. Do not retry with a new call ID.'
};

export async function resolveNotificationChannels(input: {
  readonly nodeId: string;
  readonly envelope: NodeEnvelope;
  readonly isCurrentConnection: () => boolean;
  readonly service: Pick<NotificationChannelService, 'send'> | undefined;
  readonly respond: (result: NotificationChannelsResponse) => void;
}): Promise<void> {
  try {
    if (!input.isCurrentConnection()) throw new Error('NOTIFICATION_ACCESS_DENIED');
    if (input.service === undefined) throw new Error('NOTIFICATION_UNAVAILABLE');
    input.respond(
      await input.service.send(input.nodeId, input.envelope.payload, input.isCurrentConnection)
    );
  } catch (error) {
    const code =
      error instanceof Error && Object.hasOwn(errors, error.message)
        ? error.message
        : 'NOTIFICATION_DELIVERY_UNCERTAIN';
    input.respond({ error: { code, message: errors[code]! } });
  }
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Owns one admitted MCP call; device delivery state remains in the bounded dispatcher. */
export class NotificationChannelService {
  constructor(
    private readonly input: {
      readonly database: NotificationStore;
      readonly notifications: Pick<WorkbenchNotificationService, 'consume' | 'bySource'>;
      readonly mail: Pick<MailNotificationService, 'send'>;
      readonly dispatcher?: Pick<WebPushDispatcher, 'dispatch'>;
      readonly now?: () => number;
    }
  ) {}

  async send(
    nodeId: string,
    value: unknown,
    isCurrent: () => boolean
  ): Promise<NotificationChannelsResult> {
    const parsed = notificationChannelsRequestSchema.safeParse(value);
    if (!parsed.success) throw new Error('NOTIFICATION_INPUT_INVALID');
    const request = parsed.data;
    const authorized = async () =>
      isCurrent() &&
      (await this.input.database.userCanRequestNode(
        request.userId,
        nodeId,
        'session.message',
        { workspaceId: request.workspaceId, sessionId: request.sessionId },
        request.workspaceId
      ));
    if (!(await authorized())) throw new Error('NOTIFICATION_ACCESS_DENIED');
    const key = digest(['notification-v1', nodeId, request.executionId, request.callId]);
    // Metadata timestamps are not model input; channel ordering is semantically irrelevant.
    const hash = digest([
      request.userId,
      request.workspaceId,
      request.sessionId,
      request.source,
      [...request.channels].sort(),
      request.title ?? '',
      request.message,
      request.recipientEmail ?? '',
      request.templateId ?? ''
    ]);
    const result: NotificationChannelsResult = {
      callId: request.callId,
      ...(request.channels.includes('push')
        ? {
            push: {
              persisted: false,
              delivery: emptyPushResult('uncertain', 'NOTIFICATION_DELIVERY_UNCERTAIN')
            }
          }
        : {}),
      ...(request.channels.includes('email') ? { email: { status: 'uncertain' as const } } : {})
    };
    const replay = await this.reserve(nodeId, request, key, hash, result, isCurrent);
    if (replay !== undefined) return replay;
    let current = result;
    const save = async () => {
      // A failed result write must never turn a completed channel into a retryable call.
      try {
        await this.input.database.raw.execute(
          'UPDATE mail_deliveries SET notification_result=? WHERE source_key=? AND payload_hash=?',
          [JSON.stringify(current), key, hash]
        );
      } catch {
        /* The already committed uncertain receipt prevents all replay side effects. */
      }
    };
    if (request.channels.includes('email')) {
      try {
        if (!(await authorized())) throw new Error('MAIL_ACCESS_DENIED');
        await this.input.mail.send(nodeId, {
          executionId: request.executionId,
          sessionId: request.sessionId,
          workspaceId: request.workspaceId,
          userId: request.userId,
          source: request.source,
          callId: request.callId,
          ...(request.recipientEmail === undefined
            ? {}
            : { recipientEmail: request.recipientEmail }),
          message: request.message,
          ...(request.title === undefined ? {} : { title: request.title }),
          templateId: request.templateId ?? ''
        });
        current = { ...current, email: { status: 'accepted' } };
      } catch (error) {
        const code =
          error instanceof Error && /^MAIL_[A-Z0-9_]{1,100}$/u.test(error.message)
            ? error.message
            : 'MAIL_DELIVERY_UNCERTAIN';
        current = {
          ...current,
          email: {
            status: code === 'MAIL_DELIVERY_UNCERTAIN' ? 'uncertain' : 'failed',
            error: {
              code,
              message:
                code === 'MAIL_RECIPIENT_NOT_CONFIGURED'
                  ? 'The initiating account has no valid email address. Configure an account email or specify recipientEmail.'
                  : 'The email channel did not confirm acceptance. Check the Server mail configuration and recipient.'
            }
          }
        };
      }
      await save();
    }
    if (request.channels.includes('push')) {
      try {
        if (!(await authorized())) throw new Error('NOTIFICATION_ACCESS_DENIED');
        const sourceId = `agent:${nodeId}:${request.executionId}:${request.callId}`;
        const consumed = await this.input.notifications.consume(
          nodeId,
          {
            ...request,
            notificationId: sourceId,
            runId: request.executionId,
            targetType: 'WORKSPACE_SESSION'
          },
          false
        );
        if (!consumed) throw new Error('NOTIFICATION_ACCESS_DENIED');
        const notification = await this.input.notifications.bySource(request.userId, sourceId);
        if (notification === undefined) throw new Error('NOTIFICATION_DELIVERY_UNCERTAIN');
        current = {
          ...current,
          push: {
            persisted: true,
            notificationId: notification.id,
            delivery: emptyPushResult('uncertain', 'NOTIFICATION_DELIVERY_UNCERTAIN')
          }
        };
        await save();
        const delivery =
          this.input.dispatcher === undefined
            ? emptyPushResult('skipped', 'WEB_PUSH_UNAVAILABLE')
            : await this.input.dispatcher.dispatch(request.userId, notification.id, authorized);
        current = { ...current, push: { ...current.push!, delivery } };
      } catch (error) {
        if (error instanceof Error && error.message === 'NOTIFICATION_ACCESS_DENIED')
          current = {
            ...current,
            push: {
              ...current.push!,
              delivery: emptyPushResult('failed', 'NOTIFICATION_ACCESS_DENIED')
            }
          };
        // Retain known persistence facts even if dispatch or result collection becomes uncertain.
      }
      await save();
    }
    return current;
  }

  private async reserve(
    nodeId: string,
    request: NotificationChannelsRequest,
    key: string,
    hash: string,
    initial: NotificationChannelsResult,
    isCurrent: () => boolean
  ): Promise<NotificationChannelsResult | undefined> {
    return withMysqlTransaction(this.input.database.raw, async (connection) => {
      const [users] = await connection.execute<RowDataPacket[]>(
        'SELECT enabled FROM users WHERE id=? FOR UPDATE',
        [request.userId]
      );
      if (users[0]?.['enabled'] !== 1 || !isCurrent())
        throw new Error('NOTIFICATION_ACCESS_DENIED');
      const timestamp = (this.input.now ?? Date.now)();
      await connection.execute(
        'DELETE FROM mail_deliveries WHERE user_id=? AND notification_result IS NOT NULL AND created_at<?',
        [request.userId, timestamp - 7 * 24 * 60 * 60_000]
      );
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT payload_hash,notification_result FROM mail_deliveries WHERE source_key=? FOR UPDATE',
        [key]
      );
      if (rows[0] !== undefined) {
        if (rows[0]['payload_hash'] !== hash) throw new Error('NOTIFICATION_CALL_CONFLICT');
        const raw = rows[0]['notification_result'];
        return notificationChannelsResultSchema.parse(
          typeof raw === 'string' ? JSON.parse(raw) : raw
        );
      }
      const [counts] = await connection.execute<RowDataPacket[]>(
        'SELECT COUNT(*) AS total FROM mail_deliveries WHERE user_id=? AND execution_id=? AND notification_result IS NOT NULL',
        [request.userId, request.executionId]
      );
      if (Number(counts[0]?.['total'] ?? 0) >= 50) throw new Error('NOTIFICATION_RATE_LIMITED');
      await connection.execute(
        `INSERT INTO mail_deliveries
        (source_key,payload_hash,user_id,node_id,execution_id,call_id,status,created_at,notification_result)
        VALUES (?,?,?,?,?,?,'UNKNOWN',?,?)`,
        [
          key,
          hash,
          request.userId,
          nodeId,
          request.executionId,
          request.callId,
          timestamp,
          JSON.stringify(initial)
        ]
      );
      return undefined;
    });
  }
}
