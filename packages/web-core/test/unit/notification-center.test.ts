import { createSSRApp, h, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import SystemNotificationControl from '../../src/view/settings/SystemNotificationControl.vue';
import WorkbenchActivityCenter from '../../src/view/workbench/WorkbenchActivityCenter.vue';
import { createWorkbenchNotificationService } from '../../src/service/workbench-notification-service.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { commonMessages } from '../../src/i18n/messages.js';

const originalLocale = localePreferenceService().locale.value;
afterEach(() => localePreferenceService().setLocale(originalLocale));

describe('Shared notification center', () => {
  it.each(['en-US', 'zh-CN'] as const)(
    'renders the desktop notification action and unsupported status without repeating the page title: %s',
    async (locale) => {
      localePreferenceService().setLocale(locale);
      const service = createWorkbenchNotificationService(ref('user'));
      const app = createSSRApp({
        render: () => h(SystemNotificationControl, { service: service.systemNotifications })
      });
      app.use(i18n);
      app.directive('tooltip', { getSSRProps: () => ({}) });
      const html = await renderToString(app);
      expect(html).not.toMatch(/<h3\b/u);
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
          h(WorkbenchActivityCenter, {
            service,
            uploads: [],
            statusLabel: () => '',
            mobileMode: false
          })
      });
      app.use(i18n);
      app.directive('tooltip', { getSSRProps: () => ({}) });
      const html = await renderToString(app);
      expect(html).toContain(commonMessages[locale].activityCenter.title.replaceAll('&', '&amp;'));
      expect(html).toMatch(/activity-entry-count[^>]*>1</);
      expect(service.unreadCount.value).toBe(1);
      expect(service.notifications.value[0]?.read).toBe(false);
      service.dispose();
    }
  );
});
