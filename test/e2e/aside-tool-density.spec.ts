import { expect, test } from '@playwright/test';
import { fulfillMockWorkspaceWatch, json, mockConsoleApi } from './support/web-console-api.js';

for (const width of [1440, 390]) {
  test(`Aside tool panels keep compact spacing below their shared tabs (${width}px)`, async ({
    page
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await mockConsoleApi(
      page,
      'MANAGED',
      ['history.read', 'turn.start'],
      [],
      'GIT_WORKSPACE',
      true,
      'IDLE',
      undefined,
      '0.11.69'
    );
    const changes = {
      branch: 'main',
      changes: [],
      repositories: [
        {
          repositoryPath: '',
          repositoryName: 'project',
          source: 'ROOT',
          current: true,
          branch: 'main',
          status: 'CLEAN',
          changes: []
        }
      ]
    };
    await page.route(/\/api\/workspaces\/workspace-1\/watch$/, (route) =>
      fulfillMockWorkspaceWatch(page, route, undefined, 'GIT_WORKSPACE', undefined, changes)
    );
    await page.route(/\/api\/workspaces\/workspace-1\/changes(?:\?.*)?$/, (route) =>
      json(route, changes)
    );
    await page.route(/\/api\/workspaces\/workspace-1\/git\/refs(?:\?.*)?$/, (route) =>
      json(route, { refs: [] })
    );
    await page.route(/\/api\/workspaces\/workspace-1\/git\/history(?:\?.*)?$/, (route) =>
      json(route, { commits: [], nextCursor: null })
    );
    await page.route(/\/api\/workspaces\/workspace-1\/git\/fetch(?:\?.*)?$/, (route) =>
      json(route, { fetchFailed: false, updated: false })
    );
    await page.goto('/console');
    await page.getByRole('button', { name: '进入控制台' }).click();
    await page.getByRole('button', { name: '工作', exact: true }).click();
    await page
      .locator('.workspace-tree')
      .getByRole('button', { name: /node-1/ })
      .click();
    await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
    if (width < 768)
      await page.getByRole('button', { name: '打开辅助工作面', exact: true }).click();

    const aside = page.locator('.workbench-aside');
    for (const theme of ['daylight', 'vscode-dark-2026']) {
      await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
      for (const [label, selector] of [
        ['文件', '.explorer-toolbar'],
        ['搜索', '.content-search-options'],
        ['Git 变更', '.change-repository-heading'],
        ['Git 历史', '.history-toolbar']
      ] as const) {
        await aside.getByRole('tab', { name: label, exact: true }).click();
        const toolbar = aside.locator(selector).first();
        await expect(toolbar).toBeVisible();
        await expect(aside.locator('.git-fetch-notice')).toHaveCount(0);
        const header = await aside.locator('.workbench-aside-header').boundingBox();
        const bounds = await toolbar.boundingBox();
        const gap = bounds!.y - (header!.y + header!.height);
        expect(gap, `${label}/${theme}`).toBeGreaterThanOrEqual(0);
        expect(gap, `${label}/${theme}`).toBeLessThanOrEqual(8);
        await aside.screenshot({ path: test.info().outputPath(`${label}-${theme}.png`) });
      }
    }
    expect(pageErrors).toEqual([]);
  });
}
