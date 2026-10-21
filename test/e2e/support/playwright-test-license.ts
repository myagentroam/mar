import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  computeHostFingerprint,
  createLicenseDocument
} from '../../../ee/server/src/license/license-domain.js';

export const PLAYWRIGHT_LICENSE_PRODUCT_UUID = '00000000-0000-0000-0000-309c23637c46';

interface PlaywrightTestLicenseKey {
  readonly publicKey: string;
  readonly privateKey: string;
}

function licenseKeyPath(testRunId: string): string {
  return resolve(process.cwd(), `test/runs/playwright-license-${testRunId}.json`);
}

function readPlaywrightTestLicenseKey(keyPath: string): PlaywrightTestLicenseKey {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(keyPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('MAR_TEST_LICENSE_KEY_MISSING');
    throw error;
  }
  const key = value as Partial<PlaywrightTestLicenseKey>;
  if (typeof key.publicKey !== 'string' || typeof key.privateKey !== 'string')
    throw new Error('MAR_TEST_LICENSE_KEY_INVALID');
  return { publicKey: key.publicKey, privateKey: key.privateKey };
}

export function initializePlaywrightTestLicense(testRunId: string): {
  readonly publicKey: string;
  readonly keyPath: string;
} {
  const keyPath = licenseKeyPath(testRunId);
  const inheritedPath = process.env['MAR_TEST_LICENSE_KEY_PATH'];
  const inheritedPublicKey = process.env['MAR_TEST_LICENSE_PUBLIC_KEY'];
  if (inheritedPath !== undefined || inheritedPublicKey !== undefined) {
    if (!inheritedPath || !inheritedPublicKey || resolve(inheritedPath) !== keyPath)
      throw new Error('MAR_TEST_LICENSE_KEY_MISMATCH');
    const key = readPlaywrightTestLicenseKey(keyPath);
    if (key.publicKey !== inheritedPublicKey) throw new Error('MAR_TEST_LICENSE_KEY_MISMATCH');
    return { publicKey: key.publicKey, keyPath };
  }

  try {
    const existing = readPlaywrightTestLicenseKey(keyPath);
    return { publicKey: existing.publicKey, keyPath };
  } catch (error) {
    if ((error as Error).message !== 'MAR_TEST_LICENSE_KEY_MISSING') throw error;
  }

  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  mkdirSync(resolve(process.cwd(), 'test/runs'), { recursive: true });
  try {
    writeFileSync(keyPath, JSON.stringify({ publicKey, privateKey }), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = readPlaywrightTestLicenseKey(keyPath);
    return { publicKey: existing.publicKey, keyPath };
  }
  return { publicKey, keyPath };
}

function loadPlaywrightTestLicenseKey(): PlaywrightTestLicenseKey {
  const keyPath = process.env['MAR_TEST_LICENSE_KEY_PATH'];
  if (!keyPath) throw new Error('MAR_TEST_LICENSE_KEY_PATH_REQUIRED');
  const key = readPlaywrightTestLicenseKey(keyPath);
  const configuredPublicKey = process.env['MAR_TEST_LICENSE_PUBLIC_KEY'];
  if (configuredPublicKey !== undefined && configuredPublicKey !== key.publicKey) {
    throw new Error('MAR_TEST_LICENSE_KEY_MISMATCH');
  }
  return key;
}

export function getPlaywrightTestLicensePublicKey(): string {
  return loadPlaywrightTestLicenseKey().publicKey;
}

export function createPlaywrightTestLicenseDocument(now = Date.now()): string {
  const key = loadPlaywrightTestLicenseKey();
  return createLicenseDocument(
    {
      formatVersion: 1,
      licenseId: 'playwright-hosted-conversation',
      enterpriseName: 'Playwright Enterprise',
      issuedAt: now - 60_000,
      expiresAt: now + 24 * 60 * 60 * 1000,
      hostFingerprint: computeHostFingerprint(PLAYWRIGHT_LICENSE_PRODUCT_UUID),
      features: ['ENTERPRISE']
    },
    createPrivateKey({
      key: Buffer.from(key.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8'
    })
  );
}
