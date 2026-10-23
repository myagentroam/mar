import { expect, test } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

for (const [path, content] of [
  ['schedule-real-verify.mts', 'export const value = 1;'],
  ['notes.custom', 'custom text content'],
  ['LICENSE', 'license text'],
  ['empty.mts', ''],
  ['large.mts', 'a'.repeat(2047) + '\n' + 'b'.repeat(2047) + '中文']
] as const) {
  test(`Unknown-extension text previews use content consistently in workbench and standalone windows: ${path}`, async ({
    page
  }) => {
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    const bytes = Buffer.from(content);
    await page.route(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/, (route) =>
      json(route, {
        files: {
          entries: [{ path, name: path, kind: 'FILE', size: bytes.length, modifiedAt: 1 }],
          nextCursor: null,
          truncated: false
        }
      })
    );
    const fileReadRoute = /\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/;
    await page.unroute(fileReadRoute);
    const reads: number[] = [];
    await page.context().route(fileReadRoute, (route) => {
      const query = new URL(route.request().url()).searchParams;
      expect(query.get('path')).toBe(path);
      expect(query.get('offset')).toBe('0');
      const limit = Number(query.get('limit'));
      expect([4096, 524288]).toContain(limit);
      reads.push(limit);
      let end = Math.min(bytes.length, limit);
      while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
      return json(route, {
        file: {
          path,
          encoding: 'utf-8',
          size: bytes.length,
          content: bytes.subarray(0, end).toString('utf8'),
          truncated: end < bytes.length,
          nextOffset: end < bytes.length ? end : null
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
    await page.getByRole('treeitem', { name: path, exact: true }).click();
    const preview = page.getByRole('dialog', { name: `${path} 文件预览` });
    await expect(preview.locator('.cm-content')).toHaveText(content, { useInnerText: true });
    await expect(preview.getByText('正在加载预览…')).toBeHidden();
    const expectedReads = bytes.length > 4096 ? [4096, 524288] : [4096];
    expect(reads).toEqual(expectedReads);

    const popup = await page.context().newPage();
    await mockConsoleApi(popup, 'MANAGED', ['history.read', 'turn.start'], []);
    await popup.unroute(fileReadRoute);
    await popup.goto('/console');
    await popup.getByLabel('密码').fill('test-password');
    await popup.getByRole('button', { name: '进入控制台' }).click();
    await expect(popup.getByRole('button', { name: '工作', exact: true })).toBeVisible();
    await popup.goto(
      `/console?standaloneFile=1&nodeId=node-1&workspaceId=workspace-1&path=${encodeURIComponent(path)}`
    );
    const standalone = popup.getByRole('dialog', { name: `${path} 文件预览` });
    await expect(standalone.locator('.cm-content')).toHaveText(content, { useInnerText: true });
    await expect(standalone.getByText('正在加载预览…')).toBeHidden();
    expect(reads).toEqual([...expectedReads, ...expectedReads]);
    await popup.close();
  });
}

for (const [label, content, declaredSize] of [
  ['空文件', '', 0],
  ['非空文件', 'export const hostedValue = 1;', 29],
  ['空文件元数据过期', 'updated text', 0],
  ['大文本', 'a'.repeat(2047) + '\n' + 'b'.repeat(2047) + '中文', 4101]
] as const) {
  test(`Hosted standalone windows preview unknown-extension text by content: ${label}`, async ({
    page
  }) => {
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    const bytes = Buffer.from(content);
    const reads: Array<{ method: string; range: string | undefined }> = [];
    await page.route('**/hosted-conversations/conversation-1/files/file-1/content', (route) => {
      const range = route.request().headers()['range'];
      const method = route.request().method();
      reads.push({ method, range });
      const end =
        range === undefined
          ? bytes.length
          : Math.min(bytes.length, Number(range.split('-')[1]) + 1);
      return route.fulfill({
        status: bytes.length === 0 && range !== undefined ? 416 : method === 'HEAD' ? 200 : 206,
        contentType: 'application/octet-stream',
        headers: {
          'content-length': String(end),
          ...(method === 'HEAD' || bytes.length === 0
            ? {}
            : { 'content-range': `bytes 0-${end - 1}/${bytes.length}` })
        },
        body: method === 'HEAD' ? Buffer.alloc(0) : bytes.subarray(0, end)
      });
    });
    await page.goto(
      `/console?standaloneFile=1&source=hosted&nodeId=node-1&workspaceId=conversation-1&conversationId=conversation-1&fileId=file-1&path=output/result.mts&mimeType=application%2Foctet-stream&size=${declaredSize}`
    );
    const preview = page.getByRole('dialog', { name: 'output/result.mts 文件预览' });
    await expect(preview.locator('.cm-content')).toHaveText(content, { useInnerText: true });
    await expect(preview.getByText('正在加载预览…')).toBeHidden();
    expect(reads).toEqual([
      ...(declaredSize === 0 ? [{ method: 'HEAD', range: undefined }] : []),
      ...(content === '' ? [] : [{ method: 'GET', range: 'bytes=0-4095' }]),
      ...(bytes.length > 4096 ? [{ method: 'GET', range: 'bytes=0-524287' }] : [])
    ]);
  });
}
