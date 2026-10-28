import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as entry from '../../src/sandbox/linux/index.js';

describe('Linux sandbox public and dependency boundary', () => {
  it('retains the runtime exports of the Linux public entry', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'BubblewrapSandboxExecutor',
      'LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION',
      'probeBubblewrapSandbox'
    ]);
  });
  it('does not import the direct Host executor implementation', async () => {
    const directory = new URL('../../src/sandbox/linux/', import.meta.url);
    const files = (await readdir(directory)).filter((name) => name.endsWith('.ts'));
    for (const file of files) {
      const source = await readFile(new URL(file, directory), 'utf8');
      expect(source, file).not.toMatch(
        /(?:from\s*|import\s*\()\s*['"][^'"]*host\/local-process-executor(?:\.js)?['"]/u
      );
    }
  });
});
