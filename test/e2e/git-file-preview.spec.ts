import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const [locale, theme, width, historyLabel, filesLabel, copyLabel, copiedLabel] of [
  ['en-US', 'daylight', 1280, 'Git History', 'Files', 'Copy commit ID', 'Commit ID copied.'],
  ['zh-CN', 'vscode-dark-2026', 390, 'Git 历史', '文件', '复制 Commit ID', '已复制 Commit ID。']
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
    for (const theme of ['daylight', 'vscode-dark-2026']) {
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
