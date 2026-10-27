import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, open } from 'node:fs/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  AgentError,
  SecretValue,
  type ModelCredential,
  type ModelCredentialAcquireReason,
  type ModelCredentialProvider
} from '../index.js';
import { productUserAgent } from '../network/product-user-agent.js';

const MAX_AUTH_FILE_BYTES = 1024 * 1024;
const TOKEN_MAX_BYTES = 131_072;
const AUTH_FALLBACK_LIFETIME_MS = 8 * 24 * 60 * 60 * 1000;
const executeFile = promisify(execFile);

const authFileSchema = z
  .object({
    auth_mode: z.literal('chatgpt'),
    OPENAI_API_KEY: z.union([z.null(), z.literal('')]).optional(),
    tokens: z
      .object({
        id_token: z.string().min(1).max(TOKEN_MAX_BYTES),
        access_token: z.string().min(1).max(TOKEN_MAX_BYTES),
        refresh_token: z.string().min(1).max(TOKEN_MAX_BYTES),
        account_id: z.string().trim().min(1).max(512).optional()
      })
      .strict(),
    last_refresh: z.string().datetime({ offset: true }).optional()
  })
  .strict();

interface CachedCredential {
  readonly fingerprint: string;
  readonly credential: ModelCredential;
}

export class CodexAuthFileCredentialProvider implements ModelCredentialProvider {
  readonly #path: string;
  #cached: CachedCredential | undefined;
  #invalidatedRevision: number | undefined;
  #closed = false;

  constructor(path: string) {
    if (!path)
      throw new AgentError(
        'MAR_AGENT_CREDENTIAL_FILE_INVALID',
        'Codex auth file path is required.'
      );
    this.#path = path;
  }

  async acquire(reason: ModelCredentialAcquireReason): Promise<ModelCredential> {
    if (this.#closed)
      throw new AgentError(
        'MAR_AGENT_CREDENTIAL_FILE_INVALID',
        'Codex auth file provider is closed.'
      );
    const file = await readSecureAuthFile(this.#path);
    const force =
      reason === 'UNAUTHORIZED' ||
      (this.#cached !== undefined &&
        this.#invalidatedRevision === this.#cached.credential.revision);
    if (!force && this.#cached?.fingerprint === file.fingerprint) return this.#cached.credential;

    const parsed = parseAuthFile(file.content);
    const revision = (this.#cached?.credential.revision ?? 0) + 1;
    const credential: ModelCredential = {
      revision,
      expiresAt: parsed.expiresAt,
      bearer: new SecretValue(parsed.accessToken),
      headers: {
        'ChatGPT-Account-ID': new SecretValue(parsed.accountId),
        originator: 'myagentroam',
        'user-agent': productUserAgent()
      }
    };
    this.#cached = { fingerprint: file.fingerprint, credential };
    this.#invalidatedRevision = undefined;
    return credential;
  }

  invalidate(revision: number): void {
    if (this.#cached?.credential.revision === revision) this.#invalidatedRevision = revision;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#cached = undefined;
    this.#invalidatedRevision = undefined;
  }
}

async function readSecureAuthFile(
  path: string
): Promise<{ readonly fingerprint: string; readonly content: Uint8Array }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await safeLstat(path);
    assertSafeMetadata(before);
    if (process.platform === 'win32') await assertSafeWindowsAcl(path);
    const flags =
      process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
    let handle;
    try {
      handle = await open(path, flags);
    } catch (cause) {
      throw unsafeFile(cause);
    }
    try {
      const opened = await handle.stat();
      assertSafeMetadata(opened);
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
        continue;
      const content = await readBoundedFile(handle);
      const after = await safeLstat(path);
      if (
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs
      )
        continue;
      return {
        fingerprint: `${opened.dev}:${opened.ino}:${opened.size}:${opened.mtimeMs}`,
        content
      };
    } finally {
      await handle.close();
    }
  }
  throw unsafeFile();
}

async function readBoundedFile(handle: FileHandle): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= MAX_AUTH_FILE_BYTES) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_AUTH_FILE_BYTES + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > MAX_AUTH_FILE_BYTES) throw unsafeFile();
  return Buffer.concat(chunks, total);
}

async function safeLstat(path: string) {
  try {
    return await lstat(path);
  } catch (cause) {
    throw unsafeFile(cause);
  }
}

function assertSafeMetadata(metadata: Stats): void {
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_AUTH_FILE_BYTES)
    throw unsafeFile();
  if (process.platform !== 'win32') {
    const currentUid = process.getuid?.();
    const mode = metadata.mode & 0o777;
    if (
      currentUid === undefined ||
      metadata.uid !== currentUid ||
      (mode !== 0o400 && mode !== 0o600)
    )
      throw unsafeFile();
  }
}

async function assertSafeWindowsAcl(path: string): Promise<void> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:MAR_AGENT_CODEX_AUTH_FILE_PATH
if ([string]::IsNullOrWhiteSpace($path)) { throw 'Missing auth file path.' }
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = Get-Acl -LiteralPath $path
$owner = ([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value
$allowed = @($current, 'S-1-5-18', 'S-1-5-32-544')
$bad = @()
foreach ($rule in $acl.Access) {
  if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {
    $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if ($allowed -notcontains $sid) { $bad += $sid }
  }
}
[pscustomobject]@{ current = $current; owner = $owner; bad = $bad } | ConvertTo-Json -Compress
`;
  try {
    const { stdout } = await executeFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        maxBuffer: 64 * 1024,
        env: {
          ...process.env,
          MAR_AGENT_CODEX_AUTH_FILE_PATH: path
        }
      }
    );
    const result = JSON.parse(stdout) as {
      current?: unknown;
      owner?: unknown;
      bad?: unknown;
    };
    const bad = Array.isArray(result.bad)
      ? result.bad
      : typeof result.bad === 'string'
        ? [result.bad]
        : [];
    if (
      typeof result.current !== 'string' ||
      typeof result.owner !== 'string' ||
      (result.owner !== result.current &&
        result.owner !== 'S-1-5-18' &&
        result.owner !== 'S-1-5-32-544') ||
      bad.length > 0
    )
      throw unsafeFile();
  } catch (cause) {
    if (cause instanceof AgentError) throw cause;
    throw unsafeFile(cause);
  }
}

function parseAuthFile(content: Uint8Array): {
  readonly accessToken: string;
  readonly accountId: string;
  readonly expiresAt: number;
} {
  let raw: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    raw = JSON.parse(text);
  } catch (cause) {
    throw invalidFile(cause);
  }
  const result = authFileSchema.safeParse(raw);
  if (!result.success) throw invalidFile();
  const claims = jwtClaims(result.data.tokens.id_token);
  const auth = record(claims['https://api.openai.com/auth']);
  const claimAccountId = boundedString(auth['chatgpt_account_id'], 512);
  if (claimAccountId === undefined) throw invalidFile();
  if (
    result.data.tokens.account_id !== undefined &&
    result.data.tokens.account_id !== claimAccountId
  )
    throw invalidFile();
  const tokenExpiration = jwtExpiration(result.data.tokens.access_token);
  const fallbackExpiration =
    result.data.last_refresh === undefined
      ? undefined
      : Date.parse(result.data.last_refresh) + AUTH_FALLBACK_LIFETIME_MS;
  const expiresAt = tokenExpiration ?? fallbackExpiration;
  if (expiresAt === undefined) throw invalidFile();
  if (expiresAt <= Date.now())
    throw new AgentError(
      'MAR_AGENT_MODEL_AUTH_FAILED',
      'Codex auth file access credential is expired.'
    );
  void result.data.tokens.refresh_token;
  return {
    accessToken: result.data.tokens.access_token,
    accountId: result.data.tokens.account_id ?? claimAccountId,
    expiresAt
  };
}

function jwtClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw invalidFile();
  try {
    const decoded = Buffer.from(parts[1]!, 'base64url');
    if (decoded.byteLength === 0 || decoded.byteLength > TOKEN_MAX_BYTES) throw invalidFile();
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
    return record(value);
  } catch (cause) {
    if (cause instanceof AgentError) throw cause;
    throw invalidFile(cause);
  }
}

function jwtExpiration(token: string): number | undefined {
  const expiration = jwtClaims(token)['exp'];
  if (expiration === undefined) return undefined;
  const milliseconds =
    typeof expiration === 'number' && Number.isSafeInteger(expiration) && expiration > 0
      ? expiration * 1000
      : Number.NaN;
  if (!Number.isSafeInteger(milliseconds)) throw invalidFile();
  return milliseconds;
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximum ? normalized : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function unsafeFile(cause?: unknown): AgentError {
  return new AgentError(
    'MAR_AGENT_CREDENTIAL_FILE_UNSAFE',
    'Codex auth file permissions or file type are unsafe.',
    cause === undefined ? {} : { cause }
  );
}

function invalidFile(cause?: unknown): AgentError {
  return new AgentError(
    'MAR_AGENT_CREDENTIAL_FILE_INVALID',
    'Codex auth file is invalid.',
    cause === undefined ? {} : { cause }
  );
}
