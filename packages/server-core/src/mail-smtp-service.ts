import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import nodemailer from 'nodemailer';

const SETTING_KEY = 'mail_smtp_configuration';

export interface SmtpConfiguration {
  readonly host: string;
  readonly port: number;
  readonly tls: 'TLS' | 'STARTTLS';
  readonly from: string;
  readonly fromName: string;
  readonly username: string;
  readonly password: string;
}

type StoredConfiguration = Omit<SmtpConfiguration, 'password'> & {
  readonly encryptedPassword: string;
};

export interface OutgoingMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export function validMailAddress(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 320 &&
    value.length > 3 &&
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(value) &&
    !value.includes('..')
  );
}

export class MailSmtpService {
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly database: { readonly raw: Pool },
    applicationKey: Buffer,
    private readonly deliver: (
      config: SmtpConfiguration,
      mail: OutgoingMail
    ) => Promise<void> = sendViaSmtp
  ) {
    if (applicationKey.length !== 32) throw new Error('MAIL_ENCRYPTION_KEY_INVALID');
    this.encryptionKey = createHash('sha256')
      .update(applicationKey)
      .update('mar:mail-smtp:encryption:v1')
      .digest();
  }

  async read(): Promise<string> {
    const stored = await this.stored();
    return stored === undefined
      ? '{}'
      : JSON.stringify({
          host: stored.host,
          port: stored.port,
          tls: stored.tls,
          from: stored.from,
          fromName: stored.fromName,
          username: stored.username,
          password: ''
        });
  }

  async write(value: unknown): Promise<void> {
    if (typeof value !== 'string' || value.length > 4096)
      throw new Error('MAIL_CONFIGURATION_INVALID');
    let candidate: unknown;
    try {
      candidate = JSON.parse(value);
    } catch {
      throw new Error('MAIL_CONFIGURATION_INVALID');
    }
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
      throw new Error('MAIL_CONFIGURATION_INVALID');
    const input = candidate as Record<string, unknown>;
    if (Object.keys(input).length === 0) {
      await this.database.raw.execute('DELETE FROM system_settings WHERE setting_key=?', [
        SETTING_KEY
      ]);
      return;
    }
    const username = input['username'] ?? '';
    const password = input['password'] ?? '';
    const fromName = input['fromName'] ?? '';
    if (
      Object.keys(input).some(
        (key) => !['host', 'port', 'tls', 'from', 'fromName', 'username', 'password'].includes(key)
      ) ||
      typeof input['host'] !== 'string' ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u.test(input['host']) ||
      !Number.isInteger(input['port']) ||
      (input['port'] as number) < 1 ||
      (input['port'] as number) > 65535 ||
      !['TLS', 'STARTTLS'].includes(String(input['tls'])) ||
      !validMailAddress(input['from']) ||
      typeof fromName !== 'string' ||
      fromName.length > 128 ||
      /[\r\n]/u.test(fromName) ||
      typeof username !== 'string' ||
      username.length > 320 ||
      /[\r\n]/u.test(username) ||
      typeof password !== 'string' ||
      password.length > 1024 ||
      (username === '' && password !== '')
    )
      throw new Error('MAIL_CONFIGURATION_INVALID');
    const current = await this.stored();
    const encryptedPassword =
      username === ''
        ? ''
        : password === ''
          ? current?.username === username
            ? current.encryptedPassword
            : ''
          : this.encrypt(password);
    if ((username === '') !== (encryptedPassword === ''))
      throw new Error('MAIL_CONFIGURATION_INVALID');
    const stored: StoredConfiguration = {
      host: input['host'],
      port: input['port'] as number,
      tls: input['tls'] as 'TLS' | 'STARTTLS',
      from: input['from'],
      fromName,
      username,
      encryptedPassword
    };
    await this.database.raw.execute(
      `INSERT INTO system_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value), updated_at=VALUES(updated_at)`,
      [SETTING_KEY, JSON.stringify(stored), Date.now()]
    );
  }

  async send(mail: OutgoingMail): Promise<void> {
    if (
      !validMailAddress(mail.to) ||
      mail.subject.length === 0 ||
      mail.subject.length > 256 ||
      /[\r\n]/u.test(mail.subject) ||
      mail.text.length === 0 ||
      mail.text.length > 10_000 ||
      (mail.html !== undefined && (mail.html.length === 0 || mail.html.length > 80_000))
    )
      throw new Error('MAIL_INPUT_INVALID');
    const stored = await this.stored();
    if (stored === undefined) throw new Error('MAIL_NOT_CONFIGURED');
    try {
      await this.deliver(
        {
          ...stored,
          password: stored.encryptedPassword === '' ? '' : this.decrypt(stored.encryptedPassword)
        },
        mail
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'MAIL_CONFIGURATION_CORRUPT') throw error;
      // Raw SMTP failures may include addresses, message data, or server diagnostics.
      throw new Error('MAIL_DELIVERY_UNCERTAIN');
    }
  }

  private async stored(): Promise<StoredConfiguration | undefined> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT setting_value FROM system_settings WHERE setting_key=?',
      [SETTING_KEY]
    );
    const value: unknown = rows[0]?.['setting_value'];
    if (value === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
      throw new Error('MAIL_CONFIGURATION_CORRUPT');
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !('encryptedPassword' in parsed) ||
      typeof parsed.encryptedPassword !== 'string'
    )
      throw new Error('MAIL_CONFIGURATION_CORRUPT');
    const fromName = 'fromName' in parsed ? parsed.fromName : '';
    if (typeof fromName !== 'string' || fromName.length > 128 || /[\r\n]/u.test(fromName))
      throw new Error('MAIL_CONFIGURATION_CORRUPT');
    return { ...parsed, fromName } as StoredConfiguration;
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }

  private decrypt(value: string): string {
    try {
      const data = Buffer.from(value, 'base64');
      if (data.length < 29) throw new Error('MAIL_CONFIGURATION_CORRUPT');
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('MAIL_CONFIGURATION_CORRUPT');
    }
  }
}

async function sendViaSmtp(config: SmtpConfiguration, mail: OutgoingMail): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.tls === 'TLS',
    requireTLS: config.tls === 'STARTTLS',
    tls: { rejectUnauthorized: true },
    ...(config.username === '' ? {} : { auth: { user: config.username, pass: config.password } }),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    logger: false,
    debug: false
  });
  try {
    const result = await transporter.sendMail({
      from: config.fromName === '' ? config.from : { name: config.fromName, address: config.from },
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.html === undefined ? {} : { html: mail.html }),
      disableFileAccess: true,
      disableUrlAccess: true
    });
    if (!result.accepted.includes(mail.to)) throw new Error('MAIL_RECIPIENT_REJECTED');
  } finally {
    transporter.close();
  }
}
