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
    ['theme.module.css', 'style'],
    ['*.scss', 'style'],
    ['pasted-text.txt', 'txt'],
    ['illustrations.svg', 'vector'],
    ['screenshot.png', 'image'],
    ['.py', 'fallback'],
    ['.prompt.md', 'markdown'],
    ['*.prompt.md', 'prompt'],
    ['packages/web-core/src/', 'src'],
    ['packages/web-core/test/', 'tests'],
    ['button.spec.ts', 'test'],
    ['.agents/', 'dir'],
    ['docs/', 'dir'],
    ['website/dist/', 'dir'],
    ['node_modules/', 'dir']
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
  await search.fill('pasted-text.txt');
  await expect(resolved.locator('svg').first()).toHaveCSS('color', 'rgb(82, 97, 113)');
  await resolved.locator('.icon-sample').screenshot({ path: testInfo.outputPath('txt-light.png') });
  await search.fill('illustrations.svg');
  await resolved.locator('.icon-sample').screenshot({ path: testInfo.outputPath('svg-light.png') });
  await search.fill('AGENTS.md');
  await expect(resolved.locator('svg').first()).toHaveCSS('color', 'rgb(0, 105, 232)');
  await page.getByLabel('Color theme').selectOption('vscode-dark-2026');
  await expect(resolved.locator('svg').first()).toHaveCSS('color', 'rgb(89, 169, 255)');
  await search.fill('CLAUDE.local.md');
  await expect(resolved.locator('svg').first()).toHaveCSS('color', 'rgb(189, 150, 255)');
  await search.fill('src/');
  await expect(resolved.locator('svg').first()).toHaveCSS('color', 'rgb(117, 195, 255)');
  await search.fill('pasted-text.txt');
  await expect(resolved.locator('svg').first()).toHaveCSS('color', 'rgb(157, 170, 185)');
  await resolved.locator('.icon-sample').screenshot({ path: testInfo.outputPath('txt-dark.png') });
  await search.fill('illustrations.svg');
  await resolved.locator('.icon-sample').screenshot({ path: testInfo.outputPath('svg-dark.png') });
  expect(requests).toEqual([]);
  await search.fill('AGENTS.md');
  await page.screenshot({ path: testInfo.outputPath('mar-icons-preview-dark.png') });
});
