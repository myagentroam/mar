import { expect, test, type Route } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';
import { fulfillMockSessionWatch, mockConsoleApi } from './support/web-console-api.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/new-session-group.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const [width, itemsPerSegment] of [
  [1280, 200],
  [390, 200],
  [1280, 1],
  [390, 1]
] as const) {
  test(`Workbench switches cached history without a scroll at ${width}px with ${itemsPerSegment} items per segment`, async ({
    page
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });
    await mockConsoleApi(page, 'MANAGED', ['turn.start'], [], 'DIRECTORY');
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        json: { authenticated: true, mustChangePassword: false, username: 'admin', isAdmin: true }
      })
    );
    await page.route('**/api/nodes', (route) =>
      route.fulfill({
        json: {
          nodes: [
            {
              id: 'node-1',
              displayName: 'Linux Node',
              platform: 'linux',
              connected: true,
              nodeAppVersion: '0.11.55',
              capabilities: { workbenchWatch: { apiVersion: 1 } }
            }
          ]
        }
      })
    );
    await page.route('**/api/workspaces?nodeId=node-1', (route) =>
      route.fulfill({
        json: {
          workspaces: [
            { id: 'workspace-1', displayName: 'Workspace A', path: '/project', kind: 'DIRECTORY' }
          ]
        }
      })
    );
    const sessions = ['cached', 'other'].map((name) => ({
      id: `${name}-session`,
      workspaceId: 'workspace-1',
      customTitle: `${name} conversation`,
      runner: 'codex',
      externalSessionId: `native-${name}`,
      nativeControl: 'MAR_MANAGED',
      activity: 'IDLE',
      control: { level: 'MANAGED', capabilities: ['turn.start'] }
    }));
    await page.route('**/api/agent-sessions?*', (route) =>
      route.fulfill({ json: { sessions, nextCursor: null } })
    );
    await page.route('**/api/agent-sessions/*?nodeId=node-1', (route) => {
      const id = new URL(route.request().url()).pathname.split('/').at(-1);
      return route.fulfill({ json: { session: sessions.find((session) => session.id === id) } });
    });
    let pendingWatch: Route | undefined;
    let holdWatch = false;
    let generation = 0;
    let snapshots = 0;
    let olderReads = 0;
    await page.route('**/api/agent-sessions/*/turns?*', (route) => {
      olderReads++;
      return route.fulfill({
        json: {
          unit: 'SEGMENT',
          segments: Array.from({ length: 3 }, (_, index) => ({
            id: `older-${index}`,
            turnId: 'older-turn',
            sessionId: 'cached-session',
            runId: null,
            index,
            status: 'SUCCEEDED',
            items: Array.from({ length: 200 }, (_, item) => ({
              id: `older-${index}-${item}`,
              kind: 'assistant_message',
              status: 'COMPLETED',
              payload: { text: `Older body ${index}-${item}` }
            }))
          })),
          nextCursor: null
        }
      });
    });
    const finishWatch = async (route: Route) => {
      const session = sessions.find((candidate) => route.request().url().includes(candidate.id))!;
      await fulfillMockSessionWatch(page, route, session, {
        unit: 'SEGMENT',
        segments: Array.from({ length: 3 }, (_, segment) => ({
          id: `${session.id}-${segment}`,
          turnId: `${session.id}-turn`,
          sessionId: session.id,
          runId: null,
          index: segment,
          status: 'SUCCEEDED',
          items: Array.from({ length: itemsPerSegment }, (_, item) => ({
            id: `${session.id}-${segment}-${item}`,
            kind: 'assistant_message',
            status: 'COMPLETED',
            payload: { text: `${session.id} generation ${generation} body ${segment}-${item}` }
          }))
        })),
        nextCursor: itemsPerSegment === 1 && session.id === 'cached-session' ? 'older-page' : null
      });
      snapshots++;
    };
    await page.route('**/api/agent-sessions/*/watch', async (route) => {
      if (route.request().method() !== 'POST') return route.fulfill({ json: {} });
      if (holdWatch) pendingWatch = route;
      else await finishWatch(route);
    });
    await page.goto(`${fixture.url}new-session-group.html`);
    await expect.poll(() => errors).toEqual([]);
    await page.getByRole('button', { name: 'Linux Node' }).click();
    await page.getByRole('button', { name: 'Workspace A', exact: true }).click();
    await expect(page.locator('.composer-input')).toBeVisible();
    await page.setViewportSize({ width, height: 900 });
    if (width < 768) await page.locator('.mobile-conversation-tools button').first().click();
    const cachedRow = page.locator('.session-row').filter({ hasText: 'cached conversation' });
    const otherRow = page.locator('.session-row').filter({ hasText: 'other conversation' });
    await cachedRow.locator('.session-link').click();
    const latest = (id: string, version: number) =>
      page.getByText(`${id}-session generation ${version} body 2-${itemsPerSegment - 1}`, {
        exact: true
      });
    await expect(latest('cached', 0)).toBeInViewport();
    await expect(latest('cached', 0)).toBeVisible();
    await expect.poll(() => snapshots).toBe(1);
    if (itemsPerSegment === 1) {
      await expect.poll(() => olderReads).toBe(1);
      await expect(page.getByText('Older body 2-199', { exact: true })).toBeAttached();
    }
    await page.locator('.conversation-scroll').focus();
    await page.locator('.conversation-scroll').press('Home');
    if (width < 768) await page.locator('.mobile-conversation-tools button').first().click();
    await otherRow.locator('.session-link').click();
    await expect(latest('other', 0)).toBeInViewport();
    await expect.poll(() => snapshots).toBe(2);
    await page.locator('.conversation-scroll').focus();
    await page.locator('.conversation-scroll').press('Home');
    holdWatch = true;
    if (width < 768) await page.locator('.mobile-conversation-tools button').first().click();
    await cachedRow.locator('.session-link').click();
    await expect.poll(() => pendingWatch !== undefined).toBe(true);
    await expect(latest('cached', 0)).toBeInViewport();
    await expect(latest('cached', 0)).toBeVisible();
    if (itemsPerSegment === 1) {
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      );
    }
    generation = 1;
    await finishWatch(pendingWatch!);
    await expect(latest('cached', 1)).toBeInViewport();
    if (itemsPerSegment === 1) {
      await expect.poll(() => olderReads).toBe(2);
      await expect(page.getByText('Older body 2-199', { exact: true })).toBeAttached();
      await expect(latest('cached', 1)).toBeInViewport();
    }
    await expect(page.locator('.conversation-timeline')).not.toHaveClass(/is-initializing/);
    holdWatch = false;
    for (let cycle = 0; cycle < 3; cycle++) {
      generation++;
      if (width < 768) await page.locator('.mobile-conversation-tools button').first().click();
      await otherRow.locator('.session-link').click();
      await expect(latest('other', generation)).toBeInViewport();
      if (width < 768) await page.locator('.mobile-conversation-tools button').first().click();
      await cachedRow.locator('.session-link').click();
      await expect(latest('cached', generation)).toBeInViewport();
    }
    expect(errors).toEqual([]);
  });
}
