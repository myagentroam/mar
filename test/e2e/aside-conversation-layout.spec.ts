import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';
import { fulfillMockSessionWatch, json, mockConsoleApi } from './support/web-console-api.js';

// @test-covers packages/web-core/src/view/workbench/WorkspaceSessionPane.vue
// @test-covers packages/web-core/src/view/workbench/WorkbenchSurface.vue
let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/new-session-group.html');
});
test.afterAll(async () => fixture?.close());

const scenarios = [
  { name: 'Desktop short', width: 1440, paragraphs: 1 },
  { name: 'Desktop long', width: 1440, paragraphs: 80 },
  { name: 'Mobile short', width: 390, paragraphs: 1 }
];

for (const { name, width, paragraphs } of scenarios) {
  test(`${name} Aside conversation fills its tab with the composer at the bottom`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const capabilities = ['history.read', 'turn.start'];
    await mockConsoleApi(
      page,
      'MANAGED',
      capabilities,
      [],
      'DIRECTORY',
      true,
      'IDLE',
      [],
      '0.11.69'
    );
    await page.route('**/api/auth/me', (route) =>
      json(route, { authenticated: true, userId: 1, username: 'admin', isAdmin: true })
    );
    await page.route('**/api/nodes/node-1/workbench-capabilities', (route) =>
      json(route, {
        manifest: {
          manifestVersion: 1,
          observedAt: 1,
          conversation: { available: true, reasonCode: null },
          sessionAside: { apiVersion: 1 }
        }
      })
    );
    const session = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      externalSessionId: 'vscode-thread-1',
      runner: 'codex',
      activity: 'IDLE',
      control: { level: 'MANAGED', capabilities }
    };
    const reply = 'Aside conversation reply';
    const text = [
      reply,
      ...Array.from({ length: paragraphs - 1 }, (_, i) => `Paragraph ${i + 2}`)
    ].join('\n\n');
    await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
      fulfillMockSessionWatch(page, route, session, {
        kind: 'session-watch-snapshot',
        sequence: 1,
        session,
        runs: [],
        queue: { version: 0, paused: false, items: [] },
        context: null,
        conversation: {
          unit: 'SEGMENT',
          source: 'official',
          readAt: 2,
          latestVisibleAt: 2,
          snapshotSequence: 1,
          nextCursor: null,
          segments: [
            {
              id: 'turn-1:segment:0',
              sessionId: session.id,
              turnId: 'turn-1',
              index: 0,
              runId: null,
              status: 'SUCCEEDED',
              startedAt: 1,
              completedAt: 2,
              items: [
                {
                  id: 'reply',
                  sessionId: session.id,
                  turnId: 'turn-1',
                  runId: null,
                  parentItemId: null,
                  sourceSequence: null,
                  revision: 1,
                  startedAt: 1,
                  completedAt: 2,
                  kind: 'assistant_message',
                  status: 'COMPLETED',
                  payload: { text, format: 'markdown', model: null }
                }
              ]
            }
          ]
        }
      })
    );

    await page.goto(`${fixture.url}new-session-group.html`);
    const resources = page.locator('.workspace-tree');
    if (width < 768) await page.getByRole('button', { name: '工作', exact: true }).click();
    await resources.getByRole('button', { name: /node-1/ }).click();
    await resources.getByRole('button', { name: 'project' }).click();
    if (width < 768) {
      const grid = page.locator('.workspace-grid');
      const main = grid.locator('> .conversation-panel');
      await expect(main).toBeVisible();
      const gridBox = (await grid.boundingBox())!;
      const mainBox = (await main.boundingBox())!;
      expect(Math.abs(mainBox.y - gridBox.y)).toBeLessThan(1);
      expect(Math.abs(mainBox.height - gridBox.height)).toBeLessThan(1);
      await main.getByRole('button', { name: '打开会话列表' }).click();
    }
    const row = page.locator('.session-row');
    await row.hover();
    await row.locator('.session-more-button').click();
    await page.getByRole('menuitem', { name: '在侧栏打开', exact: true }).click();

    const aside = page.locator('.workbench-aside');
    const panel = aside.getByRole('tabpanel');
    const pane = panel.locator('.conversation-panel');
    const scroll = pane.locator('.conversation-scroll');
    const composer = pane.locator('.composer-host');
    await expect(scroll.getByText(reply, { exact: true })).toBeAttached();
    await expect(composer.getByRole('textbox')).toBeInViewport({ ratio: 1 });
    await expect
      .poll(async () => {
        const paneBox = (await pane.boundingBox())!;
        const panelBox = (await panel.boundingBox())!;
        return Math.abs(paneBox.height - panelBox.height);
      })
      .toBeLessThan(1);
    const composerBox = (await composer.boundingBox())!;
    const panelBox = (await panel.boundingBox())!;
    const asideBox = (await aside.boundingBox())!;
    expect(Math.abs(panelBox.y + panelBox.height - (asideBox.y + asideBox.height))).toBeLessThan(1);
    expect(
      Math.abs(composerBox.y + composerBox.height - (panelBox.y + panelBox.height))
    ).toBeLessThan(1);

    const overflow = () =>
      scroll.evaluate((element) => element.scrollHeight - element.clientHeight);
    if (paragraphs === 1) {
      expect(await overflow()).toBe(0);
    } else {
      expect(await overflow()).toBeGreaterThan(0);
      const scrollTop = () => scroll.evaluate((element) => element.scrollTop);
      await expect.poll(scrollTop).toBeGreaterThan(0);
      const initialTop = await scrollTop();
      await scroll.hover();
      await page.mouse.wheel(0, -320);
      await expect.poll(scrollTop).toBeLessThan(initialTop);
      const scrolledComposer = (await composer.boundingBox())!;
      expect(
        Math.abs(
          scrolledComposer.y + scrolledComposer.height - (composerBox.y + composerBox.height)
        )
      ).toBeLessThan(1);
    }
  });
}
