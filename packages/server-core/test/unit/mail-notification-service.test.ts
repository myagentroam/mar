import { describe, expect, it, vi } from 'vitest';
import { MailNotificationService } from '../../src/mail-notification-service.js';
import { MailTemplateService } from '../../src/mail-template-service.js';
import { mailTemplatesEnUS } from '../../src/i18n/mail-templates.en-US.js';
import { mailTemplatesZhCN } from '../../src/i18n/mail-templates.zh-CN.js';
import { createEnvelope, type MailNotificationRequest } from '@myagentroam/protocol';
import { resolveMailNotification } from '../../src/mail-notification-channel.js';
import { NotificationChannelService } from '../../src/notification-channel-service.js';

const request: MailNotificationRequest = {
  executionId: 'run-1',
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  userId: 7,
  source: 'MANUAL',
  callId: '8e1668db-88e7-4a28-9ccd-cda8814a4e73',
  templateId: 'notification-en-US',
  title: 'Build completed',
  recipientEmail: 'recipient@example.test',
  message: 'Done'
};

function fixture(useRealTemplates = false) {
  let locale = 'zh-CN';
  let email: string | null = null;
  let enabled = 1;
  const deliveries = new Map<string, { status: string; payload_hash: string }>();
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(),
    execute: vi.fn(async (sql: string, args: unknown[] = []): Promise<unknown[]> => {
      if (sql.includes('FROM users WHERE'))
        return [[{ username: 'alice', email, locale, enabled, nickname: null }], []];
      if (sql.includes('FROM workspaces WHERE')) return [[{ display_name: 'Workspace' }], []];
      if (sql.includes('SELECT status,payload_hash FROM mail_deliveries'))
        return [[deliveries.get(String(args[0]))].filter((entry) => entry !== undefined), []];
      if (sql.includes('COUNT(*) AS total')) return [[{ total: deliveries.size }], []];
      if (sql.includes('INSERT INTO mail_deliveries')) {
        deliveries.set(String(args[0]), { status: 'UNKNOWN', payload_hash: String(args[1]) });
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected query: ${sql}`);
    })
  };
  const pool = {
    getConnection: vi.fn(async () => connection),
    execute: vi.fn(async (sql: string, args: unknown[] = []) => {
      if (sql.includes('FROM mail_templates')) {
        const id = String(args[0]);
        if (id !== 'notification-en-US' && id !== 'notification-zh-CN') return [[], []];
        const templateLocale = id === 'notification-en-US' ? 'en-US' : 'zh-CN';
        const content =
          templateLocale === 'en-US'
            ? mailTemplatesEnUS.notification
            : mailTemplatesZhCN.notification;
        return [
          [
            {
              id,
              kind: 'NOTIFICATION',
              locale: templateLocale,
              ...content,
              revision: 1,
              is_default: 1
            }
          ],
          []
        ];
      }
      if (sql.includes('UPDATE mail_deliveries SET status')) {
        deliveries.get(String(args[0]))!.status = 'SENT';
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected query: ${sql}`);
    })
  };
  const canUse = vi.fn(async () => true);
  const smtp = {
    read: vi.fn(async () => '{"host":"smtp.example.test"}'),
    send: vi.fn(async (_mail: unknown, authorize: () => Promise<boolean>) => {
      if (!(await authorize())) throw new Error('MAIL_ACCESS_DENIED');
    })
  };
  const templates = useRealTemplates
    ? new MailTemplateService({ raw: pool } as never)
    : { render: vi.fn(async () => ({ subject: 'Done', text: 'Done' })) };
  const service = new MailNotificationService(
    { raw: pool } as never,
    canUse,
    smtp as never,
    templates as never
  );
  return {
    service,
    canUse,
    smtp,
    templates,
    deliveries,
    setEmail: (value: string | null) => (email = value),
    setEnabled: (value: number) => (enabled = value),
    setLocale: (value: string) => (locale = value)
  };
}

describe('MailNotificationService', () => {
  it.each(['connection', 'authorization'] as const)(
    'multi-channel email does not deliver when %s changes during mail preparation',
    async (revoked) => {
      const state = fixture();
      let current = true;
      let resume!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => (resume = resolve));
      const started = new Promise<void>((resolve) => (entered = resolve));
      const deliver = vi.fn();
      state.smtp.send.mockImplementationOnce(async (_mail, authorize) => {
        entered();
        await gate;
        if (!(await authorize())) throw new Error('MAIL_ACCESS_DENIED');
        deliver();
      });
      const execute = vi.fn(async (sql: string) => {
        if (sql.startsWith('SELECT enabled')) return [[{ enabled: 1 }], []];
        if (sql.startsWith('SELECT payload_hash')) return [[], []];
        if (sql.startsWith('SELECT COUNT')) return [[{ total: 0 }], []];
        return [{ affectedRows: 1 }, []];
      });
      const connection = {
        execute,
        beginTransaction: vi.fn(),
        commit: vi.fn(),
        rollback: vi.fn(),
        release: vi.fn()
      };
      const channels = new NotificationChannelService({
        database: { raw: { execute, getConnection: async () => connection } } as never,
        authorize: state.canUse,
        notifications: { consume: vi.fn(), bySource: vi.fn() } as never,
        mail: state.service
      });
      const sending = channels.send(
        'node-1',
        {
          ...request,
          apiVersion: 1,
          eventType: 'notification',
          kind: 'AGENT_MESSAGE',
          occurredAt: 1,
          sessionTitle: 'Session',
          channels: ['email']
        },
        () => current
      );
      await started;
      if (revoked === 'connection') current = false;
      else state.canUse.mockResolvedValue(false);
      resume();
      expect((await sending).email).toMatchObject({ status: 'failed' });
      expect(deliver).not.toHaveBeenCalled();
    }
  );

  it.each(['connection', 'authorization'] as const)(
    'does not deliver when %s changes during mail preparation',
    async (revoked) => {
      const state = fixture();
      let current = true;
      let resume!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => (resume = resolve));
      const started = new Promise<void>((resolve) => (entered = resolve));
      const deliver = vi.fn();
      state.smtp.send.mockImplementationOnce(async (_mail, authorize) => {
        entered();
        await gate;
        if (!(await authorize())) throw new Error('MAIL_ACCESS_DENIED');
        deliver();
      });
      const sending = state.service.send('node-1', request, () => current);
      await started;
      if (revoked === 'connection') current = false;
      else state.canUse.mockResolvedValue(false);
      resume();
      await expect(sending).rejects.toThrow('MAIL_ACCESS_DENIED');
      expect(deliver).not.toHaveBeenCalled();
    }
  );

  it('defaults to the initiating account email and does not resend after that email changes', async () => {
    const state = fixture();
    state.setEmail('alice@example.test');
    const { recipientEmail: _recipientEmail, ...input } = request;
    await state.service.send('node-1', input, () => true);
    expect(state.smtp.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ to: 'alice@example.test' }),
      expect.any(Function)
    );
    expect(state.templates.render).toHaveBeenCalledWith(
      request.templateId,
      'NOTIFICATION',
      expect.objectContaining({ email: 'alice@example.test' })
    );
    state.setEmail(null);
    await state.service.send('node-1', input, () => true);
    state.setEmail('updated@example.test');
    await state.service.send('node-1', input, () => true);
    expect(state.smtp.send).toHaveBeenCalledOnce();
    await expect(
      state.service.send('node-1', { ...input, recipientEmail: 'alice@example.test' }, () => true)
    ).rejects.toThrow('MAIL_CALL_CONFLICT');
    await state.service.send(
      'node-1',
      {
        ...input,
        callId: '162d92c4-28ef-4d04-b939-4229352d4f60'
      },
      () => true
    );
    expect(state.smtp.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ to: 'updated@example.test' }),
      expect.any(Function)
    );
    expect(JSON.stringify([...state.deliveries.values()])).not.toContain('@example.test');
  });

  it.each([null, '', 'invalid-address'])(
    'rejects an unavailable account email: %s',
    async (email) => {
      const state = fixture();
      state.setEmail(email);
      const { recipientEmail: _recipientEmail, ...input } = request;
      await expect(state.service.send('node-1', input, () => true)).rejects.toThrow(
        'MAIL_RECIPIENT_NOT_CONFIGURED'
      );
      expect(state.smtp.send).not.toHaveBeenCalled();
      expect(state.deliveries.size).toBe(0);
    }
  );

  it('does not fall back for an invalid explicit address or send for an unauthorized account', async () => {
    const state = fixture();
    state.setEmail('alice@example.test');
    await expect(
      state.service.send('node-1', { ...request, recipientEmail: '' }, () => true)
    ).rejects.toThrow('MAIL_INPUT_INVALID');
    const { recipientEmail: _recipientEmail, ...input } = request;
    state.canUse.mockResolvedValue(false);
    await expect(state.service.send('node-1', input, () => true)).rejects.toThrow(
      'MAIL_ACCESS_DENIED'
    );
    state.canUse.mockResolvedValue(true);
    state.setEnabled(0);
    await expect(state.service.send('node-1', input, () => true)).rejects.toThrow(
      'MAIL_ACCESS_DENIED'
    );
    expect(state.smtp.send).not.toHaveBeenCalled();
    expect(state.deliveries.size).toBe(0);
  });

  it('does not resend an uncertain account-email delivery after the account email changes', async () => {
    const state = fixture();
    state.setEmail('alice@example.test');
    state.smtp.send.mockRejectedValueOnce(new Error('MAIL_DELIVERY_UNCERTAIN'));
    const { recipientEmail: _recipientEmail, ...input } = request;
    await expect(state.service.send('node-1', input, () => true)).rejects.toThrow(
      'MAIL_DELIVERY_UNCERTAIN'
    );
    state.setEmail('updated@example.test');
    await expect(state.service.send('node-1', input, () => true)).rejects.toThrow(
      'MAIL_DELIVERY_UNCERTAIN'
    );
    expect(state.smtp.send).toHaveBeenCalledOnce();
  });

  it('accepts the omitted recipient across the mail control boundary and reports missing account email', async () => {
    const state = fixture();
    const { recipientEmail: _recipientEmail, ...input } = request;
    const respond = vi.fn();
    const send = () =>
      resolveMailNotification({
        nodeId: 'node-1',
        envelope: createEnvelope('mail.notification.send', input),
        isCurrentConnection: () => true,
        service: state.service,
        respond
      });
    await send();
    expect(respond).toHaveBeenLastCalledWith({
      error: {
        code: 'MAIL_RECIPIENT_NOT_CONFIGURED',
        message: expect.stringContaining('account email')
      }
    });
    expect(state.smtp.send).not.toHaveBeenCalled();
    state.setEmail('alice@example.test');
    await send();
    expect(respond).toHaveBeenLastCalledWith({ accepted: true });
    expect(state.smtp.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ to: 'alice@example.test' }),
      expect.any(Function)
    );
  });

  it.each([
    ['zh-CN', 'notification-en-US', 'MyAgentRoam notification: ', 'Email notification'],
    ['en-US', 'notification-zh-CN', 'MyAgentRoam通知：', '邮件通知'],
    ['en-US', '', 'MyAgentRoam notification: ', 'Email notification'],
    ['zh-CN', '', 'MyAgentRoam通知：', '邮件通知']
  ] as const)(
    'uses the resolved template title for sender %s and template %s',
    async (locale, templateId, prefix, defaultTitle) => {
      const state = fixture(true);
      state.setLocale(locale);
      const titles = [undefined, '', '   ', 'Build completed'];
      for (const [index, title] of titles.entries()) {
        await state.service.send(
          'node-1',
          {
            ...request,
            templateId,
            title,
            callId: `8e1668db-88e7-4a28-9ccd-${String(index).padStart(12, '0')}`
          },
          () => true
        );
        expect(state.smtp.send).toHaveBeenLastCalledWith(
          expect.objectContaining({
            subject: prefix + (title?.trim() || defaultTitle),
            text: request.message
          }),
          expect.any(Function)
        );
      }
      expect(state.smtp.send).toHaveBeenCalledTimes(titles.length);
    }
  );

  it('selects the built-in notification template from the sender locale when no ID is given', async () => {
    const state = fixture();
    await state.service.send('node-1', { ...request, templateId: '', title: '' }, () => true);
    expect(state.templates.render).toHaveBeenCalledWith(
      'notification-zh-CN',
      'NOTIFICATION',
      expect.objectContaining({ title: '' })
    );
    state.setLocale('en-US');
    await state.service.send(
      'node-1',
      {
        ...request,
        templateId: '',
        title: undefined,
        callId: '162d92c4-28ef-4d04-b939-4229352d4f60'
      },
      () => true
    );
    expect(state.templates.render).toHaveBeenCalledWith(
      'notification-en-US',
      'NOTIFICATION',
      expect.objectContaining({ title: '' })
    );
    await state.service.send(
      'node-1',
      {
        ...request,
        templateId: 'notification-zh-CN',
        callId: '1ceee713-9d1b-47a1-9f9b-2d01a38bd515'
      },
      () => true
    );
    expect(state.templates.render).toHaveBeenLastCalledWith(
      'notification-zh-CN',
      'NOTIFICATION',
      expect.objectContaining({ title: 'Build completed' })
    );
  });

  it('sends to the specified address once, rejects changed replays and checks workspace authorization', async () => {
    const state = fixture();
    state.setEmail('alice@example.test');
    await state.service.send('node-1', request, () => true);
    await state.service.send('node-1', request, () => true);
    expect(state.smtp.send).toHaveBeenCalledTimes(1);
    expect(state.smtp.send).toHaveBeenCalledWith(
      {
        to: 'recipient@example.test',
        subject: 'Done',
        text: 'Done'
      },
      expect.any(Function)
    );
    expect(state.canUse).toHaveBeenCalledWith(
      7,
      'node-1',
      'session.message',
      { workspaceId: 'workspace-1', sessionId: 'session-1' },
      'workspace-1'
    );
    await expect(
      state.service.send('node-1', { ...request, message: 'Changed' }, () => true)
    ).rejects.toThrow('MAIL_CALL_CONFLICT');
    await expect(
      state.service.send('node-1', { ...request, recipientEmail: 'other@example.test' }, () => true)
    ).rejects.toThrow('MAIL_CALL_CONFLICT');
    await expect(
      state.service.send('node-1', { ...request, recipientEmail: 'invalid-address' }, () => true)
    ).rejects.toThrow('MAIL_INPUT_INVALID');
    state.canUse.mockResolvedValue(false);
    await expect(
      state.service.send(
        'node-1',
        { ...request, callId: '162d92c4-28ef-4d04-b939-4229352d4f60' },
        () => true
      )
    ).rejects.toThrow('MAIL_ACCESS_DENIED');
  });

  it('does not retry an uncertain delivery after a transport failure', async () => {
    const state = fixture();
    state.smtp.send.mockRejectedValueOnce(new Error('MAIL_DELIVERY_UNCERTAIN'));
    await expect(state.service.send('node-1', request, () => true)).rejects.toThrow(
      'MAIL_DELIVERY_UNCERTAIN'
    );
    await expect(state.service.send('node-1', request, () => true)).rejects.toThrow(
      'MAIL_DELIVERY_UNCERTAIN'
    );
    expect(state.smtp.send).toHaveBeenCalledTimes(1);
  });

  it('uses the rendered title when comparing trimmed title replays', async () => {
    const state = fixture();
    await state.service.send('node-1', { ...request, title: ' Build completed ' }, () => true);
    await state.service.send('node-1', request, () => true);

    expect(state.smtp.send).toHaveBeenCalledTimes(1);
  });

  it('allows up to 50 notifications from one user per execution', async () => {
    const state = fixture();
    for (let index = 0; index < 50; index++)
      await state.service.send(
        'node-1',
        {
          ...request,
          callId: `8e1668db-88e7-4a28-9ccd-${String(index).padStart(12, '0')}`
        },
        () => true
      );
    expect(state.smtp.send).toHaveBeenCalledTimes(50);
    await expect(
      state.service.send(
        'node-1',
        { ...request, callId: '8e1668db-88e7-4a28-9ccd-000000000050' },
        () => true
      )
    ).rejects.toThrow('MAIL_RATE_LIMITED');
  });
});
