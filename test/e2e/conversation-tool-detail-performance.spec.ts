import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

// @test-covers packages/web-core/src/view/conversation/ConversationTimeline.vue
test('switching Workspace Tabs does not recalculate an unchanged sibling style', async ({
  page,
  browserName
}) => {
  test.skip(browserName !== 'chromium', 'Style invalidation telemetry requires Chromium CDP.');
  const fixture = await startCustomThemeFixture('test/e2e/support/workbench-mobile-drawer.html', {
    protocolSource: true
  });
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // Load both style owners without re-optimizing Vite dependencies during the trace.
    const timelineModule = new URL(
      '/packages/web-core/src/view/conversation/ConversationTimeline.vue',
      fixture.url
    ).href;
    const moduleResponse = await page.request.get(timelineModule);
    expect(moduleResponse.status(), (await moduleResponse.text()).slice(0, 2000)).toBe(200);
    await page.goto(`${fixture.url}workbench-mobile-drawer.html?tree-reveal=1`);
    await page.evaluate(async (moduleUrl) => {
      await import(moduleUrl);
    }, timelineModule);
    const tabs = page.locator('.workspace-tab');
    await expect(tabs).toHaveCount(4);
    await page.evaluate(() => {
      const sibling = document.createElement('aside');
      sibling.dataset.styleSentinel = '';
      sibling.textContent = 'Unchanged workspace navigation';
      sibling.style.cssText = 'position:fixed;bottom:0;left:0;pointer-events:none';
      document.querySelector('.console-shell')!.prepend(sibling);
      void sibling.offsetWidth;
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '[data-style-sentinel]'
    });
    const { node } = await cdp.send('DOM.describeNode', { nodeId });
    let siblingRecalculations = 0;
    let totalRecalculations = 0;
    cdp.on('Tracing.dataCollected', ({ value }) => {
      for (const event of value) {
        if (event.name === 'StyleResolver::ResolveStyle') totalRecalculations++;
        if (
          event.name === 'StyleResolver::ResolveStyle' &&
          event.args?.data?.nodeId === node.backendNodeId
        )
          siblingRecalculations++;
      }
    });
    await cdp.send('Tracing.start', {
      categories:
        'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking'
    });
    for (let index = 0; index < 4; index++) {
      await tabs.nth((index + 1) % 4).click();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      );
    }
    const completed = new Promise<void>((resolve) =>
      cdp.once('Tracing.tracingComplete', () => resolve())
    );
    await cdp.send('Tracing.end');
    await completed;
    await cdp.detach();
    expect(totalRecalculations).toBeGreaterThan(0);
    expect(siblingRecalculations).toBe(0);
    await expect(page.locator('[data-style-sentinel]')).toHaveText(
      'Unchanged workspace navigation'
    );
  } finally {
    await fixture.close();
  }
});

test('records a reproducible conversation detail performance sample', async ({ page }) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/conversation-tool-detail.html', {
    protocolSource: true
  });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(
      `${fixture.url}conversation-tool-detail.html?timeline=1&unified=1&performance=1`
    );
    const result = await page.evaluate(async () => {
      const longTasks: number[] = [];
      const observer = new PerformanceObserver((list) =>
        longTasks.push(...list.getEntries().map((entry) => entry.duration))
      );
      observer.observe({ entryTypes: ['longtask'] });
      const frame = () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );
      const click = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) throw new Error(`Missing ${selector}`);
        element.click();
      };
      const process = document.querySelector<HTMLElement>('.process-heading');
      if (!process) throw new Error('Missing process');
      if (process.getAttribute('aria-expanded') === 'false') process.click();
      await frame();
      const closedDom =
        document.querySelectorAll('.conversation-timeline *').length ||
        document.querySelectorAll('main *').length;
      const closedBodies = document.querySelectorAll(
        '.mar-conversation-detail-text, .conversation-tool-sources a'
      ).length;
      const start = performance.now();
      click('[data-tool-presentation="READ"] > summary');
      await frame();
      click('[data-tool-presentation="READ"] .conversation-tool-detail > summary');
      click('[data-tool-presentation="WEB_SEARCH"] > summary');
      click('[data-tool-presentation="WEB_FETCH"] > summary');
      await frame();
      const expandMs = performance.now() - start;
      const expandedDom = document.querySelectorAll('main *').length;
      const switchStart = performance.now();
      click('[data-testid="switch-session"]');
      await frame();
      const switchMs = performance.now() - switchStart;
      observer.disconnect();
      return { closedDom, closedBodies, expandedDom, expandMs, switchMs, longTasks };
    });
    expect(result.closedDom).toBeGreaterThan(0);
    expect(result.expandedDom).toBeGreaterThan(0);
    await mkdir('test/runs', { recursive: true });
    await writeFile(
      `test/runs/conversation-tool-detail-performance-${process.env.MAR_DETAIL_PERF_LABEL ?? 'sample'}.json`,
      JSON.stringify(result, null, 2)
    );
    console.log(JSON.stringify(result));
  } finally {
    await fixture.close();
  }
});
