import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readLicenseHostUuid,
  readQuickStartHostFingerprint
} from '../../ee/server/src/license/license-service.js';
import { computeMachineIdFingerprint } from '../../ee/server/src/license/license-domain.js';

describe('required host identity', () => {
  it('reads a Linux machine ID without exposing it or falling back to another identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-license-machine-'));
    try {
      const path = join(directory, 'machine-id');
      const machineId = 'ec2a8f9c70d44a718b71b5c98d871234';
      await writeFile(path, `${machineId}\n`);
      expect(readQuickStartHostFingerprint(path)).toBe(computeMachineIdFingerprint(machineId));
      for (const value of ['', 'uninitialized', 'invalid', '0'.repeat(32)]) {
        await writeFile(path, value);
        expect(() => readQuickStartHostFingerprint(path)).toThrow('LICENSE_HOST_UNAVAILABLE');
      }
      expect(() => readQuickStartHostFingerprint(join(directory, 'missing'))).toThrow(
        'LICENSE_HOST_UNAVAILABLE'
      );
      expect(() => readQuickStartHostFingerprint(directory)).toThrow('LICENSE_HOST_UNAVAILABLE');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts the real UUID input independently of activation state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-license-host-'));
    try {
      const path = join(directory, 'product_uuid');
      const uuid = '12345678-1234-5678-1234-123456789abc\n';
      await writeFile(path, uuid);
      expect(readLicenseHostUuid(path)).toBe(uuid);
      for (const value of ['', 'invalid', '00000000-0000-0000-0000-000000000000']) {
        await writeFile(path, value);
        expect(() => readLicenseHostUuid(path)).toThrow('LICENSE_HOST_UNAVAILABLE');
      }
      expect(() => readLicenseHostUuid(join(directory, 'missing'))).toThrow(
        'LICENSE_HOST_UNAVAILABLE'
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
