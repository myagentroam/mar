import { expect, test, type Page } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const width of [1280, 390]) {
  test(`Cached conversation restoration follows layout changes and preserves manual reading at ${width}px`, async ({
    browser
  }) => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      isMobile: width < 768,
      hasTouch: width < 768
    });
    try {
      const page = await context.newPage();
      await page.goto(`${fixture.url}conversation-style.html?cached-scroll=1`);
      const region = page.locator('.conversation-scroll');
      await page.getByTestId('restore-cache').click();
      await expect(page.getByTestId('positioning')).toHaveText('false');
      await expect(page.getByTestId('loading')).toHaveText('true');
      await expect(page.getByTestId('following')).toHaveText('true');
      await expect
        .poll(() => region.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
        .toBeLessThan(2);
      await expect(page.getByText('Latest cached message')).toBeInViewport();
      await expect(page.getByTestId('older-requests')).toHaveText('0');

      await region.hover();
      await page.mouse.wheel(0, -300);
      await expect(page.getByTestId('following')).toHaveText('false');
      const readingTop = await region.evaluate((el) => el.scrollTop);
      await page.getByTestId('grow-content').click();
      await page.getByTestId('finish-watch').click();
      await expect(page.getByTestId('opened')).toHaveText('true');
      await expect(page.getByTestId('loading')).toHaveText('false');
      await expect(page.getByTestId('following')).toHaveText('false');
      expect(await region.evaluate((el) => el.scrollTop)).toBe(readingTop);
      await page.getByRole('button', { name: 'Jump to latest' }).click();
      await expect(page.getByTestId('following')).toHaveText('true');
      await expect
        .poll(() => region.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
        .toBeLessThan(2);
    } finally {
      await context.close();
    }
  });
}

test('Conversation padding clicks and drags preserve bottom following', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(`${fixture.url}conversation-style.html?cached-scroll=1`);
    const region = page.locator('.conversation-scroll');
    await page.getByTestId('restore-cache').click();
    await expect(page.getByTestId('positioning')).toHaveText('false');
    await expect(page.getByTestId('following')).toHaveText('true');
    await region.click({ position: { x: 2, y: 100 } });
    await expect(page.getByTestId('following')).toHaveText('true');
    const bounds = (await region.boundingBox())!;
    await page.mouse.move(bounds.x + 2, bounds.y + 200);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 2, bounds.y + 100, { steps: 4 });
    await page.mouse.up();
    await expect(page.getByTestId('following')).toHaveText('true');
    await page.getByTestId('grow-content').click();
    await expect
      .poll(() => region.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
      .toBeLessThan(2);
  } finally {
    await context.close();
  }
});

for (const { width, input, phase } of [
  { width: 1280, input: 'wheel', phase: 'before' },
  { width: 1280, input: 'wheel', phase: 'during' },
  { width: 390, input: 'touch', phase: 'before' },
  { width: 390, input: 'touch', phase: 'during' },
  { width: 1280, input: 'keyboard', phase: 'during' },
  { width: 1280, input: 'pointer', phase: 'during' },
  { width: 1280, input: 'overlay', phase: 'during' }
]) {
  test(`Cached calibration respects ${input} reading intent ${phase} positioning`, async ({
    browser
  }) => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      isMobile: width < 768,
      hasTouch: width < 768
    });
    try {
      const page = await context.newPage();
      await page.goto(
        `${fixture.url}conversation-style.html?cached-scroll=1&interrupt=${phase}&input=${input}`
      );
      const region = page.locator('.conversation-scroll');
      await page.getByTestId('restore-cache').click();
      await expect(page.getByTestId('guarded-interruption')).toHaveText('true');
      await expect(page.getByTestId('positioning')).toHaveText('false');
      await expect(page.getByTestId('following')).toHaveText('false');
      await page.getByTestId('finish-watch').click();
      await expect(page.getByTestId('opened')).toHaveText('true');
      await expect.poll(() => region.evaluate((el) => el.scrollTop)).toBe(500);
      await page.getByTestId('grow-content').click();
      await expect(page.getByTestId('following')).toHaveText('false');
      expect(await region.evaluate((el) => el.scrollTop)).toBe(500);
      await page.getByRole('button', { name: 'Jump to latest' }).click();
      await expect(page.getByTestId('following')).toHaveText('true');
      await expect
        .poll(() => region.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
        .toBeLessThan(2);
    } finally {
      await context.close();
    }
  });
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Read groups expand individual files lazily and preserve raw call details in ${theme}`, async ({
    browser
  }, testInfo) => {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        isMobile: width < 768,
        hasTouch: width < 768
      });
      try {
        const page = await context.newPage();
        await page.goto(`${fixture.url}conversation-style.html?theme=${theme}&read-files=1`);
        await page.locator('.conversation-timeline .process-heading').click();
        const group = page.locator('[data-tool-presentation="READ"].conversation-record-group');
        const heading = group.locator(':scope > summary');
        const rows = group.locator(':scope > details');
        await expect(heading).toContainText('5 files');
        await expect(heading).not.toContainText('calls');
        await expect(rows).toHaveCount(0);
        await heading.click();
        await expect(rows).toHaveCount(6);
        const paths = await rows.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute('data-read-path'))
        );
        expect(paths.slice(0, 3)).toEqual(['src/a.ts', 'test/a.ts', 'C:\\src\\b.ts']);
        expect(paths[3]).toContain('long-file-name-');
        expect(paths.slice(4)).toEqual(['src/a.ts', null]);
        await expect(group.locator('.conversation-record-detail')).toHaveCount(0);
        await expect(group).not.toContainText('more files');
        const first = rows.nth(0);
        await first.locator(':scope > summary').click();
        await expect(first.locator('p')).toContainText('Original batch ranges: offset 2, limit 8');
        await expect(first.locator('p')).toContainText('Original batch output');
        await expect(rows.nth(1).locator('p')).toHaveCount(0);
        await rows.nth(1).locator(':scope > summary').click();
        await expect(rows.nth(1).locator('p')).toContainText('Original batch output');
        await rows.nth(1).locator(':scope > summary').click();
        await expect(rows.nth(1).locator('p')).toHaveCount(0);
        await expect(rows.nth(4).locator(':scope > summary')).toContainText('Failed');
        await rows.nth(5).locator(':scope > summary').click();
        await expect(rows.nth(5).locator('p')).toContainText('Original pathless read failure');
        await page.getByTestId('append-read-file').click();
        await expect(heading).toContainText('6 files');
        await expect(rows).toHaveCount(7);
        await expect(first).toHaveAttribute('open', '');
        await expect(first.locator('p')).toContainText('Original batch output');
        await page.getByTestId('read-files-chinese').click();
        await expect(heading).toContainText('读取文件');
        await expect(heading).toContainText('6 个文件');
        await expect(first.locator(':scope > summary')).toContainText('src/a.ts');
        const layout = await rows
          .nth(3)
          .locator(':scope > summary')
          .evaluate((element) => {
            const title = element.querySelector('.conversation-tool-preview')!;
            const status = element.querySelector('.conversation-record-meta')!;
            return {
              titleRight: title.getBoundingClientRect().right,
              statusLeft: status.getBoundingClientRect().left,
              scrollWidth: document.documentElement.scrollWidth,
              width: innerWidth
            };
          });
        expect(layout.titleRight).toBeLessThanOrEqual(layout.statusLeft + 1);
        expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
        await heading.click();
        await expect(rows).toHaveCount(0);
        await heading.click();
        await expect(first.locator('p')).toContainText('Original batch output');
        await expect(first.locator('p')).toBeVisible();
        await expect
          .poll(() =>
            group.evaluate(
              (element) =>
                element
                  .getAnimations({ subtree: true })
                  .filter((animation) => animation.playState === 'running').length
            )
          )
          .toBe(0);
        await group.screenshot({ path: testInfo.outputPath(`read-files-${width}.png`) });
      } finally {
        await context.close();
      }
    }
  });
}

test('Process headings reveal content without a redundant status tooltip', async ({ page }) => {
  await page.goto(`${fixture.url}conversation-style.html?reasoning-preview=1`);
  const process = page.locator('[data-process-id="preview-process"]');
  const heading = process.locator('.process-heading');
  await expect(heading).toHaveAttribute('aria-expanded', 'true');
  await page.clock.install();
  await heading.hover();
  await page.clock.runFor(500);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(heading).not.toHaveAttribute('aria-describedby');
  await heading.click();
  await expect(heading).toHaveAttribute('aria-expanded', 'false');
  await heading.click();
  await expect(heading).toHaveAttribute('aria-expanded', 'true');
  const reasoning = process.locator('.reasoning-group').first();
  await reasoning.locator('summary').click();
  await expect(reasoning.locator('p')).toContainText('Full thinking detail');
});

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Jump to latest uses neutral floating feedback in ${theme}`, async ({
    browser
  }, testInfo) => {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        isMobile: width < 768,
        hasTouch: width < 768
      });
      try {
        const page = await context.newPage();
        await page.goto(`${fixture.url}visual-alignment.html?session-performance=1&theme=${theme}`);
        await page.getByTestId('leave-latest').click();
        const latest = page.getByRole('button', { name: 'Jump to latest' });
        await expect(latest).toBeVisible();
        await latest.scrollIntoViewIfNeeded();
        const tokens = await latest.evaluate((element) => {
          const probe = document.createElement('span');
          element.append(probe);
          const color = (token: string) => {
            probe.style.color = `var(${token})`;
            return getComputedStyle(probe).color;
          };
          const result = {
            text: color('--mar-text-secondary'),
            activeText: color('--mar-text-primary'),
            background: color('--mar-control-bg-color-overlay'),
            hover: color('--mar-fill-row-hover'),
            pressed: color('--mar-fill-selection'),
            border: color('--mar-border-default'),
            focus: color('--mar-color-brand')
          };
          probe.remove();
          return result;
        });
        await page.mouse.move(0, 0);
        await expect(latest).toHaveCSS('color', tokens.text);
        await expect(latest).toHaveCSS('background-color', tokens.background);
        await expect(latest).toHaveCSS('border-top-color', tokens.border);
        await page.locator('.conversation-scroll-region').screenshot({
          path: testInfo.outputPath(`latest-normal-${width}.png`)
        });
        await latest.hover();
        await expect(latest).toHaveCSS('color', tokens.activeText);
        await expect(latest).toHaveCSS('background-color', tokens.hover);
        await page.locator('.conversation-scroll-region').screenshot({
          path: testInfo.outputPath(`latest-hover-${width}.png`)
        });
        await page.mouse.move(0, 0);
        await latest.focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        await expect(latest).toBeFocused();
        await expect(latest).toHaveCSS('outline-style', 'solid');
        await expect(latest).toHaveCSS('outline-color', tokens.focus);
        await page.locator('.conversation-scroll-region').screenshot({
          path: testInfo.outputPath(`latest-focus-${width}.png`)
        });
        await latest.hover();
        await page.mouse.down();
        await expect(latest).toHaveCSS('background-color', tokens.pressed);
        await page.mouse.up();
        await expect(latest).toHaveCount(0);
      } finally {
        await context.close();
      }
    }
  });

  test(`Reasoning previews share normalized content and native ellipsis in ${theme}`, async ({
    page
  }, testInfo) => {
    const thinkingPreview = `Inspecting ../workspace ${'workspace '.repeat(20)}https://example.com/search?q=one,two&next=2 changes`;
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${fixture.url}conversation-style.html?theme=${theme}&reasoning-preview=1`);
      const process = page.locator('[data-process-id="preview-process"]');
      const preview = process.locator('.process-summary');
      const heading = process.locator('.process-heading');
      await expect(preview).toHaveText(thinkingPreview);
      await expect(heading).toHaveAttribute('aria-expanded', 'true');
      await heading.click();
      await expect(heading).toHaveAttribute('aria-expanded', 'false');
      await expect(preview).toHaveText(thinkingPreview);
      await heading.click();
      const thinking = process.locator('.reasoning-group').first();
      const subtitle = thinking.locator('.reasoning-subtitle');
      await expect(subtitle).toHaveText(thinkingPreview);
      for (const element of [preview, subtitle]) {
        await expect(element).toHaveCSS('text-overflow', 'ellipsis');
        await expect(element).toHaveCSS('white-space', 'nowrap');
        expect(await element.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      }
      await page.screenshot({
        path: testInfo.outputPath(`reasoning-preview-${width}.png`),
        animations: 'disabled'
      });
      await thinking.locator('summary').click();
      await expect(thinking.locator('p')).toContainText('Full thinking detail');
      await expect(thinking.locator('p')).toContainText('Second thinking line');
      await expect(subtitle).toHaveCount(0);
      await thinking.locator('summary').click();
      await page.getByTestId('publish-reasoning-summary').click();
      await expect(preview).toHaveText('Public summary: inspect files');
      await expect(subtitle).toHaveText(thinkingPreview);
      const summary = process.locator('.reasoning-group').last();
      await expect(summary.locator('.reasoning-subtitle')).toHaveText(
        'Public summary: inspect files'
      );
      await summary.locator('summary').click();
      await expect(summary.locator('p')).toContainText('Full summary detail');
      await heading.click();
      await expect(heading).toHaveAttribute('aria-expanded', 'false');
      await expect(preview).toHaveText('Public summary: inspect files');
      await expect(process.locator('.reasoning-group')).toHaveCount(0);
      await heading.click();
      await page.getByTestId('finish-reasoning-process').click();
      await expect(heading).toHaveAttribute('aria-expanded', 'true');
      await expect(preview).toHaveCount(0);
      await expect(process.locator('.reasoning-subtitle').first()).toHaveText(thinkingPreview);
      await expect(page.getByText('Finished reviewing files.', { exact: true })).toBeVisible();
      await heading.click();
      await expect(heading).toHaveAttribute('aria-expanded', 'false');
      await expect(preview).toHaveCount(0);
      await heading.click();
      await expect(preview).toHaveCount(0);
      const completedSummary = process.locator('.reasoning-group').last();
      await completedSummary.locator('summary').click();
      await expect(completedSummary.locator('p')).toContainText('Full summary detail');
    }
  });
}

test('Initial layout and cached synchronization preserve complete process facts without mounting details', async ({
  browser
}, testInfo) => {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      isMobile: width < 768,
      hasTouch: width < 768
    });
    try {
      const page = await context.newPage();
      await page.goto(`${fixture.url}conversation-style.html?loading-lifecycle=1`);
      await page.clock.install();
      await page.clock.pauseAt(new Date());
      await page.getByTestId('load-lifecycle-history').click();
      const timeline = page.locator('.conversation-timeline');
      const process = page.locator('[data-process-id="loading-process-initial-session"]');
      await expect(timeline).toBeHidden();
      await expect(timeline).toHaveAttribute('inert', '');
      await expect(process.locator('.process-heading')).not.toContainText('Partial history');
      const duration = await process.locator('.process-duration').textContent();
      await page.clock.runFor(100);
      await expect(page.getByTestId('rendered-version')).toHaveText('1');
      await expect(timeline).toBeHidden();
      await page.getByTestId('finish-lifecycle-initial').click();
      await page.clock.runFor(1_500);
      await expect(timeline).toBeVisible();
      await expect(process.locator('.process-duration')).toHaveText(duration!);
      await expect(process.locator('.process-heading')).not.toContainText('Partial history');
      await expect(timeline.locator('.process-summary')).toHaveCount(0);
      await page.getByTestId('switch-cached-history').click();
      const cached = page.locator('[data-process-id="loading-process-cached-session"]');
      await expect(timeline).toBeVisible();
      await expect(cached.locator('.process-heading')).not.toContainText('Partial history');
      await expect(timeline.locator('.process-summary')).toHaveCount(0);
      await page.clock.runFor(1_500);
      await page.getByTestId('synchronize-history').click();
      await expect(cached.locator('.process-summary')).toHaveText('Current public progress');
      await expect(cached.locator('.command-group')).toHaveCount(1);
      await expect(cached.locator('.command-group > details > summary')).toContainText('64');
      await expect(cached.locator('.conversation-command-detail')).toHaveCount(0);
      expect(await timeline.locator('*').count()).toBeLessThan(160);
      await cached.screenshot({
        path: testInfo.outputPath(`cached-process-${width}.png`),
        animations: 'disabled'
      });
      await page.getByTestId('omit-process-start').click();
      await expect(cached.locator('.process-heading')).toContainText('Partial history');
    } finally {
      await context.close();
    }
  }
});

test('Cached session changes retain the progressive DOM budget', async ({ page }) => {
  await page.goto(`${fixture.url}conversation-style.html?reasoning-stress=1`);
  await page.getByTestId('load-stress-history').click();
  const processes = page.locator('[data-process-id^="stress-process-"]');
  await expect(processes).toHaveCount(80);
  const initialCount = await page.getByTestId('switch-stress-session').evaluate(async (button) => {
    (button as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    return document.querySelectorAll('[data-process-id^="stress-process-"]').length;
  });
  expect(initialCount).toBeGreaterThan(0);
  // Session changes must retain the 40-record first-frame cap rather than mount all 80.
  expect(initialCount).toBeLessThanOrEqual(40);
  await expect(processes).toHaveCount(80);
  await expect(page.locator('.reasoning-group')).toHaveCount(0);
  expect(await page.locator('.conversation-timeline *').count()).toBeLessThan(1_500);
  await page.getByTestId('toggle-cached-stress-timeline').click();
  await expect(processes).toHaveCount(0);
  await page.getByTestId('toggle-cached-stress-timeline').click();
  await expect(processes).toHaveCount(80);
  await expect(page.locator('.reasoning-group')).toHaveCount(0);
});

test('Long reasoning history stays responsive through progressive rendering and remounts', async ({
  page
}, testInfo) => {
  await page.goto(`${fixture.url}conversation-style.html?reasoning-stress=1`);
  await expect(page.getByTestId('load-stress-history')).toBeVisible();
  await page.evaluate(() => {
    const gaps: number[] = [];
    let previous = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      gaps.push(now - previous);
      previous = now;
    }, 10);
    Object.assign(window, { freezeProbe: { gaps, stop: () => clearInterval(timer) } });
  });
  const processes = page.locator('[data-process-id^="stress-process-"]');
  for (let iteration = 0; iteration < 3; iteration++) {
    await page.getByTestId('load-stress-history').click();
    await expect(processes).toHaveCount(80);
    const firstProcess = processes.first();
    await expect(page.locator('.process-summary')).toHaveCount(0);
    await expect(processes.first().locator('.process-heading')).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    await firstProcess.locator('.process-heading').click();
    const longPreview = firstProcess.locator('.reasoning-subtitle');
    await expect(longPreview).toHaveText(`${'.'.repeat(64 * 1024)}x`);
    await expect(firstProcess.locator('.process-summary')).toHaveCount(0);
    await page.getByTestId('toggle-stress-timeline').click();
    await expect(processes).toHaveCount(0);
    await page.getByTestId('toggle-stress-timeline').click();
    await expect(processes).toHaveCount(80);
  }
  const gaps = await page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const probe = (window as unknown as { freezeProbe: { gaps: number[]; stop(): void } })
      .freezeProbe;
    probe.stop();
    return probe.gaps;
  });
  await testInfo.attach('main-thread-gaps', {
    body: JSON.stringify(gaps),
    contentType: 'application/json'
  });
  await testInfo.attach('progressive-render-metrics', {
    body: JSON.stringify({
      maximumEventLoopGapMs: Math.max(...gaps),
      processCount: await processes.count(),
      timelineDomNodes: await page.locator('.conversation-timeline *').count(),
      mountedReasoningDetails: await page.locator('.reasoning-group').count()
    }),
    contentType: 'application/json'
  });
  expect(gaps.length).toBeGreaterThan(0);
  // Catch multi-second stalls with ample allowance for shared CI hosts.
  expect(Math.max(...gaps)).toBeLessThan(1000);
});

test('Touch conversation details reveal titles and unavailable change reasons', async ({
  browser
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  try {
    const page = await context.newPage();
    await page.goto(`${fixture.url}conversation-style.html?touch-details=1`);
    const hint = page.locator('[role="tooltip"]:visible');
    await page.locator('.conversation-header h2').tap();
    await expect(hint).toHaveText('Review session');
    await expect(page.locator('.conversation-header .session-activity')).toHaveCount(0);
    await page.getByText('File changes', { exact: true }).tap();
    await expect(page.locator('.conversation-file-change-note')).toBeVisible();
    // Reading starts after expansion; scrolling during the height animation dismisses hints.
    await expect
      .poll(() =>
        page
          .locator('.conversation-file-change-details')
          .evaluate(
            (details) =>
              details.getAnimations().filter((animation) => animation.playState === 'running')
                .length
          )
      )
      .toBe(0);
    await page.locator('.conversation-file-change-note').tap();
    await expect(hint).toHaveText('Line differences are unavailable for non-text files');
    await expect(hint).toHaveCount(1);
  } finally {
    await context.close();
  }
});

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Expanded command details expose the complete command in ${theme}`, async ({
    browser
  }, testInfo) => {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        isMobile: width < 768,
        hasTouch: width < 768
      });
      try {
        const page = await context.newPage();
        await page.goto(`${fixture.url}conversation-style.html?theme=${theme}&group-spacing=1`);
        await page.locator('[data-process-id="spacing-process"] > .process-heading').click();
        const group = page.locator('.conversation-item.command-group > details');
        await group.locator(':scope > summary').click();
        const command = group.locator(':scope > details').first();
        const heading = command.locator(':scope > summary');
        const preview = heading.locator('.conversation-command-preview');
        const fullCommand = await preview.textContent();
        expect(fullCommand).toContain('Full command tail');
        expect(await preview.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
          true
        );
        const headingHeight = await heading.evaluate(
          (element) => element.getBoundingClientRect().height
        );
        await expect(command.locator('.conversation-command-output')).toHaveCount(0);
        await heading.click();
        const detail = command.locator('.conversation-command-output');
        await expect(detail).toBeVisible();
        expect(await detail.textContent()).toContain(fullCommand);
        await expect(detail).toContainText('Review output');
        expect(
          await heading.evaluate((element) => element.getBoundingClientRect().height)
        ).toBeCloseTo(headingHeight, 1);
        expect(await detail.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true
        );
        await expect
          .poll(() =>
            detail.evaluate((element) => {
              const body = element.getBoundingClientRect();
              return ['.conversation-command-detail', '.conversation-record-group'].every(
                (selector) => {
                  const parent = element.closest(selector)!.getBoundingClientRect();
                  return body.top >= parent.top - 1 && body.bottom <= parent.bottom + 1;
                }
              );
            })
          )
          .toBe(true);
        await detail.evaluate((element) => element.scrollIntoView({ block: 'start' }));
        await detail.screenshot({ path: testInfo.outputPath(`full-command-${width}.png`) });
        await heading.click();
        await expect(detail).toHaveCount(0);
        const withoutOutput = group.locator(':scope > details').nth(1);
        await withoutOutput.locator(':scope > summary').click();
        await expect(withoutOutput.locator('.conversation-command-output')).toContainText(
          'echo review-1'
        );
      } finally {
        await context.close();
      }
    }
  });

  test(`Grouped conversation rows keep consistent compact spacing in ${theme}`, async ({
    page
  }, testInfo) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${fixture.url}conversation-style.html?theme=${theme}&group-spacing=1`);
      await page.locator('[data-process-id="spacing-process"] > .process-heading').click();
      const groups = page.locator('.conversation-record-group');
      await expect(groups).toHaveCount(3);
      for (const group of await groups.all()) {
        await group.locator(':scope > summary').click();
        await expect(group.locator(':scope > details')).toHaveCount(3);
        const spacing = await group.evaluate((element) => {
          const rows = Array.from(element.children).map((child) => child.getBoundingClientRect());
          return rows.slice(1).map((row, index) => row.top - rows[index]!.bottom);
        });
        for (const gap of spacing) {
          expect(gap).toBeGreaterThanOrEqual(0);
          expect(gap).toBeLessThanOrEqual(4);
          expect(gap).toBeCloseTo(spacing[0]!, 1);
        }
        const child = group.locator(':scope > details').first();
        await child.locator(':scope > summary').click();
        await expect(child.locator(':scope > p')).toBeVisible();
        await child.locator(':scope > summary').click();
        await expect(child.locator(':scope > p')).toHaveCount(0);
      }
      await page.locator('.conversation-timeline').screenshot({
        path: testInfo.outputPath(`group-spacing-${width}.png`)
      });
    }
  });

  test(`Conversation metadata, status and Composer remain readable in ${theme}`, async ({
    page
  }, testInfo) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${fixture.url}conversation-style.html?theme=${theme}`);
      const tokens = await page.locator('html').evaluate((root) => {
        const color = (token: string) => {
          const probe = document.createElement('span');
          probe.style.color = `var(${token})`;
          root.append(probe);
          const value = getComputedStyle(probe).color;
          probe.remove();
          return value;
        };
        return {
          text: color('--mar-conversation-text'),
          muted: color('--mar-conversation-muted'),
          primary: color('--mar-text-primary'),
          brand: color('--mar-color-brand-text'),
          canvas: color('--mar-conversation-canvas'),
          panel: color('--mar-bg-panel')
        };
      });
      await expect(page.locator('.process-activity.is-active')).toHaveCSS('color', tokens.text);
      await expect(page.locator('.process-activity.is-active')).toHaveCSS('font-weight', '600');
      const processIndicator = page.locator('.process-activity-indicator');
      await expect(processIndicator).toHaveCSS('color', tokens.brand);
      await expect(processIndicator).toHaveCSS('width', '10px');
      await expect(processIndicator).toHaveCSS('height', '10px');
      // Fractional borders snap to device pixels; keep the stroke visible and below 2px.
      const strokeWidth = await processIndicator.evaluate((element) =>
        parseFloat(getComputedStyle(element).borderTopWidth)
      );
      expect(strokeWidth).toBeGreaterThan(0);
      expect(strokeWidth).toBeLessThan(2);
      await expect(processIndicator).toHaveCSS('animation-duration', '1.2s');
      await expect(processIndicator).toHaveCSS('animation-name', 'busy-indicator-spin');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(processIndicator).toHaveCSS('animation-name', 'none');
      await page
        .locator('.process-heading')
        .filter({ has: processIndicator })
        .screenshot({ path: testInfo.outputPath(`process-running-${width}.png`) });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await expect(page.locator('.composer-busy-indicator')).toHaveCSS('width', '10px');
      await expect(page.locator('.composer-busy-indicator')).toHaveCSS('height', '10px');
      await expect(page.locator('.composer')).toHaveCSS('background-color', tokens.canvas);
      await expect(page.locator('.composer-shell')).toHaveCSS('background-color', tokens.panel);
      await expect(page.locator('.composer-shell')).toHaveCSS('border-top-width', '1px');
      await expect(page.locator('.composer textarea')).toHaveCSS('font-size', '14px');
      await expect(page.locator('.task-list-heading > span')).toHaveCSS('color', tokens.muted);
      const taskColors = await page
        .locator('.task-list-status')
        .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).color));
      expect(new Set(taskColors).size).toBe(3);
      await expect(page.locator('.task-list-status')).toHaveText(['To-do', 'In progress', 'Done']);
      await expect(page.locator('.conversation-item-heading > span').first()).toHaveCSS(
        'color',
        tokens.muted
      );
      const files = page.locator('.conversation-file-change-details > summary');
      await expect(files.locator('.conversation-group-meta')).toContainText('2');
      const plan = page.locator('.conversation-record-meta').filter({ hasText: '2' });
      await expect(plan).toBeVisible();
      for (const meta of [files.locator('.conversation-group-meta'), plan]) {
        const bounds = await meta.boundingBox();
        const heading = await meta.locator('..').boundingBox();
        expect(bounds!.x + bounds!.width).toBeGreaterThan(heading!.x + heading!.width - 24);
      }
      const group = page.locator('.conversation-record-group').first();
      await group.locator(':scope > summary').click();
      const nested = group.locator(':scope > details > summary').first();
      // Preserve breathing room and a bounded nesting increment, not a particular padding declaration.
      const spacing = await nested.evaluate((element) => {
        const style = getComputedStyle(element);
        return { top: parseFloat(style.paddingTop), right: parseFloat(style.paddingRight) };
      });
      expect(spacing.top).toBeGreaterThanOrEqual(2);
      expect(spacing.right).toBeGreaterThanOrEqual(8);
      expect((await nested.boundingBox())!.x - (await group.boundingBox())!.x).toBeLessThanOrEqual(
        16
      );
      const status = page.locator('.conversation-status');
      const latest = page.locator('.conversation-latest');
      await expect(latest).toBeVisible();
      expect((await status.boundingBox())!.y + (await status.boundingBox())!.height).toBeLessThan(
        (await latest.boundingBox())!.y
      );
      await page.getByTestId('toggle-following').click();
      await expect(latest).toHaveCount(0);
      await expect(status).toBeVisible();
      const copy = page.locator('.conversation-session-id button');
      await expect(copy).toHaveCSS('cursor', 'pointer');
      await copy.hover();
      await expect(copy.locator('code')).toHaveCSS('color', tokens.primary);
      for (const control of [
        page.getByTestId('native-utility'),
        page.getByTestId('element-utility')
      ]) {
        await control.hover();
        await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(control).toHaveCSS('color', tokens.primary);
        await control.focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        await expect(control).toBeFocused();
        await expect(control).not.toHaveCSS('outline-style', 'none');
        await page.keyboard.down('Space');
        await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await page.keyboard.up('Space');
        await control.evaluate((element) => element.setAttribute('aria-expanded', 'true'));
        await page.mouse.move(0, 0);
        await control.evaluate((element) => element.blur());
        await expect(control).toHaveCSS('color', tokens.primary);
        await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      }
      await expect(page.getByTestId('disabled-utility')).toBeDisabled();
      const treeToggle = page.locator('.workbench-tree-toggle');
      await expect(treeToggle).toHaveAttribute('aria-expanded', 'true');
      const notificationToggle = page.locator('.workbench-notification-trigger');
      const loads = page.getByTestId('notification-loads');
      await notificationToggle.click();
      await expect(loads).toHaveText('1');
      await expect(notificationToggle).toHaveAttribute('aria-expanded', 'true');
      await notificationToggle.click();
      await expect(notificationToggle).toHaveAttribute('aria-expanded', 'false');
      await page.getByRole('button', { name: 'Preview notification', exact: true }).click();
      await expect(notificationToggle).toHaveAttribute('aria-expanded', 'true');
      await notificationToggle.click();
      await expect(loads).toHaveText('2');
      await notificationToggle.click();
      await notificationToggle.click();
      await expect(loads).toHaveText('3');
      for (const detail of await page
        .locator('.conversation-file-change-details, .conversation-record-group')
        .all()) {
        if (!(await detail.evaluate((element) => (element as HTMLDetailsElement).open)))
          await detail.locator(':scope > summary').click();
      }
      for (const marker of [
        '.task-list-status',
        '.conversation-file-change-status',
        '.conversation-error-code'
      ])
        await expect(page.locator(marker).first()).toHaveCSS('border-radius', '4px');
      for (const selector of ['.user-message', '.assistant-message', '.process'])
        await expect(page.locator('.theme-preview').locator(selector)).toHaveCSS(
          'border-radius',
          '12px'
        );
      const userMessage = page.locator('.conversation-item.user_message');
      for (const property of ['background-color', 'border-top-color']) {
        const actual = await userMessage.evaluate(
          (element, name) => getComputedStyle(element).getPropertyValue(name),
          property
        );
        await expect(page.locator('.theme-preview .user-message')).toHaveCSS(property, actual);
      }
      for (const [selector, edge, size] of [
        ['.task-list-items', 'border-top-width', '1px'],
        ['.task-list-items > li', 'border-bottom-width', '1px'],
        ['.conversation-tool-list', 'border-left-width', '2px'],
        ['.conversation-tool-list > .conversation-tool-detail', 'border-top-width', '1px'],
        ['.conversation-record-group > .conversation-tool-detail', 'border-top-width', '0px'],
        ['.conversation-record-group > .conversation-command-detail', 'border-top-width', '0px']
      ] as const)
        await expect(page.locator(selector).first()).toHaveCSS(edge, size);
      await treeToggle.click();
      await expect(treeToggle).toHaveAttribute('aria-expanded', 'false');
      await treeToggle.click();
      await expect(treeToggle).toHaveAttribute('aria-expanded', 'true');
    }
  });
}

async function paletteColors(page: Page): Promise<Record<string, string>> {
  return page.locator('html').evaluate((root) => {
    const style = getComputedStyle(root);
    return Object.fromEntries(
      Array.from(style)
        .filter((key) => key.startsWith('--mar-'))
        .map((key) => [key, style.getPropertyValue(key).trim()])
    );
  });
}
function contrast(foreground: string, background: string) {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((offset) => {
      const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  const values = [luminance(foreground), luminance(background)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

test('uses the bright daylight palette with accessible interactive and text colors', async ({
  page
}) => {
  await page.goto(fixture.url + 'conversation-style.html?theme=daylight');
  const daylight = await paletteColors(page);
  expect(daylight['--mar-bg-page']).toBe('#f7f9fd');
  expect(daylight['--mar-bg-panel']).toBe('#ffffff');
  expect(daylight['--mar-bg-tab-inactive']).toBe('#e7eef7');
  expect(daylight['--mar-border-default']).toBe('#cbd6e4');
  expect(daylight['--mar-color-brand']).toBe('#0969e8');
  expect(daylight['--mar-color-brand-text']).toBe('#075fc7');
  expect(daylight['--mar-color-brand-selected']).toBe('#d9e9ff');
  expect(daylight['--mar-color-accent']).toBe('#067493');
  expect(daylight['--mar-control-color-success']).toBe('#067551');
  expect(daylight['--mar-text-primary']).toBe('#172033');
  expect(daylight['--mar-text-secondary']).toBe('#52627a');
  expect(daylight['--mar-text-tertiary']).toBe('#5f6f86');
  expect(daylight['--mar-text-muted']).toBe('#5f6f86');
  expect(daylight['--mar-text-faint']).toBe('#5f6f86');

  for (const state of [
    '--mar-color-brand',
    '--mar-color-brand-hover',
    '--mar-control-color-primary-dark-2'
  ]) {
    expect(contrast('#ffffff', daylight[state]!)).toBeGreaterThanOrEqual(4.5);
  }
  for (const role of ['primary', 'secondary', 'tertiary', 'muted', 'faint']) {
    expect(
      contrast(daylight[`--mar-text-${role}`]!, daylight['--mar-bg-panel']!)
    ).toBeGreaterThanOrEqual(4.5);
  }
  for (const [foreground, background] of [
    ['--mar-color-brand-text', '--mar-color-brand-selected'],
    ['--mar-color-accent', '--mar-color-accent-bg'],
    ['--mar-color-success-text', '--mar-color-success-bg'],
    ['--mar-color-warning-text', '--mar-color-warning-bg'],
    ['--mar-color-danger-text', '--mar-color-danger-bg']
  ]) {
    expect(contrast(daylight[foreground!]!, daylight[background!]!)).toBeGreaterThanOrEqual(4.5);
  }
});
test('uses the original dark palette with distinct surfaces and readable button text', async ({
  page
}) => {
  await page.goto(fixture.url + 'conversation-style.html?theme=vscode-dark-2026');
  const dark = await paletteColors(page);
  expect(dark['--mar-bg-page']).toBe('#0e1116');
  expect(dark['--mar-bg-panel']).toBe('#161d28');
  expect(dark['--mar-bg-chrome']).toBe('#131922');
  for (const [role, color] of Object.entries({
    canvas: '#0e1116',
    surface: '#131922',
    process: '#111720',
    border: '#313d50',
    'process-border': '#202a39',
    text: '#d0d7e2',
    muted: '#9fb0c7',
    code: '#111720'
  })) {
    expect(dark[`--mar-conversation-${role}`]).toBe(color);
  }
  expect(dark['--mar-control-bg-color-overlay']).toBe('#1a2230');
  expect(dark['--mar-bg-tab-inactive']).toBe('#111720');
  expect(dark['--mar-border-default']).toBe('#273142');
  expect(dark['--mar-border-subtle']).toBe('#202a39');
  expect(dark['--mar-color-brand']).toBe('#1f73cf');
  expect(dark['--mar-color-brand-hover']).toBe('#1a65b8');
  expect(dark['--mar-color-brand-selected']).toBe('#162c44');
  expect(dark['--mar-color-on-accent']).toBe('#ffffff');
  expect(
    contrast(dark['--mar-color-brand-text']!, dark['--mar-color-brand-selected']!)
  ).toBeGreaterThanOrEqual(4.5);
  expect(dark['--mar-color-accent']).toBe('#5edcec');
  expect(dark['--mar-control-color-success']).toBe('#62d6a4');
  expect(dark['--mar-text-primary']).toBe('#d3dbe7');
  expect(dark['--mar-text-secondary']).toBe('#9fb0c7');
  expect(dark['--mar-text-muted']).toBe('#8799b1');
  for (const surface of [
    '--mar-bg-page',
    '--mar-bg-chrome',
    '--mar-bg-panel',
    '--mar-control-bg-color-overlay'
  ]) {
    for (const text of ['--mar-text-primary', '--mar-text-secondary', '--mar-text-tertiary']) {
      expect(contrast(dark[text]!, dark[surface]!), text + ' on ' + surface).toBeGreaterThanOrEqual(
        4.5
      );
    }
  }
  for (const brandState of [
    '--mar-color-brand',
    '--mar-color-brand-hover',
    '--mar-control-color-primary-light-3',
    '--mar-control-color-primary-dark-2'
  ]) {
    expect(contrast(dark['--mar-color-on-accent']!, dark[brandState]!)).toBeGreaterThanOrEqual(4.5);
  }
  expect(dark['--mar-shadow-medium']).toBe('#00000047');
  expect(dark['--mar-overlay-scrim']).toBe('#0000007a');
  expect(dark['--mar-text-neutral-control']).toBe('#8799b1');
});

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test('Navigation and conversation contrasts remain accessible in ' + theme, async ({ page }) => {
    await page.goto(fixture.url + 'conversation-style.html?theme=' + theme);
    const colors = await paletteColors(page);
    const selected = colors['--mar-fill-selection']!;
    const hover = colors['--mar-fill-row-hover']!;
    expect(selected).not.toBe(colors['--mar-color-brand-selected']);
    for (const text of ['--mar-text-primary', '--mar-text-secondary'])
      expect(contrast(colors[text]!, selected)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors['--mar-color-brand-text']!, selected)).toBeGreaterThanOrEqual(3);
    for (const background of ['--mar-bg-panel', '--mar-bg-chrome'])
      expect(contrast(selected, colors[background]!)).toBeGreaterThan(
        contrast(hover, colors[background]!)
      );
    expect(colors['--mar-conversation-canvas']).not.toBe(colors['--mar-conversation-surface']);
    for (const text of ['text', 'muted'])
      for (const background of ['canvas', 'surface', 'process', 'code'])
        expect(
          contrast(
            colors['--mar-conversation-' + text]!,
            colors['--mar-conversation-' + background]!
          )
        ).toBeGreaterThanOrEqual(4.5);
  });
}
