import type { Pool, RowDataPacket } from 'mysql2/promise';

const SETTING_KEY = 'html_preview_origin';

export function parseHtmlPreviewOrigin(value: unknown): string | undefined {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 253) return undefined;
  try {
    const url = new URL(value);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.origin !== value ||
      url.username !== '' ||
      url.password !== ''
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export class HtmlPreviewOrigin {
  private cached: { value: string; expiresAt: number } | undefined;
  constructor(private readonly database: { readonly raw: Pool }) {}

  async read(): Promise<string> {
    if (this.cached !== undefined && this.cached.expiresAt > Date.now()) return this.cached.value;
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT setting_value FROM system_settings WHERE setting_key=?',
      [SETTING_KEY]
    );
    const stored = rows[0]?.['setting_value'];
    if (stored === undefined) {
      this.cached = { value: '', expiresAt: Date.now() + 5_000 };
      return '';
    }
    const decoded: unknown =
      typeof stored === 'string' && stored.startsWith('"') ? JSON.parse(stored) : stored;
    const origin = parseHtmlPreviewOrigin(decoded);
    if (origin === undefined) throw new Error('SYSTEM_SETTING_INPUT_INVALID');
    this.cached = { value: origin, expiresAt: Date.now() + 5_000 };
    return origin;
  }

  async write(value: string): Promise<void> {
    if (parseHtmlPreviewOrigin(value) === undefined)
      throw new Error('SYSTEM_SETTING_INPUT_INVALID');
    await this.database.raw.execute(
      `INSERT INTO system_settings (setting_key,setting_value,updated_at) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value),updated_at=VALUES(updated_at)`,
      [SETTING_KEY, JSON.stringify(value), Date.now()]
    );
    this.cached = { value, expiresAt: Date.now() + 5_000 };
  }
}
