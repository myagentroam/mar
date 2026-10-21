import { registerSystemSettingsRoutes as registerCore } from '@myagentroam/server-core/system-settings-routes';
import type { AuditService } from '../audit/audit-service.js';
export function registerSystemSettingsRoutes(
  input: Omit<Parameters<typeof registerCore>[0], 'extensions'> & {
    readonly audits: Pick<AuditService, 'readRetentionDays' | 'setRetentionDays'>;
  }
): void {
  registerCore({
    ...input,
    extensions: [
      {
        key: 'audit-retention',
        field: 'auditRetentionDays',
        read: (userId) => input.audits.readRetentionDays(userId),
        write: async (userId, raw) => {
          if (
            raw === null ||
            typeof raw !== 'object' ||
            !('days' in raw) ||
            typeof raw.days !== 'number' ||
            !Number.isSafeInteger(raw.days) ||
            raw.days < 1 ||
            raw.days > 3650
          )
            throw new Error('SYSTEM_SETTING_INPUT_INVALID');
          await input.audits.setRetentionDays(userId, raw.days);
        }
      }
    ]
  });
}
