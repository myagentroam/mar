import { createCipheriv, createDecipheriv, createECDH, createHash, randomBytes } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';

const KEY = 'web_push_configuration';
const storedSchema = z
  .object({
    enabled: z.boolean(),
    publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/u),
    sealedPrivateKey: z.string().max(256)
  })
  .strict();
export interface WebPushDeliveryKeys {
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

export class WebPushConfiguration {
  private readonly encryptionKey: Buffer;
  constructor(
    private readonly database: { readonly raw: Pool },
    applicationKey: Buffer,
    private readonly publicOrigin: string | undefined,
    private readonly available: () => boolean
  ) {
    if (applicationKey.length !== 32) throw new Error('WEB_PUSH_CONFIGURATION_INVALID');
    this.encryptionKey = createHash('sha256')
      .update(applicationKey)
      .update('mar:web-push:encryption:v1')
      .digest();
  }

  async read(): Promise<{ enabled: boolean; available: boolean; publicKey: string | null }> {
    const stored = await this.stored();
    if (stored?.enabled) this.unseal(stored);
    return {
      enabled: stored?.enabled ?? false,
      available: this.available() && this.subject() !== undefined,
      publicKey: stored?.publicKey ?? null
    };
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new Error('WEB_PUSH_INPUT_INVALID');
    if (enabled) {
      if (!this.available()) throw new Error('WEB_PUSH_UNAVAILABLE');
      if (this.subject() === undefined) throw new Error('WEB_PUSH_CONFIGURATION_INVALID');
      if ((await this.stored()) === undefined) {
        const pair = createECDH('prime256v1');
        const publicKey = pair.generateKeys().toString('base64url');
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
        const ciphertext = Buffer.concat([cipher.update(pair.getPrivateKey()), cipher.final()]);
        const sealedPrivateKey = [iv, cipher.getAuthTag(), ciphertext]
          .map((part) => part.toString('base64url'))
          .join('.');
        // A concurrent first enable may win; never replace its key material.
        await this.database.raw.execute(
          `INSERT INTO system_settings (setting_key,setting_value,updated_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE setting_key=VALUES(setting_key)`,
          [KEY, JSON.stringify({ enabled: false, publicKey, sealedPrivateKey }), Date.now()]
        );
      }
      const stored = await this.stored();
      if (stored === undefined) throw new Error('WEB_PUSH_CONFIGURATION_INVALID');
      this.unseal(stored);
    }
    await this.database.raw.execute(
      `UPDATE system_settings SET setting_value=JSON_SET(setting_value,'$.enabled',CAST(? AS JSON)),updated_at=? WHERE setting_key=?`,
      [JSON.stringify(enabled), Date.now(), KEY]
    );
  }

  async delivery(): Promise<WebPushDeliveryKeys | undefined> {
    const stored = await this.stored();
    const subject = this.subject();
    if (!stored?.enabled || !this.available() || subject === undefined) return undefined;
    return { subject, publicKey: stored.publicKey, privateKey: this.unseal(stored) };
  }

  private subject(): string | undefined {
    try {
      const url = new URL(this.publicOrigin ?? '');
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.hostname === 'localhost' ||
        url.hostname.endsWith('.localhost')
      )
        return undefined;
      return url.origin;
    } catch {
      return undefined;
    }
  }

  private async stored(): Promise<z.infer<typeof storedSchema> | undefined> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT setting_value FROM system_settings WHERE setting_key=?',
      [KEY]
    );
    if (rows[0] === undefined) return undefined;
    try {
      const value: unknown = rows[0].setting_value;
      return storedSchema.parse(typeof value === 'string' ? JSON.parse(value) : value);
    } catch {
      throw new Error('WEB_PUSH_CONFIGURATION_INVALID');
    }
  }

  private unseal(stored: z.infer<typeof storedSchema>): string {
    try {
      const parts = stored.sealedPrivateKey.split('.');
      if (parts.length !== 3) throw new Error('invalid key');
      const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64url'));
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv!);
      decipher.setAuthTag(tag!);
      const privateKey = Buffer.concat([decipher.update(ciphertext!), decipher.final()]);
      const pair = createECDH('prime256v1');
      pair.setPrivateKey(privateKey);
      if (pair.getPublicKey().toString('base64url') !== stored.publicKey)
        throw new Error('invalid key');
      // OpenSSL may omit leading zero bytes; VAPID requires a fixed-width P-256 scalar.
      return Buffer.concat([Buffer.alloc(32 - privateKey.length), privateKey]).toString(
        'base64url'
      );
    } catch {
      throw new Error('WEB_PUSH_CONFIGURATION_INVALID');
    }
  }
}
