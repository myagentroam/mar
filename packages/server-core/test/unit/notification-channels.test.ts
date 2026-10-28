import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  notificationInputSchema,
  notificationChannelsResultSchema,
  type MailNotificationRequest
} from '@myagentroam/protocol';
import {
  NotificationChannelService,
  resolveNotificationChannels
} from '../../src/notification-channel-service.js';
import { emptyPushResult } from '../../src/web-push-dispatcher.js';

function fixture() {
  const receipts = new Map<string, { payload_hash: string; notification_result: unknown }>();
  const state = { enabled: 1, total: 0, writeFailure: false, current: true };
  const execute = vi.fn(async (sql: string, args: unknown[] = []) => {
    if (sql.startsWith('SELECT enabled')) return [[{ enabled: state.enabled }], []];
    if (sql.startsWith('SELECT payload_hash'))
      return [[...receipts.entries()].filter(([key]) => key === args[0]).map(([, row]) => row), []];
    if (sql.startsWith('SELECT COUNT')) return [[{ total: state.total }], []];
    if (sql.startsWith('DELETE FROM mail_deliveries')) return [{ affectedRows: 0 }, []];
    if (sql.startsWith('INSERT INTO mail_deliveries')) {
      receipts.set(String(args[0]), {
        payload_hash: String(args[1]),
        notification_result: JSON.parse(String(args[7]))
      });
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith('UPDATE mail_deliveries')) {
      if (state.writeFailure) throw new Error('Database temporarily unavailable');
      receipts.get(String(args[1]))!.notification_result = JSON.parse(String(args[0]));
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const connection = {
    execute,
    beginTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn()
  };
  const database = {
    raw: { execute, getConnection: async () => connection },
    userCanRequestNode: vi.fn(async () => true)
  };
  const notification = { id: randomUUID() };
  const notifications = {
    consume: vi.fn(async () => true),
    bySource: vi.fn(async () => notification)
  };
  const mail = {
    send: vi.fn(
      async (_nodeId: string, _request: MailNotificationRequest, _isCurrent: () => boolean) =>
        undefined
    )
  };
  const dispatcher = {
    dispatch: vi.fn(async () => ({
      ...emptyPushResult('accepted', 'WEB_PUSH_ACCEPTED'),
      eligible: 2,
      attempted: 2,
      accepted: 2
    }))
  };
  const service = new NotificationChannelService({
    database: database as never,
    authorize: database.userCanRequestNode,
    notifications: notifications as never,
    mail,
    dispatcher,
    now: () => 1000
  });
  const request = {
    apiVersion: 1,
    eventType: 'notification',
    kind: 'AGENT_MESSAGE',
    occurredAt: 900,
    executionId: 'run-1',
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    sessionTitle: 'Example',
    userId: 1,
    source: 'MANUAL',
    callId: randomUUID(),
    message: 'Task complete.'
  };
  return {
    state,
    receipts,
    notifications,
    mail,
    dispatcher,
    service,
    request,
    database,
    send: (input: unknown = request) => service.send('node-1', input, () => state.current)
  };
}

describe('explicit notification channels', () => {
  it('passes the connection guard to email after channel admission', async () => {
    const f = fixture();
    let resume!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (resume = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    const deliver = vi.fn();
    f.mail.send.mockImplementationOnce(async (_node, _request, isCurrent) => {
      entered();
      await gate;
      if (!isCurrent()) throw new Error('MAIL_ACCESS_DENIED');
      deliver();
    });
    const sending = f.send({ ...f.request, channels: ['email'] });
    await started;
    f.state.current = false;
    resume();
    expect((await sending).email).toMatchObject({ status: 'failed' });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('defaults only to Push and reports aggregated multi-client acceptance after persistence', async () => {
    const f = fixture();
    const result = await f.send();
    expect(notificationChannelsResultSchema.safeParse(result).success).toBe(true);
    expect(result.push).toMatchObject({
      persisted: true,
      delivery: { accepted: 2, status: 'accepted' }
    });
    expect(result.email).toBeUndefined();
    expect(f.notifications.consume).toHaveBeenCalledWith(
      'node-1',
      expect.objectContaining({
        kind: 'AGENT_MESSAGE',
        userId: 1,
        targetType: 'WORKSPACE_SESSION'
      }),
      false
    );
    expect(f.mail.send).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('endpoint');
  });

  it('keeps email-only calls out of the notification center', async () => {
    const f = fixture();
    const result = await f.send({
      ...f.request,
      channels: ['email'],
      recipientEmail: 'other@example.test'
    });
    expect(result).toMatchObject({ email: { status: 'accepted' } });
    expect(result.push).toBeUndefined();
    expect(f.notifications.consume).not.toHaveBeenCalled();
    expect(f.mail.send).toHaveBeenCalledWith(
      'node-1',
      expect.objectContaining({ recipientEmail: 'other@example.test', templateId: '' }),
      expect.any(Function)
    );
  });

  it.each([{ channels: ['email'] }, { channels: ['push', 'email'] }])(
    'allows account-email delivery for channels $channels without a model-supplied address',
    async ({ channels }) => {
      const f = fixture();
      expect(notificationInputSchema.safeParse({ channels, message: 'Done' }).success).toBe(true);
      const request = { ...f.request, channels };
      const result = await f.send(request);
      expect(result.email).toEqual({ status: 'accepted' });
      expect(f.mail.send).toHaveBeenCalledWith(
        'node-1',
        expect.objectContaining({ userId: 1 }),
        expect.any(Function)
      );
      expect(f.mail.send.mock.calls[0]![1]).not.toHaveProperty('recipientEmail');
      expect(await f.send(request)).toEqual(result);
      expect(f.mail.send).toHaveBeenCalledOnce();
      if (channels.includes('push')) expect(result.push?.persisted).toBe(true);
      else expect(f.notifications.consume).not.toHaveBeenCalled();
    }
  );

  it('continues Push when the account email is missing and returns an actionable email error', async () => {
    const f = fixture();
    f.mail.send.mockRejectedValue(new Error('MAIL_RECIPIENT_NOT_CONFIGURED'));
    const result = await f.send({ ...f.request, channels: ['push', 'email'] });
    expect(result).toMatchObject({
      email: {
        status: 'failed',
        error: {
          code: 'MAIL_RECIPIENT_NOT_CONFIGURED',
          message: expect.stringContaining('account email')
        }
      },
      push: { persisted: true }
    });
  });

  it('continues Push when email fails and replays reordered channels without sending again', async () => {
    const f = fixture();
    f.mail.send.mockRejectedValue(new Error('MAIL_NOT_CONFIGURED'));
    const request = {
      ...f.request,
      channels: ['email', 'push'],
      recipientEmail: 'other@example.test'
    };
    const result = await f.send(request);
    expect(result).toMatchObject({
      email: { status: 'failed', error: { code: 'MAIL_NOT_CONFIGURED' } },
      push: { persisted: true }
    });
    expect(await f.send({ ...request, channels: ['push', 'email'] })).toEqual(result);
    expect(f.mail.send).toHaveBeenCalledOnce();
    expect(f.dispatcher.dispatch).toHaveBeenCalledOnce();
    await expect(f.send({ ...request, message: 'Changed' })).rejects.toThrow(
      'NOTIFICATION_CALL_CONFLICT'
    );
  });

  it('retains uncertainty on replay after a result-write failure instead of repeating side effects', async () => {
    const f = fixture();
    f.state.writeFailure = true;
    const request = {
      ...f.request,
      channels: ['push', 'email'],
      recipientEmail: 'other@example.test'
    };
    expect(await f.send(request)).toMatchObject({ email: { status: 'accepted' } });
    expect(await f.send(request)).toMatchObject({
      email: { status: 'uncertain' },
      push: { persisted: false, delivery: { status: 'uncertain' } }
    });
    expect(f.mail.send).toHaveBeenCalledOnce();
    expect(f.dispatcher.dispatch).toHaveBeenCalledOnce();
  });

  it('does not restart an in-flight multi-client dispatch on duplicate requests', async () => {
    const f = fixture();
    let finish!: (value: ReturnType<typeof emptyPushResult>) => void;
    f.dispatcher.dispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const first = f.send();
    await vi.waitFor(() => expect(f.dispatcher.dispatch).toHaveBeenCalledOnce());
    expect(await f.send()).toMatchObject({
      push: { persisted: true, delivery: { status: 'uncertain' } }
    });
    finish(emptyPushResult('suppressed', 'WEB_PUSH_ONLINE'));
    expect(await first).toMatchObject({ push: { delivery: { status: 'suppressed' } } });
    expect(f.dispatcher.dispatch).toHaveBeenCalledOnce();
  });

  it('validates all input and common authorization before either channel has side effects', async () => {
    const f = fixture();
    for (const input of [
      { channels: [] },
      { channels: ['push', 'push'] },
      { channels: ['email'], recipientEmail: 'invalid-address' },
      { channels: ['email'], recipientEmail: '' },
      { channels: ['push'], recipientEmail: 'other@example.test' },
      { channels: ['sms'] },
      { userId: 0 }
    ]) {
      await expect(f.send({ ...f.request, ...input })).rejects.toThrow(
        'NOTIFICATION_INPUT_INVALID'
      );
    }
    expect(
      notificationInputSchema.safeParse({ message: 'x', recipientEmail: 'other@example.test' })
        .success
    ).toBe(false);
    f.state.enabled = 0;
    await expect(f.send()).rejects.toThrow('NOTIFICATION_ACCESS_DENIED');
    f.state.enabled = 1;
    f.state.current = false;
    await expect(f.send()).rejects.toThrow('NOTIFICATION_ACCESS_DENIED');
    f.state.current = true;
    f.state.total = 50;
    await expect(f.send()).rejects.toThrow('NOTIFICATION_RATE_LIMITED');
    expect(f.notifications.consume).not.toHaveBeenCalled();
    expect(f.mail.send).not.toHaveBeenCalled();
  });

  it('exposes bounded English errors without forwarding raw exceptions', async () => {
    const respond = vi.fn();
    await resolveNotificationChannels({
      nodeId: 'node-1',
      envelope: { payload: {} } as never,
      isCurrentConnection: () => true,
      service: {
        send: async () => {
          throw new Error('secret raw diagnostic');
        }
      },
      respond
    });
    expect(respond).toHaveBeenCalledWith({
      error: { code: 'NOTIFICATION_DELIVERY_UNCERTAIN', message: expect.any(String) }
    });
    expect(JSON.stringify(respond.mock.calls)).not.toContain('secret');
  });
});
