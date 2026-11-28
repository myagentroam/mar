import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const changed of [false, true]) {
  test(`opens one file dialog before Changes resolves (${changed ? 'Diff' : 'source'})`, async ({
    page
  }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reached: string[] = [];
    await page.route('**/api/workspaces/workspace/**', async (route) => {
      const { pathname } = new URL(route.request().url());
      reached.push(pathname);
      if (pathname.endsWith('/changes')) {
        await gate;
        const changes = changed
          ? [
              {
                repositoryPath: '',
                repositoryName: 'project',
                source: 'ROOT',
                path: 'comparison.ts',
                state: 'UNSTAGED',
                change: 'MODIFIED',
                diffAvailable: true
              }
            ]
          : [];
        return route.fulfill({
          json: {
            changes,
            worktrees: [],
            repositories: [
              {
                repositoryPath: '',
                repositoryName: 'project',
                source: 'ROOT',
                current: true,
                branch: 'main',
                changes
              }
            ]
          }
        });
      }
      if (pathname.endsWith('/diff'))
        return route.fulfill({
          json: {
            diff: {
              text: 'diff --git a/comparison.ts b/comparison.ts\n--- a/comparison.ts\n+++ b/comparison.ts\n@@ -1 +1 @@\n-old value\n+new value'
            }
          }
        });
      return route.fulfill({
        json: {
          file: {
            encoding: 'utf-8',
            size: 25,
            content: '// source\nconst answer=42',
            nextOffset: null,
            revision: 'r1'
          }
        }
      });
    });
    await page.goto(`${fixture.url}file-tabs.html?preview-preflight`);
    const trigger = page.getByRole('button', { name: 'Open comparison' });
    const dialog = page
      .locator('dialog[open]')
      .filter({ has: page.locator('.file-preview-surface') });
    const close = dialog.getByRole('button', { name: 'Close file window' });
    await trigger.press('Enter');
    try {
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('tab', { name: 'comparison.ts' })).toBeVisible();
      await expect(dialog.locator('.file-preview-loading')).toBeVisible();
      await expect.poll(() => reached.length).toBe(1);
      await expect(close).toBeFocused();
    } finally {
      release();
    }
    if (changed) await expect(dialog.locator('code')).toContainText('+new value');
    else
      await expect(dialog.locator('.cm-code-navigation-destination')).toHaveText('const answer=42');
    await expect(close).toBeFocused();
    await expect(dialog).toHaveCount(1);
    expect(reached.filter((path) => path.endsWith('/diff'))).toHaveLength(Number(changed));
    expect(reached.some((path) => path.endsWith('/files/read'))).toBe(!changed);
    await close.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
}

for (const closeEarly of [false, true]) {
  test(`keeps failed Changes in the dialog (${closeEarly ? 'early close' : 'inline retry'})`, async ({
    page
  }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let queries = 0;
    let reads = 0;
    await page.route('**/api/workspaces/workspace/**', async (route) => {
      if (new URL(route.request().url()).pathname.endsWith('/changes')) {
        if (++queries === 1)
          return route.fulfill({
            status: 503,
            json: { error: { code: 'FIXTURE_CHANGES_UNAVAILABLE', message: 'Changes unavailable' } }
          });
        await gate;
        return route.fulfill({ json: { changes: [], worktrees: [], repositories: [] } });
      }
      reads += 1;
      return route.fulfill({
        json: {
          file: { encoding: 'utf-8', size: 7, content: 'retried', nextOffset: null, revision: 'r1' }
        }
      });
    });
    await page.goto(`${fixture.url}file-tabs.html?preview-preflight`);
    const dialog = page
      .locator('dialog[open]')
      .filter({ has: page.locator('.file-preview-surface') });
    await page.getByRole('button', { name: 'Open comparison' }).click();
    await expect(dialog.locator('.file-preview-state')).toContainText('Unable to load the file');
    expect(reads).toBe(0);
    await dialog.getByRole('button', { name: 'Retry' }).press('Enter');
    try {
      await expect.poll(() => queries).toBe(2);
      const busy = dialog.getByRole('button', { name: 'Loading…' });
      await expect(busy).toHaveAttribute('aria-busy', 'true');
      await expect(busy).toBeFocused();
      await page.keyboard.press('Enter');
      expect(queries).toBe(2);
      if (closeEarly) {
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveAttribute('data-closing', 'true');
      }
    } finally {
      release();
    }
    if (closeEarly) {
      await expect(dialog).toHaveCount(0);
      expect(reads).toBe(0);
    } else {
      await expect(dialog.locator('.cm-content')).toContainText('retried');
      await expect(dialog.getByRole('button', { name: 'Close file window' })).toBeFocused();
      expect(reads).toBe(1);
    }
  });
}

test('opens a temporary file before validation and never shows unvalidated content', async ({
  page
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const limits: string[] = [];
  await page.route('**/api/workspaces/workspace/files/read?*', async (route) => {
    const limit = new URL(route.request().url()).searchParams.get('limit')!;
    limits.push(limit);
    if (limit === '1') await gate;
    return route.fulfill({
      json: {
        file: {
          encoding: 'utf-8',
          size: 12,
          content: limit === '1' ? 'p' : 'private text',
          nextOffset: limit === '1' ? 1 : null,
          revision: 'r1'
        }
      }
    });
  });
  await page.goto(`${fixture.url}file-tabs.html?preview-preflight`);
  const dialog = page
    .locator('dialog[open]')
    .filter({ has: page.locator('.file-preview-surface') });
  await page.getByRole('button', { name: 'Open temporary file' }).click();
  try {
    await expect(dialog.getByRole('tab', { name: 'temp.ts' })).toBeVisible();
    await expect(dialog.locator('.file-preview-loading')).toBeVisible();
    await expect.poll(() => limits).toEqual(['1']);
    await expect(dialog.locator('.cm-content')).toHaveCount(0);
  } finally {
    release();
  }
  await expect(dialog.locator('.cm-content')).toContainText('private text');
});

test('closing a temporary file during validation does not start its body read', async ({
  page
}) => {
  const gate = Promise.withResolvers<void>();
  const validationHandled = Promise.withResolvers<void>();
  const limits: string[] = [];
  await page.route('**/api/workspaces/workspace/files/read?*', async (route) => {
    const limit = new URL(route.request().url()).searchParams.get('limit')!;
    limits.push(limit);
    if (limit === '1') await gate.promise;
    try {
      await route.fulfill({
        json: {
          file: { encoding: 'utf-8', size: 1, content: 'p', nextOffset: null, revision: 'r1' }
        }
      });
    } finally {
      if (limit === '1') validationHandled.resolve();
    }
  });
  await page.goto(`${fixture.url}file-tabs.html?preview-preflight`);
  await page.addStyleTag({
    content: 'dialog[data-closing="true"] { animation-play-state: paused !important; }'
  });
  const dialog = page
    .locator('dialog[open]')
    .filter({ has: page.locator('.file-preview-surface') });
  const trigger = page.getByRole('button', { name: 'Open temporary file' });
  await trigger.press('Enter');
  try {
    await expect.poll(() => limits).toEqual(['1']);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveAttribute('data-closing', 'true');
  } finally {
    gate.resolve();
  }
  await validationHandled.promise;
  await dialog.evaluate(async (element) => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    element.getAnimations().forEach((animation) => animation.finish());
  });
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(limits).toEqual(['1']);
  await trigger.press('Enter');
  await expect(dialog.locator('.cm-content')).toHaveText('p');
  expect(limits).toEqual(['1', '1', '4096']);
});

for (const [locale, theme, width, historyLabel, filesLabel, copyLabel, copiedLabel] of [
  ['en-US', 'daylight', 1280, 'Git History', 'Files', 'Copy commit ID', 'Commit ID copied.'],
  ['zh-CN', 'dark', 390, 'Git 历史', '文件', '复制 Commit ID', '已复制 Commit ID。']
] as const) {
  test.describe(`Git History menu in ${locale}`, () => {
    test.use({ locale, viewport: { width, height: 900 } });

    test('uses the standard context menu to copy the targeted commit and report the result', async ({
      page
    }) => {
      const commits = ['a', 'b'].map((char, index) => ({
        hash: char.repeat(40),
        parents: [],
        subject: index ? 'Second commit' : 'First commit',
        authorName: 'Example',
        authorEmail: 'example@example.com',
        committedAt: 2 - index,
        refs: []
      }));
      const copied: string[] = [];
      let rejectCopy = false;
      await page.exposeFunction('copyCommitInFixture', (hash: string) => {
        copied.push(hash);
        return !rejectCopy;
      });
      await page.addInitScript(() => {
        const { copyCommitInFixture } = window as Window & {
          copyCommitInFixture(hash: string): Promise<boolean>;
        };
        const clipboardDenied = new Error('Clipboard access denied');
        window.addEventListener('fixture-history-notice', (event) => {
          if ((event as CustomEvent).detail === clipboardDenied)
            document.documentElement.dataset['clipboardCauseForwarded'] = 'true';
        });
        Object.defineProperty(navigator, 'clipboard', {
          value: {
            async writeText(hash: string) {
              if (!(await copyCommitInFixture(hash))) throw clipboardDenied;
            }
          }
        });
      });
      await page.route('**/api/workspaces/workspace/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        const json = path.endsWith('/git/history')
          ? { commits, nextCursor: null }
          : path.endsWith('/git/refs')
            ? { refs: [] }
            : { entries: [], nextCursor: null };
        await route.fulfill({ json });
      });
      await page.goto(
        `${fixture.url}workbench-style.html?git-previews=1&theme=${theme}&locale=${locale}`
      );
      const inspector = page.getByRole('region', { name: 'Inspector fixture' });
      const historyTab = inspector.getByRole('tab', { name: historyLabel, exact: true });
      const filesTab = inspector.getByRole('tab', { name: filesLabel, exact: true });
      await historyTab.click();
      const firstRow = inspector.getByRole('button', { name: /First commit/ });
      const secondRow = inspector.getByRole('button', { name: /Second commit/ });
      const menu = page.locator('.mar-ui-dropdown__popup:popover-open');
      const copy = menu.getByRole('menuitem', { name: copyLabel });
      const feedback = page.getByLabel('File operation feedback');

      await firstRow.click({ button: 'right' });
      await expect(copy).toBeFocused();
      await expect(menu).toHaveAccessibleName(historyLabel);
      await expect(menu).not.toHaveAttribute('data-arrow', '');
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(firstRow).toBeFocused();
      expect(copied).toEqual([]);

      await firstRow.click({ button: 'right' });
      await secondRow.click({ button: 'right', position: { x: 8, y: 18 } });
      await expect(menu).toHaveCount(1);
      await copy.press('Enter');
      await expect(menu).toHaveCount(0);
      await expect(feedback).toHaveText(copiedLabel);
      await expect(feedback).toHaveAttribute('data-type', 'info');
      expect(copied).toEqual([commits[1]!.hash]);

      rejectCopy = true;
      await firstRow.click({ button: 'right' });
      await copy.click();
      await expect(menu).toHaveCount(0);
      await expect(feedback).toHaveText('Clipboard access denied');
      await expect(feedback).toHaveAttribute('data-type', 'error');
      await expect(page.locator('html')).toHaveAttribute('data-clipboard-cause-forwarded', 'true');
      expect(copied).toEqual([commits[1]!.hash, commits[0]!.hash]);

      await firstRow.click({ button: 'right' });
      await expect(copy).toBeFocused();
      // Switch without a pointer or focus change so outside dismissal cannot hide an unmount leak.
      await filesTab.evaluate((tab: HTMLButtonElement) => tab.click());
      await expect(menu).toHaveCount(0);
      await historyTab.click();
      await expect(firstRow).toBeVisible();
      await expect(menu).toHaveCount(0);
    });
  });
}

for (const width of [1280, 390]) {
  test.describe(`Git preview at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, isMobile: width < 768, hasTouch: width < 768 });
    for (const theme of ['daylight', 'dark']) {
      test(`Git History expansions share the list surface in ${theme} at ${width}px`, async ({
        page
      }) => {
        const changes = [
          {
            repositoryPath: '',
            repositoryName: 'project',
            source: 'ROOT',
            path: 'src/app.ts',
            state: 'UNSTAGED',
            change: 'MODIFIED',
            diffAvailable: true
          }
        ];
        const commits = ['a', 'b'].map((character, index) => ({
          hash: character.repeat(40),
          parents: index === 0 ? ['b'.repeat(40)] : [],
          subject: index === 0 ? 'Update source' : 'Empty commit',
          authorName: 'Example',
          authorEmail: 'example@example.com',
          committedAt: 2 - index,
          refs: []
        }));
        await page.route('**/api/workspaces/workspace/**', async (route) => {
          const path = new URL(route.request().url()).pathname;
          if (path.endsWith('/changes')) {
            await route.fulfill({
              json: {
                workspace: { id: 'workspace', kind: 'GIT_WORKSPACE', path: '/project' },
                changes,
                worktrees: [],
                repositories: [
                  {
                    repositoryPath: '',
                    repositoryName: 'project',
                    source: 'ROOT',
                    current: true,
                    branch: 'main',
                    changes
                  }
                ]
              }
            });
          } else if (path.endsWith('/git/refs')) {
            await route.fulfill({ json: { refs: [] } });
          } else if (path.endsWith('/git/history')) {
            await route.fulfill({ json: { commits, nextCursor: null } });
          } else if (path.endsWith('/files') && path.includes('/git/commits/')) {
            await route.fulfill({
              json: {
                files: path.includes(commits[0]!.hash)
                  ? [{ path: 'src/app.ts', change: 'MODIFIED' }]
                  : []
              }
            });
          } else {
            await route.fulfill({ json: { entries: [], nextCursor: null } });
          }
        });
        await page.goto(`${fixture.url}workbench-style.html?git-previews=1&theme=${theme}`);
        const inspector = page.getByRole('region', { name: 'Inspector fixture' });
        await inspector.getByRole('tab', { name: 'Git Changes', exact: true }).click();
        const changeFile = inspector.locator('.change-file-name').first();
        await expect(changeFile).toHaveText('app.ts');
        const fileFontSize = await changeFile.evaluate(
          (element) => getComputedStyle(element).fontSize
        );
        await inspector.getByRole('tab', { name: 'Git History', exact: true }).click();
        const populatedCommit = inspector
          .locator('.history-commit')
          .filter({ hasText: 'Update source' });
        await populatedCommit.locator('.history-commit-row').click();
        await expect(populatedCommit.locator('.history-directory')).toContainText('src');
        await expect(populatedCommit.locator('.history-directory')).toHaveCSS(
          'font-size',
          fileFontSize
        );
        await populatedCommit.locator('.history-directory').click();
        await expect(populatedCommit.locator('.history-file-path')).toHaveText('app.ts');
        await expect(populatedCommit.locator('.history-file-path')).toHaveCSS(
          'font-size',
          fileFontSize
        );
        const emptyCommit = inspector
          .locator('.history-commit')
          .filter({ hasText: 'Empty commit' });
        await emptyCommit.locator('.history-commit-row').click();
        await expect(emptyCommit.locator('[role="status"]')).toHaveCount(0);
        await expect(emptyCommit.locator('.history-files > li')).toHaveCount(0);
        await expect(emptyCommit.locator('.history-expanded')).toHaveCSS('height', '0px');
        for (const commit of [populatedCommit, emptyCommit]) {
          const files = commit.locator('.history-files');
          await expect(files).toHaveCSS('border-top-width', '0px');
          await expect(files).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        }
      });
    }
    test(`Git Changes and History open versioned image previews at ${width}px`, async ({
      page
    }, testInfo) => {
      const hash = 'a'.repeat(40);
      const requests: URL[] = [];
      const image =
        '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#3093ff"/></svg>';
      const change = {
        repositoryPath: '',
        repositoryName: 'project',
        source: 'ROOT',
        path: 'art.svg',
        state: 'UNSTAGED',
        change: 'MODIFIED',
        diffAvailable: true
      };
      await page.route('**/api/workspaces/workspace/**', async (route) => {
        const url = new URL(route.request().url());
        requests.push(url);
        const path = url.pathname;
        if (path.endsWith('/files/content')) {
          if (url.searchParams.get('path') === 'deleted.svg') {
            await route.fulfill({
              status: 404,
              json: { error: { code: 'FILE_NOT_FOUND', message: 'File was not found.' } }
            });
            return;
          }
          const content = path.includes('/git/commits/')
            ? image.replace('width="80"', 'width="64"')
            : image;
          await route.fulfill({
            status: 206,
            contentType: 'image/svg+xml',
            headers: { 'Content-Range': `bytes 0-${content.length - 1}/${content.length}` },
            body: content
          });
        } else if (path.endsWith('/changes')) {
          await route.fulfill({
            json: {
              workspace: { id: 'workspace', kind: 'GIT_WORKSPACE', path: '/project' },
              changes: [change],
              worktrees: [],
              repositories: [
                {
                  repositoryPath: '',
                  repositoryName: 'project',
                  source: 'ROOT',
                  current: true,
                  branch: 'main',
                  changes: [change]
                }
              ]
            }
          });
        } else if (path.endsWith('/git/refs')) {
          await route.fulfill({ json: { refs: [] } });
        } else if (path.endsWith('/git/history')) {
          await route.fulfill({
            json: {
              commits: [
                {
                  hash,
                  parents: [],
                  subject: 'Add artwork',
                  authorName: 'Example',
                  authorEmail: 'example@example.com',
                  committedAt: 1,
                  refs: []
                }
              ],
              nextCursor: null
            }
          });
        } else if (path.endsWith(`/git/commits/${hash}/files`)) {
          await route.fulfill({
            json: {
              files: [
                { path: 'art.svg', change: 'ADDED' },
                { path: 'deleted.svg', change: 'DELETED' }
              ]
            }
          });
        } else {
          await route.fulfill({ json: { entries: [], nextCursor: null } });
        }
      });
      await page.goto(`${fixture.url}workbench-style.html?git-previews=1`);
      const inspector = page.getByRole('region', { name: 'Inspector fixture' });
      await inspector
        .locator('.workbench-aside-tabs')
        .getByRole('tab', { name: 'Git Changes', exact: true })
        .click();
      const changedFile = inspector.locator('.change-path').filter({ hasText: 'art.svg' });
      await expect(changedFile).toHaveAttribute('aria-label', /Preview/);
      await changedFile.click();
      const preview = page.locator('.file-binary-preview:visible');
      await expect(preview).toHaveAttribute('alt', 'art.svg');
      await expect
        .poll(() => preview.evaluate((element) => (element as HTMLImageElement).naturalWidth))
        .toBe(80);
      expect(requests.some((url) => url.pathname.endsWith('/changes/diff'))).toBe(false);
      await expect(page.locator('.workspace-file-tab')).toHaveCount(1);
      await page.getByRole('button', { name: 'Close file window', exact: true }).click();

      await inspector
        .locator('.workbench-aside-tabs')
        .getByRole('tab', { name: 'Git History', exact: true })
        .click();
      await inspector.locator('.history-commit-row').filter({ hasText: 'Add artwork' }).click();
      await inspector
        .locator('.history-files')
        .getByRole('button')
        .filter({ hasText: 'art.svg' })
        .click();
      await expect(preview).toHaveAttribute('alt', 'art.svg');
      await expect
        .poll(() => preview.evaluate((element) => (element as HTMLImageElement).naturalWidth))
        .toBe(64);
      expect(
        requests.some((url) => url.pathname.endsWith(`/git/commits/${hash}/files/content`))
      ).toBe(true);
      expect(requests.some((url) => url.pathname.endsWith('/diff'))).toBe(false);
      await expect(page.locator('.workspace-file-tab')).toHaveCount(1);
      await page
        .getByRole('dialog')
        .screenshot({ path: testInfo.outputPath('git-history-preview.png') });
      await page.getByRole('button', { name: 'Close file window', exact: true }).click();
      await inspector
        .locator('.history-files')
        .getByRole('button')
        .filter({ hasText: 'deleted.svg' })
        .click();
      const failure = page
        .getByRole('dialog', { name: 'deleted.svg file preview', exact: true })
        .locator('.file-preview-state');
      await expect(failure.getByRole('status')).toContainText('Unable to preview this file.');
      await expect(
        failure.getByRole('button', { name: 'Download file', exact: true })
      ).toBeVisible();
      await expect(preview).toHaveCount(0);
      const deletedReads = requests.filter((url) => url.searchParams.get('path') === 'deleted.svg');
      expect(deletedReads.length).toBeGreaterThan(0);
      expect(
        deletedReads.every((url) => url.pathname.endsWith(`/git/commits/${hash}/files/content`))
      ).toBe(true);
    });
  });
}
