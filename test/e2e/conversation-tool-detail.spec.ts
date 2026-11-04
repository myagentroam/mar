import { expect, test, type Locator } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/conversation-tool-detail.html', {
    protocolSource: true
  });
});
test.afterAll(async () => {
  await fixture?.close();
});

async function expectUnclippedDetail(content: Locator) {
  await expect
    .poll(() =>
      content.evaluate((element) => {
        const bottom = element.getBoundingClientRect().bottom;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          if (
            ['hidden', 'clip'].includes(getComputedStyle(parent).overflowY) &&
            parent.getBoundingClientRect().bottom < bottom - 1
          )
            return false;
        }
        return true;
      })
    )
    .toBe(true);
}

for (const variant of [
  { width: 1280, theme: 'daylight', locale: 'en-US', more: 'Show more', less: 'Show less' },
  { width: 390, theme: 'dark', locale: 'zh-CN', more: '展开更多', less: '收起' }
]) {
  test(`previews the complete detail area by height at ${variant.width}px`, async ({
    page
  }, testInfo) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width: variant.width, height: 900 });
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(
      `${fixture.url}conversation-tool-detail.html?timeline=1&unified=1&updates=1&read-association=1&preview=1&theme=${variant.theme}&locale=${variant.locale}`
    );
    const process = page.locator('.process-heading').first();
    if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
    const read = page.locator('[data-tool-presentation="READ"]');
    await read.locator('> summary').click();
    const file = read.locator('.conversation-tool-detail');
    await file.locator('> summary').click();
    const preview = file.locator('.detail-preview-window');
    const more = file.getByRole('button', { name: variant.more, exact: true });
    await expect(more).toBeVisible();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(file.locator('pre')).toContainText('Returned line 40');
    await expect(file.locator('pre')).not.toContainText('[Truncated]');
    const heights = await preview.evaluate((element) => ({
      visible: element.getBoundingClientRect().height,
      full: element.firstElementChild!.getBoundingClientRect().height,
      limit: parseFloat(getComputedStyle(element).lineHeight) * 12
    }));
    expect(heights.visible).toBeLessThanOrEqual(heights.limit + 1);
    expect(heights.full).toBeGreaterThan(heights.visible);
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    await page.screenshot({
      path: testInfo.outputPath(`detail-preview-${variant.width}.png`),
      fullPage: true
    });
    await file.getByRole('button', { name: /Copy public record|复制公开记录/ }).click();
    const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
    expect(copied.payload.output.blocks[0].text).toContain('Returned line 40');
    await more.focus();
    await page.keyboard.press('Enter');
    const less = file.getByRole('button', { name: variant.less, exact: true });
    await expect(less).toHaveAttribute('aria-expanded', 'true');
    await expect(preview).toHaveCSS('max-height', 'none');
    await less.click();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await more.click();
    await file.locator('> summary').click();
    await expect(file.locator('.detail-preview')).toHaveCount(0);
    await file.locator('> summary').click();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await page.getByTestId('stream-details').click();
    await expect(file.locator('pre')).toContainText('live output');
    await expect(more).toHaveCount(0);
    await page.getByTestId('finish-details').click();
    await expect(file.locator('pre')).toContainText('[Truncated]');
    await expect(more).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    expect(pageErrors).toEqual([]);
  });
}

test('uses area height for wrapped single-line execution output and keeps copy outside', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${fixture.url}conversation-tool-detail.html`);
  const exec = page.getByTestId('exec');
  await exec.locator('summary').click();
  await expect(exec.getByRole('button', { name: 'Show more', exact: true })).toHaveCount(0);
  await page.getByTestId('finish').click();
  const more = exec.getByRole('button', { name: 'Show more', exact: true });
  await expect(more).toBeVisible();
  await expect(exec.getByRole('button', { name: 'Copy public record' })).toBeVisible();
  expect(
    await exec
      .locator('.detail-preview-window')
      .evaluate((element) => element.scrollHeight > element.clientHeight)
  ).toBe(true);
  await more.click();
  await expect(exec.locator('.detail-preview-window')).toHaveCSS('max-height', 'none');
  await expect(exec.locator('.tool-output-text')).toContainText('TAIL');
  await expect(exec.locator('.execution-detail')).toHaveText(/TAIL\s+\[Truncated\]\s+Exit 0$/, {
    useInnerText: true
  });
  await expect(exec.getByRole('button', { name: 'Show less', exact: true })).toBeVisible();
});

test('remeasures on resize and reveals a keyboard-focused link below the preview', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.url}conversation-tool-detail.html?preview-probe=1`);
  const probe = page.getByTestId('preview-probe');
  const more = probe.getByRole('button', { name: 'Show more', exact: true });
  const less = probe.getByRole('button', { name: 'Show less', exact: true });
  await expect(more).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(more).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(more).toHaveCount(0);
  await page.getByTestId('stretch-preview').click();
  await expect(more).toBeVisible();
  const link = page.getByTestId('preview-link');
  await link.focus();
  await expect(less).toHaveAttribute('aria-expanded', 'true');
  await expect(link).toBeFocused();
  await expect(link).toBeInViewport();
});

test('mounts independent details only while open and releases them with the process', async ({
  page
}) => {
  await page.goto(`${fixture.url}conversation-tool-detail.html?timeline=1&unified=1`);
  const process = page.locator('.process-heading').first();
  if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
  const search = page.locator('[data-tool-presentation="WEB_SEARCH"]');
  const fetch = page.locator('[data-tool-presentation="WEB_FETCH"]');
  await expect(search.locator('.tool-detail, .conversation-tool-sources a')).toHaveCount(0);
  await expect(fetch.locator('.tool-detail')).toHaveCount(0);
  await search.locator('> summary').click();
  await fetch.locator('> summary').click();
  await expect(search.locator('.conversation-tool-sources a')).toHaveCount(1);
  await expect(search.locator('.conversation-tool-sources a')).toHaveAttribute(
    'href',
    'https://example.com/docs'
  );
  await expect(search.locator('.conversation-tool-sources a')).toHaveAttribute(
    'rel',
    'noopener noreferrer'
  );
  await expect(search.locator('.conversation-tool-source-host')).toHaveText(
    'https://example.com/docs'
  );
  await expect(search.locator('.conversation-tool-sources')).toContainText(
    'A plain-text search summary.'
  );
  await expect(search.locator('.conversation-tool-sources')).toContainText('<plain summary>');
  await expect(search.locator('.conversation-tool-sources plain')).toHaveCount(0);
  expect(await search.locator('.conversation-tool-sources').innerHTML()).toContain(
    '&lt;plain summary&gt;'
  );
  await expect(search.locator('.web-query')).toHaveText('documentation');
  await expect(search.locator('.tool-detail')).not.toContainText('Input:');
  await expect(search.locator('.web-output')).toHaveCount(0);
  await expect(search.locator('.tool-detail')).not.toContainText('Relevant documentation found.');
  await expect(fetch.locator('.web-page-url a')).toHaveAttribute(
    'href',
    'https://example.com/docs'
  );
  await expect(fetch.locator('.web-output')).toContainText('The requested page content.');
  await expect(fetch.locator('.tool-detail')).not.toContainText('Input:');
  await search.locator('> summary').click();
  await expect(search.locator('.tool-detail, .conversation-tool-sources a')).toHaveCount(0);
  await process.click();
  await expect(
    page.locator('[data-tool-presentation="WEB_FETCH"] .conversation-detail-text')
  ).toHaveCount(0);
  await process.click();
  await expect(
    page.locator('[data-tool-presentation="WEB_FETCH"] .conversation-detail-text')
  ).toHaveCount(0);
});

test('read file details separate their path and range from the associated raw file text', async ({
  page
}) => {
  await page.goto(
    `${fixture.url}conversation-tool-detail.html?timeline=1&unified=1&read-association=1`
  );
  const process = page.locator('.process-heading').first();
  if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
  const read = page.locator('[data-tool-presentation="READ"]');
  await read.locator('> summary').click();
  await read.locator('.conversation-tool-detail > summary').click();
  const detail = read.locator('.conversation-detail-text');
  await expect(read.locator('.conversation-tool-detail > summary')).toContainText('3–4');
  await expect(read.locator('.tool-detail-heading')).toHaveText('/fixture/example.ts · 3–4');
  await expect(detail).toHaveText('  first file\r\nsecond line\r\n', { useInnerText: false });
  await expect(detail).not.toContainText('3–4');
  await expect(detail).not.toContainText('/fixture/example.ts');
  await expect(detail).not.toContainText('1: export const result');
});

for (const [width, theme, locale] of [
  [1280, 'daylight', 'en-US'],
  [390, 'dark', 'zh-CN']
] as const) {
  test(`renders the revised Read, Skill and execution layouts at ${width}px`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(
      `${fixture.url}conversation-tool-detail.html?timeline&unified&read-association&detail-layout&theme=${theme}&locale=${locale}`
    );
    const process = page.locator('.process-heading').first();
    if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
    const read = page.locator('[data-tool-presentation="READ"]');
    await read.locator('> summary').click();
    await read.locator('.conversation-tool-detail > summary').click();
    await expect(read.locator('.tool-detail-heading')).toHaveText('/fixture/example.ts · 3–4');
    const skill = page.locator('[data-tool-presentation="SKILL"]');
    await skill.locator('> summary').click();
    await expect(skill.locator('.tool-detail-heading')).toHaveText('mar-web-spec');
    const description = skill.locator('.conversation-detail-text');
    await expect(description).toHaveText(
      'Design <plain> interfaces.\nKeep the original description and its line breaks.'
    );
    await expect(skill.locator('plain')).toHaveCount(0);
    await expect(skill).not.toContainText('Complete skill output');
    await expect(skill).not.toContainText('original skill request');
    await expect(skill).not.toContainText('Output:');
    await skill.getByRole('button', { name: /Copy public record|复制公开记录/ }).click();
    await expect(skill.getByRole('button', { name: /Copied|已复制/ })).toBeVisible();
    const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
    expect(copied.payload.output.blocks[0].text).toBe(
      'Complete skill output is copied, not displayed.'
    );
    await page.locator('.command-group > details > summary').click();
    const shell = page
      .locator('.conversation-command-detail')
      .filter({ has: page.locator('.conversation-command-preview', { hasText: 'printf test' }) });
    await shell.locator('> summary').click();
    await expect(shell.locator('.tool-detail-heading')).toHaveText('exec');
    await expect(shell.locator('.tool-source-text')).toHaveText('Command: printf test');
    await expect(shell.locator('.execution-output').nth(0)).toContainText('Output:');
    await expect(shell.locator('.execution-output').nth(1)).toContainText('stderr:');
    const code = page.locator('.conversation-command-detail').filter({
      has: page.locator('.conversation-command-preview', {
        hasText: 'const result = await tools.read'
      })
    });
    await code.locator('> summary').click();
    await expect(code.locator('.tool-detail-heading')).toHaveText('code_exec');
    await expect(code.locator('.tool-source-text')).toContainText('Code: const result');
    await expect(code.locator('.tool-output-text')).toHaveText('Observed the requested file.');
    await expect(code.locator('.tool-exit')).toHaveCount(0);
    for (const body of [read, skill, shell, code]) {
      const heading = body.locator('.tool-detail-heading');
      await expect(heading).toHaveCSS('font-size', '12px');
      await expect(heading).toHaveCSS('font-weight', '400');
      for (const content of await body.locator('.conversation-detail-text').all()) {
        await expect(content).toHaveCSS('font-size', '12px');
        await expect(content).toHaveCSS('font-weight', '400');
      }
      expect(await heading.evaluate((element) => getComputedStyle(element).color)).not.toBe(
        await body
          .locator('.conversation-detail-text')
          .first()
          .evaluate((element) => getComputedStyle(element).color)
      );
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page.setViewportSize({ width, height: 1600 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectUnclippedDetail(code.locator('.execution-detail'));
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    await page.screenshot({
      path: testInfo.outputPath(`revised-details-${width}-${theme}.png`),
      fullPage: true
    });
  });
}

for (const width of [1280, 390]) {
  test(`wait rows use explicit commands, code or resource IDs at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(
      `${fixture.url}conversation-tool-detail.html?timeline&unified&wait-titles&locale=${width === 390 ? 'zh-CN' : 'en-US'}&theme=${width === 390 ? 'dark' : 'daylight'}`
    );
    const process = page.locator('.process-heading').first();
    if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
    await page.locator('.command-group > details > summary').click();
    const source = `pnpm test --filter fixture ${'long-argument-'.repeat(24)}`;
    const code = `await tools.exec({ command: "${source}" });\nawait tools.agent_wait({ agentId: "peer" });`;
    for (const [targetId, toolName, title] of [
      ['p_known', 'exec_wait', `wait ${source}`],
      ['c_known', 'code_exec_wait', `wait ${code}`],
      ['p_unknown', 'exec_wait', 'wait p_unknown'],
      ['c_unknown', 'code_exec_wait', 'wait c_unknown']
    ] as const) {
      const row = page.locator('.conversation-command-detail').filter({
        has: page.locator('.conversation-command-preview', { hasText: title })
      });
      const matchingRow = row;
      const preview = matchingRow.locator('.conversation-command-preview');
      await expect(preview).toHaveText(title.replaceAll('\n', ' '));
      if (targetId === 'p_known' || targetId === 'c_known') {
        expect(await preview.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
          true
        );
      }
      await expect(matchingRow.locator('.tool-detail')).toHaveCount(0);
      await matchingRow.locator('> summary').click();
      await expect(matchingRow.locator('.tool-detail-heading')).toContainText(`${toolName} · Poll`);
      if (targetId === 'p_unknown' || targetId === 'c_unknown')
        await expect(matchingRow.locator('.tool-detail-heading')).toContainText(targetId);
      if (targetId === 'c_known') {
        await expect(matchingRow.locator('.execution-detail')).toContainText('Code:');
        await expect(matchingRow.locator('.execution-detail')).toContainText(code);
        await expect(matchingRow.locator('.tool-detail-heading')).not.toContainText(targetId);
      }
      await matchingRow.getByRole('button', { name: /Copy public record|复制公开记录/ }).click();
      await expect(matchingRow.getByRole('button', { name: /Copied|已复制/ })).toBeVisible();
      const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
      expect(copied.payload.toolPresentation.execution.toolName).toBe(toolName);
      expect(copied.payload.toolPresentation.execution.targetId).toBe(targetId);
      if (targetId === 'c_known')
        expect(copied.payload.toolPresentation.execution.source.text).toBe(code);
      await matchingRow.locator('> summary').click();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
  });

  test(`Read keeps the range visible beside a long path at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const path = `/fixture/${'long-directory/'.repeat(24)}README.md`;
    await page.goto(
      `${fixture.url}conversation-tool-detail.html?timeline&unified&read-association&read-path=${encodeURIComponent(path)}`
    );
    const process = page.locator('.process-heading').first();
    if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
    const read = page.locator('[data-tool-presentation="READ"]');
    await read.locator('> summary').click();
    const heading = read.locator('.conversation-tool-detail > summary');
    const range = heading.locator('.conversation-read-range');
    await expect(range).toHaveText('· 3–4');
    const geometry = await range.evaluate((element) => {
      const range = element.getBoundingClientRect();
      const preview = element.parentElement!.getBoundingClientRect();
      return { left: range.left, right: range.right, start: preview.left, end: preview.right };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.start);
    expect(geometry.right).toBeLessThanOrEqual(geometry.end + 1);
    const pathBox = heading.locator('.conversation-read-path');
    await expect(pathBox).toHaveText(path);
    expect((await pathBox.boundingBox())!.width).toBeGreaterThan(32);
    expect(await pathBox.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
      true
    );
    const height = (await heading.boundingBox())!.height;
    await heading.click();
    await expect(read.locator('.conversation-detail-text')).toHaveText(
      '  first file\r\nsecond line\r\n'
    );
    expect((await heading.boundingBox())!.height).toBe(height);
    await heading.click();
    await expect(read.locator('.conversation-detail-text')).toHaveCount(0);
  });
}

for (const truncation of ['HEAD', 'SOURCE']) {
  test(`places the ${truncation} notice beside associated READ content`, async ({ page }) => {
    await page.goto(
      `${fixture.url}conversation-tool-detail.html?timeline&unified&read-association&read-truncation=${truncation}`
    );
    const process = page.locator('.process-heading').first();
    if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
    const read = page.locator('[data-tool-presentation="READ"]');
    await read.locator('> summary').click();
    await read.locator('.conversation-tool-detail > summary').click();
    const text = await read.locator('.conversation-detail-text').textContent();
    expect(text?.match(/\[Truncated\]/gu)).toHaveLength(1);
    if (truncation === 'HEAD') expect(text).toMatch(/^\[Truncated\][\s\S]+second line\s*$/u);
    else expect(text).toMatch(/^  first file[\s\S]+\[Truncated\]$/u);
  });
}

test('READ replaces body and association together, then falls back when a snapshot has none', async ({
  page
}) => {
  await page.goto(
    `${fixture.url}conversation-tool-detail.html?timeline&unified&updates&read-association`
  );
  const process = page.locator('.process-heading').first();
  if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
  const read = page.locator('[data-tool-presentation="READ"]');
  await read.locator('> summary').click();
  await read.locator('.conversation-tool-detail > summary').click();
  const detail = read.locator('.conversation-detail-text');
  await expect(detail).toContainText('first file');
  await page.getByTestId('stream-details').click();
  await expect.poll(() => detail.textContent()).toContain('  live output\n\n  next line\n');
  await expect(detail).not.toContainText('first file');
  await page.getByTestId('finish-details').click();
  await expect.poll(() => detail.textContent()).toContain('  authoritative tail\n');
  await expect(detail).not.toContainText('live output');
  await page.getByTestId('clear-read-association').click();
  await expect(detail).toContainText('unassociated replacement');
  await expect(detail).not.toContainText('authoritative tail');
});

for (const [width, theme] of [
  [1280, 'daylight'],
  [390, 'dark']
] as const) {
  test(`web details keep source hierarchy, safe links and shared preview at ${width}px in ${theme}`, async ({
    browser
  }, testInfo) => {
    const context = await browser.newContext({
      viewport: { width, height: 1100 },
      reducedMotion: 'reduce',
      permissions: ['clipboard-read', 'clipboard-write']
    });
    try {
      const page = await context.newPage();
      await page.goto(
        `${fixture.url}conversation-tool-detail.html?timeline&unified&web-layout&theme=${theme}`
      );
      const process = page.locator('.process-heading').first();
      if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
      const search = page.locator('[data-tool-presentation="WEB_SEARCH"]');
      const fetch = page.locator('[data-tool-presentation="WEB_FETCH"]');
      await search.locator('> summary').click();
      await fetch.locator('> summary').click();
      await expect(search.locator('.web-query')).toHaveText('Documentation and release notes');
      await expect(search.locator('.web-output')).toHaveCount(0);
      await expect(search.locator('.tool-detail')).not.toContainText('copy-only input');
      await expect(search.locator('.detail-preview-toggle')).toBeVisible();
      await expect(search.locator('.detail-preview-toggle')).toHaveAttribute(
        'aria-expanded',
        'false'
      );
      await expect(fetch.locator('.web-page-origin')).toContainText(
        'From: https://example.com/old'
      );
      await expect(fetch.locator('.web-page-url a')).toHaveAttribute(
        'href',
        'https://example.com/docs'
      );
      await expect(fetch.locator('.web-output')).toContainText('Returned page paragraph 1.');
      await page.screenshot({
        path: testInfo.outputPath(`web-details-${width}-${theme}.png`),
        fullPage: true
      });
      await search.locator('.detail-preview-toggle').click();
      await expect(search.locator('.conversation-tool-sources li')).toHaveCount(8);
      await expect(search.locator('a[href^="javascript:"]')).toHaveCount(0);
      await expect(search.locator('.conversation-tool-sources script')).toHaveCount(0);
      await expect(search.locator('.conversation-tool-sources')).toContainText('<unsafe title>');
      await expect(search.locator('.conversation-tool-sources')).toContainText(
        '<script>plain text only</script>'
      );
      await expect(search.locator('.conversation-tool-sources a').first()).toHaveAttribute(
        'rel',
        'noopener noreferrer'
      );
      await expect(search.locator('.conversation-tool-source-host').first()).toHaveCSS(
        'font-size',
        '12px'
      );
      await expect(search.locator('.web-detail')).toHaveCSS('font-weight', '400');
      await fetch.locator('.detail-preview-toggle').click();
      await expect(fetch.locator('.web-output')).toContainText('Returned page paragraph 30.');
      await expect(fetch.locator('.web-detail')).toContainText('[Truncated]');
      await search.locator('.tool-detail-copy').click();
      await expect(page.getByTestId('copied')).toContainText('copy-only input');
      const copied = JSON.parse((await page.getByTestId('copied').textContent())!);
      expect(copied.payload.inputSummary).toContain('copy-only input');
      expect(copied.payload.outputSummary).toContain('Redundant source output');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
      await search.locator('> summary').click();
      await expect(search.locator('.web-detail')).toHaveCount(0);
      await search.locator('> summary').click();
      await expect(search.locator('.detail-preview-toggle')).toHaveAttribute(
        'aria-expanded',
        'false'
      );
    } finally {
      await context.close();
    }
  });
}

for (const width of [1280, 390]) {
  test(`detail-only native web tools keep their ordinary group at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${fixture.url}conversation-tool-detail.html?timeline&unified&external-web`);
    const process = page.locator('.process-heading').first();
    if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
    const groups = page.locator('details.conversation-record-group:not([data-tool-presentation])');
    for (const group of await groups.all()) await group.locator('> summary').click();
    for (const [name, text] of [
      ['WebSearch', 'Native documentation query'],
      ['WebFetch', 'https://example.com/native-page']
    ] as const) {
      const row = groups.locator('details.conversation-tool-detail').filter({ hasText: name });
      await expect(row).toHaveCount(1);
      await expect(row.locator('.web-detail')).toHaveCount(0);
      await row.locator('> summary').click();
      await expect(row.locator('.web-detail')).toContainText(text);
      if (name === 'WebSearch') {
        await expect(row.locator('.web-output')).toHaveCount(0);
        await expect(row.locator('.web-detail')).not.toContainText('Native public output');
      } else await expect(row.locator('.web-detail')).toContainText('Native public output');
      await expect(row.locator('.web-detail')).not.toContainText('copy-only native input');
      await expect(row.locator('.conversation-tool-sources')).toHaveCount(0);
      await row.locator('> summary').click();
      await expect(row.locator('.web-detail')).toHaveCount(0);
    }
    await expect(page.locator('[data-tool-presentation="WEB_SEARCH"]')).toHaveCount(1);
    await expect(page.locator('[data-tool-presentation="WEB_FETCH"]')).toHaveCount(1);
  });
}

test('renders image, search and compact details within the ordinary tool group', async ({
  page
}) => {
  await page.goto(`${fixture.url}conversation-tool-detail.html?timeline&unified&specialized`);
  const process = page.locator('.process-heading').first();
  if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
  const groups = page.locator('details.conversation-record-group:not([data-tool-presentation])');
  for (const group of await groups.all()) await group.locator('> summary').click();
  for (const [name, expected] of [
    ['view_image', '/fixture/image.png'],
    ['tool_search', 'mcp__example'],
    ['smart_compact', 'Compaction request accepted']
  ] as const) {
    const row = page.locator('details.conversation-tool-detail').filter({ hasText: name }).first();
    await row.locator(':scope > summary').click();
    await expect(row.locator('.conversation-detail-text')).toContainText(expected);
    await expect(row.locator('.tool-detail')).toHaveClass(/conversation-detail-body/);
  }
});

for (const [width, theme] of [
  [1280, 'daylight'],
  [390, 'dark']
] as const) {
  test(`captures specialized details at ${width}px in ${theme}`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      reducedMotion: 'reduce'
    });
    try {
      const page = await context.newPage();
      await page.goto(
        `${fixture.url}conversation-tool-detail.html?timeline&unified&specialized&read-association&long&theme=${theme}`
      );
      const process = page.locator('.process-heading').first();
      if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
      const read = page.locator('[data-tool-presentation="READ"]');
      await read.locator('> summary').click();
      await read.locator('.conversation-tool-detail > summary').click();
      await page.locator('[data-tool-presentation="WEB_SEARCH"] > summary').click();
      for (const group of await page
        .locator('details.conversation-record-group:not([data-tool-presentation])')
        .all())
        await group.locator('> summary').click();
      for (const name of ['view_image', 'tool_search', 'smart_compact']) {
        const detail = page
          .locator('details.conversation-tool-detail')
          .filter({ hasText: name })
          .first();
        await detail.locator('> summary').click();
        await expect(detail.locator('.tool-detail')).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
      await page.screenshot({
        path: testInfo.outputPath(`specialized-${theme}-${width}.png`),
        fullPage: true
      });
    } finally {
      await context.close();
    }
  });
}

test('specialized tool details replace live output with the authoritative result', async ({
  page
}) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`${fixture.url}conversation-tool-detail.html?timeline=1&unified=1&updates=1`);
  const process = page.locator('.process-heading').first();
  if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
  const read = page.locator('[data-tool-presentation="READ"]');
  await read.locator(':scope > summary').click();
  await read.locator('.conversation-tool-detail > summary').click();
  for (const kind of ['WEB_SEARCH', 'WEB_FETCH'])
    await page.locator(`[data-tool-presentation="${kind}"] > summary`).click();
  const child = page.locator('.subagent-group');
  await child.locator('.conversation-record-group > summary').click();
  await child.locator('.conversation-tool-detail > summary').click();
  const bodies = [
    read.locator('.conversation-detail-text'),
    child.locator('.conversation-detail-text')
  ];
  const webRegions = ['WEB_SEARCH', 'WEB_FETCH'].map((kind) => ({
    kind,
    region: page.locator(`[data-tool-presentation="${kind}"] .web-detail`)
  }));
  await page.getByTestId('stream-details').click();
  for (const [index, body] of bodies.entries()) {
    await expect
      .poll(() => body.textContent(), { message: `live detail ${index}` })
      .toContain(':\n  live output\n\n  next line\n');
    await expect(body).not.toContainText('Truncated');
  }
  for (const { kind, region } of webRegions) {
    if (kind === 'WEB_SEARCH') {
      await expect(region.locator('.web-output')).toHaveCount(0);
      await expect(region).not.toContainText('live output');
    } else
      await expect
        .poll(() => region.locator('.web-output .conversation-detail-text').textContent())
        .toBe('  live output\n\n  next line\n');
    await expect(region).not.toContainText('[Truncated]');
  }
  await page.getByTestId('finish-details').click();
  for (const body of bodies) {
    await expect.poll(() => body.textContent()).toContain(':\n  authoritative tail\n\n[Truncated]');
    await expect(body).not.toContainText('live output');
    await expect(body).not.toContainText('export const result');
    await expect(body).not.toContainText('The requested page content.');
    await expect(body).not.toContainText('Message delivered.');
  }
  for (const { kind, region } of webRegions) {
    if (kind === 'WEB_SEARCH') {
      await expect(region.locator('.web-output')).toHaveCount(0);
      await expect(region).not.toContainText('authoritative tail');
      await expect(region).toContainText('[Truncated]');
    } else {
      await expect
        .poll(() => region.locator('.web-output .conversation-detail-text').textContent())
        .toBe('  authoritative tail\n');
      const text = await region.textContent();
      expect(text!.indexOf('[Truncated]')).toBeGreaterThan(text!.indexOf('authoritative tail'));
    }
    await expect(region).not.toContainText('live output');
    await expect(region).not.toContainText('Relevant documentation found.');
    await expect(region).not.toContainText('The requested page content.');
  }
  await expect(page.locator('.conversation-tool-sources a')).toHaveAttribute(
    'href',
    'https://example.com/docs'
  );
  await page.locator('[data-tool-presentation="WEB_SEARCH"] .tool-detail-copy').click();
  await expect(page.getByTestId('copied')).toContainText('authoritative tail');
  const copied = JSON.parse((await page.getByTestId('copied').textContent())!);
  expect(copied.payload.output).toMatchObject({
    blocks: [{ channel: 'TEXT', text: '  authoritative tail\n' }],
    truncation: 'SOURCE'
  });
});

test('places the HEAD marker before authoritative output without repeating it at the end', async ({
  page
}) => {
  await page.goto(`${fixture.url}conversation-tool-detail.html?head`);
  const exec = page.getByTestId('exec');
  await exec.locator('summary').click();
  await page.getByTestId('finish').click();
  const pre = exec.locator('.tool-output-text');
  await expect(pre).toHaveText(/^\[Truncated\]\nx+TAIL$/);
  await expect(exec.locator('.tool-exit')).toHaveText('Exit 0');
  await expect(pre).not.toContainText('TAIL\n[Truncated]');
  await expect(pre).not.toContainText('visible stdout');
});

for (const width of [1280, 390]) {
  test(`execution details, copy and terminal replacement at ${width}px`, async ({
    browser
  }, testInfo) => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      permissions: ['clipboard-read', 'clipboard-write']
    });
    try {
      const page = await context.newPage();
      await page.goto(`${fixture.url}conversation-tool-detail.html`);
      const exec = page.getByTestId('exec');
      await exec.locator('summary').click();
      await expect(exec.locator('.tool-detail-heading')).toHaveText('exec');
      await expect(exec.locator('.tool-source-text')).toHaveText('Command: printf test');
      await expect(exec.locator('.execution-detail')).toContainText('Working directory: /fixture');
      await expect(exec).toContainText('visible stdout');
      await expect(exec).toContainText('visible stderr');
      await expect(exec).not.toContainText('combined should not replace streams');
      const copyButton = exec.getByRole('button', { name: 'Copy public record' });
      await expect(copyButton).toHaveText('');
      await expect(exec).not.toContainText('may be truncated');
      for (const pre of await exec.locator('pre').all()) {
        await expect(pre).toHaveCSS('border-top-width', '0px');
        await expect(pre).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(pre).toHaveCSS('max-height', 'none');
      }
      const detailBox = await exec.locator('.tool-detail').boundingBox();
      const copyBox = await copyButton.boundingBox();
      expect(
        Math.abs(copyBox!.x + copyBox!.width + 8 - detailBox!.x - detailBox!.width)
      ).toBeLessThan(2);
      expect(copyBox!.y - detailBox!.y).toBeLessThan(12);

      await exec.getByRole('button', { name: 'Copy public record' }).click();
      await expect(page.getByTestId('copied')).toContainText('exec-a');
      const copied = JSON.parse((await page.getByTestId('copied').textContent()) ?? '{}');
      expect(copied.id).toBe('exec-a');
      expect(copied.payload.command).toBe('printf test');
      await expect(exec.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
      await page.getByTestId('empty').locator('summary').click();
      await expect(page.getByTestId('empty').locator('.execution-output')).toHaveCount(0);
      await expect(page.getByTestId('empty')).not.toContainText('No output');
      await expect(page.getByTestId('empty')).not.toContainText('stderr');
      await page.getByTestId('generic').locator('summary').click();
      await expect(page.getByTestId('generic').locator('pre')).toHaveText(
        'Details: Inspect fixture\nInput: Preserved input\nOutput:\nPartial inspection output\n[Truncated]\nProgress: Stopped at the last file\nError: INSPECTION_FAILED'
      );
      await page.getByTestId('wait').locator('summary').click();
      await expect(page.getByTestId('wait')).toContainText('Wait failed');
      await expect(page.getByTestId('wait').locator('.tool-detail-heading')).toHaveText(
        'exec_wait · Poll'
      );
      await expect(page.getByTestId('wait').locator('.tool-source-text')).toHaveText(
        'Command: pnpm test --filter fixture'
      );
      await page.getByTestId('declined').locator('summary').click();
      await expect(page.getByTestId('declined')).toContainText('Declined');
      await expect(page.getByTestId('declined')).not.toContainText(
        'toolPresentation.detail.DECLINED'
      );
      await page.getByTestId('finish').click();
      await expect(exec).toContainText('TAIL');
      await expect(exec).toContainText('[Truncated]');
      await expect(exec.locator('.execution-detail')).toHaveText(/\[Truncated\]\s+Exit 0$/, {
        useInnerText: true
      });
      await expect(exec).not.toContainText('visible stdout');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
      await page.screenshot({
        path: testInfo.outputPath(`execution-${width}.png`),
        fullPage: true
      });
      await page.getByTestId('fail-copy').click();
      await exec.getByRole('button', { name: 'Copy public record' }).click();
      await expect(page.getByTestId('copy-error')).toHaveText('true');
    } finally {
      await context.close();
    }
  });
}

for (const width of [1280, 390]) {
  for (const theme of ['daylight', 'dark']) {
    test(`tool details blend into the timeline at ${width}px in ${theme}`, async ({
      browser
    }, testInfo) => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        const page = await context.newPage();
        await page.goto(
          `${fixture.url}conversation-tool-detail.html?timeline=1&long=1&unified=1&theme=${theme}`
        );
        const process = page.locator('.process-heading').first();
        if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
        const group = page.locator('.conversation-record-group').filter({ hasText: 'Command' });
        await group.locator(':scope > summary').click();
        const command = page.locator('.conversation-command-detail');
        await command.locator(':scope > summary').click();
        const detail = command.locator('.tool-detail');
        await expect(detail).toContainText('visible stdout');
        await expect(detail).toContainText('visible stderr');
        await expect(detail.locator('.tool-source-text')).toHaveCount(1);
        await expect(detail.locator('.execution-output')).toHaveCount(2);
        await expect(detail.locator('strong, dl, dt, dd')).toHaveCount(0);
        await expect(detail.locator('.tool-source-text')).toContainText(
          'Code: observe.result(await tools.exec('
        );
        await expect(detail.locator('.execution-output > .tool-detail-meta')).toHaveText([
          'Output:',
          'stderr:'
        ]);
        await expect(detail.locator('.tool-output-text')).toHaveText([
          'visible stdout',
          'visible stderr'
        ]);
        await expect(detail).not.toContainText('Working directory:');
        await expect(detail).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        const expand = detail.getByRole('button', { name: 'Show more', exact: true });
        if (await expand.isVisible()) await expand.click();
        const textBounds = await detail.locator('.tool-source-text').boundingBox();
        const titleBounds = await command.locator('.conversation-command-preview').boundingBox();
        expect(Math.abs(textBounds!.x - titleBounds!.x)).toBeLessThan(3);
        await expect(detail.locator('.tool-source-text')).toHaveCSS('font-weight', '400');

        await expectUnclippedDetail(detail.locator('.execution-detail'));

        const button = detail.getByRole('button', { name: 'Copy public record' });
        await expect(button).toHaveText('');
        const bounds = await detail.boundingBox();
        const copyBounds = await button.boundingBox();
        expect(
          Math.abs(copyBounds!.x + copyBounds!.width + 8 - bounds!.x - bounds!.width)
        ).toBeLessThan(2);
        for (const pre of await detail.locator('pre').all()) {
          await expect(pre).toHaveCSS('border-top-width', '0px');
          await expect(pre).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
          await expect(pre).toHaveCSS('overflow-y', 'visible');
          await expect(pre).toHaveCSS('overflow-x', 'visible');
          await expect(pre).toHaveCSS('max-height', 'none');
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true
        );
        const reasoning = page.locator('.reasoning-group');
        await reasoning.locator('summary').click();
        const thinking = reasoning.locator('.conversation-detail-text');
        const thinkingBounds = await thinking.boundingBox();
        const reasoningTitleBounds = await reasoning.locator('summary strong').boundingBox();
        expect(Math.abs(thinkingBounds!.x - reasoningTitleBounds!.x)).toBeLessThan(3);
        const thinkingStyle = await thinking.evaluate((element) => ({
          fontSize: getComputedStyle(element).fontSize,
          lineHeight: getComputedStyle(element).lineHeight,
          color: getComputedStyle(element).color,
          expectedColor: getComputedStyle(element.closest('.conversation-item')!).color,
          background: getComputedStyle(element.closest('.conversation-detail-body')!)
            .backgroundColor
        }));
        expect(thinkingStyle.fontSize).toBe('12px');
        expect(thinkingStyle.color).toBe(thinkingStyle.expectedColor);
        const read = page.locator('[data-tool-presentation="READ"]');
        await read.locator(':scope > summary').click();
        await read.locator('.conversation-tool-detail > summary').click();
        for (const kind of ['WEB_SEARCH', 'WEB_FETCH'])
          await page.locator(`[data-tool-presentation="${kind}"] > summary`).click();
        await expect(
          page.locator('.conversation-tool-sources .conversation-detail-text')
        ).toHaveCSS('font-size', thinkingStyle.fontSize);
        await expect(page.locator('.conversation-tool-sources a')).toHaveCSS(
          'font-size',
          thinkingStyle.fontSize
        );
        const subagent = page.locator('.subagent-group');
        await subagent.locator('.conversation-record-group > summary').click();
        await subagent.locator('.conversation-tool-detail > summary').click();
        const generic = page.locator('.tool-group:not(:has([data-tool-presentation="READ"]))');
        await generic.locator('.conversation-record-group > summary').click();
        await generic.locator('.conversation-tool-detail > summary').click();
        await expect(generic.locator('.conversation-detail-text')).toHaveText(
          'Details: Inspect fixture\nInput: Preserved input\nOutput:\nPartial inspection output\n[Truncated]\nProgress: Stopped at the last file\nError: INSPECTION_FAILED'
        );
        const surfaces = page.locator('.conversation-detail-body');
        const search = page.locator('[data-tool-presentation="WEB_SEARCH"]');
        await expect(search.locator('.web-detail')).toBeVisible();
        await expect(search.locator('.web-output')).toHaveCount(0);
        await expect(search.locator('.conversation-detail-body')).toHaveCount(1);
        await expect(surfaces).toHaveCount(7);
        for (const surface of await surfaces.all()) {
          const spacing = await surface.evaluate((element) => {
            const text = element.querySelector('.conversation-detail-text')!;
            const heading = element.parentElement!.querySelector(':scope > summary')!;
            const title = heading.querySelector(
              ':scope > strong, :scope > span:not(.mar-disclosure-icon):not(.conversation-record-icon)'
            )!;
            return {
              inset: text.getBoundingClientRect().left - element.getBoundingClientRect().left,
              expectedInset: parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.75,
              titleOffset: text.getBoundingClientRect().left - title.getBoundingClientRect().left
            };
          });
          expect(Math.abs(spacing.inset - spacing.expectedInset)).toBeLessThan(1);
          expect(Math.abs(spacing.titleOffset)).toBeLessThan(3);
          await expect(surface).toHaveCSS('background-color', thinkingStyle.background);
          const radius = await surface.evaluate((element) =>
            getComputedStyle(element).getPropertyValue('--mar-radius-surface').trim()
          );
          await expect(surface).toHaveCSS('border-radius', radius);
          const contents = surface.locator('.conversation-detail-text');
          expect(await contents.count()).toBeGreaterThan(0);
          for (const content of await contents.all()) {
            await expect(content).toHaveCSS('font-size', thinkingStyle.fontSize);
            await expect(content).toHaveCSS('line-height', thinkingStyle.lineHeight);
          }
          await expect(surface).toHaveCSS('overflow-y', 'visible');
        }
        await expect(page.locator('.conversation-tool-sources a')).toHaveAttribute(
          'href',
          'https://example.com/docs'
        );
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true
        );
        await page.setViewportSize({ width, height: 1600 });
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
        await page.screenshot({
          path: testInfo.outputPath(`timeline-${theme}-${width}.png`),
          fullPage: true
        });
      } finally {
        await context.close();
      }
    });
  }
}
