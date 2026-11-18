import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import marIconMapping from '../../packages/web-core/src/icon-themes/mar/mapping.json' with { type: 'json' };

test('MAR icon development preview opens as one offline HTML file', async ({ page }, testInfo) => {
  const source = new URL(
    '../../packages/web-core/src/icon-themes/mar/preview.html',
    import.meta.url
  );
  const previewPath = testInfo.outputPath('preview.html');
  await mkdir(dirname(previewPath), { recursive: true });
  const preview = pathToFileURL(previewPath);
  await copyFile(source, preview);
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url() !== preview.href) requests.push(request.url());
  });
  // The single file must work without Vite, assets on disk, or access to the network.
  await page.context().setOffline(true);
  await page.goto(preview.href);
  const catalog = page.getByRole('list', { name: 'Icon catalog' });
  await expect(catalog.getByRole('listitem')).toHaveCount(
    Object.keys(marIconMapping.artwork).length
  );
  const search = page.getByRole('searchbox', { name: 'File name or extension' });
  const resolved = page.getByRole('region', { name: 'Resolved icon' });
  for (const [query, id] of [
    ['AGENTS.md', 'agent'],
    ['docs/AGENTS.md', 'agent'],
    ['CLAUDE.local.md', 'agent'],
    ['*.py', 'python'],
    ['.py', 'fallback'],
    ['.prompt.md', 'markdown'],
    ['*.prompt.md', 'prompt'],
    ['packages/web-core/src/', 'src']
  ] as const) {
    await search.fill(query);
    const symbol = resolved.locator('use').first();
    await expect(symbol).toHaveAttribute('href', new RegExp(`#mar-file-${id}$`));
    await expect
      .poll(() => symbol.evaluate((node: SVGUseElement) => node.getBBox().width))
      .toBeGreaterThan(0);
  }
  await search.fill('my_script.py');
  await expect(catalog.getByRole('listitem').locator('use').first()).toHaveAttribute(
    'href',
    /#mar-file-python$/u
  );
  await search.fill('src/');
  await page.getByLabel('Color theme').selectOption('vscode-dark-2026');
  await expect(resolved.locator('svg').first()).toHaveCSS('color', 'rgb(117, 195, 255)');
  expect(requests).toEqual([]);
  await search.fill('AGENTS.md');
  await page.screenshot({ path: testInfo.outputPath('mar-icons-preview-dark.png') });
});
