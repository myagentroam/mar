import https from 'node:https';
import type { Pool, RowDataPacket } from 'mysql2/promise';

const SETTING_KEY = 'skill_tls_verification_disabled';
const MAX_RESPONSE_BYTES = 110 * 1024 * 1024;

export class SkillNetworkPolicy {
  private cached: { value: boolean; expiresAt: number } | undefined;
  constructor(private readonly database: { readonly raw: Pool }) {}

  readonly fetch: typeof fetch = async (input, init) => {
    return safeHttpsFetch(input, init, await this.disabled());
  };

  async disabled(): Promise<boolean> {
    if (this.cached !== undefined && this.cached.expiresAt > Date.now()) return this.cached.value;
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT setting_value FROM system_settings WHERE setting_key=?',
      [SETTING_KEY]
    );
    const value = rows[0]?.['setting_value'] === 'true';
    this.cached = { value, expiresAt: Date.now() + 5_000 };
    return value;
  }

  async setDisabled(disabled: boolean): Promise<void> {
    await this.database.raw.execute(
      `INSERT INTO system_settings (setting_key,setting_value,updated_at) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value),updated_at=VALUES(updated_at)`,
      [SETTING_KEY, String(disabled), Date.now()]
    );
    this.cached = { value: disabled, expiresAt: Date.now() + 5_000 };
  }
}

async function safeHttpsFetch(
  input: string | URL | Request,
  init: RequestInit | undefined,
  verificationDisabled: boolean
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.protocol !== 'https:') throw new Error('SKILL_SOURCE_TLS_FAILED');
  return new Promise<Response>((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
        headers: {
          ...Object.fromEntries(
            new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
          ),
          host: url.host
        },
        rejectUnauthorized: !verificationDisabled,
        signal: init?.signal ?? undefined
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.once('error', reject);
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            response.destroy(new Error('SKILL_SOURCE_LIMIT_EXCEEDED'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 500,
              headers: response.headers as HeadersInit
            })
          )
        );
      }
    );
    request.once('error', reject);
    request.end();
  });
}

/** HTTPS fetch with certificate verification for remote service calls. */
export const publicHttpsFetch: typeof fetch = async (input, init) =>
  safeHttpsFetch(input, init, false);
