import { expect, test, type Page } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

async function openInspector(page: Page, mobile: boolean): Promise<void> {
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  const work = page.getByRole('button', { name: '工作', exact: true });
  await work.click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  if (mobile) await work.click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  if (mobile) await page.getByRole('button', { name: '打开辅助工作面', exact: true }).click();
  await expect(page.locator('.workspace-inspector')).toBeVisible();
}

for (const mobile of [false, true]) {
  test.describe(`Inspector domains ${mobile ? 'mobile' : 'desktop'}`, () => {
    test.use(
      mobile
        ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
        : { viewport: { width: 1365, height: 900 } }
    );

    test('keeps edits made during save, preserves conflicts, and separates refresh failure', async ({
      page
    }) => {
      await mockConsoleApi(
        page,
        'MANAGED',
        ['history.read', 'turn.start'],
        [],
        'GIT_WORKSPACE',
        true,
        undefined,
        undefined,
        '0.9.12'
      );
      const initial = 'export const value = 1;';
      let failRefresh = false;
      await page.route(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/, (route) =>
        failRefresh
          ? json(
              route,
              {
                error: {
                  code: 'FILES_REFRESH_FAILED',
                  message: 'The file list could not refresh.',
                  requestId: 'refresh-request'
                }
              },
              503
            )
          : json(route, {
              files: {
                entries: [
                  {
                    path: 'main.ts',
                    name: 'main.ts',
                    kind: 'FILE',
                    size: initial.length,
                    modifiedAt: 1
                  }
                ],
                nextCursor: null,
                truncated: false
              }
            })
      );
      await page.route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, (route) =>
        json(route, {
          file: {
            path: 'main.ts',
            encoding: 'utf-8',
            size: initial.length,
            content: initial,
            nextOffset: null,
            revision: 'a'.repeat(64)
          }
        })
      );
      const writes: { content: string; expectedRevision: string; path: string; nodeId: string }[] =
        [];
      let releaseWrite: (() => void) | undefined;
      const firstWrite = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      await page.route('**/api/workspaces/workspace-1/files/write', async (route) => {
        writes.push(route.request().postDataJSON());
        const index = writes.length;
        if (index === 1) await firstWrite;
        if (index === 2)
          return json(
            route,
            {
              error: {
                code: 'FILE_WRITE_CONFLICT',
                message: 'The file changed before saving.',
                requestId: 'write-conflict'
              }
            },
            409
          );
        return json(route, {
          file: {
            path: 'main.ts',
            revision: (index === 1 ? 'b' : 'c').repeat(64),
            size: writes[index - 1]!.content.length
          }
        });
      });
      await openInspector(page, mobile);
      await page.getByRole('treeitem', { name: 'main.ts', exact: true }).click();
      const preview = page.getByRole('dialog', { name: 'main.ts 文件预览' });
      const editor = preview.locator('.cm-content');
      const save = preview
        .getByRole('button', { name: '保存', exact: true, includeHidden: true })
        .first();
      await expect(editor).toHaveText(initial);
      await editor.fill('submitted text');
      await editor.press('Control+s');
      await expect.poll(() => writes.length).toBe(1);
      await editor.fill('new edits made during save');
      releaseWrite!();
      await expect(save).toBeEnabled();
      await expect(editor).toHaveText('new edits made during save');
      await editor.press('Control+s');
      await expect.poll(() => writes.length).toBe(2);
      await expect(
        page.getByRole('alert').filter({ hasText: '文件已被其他操作修改，请重新加载后再编辑。' })
      ).toBeVisible();
      await expect(editor).toHaveText('new edits made during save');
      await expect(save).toBeEnabled();
      expect(writes[0]).toEqual({
        nodeId: 'node-1',
        path: 'main.ts',
        content: 'submitted text',
        expectedRevision: 'a'.repeat(64)
      });
      expect(writes[1]!.expectedRevision).toBe('b'.repeat(64));
      failRefresh = true;
      const failedRefresh = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/workspaces/workspace-1/files' &&
          response.status() === 503
      );
      await editor.press('Control+s');
      await failedRefresh;
      await expect.poll(() => writes.length).toBe(3);
      await expect(page.getByText(/FILES_REFRESH_FAILED/)).toBeVisible();
      await expect(save).toBeDisabled();
      await expect(editor).toHaveText('new edits made during save');
      expect(writes[2]!.expectedRevision).toBe('b'.repeat(64));
      await page.getByRole('button', { name: '关闭文件窗口', exact: true }).click();
      await expect(page.locator('.workspace-file-tabs')).toHaveCount(0);
      await expect(page.locator('.el-message-box')).toHaveCount(0);
    });

    test('keeps the Git history menu in the viewport and releases it on section changes', async ({
      page
    }) => {
      await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
      const commit = 'a'.repeat(40);
      await page.route(/\/api\/workspaces\/workspace-1\/git\/refs(?:\?.*)?$/, (route) =>
        json(route, {
          refs: [
            {
              name: 'refs/heads/main',
              displayName: 'main',
              kind: 'LOCAL',
              hash: commit,
              current: true
            }
          ]
        })
      );
      await page.route(/\/api\/workspaces\/workspace-1\/git\/history(?:\?.*)?$/, (route) =>
        json(route, {
          commits: [
            {
              hash: commit,
              parents: [],
              subject: 'Inspectable commit',
              authorName: 'A long author name for a narrow viewport',
              authorEmail: 'author@example.invalid',
              committedAt: 1_900_000_000_000,
              refs: ['main']
            }
          ],
          nextCursor: null
        })
      );
      await openInspector(page, mobile);
      await page.getByRole('tab', { name: 'Git 历史', exact: true }).click();
      const row = page.locator('.history-commit-row').first();
      await expect(row).toContainText('Inspectable commit');
      await row.click({ button: 'right' });
      const menu = page
        .getByRole('menu')
        .filter({ has: page.getByRole('menuitem', { name: '复制 Commit ID' }) });
      await expect(menu).toBeVisible();
      const bounds = await menu.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await row.click({ button: 'right' });
      await page.getByRole('tab', { name: '文件', exact: true }).click();
      await expect(menu).toHaveCount(0);
      await page.getByRole('tab', { name: 'Git 历史', exact: true }).click();
      await expect(row).toContainText('Inspectable commit');
      await row.click({ button: 'right' });
      await expect(menu).toBeVisible();
      await page.keyboard.press('Escape');
    });
  });
}
