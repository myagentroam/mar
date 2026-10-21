import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { thirdPartyNoticesPlugin } from '../../scripts/third-party-notices.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mar-web-notices-'));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

async function notices(moduleIds: readonly string[] = []) {
  const plugin = thirdPartyNoticesPlugin({ outputDirectory: directory });
  const hook = plugin.generateBundle;
  if (typeof hook !== 'function') throw new Error('NOTICE_GENERATION_HOOK_REQUIRED');
  const emitFile = vi.fn<(asset: unknown) => string>(() => 'notices');
  await Reflect.apply(hook, { emitFile }, [{}, { chunk: { type: 'chunk', moduleIds } }, false]);
  expect(emitFile).toHaveBeenCalledTimes(1);
  const asset = emitFile.mock.calls[0]![0] as {
    type: string;
    fileName: string;
    source: string;
  };
  expect(asset.type).toBe('asset');
  expect(asset.fileName).toBe('THIRD_PARTY_NOTICES.txt');
  return asset.source;
}

function packageModule(name: string, license: string, text?: string) {
  const root = join(directory, 'node_modules', name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version: '1.0.0', license }));
  if (text !== undefined) writeFileSync(join(root, 'LICENSE'), text);
  writeFileSync(join(root, 'index.js'), 'export const value = 1;\n');
  return join(root, 'index.js');
}

describe('shared third-party notices generation', () => {
  it('retains all bundled icon license and notice texts without enterprise paths', async () => {
    const result = await notices();
    for (const file of [
      'seti/assets/NOTICE.md',
      'seti/assets/LICENSE.txt',
      'material/LICENSE.txt',
      'material/UPSTREAM_LICENSE.txt'
    ]) {
      expect(result).toContain(
        readFileSync(new URL(`../../src/icon-themes/${file}`, import.meta.url), 'utf8').trim()
      );
    }
    expect(result).not.toContain('packages/enterprise-web');
  });

  it('includes only emitted third-party modules and deduplicates packages', async () => {
    const included = packageModule('included-fixture', 'MIT', 'Copyright included fixture');
    packageModule('unused-fixture', 'MIT', 'Copyright unused fixture');
    const result = await notices([included, `${included}?raw`]);
    expect(result.match(/included-fixture 1\.0\.0/gu)).toHaveLength(1);
    expect(result).toContain('Copyright included fixture');
    expect(result).not.toContain('unused-fixture');
  });

  it('retains license and notice files from scoped packages', async () => {
    const included = packageModule('@fixture/asset', 'Apache-2.0', 'Fixture license text');
    writeFileSync(join(directory, 'node_modules/@fixture/asset/NOTICE'), 'Fixture NOTICE text');
    const result = await notices([included]);
    expect(result).toContain('@fixture/asset 1.0.0');
    expect(result).toContain('Fixture license text');
    expect(result).toContain('Fixture NOTICE text');
  });

  it('keeps the readable missing-license diagnostic for a package without text', async () => {
    const included = packageModule('missing-license-fixture', 'Custom');
    const result = await notices([included]);
    expect(result).toContain('missing-license-fixture 1.0.0');
    expect(result).toContain('License text is not included in this package distribution.');
  });
});
