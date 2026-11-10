import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { downloadPinnedFile } from '../../mar-server/src/quick-start/download.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('Pinned Quick Start downloads', () => {
  it('only exposes the destination after verifying the complete digest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-quick-download-'));
    directories.push(directory);
    const server = createServer((_request, reply) => reply.end('fixture archive'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('listener unavailable');
    const url = `http://127.0.0.1:${address.port}/artifact`;
    try {
      const digest = createHash('sha256').update('fixture archive').digest('hex');
      const path = join(directory, 'component');
      await expect(downloadPinnedFile(url, '0'.repeat(64), path)).rejects.toThrow(
        'QUICK_START_DOWNLOAD_INVALID'
      );
      expect(await readdir(directory)).toEqual([]);
      await downloadPinnedFile(url, digest, path);
      expect(await readFile(path, 'utf8')).toBe('fixture archive');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
