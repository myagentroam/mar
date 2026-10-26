import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

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
            await route.fulfill({ status: 404, body: 'FILE_NOT_FOUND' });
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
        .locator('.inspector-tabs')
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
        .locator('.inspector-tabs')
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
      await expect(page.locator('.file-preview-content > .empty')).toContainText('download');
      await expect(preview).toHaveCount(0);
      const deletedReads = requests.filter((url) => url.searchParams.get('path') === 'deleted.svg');
      expect(deletedReads.length).toBeGreaterThan(0);
      expect(
        deletedReads.every((url) => url.pathname.endsWith(`/git/commits/${hash}/files/content`))
      ).toBe(true);
    });
  });
}
