import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { ServerNotification } from '@myagentroam/protocol';
import { createWorkbenchNotificationService } from '../../src/service/workbench-notification-service.js';

afterEach(() => vi.unstubAllGlobals());
const record = (id: string): ServerNotification => ({
  id,
  kind: 'schedule',
  title: '任务完成',
  message: 'Original user text',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  expiresAt: Date.now() + 60000,
  read: false,
  target: {
    targetType: 'WORKSPACE_SESSION',
    nodeId: 'node',
    workspaceId: 'workspace',
    sessionId: 'other'
  }
});

describe('notification scenario routing', () => {
  it('previews the confirmed ID rather than the newest list entry without external permission', async () => {
    vi.stubGlobal('Notification', { permission: 'denied' });
    const created = record('confirmed');
    const newest = { ...record('newer'), createdAt: created.createdAt + 1 };
    const service = createWorkbenchNotificationService(ref('alice'), {
      request: async <T>() => ({ notifications: [newest, created] }) as T
    });
    service.projectServerMessage({ type: 'notification.created', notification: created });
    await service.load();
    expect(service.previewNotificationId.value).toBe('confirmed');
    expect(service.notifications.value[0]?.id).toBe('newer');
    expect(service.notificationRevision.value).toBe(1);
    service.dispose();
  });

  it.each([true, false])(
    'cancels rather than reroutes a create across focus change from %s',
    async (foreground) => {
      const browser = { foreground };
      vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => browser.foreground });
      let finish!: (value: { notifications: ServerNotification[] }) => void;
      const service = createWorkbenchNotificationService(ref('alice'), {
        request: <T>() =>
          new Promise<T>((resolve) => {
            finish = resolve as typeof finish;
          })
      });
      const show = vi.spyOn(service.systemNotifications, 'show');
      const created = record('focus-change');
      service.projectServerMessage({ type: 'notification.created', notification: created });
      browser.foreground = !foreground;
      finish({ notifications: [created] });
      await vi.waitFor(() => expect(service.notifications.value).toHaveLength(1));
      expect(service.notificationRevision.value).toBe(0);
      expect(show).not.toHaveBeenCalled();
      service.dispose();
    }
  );

  it('does not preview an already-read confirmation or a background upload', async () => {
    vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => false });
    const created = record('read');
    const service = createWorkbenchNotificationService(ref('alice'), {
      request: async <T>() => ({ notifications: [{ ...created, read: true }] }) as T
    });
    service.projectServerMessage({ type: 'notification.created', notification: created });
    service.notify({ id: 'upload', kind: 'upload', title: 'Upload', message: '' });
    await service.load();
    expect(service.notificationRevision.value).toBe(0);
    expect(service.notifications.value.find((item) => item.id === 'upload')?.read).toBe(true);
    service.dispose();
  });
});
