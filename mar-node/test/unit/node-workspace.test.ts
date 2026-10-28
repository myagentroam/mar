import { WorkspaceFileIndex, searchWorkspaceFiles } from '../../src/workspace/file-index.js';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { execFile as execFileCallback } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSafeGitRef,
  inspectWorkspace,
  isWorkspaceChangeVisible,
  readCurrentChanges,
  readCurrentChangesSummary
} from '../../src/workspace/git.js';
import {
  createWorkspaceDirectory,
  listWorkspaceDirectories,
  listWorkspaceFiles,
  normalizeFilePreviewPath,
  readAbsoluteTextFile,
  readWorkspaceFileContentRange,
  readWorkspaceTextFile
} from '../../src/workspace/files.js';
import { isWithinAllowedRoot, normalizeWorkspacePath } from '../../src/workspace/path-access.js';
import { WorkspaceService } from '../../src/service/workspace-service.js';
import { nextReconnectDelay } from '../../src/connector.js';
import {
  launchdServiceDefinition,
  systemdUnit,
  windowsServiceDefinition
} from '../../src/service.js';

const directories: string[] = [];
const execFile = promisify(execFileCallback);

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('Node path and reconnection safety', () => {
  it('normalizes Windows paths, rejects device paths, and preserves root boundaries', () => {
    expect(normalizeWorkspacePath('C:/Work/Project/', 'win32')).toBe('c:\\work\\project');
    expect(normalizeWorkspacePath('E:/', 'win32')).toBe('e:\\');
    expect(normalizeWorkspacePath('E:\\', 'win32')).toBe('e:\\');
    expect(normalizeWorkspacePath('\\\\server\\share\\', 'win32')).toBe('\\\\server\\share\\');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('E:\\Develop\\nvm\\nodejs');
    try {
      expect(isWithinAllowedRoot('E:/Projects/cloud/project', ['E:/'], 'win32')).toBe(true);
      expect(isWithinAllowedRoot('E:/Develop', ['E:/'], 'win32')).toBe(true);
      expect(isWithinAllowedRoot('D:/Develop', ['E:/'], 'win32')).toBe(false);
      expect(isWithinAllowedRoot('E:/Projects', ['E:/Develop'], 'win32')).toBe(false);
      expect(isWithinAllowedRoot('E:/', ['E:/'], 'win32')).toBe(true);
      expect(isWithinAllowedRoot('E:/Develop-other', ['E:/Develop'], 'win32')).toBe(false);
      expect(isWithinAllowedRoot('E:/../Projects', ['E:/Develop'], 'win32')).toBe(false);
      expect(
        isWithinAllowedRoot('\\\\server\\share\\project', ['\\\\server\\share'], 'win32')
      ).toBe(true);
      expect(
        isWithinAllowedRoot('\\\\server\\other\\project', ['\\\\server\\share'], 'win32')
      ).toBe(false);
    } finally {
      cwd.mockRestore();
    }
    expect(isWithinAllowedRoot('C:/Work/Project/a', ['c:/work/project'], 'win32')).toBe(true);
    expect(isWithinAllowedRoot('C:/Work/other', ['c:/work/project'], 'win32')).toBe(false);
    expect(() => normalizeWorkspacePath('\\\\?\\C:\\unsafe', 'win32')).toThrow(
      'WORKSPACE_DEVICE_PATH_REJECTED'
    );
  });

  it('normalizes macOS paths with POSIX root boundaries', () => {
    expect(normalizeWorkspacePath('/Users/mar-node/workspaces/project/', 'darwin')).toBe(
      '/Users/mar-node/workspaces/project'
    );
    expect(
      isWithinAllowedRoot(
        '/Users/mar-node/workspaces/project/src',
        ['/Users/mar-node/workspaces'],
        'darwin'
      )
    ).toBe(true);
  });

  it('strips and decodes the sandbox local-file prefix and supports Windows drive-letter paths', () => {
    expect(normalizeFilePreviewPath('sandbox:/tmp/cache%20image.png')).toBe('/tmp/cache image.png');
    expect(normalizeFilePreviewPath('sandbox:/C:/Users/runner/AppData/Local/Temp/cache.png')).toBe(
      'C:/Users/runner/AppData/Local/Temp/cache.png'
    );
    expect(normalizeFilePreviewPath('sandbox:C:\\Users\\runner\\Temp\\cache.png')).toBe(
      'C:\\Users\\runner\\Temp\\cache.png'
    );
    expect(() => normalizeFilePreviewPath('sandbox:relative/cache.png')).toThrow(
      'FILE_PATH_ESCAPE'
    );
    expect(() => normalizeFilePreviewPath('sandbox:/tmp/cache.png%23fragment')).toThrow(
      'FILE_PATH_ESCAPE'
    );
    expect(() =>
      normalizeFilePreviewPath('sandbox:\\\\.\\C:\\Users\\runner\\Temp\\cache.png')
    ).toThrow('FILE_PATH_ESCAPE');
  });

  it('rejects Linux symlinks that escape the allowed root and classifies regular directories as DIRECTORY', async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const directory = join(root, 'directory');
    await mkdir(directory);
    await writeFile(join(directory, 'a.txt'), 'safe');
    await symlink(outside, join(root, 'escape'));

    await expect(inspectWorkspace(directory, [root])).resolves.toMatchObject({
      kind: 'DIRECTORY'
    });
    await expect(inspectWorkspace(join(root, 'escape'), [root])).rejects.toThrow(
      'WORKSPACE_NOT_ALLOWED'
    );
  });

  it('registers a regular directory as DIRECTORY when Git is not installed', async () => {
    const root = await temporaryDirectory();
    const directory = join(root, 'without-git');
    await mkdir(directory);
    const previousPath = process.env.PATH;
    process.env.PATH = root;
    try {
      await expect(inspectWorkspace(directory, [root])).resolves.toMatchObject({
        kind: 'DIRECTORY'
      });
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it('starts the Workspace directory selector at the first allowed root and allows registration only inside configured roots', async () => {
    const home = await temporaryDirectory();
    const workspaceRoot = join(home, 'projects');
    const project = join(workspaceRoot, 'my-agent-roam');
    const privateDirectory = join(home, 'private');
    await mkdir(project, { recursive: true });
    await mkdir(privateDirectory);

    await expect(listWorkspaceDirectories(undefined, [workspaceRoot], home)).resolves.toMatchObject(
      {
        homePath: home,
        currentPath: workspaceRoot,
        selectable: true,
        entries: [
          expect.objectContaining({ name: 'my-agent-roam', path: project, selectable: true })
        ]
      }
    );
    await expect(listWorkspaceDirectories(home, [workspaceRoot], home)).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ name: 'projects', path: workspaceRoot, selectable: true }),
        expect.objectContaining({ name: 'private', path: privateDirectory, selectable: false })
      ])
    });
    await expect(listWorkspaceDirectories(project, [workspaceRoot], home)).resolves.toMatchObject({
      currentPath: project,
      selectable: true,
      parentPath: workspaceRoot
    });
  });

  it('creates a single-level Workspace directory only under the real parent of an allowed root', async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const escaped = join(root, 'escaped');
    await symlink(outside, escaped);

    await expect(createWorkspaceDirectory(root, 'new-project', [root])).resolves.toBe(
      join(root, 'new-project')
    );
    await expect(access(join(root, 'new-project'))).resolves.toBeUndefined();
    await expect(createWorkspaceDirectory(root, 'nested/project', [root])).rejects.toThrow(
      'WORKSPACE_DIRECTORY_NAME_INVALID'
    );
    await expect(createWorkspaceDirectory(root, '..', [root])).rejects.toThrow(
      'WORKSPACE_DIRECTORY_NAME_INVALID'
    );
    await expect(createWorkspaceDirectory(escaped, 'project', [root])).rejects.toThrow(
      'WORKSPACE_DIRECTORY_NOT_ALLOWED'
    );
    await expect(createWorkspaceDirectory(root, 'new-project', [root])).rejects.toThrow(
      'WORKSPACE_DIRECTORY_EXISTS'
    );
  });

  it('cleans up only the empty directory created by a failed Workspace registration', async () => {
    const root = await temporaryDirectory();
    const database = {
      getWorkspaceByPath: vi.fn(() => undefined),
      saveWorkspace: vi.fn(() => {
        throw new Error('DATABASE_WRITE_FAILED');
      })
    };
    const service = new WorkspaceService(
      () => database as never,
      () => ({ serverUrl: 'http://127.0.0.1', allowedRoots: [root] }),
      {} as never,
      vi.fn()
    );

    await expect(
      service.operations()['workspace.register']!({
        path: root,
        createDirectoryName: 'cleanup-project'
      })
    ).rejects.toThrow('DATABASE_WRITE_FAILED');
    await expect(access(join(root, 'cleanup-project'))).rejects.toThrow();

    const occupiedDatabase = {
      getWorkspaceByPath: vi.fn(() => undefined),
      saveWorkspace: vi.fn((input: { path: string }) => {
        writeFileSync(join(input.path, 'keep.txt'), 'keep');
        throw new Error('DATABASE_WRITE_FAILED');
      })
    };
    const occupiedService = new WorkspaceService(
      () => occupiedDatabase as never,
      () => ({ serverUrl: 'http://127.0.0.1', allowedRoots: [root] }),
      {} as never,
      vi.fn()
    );
    await expect(
      occupiedService.operations()['workspace.register']!({
        path: root,
        createDirectoryName: 'occupied-project'
      })
    ).rejects.toThrow('DATABASE_WRITE_FAILED');
    await expect(access(join(root, 'occupied-project', 'keep.txt'))).resolves.toBeUndefined();
  });

  it('removes the legacy MAR temporary exclude while preserving local and Skill rules on registration', async () => {
    const root = await temporaryDirectory();
    const workspace = join(root, 'project');
    await mkdir(workspace);
    await execFile('git', ['init', workspace]);
    await writeFile(
      join(workspace, '.git', 'info', 'exclude'),
      '# local\n/local-only/\n# BEGIN MyAgentRoam Skills\n/.mar/\n/.agents/skills/review/\n# END MyAgentRoam Skills\n'
    );
    const database = {
      getWorkspaceByPath: vi.fn(() => undefined),
      saveWorkspace: vi.fn((input: { path: string; kind: string }) => ({
        id: 'workspace-1',
        ...input
      }))
    };
    const service = new WorkspaceService(
      () => database as never,
      () => ({ serverUrl: 'http://127.0.0.1', allowedRoots: [root] }),
      {} as never,
      vi.fn()
    );

    await service.operations()['workspace.register']!({ path: workspace });

    const exclude = await readFile(join(workspace, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).not.toContain('/.mar/');
    expect(exclude).toContain('/local-only/');
    expect(exclude).toContain('/.agents/skills/review/');
    expect(exclude).toContain('# BEGIN MyAgentRoam\n');
    expect(exclude).not.toContain('# BEGIN MyAgentRoam Skills');
  });

  it('lists only regular files under the root and rejects .git, escapes, and binary reads', async () => {
    const root = await temporaryDirectory();
    const nested = join(root, 'src');
    const outside = await temporaryDirectory();
    await mkdir(nested);
    await writeFile(join(nested, 'main.ts'), 'export const value = 1;');
    await writeFile(join(root, '.git'), 'not a directory');
    await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
    await symlink(outside, join(root, 'escape'));
    await expect(listWorkspaceFiles(root)).resolves.toMatchObject({
      entries: expect.arrayContaining([expect.objectContaining({ path: 'src', kind: 'DIRECTORY' })])
    });
    await expect(listWorkspaceFiles(root)).resolves.toMatchObject({
      entries: expect.not.arrayContaining([expect.objectContaining({ name: 'escape' })])
    });
    await expect(isWorkspaceChangeVisible(root, 'escape')).resolves.toBe(false);
    await expect(isWorkspaceChangeVisible(root, 'src/main.ts')).resolves.toBe(true);
    await expect(listWorkspaceFiles(root, '.', undefined, 1)).resolves.toMatchObject({
      entries: [expect.any(Object)],
      nextCursor: expect.any(String),
      truncated: true
    });
    await expect(searchWorkspaceFiles(root, 'main')).resolves.toMatchObject({
      entries: [expect.objectContaining({ path: 'src/main.ts', kind: 'FILE' })]
    });
    await expect(listWorkspaceFiles(root, '.', 'not-a-valid-cursor')).rejects.toThrow(
      'DIRECTORY_CURSOR_INVALID'
    );
    await expect(readWorkspaceTextFile(root, 'src/main.ts')).resolves.toMatchObject({
      content: 'export const value = 1;'
    });
    await expect(readWorkspaceTextFile(root, '.git')).rejects.toThrow('FILE_PATH_ESCAPE');
    await expect(readWorkspaceTextFile(root, 'escape')).rejects.toThrow('FILE_PATH_ESCAPE');
    await expect(readWorkspaceTextFile(root, 'binary.bin', 0, 2)).resolves.toMatchObject({
      encoding: 'base64',
      content: 'AAE=',
      nextOffset: 2
    });
    await expect(readWorkspaceTextFile(root, 'binary.bin', 2, 2)).resolves.toMatchObject({
      encoding: 'base64',
      content: 'Ag==',
      nextOffset: null
    });
    const firstRange = await readWorkspaceFileContentRange(root, 'binary.bin', 1, 1);
    expect(firstRange).toEqual({
      path: 'binary.bin',
      size: 3,
      sourceRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
      offset: 1,
      contentBase64: 'AQ==',
      nextOffset: 2
    });
    await expect(readWorkspaceFileContentRange(root, 'binary.bin', 3, 1)).resolves.toEqual({
      path: 'binary.bin',
      size: 3,
      sourceRevision: firstRange.sourceRevision,
      offset: 3,
      contentBase64: '',
      nextOffset: null
    });
  });

  it('sorts quick-open entries by fuzzy score and honors VS Code exclude', async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, '.vscode'), { recursive: true });
    await mkdir(join(root, 'node_modules'));
    await mkdir(join(root, 'src'));
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'test', 'runs'), { recursive: true });
    await writeFile(
      join(root, '.vscode', 'settings.json'),
      JSON.stringify({
        'search.exclude': { '**/*.generated.ts': true }
      })
    );
    await writeFile(join(root, 'src', 'my-agent-roam.ts'), 'safe');
    await writeFile(join(root, 'src', 'my-agent.generated.ts'), 'safe');
    await writeFile(join(root, 'node_modules', 'my-agent-roam.ts'), 'hidden');
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist', 'my-agent-roam.ts'), 'hidden');
    await writeFile(join(root, '.git', 'search-secret.txt'), 'hidden');
    await writeFile(join(root, 'test', 'runs', 'node.log'), 'hidden');
    await symlink(join(root, '.git'), join(root, 'git-alias'));
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const index = new WorkspaceFileIndex(root, { freshnessTtlMs: 30_000 });
    try {
      await expect(index.search('mar')).resolves.toMatchObject({
        entries: [expect.objectContaining({ path: 'src/my-agent-roam.ts' })]
      });
      await expect(index.search('src')).resolves.not.toMatchObject({
        entries: expect.arrayContaining([expect.objectContaining({ kind: 'DIRECTORY' })])
      });
      await expect(index.search('src', undefined, 200, true)).resolves.toMatchObject({
        entries: expect.arrayContaining([
          expect.objectContaining({ path: 'src', kind: 'DIRECTORY' })
        ])
      });
      await expect(index.search('mar')).resolves.not.toMatchObject({
        entries: expect.arrayContaining([
          expect.objectContaining({ path: 'node_modules/my-agent-roam.ts' }),
          expect.objectContaining({ path: 'dist/my-agent-roam.ts' })
        ])
      });
      await expect(index.search('mag')).resolves.toMatchObject({
        entries: [expect.objectContaining({ path: 'src/my-agent-roam.ts' })]
      });
      await expect(index.search('generated')).resolves.toMatchObject({ entries: [] });
      await expect(index.search('search-secret')).resolves.toMatchObject({ entries: [] });
      await expect(index.search('node.log')).resolves.toMatchObject({ entries: [] });
      await writeFile(join(root, 'test', 'runs', 'node.log'), 'ignored change');
      await writeFile(join(root, 'node_modules', 'runtime.log'), 'ignored change');
      await writeFile(join(root, 'src', 'new-file.ts'), 'visible change');
      await expect(index.search('new-file')).resolves.toMatchObject({ entries: [] });
      now.mockReturnValue(31_001);
      await expect(index.search('new-file')).resolves.toMatchObject({ entries: [] });
      now.mockRestore();
      await vi.waitFor(async () =>
        expect(await index.search('new-file')).toMatchObject({
          entries: [expect.objectContaining({ path: 'src/new-file.ts' })]
        })
      );
    } finally {
      now.mockRestore();
      index.dispose();
    }
  });

  it('preserves default exclusion boundaries, custom globs and canonical symlink exclusions', async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const visible = [
      'src/distance.ts',
      'dist-file.ts',
      'nested/test/runs-other/keep.ts',
      'nested/test/other/runs/keep.ts',
      'nested/.cache-other/keep.ts',
      'src/keep.ts'
    ];
    const hidden = [
      'nested/dist/hidden.ts',
      'nested/test/runs/hidden.ts',
      'nested/.cache/hidden.ts',
      'src/hidden.generated.ts',
      'src/hidden.spec.ts'
    ];
    if (process.platform !== 'win32') {
      visible.push('line\nbreak/keep.ts');
      hidden.push('line\nbreak/dist/hidden.ts');
    }
    for (const path of [...visible, ...hidden]) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), 'safe');
    }
    await mkdir(join(root, '.vscode'));
    await writeFile(
      join(root, '.vscode', 'settings.json'),
      JSON.stringify({
        'search.exclude': { '**/*.{generated,spec}.ts': true, '**/keep.ts': false }
      })
    );
    await writeFile(join(outside, 'escape.ts'), 'outside');
    await symlink(join(outside, 'escape.ts'), join(root, 'escape-alias.ts'));
    await symlink(join(root, 'nested', 'dist', 'hidden.ts'), join(root, 'dist-alias.ts'));
    await symlink(join(root, 'src', 'hidden.generated.ts'), join(root, 'custom-alias.ts'));
    const index = new WorkspaceFileIndex(root);
    try {
      const page = await index.search('ts');
      expect(page.entries.map((entry) => entry.path).sort()).toEqual(
        [...visible, '.vscode/settings.json'].sort()
      );
      expect(page.truncated).toBe(false);
    } finally {
      index.dispose();
    }
  });

  it('keeps an exact basename ahead of more than one page of weaker matches', async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, 'very', 'deep', 'path'), { recursive: true });
    await writeFile(join(root, 'very', 'deep', 'path', 'foo.ts'), 'safe');
    await Promise.all(
      Array.from({ length: 201 }, (_, index) =>
        writeFile(join(root, `bar-${String(index).padStart(3, '0')}-foo.ts`), 'safe')
      )
    );
    const index = new WorkspaceFileIndex(root);
    try {
      const page = await index.search('foo.ts');
      expect(page.entries[0]?.path).toBe('very/deep/path/foo.ts');
      expect(page.entries).toHaveLength(200);
      expect(page.truncated).toBe(true);
    } finally {
      index.dispose();
    }
  });

  it('confirms a cold nonblocking query without waiting for the shared scan', async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, 'ready.ts'), 'safe');
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const schedule = vi.fn(async (run: () => Promise<void>) => {
      await barrier;
      await run();
    });
    const index = new WorkspaceFileIndex(root, { schedule });
    try {
      await expect(index.search('ts', undefined, 200, false, false)).resolves.toMatchObject({
        entries: [],
        indexState: 'BUILDING',
        nextCursor: null,
        truncated: false
      });
      await expect(index.search('ts', undefined, 200, false, false)).resolves.toMatchObject({
        indexState: 'BUILDING'
      });
      expect(schedule).toHaveBeenCalledTimes(1);
      const legacy = index.search('ts');
      release();
      await expect(legacy).resolves.toMatchObject({
        entries: [expect.objectContaining({ path: 'ready.ts' })]
      });
      await expect(index.search('ts', undefined, 200, false, false)).resolves.toMatchObject({
        indexState: 'READY'
      });
    } finally {
      release();
      await index.refreshContentCandidates().catch(() => undefined);
      index.dispose();
    }
  });

  it('keeps queued preparation for another active Watch after the first lease is removed', async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, 'shared.ts'), 'safe');
    let neededQueued!: () => boolean;
    let release!: () => Promise<void>;
    let released = false;
    const schedule = vi.fn(
      (run: () => Promise<void>, _background: () => boolean, needed: () => boolean) => {
        neededQueued = needed;
        return new Promise<void>((resolve, reject) => {
          release = () => run().then(resolve, reject);
        });
      }
    );
    let first = true;
    let second = true;
    const index = new WorkspaceFileIndex(root, { schedule });
    try {
      const one = index.prepare(() => first);
      const two = index.prepare(() => second);
      expect(one).toBe(two);
      expect(schedule).toHaveBeenCalledTimes(1);
      first = false;
      expect(neededQueued()).toBe(true);
      released = true;
      await release();
      await one;
      expect(await index.search('shared')).toMatchObject({
        entries: [expect.objectContaining({ path: 'shared.ts' })]
      });
    } finally {
      first = false;
      second = false;
      if (!released) await release();
      index.dispose();
    }
  });

  it('rejects an invalidated waiting query rather than reporting a successful empty page', async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, 'present.ts'), 'safe');
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const index = new WorkspaceFileIndex(root, {
      schedule: async (run) => {
        await barrier;
        await run();
      }
    });
    const pending = index.search('ts');
    try {
      index.dispose();
      release();
      await expect(pending).rejects.toThrow('FILE_INDEX_INVALIDATED');
    } finally {
      release();
      await pending.catch(() => undefined);
      index.dispose();
    }
  });

  it('bounds accounted index bytes and releases retained entries on disposal', async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, 'first.ts'), 'safe');
    await writeFile(join(root, 'second.ts'), 'safe');
    const index = new WorkspaceFileIndex(root, { byteLimit: 220 });
    try {
      const page = await index.search('ts');
      expect(page.truncated).toBe(true);
      expect(index.accountedBytes).toBeLessThanOrEqual(220);
      expect(index.accountedBytes).toBeGreaterThan(0);
      index.dispose();
      expect(index.accountedBytes).toBe(0);
      expect(index.peekContentCandidates()).toBeUndefined();
    } finally {
      index.dispose();
    }
  });

  it('matches every space-separated file term regardless of path order', async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'test'));
    await writeFile(join(root, 'src', 'app.ts'), 'safe');
    await writeFile(join(root, 'test', 'app.ts'), 'safe');
    await writeFile(join(root, 'src', 'other.ts'), 'safe');
    const index = new WorkspaceFileIndex(root);
    try {
      for (const query of ['app src', 'src app', 'app   src']) {
        await expect(index.search(query)).resolves.toMatchObject({
          entries: [expect.objectContaining({ path: 'src/app.ts' })],
          nextCursor: null
        });
      }
      await expect(index.search('app missing')).resolves.toMatchObject({ entries: [] });
      await expect(index.search('app')).resolves.toMatchObject({
        entries: expect.arrayContaining([
          expect.objectContaining({ path: 'src/app.ts' }),
          expect.objectContaining({ path: 'test/app.ts' })
        ])
      });
    } finally {
      index.dispose();
    }
  });

  it('marks quick-open results incomplete when the file limit is reached', async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, 'first.ts'), 'safe');
    await writeFile(join(root, 'second.ts'), 'safe');
    const index = new WorkspaceFileIndex(root, { entryLimit: 1 });
    try {
      await expect(index.search('ts')).resolves.toMatchObject({
        entries: [expect.any(Object)],
        nextCursor: null,
        truncated: true
      });
    } finally {
      index.dispose();
    }
  });

  it('keeps paginated large-index results consistent with the complete sort order', async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, 'src'));
    await Promise.all(
      ['file-alpha.ts', 'file-beta.ts', 'profile-file.ts', 'nested-file.ts', 'final-file.ts'].map(
        (name) => writeFile(join(root, 'src', name), 'safe')
      )
    );
    const index = new WorkspaceFileIndex(root);
    try {
      const complete = await index.search('file');
      const first = await index.search('file', undefined, 2);
      const second = await index.search('file', first.nextCursor ?? undefined, 2);
      const third = await index.search('file', second.nextCursor ?? undefined, 2);
      expect([...first.entries, ...second.entries, ...third.entries]).toEqual(complete.entries);
      expect(third.nextCursor).toBeNull();
    } finally {
      index.dispose();
    }
  });

  it('continues file-range reads at UTF-8 character boundaries for browser downloads', async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, 'unicode.txt'), 'a中文b');

    const first = await readWorkspaceTextFile(root, 'unicode.txt', 0, 2);
    const second = await readWorkspaceTextFile(root, 'unicode.txt', first.nextOffset ?? 0, 2);
    const third = await readWorkspaceTextFile(root, 'unicode.txt', second.nextOffset ?? 0, 2);
    const fourth = await readWorkspaceTextFile(root, 'unicode.txt', third.nextOffset ?? 0, 2);

    expect([first.content, second.content, third.content, fourth.content].join('')).toBe('a中文b');
    expect(fourth.nextOffset).toBeNull();
    await expect(readWorkspaceTextFile(root, 'unicode.txt', 2, 2)).rejects.toThrow(
      'FILE_RANGE_INVALID'
    );
  });

  it('classifies preview contents independently of unknown file suffixes', async () => {
    const root = await temporaryDirectory();
    for (const path of ['script.mts', 'script.cts', 'notes.custom', 'LICENSE']) {
      await writeFile(join(root, path), 'export const value = "中文";');
      await expect(readWorkspaceTextFile(root, path)).resolves.toMatchObject({
        path,
        encoding: 'utf-8',
        content: 'export const value = "中文";',
        nextOffset: null
      });
    }
    await writeFile(join(root, 'empty.mts'), '');
    await expect(readWorkspaceTextFile(root, 'empty.mts')).resolves.toMatchObject({
      encoding: 'utf-8',
      content: '',
      size: 0,
      nextOffset: null
    });
    for (const [path, bytes] of [
      ['binary.mts', Buffer.from([65, 0, 66])],
      ['invalid.cts', Buffer.from([0xff])]
    ] as const) {
      await writeFile(join(root, path), bytes);
      await expect(readWorkspaceTextFile(root, path)).resolves.toMatchObject({
        encoding: 'base64',
        content: bytes.toString('base64')
      });
    }
  });

  it('reads regular absolute files outside Workspace roots while preserving UTF-8 ranges', async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const nested = join(root, 'nested');
    await mkdir(nested);
    await writeFile(join(nested, 'unicode.txt'), 'a中文b');
    await writeFile(join(outside, 'secret.txt'), 'secret');

    const first = await readAbsoluteTextFile(join(nested, 'unicode.txt'), 0, 2);
    const second = await readAbsoluteTextFile(
      join(nested, 'unicode.txt'),
      first.nextOffset ?? 0,
      2
    );
    const third = await readAbsoluteTextFile(
      join(nested, 'unicode.txt'),
      second.nextOffset ?? 0,
      2
    );
    const fourth = await readAbsoluteTextFile(
      join(nested, 'unicode.txt'),
      third.nextOffset ?? 0,
      2
    );
    expect(`${first.content}${second.content}${third.content}${fourth.content}`).toBe('a中文b');
    expect(fourth.nextOffset).toBeNull();
    await expect(readAbsoluteTextFile(join(outside, 'secret.txt'))).resolves.toMatchObject({
      content: 'secret',
      encoding: 'utf-8'
    });
    await expect(readAbsoluteTextFile(outside)).rejects.toThrow('FILE_NOT_REGULAR');
    await expect(readAbsoluteTextFile('relative.txt')).rejects.toThrow('FILE_PATH_ESCAPE');
  });

  it('restricts Git refs and generates a unified cross-platform service definition', () => {
    expect(() => assertSafeGitRef('main')).not.toThrow();
    expect(() => assertSafeGitRef('main..other')).toThrow('GIT_REF_INVALID');
    expect(() => assertSafeGitRef('--upload-pack=x')).toThrow('GIT_REF_INVALID');
    expect(nextReconnectDelay(0)).toBe(500);
    expect(nextReconnectDelay(4)).toBe(8_000);
    expect(nextReconnectDelay(99)).toBe(30_000);
    expect(systemdUnit('/usr/bin/node', '/etc/mar-node.json')).toContain('NoNewPrivileges=true');
    expect(
      systemdUnit('/usr/bin/node', '/etc/mar-node.json', undefined, ['/var/lib/mar-node'])
    ).toContain('ReadWritePaths="/var/lib/mar-node"');
    expect(JSON.parse(windowsServiceDefinition('node.exe', 'node.json'))).toMatchObject({
      serviceName: 'MyAgentRoamNode',
      account: 'LocalService'
    });
    expect(
      launchdServiceDefinition('/usr/local/bin/node', '/Users/mar-node/mar-node.json')
    ).toContain('<string>com.myagentroam.node</string>');
  });

  it('distinguishes staged, unstaged, and untracked Git Changes', async () => {
    const repository = await temporaryDirectory();
    await git(repository, ['init', '-b', 'main']);
    await git(repository, ['config', 'user.email', 'test@example.invalid']);
    await git(repository, ['config', 'user.name', 'Test']);
    await writeFile(join(repository, 'tracked.txt'), 'base');
    await git(repository, ['add', 'tracked.txt']);
    await git(repository, ['commit', '-m', 'base']);
    await writeFile(join(repository, 'tracked.txt'), 'unstaged');
    await writeFile(join(repository, 'staged.txt'), 'staged');
    await git(repository, ['add', 'staged.txt']);
    await writeFile(join(repository, 'untracked.txt'), 'untracked');
    await expect(readCurrentChanges(repository)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'tracked.txt', state: 'UNSTAGED', change: 'MODIFIED' }),
        expect.objectContaining({ path: 'staged.txt', state: 'STAGED', change: 'ADDED' }),
        expect.objectContaining({ path: 'untracked.txt', state: 'UNTRACKED', change: 'ADDED' })
      ])
    );
    await expect(readCurrentChangesSummary(repository)).resolves.toMatchObject({ branch: 'main' });
  });

  it('reads uncommitted branch information for Current Changes with one Git status call', async () => {
    const repository = await temporaryDirectory();
    await git(repository, ['init', '-b', 'unborn-branch']);
    await expect(readCurrentChangesSummary(repository)).resolves.toEqual({
      branch: 'unborn-branch',
      changes: []
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'my-agent-roam-node-')));
  directories.push(path);
  return path;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFile('git', args, { cwd });
  return result.stdout;
}
