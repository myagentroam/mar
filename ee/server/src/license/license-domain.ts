import { createHash, createHmac, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';

const MAX_LICENSE_DOCUMENT_BYTES = 64 * 1024;
const licensePayloadSchema = z
  .object({
    formatVersion: z.literal(1),
    licenseId: z.string().min(1).max(128),
    enterpriseName: z.string().trim().min(1).max(256),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    hostFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    features: z.tuple([z.literal('ENTERPRISE')])
  })
  .strict()
  .refine((value) => value.expiresAt > value.issuedAt, 'expiresAt must follow issuedAt');

const licenseDocumentSchema = z
  .object({
    payload: z.string().min(1).max(MAX_LICENSE_DOCUMENT_BYTES),
    signature: z.string().min(1).max(1024)
  })
  .strict();
const licenseRequestSchema = z
  .object({
    formatVersion: z.literal(1),
    requestId: z.string().uuid(),
    requestedAt: z.number().int().nonnegative(),
    hostFingerprint: z.string().regex(/^[a-f0-9]{64}$/u)
  })
  .strict();

export type LicensePayload = z.infer<typeof licensePayloadSchema>;
export type LicenseState = 'COMMUNITY' | 'ENTERPRISE_VALID' | 'ENTERPRISE_FROZEN';

export function computeHostFingerprint(productUuid: string): string {
  const normalized = productUuid.trim().toLowerCase();
  if (
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(normalized) ||
    normalized === '00000000-0000-0000-0000-000000000000'
  ) {
    throw new Error('LICENSE_HOST_UUID_INVALID');
  }
  return createHash('sha256').update(`myagentroam:enterprise-host:v1:${normalized}`).digest('hex');
}

export function computeMachineIdFingerprint(machineId: string): string {
  const normalized = machineId.trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/u.test(normalized) || normalized === '0'.repeat(32)) {
    throw new Error('LICENSE_MACHINE_ID_INVALID');
  }
  return createHmac('sha256', 'myagentroam:quick-start-machine:v1')
    .update(normalized)
    .digest('hex');
}

export function createLicenseRequestCode(hostFingerprint: string, requestedAt: number): string {
  const request = licenseRequestSchema.parse({
    formatVersion: 1,
    requestId: randomUUID(),
    requestedAt,
    hostFingerprint
  });
  const payload = Buffer.from(JSON.stringify(request)).toString('base64url');
  const checksum = createHash('sha256')
    .update(`myagentroam:license-request:v1:${payload}`)
    .digest('hex')
    .slice(0, 16);
  return `MAR1.${payload}.${checksum}`;
}

export function inspectLicenseRequestCode(code: string): z.infer<typeof licenseRequestSchema> {
  const match = /^MAR1\.([A-Za-z0-9_-]+)\.([a-f0-9]{16})$/u.exec(code);
  if (match === null) throw new Error('LICENSE_REQUEST_CODE_INVALID');
  const payload = match[1] as string;
  const expected = createHash('sha256')
    .update(`myagentroam:license-request:v1:${payload}`)
    .digest('hex')
    .slice(0, 16);
  if (match[2] !== expected) throw new Error('LICENSE_REQUEST_CODE_INVALID');
  try {
    return licenseRequestSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
  } catch {
    throw new Error('LICENSE_REQUEST_CODE_INVALID');
  }
}

export function createLicenseDocument(
  payload: LicensePayload,
  privateKey: string | KeyObject
): string {
  const bytes = canonicalPayloadBytes(payload);
  return JSON.stringify({
    payload: bytes.toString('base64url'),
    signature: sign(null, bytes, privateKey).toString('base64url')
  });
}

export function inspectLicenseDocument(document: string): LicensePayload {
  const parsed = parseDocument(document);
  try {
    return licensePayloadSchema.parse(
      JSON.parse(Buffer.from(parsed.payload, 'base64url').toString())
    );
  } catch {
    throw new Error('LICENSE_DOCUMENT_INVALID');
  }
}

export function verifyLicenseDocument(document: string, publicKey: string): LicensePayload {
  const parsed = parseDocument(document);
  const bytes = Buffer.from(parsed.payload, 'base64url');
  if (!verify(null, bytes, publicKey, Buffer.from(parsed.signature, 'base64url'))) {
    throw new Error('LICENSE_SIGNATURE_INVALID');
  }
  const payload = inspectLicenseDocument(document);
  if (!bytes.equals(canonicalPayloadBytes(payload))) throw new Error('LICENSE_DOCUMENT_INVALID');
  return payload;
}

export function evaluateLicense(
  stored: {
    readonly document: string | null;
    readonly everActivated: boolean;
    readonly highWatermark: number;
  },
  runtime: {
    readonly now: number;
    readonly hostFingerprint: string | null;
    readonly publicKey: string;
  }
): {
  readonly state: LicenseState;
  readonly reason?: string;
  readonly payload?: LicensePayload;
  readonly trustedTime: number;
} {
  const trustedTime = Math.max(runtime.now, stored.highWatermark);
  if (stored.document === null) {
    return stored.everActivated
      ? { state: 'ENTERPRISE_FROZEN', reason: 'LICENSE_MISSING', trustedTime }
      : { state: 'COMMUNITY', trustedTime };
  }
  try {
    const payload = verifyLicenseDocument(stored.document, runtime.publicKey);
    if (runtime.hostFingerprint === null)
      return {
        state: 'ENTERPRISE_FROZEN',
        reason: 'LICENSE_HOST_UNAVAILABLE',
        payload,
        trustedTime
      };
    if (payload.hostFingerprint !== runtime.hostFingerprint)
      return { state: 'ENTERPRISE_FROZEN', reason: 'LICENSE_HOST_MISMATCH', payload, trustedTime };
    if (trustedTime < payload.issuedAt)
      return { state: 'ENTERPRISE_FROZEN', reason: 'LICENSE_NOT_YET_VALID', payload, trustedTime };
    if (trustedTime >= payload.expiresAt)
      return { state: 'ENTERPRISE_FROZEN', reason: 'LICENSE_EXPIRED', payload, trustedTime };
    return { state: 'ENTERPRISE_VALID', payload, trustedTime };
  } catch (error) {
    return {
      state: 'ENTERPRISE_FROZEN',
      reason:
        error instanceof Error && /^LICENSE_[A-Z0-9_]+$/u.test(error.message)
          ? error.message
          : 'LICENSE_DOCUMENT_INVALID',
      trustedTime
    };
  }
}

function canonicalPayloadBytes(payload: LicensePayload): Buffer {
  const value = licensePayloadSchema.parse(payload);
  return Buffer.from(
    JSON.stringify({
      formatVersion: value.formatVersion,
      licenseId: value.licenseId,
      enterpriseName: value.enterpriseName,
      issuedAt: value.issuedAt,
      expiresAt: value.expiresAt,
      hostFingerprint: value.hostFingerprint,
      features: value.features
    })
  );
}

function parseDocument(document: string): z.infer<typeof licenseDocumentSchema> {
  if (Buffer.byteLength(document) > MAX_LICENSE_DOCUMENT_BYTES)
    throw new Error('LICENSE_DOCUMENT_TOO_LARGE');
  try {
    return licenseDocumentSchema.parse(JSON.parse(document));
  } catch {
    throw new Error('LICENSE_DOCUMENT_INVALID');
  }
}
