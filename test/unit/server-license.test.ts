import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  computeHostFingerprint,
  createLicenseRequestCode,
  createLicenseDocument,
  evaluateLicense,
  inspectLicenseRequestCode,
  inspectLicenseDocument,
  verifyLicenseDocument
} from '../../ee/server/src/license/license-domain.js';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const fingerprint = computeHostFingerprint('EC2A8F9C-70D4-4A71-8B71-B5C98D871234\n');

describe('Server License domain', () => {
  it('normalizes a product UUID without exposing it in the fingerprint', () => {
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprint).toBe(computeHostFingerprint('ec2a8f9c-70d4-4a71-8b71-b5c98d871234'));
    expect(computeHostFingerprint('00000000-0000-0000-0000-309c23637c46')).toMatch(
      /^[a-f0-9]{64}$/u
    );
    expect(() => computeHostFingerprint('00000000-0000-0000-0000-000000000000')).toThrow(
      'LICENSE_HOST_UUID_INVALID'
    );
    expect(() => computeHostFingerprint('not-a-uuid')).toThrow('LICENSE_HOST_UUID_INVALID');
  });

  it('License application codes are randomized and verifiably encode host binding', () => {
    const first = createLicenseRequestCode(fingerprint, 2_000);
    const second = createLicenseRequestCode(fingerprint, 2_000);

    expect(first).not.toBe(second);
    expect(first).toMatch(/^MAR1\.[A-Za-z0-9_-]+\.[a-f0-9]{16}$/u);
    expect(inspectLicenseRequestCode(first)).toMatchObject({
      formatVersion: 1,
      hostFingerprint: fingerprint,
      requestedAt: 2_000
    });
    expect(() =>
      inspectLicenseRequestCode(`${first.slice(0, -1)}${first.endsWith('0') ? '1' : '0'}`)
    ).toThrow('LICENSE_REQUEST_CODE_INVALID');
  });

  it('signs canonical payload bytes and rejects signature or payload tampering', () => {
    const document = createLicenseDocument(
      {
        formatVersion: 1,
        licenseId: 'license-1',
        enterpriseName: 'Acme',
        issuedAt: 1_000,
        expiresAt: 3_000,
        hostFingerprint: fingerprint,
        features: ['ENTERPRISE']
      },
      privateKey
    );
    expect(inspectLicenseDocument(document)).toMatchObject({ licenseId: 'license-1' });
    expect(verifyLicenseDocument(document, publicKey)).toMatchObject({ enterpriseName: 'Acme' });
    const parsed = JSON.parse(document) as { payload: string; signature: string };
    parsed.payload = `${parsed.payload.slice(0, -1)}A`;
    expect(() => verifyLicenseDocument(JSON.stringify(parsed), publicKey)).toThrow(
      'LICENSE_SIGNATURE_INVALID'
    );
  });

  it('uses trusted time high-watermark and preserves the three edition states', () => {
    const document = createLicenseDocument(
      {
        formatVersion: 1,
        licenseId: 'license-2',
        enterpriseName: 'Acme',
        issuedAt: 1_000,
        expiresAt: 3_000,
        hostFingerprint: fingerprint,
        features: ['ENTERPRISE']
      },
      privateKey
    );
    expect(
      evaluateLicense(
        { document: null, everActivated: false, highWatermark: 0 },
        {
          now: 2_000,
          hostFingerprint: fingerprint,
          publicKey
        }
      )
    ).toMatchObject({ state: 'COMMUNITY', trustedTime: 2_000 });
    expect(
      evaluateLicense(
        { document, everActivated: false, highWatermark: 0 },
        {
          now: 2_000,
          hostFingerprint: fingerprint,
          publicKey
        }
      )
    ).toMatchObject({ state: 'ENTERPRISE_VALID', trustedTime: 2_000 });
    expect(
      evaluateLicense(
        { document, everActivated: true, highWatermark: 4_000 },
        {
          now: 2_000,
          hostFingerprint: fingerprint,
          publicKey
        }
      )
    ).toMatchObject({ state: 'ENTERPRISE_FROZEN', reason: 'LICENSE_EXPIRED', trustedTime: 4_000 });
    expect(
      evaluateLicense(
        { document: null, everActivated: true, highWatermark: 4_000 },
        {
          now: 5_000,
          hostFingerprint: fingerprint,
          publicKey
        }
      )
    ).toMatchObject({ state: 'ENTERPRISE_FROZEN', reason: 'LICENSE_MISSING' });
  });
});
