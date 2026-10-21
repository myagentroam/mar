import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceFileService } from '../../src/service/workspace-file-service.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('Workspace HTML preview physical directory boundary', () => {
  it('loads nested resources and rejects a symlink into a sibling directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-html-preview-'));
    directories.push(root);
    await mkdir(join(root, 'pages/demo/js'), { recursive: true });
    await mkdir(join(root, 'private'));
    await writeFile(join(root, 'pages/demo/js/app.js'), 'export default 1');
    await writeFile(join(root, 'private/secret.js'), 'secret');
    await symlink(join(root, 'private/secret.js'), join(root, 'pages/demo/secret.js'));
    const service = new WorkspaceFileService({} as never, () => undefined);
    const workspace = { path: root } as never;
    await expect(
      service.readContent(workspace, {
        path: 'pages/demo/js/app.js',
        previewDirectory: 'pages/demo',
        offset: 0,
        limit: 16
      })
    ).resolves.toMatchObject({ size: 16 });
    await expect(
      service.readContent(workspace, {
        path: 'pages/demo/secret.js',
        previewDirectory: 'pages/demo',
        offset: 0,
        limit: 16
      })
    ).rejects.toThrow('FILE_PATH_ESCAPE');
    await expect(
      service.readContent(workspace, {
        path: join(root, 'private/secret.js'),
        previewDirectory: 'pages/demo'
      })
    ).rejects.toThrow('FILE_PATH_ESCAPE');
  });
});
