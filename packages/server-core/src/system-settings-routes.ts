import type { FastifyInstance } from 'fastify';
import { emitAudit, type AuditObserver } from './audit.js';
import { isAllowedOrigin } from './auth.js';
import { protectedManagementAdmin, validCsrf, type SessionLookup } from './session.js';
import { sendError } from './http-errors.js';
import { databaseError } from './domain-errors.js';
import type { SkillNetworkPolicy } from './skill-network-policy.js';
import type { HtmlPreviewOrigin } from './html-preview-origin.js';
import type { MailSmtpService } from './mail-smtp-service.js';
import type { WebPushConfiguration } from './web-push-configuration.js';

export interface SystemSettingExtension {
  readonly key: string;
  readonly field: string;
  read(userId: number): Promise<number | boolean | string>;
  write(userId: number, body: unknown): Promise<void>;
}

export function registerSystemSettingsRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: SessionLookup & Partial<AuditObserver>;
  readonly network: Pick<SkillNetworkPolicy, 'disabled' | 'setDisabled'>;
  readonly htmlPreviewOrigin: Pick<HtmlPreviewOrigin, 'read' | 'write'>;
  readonly smtp?: Pick<MailSmtpService, 'read' | 'write'>;
  readonly webPush?: Pick<WebPushConfiguration, 'read' | 'setEnabled'>;
  readonly publicOrigin: string | undefined;
  readonly extensions?: readonly SystemSettingExtension[];
}): void {
  const { app, database, network, publicOrigin } = input;
  const settings: readonly SystemSettingExtension[] = [
    ...(input.extensions ?? []),
    ...(input.webPush === undefined
      ? []
      : [
          {
            key: 'web-push',
            field: 'webPushEnabled',
            read: async () => (await input.webPush!.read()).enabled,
            write: async (_userId: number, raw: unknown) => {
              if (
                raw === null ||
                typeof raw !== 'object' ||
                Array.isArray(raw) ||
                Object.keys(raw).length !== 1 ||
                !('enabled' in raw) ||
                typeof raw.enabled !== 'boolean'
              )
                throw new Error('WEB_PUSH_INPUT_INVALID');
              await input.webPush!.setEnabled(raw.enabled);
            }
          }
        ]),
    ...(input.smtp === undefined
      ? []
      : [
          {
            key: 'mail-smtp',
            field: 'smtpConfiguration',
            read: () => input.smtp!.read(),
            write: async (_userId: number, raw: unknown) => {
              if (raw === null || typeof raw !== 'object' || !('config' in raw))
                throw new Error('MAIL_CONFIGURATION_INVALID');
              await input.smtp!.write(raw.config);
            }
          }
        ]),
    {
      key: 'html-preview-origin',
      field: 'htmlPreviewOrigin',
      read: () => input.htmlPreviewOrigin.read(),
      write: async (_userId, raw) => {
        if (
          raw === null ||
          typeof raw !== 'object' ||
          !('origin' in raw) ||
          typeof raw.origin !== 'string'
        )
          throw new Error('SYSTEM_SETTING_INPUT_INVALID');
        await input.htmlPreviewOrigin.write(raw.origin);
      }
    },
    {
      key: 'skill-tls',
      field: 'skillTlsVerificationDisabled',
      read: () => network.disabled(),
      write: async (_userId, raw) => {
        if (
          raw === null ||
          typeof raw !== 'object' ||
          !('verificationDisabled' in raw) ||
          typeof raw.verificationDisabled !== 'boolean'
        )
          throw new Error('SYSTEM_SETTING_INPUT_INVALID');
        await network.setDisabled(raw.verificationDisabled);
      }
    }
  ];
  const byKey = new Map(settings.map((setting) => [setting.key, setting]));
  if (
    byKey.size !== settings.length ||
    new Set(settings.map((setting) => setting.field)).size !== settings.length
  )
    throw new Error('SYSTEM_SETTING_DUPLICATE');
  const snapshot = async (userId: number) =>
    Object.fromEntries(
      await Promise.all(
        settings.map(async (setting) => [setting.field, await setting.read(userId)])
      )
    );
  app.get('/api/system-settings', async (request, reply) => {
    const actor = protectedManagementAdmin(database, request, reply);
    if (actor === undefined) return;
    try {
      return reply.send(await snapshot(actor.userId));
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.patch<{ Params: { settingKey: string }; Body: unknown }>(
    '/api/system-settings/:settingKey',
    async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const actor = protectedManagementAdmin(database, request, reply);
      if (actor === undefined) return;
      if (!validCsrf(request, actor)) return sendError(reply, 403, 'CSRF_INVALID');
      const setting = byKey.get(request.params.settingKey);
      if (setting === undefined) return sendError(reply, 404, 'SYSTEM_SETTING_NOT_FOUND');
      try {
        await setting.write(actor.userId, request.body);
        emitAudit(database, {
          eventType: 'system_setting.updated',
          actorUserId: actor.userId,
          requestId: request.id,
          targetType: 'SYSTEM_SETTING',
          targetId: setting.key,
          targetName: setting.key,
          metadata: JSON.stringify({ action: 'UPDATE', name: setting.key })
        });
        return reply.send(await snapshot(actor.userId));
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
}
