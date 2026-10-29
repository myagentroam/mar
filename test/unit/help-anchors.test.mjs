import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  inspectHelpMarkdown,
  missingHelpTargets,
  validateHelpAnchors
} from '../../scripts/help-anchors.mjs';

const root = resolve('/tmp/help-anchor-fixture');
const first = resolve(root, 'first.md');
const second = resolve(root, 'workbench/composer.md');

test('checks rendered VitePress slugs and ignores fenced examples and external URLs', async () => {
  const sources = new Map([
    [
      first,
      '[valid](workbench/composer.md#输入预测-prompt-tab)\n\n```md\n[example](#missing)\n```\n\n[external](https://example.com/#missing)'
    ],
    [second, '## 输入预测（Prompt Tab）']
  ]);
  assert.deepEqual(await validateHelpAnchors(root, sources), []);
});

test('reports absent local anchors, including links within the same document', async () => {
  const sources = new Map([
    [first, '# Heading\n\n[broken](#absent)\n\n[broken](workbench/composer.md#输入预测prompt-tab)'],
    [second, '## 输入预测（Prompt Tab）']
  ]);
  const errors = await validateHelpAnchors(root, sources);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((error) => error.includes('missing anchor')));
});

test('recognizes retained empty HTML anchors without accepting code or comment examples', async () => {
  const source = [
    '# Page',
    '',
    '<a id="输入预测prompt-tab"></a>',
    '',
    '[legacy](#输入预测prompt-tab)',
    '',
    "Inline alias <a id='inline-alias'></a> [inline](#inline-alias)",
    '',
    '```html',
    '<a id="fenced-only"></a>',
    '```',
    '',
    '`<a id="code-only"></a>`',
    '',
    '<!--',
    '<a id="comment-only"></a>',
    '-->',
    '',
    '[fenced](#fenced-only) [code](#code-only) [comment](#comment-only)'
  ].join('\n');
  const errors = await validateHelpAnchors(root, new Map([[first, source]]));
  assert.deepEqual(errors, [
    'first.md: missing anchor #fenced-only',
    'first.md: missing anchor #code-only',
    'first.md: missing anchor #comment-only'
  ]);
});

test('validates images while ignoring examples in fenced code', async () => {
  const fixture = await mkdtemp(resolve(tmpdir(), 'help-images-'));
  try {
    const file = resolve(fixture, 'page.md');
    await writeFile(resolve(fixture, 'present.png'), 'fixture');
    await writeFile(resolve(fixture, 'with space.png'), 'fixture');
    const source =
      '# Page\n\n![present](present.png)\n\n![space](with%20space.png)\n\n![missing](missing.png)\n\n```md\n![example](ignored.png)\n```';
    const { pages, errors } = await inspectHelpMarkdown(fixture, new Map([[file, source]]));
    assert.deepEqual(errors, []);
    const missing = missingHelpTargets(fixture, file, pages.get(file));
    assert.deepEqual(missing, ['page.md: missing local link missing.png']);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
