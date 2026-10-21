import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createEnvelope,
  type NodeEnvelope,
  type NotificationChannelsRequest
} from '@myagentroam/protocol';
import { MailNotificationControl } from '../../src/service/mail-notification-control.js';

function fixture() {
  const envelopes: NodeEnvelope[] = [];
  const control = new MailNotificationControl((envelope) => {
    envelopes.push(envelope);
  });
  const request: NotificationChannelsRequest = {
    apiVersion: 1,
    eventType: 'notification',
    kind: 'AGENT_MESSAGE',
    executionId: 'run-1',
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    sessionTitle: 'Session',
    userId: 1,
    source: 'MANUAL',
    callId: randomUUID(),
    channels: ['push'],
    message: 'Done',
    occurredAt: 1000
  };
  return { control, request, envelopes };
}

describe('negotiated notification control', () => {
  it('rejects unknown/missing capability versions and keeps the stable call ID in correlated replies', async () => {
    const f = fixture();
    f.control.connected();
    await expect(f.control.notification(f.request)).rejects.toThrow('NOTIFICATION_UNSUPPORTED');
    f.control.setFeatures({ notificationChannels: { apiVersion: 2 } });
    expect(f.control.supportsChannels()).toBe(false);
    f.control.setFeatures({ notificationChannels: { apiVersion: 1 } });
    const pending = f.control.notification(f.request);
    const request = f.envelopes[0]!;
    expect(request.type).toBe('notification.channels.send');
    expect(request.payload).toMatchObject({ callId: f.request.callId });
    expect(
      f.control.handle(
        createEnvelope(
          'notification.channels.response',
          { callId: f.request.callId },
          { replyTo: request.id }
        )
      )
    ).toBe(true);
    expect(await pending).toEqual({ callId: f.request.callId });
    f.control.close();
  });

  it('does not settle a multi-channel call with a legacy response and revokes on reconnect', async () => {
    const f = fixture();
    f.control.connected();
    f.control.setFeatures({ notificationChannels: { apiVersion: 1 } });
    const pending = f.control.notification(f.request);
    const rejected = expect(pending).rejects.toThrow('MAIL_DELIVERY_UNCERTAIN');
    const settled = vi.fn();
    void pending.then(settled, () => undefined);
    f.control.handle(
      createEnvelope(
        'mail.notification.response',
        { accepted: true },
        { replyTo: f.envelopes[0]!.id }
      )
    );
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    f.control.disconnected();
    await rejected;
    f.control.connected();
    expect(f.control.supportsChannels()).toBe(false);
    f.control.close();
  });
});
