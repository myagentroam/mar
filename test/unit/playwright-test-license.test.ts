import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { initializePlaywrightTestLicense } from '../e2e/support/playwright-test-license.js';

const savedKeyPath = process.env['MAR_TEST_LICENSE_KEY_PATH'];
const savedPublicKey = process.env['MAR_TEST_LICENSE_PUBLIC_KEY'];
const createdPaths: string[] = [];

function clearLicenseEnvironment(): void {
  delete process.env['MAR_TEST_LICENSE_KEY_PATH'];
  delete process.env['MAR_TEST_LICENSE_PUBLIC_KEY'];
}

function restoreLicenseEnvironment(): void {
  if (savedKeyPath === undefined) delete process.env['MAR_TEST_LICENSE_KEY_PATH'];
  else process.env['MAR_TEST_LICENSE_KEY_PATH'] = savedKeyPath;
  if (savedPublicKey === undefined) delete process.env['MAR_TEST_LICENSE_PUBLIC_KEY'];
  else process.env['MAR_TEST_LICENSE_PUBLIC_KEY'] = savedPublicKey;
}

afterEach(() => {
  restoreLicenseEnvironment();
  for (const path of createdPaths.splice(0)) rmSync(path, { force: true });
});

describe('Playwright test license fixture', () => {
  it('reuses one key when the same run is initialized again', () => {
    clearLicenseEnvironment();
    const runId = `license-reuse-${randomUUID()}`;
    const first = initializePlaywrightTestLicense(runId);
    createdPaths.push(first.keyPath);
    const snapshot = readFileSync(first.keyPath, 'utf8');
    process.env['MAR_TEST_LICENSE_KEY_PATH'] = first.keyPath;
    process.env['MAR_TEST_LICENSE_PUBLIC_KEY'] = first.publicKey;

    const second = initializePlaywrightTestLicense(runId);

    expect(second).toEqual(first);
    expect(readFileSync(first.keyPath, 'utf8')).toBe(snapshot);
  });

  it('creates different keys for different runs', () => {
    clearLicenseEnvironment();
    const first = initializePlaywrightTestLicense(`license-first-${randomUUID()}`);
    const second = initializePlaywrightTestLicense(`license-second-${randomUUID()}`);
    createdPaths.push(first.keyPath, second.keyPath);

    expect(second.keyPath).not.toBe(first.keyPath);
    expect(second.publicKey).not.toBe(first.publicKey);
  });

  it('rejects an inherited key path and public key that do not match', () => {
    clearLicenseEnvironment();
    const first = initializePlaywrightTestLicense(`license-path-${randomUUID()}`);
    const second = initializePlaywrightTestLicense(`license-public-${randomUUID()}`);
    createdPaths.push(first.keyPath, second.keyPath);
    process.env['MAR_TEST_LICENSE_KEY_PATH'] = first.keyPath;
    process.env['MAR_TEST_LICENSE_PUBLIC_KEY'] = second.publicKey;

    expect(() => initializePlaywrightTestLicense('license-path-mismatch')).toThrow(
      'MAR_TEST_LICENSE_KEY_MISMATCH'
    );
  });
});
