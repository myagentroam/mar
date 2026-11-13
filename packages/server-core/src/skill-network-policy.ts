import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
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
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  const selected = addresses.find((entry) => isPublicAddress(entry.address));
  if (selected === undefined || addresses.some((entry) => !isPublicAddress(entry.address)))
    throw new Error('SKILL_SOURCE_ADDRESS_FORBIDDEN');
  return new Promise<Response>((resolve, reject) => {
    const request = https.request(
      {
        hostname: selected.address,
        family: selected.family,
        servername: url.hostname,
        port: url.port === '' ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
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

/** Public HTTPS fetch with DNS rebinding and private-address protection. */
export const publicHttpsFetch: typeof fetch = async (input, init) =>
  safeHttpsFetch(input, init, false);

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    const [first, second] = parts;
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second! >= 64 && second! <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second! >= 16 && second! <= 31) ||
      (first === 192 && second === 0) ||
      (first === 192 && second === 168) ||
      (first === 192 && second === 0 && parts[2] === 2) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51 && parts[2] === 100) ||
      (first === 203 && second === 0 && parts[2] === 113) ||
      first! >= 224
    );
  }
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) return isPublicAddress(normalized.slice(7));
  return !(
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/u.test(normalized) ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:')
  );
}

export async function assertPublicSkillHost(
  hostname: string
): Promise<{ readonly address: string; readonly family: number }> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address)))
    throw new Error('SKILL_SOURCE_ADDRESS_FORBIDDEN');
  return addresses[0]!;
}
