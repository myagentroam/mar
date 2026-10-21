import { fileURLToPath } from 'node:url';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUNDLED_RIPGREP_VERSION,
  bundledRipgrepDirectory,
  bundledRipgrepPath
} from '../../src/ripgrep-binary.js';
import { WorkspaceContentSearchService } from '../../src/service/workspace-content-search-service.js';
import type { WorkspaceFileService } from '../../src/service/workspace-file-service.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

describe('Node bundled ripgrep', () => {
  it.each([
    ['linux', 'x64', 'linux-x64/rg'],
    ['linux', 'arm64', 'linux-arm64/rg'],
    ['darwin', 'x64', 'darwin-x64/rg'],
    ['darwin', 'arm64', 'darwin-arm64/rg'],
    ['win32', 'x64', 'win32-x64/rg.exe'],
    ['win32', 'arm64', 'win32-arm64/rg.exe']
  ] as const)('selects %s %s from the package resources', (platform, arch, suffix) => {
    expect(
      bundledRipgrepPath(platform, arch, root)
        .replaceAll('\\', '/')
        .endsWith(`/mar-node/vendor/ripgrep/${suffix}`)
    ).toBe(true);
  });

  it('rejects targets outside the Node support matrix', () => {
    expect(() => bundledRipgrepPath('darwin', 'ia32', root)).toThrow(
      'RIPGREP_PLATFORM_UNSUPPORTED'
    );
    expect(() => bundledRipgrepPath('linux', 'ia32', root)).toThrow('RIPGREP_PLATFORM_UNSUPPORTED');
  });

  it('ships executable resources and the upstream license', async () => {
    expect(BUNDLED_RIPGREP_VERSION).toBe('15.1.0');
    for (const [platform, arch] of [
      ['linux', 'x64'],
      ['linux', 'arm64'],
      ['darwin', 'x64'],
      ['darwin', 'arm64'],
      ['win32', 'x64'],
      ['win32', 'arm64']
    ] as const)
      await access(bundledRipgrepPath(platform, arch, root), constants.R_OK);
    await expect(
      readFile(resolve(bundledRipgrepDirectory(root), 'LICENSE-MIT'), 'utf8')
    ).resolves.toContain('Permission is hereby granted');
    const manifest = JSON.parse(
      await readFile(resolve(bundledRipgrepDirectory(root), 'manifest.json'), 'utf8')
    ) as {
      version: string;
      targets: Record<string, { executable: string; executableSha256: string }>;
    };
    expect(manifest.version).toBe(BUNDLED_RIPGREP_VERSION);
    for (const target of Object.values(manifest.targets))
      expect(
        createHash('sha256')
          .update(await readFile(resolve(bundledRipgrepDirectory(root), target.executable)))
          .digest('hex')
      ).toBe(target.executableSha256);
  });

  it('uses the bundled ripgrep binary for case-insensitive regular expressions', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'mar-ripgrep-regexp-'));
    try {
      await writeFile(resolve(directory, 'match.txt'), 'Prefix 中文 fallback');
      const files = {
        index: () => ({
          contentCandidates: () =>
            Promise.resolve({
              entries: [{ path: 'match.txt' }],
              truncated: false
            })
        })
      } as unknown as WorkspaceFileService;
      const service = new WorkspaceContentSearchService(files);

      await expect(
        service.search({ id: 'workspace-regexp', path: directory } as never, {
          query: '^prefix\\s+中文',
          regex: true
        })
      ).resolves.toMatchObject({
        engine: 'RIPGREP',
        matches: [expect.objectContaining({ path: 'match.txt', line: 1, column: 1 })]
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not merge concurrent regular expressions that differ only by case', async () => {
    let resolveCandidates:
      | ((value: {
          readonly entries: readonly { readonly path: string }[];
          readonly truncated: boolean;
        }) => void)
      | undefined;
    const candidates = new Promise<{
      readonly entries: readonly { readonly path: string }[];
      readonly truncated: boolean;
    }>((resolve) => {
      resolveCandidates = resolve;
    });
    const files = {
      index: () => ({ contentCandidates: () => candidates })
    } as unknown as WorkspaceFileService;
    const service = new WorkspaceContentSearchService(files);
    const workspace = { id: 'workspace-regexp-key', path: tmpdir() } as never;

    const first = service.search(workspace, { query: '\\P{Lowercase_Letter}', regex: true });
    const second = service.search(workspace, { query: '\\p{Lowercase_Letter}', regex: true });

    expect(second).not.toBe(first);
    resolveCandidates?.({ entries: [], truncated: false });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ matches: [] }),
      expect.objectContaining({ matches: [] })
    ]);
  });

  it('falls back to the bounded Node scanner for literal search when the bundled resource is unavailable', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'mar-ripgrep-fallback-'));
    try {
      await writeFile(resolve(directory, 'match.txt'), 'bundled fallback');
      const files = {
        index: () => ({
          contentCandidates: () =>
            Promise.resolve({
              entries: [{ path: 'match.txt' }],
              truncated: false
            })
        })
      } as unknown as WorkspaceFileService;
      const service = new WorkspaceContentSearchService(files, 'linux', null);
      await expect(
        service.search({ id: 'workspace-1', path: directory } as never, { query: 'fallback' })
      ).resolves.toMatchObject({
        engine: 'NODE',
        matches: [expect.objectContaining({ path: 'match.txt', line: 1 })]
      });
      await expect(
        service.search({ id: 'workspace-1', path: directory } as never, {
          query: '^bundled\\s+fall',
          regex: true
        })
      ).rejects.toThrow('RIPGREP_RESOURCE_UNAVAILABLE');
      await expect(
        service.search({ id: 'workspace-1', path: directory } as never, { query: '(', regex: true })
      ).rejects.toThrow('RIPGREP_RESOURCE_UNAVAILABLE');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an invalid regular expression even when no candidate file exists', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'mar-ripgrep-empty-regexp-'));
    try {
      const files = {
        index: () => ({
          contentCandidates: () => Promise.resolve({ entries: [], truncated: false })
        })
      } as unknown as WorkspaceFileService;
      const service = new WorkspaceContentSearchService(files);

      await expect(
        service.search({ id: 'workspace-empty-regexp', path: directory } as never, {
          query: '(',
          regex: true
        })
      ).rejects.toThrow('FILE_CONTENT_SEARCH_INVALID');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
