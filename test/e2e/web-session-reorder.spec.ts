import { expect, test, type Page } from '@playwright/test';
import {
  hostedConversationSnapshotSchema,
  hostedConversationSummarySchema
} from '../../packages/protocol/src/index.js';
import {
  emitMockHostedConversationEvent,
  emitMockWorkspaceSnapshot,
  fulfillMockHostedConversationWatch,
  json,
  mockConsoleApi
} from './support/web-console-api.js';

async function observeMoves(page: Page, pauseNewMoves = false): Promise<void> {
  await page.addInitScript((pauseNewMoves) => {
    const moves: { title: string; transform: string; cancelled: boolean }[] = [];
    const measurements = { count: 0 };
    Object.assign(window, { sessionMoves: moves, sessionRowMeasurements: measurements });
    const boundingRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (this.classList.contains('mar-session-reorder-item')) measurements.count += 1;
      return boundingRect.call(this);
    };
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      const animation = animate.call(this, keyframes, options);
      if (this.classList.contains('mar-session-reorder-item')) {
        const move = {
          title: this.textContent ?? '',
          transform: getComputedStyle(this).transform,
          cancelled: false
        };
        moves.push(move);
        animation.addEventListener('cancel', () => {
          move.cancelled = true;
        });
        if (pauseNewMoves) animation.pause();
      }
      return animation;
    };
  }, pauseNewMoves);
}

async function moves(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          sessionMoves: { title: string; transform: string; cancelled: boolean }[];
        }
      ).sessionMoves
  );
}

async function finishMoves(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('.mar-session-reorder-item')).reduce(
          (count, element) => count + element.getAnimations().length,
          0
        )
      )
    )
    .toBe(0);
  await page.evaluate(() => {
    (window as unknown as { sessionMoves: unknown[] }).sessionMoves.length = 0;
  });
}

async function rowMeasurementCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { sessionRowMeasurements: { count: number } }).sessionRowMeasurements
        .count
  );
}

async function renderFrames(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}

function session(id: string, runnerTitle: string, lastActivityAt: number) {
  return {
    id,
    runnerTitle,
    lastActivityAt,
    workspaceId: 'workspace-1',
    runner: 'codex',
    externalSessionId: `native:${id}`,
    activity: 'IDLE',
    pinOrder: null,
    pinnedAt: null,
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
  };
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`Session activity reorder moves existing rows only: ${reducedMotion}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 1280, height: 900 });
    await observeMoves(page);
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    const first = session('session-1', 'Earlier session', 200);
    const second = session('session-2', 'Active session', 100);
    await page.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/, (route) =>
      json(route, { sessions: [first, second], nextCursor: null })
    );
    await page.goto('/console');
    await page.getByRole('button', { name: '进入控制台' }).click();
    await page.getByRole('button', { name: '工作', exact: true }).click();
    await page
      .locator('.workspace-tree')
      .getByRole('button', { name: /node-1/ })
      .click();
    await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
    const titles = page.locator('.session-list .session-link strong');
    await expect(titles).toHaveText(['Earlier session', 'Active session']);
    expect(await moves(page)).toEqual([]);
    const focused = page.locator('.session-link').filter({ hasText: 'Earlier session' });
    await focused.focus();
    const measurementsBeforeActivity = await rowMeasurementCount(page);

    const active = { ...second, lastActivityAt: 300 };
    await emitMockWorkspaceSnapshot(page, 'sessions', {
      sessions: [active, first],
      nextCursor: null
    });
    await expect(titles).toHaveText(['Active session', 'Earlier session']);
    if (reducedMotion === 'no-preference') {
      await expect.poll(async () => (await moves(page)).length).toBe(2);
      const transforms = (await moves(page)).map((entry) => entry.transform);
      expect(transforms.every((transform) => transform !== 'none')).toBe(true);
      const offsets = await page.evaluate(
        (values) => values.map((transform) => new DOMMatrixReadOnly(transform).m42),
        transforms
      );
      expect(Math.min(...offsets)).toBeLessThan(0);
      expect(Math.max(...offsets)).toBeGreaterThan(0);
      const measurementsBeforeMetadata = await rowMeasurementCount(page);
      await emitMockWorkspaceSnapshot(page, 'sessions', {
        sessions: [{ ...active, lastActivityAt: 310 }, first],
        nextCursor: null
      });
      await renderFrames(page);
      expect((await moves(page)).every((entry) => !entry.cancelled)).toBe(true);
      expect(await moves(page)).toHaveLength(2);
      expect(await rowMeasurementCount(page)).toBe(measurementsBeforeMetadata);
    } else {
      await renderFrames(page);
      expect(await moves(page)).toEqual([]);
      expect(await rowMeasurementCount(page)).toBe(measurementsBeforeActivity);
    }
    await expect(focused).toBeFocused();

    await emitMockWorkspaceSnapshot(page, 'sessions', {
      sessions: [{ ...first, lastActivityAt: 400 }, active],
      nextCursor: null
    });
    await expect(titles).toHaveText(['Earlier session', 'Active session']);
    await finishMoves(page);

    await emitMockWorkspaceSnapshot(page, 'sessions', {
      sessions: [{ ...second, lastActivityAt: 500 }, first, session('third', 'Loaded session', 50)],
      nextCursor: null
    });
    await expect(titles).toHaveText(['Active session', 'Earlier session', 'Loaded session']);
    await renderFrames(page);
    expect(await moves(page)).toEqual([]);
  });
}

test('Workspace snapshots and repeated searches keep loaded rows mounted and preserve list scroll', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  const items = Array.from({ length: 45 }, (_, index) =>
    session(
      index === 0 ? 'session-1' : `session-${index + 1}`,
      `Loaded session ${index}`,
      1000 - index
    )
  );
  let holdRebase = false;
  let rebaseRequested = false;
  let holdSearch = false;
  let searchRequested = false;
  let releaseRebase!: () => void;
  let releaseSearch!: () => void;
  const rebaseGate = new Promise<void>((resolve) => (releaseRebase = resolve));
  const searchGate = new Promise<void>((resolve) => (releaseSearch = resolve));
  await page.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/, async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.has('query')) {
      if (holdSearch) {
        searchRequested = true;
        await searchGate;
      }
      return json(route, { sessions: items.slice(0, 2), nextCursor: null });
    }
    const offset = Number(query.get('cursor') ?? 0);
    if (offset > 0 && holdRebase) {
      rebaseRequested = true;
      await rebaseGate;
    }
    const end = Math.min(items.length, offset + Number(query.get('limit') ?? 30));
    return json(route, {
      sessions: items.slice(offset, end),
      nextCursor: end < items.length ? String(end) : null
    });
  });
  try {
    await page.goto('/console');
    await page.getByRole('button', { name: '进入控制台' }).click();
    await page.getByRole('button', { name: '工作', exact: true }).click();
    await page
      .locator('.workspace-tree')
      .getByRole('button', { name: /node-1/ })
      .click();
    await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
    const rows = page.locator('.session-list .session-link');
    const list = page.locator('.session-list');
    await expect(rows).toHaveCount(30);
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(rows).toHaveCount(45);
    const retainedRow = await rows.nth(35).elementHandle();
    const scrollTop = await list.evaluate((element) => {
      element.scrollTop = 200;
      return element.scrollTop;
    });
    holdRebase = true;
    await emitMockWorkspaceSnapshot(page, 'sessions', {
      sessions: items.slice(0, 30),
      nextCursor: '30'
    });
    await expect.poll(() => rebaseRequested).toBe(true);
    await expect(rows).toHaveCount(45);
    expect(await retainedRow!.evaluate((element) => element.isConnected)).toBe(true);
    expect(await list.evaluate((element) => element.scrollTop)).toBe(scrollTop);
    releaseRebase();
    await expect(page.locator('.session-list .mar-list-append-state')).toHaveCount(0);
    await expect(rows).toHaveCount(45);
    expect(await retainedRow!.evaluate((element) => element.isConnected)).toBe(true);

    const search = page.locator('.session-search input');
    await search.fill('Loaded');
    await search.press('Enter');
    await expect(rows).toHaveCount(2);
    const retainedMatch = await rows.first().elementHandle();
    holdSearch = true;
    await search.press('Enter');
    await expect.poll(() => searchRequested).toBe(true);
    await expect(rows).toHaveCount(2);
    expect(await retainedMatch!.evaluate((element) => element.isConnected)).toBe(true);
    releaseSearch();
    await expect(page.locator('.session-search-button')).toBeEnabled();
    await expect(rows).toHaveCount(2);
    expect(await retainedMatch!.evaluate((element) => element.isConnected)).toBe(true);
  } finally {
    releaseRebase();
    releaseSearch();
  }
});

test('Hosted session activity moves keyed history cards and filtering stays static', async ({
  page
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1280, height: 900 });
  // Freeze real playback so a preference change cannot pass by waiting for the move to finish.
  await observeMoves(page, true);
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  const template = {
    id: 'template-1',
    nodeId: 'node-1',
    name: 'Review',
    description: '',
    status: 'ACTIVE',
    currentVersionId: 'version-1',
    available: true,
    createdAt: 1,
    updatedAt: 1
  };
  const first = hostedConversationSummarySchema.parse({
    id: 'conversation-1',
    nodeId: 'node-1',
    sessionId: 'hosted-1',
    templateId: template.id,
    templateName: template.name,
    activeVersionId: 'version-1',
    title: 'Active hosted session',
    titleSource: 'AUTO',
    pinnedAt: null,
    status: 'ACTIVE',
    modelId: 'model-1',
    createdAt: 1,
    updatedAt: 100,
    lastActivityAt: 100
  });
  const second = {
    ...first,
    id: 'conversation-2',
    sessionId: 'hosted-2',
    title: 'Earlier hosted session',
    lastActivityAt: 200,
    updatedAt: 200
  };
  await page.route(/\/api\/hosted-conversations\?limit=20$/, (route) =>
    json(route, { items: [first, second], nextCursor: null })
  );
  await page.route('**/api/conversation-templates', (route) =>
    json(route, { templates: [template] })
  );
  await page.route(/\/api\/nodes\/node-1\/hosted-conversations\/[^/]+\/watch$/, (route) => {
    const selected = route.request().url().includes('/conversation-1/') ? first : second;
    return fulfillMockHostedConversationWatch(
      page,
      route,
      selected.id,
      hostedConversationSnapshotSchema.parse({
        conversation: selected,
        template,
        run: null,
        turns: [],
        historyNextCursor: null,
        files: [],
        models: [],
        nodeAppVersion: '0.11.3',
        error: null,
        snapshotSequence: 1
      })
    );
  });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '对话', exact: true }).click();
  const titles = page.locator('.history-list .history-title-row strong');
  await expect(titles).toHaveText(['Earlier hosted session', 'Active hosted session']);
  await page.locator('.history-open').filter({ hasText: 'Active hosted session' }).click();
  await expect(page.locator('.history-list article.selected')).toContainText(
    'Active hosted session'
  );
  expect(await moves(page)).toEqual([]);
  await emitMockHostedConversationEvent(page, {
    conversationId: first.id,
    kind: 'conversation',
    conversation: { ...first, updatedAt: 300, lastActivityAt: 300 }
  });
  await expect(titles).toHaveText(['Active hosted session', 'Earlier hosted session']);
  await expect.poll(async () => (await moves(page)).length).toBe(2);
  await expect(page.locator('.history-list article.selected')).toContainText(
    'Active hosted session'
  );
  await expect
    .poll(() =>
      page
        .locator('.history-list article')
        .evaluateAll((rows) =>
          rows.flatMap((row) => row.getAnimations()).map((animation) => animation.playState)
        )
    )
    .toEqual(['paused', 'paused']);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await finishMoves(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('.history-search-row input').fill('Earlier');
  await expect(titles).toHaveText(['Earlier hosted session']);
  await renderFrames(page);
  expect(await moves(page)).toEqual([]);
});
