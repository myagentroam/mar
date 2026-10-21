import { emitAudit, type AuditObserver } from './audit.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isAllowedOrigin } from './auth.js';
import { databaseError } from './domain-errors.js';
import { sendError } from './http-errors.js';
import { protectedManagementAdmin, validCsrf, type SessionLookup } from './session.js';
import { MailTemplateService, mailTemplateContent } from './mail-template-service.js';
import { MailSmtpService, validMailAddress } from './mail-smtp-service.js';

export function registerMailRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: SessionLookup & Partial<AuditObserver>;
  readonly smtp: MailSmtpService;
  readonly templates: MailTemplateService;
  readonly publicOrigin: string | undefined;
}): void {
  const { app, database, smtp, templates, publicOrigin } = input;
  const testSentAt = new Map<number, number>();

  function admin(request: FastifyRequest, reply: FastifyReply, write: boolean) {
    if (write && !isAllowedOrigin(request, publicOrigin)) {
      void sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      return undefined;
    }
    const actor = protectedManagementAdmin(database, request, reply);
    if (actor === undefined) return undefined;
    if (write && !validCsrf(request, actor)) {
      void sendError(reply, 403, 'CSRF_INVALID');
      return undefined;
    }
    return actor;
  }
  app.get('/api/mail/templates', async (request, reply) => {
    if (admin(request, reply, false) === undefined) return;
    try {
      return reply.send(await templates.list());
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.post<{ Body: unknown }>('/api/mail/templates/preview', async (request, reply) => {
    if (admin(request, reply, true) === undefined) return;
    const body = request.body as Record<string, unknown> | null;
    if (
      typeof body?.['templateId'] !== 'string' ||
      typeof body?.['message'] !== 'string' ||
      body['message'].length > 4000
    )
      return sendError(reply, 400, 'MAIL_INPUT_INVALID');
    try {
      const template = await templates.get(body['templateId']);
      return reply.send(
        await templates.render(body['templateId'], template.kind, {
          title: mailTemplateContent(template.locale).notification.previewTitle,
          message: body['message'],
          userName: 'User',
          workspaceName: 'Workspace',
          email: 'user@example.com'
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.post<{ Body: unknown }>('/api/mail/test', async (request, reply) => {
    const actor = admin(request, reply, true);
    if (actor === undefined) return;
    const body = request.body as Record<string, unknown> | null;
    if (!validMailAddress(body?.['email']) || typeof body?.['templateId'] !== 'string')
      return sendError(reply, 400, 'MAIL_INPUT_INVALID');
    if (Date.now() - (testSentAt.get(actor.userId) ?? 0) < 60_000)
      return sendError(reply, 429, 'MAIL_RATE_LIMITED');
    try {
      const rendered = await templates.render(body['templateId'], 'TEST', {
        title: 'Email test',
        email: body['email'],
        message: '',
        userName: actor.username,
        workspaceName: ''
      });
      testSentAt.set(actor.userId, Date.now());
      await smtp.send({ to: body['email'], ...rendered });
      emitAudit(database, {
        eventType: 'mail.test.executed',
        actorUserId: actor.userId,
        targetType: 'MAIL_TEMPLATE',
        targetId: body['templateId'],
        targetName: body['templateId']
      });
      return reply.send({ accepted: true });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
}
