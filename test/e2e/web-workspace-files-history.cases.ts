import { expect, test } from '@playwright/test';
import { recordWebm, silentWave } from './support/file-preview-media.js';
import {
  fulfillMockWorkspaceWatch,
  json,
  mockConsoleApi,
  write
} from './support/web-console-api.js';

// Git history, binary previews, uploads, notifications, and the resource tree

function onePagePdf(): Buffer {
  const stream = 'BT /F1 18 Tf 72 720 Td (MyAgentRoam PDF) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(source);
}

function minimalSpreadsheet(): Buffer {
  return Buffer.from(
    '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',
    'base64'
  );
}

test('Git History filters all or selected branches, expands commit files, and opens diffs', async ({
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
    '0.9.6',
    true
  );
  let historyRequests = 0;
  let holdHistoryRefresh = false;
  let releaseHistoryRefresh: (() => void) | undefined;
  await page.route(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/, (route) =>
    json(route, { files: { entries: [], nextCursor: null, truncated: false } })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/changes(?:\?.*)?$/, (route) =>
    json(route, {
      branch: 'main',
      changes: [],
      repositories: [
        { repositoryPath: '', repositoryName: '根仓库', branch: 'main', changes: [] },
        {
          repositoryPath: 'modules/child',
          repositoryName: 'modules/child',
          branch: 'main',
          changes: []
        }
      ]
    })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/git\/refs(?:\?.*)?$/, (route) =>
    json(route, {
      refs: [
        {
          name: 'refs/heads/main',
          displayName: 'main',
          kind: 'LOCAL',
          hash: 'a'.repeat(40),
          current: true
        },
        {
          name: 'refs/remotes/origin/main',
          displayName: 'origin/main',
          kind: 'REMOTE',
          hash: 'a'.repeat(40),
          current: false
        }
      ]
    })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/git\/history(?:\?.*)?$/, async (route) => {
    historyRequests += 1;
    if (holdHistoryRefresh) {
      await new Promise<void>((resolve) => {
        releaseHistoryRefresh = resolve;
      });
      return json(route, { error: { code: 'HISTORY_REFRESH_FAILED' } }, 503);
    }
    return json(route, {
      commits: [
        {
          hash: 'a'.repeat(40),
          parents: [],
          subject: '初始化 Git History',
          authorName: 'Tester',
          authorEmail: 'test@example.invalid',
          committedAt: 1_900_000_000_000,
          refs: ['main', 'origin/main']
        }
      ],
      nextCursor: null
    });
  });
  await page.route(
    /\/api\/workspaces\/workspace-1\/git\/commits\/[a-f0-9]+\/files(?:\?.*)?$/,
    (route) =>
      json(route, {
        files: [
          { path: 'README.md', change: 'MODIFIED' },
          { path: 'src/history.ts', change: 'ADDED' },
          { path: 'src/photo.png', change: 'ADDED' },
          { path: 'src/nested/deeper.ts', change: 'MODIFIED' }
        ]
      })
  );
  await page.route(
    /\/api\/workspaces\/workspace-1\/git\/commits\/[a-f0-9]+\/diff(?:\?.*)?$/,
    (route) =>
      json(route, {
        diff: {
          binary: false,
          text: 'diff --git a/src/history.ts b/src/history.ts\nindex 1111111..2222222 100644\n--- a/src/history.ts\n+++ b/src/history.ts\n@@ -1,3 +1,3 @@\n - Markdown context item\n-legacy\n-\n+history\n+',
          truncated: false
        }
      })
  );

  await page.goto('/console');
  await page.getByLabel('密码').fill('test-password');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.getByRole('tab', { name: 'Git 历史' }).click();
  await expect(page.getByRole('combobox', { name: '选择 Git 仓库' })).toHaveValue('');
  await expect(page.getByText('初始化 Git History')).toBeVisible();
  await expect.poll(() => historyRequests).toBe(1);
  holdHistoryRefresh = true;
  await page.getByRole('tab', { name: 'Git 变更' }).click();
  await page.getByRole('tab', { name: 'Git 历史' }).click();
  await expect.poll(() => historyRequests).toBe(2);
  await expect.poll(() => releaseHistoryRefresh !== undefined).toBe(true);
  await expect(page.getByText('初始化 Git History')).toBeVisible();
  releaseHistoryRefresh?.();
  const historyRefreshButton = page.getByRole('button', { name: '刷新 Git 历史', exact: true });
  await expect(historyRefreshButton).toBeEnabled();
  await expect(historyRefreshButton).toHaveAttribute('type', 'button');
  await expect(historyRefreshButton).toHaveClass(/file-explorer-utility-button/u);
  await expect(historyRefreshButton).toHaveClass(/utility-control/u);
  await expect(historyRefreshButton).not.toHaveClass(/el-button/u);
  holdHistoryRefresh = false;
  await expect(page.getByText('初始化 Git History')).toBeVisible();
  await expect(page.getByText('aaaaaaaa')).toHaveCount(0);
  await page.locator('.history-filter').nth(1).locator('.el-select__wrapper').click();
  await page.getByRole('option', { name: 'main', exact: true }).click();
  await expect(page.getByText('初始化 Git History')).toBeVisible();
  await page.getByText('初始化 Git History').click();
  await expect(page.getByRole('button', { name: /README\.md/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'src', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /src\/history.ts/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'nested', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /src\/nested\/deeper.ts/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'src', exact: true }).click();
  await expect(page.getByRole('button', { name: /history\.ts/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'nested', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /deeper\.ts/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'nested', exact: true }).click();
  await expect(page.getByRole('button', { name: /deeper\.ts/ })).toBeVisible();
  await page
    .context()
    .route(/\/api\/workspaces\/workspace-1\/git\/commits\/[a-f0-9]+\/diff(?:\?.*)?$/, (route) => {
      const path = new URL(route.request().url()).searchParams.get('path');
      if (path === 'src/photo.png')
        return json(route, { diff: { binary: true, truncated: false } });
      if (path === 'src/nested/deeper.ts')
        return json(
          route,
          {
            error: {
              code: 'GIT_DIFF_UNAVAILABLE',
              message: 'Cannot read the selected Diff.',
              requestId: 'request-popup-1'
            }
          },
          403
        );
      return json(route, {
        diff: { binary: false, text: '@@ -1 +1 @@\n-before\n+history-popup', truncated: false }
      });
    });
  await page
    .context()
    .route(
      /\/api\/workspaces\/workspace-1\/git\/commits\/[a-f0-9]+\/files\/content(?:\?.*)?$/,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'image/png',
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64'
          )
        })
    );
  const historyPopupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: /history\.ts/ }).click({ modifiers: ['Control'] });
  const historyPopup = await historyPopupPromise;
  await expect(historyPopup).toHaveURL(/standaloneFile=1.*fileTabKind=HISTORY_DIFF.*commit=/);
  expect(new URL(historyPopup.url()).searchParams.getAll('refs')).toContain('refs/heads/main');
  await expect(historyPopup.getByRole('dialog', { name: 'src/history.ts Git 差异' })).toBeVisible();
  await expect(historyPopup.getByText('+history-popup')).toBeVisible();
  await historyPopup.locator('.unified-history-diff').click({ button: 'right' });
  await expect(historyPopup.getByRole('menuitem', { name: '复制' })).toBeVisible();
  await expect(historyPopup.getByRole('menuitem', { name: '粘贴' })).toBeDisabled();
  await expect(historyPopup.getByRole('menuitem', { name: '重新加载' })).toBeVisible();
  await historyPopup.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'src/history.ts Git 差异' })).toHaveCount(0);
  await page.getByRole('button', { name: /photo\.png/ }).click({ modifiers: ['Control'] });
  await expect(
    historyPopup.getByRole('tablist', { name: '文件预览标签' }).getByRole('tab')
  ).toHaveCount(2);
  await historyPopup.getByRole('button', { name: '打开文件预览' }).click();
  const photo = historyPopup.getByRole('img', { name: 'src/photo.png' });
  await expect(photo).toBeVisible();
  await expect(photo).toHaveJSProperty('naturalWidth', 1);
  expect(
    new URL((await photo.getAttribute('src'))!, historyPopup.url()).searchParams.getAll('refs')
  ).toContain('refs/heads/main');
  await historyPopup.reload();
  await expect(historyPopup).toHaveURL(/standaloneFile=1.*path=src%2Fphoto\.png/);
  await expect(historyPopup.getByRole('dialog', { name: 'src/photo.png Git 差异' })).toBeVisible();
  await historyPopup.close();
  const errorPopupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: /deeper\.ts/ }).click({ modifiers: ['Control'] });
  const errorPopup = await errorPopupPromise;
  await expect(errorPopup.getByRole('alert')).toContainText('GIT_DIFF_UNAVAILABLE');
  await expect(errorPopup.getByRole('alert')).toContainText('request-popup-1');
  await errorPopup.close();
  await page.getByRole('button', { name: /history\.ts/ }).click();
  await expect(page.getByRole('dialog', { name: 'src/history.ts Git 差异' })).toBeVisible();
  await expect(page.getByText('当前 节点未返回新文件全文')).toHaveCount(0);
  await expect(page.locator('.unified-history-diff .is-deleted')).toHaveText([
    '--- a/src/history.ts',
    '-legacy',
    '-'
  ]);
  await expect(page.locator('.unified-history-diff .is-added')).toHaveText([
    '+++ b/src/history.ts',
    '+history',
    '+'
  ]);
  await expect(page.locator('.unified-history-diff .is-hunk')).toHaveText('@@ -1,3 +1,3 @@');
  await expect(page.locator('.unified-history-diff .is-meta')).toHaveText([
    'diff --git a/src/history.ts b/src/history.ts',
    'index 1111111..2222222 100644'
  ]);
  const historyDiffColors = await page.locator('.unified-history-diff').evaluate((element) => {
    const color = (selector: string): string =>
      getComputedStyle(element.querySelector<HTMLElement>(selector)!).color;
    return {
      added: color('.is-added'),
      deleted: color('.is-deleted'),
      metadata: color('.is-meta')
    };
  });
  expect(historyDiffColors.added).not.toBe(historyDiffColors.metadata);
  expect(historyDiffColors.deleted).not.toBe(historyDiffColors.metadata);
  await expect(
    page.locator('.unified-history-diff code > span').filter({ hasText: '- Markdown context item' })
  ).not.toHaveClass(/is-(added|deleted|mixed)/u);
});

test('Long-diff minimaps aggregate all changes while content line spacing stays stable', async ({
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
    '0.9.6',
    true
  );
  const afterLines = Array.from({ length: 1_200 }, (_, index) =>
    index === 1_080
      ? `export const changed = '${'x'.repeat(2_000)}';`
      : `export const line${index} = ${index};`
  );
  await page.route(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/, (route) =>
    json(route, {
      files: {
        entries: [
          { path: 'alpha.ts', name: 'alpha.ts', kind: 'FILE', size: 16 },
          { path: 'beta.ts', name: 'beta.ts', kind: 'FILE', size: 15 }
        ],
        nextCursor: null,
        truncated: false
      }
    })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/changes(?:\?.*)?$/, (route) =>
    json(route, {
      branch: 'feature/minimap',
      changes: [
        { path: 'src/long.ts', state: 'UNSTAGED', change: 'MODIFIED', diffAvailable: true }
      ],
      repositories: [
        {
          repositoryPath: '',
          repositoryName: '根仓库',
          source: 'ROOT',
          branch: 'feature/minimap',
          changes: [
            { path: 'src/long.ts', state: 'UNSTAGED', change: 'MODIFIED', diffAvailable: true }
          ]
        }
      ]
    })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/watch$/, (route) =>
    fulfillMockWorkspaceWatch(
      page,
      route,
      { id: 'session-1', workspaceId: 'workspace-1' },
      'GIT_WORKSPACE',
      [
        { path: 'alpha.ts', name: 'alpha.ts', kind: 'FILE', size: 16 },
        { path: 'beta.ts', name: 'beta.ts', kind: 'FILE', size: 15 }
      ],
      {
        branch: 'feature/minimap',
        changes: [
          { path: 'src/long.ts', state: 'UNSTAGED', change: 'MODIFIED', diffAvailable: true }
        ],
        repositories: [
          {
            repositoryPath: '',
            repositoryName: '根仓库',
            source: 'ROOT',
            branch: 'feature/minimap',
            changes: [
              {
                path: 'src/long.ts',
                state: 'UNSTAGED',
                change: 'MODIFIED',
                diffAvailable: true
              }
            ]
          }
        ]
      }
    )
  );
  await page.route(/\/api\/workspaces\/workspace-1\/changes\/diff(?:\?.*)?$/, (route) =>
    json(route, {
      diff: {
        binary: false,
        afterText: `${afterLines.join('\n')}\n`,
        text: [
          'diff --git a/src/long.ts b/src/long.ts',
          '@@ -1081 +1081 @@',
          '-export const changed = "before";',
          `+${afterLines[1080]}`
        ].join('\n')
      }
    })
  );
  await page.context().route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, (route) => {
    const path = new URL(route.request().url()).searchParams.get('path') ?? '';
    return json(route, {
      file: {
        path,
        encoding: 'utf-8',
        content: `export const file = '${path}';\n`,
        truncated: false,
        nextOffset: null
      }
    });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  const firstPopupPromise = page.waitForEvent('popup');
  await page
    .getByRole('tree', { name: '文件树' })
    .getByRole('treeitem', { name: /alpha\.ts/ })
    .click({ modifiers: ['Control'] });
  const changesPopup = await firstPopupPromise;
  await expect(changesPopup.getByRole('dialog', { name: 'alpha.ts 文件预览' })).toBeVisible();
  await page
    .getByRole('tree', { name: '文件树' })
    .getByRole('treeitem', { name: /beta\.ts/ })
    .click({ modifiers: ['Control'] });
  const popupTabs = changesPopup.getByRole('tablist', { name: '文件预览标签' }).getByRole('tab');
  await expect(popupTabs).toHaveCount(2);
  await expect(changesPopup.getByRole('dialog', { name: 'beta.ts 文件预览' })).toBeVisible();
  await page.getByRole('tab', { name: 'Git 变更' }).click();
  await page
    .context()
    .route(/\/api\/workspaces\/workspace-1\/changes\/diff(?:\?.*)?$/, (route) =>
      json(route, { diff: { binary: false, text: '@@ -1 +1 @@\n-before\n+changes-popup' } })
    );
  await page
    .getByRole('button', { name: '查看 src/long.ts 的 Diff' })
    .click({ modifiers: ['Control'] });
  await expect(popupTabs).toHaveCount(3);
  await expect(changesPopup.getByRole('dialog', { name: 'src/long.ts Git 差异' })).toBeVisible();
  await expect(changesPopup.getByText('+changes-popup')).toBeVisible();
  await changesPopup.close();
  await page.getByRole('button', { name: '查看 src/long.ts 的 Diff' }).click();

  const diff = page.getByRole('dialog', { name: 'src/long.ts Git 差异' });
  const minimapRows = diff.locator('.diff-minimap-row');
  await expect(minimapRows).toHaveCount(180);
  await expect(diff.locator('.diff-minimap-row.is-mixed')).toHaveCount(1);
  const workingTree = diff.getByLabel('工作树文件全文');
  await expect(workingTree.locator('.unified-diff-line')).toHaveCount(1_201);
  const minimapReservedWidth = await diff.evaluate((dialog) => {
    const code = dialog.querySelector<HTMLElement>('.unified-diff-code');
    const minimap = dialog.querySelector<HTMLElement>('.diff-minimap');
    return {
      paddingRight: Number.parseFloat(code === null ? '0' : getComputedStyle(code).paddingRight),
      minimapWidth: minimap?.offsetWidth ?? 0
    };
  });
  expect(
    Math.abs(minimapReservedWidth.paddingRight - minimapReservedWidth.minimapWidth)
  ).toBeLessThanOrEqual(1);
  const lineHeights = await workingTree
    .locator('.unified-diff-line')
    .evaluateAll((lines) =>
      [lines[0], lines[1], lines[1080]].map((line) => line?.getBoundingClientRect().height)
    );
  expect(lineHeights[0]).toBeCloseTo(lineHeights[1] ?? 0, 2);
  expect(lineHeights[1]).toBeCloseTo(lineHeights[2] ?? 0, 2);
  const minimapBounds = await diff.locator('.diff-minimap').boundingBox();
  expect(minimapBounds).not.toBeNull();
  await workingTree.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await page.mouse.move(
    (minimapBounds?.x ?? 0) + (minimapBounds?.width ?? 0) / 2,
    (minimapBounds?.y ?? 0) + 8
  );
  await page.mouse.down();
  await page.mouse.move(
    (minimapBounds?.x ?? 0) + (minimapBounds?.width ?? 0) / 2,
    (minimapBounds?.y ?? 0) + (minimapBounds?.height ?? 0) - 8
  );
  await page.mouse.up();
  await expect
    .poll(() =>
      workingTree.evaluate(
        (element) => element.scrollTop / Math.max(1, element.scrollHeight - element.clientHeight)
      )
    )
    .toBeGreaterThan(0.85);
  await workingTree.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  const minimapViewportTopRatio = await diff
    .locator('.diff-minimap-viewport')
    .evaluate((element) => {
      const minimap = element.parentElement;
      return minimap === null ? 0 : (element as HTMLElement).offsetTop / minimap.clientHeight;
    });
  expect(minimapViewportTopRatio).toBeGreaterThan(0.85);
});

test('Ctrl-click opens linked-worktree files without diffs in standalone previews', async ({
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
    '0.9.6',
    true
  );
  await page.context().route(/\/api\/workspaces\/workspace-1\/changes(?:\?.*)?$/, (route) =>
    json(route, {
      branch: 'main',
      repositories: [
        {
          repositoryPath: '',
          repositoryName: 'project',
          source: 'ROOT',
          branch: 'main',
          changes: []
        },
        {
          repositoryPath: '',
          repositoryName: 'linked-review',
          source: 'WORKTREE',
          worktreePath: '/srv/worktrees/linked-review',
          status: 'DIRTY',
          branch: 'agent/review',
          changes: [
            {
              path: 'notes/linked.txt',
              state: 'UNTRACKED',
              change: 'ADDED',
              diffAvailable: false
            }
          ]
        }
      ]
    })
  );
  let requestedWorktreePath: string | null = null;
  await page.context().route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, (route) => {
    requestedWorktreePath = new URL(route.request().url()).searchParams.get('worktreePath');
    return json(route, {
      file: {
        path: 'notes/linked.txt',
        size: 24,
        encoding: 'utf-8',
        content: 'linked worktree preview\n',
        truncated: false,
        nextOffset: null
      }
    });
  });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.getByRole('tab', { name: 'Git 变更' }).click();
  const popupPromise = page.waitForEvent('popup');
  await page
    .getByRole('button', { name: '预览 /srv/worktrees/linked-review/notes/linked.txt' })
    .click({ modifiers: ['Control'] });
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/standaloneFile=1/);
  await expect(popup.getByRole('dialog', { name: 'notes/linked.txt 文件预览' })).toBeVisible();
  await expect(popup.locator('.cm-content')).toContainText('linked worktree preview');
  expect(requestedWorktreePath).toBe('/srv/worktrees/linked-review');
  await expect(page.getByRole('dialog', { name: 'notes/linked.txt 文件预览' })).toHaveCount(0);
  await popup.reload();
  await expect(popup).toHaveURL(/standaloneFile=1.*path=notes%2Flinked\.txt/);
  await expect(popup.getByRole('dialog', { name: 'notes/linked.txt 文件预览' })).toBeVisible();
  await expect(popup.locator('.cm-content')).toContainText('linked worktree preview');
  await popup.close();
});

test('Supported binary files render in bounded preview windows and unknown types offer download only', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  const archiveReadLimits: number[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/, (route) =>
    json(route, {
      files: {
        entries: [
          { path: 'photo.png', name: 'photo.png', kind: 'FILE', size: 68, modifiedAt: 1 },
          { path: 'manual.pdf', name: 'manual.pdf', kind: 'FILE', size: 512, modifiedAt: 1 },
          { path: 'broken.pdf', name: 'broken.pdf', kind: 'FILE', size: 7, modifiedAt: 1 },
          { path: 'sheet.xlsx', name: 'sheet.xlsx', kind: 'FILE', size: 64, modifiedAt: 1 },
          { path: 'deck.pptx', name: 'deck.pptx', kind: 'FILE', size: 64, modifiedAt: 1 },
          { path: 'archive.bin', name: 'archive.bin', kind: 'FILE', size: 3, modifiedAt: 1 }
        ],
        nextCursor: null,
        truncated: false
      }
    })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, async (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (path === 'archive.bin') {
      archiveReadLimits.push(Number(new URL(route.request().url()).searchParams.get('limit')));
      return json(route, {
        file: {
          path,
          encoding: 'base64',
          size: 3,
          content: 'AAEC',
          truncated: false,
          nextOffset: null
        }
      });
    }
    return json(route, {
      file: {
        path,
        encoding: 'base64',
        size: 68,
        content:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        truncated: false,
        nextOffset: null
      }
    });
  });
  let releasePresentationRead: (() => void) | undefined;
  const presentationRead = new Promise<void>((resolve) => {
    releasePresentationRead = resolve;
  });
  await page.route(/\/api\/workspaces\/workspace-1\/files\/content(?:\?.*)?$/, (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (path === 'sheet.xlsx') {
      return route.fulfill({
        status: 200,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        body: minimalSpreadsheet()
      });
    }
    if (path === 'deck.pptx')
      return presentationRead.then(() =>
        route.fulfill({
          status: 200,
          contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          body: Buffer.from('invalid')
        })
      );
    return route.fulfill(
      path?.endsWith('.pdf') === true
        ? {
            status: 200,
            contentType: 'application/pdf',
            body: path === 'manual.pdf' ? onePagePdf() : Buffer.from('invalid')
          }
        : {
            status: 200,
            contentType: 'image/png',
            body: Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
              'base64'
            )
          }
    );
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.getByRole('treeitem', { name: 'archive.bin' }).click();
  const archivePreview = page.getByRole('dialog', { name: 'archive.bin 文件预览' });
  await expect(archivePreview).toBeVisible();
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  await page.getByRole('treeitem', { name: 'photo.png' }).click();
  const photoPreview = page.getByRole('dialog', { name: 'photo.png 文件预览' });
  await expect(photoPreview.locator('img')).toBeVisible();
  expect(archiveReadLimits).toEqual([4096]);
  await expect(photoPreview).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(photoPreview).toBeHidden();
  await page.getByRole('treeitem', { name: 'archive.bin' }).click();
  await expect(
    page.getByText('此文件类型暂不支持浏览器预览；你仍可使用右上角按钮下载文件。')
  ).toBeVisible();
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  await page.getByRole('treeitem', { name: 'manual.pdf' }).click();
  const pdfPreview = page.getByRole('dialog', { name: 'manual.pdf 文件预览' });
  await expect(pdfPreview).toBeVisible();
  await page.setViewportSize({ width: 1180, height: 760 });
  await page.setViewportSize({ width: 980, height: 720 });
  const pdfCanvas = pdfPreview.locator('canvas.pdf-file-preview-page');
  await expect(pdfCanvas).toBeVisible();
  await expect(pdfPreview.getByText('文件预览失败；你仍可使用右上角按钮下载文件。')).toHaveCount(0);
  await expect(pdfPreview.getByText('正在加载预览…')).toHaveCount(0);
  await expect
    .poll(() =>
      pdfCanvas.evaluate(
        (canvas) =>
          (canvas as HTMLCanvasElement).width > 300 && (canvas as HTMLCanvasElement).height > 150
      )
    )
    .toBe(true);
  await expect(pdfPreview.locator('iframe')).toHaveCount(0);
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  await page.getByRole('treeitem', { name: 'broken.pdf' }).click();
  const brokenPreview = page.getByRole('dialog', { name: 'broken.pdf 文件预览' });
  await expect(
    brokenPreview.getByText('文件预览失败；你仍可使用右上角按钮下载文件。')
  ).toBeVisible();
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  await page.getByRole('treeitem', { name: 'sheet.xlsx' }).click();
  const spreadsheetPreview = page.getByRole('dialog', { name: 'sheet.xlsx 文件预览' });
  await expect(spreadsheetPreview.locator('.x-spreadsheet')).toBeVisible();
  const [contentHeight, officeHeight, excelHeight] = await Promise.all([
    spreadsheetPreview
      .locator('.file-preview-content')
      .evaluate((element) => element.getBoundingClientRect().height),
    spreadsheetPreview
      .locator('.file-office-preview')
      .evaluate((element) => element.getBoundingClientRect().height),
    spreadsheetPreview
      .locator('.x-spreadsheet')
      .evaluate((element) => element.getBoundingClientRect().height)
  ]);
  const spreadsheetLayout = { contentHeight, officeHeight, excelHeight };
  expect(spreadsheetLayout.officeHeight).toBeGreaterThan(spreadsheetLayout.contentHeight - 40);
  expect(spreadsheetLayout.excelHeight).toBeGreaterThan(spreadsheetLayout.officeHeight - 4);
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  await page.setViewportSize({ width: 1600, height: 600 });
  await page.getByRole('treeitem', { name: 'deck.pptx' }).click();
  const presentationPreview = page.getByRole('dialog', { name: 'deck.pptx 文件预览' });
  const presentationLayout = await presentationPreview
    .locator('.file-presentation-renderer')
    .evaluate((element) => {
      const renderer = element.getBoundingClientRect();
      const office = element.parentElement!.getBoundingClientRect();
      return {
        rendererWidth: renderer.width,
        rendererHeight: renderer.height,
        officeWidth: office.width,
        officeHeight: office.height
      };
    });
  expect(presentationLayout.rendererHeight).toBeGreaterThan(presentationLayout.officeHeight - 4);
  expect(presentationLayout.rendererWidth).toBeLessThanOrEqual(
    (presentationLayout.officeHeight * 16) / 9 + 2
  );
  expect(presentationLayout.rendererWidth).toBeLessThan(presentationLayout.officeWidth - 100);
  releasePresentationRead?.();
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
});

test('Audio and video previews use HTTP Range and support playback and audio seeking', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  const audio = silentWave();
  const files = new Map<string, Buffer>([['sound.wav', audio]]);
  const ranges: { path: string; range: string | undefined }[] = [];
  await page.route(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/, (route) =>
    json(route, {
      files: {
        entries: [...files].map(([path, bytes]) => ({
          path,
          name: path,
          kind: 'FILE',
          size: bytes.length,
          modifiedAt: 1
        })),
        nextCursor: null,
        truncated: false
      }
    })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/files\/content(?:\?.*)?$/, (route) => {
    const path = new URL(route.request().url()).searchParams.get('path') ?? '';
    const bytes = files.get(path)!;
    const range = route.request().headers()['range'];
    ranges.push({ path, range });
    const match = /^bytes=(\d+)-(\d*)$/u.exec(range ?? '');
    const start = match === null ? 0 : Number(match[1]);
    const requestedEnd = match?.[2]
      ? Math.min(Number(match[2]), bytes.length - 1)
      : bytes.length - 1;
    const end = path.endsWith('.wav')
      ? Math.min(requestedEnd, start + 512 * 1024 - 1)
      : requestedEnd;
    return route.fulfill({
      status: match === null ? 200 : 206,
      contentType: path.endsWith('.wav') ? 'audio/wav' : 'video/webm',
      headers: {
        'accept-ranges': 'bytes',
        'content-length': String(end - start + 1),
        ...(match === null ? {} : { 'content-range': `bytes ${start}-${end}/${bytes.length}` })
      },
      body: bytes.subarray(start, end + 1)
    });
  });
  await page.goto('/console');
  files.set('clip.webm', await recordWebm(page));
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  for (const [path, tag] of [
    ['sound.wav', 'audio'],
    ['clip.webm', 'video']
  ] as const) {
    await page.getByRole('treeitem', { name: path }).click();
    const preview = page.getByRole('dialog', { name: `${path} 文件预览` });
    const player = preview.locator(tag);
    await expect(player).toBeVisible();
    await expect(player).toHaveAttribute('src', /\/files\/content\?/u);
    await expect
      .poll(() => player.evaluate((element: HTMLMediaElement) => element.readyState))
      .toBeGreaterThanOrEqual(2);
    expect(
      ranges.some((request) => request.path === path && request.range?.startsWith('bytes='))
    ).toBe(true);
    await player.evaluate(async (element: HTMLMediaElement) => {
      element.muted = true;
      await element.play();
    });
    await expect
      .poll(() => player.evaluate((element: HTMLMediaElement) => element.currentTime))
      .toBeGreaterThan(0);
    await player.evaluate((element: HTMLMediaElement) => element.pause());
    if (tag === 'audio') {
      const requestsBeforeSeek = ranges.length;
      await player.evaluate((element: HTMLMediaElement) => {
        element.currentTime = 120;
      });
      await expect
        .poll(() =>
          ranges
            .slice(requestsBeforeSeek)
            .some(
              (request) =>
                request.path === path &&
                Number(/^bytes=(\d+)-/u.exec(request.range ?? '')?.[1]) > 100 * 88200
            )
        )
        .toBe(true);
      await expect
        .poll(() => player.evaluate((element: HTMLMediaElement) => element.seeking))
        .toBe(false);
      expect(await player.evaluate((element: HTMLMediaElement) => element.currentTime)).toBeCloseTo(
        120
      );
    }
    expect(await player.evaluate((element: HTMLMediaElement) => element.error)).toBeNull();
    await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  }
});

test('Reload marks uploads interrupted in notifications, permits resume or deletion, and collapses completed entries', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.addInitScript(() => {
    const now = Date.now();
    window.localStorage.setItem(
      'mar.workbench.notifications.v1.admin',
      JSON.stringify([
        {
          id: 'run:node-1:previous',
          kind: 'run',
          title: '历史通知',
          message: '不应出现在新通知预览中。',
          createdAt: now - 1_000,
          updatedAt: now - 1_000,
          expiresAt: now + 60_000,
          read: true
        }
      ])
    );
    window.sessionStorage.setItem(
      'mar.workspace-upload-tasks',
      JSON.stringify([
        {
          id: 'resume-task',
          nodeId: 'node-1',
          workspaceId: 'workspace-1',
          directory: 'src',
          name: 'paused.txt',
          size: 2,
          overwrite: false,
          uploadId: 'upload-resume',
          receivedBytes: 1,
          status: 'UPLOADING'
        },
        {
          id: 'delete-task',
          nodeId: 'node-1',
          workspaceId: 'workspace-1',
          directory: '',
          name: 'remove.txt',
          size: 1,
          overwrite: false,
          uploadId: 'upload-delete',
          receivedBytes: 0,
          status: 'UPLOADING'
        }
      ])
    );
  });
  await page.route('**/api/workspaces/workspace-1/uploads/upload-resume?nodeId=node-1', (route) =>
    json(route, { upload: { uploadId: 'upload-resume', receivedBytes: 1, size: 2 } })
  );
  await page.route(
    '**/api/workspaces/workspace-1/uploads/upload-resume/chunks?nodeId=node-1&offset=1',
    (route) => json(route, { upload: { receivedBytes: 2 } })
  );
  await page.route('**/api/workspaces/workspace-1/uploads/upload-resume/complete', (route) =>
    json(route, { upload: { receivedBytes: 2 } })
  );
  await page.route('**/api/workspaces/workspace-1/uploads/upload-delete/cancel', (route) =>
    write(route, writes, { cancelled: true })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await expect(page.locator('.workbench-notification-center')).not.toHaveClass(/mobile-mode/);
  await page.getByRole('button', { name: '打开通知中心' }).click();
  const transfer = page.getByRole('complementary', { name: '通知中心' });
  const interruptedUploads = transfer.locator('.workbench-notification-upload');
  await expect(interruptedUploads).toHaveCount(2);
  await expect(interruptedUploads).toContainText(['已中断', '已中断']);
  await expect(transfer.getByRole('button', { name: '恢复', exact: true })).toHaveCount(2);
  await page.getByRole('heading', { name: '选择一个工作区' }).click();
  await expect(transfer).toBeHidden();
  await page.getByRole('button', { name: '打开通知中心' }).click();
  await transfer.getByRole('button', { name: '删除 remove.txt' }).click();
  await expect(transfer.getByText('remove.txt', { exact: true })).toHaveCount(0);

  const chooser = page.waitForEvent('filechooser');
  await transfer.getByRole('button', { name: '恢复', exact: true }).click();
  await (
    await chooser
  ).setFiles({ name: 'paused.txt', mimeType: 'text/plain', buffer: Buffer.from('ab') });
  await expect(transfer.getByText('文件上传完成', { exact: true })).toBeVisible();
  await expect(transfer.locator('.workbench-notification-list > li')).toHaveCount(1);
  await expect(transfer.getByText('历史通知', { exact: true })).toHaveCount(0);
  await expect(transfer.locator('time')).toHaveCount(1);
  await expect(transfer.locator('.workbench-notification-list > li')).not.toHaveClass(/unread/);
  await expect(transfer.getByRole('button', { name: '全部标记已读' })).toHaveCount(0);
  const completedDelete = transfer.getByRole('button', {
    name: '删除通知 文件上传完成',
    exact: true
  });
  await expect(completedDelete).toBeVisible();
  await expect(completedDelete).toBeEnabled();
  await expect(transfer).toBeHidden({ timeout: 9_000 });
  expect(writes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ url: expect.stringContaining('/uploads/upload-delete/cancel') })
    ])
  );
});

test('Notifications use full timestamps even within the same calendar day', async ({ page }) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  const today = new Date();
  today.setHours(7, 43, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(19, 1, 0, 0);
  await page.route('**/api/notifications', (route) =>
    json(route, {
      notifications: [
        {
          id: 'run:node-1:today',
          kind: 'run',
          title: '今天通知',
          message: '今天的通知。',
          createdAt: today.valueOf(),
          updatedAt: today.valueOf(),
          expiresAt: Date.now() + 60_000,
          read: true
        },
        {
          id: 'run:node-1:yesterday',
          kind: 'run',
          title: '昨天通知',
          message: '昨天的通知。',
          createdAt: yesterday.valueOf(),
          updatedAt: yesterday.valueOf(),
          expiresAt: Date.now() + 60_000,
          read: true
        }
      ],
      recentRuns: []
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '打开通知中心' }).click();
  const center = page.getByRole('complementary', { name: '通知中心' });
  const notificationItems = center.locator('.workbench-notification-list > li');
  const expectedTimes = await page.evaluate(
    (values) =>
      values.map((value) =>
        new Date(value - new Date(value).getTimezoneOffset() * 60_000)
          .toISOString()
          .slice(0, 19)
          .replace('T', ' ')
      ),
    [today.valueOf(), yesterday.valueOf()]
  );
  await expect(notificationItems.filter({ hasText: '今天通知' }).locator('time')).toHaveText(
    expectedTimes[0]!
  );
  await expect(notificationItems.filter({ hasText: '昨天通知' }).locator('time')).toHaveText(
    expectedTimes[1]!
  );
});

test('Recent running tasks show status tags and cumulative duration in notifications', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  const now = Date.now();
  await page.route('**/api/notifications', (route) =>
    json(route, {
      notifications: [],
      recentRuns: [
        {
          nodeId: 'node-1',
          runId: 'run-recent',
          workspaceId: 'workspace-1',
          workspaceName: 'my-agent-roam',
          sessionId: 'session-1',
          sessionTitle: '状态展示',
          userMessage: '继续完成当前任务',
          runner: 'codex',
          status: 'RUNNING',
          createdAt: now - 2_000,
          startedAt: now - 3 * 60_000 - 1_000,
          completedAt: null,
          sortAt: now - 3 * 60_000 - 1_000,
          updatedAt: now,
          version: 1
        }
      ]
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '打开通知中心' }).click();
  const task = page
    .getByRole('complementary', { name: '通知中心' })
    .locator('.workbench-recent-run-list > li');
  await expect(task).toContainText('my-agent-roam: 状态展示');
  await expect(task).toContainText('继续完成当前任务');
  await expect(task.locator('.el-tag')).toHaveText('运行中');
  await expect(task.locator('.el-tag')).toHaveClass(/el-tag--primary/);
  await expect(task.locator('time')).toHaveText(
    /^运行时间 3m 启动于 [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/
  );
});

for (const mobile of [false, true]) {
  for (const notificationCount of [0, 30]) {
    test(`Notifications retain vertical spacing and expand recent tasks to available height: ${mobile ? 'mobile' : 'desktop'}-${notificationCount} notifications`, async ({
      page
    }, testInfo) => {
      const viewport = { width: mobile ? 390 : 1365, height: mobile ? 844 : 900 };
      await page.setViewportSize(viewport);
      await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
      const now = Date.now();
      let taskCount = 30;
      await page.route('**/api/notifications', (route) =>
        json(route, {
          notifications: Array.from({ length: notificationCount }, (_, index) => ({
            id: `notification-${index}`,
            kind: 'run',
            title: `Notification ${index}`,
            message: 'Open the related session.',
            read: true,
            createdAt: now,
            updatedAt: now,
            expiresAt: now + 60_000
          })),
          recentRuns: Array.from({ length: taskCount }, (_, index) => ({
            nodeId: 'node-1',
            workspaceId: 'workspace-1',
            workspaceName: 'Workspace',
            sessionId: `session-${index}`,
            sessionTitle: `Task ${index}`,
            userMessage: `Message ${index}`,
            runId: `run-${index}`,
            runner: 'codex',
            status: index === taskCount - 1 ? 'RUNNING' : 'SUCCEEDED',
            createdAt: now - index * 1000,
            startedAt: now - index * 1000,
            sortAt: now - index * 1000,
            completedAt: index === taskCount - 1 ? null : now - (taskCount - index) * 100,
            updatedAt: now,
            version: 1
          }))
        })
      );
      await page.goto('/console');
      await page.getByRole('button', { name: '进入控制台' }).click();
      const trigger = page.getByRole('button', { name: '打开通知中心' });
      await trigger.click();
      const panel = page.getByRole('complementary', { name: '通知中心' });
      const tasks = panel.locator('.workbench-recent-run-list > li');
      await expect(tasks).toHaveCount(30);
      await expect(tasks.nth(0)).toContainText('Workspace: Task 29');
      await expect(tasks.nth(1)).toContainText('Workspace: Task 28');
      await expect(tasks.nth(29)).toContainText('Workspace: Task 0');
      const checkBounds = async () => {
        await expect
          .poll(() =>
            panel.evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              const headerHeight = Number.parseFloat(
                style.getPropertyValue('--notification-panel-header-height')
              );
              const gap =
                Number.parseFloat(getComputedStyle(document.documentElement).fontSize) / 2;
              return (
                Math.abs(bounds.top - headerHeight - gap) <= 1 &&
                Math.abs(window.innerHeight - bounds.bottom - gap) <= 1 &&
                bounds.left >= 0 &&
                bounds.right <= window.innerWidth
              );
            })
          )
          .toBe(true);
      };
      await checkBounds();
      const list = panel.locator('.workbench-recent-run-list');
      expect(await list.evaluate((element) => element.clientHeight)).toBeGreaterThan(264);
      await tasks.last().scrollIntoViewIfNeeded();
      await expect(tasks.last()).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath('notification-center.png') });
      await page.setViewportSize({ ...viewport, height: 300 });
      await checkBounds();
      await tasks.first().scrollIntoViewIfNeeded();
      await expect(tasks.first()).toBeInViewport();
      await tasks.last().scrollIntoViewIfNeeded();
      await expect(tasks.last()).toBeInViewport();
      if (notificationCount > 0) {
        const notifications = panel.locator('.workbench-notification-list > li');
        await notifications.last().scrollIntoViewIfNeeded();
        await expect(notifications.last()).toBeInViewport();
      }
      await trigger.click();
      taskCount = 1;
      await page.setViewportSize(viewport);
      await trigger.click();
      await expect(tasks).toHaveCount(1);
      expect(
        await panel.evaluate((element) => element.getBoundingClientRect().bottom)
      ).toBeLessThan(viewport.height - 50);
    });
  }
}

test('Resource trees support expansion, Workspace drag ordering, Element icons, and safe unregistration', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.unroute('**/api/nodes');
  await page.route('**/api/nodes', (route) =>
    json(route, {
      nodes: [
        {
          id: 'node-1',
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.9.6',
          nodeVersion: 'v24.15.0',
          connected: true,
          disabled: false,
          workspaceCreatable: true,
          capabilities: {
            codex: { available: true, version: '0.146' },
            claudeCode: { available: true, version: '2.1' }
          }
        }
      ]
    })
  );
  await page.route('**/api/workspaces?nodeId=node-1', (route) =>
    json(route, {
      workspaces: [
        { id: 'workspace-1', path: '/project', kind: 'GIT_WORKSPACE' },
        { id: 'workspace-2', path: '/second', kind: 'DIRECTORY' }
      ]
    })
  );
  await page.route(/\/api\/workspaces\/workspace-2\?nodeId=node-1$/, (route) =>
    write(route, writes, { workspace: { id: 'workspace-2' } })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();

  await expect(page.getByRole('button', { name: '收起工作区' })).toBeVisible();
  await expect(page.locator('.activity-rail .nav-menu-button').first()).toHaveCSS(
    'cursor',
    'pointer'
  );
  await expect(page.locator('.tree-node').first()).toHaveCSS('cursor', 'pointer');
  await expect(page.locator('.workspace-branch-button').first()).toHaveCSS('cursor', 'grab');
  await expect(page.locator('.node-tree-actions .el-icon')).toHaveCount(1);

  await page.getByRole('button', { name: 'project', exact: true }).click();
  const selectedWorkspace = page.locator('.workspace-branches > li.selected');
  await expect(selectedWorkspace).toBeVisible();
  await expect(selectedWorkspace).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

  const workspaces = page.locator('.workspace-branches > li');
  const sourceWorkspace = workspaces.filter({ hasText: 'project' });
  const targetWorkspace = workspaces.filter({ hasText: 'second' });
  await sourceWorkspace.dragTo(targetWorkspace);
  await expect(
    page
      .locator('.workspace-branches > li')
      .evaluateAll((items) => items.map((item) => item.textContent?.trim()))
  ).resolves.toEqual(['second', 'project']);

  const secondWorkspace = page.locator('.workspace-branches > li').filter({ hasText: 'second' });
  await secondWorkspace.hover();
  await secondWorkspace.getByRole('button', { name: '工作区操作' }).click();
  await page.getByRole('menu', { name: '工作区操作' }).getByRole('menuitem').last().click();
  await page.getByRole('button', { name: '移除工作区' }).click();
  await expect(page.locator('.workspace-branches > li').filter({ hasText: 'second' })).toHaveCount(
    0
  );
  expect(writes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        url: expect.stringContaining('/api/workspaces/workspace-2?nodeId=node-1'),
        csrf: 'csrf-1'
      })
    ])
  );
});
