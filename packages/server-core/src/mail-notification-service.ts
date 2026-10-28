import { createHash } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { MailNotificationRequest } from '@myagentroam/protocol';
import type { NodeRequestAuthorization } from './node-access-contracts.js';
import { MailSmtpService, validMailAddress } from './mail-smtp-service.js';
import { MailTemplateService } from './mail-template-service.js';

const MAX_EMAILS_PER_EXECUTION = 50;

export class MailNotificationService {
  constructor(
    private readonly database: {
      readonly raw: Pool;
    },
    private readonly authorize: NodeRequestAuthorization,
    private readonly smtp: MailSmtpService,
    private readonly templates: MailTemplateService
  ) {}

  async send(
    nodeId: string,
    request: MailNotificationRequest,
    isCurrentConnection: () => boolean
  ): Promise<void> {
    if (request.recipientEmail !== undefined && !validMailAddress(request.recipientEmail))
      throw new Error('MAIL_INPUT_INVALID');
    if (
      request.title !== undefined &&
      (request.title.length > 160 || /[\r\n]/u.test(request.title))
    )
      throw new Error('MAIL_INPUT_INVALID');
    const requestedTitle = request.title?.trim() ?? '';
    const authorized = async () => {
      if (!isCurrentConnection()) return false;
      const allowed = await this.authorize(
        request.userId,
        nodeId,
        'session.message',
        { workspaceId: request.workspaceId, sessionId: request.sessionId },
        request.workspaceId
      );
      return allowed && isCurrentConnection();
    };
    if (!(await authorized())) throw new Error('MAIL_ACCESS_DENIED');
    const connection = await this.database.raw.getConnection();
    const sourceKey = createHash('sha256')
      .update(JSON.stringify([nodeId, request.executionId, request.callId]))
      .digest('hex');
    const payloadHash = createHash('sha256')
      .update(
        JSON.stringify([
          request.userId,
          request.workspaceId,
          request.sessionId,
          request.recipientEmail,
          request.templateId,
          requestedTitle,
          request.message
        ])
      )
      .digest('hex');
    let userName = '';
    let workspaceName = '';
    let duplicate = false;
    let recipientEmail = request.recipientEmail;
    let rendered: Awaited<ReturnType<MailTemplateService['render']>> | undefined;
    try {
      await connection.beginTransaction();
      const [users] = await connection.execute<RowDataPacket[]>(
        'SELECT username,nickname,email,locale,enabled FROM users WHERE id=? FOR UPDATE',
        [request.userId]
      );
      const user = users[0];
      if (user === undefined || user['enabled'] !== 1) throw new Error('MAIL_ACCESS_DENIED');
      userName = String(user['nickname'] ?? user['username']);
      const [workspaces] = await connection.execute<RowDataPacket[]>(
        'SELECT display_name FROM workspaces WHERE workspace_id=? AND node_id=?',
        [request.workspaceId, nodeId]
      );
      if (workspaces.length !== 1) throw new Error('MAIL_ACCESS_DENIED');
      workspaceName = String(workspaces[0]!['display_name']);
      const [existing] = await connection.execute<RowDataPacket[]>(
        'SELECT status,payload_hash FROM mail_deliveries WHERE source_key=?',
        [sourceKey]
      );
      if (existing.length > 0) {
        if (existing[0]!['payload_hash'] !== payloadHash) throw new Error('MAIL_CALL_CONFLICT');
        if (existing[0]!['status'] !== 'SENT') throw new Error('MAIL_DELIVERY_UNCERTAIN');
        duplicate = true;
      } else {
        if (recipientEmail === undefined) {
          const accountEmail = user['email'];
          if (!validMailAddress(accountEmail)) throw new Error('MAIL_RECIPIENT_NOT_CONFIGURED');
          recipientEmail = accountEmail;
        }
        if ((await this.smtp.read()) === '{}') throw new Error('MAIL_NOT_CONFIGURED');
        const templateId =
          request.templateId === ''
            ? user['locale'] === 'en-US'
              ? 'notification-en-US'
              : 'notification-zh-CN'
            : request.templateId;
        rendered = await this.templates.render(templateId, 'NOTIFICATION', {
          email: recipientEmail,
          title: requestedTitle,
          userName,
          workspaceName,
          message: request.message
        });
        const [count] = await connection.execute<RowDataPacket[]>(
          'SELECT COUNT(*) AS total FROM mail_deliveries WHERE user_id=? AND execution_id=? AND notification_result IS NULL',
          [request.userId, request.executionId]
        );
        if (Number(count[0]?.['total']) >= MAX_EMAILS_PER_EXECUTION)
          throw new Error('MAIL_RATE_LIMITED');
        await connection.execute(
          `INSERT INTO mail_deliveries
           (source_key,payload_hash,user_id,node_id,execution_id,call_id,status,created_at)
           VALUES (?,?,?,?,?,?,'UNKNOWN',?)`,
          [
            sourceKey,
            payloadHash,
            request.userId,
            nodeId,
            request.executionId,
            request.callId,
            Date.now()
          ]
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    if (duplicate) return;
    await this.smtp.send({ to: recipientEmail!, ...rendered! }, authorized);
    await this.database.raw.execute(
      "UPDATE mail_deliveries SET status='SENT' WHERE source_key=? AND status='UNKNOWN'",
      [sourceKey]
    );
  }
}
