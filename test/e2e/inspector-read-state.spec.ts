import { expect, test, type Locator } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/inspector-read-state.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

async function expectStatusToScrollWithRows(status: Locator, firstRow: Locator) {
  await expect(status).toBeVisible();
  const rowTop = (await firstRow.boundingBox())!.y;
  const statusBefore = (await status.boundingBox())!;
  expect(statusBefore.y + statusBefore.height).toBeLessThanOrEqual(rowTop);
  await firstRow.evaluate((row) => {
    let scroll = row.parentElement;
    while (scroll && getComputedStyle(scroll).overflowY !== 'auto') scroll = scroll.parentElement;
    if (!scroll) throw new Error('Missing list scroll container');
    scroll.scrollTop = 110;
  });
  await expect.poll(async () => (await status.boundingBox())?.y).toBeCloseTo(statusBefore.y - 110);
}

function textContrast(locator: Locator) {
  return locator.evaluate((element) => {
    const backgrounds: string[] = [];
    for (let layer: Element | null = element; layer; layer = layer.parentElement) {
      backgrounds.unshift(getComputedStyle(layer).backgroundColor);
    }
    const canvas = document.createElement('canvas').getContext('2d')!;
    const luminance = (layers: string[]) => {
      canvas.clearRect(0, 0, 1, 1);
      for (const color of layers) {
        canvas.fillStyle = color;
        canvas.fillRect(0, 0, 1, 1);
      }
      const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data;
      const linear = (channel: number) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * linear(r!) + 0.7152 * linear(g!) + 0.0722 * linear(b!);
    };
    const bg = luminance(backgrounds);
    const fg = luminance([...backgrounds, getComputedStyle(element).color]);
    return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
  });
}

for (const theme of ['daylight', 'dark']) {
  test(`Inspector result rows share visible hover and keyboard focus in ${theme}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 880 });
    const changes = [
      { path: 'scripts/release-uat.mjs', change: 'MODIFIED' },
      { path: 'src/inspector.ts', change: 'ADDED' },
      { path: 'src/old-panel.ts', change: 'DELETED' }
    ].map((file) => ({ ...file, state: 'UNSTAGED', diffAvailable: true }));
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/content/search')) {
        return route.fulfill({
          json: {
            search: {
              truncated: true,
              matches: [
                'const workspace = resolve(root);',
                'await git(workspace, args);',
                'const status = await readStatus(workspace);',
                'return workspace;',
                'await publishWorkspace(workspace);',
                'await refresh(workspace);'
              ].map((preview, index) => ({
                path: changes[0]!.path,
                line: 37 + index * 7,
                column: 1,
                preview
              }))
            }
          }
        });
      }
      if (path.endsWith('/changes')) {
        return route.fulfill({
          json: {
            changes,
            repositories: [
              {
                repositoryPath: '',
                repositoryName: 'my-agent-roam',
                source: 'ROOT',
                current: true,
                branch: 'develop',
                status: 'DIRTY',
                changes
              }
            ]
          }
        });
      }
      if (path.endsWith('/git/history')) {
        return route.fulfill({
          json: {
            commits: [
              'Unify inspector row states',
              'Align search results',
              'Improve file preview'
            ].map((subject, index) => ({
              subject,
              hash: `commit-${index}`,
              parents: index < 2 ? [`commit-${index + 1}`] : [],
              authorName: 'Developer',
              authorEmail: 'dev@example.test',
              committedAt: Date.UTC(2026, 6, 10, 14, 32 - index * 5),
              refs: index === 0 ? ['develop'] : []
            })),
            nextCursor: null
          }
        });
      }
      if (path.includes('/git/commits/') && path.endsWith('/files')) {
        return route.fulfill({ json: { files: changes } });
      }
      return route.fulfill({ json: { refs: [] } });
    });
    await page.goto(
      `${fixture.url}inspector-read-state.html?theme=${theme}&locale=zh-CN&row-styles`
    );
    const search = page.getByTestId('Search');
    const input = search.getByRole('textbox');
    await input.fill('workspace');
    await input.press('Enter');
    const searchRow = search.locator('.content-search-results button').first();
    const match = searchRow.locator('mark');
    await expect(match).toHaveText('workspace');
    await expect(match).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(match).toHaveCSS('text-decoration-line', 'underline');

    const files = page.getByTestId('Files');
    const file = files.locator('[data-file-path="src/existing.ts"]');
    const gitChanges = page.getByTestId('Git Changes');
    const change = gitChanges.locator('.change-entry').first();
    const history = page.getByTestId('Git History');
    const commit = history.locator('.history-commit-row').first();
    await commit.click();
    const directory = history.getByRole('button', { name: 'scripts', exact: true });
    await directory.click();
    const historyFile = history.getByRole('button', { name: /release-uat\.mjs/ });
    const rows = [
      { panel: files, name: 'files', row: file.locator('..'), target: file, text: ['.tree-name'] },
      {
        panel: search,
        name: 'search',
        row: searchRow,
        target: searchRow,
        text: ['.content-search-file', '.content-search-directory', 'small', 'code', 'mark']
      },
      {
        panel: gitChanges,
        name: 'git-changes',
        row: change,
        target: change.locator('.change-path'),
        text: ['.change-file-name', '.change-directory', '.change-status']
      },
      {
        panel: history,
        name: 'git-history',
        row: commit,
        target: commit,
        text: ['.history-subject', 'small', '.history-ref']
      },
      {
        row: historyFile,
        target: historyFile,
        text: ['.history-file-path', '.history-file-status']
      }
    ];
    const hover = theme === 'daylight' ? 'rgb(232, 241, 255)' : 'rgb(46, 46, 46)';
    for (const { panel, name, row, target, text } of rows) {
      for (const selector of text) {
        expect(await textContrast(row.locator(selector).first()), selector).toBeGreaterThanOrEqual(
          4.5
        );
      }
      await target.hover();
      await expect(row).toHaveCSS('background-color', hover);
      if (panel) await panel.screenshot({ path: testInfo.outputPath(`${name}.png`) });
      for (const selector of text) {
        expect(await textContrast(row.locator(selector).first()), selector).toBeGreaterThanOrEqual(
          4.5
        );
      }
      await page.mouse.move(0, 0);
      await page.keyboard.press('Tab');
      await target.focus();
      await expect(target).toHaveCSS('outline-style', 'solid');
      await expect(target).toHaveCSS('outline-width', '2px');
      await target.blur();
    }

    const customHover = theme === 'daylight' ? '#d6d6d6' : '#444444';
    const matchColors = theme === 'daylight' ? ['#261900', '#ffd386'] : ['#fff4dc', '#653700'];
    await page.locator('html').evaluate(
      (root, { customHover, matchColors }) => {
        root.style.setProperty('--mar-fill-row-hover', customHover);
        root.style.setProperty('--mar-color-warning-bg', matchColors[0]!);
        root.style.setProperty('--mar-color-warning-text', matchColors[1]!);
      },
      { customHover, matchColors }
    );
    for (const { row, target } of rows) {
      await target.hover();
      await expect(row).toHaveCSS(
        'background-color',
        theme === 'daylight' ? 'rgb(214, 214, 214)' : 'rgb(68, 68, 68)'
      );
    }
    await searchRow.hover();
    expect(await textContrast(match)).toBeGreaterThanOrEqual(4.5);
  });
}

for (const width of [1280, 390]) {
  const theme = width < 768 ? 'daylight' : 'dark';
  test(`Inspector feedback scrolls with the content it describes at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 860 });
    const changes = Array.from({ length: 205 }, (_, index) => ({
      path: `file-${index}.ts`,
      state: 'UNSTAGED',
      change: 'MODIFIED',
      diffAvailable: true
    }));
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/changes'))
        return route.fulfill({
          json: {
            changes,
            repositories: [
              {
                repositoryPath: '',
                repositoryName: 'root',
                source: 'ROOT',
                status: 'DIRTY',
                changes
              }
            ]
          }
        });
      if (path.endsWith('/git/fetch'))
        return route.fulfill({ json: { fetchFailed: true, updated: false } });
      if (path.endsWith('/git/history'))
        return route.fulfill({
          json: {
            commits: changes.slice(0, 60).map(({ path }, index) => ({
              hash: `commit-${index}`,
              subject: path,
              parents: [],
              authorName: 'Developer',
              authorEmail: 'dev@example.test',
              committedAt: 1,
              refs: []
            })),
            nextCursor: null
          }
        });
      if (path.endsWith('/content/search'))
        return route.fulfill({
          json: {
            search: {
              matches: changes.slice(0, 60).map(({ path }) => ({
                path,
                line: 1,
                column: 1,
                preview: 'workspace'
              })),
              truncated: true
            }
          }
        });
      return route.fulfill({ json: { refs: [] } });
    });
    await page.goto(`${fixture.url}inspector-read-state.html?theme=${theme}&scroll-feedback`);

    const gitChanges = page.getByTestId('Git Changes');
    const changeRow = gitChanges.locator('.change-entry').first();
    const changeWarning = gitChanges.getByRole('alert');
    await expectStatusToScrollWithRows(changeWarning, changeRow);
    await page.getByRole('button', { name: 'Load Git Changes Watch' }).click();
    const changeScroller = gitChanges.locator('.current-changes');
    await changeScroller.evaluate((element) => (element.scrollTop = 0));
    await expectStatusToScrollWithRows(gitChanges.locator('.changes-read-state'), changeRow);
    await expect(gitChanges.locator('.change-entry')).toHaveCount(200);
    await changeScroller.evaluate((element) => (element.scrollTop = element.scrollHeight));
    await expect(gitChanges.locator('.change-entry')).toHaveCount(205);

    const history = page.getByTestId('Git History');
    await expectStatusToScrollWithRows(
      history.getByRole('alert'),
      history.locator('.history-commit-row').first()
    );

    const search = page.getByTestId('Search');
    const searchWarning = search.getByRole('alert');
    await expect(searchWarning).toHaveText('Results are incomplete. Narrow the search scope.');
    await expect(searchWarning).toHaveAttribute('data-type', 'warning');
    const warningBounds = (await searchWarning.boundingBox())!;
    const inputBounds = (await search.locator('.mar-ui-input').boundingBox())!;
    const listBounds = (await search
      .getByRole('list', { name: 'Content search results' })
      .boundingBox())!;
    const firstSearchRow = search.locator('.content-search-results button').first();
    expect(warningBounds.x).toBeCloseTo(inputBounds.x);
    expect(warningBounds.x).toBeCloseTo(listBounds.x);
    expect(warningBounds.width).toBeCloseTo(listBounds.width);
    const gutters = await firstSearchRow.evaluate((row) => {
      const scrollport = row.closest('.content-search-body')!;
      const x = scrollport.getBoundingClientRect().left;
      const bounds = row.getBoundingClientRect();
      return { left: bounds.left - x, right: x + scrollport.clientWidth - bounds.right };
    });
    expect(gutters.left).toBeGreaterThanOrEqual(6);
    expect(gutters.right).toBeCloseTo(gutters.left);
    await expectStatusToScrollWithRows(searchWarning, firstSearchRow);

    await page.getByRole('button', { name: 'Fail Files Watch' }).click();
    const files = page.getByTestId('Files');
    const retry = files.locator('.files-read-retry');
    const handledDragEvents = await retry.evaluate((element) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(['data'], 'notes.txt'));
      return ['dragenter', 'dragover', 'drop'].filter((type) => {
        const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      });
    });
    expect(handledDragEvents).toEqual([]);
    await expectStatusToScrollWithRows(retry, files.getByRole('treeitem').first());
    await files.scrollIntoViewIfNeeded();
    await files.locator('.workspace-file-tree').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(files.getByRole('treeitem', { name: 'file-59.ts' })).toBeInViewport();
  });

  test(`Directory navigation and refresh own separate feedback at ${width}px`, async ({
    page
  }, info) => {
    await page.setViewportSize({ width, height: 860 });
    let request = Promise.withResolvers<void>();
    await page.route('**/api/workspace-directories?**', async (route) => {
      await request.promise;
      const subdirectory = route.request().url().includes('projects');
      return route.fulfill({
        json: {
          directory: {
            currentPath: subdirectory ? '/workspace/projects' : '/workspace',
            homePath: '/workspace',
            parentPath: subdirectory ? '/workspace' : null,
            browseRoots: ['/workspace'],
            selectable: true,
            entries: subdirectory
              ? []
              : [{ name: 'projects', path: '/workspace/projects', selectable: true }],
            truncated: false
          }
        }
      });
    });
    await page.route('**/api/**/html-preview**', (route) =>
      route.fulfill({ json: { url: '/fixture-preview.html' } })
    );
    await page.goto(
      `${fixture.url}inspector-read-state.html?theme=${theme}&refresh-controls&empty-directory`
    );
    await page.getByRole('button', { name: 'Open directory picker' }).click();
    const dialog = page.getByRole('dialog');
    const pending = dialog.getByRole('progressbar');
    const refresh = dialog.getByRole('button', { name: 'Refresh directory' });
    await expect(pending).toBeVisible();
    await page.screenshot({
      path: info.outputPath('directory-loading.png'),
      animations: 'disabled'
    });
    request.resolve();
    await expect(refresh).toBeEnabled();
    request = Promise.withResolvers<void>();
    await dialog.getByRole('button', { name: 'Open projects' }).click();
    await expect(pending).toBeVisible();
    await expect(refresh).not.toHaveAttribute('aria-busy', 'true');
    await page.screenshot({
      path: info.outputPath('directory-navigating.png'),
      animations: 'disabled'
    });
    request.resolve();
    await expect(refresh).toBeEnabled();
    request = Promise.withResolvers<void>();
    await refresh.click();
    await expect(refresh).toHaveAttribute('aria-busy', 'true');
    await expect(pending).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath('directory-refreshing.png'),
      animations: 'disabled'
    });
    request.resolve();
    await expect(refresh).toBeEnabled();
  });

  test(`Share records distinguish first read, failure and empty at ${width}px`, async ({
    page
  }, info) => {
    await page.setViewportSize({ width, height: 860 });
    const first = Promise.withResolvers<void>();
    const retry = Promise.withResolvers<void>();
    const recovery = Promise.withResolvers<void>();
    let reads = 0;
    await page.route('**/api/agent-sessions/session/shares?**', async (route) => {
      if (++reads === 1) {
        await first.promise;
        return route.fulfill({ status: 503, json: { error: 'UNAVAILABLE' } });
      }
      if (reads === 2) {
        await retry.promise;
        return route.fulfill({ status: 503, json: { error: 'UNAVAILABLE' } });
      }
      await recovery.promise;
      return route.fulfill({ json: { shares: [] } });
    });
    await page.goto(`${fixture.url}inspector-read-state.html?theme=${theme}&refresh-controls`);
    await page.getByRole('button', { name: 'Open share dialog' }).click();
    const dialog = page.getByRole('dialog');
    const empty = dialog.getByText('No shared links yet.');
    const progress = dialog.getByRole('progressbar');
    await expect(progress).toBeVisible();
    await expect(empty).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('share-loading.png'), animations: 'disabled' });
    first.resolve();
    const retryButton = dialog.getByRole('button', { name: /Retry/ });
    await expect(retryButton).toBeVisible();
    await expect(empty).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('share-failed.png'), animations: 'disabled' });
    await retryButton.focus();
    await retryButton.click();
    const busyRetry = dialog.getByRole('button', { name: /^Loading…?$/ });
    await expect(busyRetry).toBeFocused();
    await expect(busyRetry).toHaveAttribute('aria-busy', 'true');
    await expect(busyRetry.locator('.mar-read-loading-indicator')).toBeVisible();
    await expect(progress).toHaveCount(0);
    await page.keyboard.press('Enter');
    expect(reads).toBe(2);
    await page.screenshot({ path: info.outputPath('share-retrying.png'), animations: 'disabled' });
    retry.resolve();
    await expect(retryButton).toBeFocused();
    await retryButton.click();
    recovery.resolve();
    await expect(empty).toBeVisible();
    await page.screenshot({ path: info.outputPath('share-empty.png'), animations: 'disabled' });
  });
}

test('Share record retry keeps the region typography when a record is already visible', async ({
  page
}) => {
  await page.route('**/api/agent-sessions/session/shares?**', (route) =>
    route.fulfill({ status: 503, json: { error: 'UNAVAILABLE' } })
  );
  await page.route('**/api/agent-sessions/session/shares', (route) =>
    route.fulfill({
      json: {
        share: {
          id: 'share',
          sessionId: 'session',
          nodeId: 'node',
          workspaceId: 'workspace',
          createdAt: Date.now(),
          expiresAt: null
        },
        password: '123456'
      }
    })
  );
  await page.goto(`${fixture.url}inspector-read-state.html?theme=daylight&refresh-controls`);
  await page.getByRole('button', { name: 'Open share dialog' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: /Retry/ })).toBeVisible();
  await dialog.getByRole('button', { name: 'Create share' }).click();
  await expect(dialog.getByRole('link').filter({ hasText: '/share/share' })).toBeVisible();
  const region = dialog.locator('.mar-region-status');
  const retry = region.getByRole('button', { name: /Retry/ });
  await expect(retry).toHaveCSS(
    'font-size',
    await region.evaluate((element) => getComputedStyle(element).fontSize)
  );
  await expect(retry).toHaveCSS('border-top-width', '0px');
});

async function expectReadableState(button: Locator) {
  await expect(button).toBeVisible();
  const layout = await button.evaluate((element) => {
    const probe = document.createElement('span');
    probe.style.fontSize = 'var(--mar-font-size-meta)';
    element.parentElement!.append(probe);
    const metaSize = getComputedStyle(probe).fontSize;
    probe.remove();
    const range = document.createRange();
    // Measure text rather than the rotating SVG's transformed square bounds.
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.textContent?.trim() && !node.parentElement?.closest('svg')
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT
    });
    const first = walker.nextNode()!;
    let last = first;
    while (walker.nextNode()) last = walker.currentNode;
    range.setStart(first, 0);
    range.setEnd(last, last.textContent!.length);
    const text = range.getBoundingClientRect();
    const button = element.getBoundingClientRect();
    return {
      fontSize: getComputedStyle(element).fontSize,
      metaSize,
      left: text.left - button.left,
      right: button.right - text.right,
      textWidth: text.width
    };
  });
  expect(layout.fontSize).toBe(layout.metaSize);
  expect(layout.textWidth).toBeGreaterThan(0);
  expect(layout.left).toBeGreaterThanOrEqual(-1);
  expect(layout.right).toBeGreaterThanOrEqual(-1);
  await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await button.hover();
  await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
}

for (const theme of ['daylight', 'dark']) {
  for (const width of [1280, 390]) {
    test(`Settings, directory and HTML refresh actions recover: ${theme} ${width}`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      let pending: Promise<void> | undefined;
      let release: (() => void) | undefined;
      let failed = false;
      await page.route('**/api/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        await pending;
        await route.fulfill({
          status: failed ? 503 : 200,
          json: failed
            ? { error: 'REFRESH_FAILED' }
            : path.endsWith('/sessions')
              ? { sessions: [] }
              : path.endsWith('/workspace-directories')
                ? {
                    directory: {
                      currentPath: '/workspace',
                      homePath: '/workspace',
                      parentPath: null,
                      browseRoots: ['/workspace'],
                      selectable: true,
                      entries: [],
                      truncated: false
                    }
                  }
                : { url: '/fixture-preview.html' }
        });
      });
      await page.route('**/fixture-preview.html', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<p>Preview</p>' })
      );
      await page.goto(`${fixture.url}inspector-read-state.html?theme=${theme}&refresh-controls`);
      for (const action of [
        { panel: 'sign-in-refresh', selector: '.admin-sessions-heading button' },
        { panel: 'directory-refresh', selector: '.workspace-picker-toolbar-actions button' },
        { panel: 'html-refresh', selector: '.html-browser-actions button[aria-label="Reload"]' }
      ]) {
        const panel = page.getByTestId(action.panel);
        const directoryPicker = action.panel === 'directory-refresh';
        const htmlPreview = action.panel === 'html-refresh';
        if (directoryPicker)
          await panel.getByRole('button', { name: 'Open directory picker' }).click();
        const refresh = panel.locator(action.selector).first();
        await expect(refresh).toBeEnabled();
        await expect(refresh.locator('[data-mar-icon="refresh"]')).toBeVisible();
        for (failed of [false, true, false]) {
          pending = new Promise<void>((resolve) => (release = resolve));
          try {
            await refresh.click();
            const loading = refresh.locator('[data-mar-icon="loading-action"]');
            await expect(loading).toBeVisible();
            await expect(refresh).toBeDisabled();
            await expect(refresh).toHaveAttribute('aria-busy', 'true');
            await expect(refresh.locator('svg')).toHaveCount(1);
            await expect(refresh.locator('[data-mar-icon="refresh"]')).toHaveCount(0);
          } finally {
            release?.();
          }
          await expect(refresh).toBeEnabled();
          await expect(refresh).not.toHaveAttribute('aria-busy', 'true');
          await expect(refresh.locator('[data-mar-icon="refresh"]')).toBeVisible();
          await expect(refresh.locator('[data-mar-icon="loading-action"]')).toHaveCount(0);
          if (htmlPreview) {
            await expect(
              panel.frameLocator('iframe').getByText('Preview', { exact: true })
            ).toBeVisible();
            if (failed) await expect(panel.getByRole('alert')).toBeVisible();
            else await expect(panel.getByRole('alert')).toHaveCount(0);
          }
          pending = undefined;
        }
        if (directoryPicker) {
          const dialog = page.getByRole('dialog', { name: 'Register Workspace' });
          await dialog.screenshot({
            path: testInfo.outputPath(`directory-refresh-${theme}-${width}.png`),
            animations: 'disabled'
          });
          await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        }
      }
      await page.locator('.refresh-actions-fixture').screenshot({
        path: testInfo.outputPath(`refresh-actions-${theme}-${width}.png`),
        animations: 'disabled'
      });
    });

    for (const action of [
      {
        panel: 'Git History',
        selector: '.history-refresh',
        path: '/git/history'
      },
      {
        panel: 'Files',
        selector: '.explorer-toolbar > button',
        path: '/fixture/files'
      },
      {
        panel: 'Search',
        selector: '.content-search-button',
        path: '/content/search'
      }
    ]) {
      test(`${action.panel} action replaces its icon while busy: ${theme} ${width}`, async ({
        page
      }, testInfo) => {
        await page.setViewportSize({ width, height: 900 });
        let pending: Promise<void> | undefined;
        let release: (() => void) | undefined;
        let failed = false;
        await page.route('**/api/**', async (route) => {
          const path = new URL(route.request().url()).pathname;
          if (path.endsWith(action.path)) {
            await pending;
          }
          if (path.endsWith(action.path) && failed) {
            await route.fulfill({
              status: 503,
              json: { code: 'NODE_OFFLINE', message: 'Node offline' }
            });
            return;
          }
          await route.fulfill({
            json: path.endsWith('/fixture/files')
              ? { entries: [], nextCursor: null }
              : path.endsWith('/content/search')
                ? { search: { matches: [], truncated: false } }
                : path.endsWith('/git/history')
                  ? { commits: [], nextCursor: null }
                  : path.endsWith('/git/refs')
                    ? { refs: [] }
                    : path.endsWith('/git/fetch')
                      ? { fetchFailed: false }
                      : {}
          });
        });
        try {
          await page.goto(`${fixture.url}inspector-read-state.html?theme=${theme}`);
          const panel = page.getByTestId(action.panel);
          const refresh = panel.locator(action.selector).first();
          await expect(refresh).toBeEnabled();
          if (action.panel === 'Search') {
            await expect(panel.locator('.mar-ui-input [data-mar-icon="search"]')).toBeVisible();
            await panel.getByRole('textbox').fill('workspace');
            await expect(panel.locator('.file-search-empty')).toBeVisible();
          }
          if (action.panel === 'Git History')
            await expect(panel.locator('.mar-region-status')).toHaveText('No Git commit history.');
          for (failed of [false, true]) {
            pending = new Promise<void>((resolve) => {
              release = resolve;
            });
            if (action.panel === 'Search' && !failed)
              await panel.getByRole('textbox').press('Enter');
            else await refresh.click();
            await expect(refresh).toBeDisabled();
            await expect(refresh).toHaveAttribute('aria-busy', 'true');
            await expect(refresh.locator('svg')).toHaveCount(1);
            const spinner = refresh.locator('[data-mar-icon="loading-action"]');
            await expect(spinner).toBeVisible();
            await expect(spinner).not.toHaveCSS('animation-name', 'none');
            await expect(refresh.locator('[data-mar-icon="refresh"]')).toHaveCount(0);
            if (!failed)
              await refresh.screenshot({ path: testInfo.outputPath('inspector-action-busy.png') });
            release!();
            await expect(refresh).toBeEnabled();
            await expect(refresh).not.toHaveAttribute('aria-busy', 'true');
            await expect(refresh.locator('[data-mar-icon="loading-action"]')).toHaveCount(0);
            await expect(refresh.locator('[data-mar-icon="refresh"]')).toBeVisible();
          }
        } finally {
          release?.();
        }
      });
    }
  }
}

for (const theme of ['daylight', 'dark']) {
  for (const width of [1280, 390]) {
    test(`Inspector read feedback keeps text, indentation and neutral actions: ${theme} ${width}`, async ({
      browser
    }, testInfo) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        hasTouch: width === 390,
        isMobile: width === 390
      });
      const page = await context.newPage();
      try {
        for (const locale of ['en-US', 'zh-CN']) {
          let recovering = false;
          let finish!: () => void;
          const recovery = new Promise<void>((resolve) => {
            finish = resolve;
          });
          await page.unrouteAll({ behavior: 'wait' });
          await page.route('**/api/**', async (route) => {
            if (!recovering) {
              await route.fulfill({
                status: 503,
                json: { code: 'NODE_OFFLINE', message: 'Node offline' }
              });
              return;
            }
            await recovery;
            const path = new URL(route.request().url()).pathname;
            const value = path.includes('/fixture/files')
              ? { entries: [], nextCursor: null }
              : path.endsWith('/content/search')
                ? { search: { matches: [], truncated: false } }
                : path.endsWith('/git/refs')
                  ? { refs: [] }
                  : path.endsWith('/git/history')
                    ? { commits: [], nextCursor: null }
                    : path.endsWith('/files')
                      ? { files: [] }
                      : {};
            await route.fulfill({ json: value });
          });
          await page.goto(
            `${fixture.url}inspector-read-state.html?theme=${theme}&locale=${locale}`
          );
          const files = page.getByTestId('Files');
          for (const [panel, toolbarSelector] of [
            [files, '.explorer-toolbar'],
            [page.getByTestId('Search'), '.content-search-toolbar']
          ] as const) {
            const toolbar = panel.locator(toolbarSelector);
            const input = await toolbar.locator('.mar-ui-input').boundingBox();
            const action = await toolbar.locator('button').last().boundingBox();
            const bounds = await toolbar.boundingBox();
            expect(input!.x - bounds!.x).toBeGreaterThanOrEqual(6);
            expect(bounds!.x + bounds!.width - action!.x - action!.width).toBeGreaterThanOrEqual(6);
            expect(bounds!.y + bounds!.height - input!.y - input!.height).toBeGreaterThanOrEqual(6);
            await toolbar.getByRole('textbox').fill('workspace');
            await toolbar.getByRole('textbox').focus();
            await expect(toolbar.getByRole('textbox')).toBeFocused();
          }
          const searchPanel = page.getByTestId('Search').locator('.content-search');
          const searchBounds = await searchPanel.boundingBox();
          const checkbox = await searchPanel.getByRole('checkbox').boundingBox();
          const searchInput = await searchPanel.locator('.mar-ui-input').boundingBox();
          expect(checkbox!.x - searchBounds!.x).toBeGreaterThanOrEqual(6);
          expect(searchInput!.y - searchBounds!.y).toBeGreaterThanOrEqual(6);
          expect(checkbox!.y).toBeGreaterThan(searchInput!.y + searchInput!.height);
          expect(Math.abs(checkbox!.x - searchInput!.x)).toBeLessThanOrEqual(1);
          const filesBounds = await files.locator('.file-explorer').boundingBox();
          const filter = files.locator('.file-display-filter input');
          const filterBounds = await filter.boundingBox();
          expect(filterBounds!.y - filesBounds!.y).toBeGreaterThanOrEqual(6);
          await filter.clear();
          const textBounds = await files.locator('.tree-name').evaluateAll((labels) =>
            labels.map((label) => {
              const range = document.createRange();
              range.selectNodeContents(label);
              const text = range.getBoundingClientRect();
              const labelBox = label.getBoundingClientRect();
              const row = label.closest('.file-tree-row-shell')!;
              const rowBox = row.getBoundingClientRect();
              const style = getComputedStyle(label);
              return {
                name: label.textContent,
                above: text.top - rowBox.top,
                below: rowBox.bottom - text.bottom,
                labelClipAbove: text.top - labelBox.top,
                labelClipBelow: labelBox.bottom - text.bottom,
                fontSize: Number.parseFloat(style.fontSize),
                lineHeight: Number.parseFloat(style.lineHeight),
                rowHeight: rowBox.height,
                expectedRowHeight: Number.parseFloat(
                  getComputedStyle(row).getPropertyValue('--file-tree-row-size')
                )
              };
            })
          );
          expect(textBounds.length).toBeGreaterThan(0);
          for (const bounds of textBounds) {
            expect(bounds.above, `${bounds.name}: glyph space above`).toBeGreaterThanOrEqual(1);
            expect(bounds.below, `${bounds.name}: glyph space below`).toBeGreaterThanOrEqual(1);
            // Range returns line boxes, not ink; allow only subpixel offset at the label clip.
            expect(
              bounds.labelClipAbove,
              `${bounds.name}: label clip above`
            ).toBeGreaterThanOrEqual(-0.5);
            expect(
              bounds.labelClipBelow,
              `${bounds.name}: label clip below`
            ).toBeGreaterThanOrEqual(-0.5);
            expect(bounds.lineHeight).toBeCloseTo(bounds.fontSize * 1.5, 2);
            expect(bounds.rowHeight).toBeCloseTo(bounds.expectedRowHeight, 2);
          }
          const rootRow = files.locator('[data-file-path="."]');
          await rootRow.click();
          await expect(rootRow).toHaveAttribute('aria-expanded', 'false');
          await rootRow.click();
          await expect(rootRow).toHaveAttribute('aria-expanded', 'true');
          await expect(rootRow).toHaveAttribute('aria-selected', 'true');
          const treeBounds = await files.locator('.workspace-file-tree').boundingBox();
          const selectionBounds = await files
            .locator('.file-tree-row-shell.selected')
            .boundingBox();
          expect(selectionBounds!.x - treeBounds!.x).toBeGreaterThanOrEqual(6);
          expect(
            treeBounds!.x + treeBounds!.width - selectionBounds!.x - selectionBounds!.width
          ).toBeGreaterThanOrEqual(6);
          expect(selectionBounds!.y - treeBounds!.y).toBeGreaterThanOrEqual(4);
          if (width >= 768) {
            const child = files.locator('[data-file-path="src/existing.ts"]');
            await child.hover();
            const hoverBounds = await child.locator('..').boundingBox();
            expect(hoverBounds!.x).toBe(selectionBounds!.x);
            expect(hoverBounds!.width).toBe(selectionBounds!.width);
          }
          await files.screenshot({ path: testInfo.outputPath(`files-toolbar-${locale}.png`) });
          await searchPanel.screenshot({
            path: testInfo.outputPath(`search-toolbar-${locale}.png`)
          });
          const nestedRetry = files.locator('.file-tree-load-more button').first();
          await expectReadableState(nestedRetry);
          const retries = files.locator('.file-tree-load-more button');
          for (const [index, path] of ['src/nested/existing.ts', 'src/existing.ts'].entries()) {
            const label = files.locator(`[data-file-path="${path}"] .tree-name`);
            const textLeft = await retries
              .nth(index)
              .locator('span')
              .evaluate((element) => {
                const range = document.createRange();
                range.selectNodeContents(element);
                return range.getBoundingClientRect().x;
              });
            expect(Math.abs(textLeft - (await label.boundingBox())!.x)).toBeLessThanOrEqual(1);
          }
          const search = page.getByTestId('Search').locator('button.watch-status');
          const changes = page.getByTestId('Git Changes').locator('.changes-read-state button');
          const history = page.getByTestId('Git History').locator('button.history-load-more');
          const commitFiles = page.getByTestId('Commit files');
          await commitFiles.locator('.history-commit-row').click();
          const commitRetry = commitFiles.locator('.history-files .mar-empty button');
          for (const button of [search, changes, history, commitRetry])
            await expectReadableState(button);
          await page.screenshot({
            path: testInfo.outputPath(`inspector-errors-${locale}.png`),
            fullPage: true
          });

          recovering = true;
          for (const button of [nestedRetry, search, changes, history, commitRetry]) {
            await button.click();
            await expect(button).toHaveAttribute('aria-busy', 'true');
            await expectReadableState(button);
            await expect(button.locator('[data-mar-icon="loading-action"]')).toBeVisible();
          }
          finish();
          for (const button of [search, changes, history, commitRetry])
            await expect(button).toHaveCount(0);
          await expect(retries).toHaveCount(1);
          await retries.click();
          await expect(retries).toHaveCount(0);

          await page.getByRole('button', { name: 'Fail Files Watch', exact: true }).click();
          const watchRetry = files.locator('button.files-read-retry');
          await expectReadableState(watchRetry);
          await watchRetry.click();
          await expect(watchRetry).toHaveCount(0);
          await page.getByRole('button', { name: 'Fail Files refresh', exact: true }).click();
          const refreshRetry = files.locator('button.files-read-retry');
          await expectReadableState(refreshRetry);
          await refreshRetry.click();
          await expect(refreshRetry).toHaveCount(0);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
          ).toBeLessThanOrEqual(1);
        }
      } finally {
        await context.close();
      }
    });
  }
}
