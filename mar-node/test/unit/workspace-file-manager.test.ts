import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  fileManagerInvocation,
  revealWorkspaceFileInFileManager
} from '../../src/service/workspace-file-manager-service.js';

describe('Workspace local file manager', () => {
  it('builds platform-specific open and reveal commands without a shell', () => {
    const file = { path: 'C:\\work space\\notes.txt', kind: 'FILE' } as const;
    const directory = { path: 'C:\\work space', kind: 'DIRECTORY' } as const;
    expect(fileManagerInvocation('win32', file)).toEqual({
      command: 'explorer.exe',
      args: ['/select,', 'C:\\work space\\notes.txt']
    });
    expect(fileManagerInvocation('win32', directory).args).toEqual([directory.path]);
    expect(fileManagerInvocation('darwin', file)).toEqual({
      command: 'osascript',
      args: ['-e', expect.stringMatching(/reveal finderItem[\s\S]*select finderItem/), file.path]
    });
    expect(fileManagerInvocation('darwin', directory)).toEqual({
      command: 'open',
      args: [directory.path]
    });
    expect(fileManagerInvocation('linux', { path: '/srv/work/notes.txt', kind: 'FILE' })).toEqual({
      command: 'xdg-open',
      args: ['/srv/work']
    });
  });

  it('resolves a real Workspace file and launches it with argument boundaries intact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-file-manager-'));
    try {
      await mkdir(join(root, 'folder with space'));
      await writeFile(join(root, 'folder with space', 'notes.txt'), 'notes');
      const child = new EventEmitter() as ChildProcess;
      child.unref = vi.fn();
      const spawnProcess = vi.fn(() => {
        queueMicrotask(() => {
          child.emit('spawn');
          child.emit('exit', 0);
        });
        return child;
      });

      await expect(
        revealWorkspaceFileInFileManager(root, 'folder with space/notes.txt', {
          platform: 'linux',
          spawnProcess
        })
      ).resolves.toEqual({ revealed: true });
      expect(spawnProcess).toHaveBeenCalledExactlyOnceWith(
        'xdg-open',
        [join(root, 'folder with space')],
        { detached: true, stdio: 'ignore', windowsHide: true }
      );
      expect(child.unref).toHaveBeenCalledOnce();
      await expect(
        revealWorkspaceFileInFileManager(root, '../outside', { spawnProcess })
      ).rejects.toThrow('FILE_PATH_ESCAPE');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports a desktop launcher that exits unsuccessfully', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-file-manager-'));
    try {
      const child = new EventEmitter() as ChildProcess;
      child.unref = vi.fn();
      const spawnProcess = vi.fn(() => {
        queueMicrotask(() => child.emit('exit', 3));
        return child;
      });
      await expect(
        revealWorkspaceFileInFileManager(root, '.', { platform: 'linux', spawnProcess })
      ).rejects.toThrow('FILE_MANAGER_UNAVAILABLE');
      expect(child.unref).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports an unavailable desktop command without changing the path error contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-file-manager-'));
    try {
      const child = new EventEmitter() as ChildProcess;
      child.unref = vi.fn();
      const spawnProcess = vi.fn(() => {
        queueMicrotask(() => child.emit('error', new Error('ENOENT')));
        return child;
      });
      await expect(
        revealWorkspaceFileInFileManager(root, '.', { platform: 'linux', spawnProcess })
      ).rejects.toThrow('FILE_MANAGER_UNAVAILABLE');
      expect(child.unref).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
