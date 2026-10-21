import { createSSRApp, h, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus from 'element-plus';
import { afterEach, describe, expect, it } from 'vitest';
import SystemNotificationControl from '../../src/view/settings/SystemNotificationControl.vue';
import WorkbenchNotificationCenter from '../../src/view/workbench/WorkbenchNotificationCenter.vue';
import { createWorkbenchNotificationService } from '../../src/service/WorkbenchNotificationService.js';
import { i18n, localePreferenceService } from '../../src/service/LocalePreferenceService.js';
import { commonMessages } from '../../src/i18n/messages.js';

const originalLocale = localePreferenceService().locale.value;
afterEach(() => localePreferenceService().setLocale(originalLocale));

describe('Shared notification center', () => {
  it.each([
    { locale: 'en-US', title: 'System notifications' },
    { locale: 'zh-CN', title: '系统通知' }
  ] as const)(
    'renders the plain system notification title, action and unsupported status: $locale',
    async ({ locale, title }) => {
      localePreferenceService().setLocale(locale);
      const service = createWorkbenchNotificationService(ref('user'));
      const app = createSSRApp({
        render: () => h(SystemNotificationControl, { service: service.systemNotifications })
      });
      app.use(i18n).use(ElementPlus);
      const html = await renderToString(app);
      expect(html.match(/<h3\b[^>]*>([^<]*)</u)?.[1]).toBe(title);
      expect(html).toContain(
        commonMessages[locale].workbenchNotificationCenter.systemNotifications.enable
      );
      expect(html).toContain(
        commonMessages[locale].workbenchNotificationCenter.systemNotifications.unsupported
      );
      expect(html).toContain('disabled');
      service.dispose();
    }
  );
  it.each(['en-US', 'zh-CN'] as const)(
    'renders the localized trigger and authoritative unread badge without marking notifications read: %s',
    async (locale) => {
      localePreferenceService().setLocale(locale);
      const service = createWorkbenchNotificationService(ref('user'), {
        request: async <T>() =>
          ({
            notifications: [
              {
                id: 'server-notification',
                kind: 'run',
                title: 'Original title',
                message: 'Original message',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                expiresAt: Date.now() + 60000,
                read: false,
                target: {
                  targetType: 'WORKSPACE_SESSION',
                  nodeId: 'node',
                  workspaceId: 'workspace',
                  sessionId: 'session'
                }
              }
            ]
          }) as T
      });
      await service.load();
      const app = createSSRApp({
        render: () =>
          h(WorkbenchNotificationCenter, { service, uploads: [], statusLabel: () => '' })
      });
      app.use(i18n).use(ElementPlus);
      const html = await renderToString(app);
      expect(html).toContain(
        commonMessages[locale].generated.workbenchNotificationCenter.openNotificationCenter
      );
      expect(html).toMatch(/workbench-notification-badge[^>]*>1</);
      expect(service.unreadCount.value).toBe(1);
      expect(service.notifications.value[0]?.read).toBe(false);
      service.dispose();
    }
  );
});
