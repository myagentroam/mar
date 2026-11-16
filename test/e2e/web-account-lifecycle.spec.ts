import { expect, test, type Page } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

// Real Console interaction with mock APIs: Server identity projection is tested separately.
async function openWorkspace(page: Page): Promise<void> {
  await page.getByRole('button', { name: '工作', exact: true }).click();
  const tree = page.locator('.workspace-tree');
  const node = tree.getByRole('button', { name: /node-1/ });
  await expect(node).toBeVisible();
  const workspace = tree.getByRole('button', { name: 'project', exact: true });
  if (!(await workspace.isVisible())) await node.click();
  await workspace.click();
  await expect(page.getByRole('textbox', { name: '输入消息' })).toBeVisible();
}

test('same-page account changes discard attachments and uploads while restoring only the current account draft', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  let userId = 0;
  let loginCount = 0;
  const identity = () => ({
    authenticated: true,
    userId,
    username: `account-${userId}`,
    isAdmin: true,
    mustChangePassword: false
  });
  await page.route('**/api/auth/me', (route) =>
    json(route, userId === 0 ? { authenticated: false, mustChangePassword: false } : identity())
  );
  await page.route('**/api/auth/login', (route) => {
    userId = ++loginCount;
    return json(route, { ...identity(), csrfToken: `csrf-${userId}` });
  });
  await page.route('**/api/auth/csrf', (route) => json(route, { csrfToken: `csrf-${userId}` }));
  await page.route('**/api/auth/logout', (route) => {
    userId = 0;
    return route.fulfill({ status: 204 });
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pendingStarted = false;
  let oldFollowups = 0;
  const attachmentIds = new Map<string, string>();
  await page.route('**/api/workspaces/workspace-1/uploads', async (route) => {
    const input = route.request().postDataJSON() as {
      name: string;
      size: number;
      composerAttachmentId: string;
    };
    attachmentIds.set(input.name, input.composerAttachmentId);
    if (input.name === 'pending-private.txt') {
      pendingStarted = true;
      await pending;
      await json(route, {
        upload: { uploadId: 'old-pending', receivedBytes: 0, size: input.size }
      }).catch(() => undefined);
      return;
    }
    return json(route, {
      upload: { uploadId: `account-${userId}-upload`, receivedBytes: input.size, size: input.size }
    });
  });
  await page.route('**/api/workspaces/workspace-1/uploads/*/complete', (route) =>
    json(route, { upload: { receivedBytes: 5 } })
  );
  await page.route('**/api/workspaces/workspace-1/uploads/old-pending/**', (route) => {
    oldFollowups += 1;
    return json(route, { upload: { receivedBytes: 5 } });
  });
  await page.addInitScript(() => {
    sessionStorage.setItem('mar.workbench.draft.node-1.workspace-1', 'unowned legacy text');
    localStorage.setItem(
      'mar.workbench.selection.v1',
      JSON.stringify({ workspace: { nodeId: 'node-1', workspaceId: 'workspace-1' } })
    );
  });

  try {
    await page.goto('/console');
    await page.getByRole('button', { name: '进入控制台' }).click();
    await openWorkspace(page);
    const editor = page.getByRole('textbox', { name: '输入消息' });
    await expect(editor).toHaveValue('');
    await editor.fill('account A private draft');
    await page.locator('.attachment-file-input').setInputFiles([
      { name: 'private.png', mimeType: 'image/png', buffer: Buffer.from('image') },
      { name: 'pending-private.txt', mimeType: 'text/plain', buffer: Buffer.from('private') }
    ]);
    await expect(page.locator('.composer-attachments')).toContainText('private.png');
    await expect(page.locator('.composer-attachments')).toContainText('pending-private.txt');
    await expect.poll(() => pendingStarted).toBe(true);
    await expect
      .poll(() =>
        page.evaluate(() =>
          sessionStorage.getItem('mar.account.v1.1.mar.workbench.draft.node-1.workspace-1')
        )
      )
      .toContain('account A private draft');

    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '退出登录' }).click();
    await page
      .getByRole('dialog', { name: '退出登录' })
      .getByRole('button', { name: '确定', exact: true })
      .click();
    await expect(page.getByRole('button', { name: '进入控制台' })).toBeVisible();
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem('mar.account.v1.1.mar.workbench.draft.node-1.workspace-1')
      )
    ).toBeNull();
    await page.getByRole('button', { name: '进入控制台' }).click();
    await openWorkspace(page);
    await expect(editor).toHaveValue('');
    await expect(page.locator('.composer-attachments')).toHaveCount(0);
    await expect(page.locator('.attachment-preview-dialog')).toHaveCount(0);
    release();
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible();
    expect(oldFollowups).toBe(0);

    await editor.fill('account B retained draft');
    await expect
      .poll(() =>
        page.evaluate(() =>
          sessionStorage.getItem('mar.account.v1.2.mar.workbench.draft.node-1.workspace-1')
        )
      )
      .toContain('account B retained draft');
    await page.reload();
    await openWorkspace(page);
    await expect(editor).toHaveValue('account B retained draft');
    await expect(page.locator('.composer-attachments')).toHaveCount(0);
    await page.locator('.session-link').first().click();
    await editor.fill('account B own message');
    await page.locator('.attachment-file-input').setInputFiles({
      name: 'account-b.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('own-b')
    });
    await expect(page.locator('.composer-attachments')).toContainText('account-b.txt');
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect
      .poll(() => writes.filter((entry) => entry.url.includes('/messages')).length)
      .toBe(1);
    const sent = writes.find((entry) => entry.url.includes('/messages'))!;
    expect(sent.csrf).toBe('csrf-2');
    expect(sent.body).toContain('account B own message');
    const sentAttachments = (JSON.parse(sent.body) as { attachmentIds: string[] }).attachmentIds;
    expect(sentAttachments).toEqual([attachmentIds.get('account-b.txt')]);
    expect(sentAttachments).not.toContain(attachmentIds.get('private.png'));
    expect(sentAttachments).not.toContain(attachmentIds.get('pending-private.txt'));
    expect(oldFollowups).toBe(0);
  } finally {
    release();
  }
});
