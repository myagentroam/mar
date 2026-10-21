import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readLicenseHostUuid } from '../../ee/server/src/license/license-service.js';

describe('required host identity', () => {
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
