import { expect, test, type Page } from '@playwright/test';
import { startPromptCompletionViteFixture } from './support/prompt-completion-vite.js';

type CompactState =
  'WAITING' | 'BLOCKING_WAITING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'UNRESOLVED';

declare global {
  interface Window {
    __compactLifecycleHarness: {
      update(state: CompactState): void;
      useToolAnchor(): void;
      itemIds(): string[];
    };
  }
}

let fixture: Awaited<ReturnType<typeof startPromptCompletionViteFixture>>;

test.beforeAll(async () => {
  fixture = await startPromptCompletionViteFixture();
});

test.afterAll(async () => {
  await fixture?.close();
});

async function openTimeline(page: Page): Promise<void> {
  await page.goto(new URL('/compact-lifecycle.html', fixture.url).toString());
  for (const group of ['prefix', 'tail']) {
    const heading = page.locator(`[data-process-id="${group}"] .process-heading`);
    if ((await heading.getAttribute('aria-expanded')) === 'true') await heading.click();
    await heading.click();
  }
}

async function itemOrder(page: Page): Promise<string[]> {
  return page
    .locator('article.conversation-item')
    .evaluateAll((items) =>
      items.map((item) =>
        item.classList.contains('context_compaction')
          ? 'compact'
          : item.classList.contains('reasoning-group')
            ? 'reasoning'
            : item.classList.contains('tool-group')
              ? 'tool'
              : item.classList.contains('assistant_message')
                ? 'assistant'
                : 'other'
      )
    );
}

test('background Compact waits and installs in place without interrupting the reasoning tail', async ({
  page
}) => {
  await openTimeline(page);
  const compact = page.locator('article.context_compaction');
  await expect(compact).toHaveCount(1);
  await expect(compact.locator('.conversation-item-heading span')).toHaveText(
    'Compacting context in the background'
  );
  await expect(page.locator('.conversation-process .process-summary')).toHaveText([
    'Reasoning before anchor',
    'Continuing after anchor'
  ]);
  expect(await itemOrder(page)).toEqual(['reasoning', 'assistant', 'compact', 'reasoning']);
  expect(await page.evaluate(() => window.__compactLifecycleHarness.itemIds())).toEqual([
    'reasoning-before',
    'snapshot-anchor',
    'mar-agent-compact:compact-1',
    'reasoning-after'
  ]);

  await compact.evaluate((element) => {
    (element as HTMLElement).dataset.stableCard = 'compact-1';
  });
  await page.evaluate(() => window.__compactLifecycleHarness.update('BLOCKING_WAITING'));
  await page.evaluate(() => window.__compactLifecycleHarness.update('BLOCKING_WAITING'));
  await expect(compact).toHaveCount(1);
  await expect(compact).toHaveAttribute('data-stable-card', 'compact-1');
  await expect(compact.locator('.conversation-item-heading span')).toHaveText(
    'Waiting for context compaction before continuing'
  );
  await expect(page.locator('.conversation-process .process-summary')).toHaveText([
    'Reasoning before anchor',
    'Continuing after anchor'
  ]);
  expect(await itemOrder(page)).toEqual(['reasoning', 'assistant', 'compact', 'reasoning']);

  await page.evaluate(() => window.__compactLifecycleHarness.update('COMPLETED'));
  await expect(compact).toHaveCount(1);
  await expect(compact).toHaveAttribute('data-stable-card', 'compact-1');
  await expect(compact.locator('.conversation-item-heading span')).toHaveText('Compacted');
  await expect(page.locator('[data-process-id="prefix"] .process-summary')).toHaveCount(0);
  await expect(page.locator('[data-process-id="prefix"] .process-activity-label')).toHaveText(
    'Completed'
  );
  await expect(page.locator('[data-process-id="tail"] .process-summary')).toHaveText(
    'Continuing after anchor'
  );
  await expect(page.locator('.reasoning-subtitle')).toHaveText([
    'Reasoning before anchor',
    'Continuing after anchor'
  ]);
  expect(await itemOrder(page)).toEqual([
    'reasoning',
    'assistant',
    'compact',
    'reasoning',
    'assistant'
  ]);
  expect(await page.evaluate(() => window.__compactLifecycleHarness.itemIds())).toEqual([
    'reasoning-before',
    'snapshot-anchor',
    'mar-agent-compact:compact-1',
    'reasoning-after',
    'tail-message'
  ]);
  await expect(page.locator('article.conversation-item').nth(4)).toContainText(
    'Tail after compaction'
  );
});

for (const terminal of [
  { state: 'FAILED', label: 'Context compaction failed' },
  { state: 'CANCELLED', label: 'Context compaction canceled' }
] as const) {
  test(`background Compact ${terminal.state.toLowerCase()} keeps its identity and active reasoning`, async ({
    page
  }) => {
    await openTimeline(page);
    const compact = page.locator('article.context_compaction');
    await page.evaluate((state) => window.__compactLifecycleHarness.update(state), terminal.state);
    await expect(compact).toHaveCount(1);
    await expect(compact.locator('.conversation-item-heading span')).toHaveText(terminal.label);
    await expect(page.locator('.conversation-process .process-summary')).toHaveText([
      'Reasoning before anchor',
      'Continuing after anchor'
    ]);
    await expect(page.locator('.reasoning-subtitle')).toHaveText([
      'Reasoning before anchor',
      'Continuing after anchor'
    ]);
    expect(await itemOrder(page)).toEqual(['reasoning', 'assistant', 'compact', 'reasoning']);
    expect(await page.evaluate(() => window.__compactLifecycleHarness.itemIds())).toEqual([
      'reasoning-before',
      'snapshot-anchor',
      'mar-agent-compact:compact-1',
      'reasoning-after'
    ]);
  });
}

test('background Compact with a paginated-away anchor does not complete the tail', async ({
  page
}) => {
  await openTimeline(page);
  await page.evaluate(() => window.__compactLifecycleHarness.update('UNRESOLVED'));
  const compact = page.locator('article.context_compaction');
  await expect(compact).toHaveCount(1);
  await expect(compact.locator('.conversation-item-heading span')).toHaveText('Compacted');
  await expect(page.locator('.conversation-process .process-summary')).toHaveText([
    'Reasoning before anchor',
    'Continuing after anchor'
  ]);
  await expect(page.locator('.reasoning-subtitle')).toHaveText([
    'Reasoning before anchor',
    'Continuing after anchor'
  ]);
  expect(await itemOrder(page)).toEqual(['reasoning', 'compact', 'reasoning']);
});

test('background Compact follows a tool anchor and completes only the installed prefix', async ({
  page
}) => {
  await openTimeline(page);
  await page.evaluate(() => window.__compactLifecycleHarness.useToolAnchor());
  const compact = page.locator('article.context_compaction');
  await expect(compact).toHaveCount(1);
  expect(await itemOrder(page)).toEqual(['reasoning', 'tool', 'compact', 'reasoning']);

  await page.evaluate(() => window.__compactLifecycleHarness.update('COMPLETED'));
  await expect(compact.locator('.conversation-item-heading span')).toHaveText('Compacted');
  expect(await itemOrder(page)).toEqual(['reasoning', 'tool', 'compact', 'reasoning', 'assistant']);
  await expect(page.locator('[data-process-id="prefix"] .process-summary')).toHaveCount(0);
  await expect(page.locator('[data-process-id="prefix"] .process-activity-label')).toHaveText(
    'Completed'
  );
  await expect(page.locator('[data-process-id="tail"] .process-summary')).toHaveText(
    'Continuing after anchor'
  );
  await expect(page.locator('.reasoning-subtitle')).toHaveText([
    'Reasoning before anchor',
    'Continuing after anchor'
  ]);
});
