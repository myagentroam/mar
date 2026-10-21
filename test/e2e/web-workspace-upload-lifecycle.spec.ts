import { expect, test } from '@playwright/test';
import { json, mockConsoleApi, mockEmptyWorkspaceFiles } from './support/web-console-api.js';

// @test-covers packages/web-core/src/service/WorkspaceUploadService.ts
// @test-covers packages/web-core/src/service/WorkbenchPageLifecycleService.ts

test('Workspace upload page teardown cleans late creates without draining or overwriting recovery', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], [], 'DIRECTORY');
  const creates: string[] = [];
  const cancels: string[] = [];
  const completes: string[] = [];
  const chunks: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/workspaces\/workspace-1\/uploads(?:\/.*)?(?:\?.*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/preflight')) {
      const { files } = route.request().postDataJSON() as { files: { name: string }[] };
      return json(route, { uploads: files.map(({ name }) => ({ status: 'READY', path: name })) });
    }
    if (path.endsWith('/uploads')) {
      const { name, size } = route.request().postDataJSON();
      creates.push(name);
      await gate;
      return json(route, { upload: { uploadId: name, receivedBytes: 0, size } });
    }
    if (path.endsWith('/cancel')) {
      cancels.push(path.split('/').at(-2)!);
      return json(route, { cancelled: true });
    }
    if (path.endsWith('/complete')) completes.push(path);
    else chunks.push(path);
    return json(route, {});
  });
  try {
    await page.goto('/console');
    await page.getByRole('button', { name: '进入控制台' }).click();
    await page
      .locator('.workspace-tree')
      .getByRole('button', { name: /node-1/ })
      .click();
    await page
      .locator('.workspace-tree')
      .getByRole('button', { name: 'project', exact: true })
      .click();
    await page.getByRole('tab', { name: '文件', exact: true }).click();
    await page.locator('.workspace-upload-input[multiple]').setInputFiles(
      ['one.txt', 'two.txt', 'queued.txt'].map((name) => ({
        name,
        mimeType: 'text/plain',
        buffer: Buffer.from('x')
      }))
    );
    await page.getByRole('button', { name: '开始上传', exact: true }).click();
    await expect.poll(() => creates.length).toBe(2);
    const snapshot = await page.evaluate(() => {
      // Unmount the actual Console while keeping its JS context alive, so late requests can finish.
      // Closing a browser document cannot guarantee that remote cleanup requests will run.
      const root = document.querySelector('#app') as HTMLElement & {
        __vue_app__: { unmount(): void };
      };
      root.__vue_app__.unmount();
      return JSON.parse(sessionStorage.getItem('mar.workspace-upload-tasks')!);
    });
    expect(snapshot).toHaveLength(3);
    await expect(page.locator('.workbench')).toHaveCount(0);
    const nextOwnerSnapshot = JSON.stringify([
      { ...snapshot[0], status: 'INTERRUPTED', error: 'next-owner' }
    ]);
    await page.evaluate(
      (value) => sessionStorage.setItem('mar.workspace-upload-tasks', value),
      nextOwnerSnapshot
    );
    release();
    await expect.poll(() => cancels.length).toBe(2);
    await page.evaluate(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
    });
    expect(creates).toEqual(['one.txt', 'two.txt']);
    expect(cancels.sort()).toEqual(['one.txt', 'two.txt']);
    expect(chunks).toEqual([]);
    expect(completes).toEqual([]);
    expect(await page.evaluate(() => sessionStorage.getItem('mar.workspace-upload-tasks'))).toBe(
      nextOwnerSnapshot
    );
  } finally {
    release();
  }
});

test('Workspace upload selection changes preserve the original target and normal transfer', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], [], 'DIRECTORY');
  await mockEmptyWorkspaceFiles(page, ['workspace-2']);
  await page.route('**/api/workspaces?nodeId=node-1', (route) =>
    json(route, {
      workspaces: [1, 2].map((id) => ({
        id: `workspace-${id}`,
        path: `/project-${id}`,
        kind: 'DIRECTORY'
      }))
    })
  );
  const creates: string[] = [];
  const chunks: string[] = [];
  const completes: string[] = [];
  const cancels: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/workspaces\/[^/]+\/uploads(?:\/.*)?(?:\?.*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/preflight')) {
      const { files } = route.request().postDataJSON() as { files: { name: string }[] };
      return json(route, { uploads: files.map(({ name }) => ({ status: 'READY', path: name })) });
    }
    if (path.endsWith('/uploads')) {
      creates.push(path);
      await gate;
      return json(route, { upload: { uploadId: 'original-upload', receivedBytes: 0, size: 1 } });
    }
    if (path.endsWith('/complete')) {
      completes.push(path);
      return json(route, { upload: { uploadId: 'original-upload', receivedBytes: 1, size: 1 } });
    }
    if (path.endsWith('/cancel')) {
      cancels.push(path);
      return json(route, { cancelled: true });
    }
    chunks.push(path);
    expect(route.request().postDataBuffer()).toEqual(Buffer.from('x'));
    return json(route, { upload: { uploadId: 'original-upload', receivedBytes: 1, size: 1 } });
  });
  try {
    await page.goto('/console');
    await page.getByRole('button', { name: '进入控制台' }).click();
    const tree = page.locator('.workspace-tree');
    await tree.getByRole('button', { name: /node-1/ }).click();
    await tree.getByRole('button', { name: 'project-1', exact: true }).click();
    await page.getByRole('tab', { name: '文件', exact: true }).click();
    await page
      .locator('.workspace-upload-input[multiple]')
      .setInputFiles({ name: 'switch.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
    await page.getByRole('button', { name: '开始上传', exact: true }).click();
    await expect.poll(() => creates.length).toBe(1);
    await tree.getByRole('button', { name: 'project-2', exact: true }).click();
    await expect(
      page.locator('.workspace-tab[data-tab-id="node-1:workspace-2"]').getByRole('tab')
    ).toHaveAttribute('aria-selected', 'true');
    const transfer = page.getByRole('complementary', { name: '通知中心' });
    await page.getByRole('button', { name: '打开通知中心' }).click();
    await expect(transfer).toBeVisible();
    release();
    await expect(transfer.getByText('文件上传完成', { exact: true })).toBeVisible();
    // Recovery storage only retains unfinished uploads; the notification proves completion.
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem('mar.workspace-upload-tasks')))
      .toBeNull();
    expect(creates).toEqual(['/api/workspaces/workspace-1/uploads']);
    expect(chunks).toEqual(['/api/workspaces/workspace-1/uploads/original-upload/chunks']);
    expect(completes).toEqual(['/api/workspaces/workspace-1/uploads/original-upload/complete']);
    expect(cancels).toEqual([]);
    await expect(
      page.locator('.workspace-tab[data-tab-id="node-1:workspace-2"]').getByRole('tab')
    ).toHaveAttribute('aria-selected', 'true');
  } finally {
    release();
  }
});
