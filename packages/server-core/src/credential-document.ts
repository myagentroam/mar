import { z } from 'zod';
import {
  CHATGPT_ISSUER,
  codexCredentialOwnershipSchema,
  type CodexCredentialOwnership
} from '@myagentroam/protocol';

export const CODEX_CREDENTIAL_SETTING_KEY = 'mar_agent_credentials';
export const CODEX_CREDENTIAL_DOCUMENT_VERSION = 3;
export const CODEX_MAX_CREDENTIALS = 64;
export const CODEX_MAX_DOCUMENT_BYTES = 1024 * 1024;

const credentialRecordObjectSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(128),
    type: z.enum(['CODEX_OAUTH', 'CHATGPT_OAUTH', 'XAI_OAUTH']),
    xai: z
      .object({
        subject: z.string().min(1).max(512),
        scopes: z.array(z.string().min(1).max(256)).max(64)
      })
      .strict()
      .optional(),
    chatgpt: z
      .object({
        clientId: z.string().min(1).max(512),
        issuer: z.literal(CHATGPT_ISSUER),
        subject: z.string().min(1).max(512),
        idToken: z.string().min(1).max(131_072),
        scopes: z.array(z.string().min(1).max(256)).max(64),
        earliestRefreshAt: z.number().int().nonnegative().nullable(),
        hostId: z.string().min(1).max(512)
      })
      .strict()
      .optional(),
    ownership: codexCredentialOwnershipSchema,
    status: z.enum(['ACTIVE', 'DEGRADED', 'REAUTH_REQUIRED']),
    accessToken: z.string().min(1).max(131_072),
    refreshToken: z.string().max(131_072),
    accountId: z.string().trim().min(1).max(512),
    accessTokenExpiresAt: z.number().int().nonnegative().nullable(),
    lastRefreshAt: z.number().int().nonnegative().nullable(),
    lastCheckedAt: z.number().int().nonnegative().nullable(),
    proxy: z.string().url().max(2048).nullable(),
    revision: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strict();
function validateRecord(
  credential: Pick<
    z.infer<typeof credentialRecordObjectSchema>,
    'type' | 'chatgpt' | 'xai' | 'refreshToken' | 'proxy'
  >,
  context: z.RefinementCtx
): void {
  if (
    (credential.type === 'CHATGPT_OAUTH') !== (credential.chatgpt !== undefined) ||
    (credential.type === 'XAI_OAUTH') !== (credential.xai !== undefined) ||
    (credential.type !== 'CHATGPT_OAUTH' && credential.refreshToken.length === 0)
  )
    context.addIssue({ code: 'custom', message: 'invalid credential type metadata' });
  if (credential.proxy !== null && !isValidSocks5Url(credential.proxy))
    context.addIssue({ code: 'custom', path: ['proxy'], message: 'SOCKS5 proxy is required' });
}

export const credentialRecordSchema = credentialRecordObjectSchema.superRefine(validateRecord);
const legacyOwnershipSchema = z.union([
  codexCredentialOwnershipSchema,
  z.object({ ownerType: z.literal('ENTERPRISE') }).strict()
]);
type LegacyOwnership = z.infer<typeof legacyOwnershipSchema>;
const legacyRecordSchema = credentialRecordObjectSchema
  .extend({ ownership: legacyOwnershipSchema })
  .superRefine(validateRecord);

function validateDocument(
  document: { credentials: readonly { id: string; name: string; ownership: LegacyOwnership }[] },
  context: z.RefinementCtx
): void {
  const ids = document.credentials.map((record) => record.id);
  const names = document.credentials.map(
    (record) => `${legacyOwnershipKey(record.ownership)}\0${normalizeCredentialName(record.name)}`
  );
  if (new Set(ids).size !== ids.length)
    context.addIssue({ code: 'custom', path: ['credentials'], message: 'duplicate credential ID' });
  if (new Set(names).size !== names.length)
    context.addIssue({
      code: 'custom',
      path: ['credentials'],
      message: 'duplicate credential name'
    });
}
export const credentialDocumentSchema = z
  .object({
    version: z.literal(CODEX_CREDENTIAL_DOCUMENT_VERSION),
    credentials: z.array(credentialRecordSchema).max(CODEX_MAX_CREDENTIALS)
  })
  .strict()
  .superRefine(validateDocument);
const legacyDocumentSchema = z
  .object({
    version: z.literal(2),
    credentials: z.array(legacyRecordSchema).max(CODEX_MAX_CREDENTIALS)
  })
  .strict()
  .superRefine(validateDocument);
export type CredentialRecord = z.infer<typeof credentialRecordSchema>;
export type CredentialDocument = z.infer<typeof credentialDocumentSchema>;

export function credentialOwnershipKey(ownership: CodexCredentialOwnership): string {
  return ownership.ownerType === 'PERSONAL'
    ? `PERSONAL:${ownership.ownerUserId}`
    : `ORGANIZATION:${ownership.ownerOrganizationId}`;
}
function legacyOwnershipKey(ownership: LegacyOwnership): string {
  return ownership.ownerType === 'ENTERPRISE' ? 'ENTERPRISE' : credentialOwnershipKey(ownership);
}
export function normalizeCredentialName(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

class CredentialDocumentError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function rawDocument(value: unknown): unknown {
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    if (Buffer.byteLength(value) > CODEX_MAX_DOCUMENT_BYTES)
      throw new CredentialDocumentError('CODEX_CREDENTIAL_STORE_INVALID');
    return JSON.parse(typeof value === 'string' ? value : value.toString('utf8')) as unknown;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized) > CODEX_MAX_DOCUMENT_BYTES)
    throw new CredentialDocumentError('CODEX_CREDENTIAL_STORE_INVALID');
  return value;
}

export function parseCredentialDocument(raw: unknown): CredentialDocument {
  try {
    return credentialDocumentSchema.parse(rawDocument(raw));
  } catch {
    throw new CredentialDocumentError('CODEX_CREDENTIAL_STORE_INVALID');
  }
}

/** Only startup migrations may project historical ownership. */
export function projectCredentialDocument(
  raw: unknown,
  target: CodexCredentialOwnership | undefined,
  now: number
): { document: CredentialDocument; changed: boolean } {
  try {
    const value = rawDocument(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new CredentialDocumentError('CODEX_CREDENTIAL_STORE_INVALID');
    const input = value as Record<string, unknown>;
    if (input['version'] === CODEX_CREDENTIAL_DOCUMENT_VERSION)
      return { document: parseCredentialDocument(value), changed: false };
    let legacy: unknown = value;
    if (input['version'] === 1 && Array.isArray(input['credentials'])) {
      legacy = {
        ...input,
        version: 2,
        credentials: input['credentials'].map((entry: unknown) => {
          if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
          const record = { ...(entry as Record<string, unknown>) };
          delete record['fedramp'];
          delete record['custom'];
          return { ...record, ownership: { ownerType: 'ENTERPRISE' } };
        })
      };
    }
    const document = legacyDocumentSchema.parse(legacy);
    const credentials = document.credentials.map((record) => {
      if (record.ownership.ownerType !== 'ENTERPRISE') return record;
      if (target === undefined)
        throw new CredentialDocumentError('CODEX_CREDENTIAL_SCOPE_FORBIDDEN');
      return { ...record, ownership: target, revision: record.revision + 1, updatedAt: now };
    });
    const names = credentials.map(
      (record) =>
        `${credentialOwnershipKey(record.ownership as CodexCredentialOwnership)}\0${normalizeCredentialName(record.name)}`
    );
    if (new Set(names).size !== names.length)
      throw new CredentialDocumentError('CODEX_CREDENTIAL_NAME_CONFLICT');
    return {
      document: parseCredentialDocument({
        version: CODEX_CREDENTIAL_DOCUMENT_VERSION,
        credentials
      }),
      changed: true
    };
  } catch (error) {
    if (error instanceof CredentialDocumentError) throw error;
    throw new CredentialDocumentError('CODEX_CREDENTIAL_STORE_INVALID');
  }
}

export function isValidSocks5Url(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'socks5:' && Boolean(url.hostname) && Number(url.port || 1080) <= 65_535
    );
  } catch {
    return false;
  }
}
