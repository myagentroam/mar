import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { fulfillMockSessionWatch, json, mockConsoleApi } from './support/web-console-api.js';

test('immutable tool changes show colored statistics, isolated tabs and retry without Git fallback', async ({
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
    '0.10.8',
    true
  );
  const texts = [
    '--- /dev/null\n+++ b/added.txt\n@@ -0,0 +1,1 @@\n+created\n',
    '--- a/deleted.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-removed\n',
    '--- a/same.txt\n+++ b/same.txt\n@@ -1,1 +1,1 @@\n-first\n+second\n',
    '--- a/same.txt\n+++ b/same.txt\n@@ -1,1 +1,1 @@\n-second\n+third\n'
  ];
  const changes = texts.map((text, index) => ({
    path: ['added.txt', 'deleted.txt', 'same.txt', 'same.txt'][index],
    change: index === 0 ? 'ADDED' : index === 1 ? 'DELETED' : 'MODIFIED',
    additions: index === 1 ? 0 : 1,
    deletions: index === 0 ? 0 : 1,
    diffAvailable: true,
    changeId: randomUUID(),
    diff: {
      status: 'available',
      source: 'TOOL_CHANGE',
      resourceRef: randomUUID(),
      format: 'unified-diff',
      byteSize: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex')
    }
  }));
  await page.context().route('**/api/agent-sessions/session-1/watch*', (route) =>
    fulfillMockSessionWatch(
      page,
      route,
      { id: 'session-1', workspaceId: 'workspace-1' },
      {
        kind: 'session-watch-snapshot',
        sequence: 1,
        session: {
          id: 'session-1',
          workspaceId: 'workspace-1',
          runner: 'mar-agent',
          activity: 'IDLE',
          control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
        },
        runs: [],
        queue: { version: 0, paused: false, items: [] },
        context: null,
        conversation: {
          unit: 'SEGMENT',
          source: 'official',
          readAt: 1,
          latestVisibleAt: 1,
          snapshotSequence: 1,
          nextCursor: null,
          segments: [
            {
              id: 'change:segment:0',
              sessionId: 'session-1',
              turnId: 'change',
              index: 0,
              runId: null,
              status: 'SUCCEEDED',
              startedAt: null,
              completedAt: null,
              items: [
                {
                  id: 'changes',
                  sessionId: 'session-1',
                  turnId: 'change',
                  runId: null,
                  parentItemId: null,
                  sourceSequence: null,
                  revision: 1,
                  startedAt: null,
                  completedAt: null,
                  kind: 'file_change',
                  status: 'COMPLETED',
                  payload: { changes }
                }
              ]
            }
          ]
        }
      }
    )
  );
  let failRead = true;
  let resourceReads = 0;
  let gitReads = 0;
  const currentFileRequests: string[] = [];
  page.on('request', (request) => {
    if (/\/files\/(?:read|content)(?:\?|$)/u.test(request.url()))
      currentFileRequests.push(request.url());
  });
  await page.route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, (route) => {
    const path = new URL(route.request().url()).searchParams.get('path') ?? '';
    if (path === 'deleted.txt')
      return json(
        route,
        { error: { code: 'FILE_NOT_FOUND', message: 'Source file no longer exists' } },
        404
      );
    return json(route, {
      file: {
        path,
        encoding: 'utf-8',
        content: `Current source of ${path}\n`,
        size: Buffer.byteLength(`Current source of ${path}\n`),
        truncated: false,
        nextOffset: null
      }
    });
  });
  await page.route('**/api/agent-sessions/session-1/tool-resources/*', (route) => {
    resourceReads++;
    const url = new URL(route.request().url());
    expect(url.searchParams.get('workspaceId')).toBe('workspace-1');
    const index = changes.findIndex((change) => url.pathname.endsWith(change.diff.resourceRef));
    if (failRead)
      return json(
        route,
        { error: { code: 'TOOL_RESOURCE_UNAVAILABLE', message: 'Unavailable' } },
        503
      );
    const { status: _status, source: _source, ...resource } = changes[index]!.diff;
    return json(route, { ...resource, type: 'file_changes', version: 1, content: texts[index] });
  });
  await page.route('**/api/workspaces/workspace-1/git/diff*', (route) => {
    gitReads++;
    return json(route, { text: 'WRONG CURRENT DIFF' });
  });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();
  await page.locator('.conversation-file-change-details > summary').click();
  const entries = page.locator('.conversation-file-change-list li');
  await expect(entries).toHaveCount(4);
  await expect(entries.nth(0).locator('.change-additions')).toHaveText('+1');
  await expect(entries.nth(0).locator('.change-deletions')).toHaveText('-0');
  await expect(entries.nth(1).locator('.change-additions')).toHaveText('+0');
  await expect(entries.nth(1).locator('.change-deletions')).toHaveText('-1');
  await expect(entries.nth(0).locator('.change-additions')).toHaveCSS(
    'color',
    /^rgb\((23, 128, 61|34, 197, 94)\)$/
  );
  await expect(entries.nth(0).locator('.change-deletions')).toHaveCSS(
    'color',
    /^rgb\((200, 59, 59|248, 81, 73)\)$/
  );
  await entries.nth(0).getByRole('button').click();
  const added = page.getByRole('dialog', { name: 'added.txt 本次修改' });
  await expect(added).toBeVisible();
  const readError = page.getByRole('alert').filter({ hasText: 'TOOL_RESOURCE_UNAVAILABLE' });
  await expect(readError).toBeVisible();
  await readError.getByRole('button', { name: '关闭', exact: true }).click();
  failRead = false;
  await expect(added.getByRole('button', { name: '打开源文件', exact: true })).toBeEnabled();
  await added.getByRole('button', { name: /重试/ }).click();
  await expect(added).toContainText('+created');
  const copied: string[] = [];
  await page.exposeFunction('recordDiffClipboard', (value: string) => copied.push(value));
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: (text: string) =>
        (
          window as unknown as { recordDiffClipboard(text: string): Promise<void> }
        ).recordDiffClipboard(text)
    });
  });
  const diffLines = added.locator('.unified-history-diff');
  await diffLines.evaluate((element) => {
    const outside = document.createElement('p');
    outside.dataset.testid = 'outside-diff-selection';
    outside.textContent = 'Unrelated page content';
    document.body.append(outside);
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await diffLines.dispatchEvent('contextmenu', { clientX: 200, clientY: 250 });
  await page.getByRole('menuitem', { name: '复制', exact: true }).dispatchEvent('click');
  await expect.poll(() => copied.length).toBe(1);
  expect(copied[0]).toContain('+created');
  await diffLines.evaluate((element) => {
    const range = document.createRange();
    range.setStart(element.querySelector('span')!.firstChild!, 0);
    range.setEndAfter(document.querySelector('[data-testid="outside-diff-selection"]')!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await diffLines.dispatchEvent('contextmenu', { clientX: 200, clientY: 250 });
  await page.getByRole('menuitem', { name: '复制', exact: true }).dispatchEvent('click');
  expect(copied).toHaveLength(1);
  await page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    document.querySelector('[data-testid="outside-diff-selection"]')?.remove();
  });

  await expect(added.getByRole('button', { name: '打开当前文件', exact: true })).toHaveCount(0);
  expect(currentFileRequests).toEqual([]);
  await added.getByRole('button', { name: '打开源文件', exact: true }).click();
  await expect(page.locator('.cm-content:visible')).toHaveText('Current source of added.txt');
  expect(currentFileRequests.map((url) => new URL(url).searchParams.get('path'))).toEqual([
    'added.txt'
  ]);
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  await expect(added).toBeVisible();
  await expect(added).toContainText('+created');
  await added.locator('.unified-history-diff').click();
  await page.keyboard.press('Control+e');
  await expect(page.locator('.cm-content:visible')).toHaveText('Current source of added.txt');
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  const desktopSize = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await added.getByRole('button', { name: '打开源文件', exact: true }).click();
  await expect(page.locator('.cm-content:visible')).toHaveText('Current source of added.txt');
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  await page.setViewportSize(desktopSize);
  await expect(added.locator('.unified-history-diff')).toBeVisible();
  await expect(added.locator('.cm-content')).toHaveCount(0);
  await expect(added.getByRole('button', { name: /编辑|恢复/ })).toHaveCount(0);
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  await entries.nth(1).getByRole('button').click();
  await expect(page.getByRole('dialog', { name: 'deleted.txt 本次修改' })).toContainText(
    '-removed'
  );
  const deleted = page.getByRole('dialog', { name: 'deleted.txt 本次修改' });
  await deleted.getByRole('button', { name: '打开源文件', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'FILE_NOT_FOUND' })).toBeVisible();
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  await expect(deleted).toBeVisible();
  await expect(deleted).toContainText('-removed');
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  await entries.nth(2).getByRole('button').click();
  await expect(page.getByRole('dialog', { name: 'same.txt 本次修改' })).toContainText('+second');
  const modified = page.getByRole('dialog', { name: 'same.txt 本次修改' });
  await modified.getByRole('button', { name: '打开源文件', exact: true }).click();
  await expect(page.locator('.cm-content:visible')).toHaveText('Current source of same.txt');
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  await expect(modified).toContainText('+second');
  await page.keyboard.press('Escape');
  await entries.nth(3).getByRole('button').click();
  await expect(page.getByRole('dialog', { name: 'same.txt 本次修改' }).last()).toContainText(
    '+third'
  );
  expect(resourceReads).toBeGreaterThanOrEqual(5);
  expect(gitReads).toBe(0);
});
