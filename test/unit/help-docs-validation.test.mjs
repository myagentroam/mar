import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');

async function validateFixture(newline, includeEnglish = true) {
  const fixture = await mkdtemp(resolve(tmpdir(), 'mar-help-validation-'));
  try {
    for (const directory of [
      'scripts',
      'docs/help/getting-started',
      'docs/help/en-US/getting-started',
      'mar-web-console/docs/.vitepress'
    ]) {
      await mkdir(resolve(fixture, directory), { recursive: true });
    }
    for (const file of ['validate-help-docs.mjs', 'help-anchors.mjs']) {
      await copyFile(resolve(root, 'scripts', file), resolve(fixture, 'scripts', file));
    }
    await symlink(resolve(root, 'node_modules'), resolve(fixture, 'node_modules'), 'junction');
    const source = [
      '---',
      'title: Quick Start',
      'lastUpdated: 2026-11-12',
      '---',
      '# Quick Start',
      '',
      'Preserve the `nodeId` configuration field.'
    ].join(newline);
    for (const language of ['', ...(includeEnglish ? ['en-US/'] : [])]) {
      await writeFile(
        resolve(fixture, `docs/help/${language}getting-started/npm-quick-start.md`),
        source
      );
    }
    for (const [locale, prefix] of [
      ['zh-CN', ''],
      ['en-US', 'en-US/']
    ]) {
      await writeFile(
        resolve(fixture, `mar-web-console/docs/.vitepress/navigation.${locale}.ts`),
        `export default [{ link: '/${prefix}getting-started/npm-quick-start' }];`
      );
    }
    return spawnSync(process.execPath, [resolve(fixture, 'scripts/validate-help-docs.mjs')], {
      encoding: 'utf8',
      timeout: 30_000
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

for (const [name, newline] of [
  ['LF', '\n'],
  ['CRLF', '\r\n']
]) {
  test(`validates bilingual help with ${name} line endings on the host platform`, async () => {
    const result = await validateFixture(newline);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Help validation passed \(2 documents\)/u);
  });
}

test('still rejects a missing English counterpart', async () => {
  const result = await validateFixture('\n', false);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing matching English document/u);
});
