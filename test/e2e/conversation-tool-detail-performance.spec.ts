import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

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
        '.conversation-detail-text, .conversation-tool-sources a'
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
