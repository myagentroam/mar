import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import {
  MailSmtpService,
  type OutgoingMail,
  type SmtpConfiguration
} from '../../src/mail-smtp-service.js';
import { MailTemplateService, type MailTemplateKind } from '../../src/mail-template-service.js';
import { registerMailRoutes } from '../../src/mail-routes.js';
import { hashOpaque } from '../../src/session-token.js';

type Execute = (sql: string, parameters?: readonly unknown[]) => Promise<readonly unknown[]>;

function smtpDatabase() {
  let settingValue: string | undefined;
  const execute = vi.fn<Execute>(async (sql, parameters = []) => {
    if (sql.startsWith('SELECT setting_value FROM system_settings')) {
      return [settingValue === undefined ? [] : [{ setting_value: settingValue }], []];
    }
    if (sql.startsWith('DELETE FROM system_settings')) {
      settingValue = undefined;
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith('INSERT INTO system_settings')) {
      settingValue = String(parameters[1]);
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`Unexpected SMTP statement: ${sql}`);
  });
  return {
    database: { raw: { execute } } as never,
    execute,
    document: () =>
      settingValue === undefined ? undefined : (JSON.parse(settingValue) as Record<string, unknown>)
  };
}

type TemplateRow = {
  id: string;
  kind: MailTemplateKind;
  locale: 'zh-CN' | 'en-US';
  name: string;
  subject: string;
  body: string;
  revision: number;
  is_default: number;
};

function templateDatabase() {
  const rows = new Map<string, TemplateRow>();
  const execute = vi.fn<Execute>(async (sql, parameters = []) => {
    if (sql.includes('FROM mail_templates') && sql.includes('ORDER BY')) {
      return [[...rows.values()].filter((row) => row.is_default === 1), []];
    }
    if (sql.includes('FROM mail_templates') && sql.includes('WHERE id=?')) {
      const row = rows.get(String(parameters[0]));
      return [row?.is_default === 1 ? [row] : [], []];
    }
    throw new Error(`Unexpected template statement: ${sql}`);
  });
  return {
    database: { raw: { execute } } as never,
    execute,
    rows
  };
}

const smtpConfiguration: SmtpConfiguration = {
  host: 'smtp.example.test',
  port: 465,
  tls: 'TLS',
  from: 'no-reply@example.test',
  fromName: 'MyAgentRoam',
  username: 'mailer',
  password: 'smtp-secret'
};

const notificationTemplate = {
  kind: 'NOTIFICATION' as const,
  locale: 'en-US' as const,
  name: 'Run notification',
  subject: 'Run: {{title}}',
  body: '{{message}} in {{workspaceName}} for {{email}}'
};

describe('MailSmtpService', () => {
  it('keeps legacy configurations readable when the sender name is absent', async () => {
    const fixture = smtpDatabase();
    const service = new MailSmtpService(fixture.database, Buffer.alloc(32, 6));
    const legacy: Record<string, unknown> = { ...smtpConfiguration };
    delete legacy['fromName'];

    await service.write(JSON.stringify(legacy));

    const document = JSON.parse(await service.read()) as Record<string, unknown>;
    expect(document).toEqual({ ...legacy, fromName: '', password: '' });
  });

  it('accepts exactly one JSON document and redacts and retains the password', async () => {
    const fixture = smtpDatabase();
    const service = new MailSmtpService(fixture.database, Buffer.alloc(32, 7));

    await expect(service.write(smtpConfiguration)).rejects.toThrow('MAIL_CONFIGURATION_INVALID');
    await expect(
      service.write(JSON.stringify({ ...smtpConfiguration, unexpected: true }))
    ).rejects.toThrow('MAIL_CONFIGURATION_INVALID');
    expect(fixture.execute).not.toHaveBeenCalled();

    await service.write(JSON.stringify(smtpConfiguration));
    await expect(service.read()).resolves.toBe(
      JSON.stringify({ ...smtpConfiguration, password: '' })
    );
    const firstDocument = fixture.document()!;
    expect(firstDocument).toMatchObject({
      host: smtpConfiguration.host,
      username: smtpConfiguration.username
    });
    expect(firstDocument['encryptedPassword']).toEqual(expect.any(String));
    expect(JSON.stringify(firstDocument)).not.toContain(smtpConfiguration.password);

    await service.write(JSON.stringify({ ...smtpConfiguration, password: '' }));
    expect(fixture.document()?.['encryptedPassword']).toBe(firstDocument['encryptedPassword']);
    await expect(service.read()).resolves.toBe(
      JSON.stringify({ ...smtpConfiguration, password: '' })
    );
  });

  it('decrypts the password only for the injected sender and rejects invalid mail', async () => {
    const fixture = smtpDatabase();
    const deliver = vi.fn(async (_config: SmtpConfiguration, _mail: OutgoingMail) => undefined);
    const service = new MailSmtpService(fixture.database, Buffer.alloc(32, 9), deliver);
    await service.write(JSON.stringify(smtpConfiguration));

    const mail = {
      to: 'recipient@example.test',
      subject: 'Test message',
      text: 'Body',
      html: '<h1>Body</h1>'
    };
    await service.send(mail);
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        host: smtpConfiguration.host,
        fromName: smtpConfiguration.fromName,
        username: smtpConfiguration.username,
        password: smtpConfiguration.password
      }),
      mail
    );

    for (const invalid of [
      { ...mail, to: 'not-an-email' },
      { ...mail, subject: 'Injected\r\nHeader' },
      { ...mail, text: '' },
      { ...mail, html: 'x'.repeat(80_001) }
    ]) {
      await expect(service.send(invalid)).rejects.toThrow('MAIL_INPUT_INVALID');
    }
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

describe('MailTemplateService', () => {
  it.each([
    ['en-US', 'Email notification'],
    ['zh-CN', '邮件通知']
  ] as const)(
    'resolves empty notification titles using the %s template',
    async (locale, defaultTitle) => {
      const fixture = templateDatabase();
      const id = `notification-${locale}`;
      fixture.rows.set(id, {
        id,
        ...notificationTemplate,
        locale,
        revision: 1,
        is_default: 1
      });
      const service = new MailTemplateService(fixture.database);
      for (const title of ['', '   ', 'Explicit title']) {
        const rendered = await service.render(id, 'NOTIFICATION', {
          title,
          message: 'Done',
          userName: 'Alice',
          workspaceName: 'Workspace',
          email: 'alice@example.test'
        });
        expect(rendered.subject).toBe(`Run: ${title.trim() || defaultTitle}`);
        expect(rendered.html).toContain(`lang="${locale}"`);
      }
    }
  );

  it.each([
    ['en-US', 'Notification preview'],
    ['zh-CN', '通知预览']
  ] as const)(
    'preserves the %s notification preview title and escaped content',
    async (locale, title) => {
      const fixture = templateDatabase();
      const id = `notification-${locale}`;
      fixture.rows.set(id, {
        id,
        ...notificationTemplate,
        locale,
        subject: '{{title}}',
        revision: 1,
        is_default: 1
      });
      const app = Fastify();
      registerMailRoutes({
        app,
        database: {
          findCurrentUserSession: () => ({
            userId: 1,
            username: 'admin',
            isAdmin: true,
            sessionHash: 'session-hash',
            mustChangePassword: false,
            csrfTokenHash: hashOpaque('csrf-test')
          })
        },
        smtp: {} as never,
        templates: new MailTemplateService(fixture.database),
        publicOrigin: undefined
      });
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/api/mail/templates/preview',
          headers: { cookie: 'mar_user_session=admin-test', 'x-csrf-token': 'csrf-test' },
          payload: { templateId: id, message: '<script>alert(1)</script>' }
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ subject: title });
        expect(response.json().html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(response.json().html).not.toContain('<script>');
      } finally {
        await app.close();
      }
    }
  );

  it('lists and renders only built-in templates', async () => {
    const fixture = templateDatabase();
    const service = new MailTemplateService(fixture.database);
    const builtin: TemplateRow = {
      id: 'notification-en-US',
      ...notificationTemplate,
      revision: 1,
      is_default: 1
    };
    fixture.rows.set(builtin.id, builtin);
    fixture.rows.set('legacy-custom', {
      ...builtin,
      id: 'legacy-custom',
      is_default: 0
    });

    await expect(service.list()).resolves.toMatchObject([{ id: builtin.id, isDefault: true }]);
    await expect(service.get('legacy-custom')).rejects.toThrow('MAIL_TEMPLATE_NOT_FOUND');
    await expect(service.get(builtin.id, 'TEST')).rejects.toThrow('MAIL_TEMPLATE_NOT_FOUND');
    const rendered = await service.render(builtin.id, 'NOTIFICATION', {
      title: 'Build completed',
      message: 'The run completed',
      userName: 'Alice',
      workspaceName: 'Workspace',
      email: 'alice@example.test'
    });
    expect(rendered).toMatchObject({
      subject: 'Run: Build completed',
      text: 'The run completed in Workspace for alice@example.test'
    });
    expect(rendered.html).toContain('Build completed');
    expect(rendered.html).toContain('The run completed in Workspace for alice@example.test');
    expect(rendered.html).not.toContain('border:1px solid');
    expect(rendered.html).not.toContain('MAR / MAIL');
    fixture.rows.set(builtin.id, { ...builtin, subject: 'Bad {{unknown}}' });
    await expect(
      service.render(builtin.id, 'NOTIFICATION', {
        title: 'Build completed',
        message: 'The run completed',
        userName: 'Alice',
        workspaceName: 'Workspace',
        email: 'alice@example.test'
      })
    ).rejects.toThrow('MAIL_TEMPLATE_INVALID');
    expect(fixture.execute.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
  });

  it('renders the built-in test template without allowing a notification template to substitute', async () => {
    const fixture = templateDatabase();
    fixture.rows.set('test-en-US', {
      id: 'test-en-US',
      kind: 'TEST',
      locale: 'en-US',
      name: 'Test email',
      subject: 'Test for {{userName}}',
      body: 'Sent to {{email}}',
      revision: 1,
      is_default: 1
    });
    const service = new MailTemplateService(fixture.database);
    const rendered = await service.render('test-en-US', 'TEST', {
      title: 'Email test',
      message: '',
      userName: 'Alice',
      workspaceName: '',
      email: 'alice@example.test'
    });
    expect(rendered).toMatchObject({
      subject: 'Test for Alice',
      text: 'Sent to alice@example.test'
    });
    expect(rendered.html).toContain('MyAgentRoam');
    expect(rendered.html).toContain('Sent to alice@example.test');
    await expect(
      service.render('test-en-US', 'NOTIFICATION', {
        title: 'Email test',
        message: '',
        userName: 'Alice',
        workspaceName: '',
        email: 'alice@example.test'
      })
    ).rejects.toThrow('MAIL_TEMPLATE_NOT_FOUND');
  });

  it('escapes untrusted content in both built-in email layouts without changing the text fallback', async () => {
    const fixture = templateDatabase();
    const service = new MailTemplateService(fixture.database);
    for (const kind of ['TEST', 'NOTIFICATION'] as const) {
      const id = `${kind === 'TEST' ? 'test' : 'notification'}-zh-CN`;
      fixture.rows.set(id, {
        id,
        kind,
        locale: 'zh-CN',
        name: '测试',
        subject: '通知 {{userName}}',
        body: '工作区 {{workspaceName}}\n{{message}}',
        revision: 1,
        is_default: 1
      });
      const mail = await service.render(id, kind, {
        title: 'Build completed',
        message: '<img src=x onerror=alert(1)>\n下一行',
        userName: '<Alice & Bob>',
        workspaceName: '"Demo"',
        email: 'user@example.test'
      });
      expect(mail.text).toContain('<img src=x onerror=alert(1)>');
      expect(mail.html).toContain('lang="zh-CN"');
      expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt;<br>下一行');
      expect(mail.html).toContain('&lt;Alice &amp; Bob&gt;');
      expect(mail.html).toContain('&quot;Demo&quot;');
      expect(mail.html).not.toContain('<img');
      expect(mail.html).toContain('MyAgentRoam');
    }
  });

  it('does not expose template mutation routes', async () => {
    const app = Fastify();
    registerMailRoutes({
      app,
      database: {} as never,
      smtp: {} as never,
      templates: {} as never,
      publicOrigin: undefined
    });
    try {
      for (const [method, url] of [
        ['POST', '/api/mail/templates'],
        ['PATCH', '/api/mail/templates/test-en-US'],
        ['DELETE', '/api/mail/templates/test-en-US']
      ] as const) {
        const response = await app.inject({ method, url });
        expect(response.statusCode).toBe(404);
      }
    } finally {
      await app.close();
    }
  });
});
