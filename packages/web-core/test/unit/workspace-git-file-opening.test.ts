import { expect, it, vi } from 'vitest';
import type { ChangeEntry } from '../../src/model/workspace-git.js';
import { createWorkspaceFileWorkbenchController } from '../../src/service/workspace-file-workbench-controller.js';
import { createWorkspaceGitService } from '../../src/service/workspace-git-service.js';
import { createScopedHttpService } from '../../src/service/scoped-http-service.js';
import { gitFileRepositoryPath } from '../../src/util/workspace-git.js';
import { createFileAccessFixture } from '../support/file-access-fixture.js';

const target = { nodeId: 'node', workspaceId: 'workspace' };
const entry: ChangeEntry = {
  repositoryPath: 'packages/child',
  repositoryName: 'child',
  source: 'SUBMODULE',
  path: 'src/main.ts',
  state: 'UNSTAGED',
  change: 'MODIFIED',
  diffAvailable: true
};

it.each([
  ['root', '', undefined, '/root', '/root', undefined],
  ['submodule', 'packages/child', undefined, '/root', '/root', undefined],
  ['nested submodule', 'packages/child/nested', undefined, '/root', '/root', undefined],
  ['Windows submodule', 'packages/child', undefined, 'C:\\root', 'C:\\root', undefined],
  ['parent root', '', undefined, '/root', '/root/subdir', ''],
  ['parent submodule', 'packages/child', undefined, '/root', '/root/subdir', 'packages/child'],
  ['unknown root', 'packages/child', undefined, undefined, '/root', 'packages/child'],
  ['unknown Workspace', 'packages/child', undefined, '/root', undefined, 'packages/child'],
  ['linked worktree', '', '/linked', '/root', '/root', undefined]
] as const)(
  'retains a repository target only when needed for %s',
  (_name, repositoryPath, worktreePath, repositoryRoot, workspacePath, expected) => {
    expect(gitFileRepositoryPath(repositoryPath, worktreePath, repositoryRoot, workspacePath)).toBe(
      expected
    );
  }
);

function createWorkbench(workspacePath: string, repositoryRoot?: string) {
  const request = vi.fn(async (url: string): Promise<unknown> =>
    url.endsWith('/files/write')
      ? { file: { revision: 'r2', size: 20 } }
      : {
          file: {
            encoding: 'utf-8',
            content: 'export const value = 1;',
            size: 23,
            nextOffset: null,
            revision: 'r1'
          }
        }
  );
  const http = { request } as unknown as ReturnType<typeof createScopedHttpService>;
  const git = createWorkspaceGitService({
    http,
    target: () => target,
    gitEnabled: () => true,
    historyEnabled: () => true,
    workspacePath: () => workspacePath,
    onFailure: vi.fn(),
    onWorkspace: vi.fn(),
    onBranch: vi.fn()
  });
  git.applyWatch({ repositoryRoot, repositories: [] }, 1);
  const owner = createWorkspaceFileWorkbenchController({
    target: () => target,
    externalTarget: () => target,
    fileWriteEnabled: () => true,
    onPopupBlocked: vi.fn(),
    prewarmEnabled: () => false,
    resolveRepositoryPath: git.resolveRepositoryPathForOpen,
    reveal: async () => {},
    onOpenFailure: vi.fn(),
    onRevealFailure: vi.fn(),
    comparison: async () => undefined,
    page: () => undefined,
    access: createFileAccessFixture({ http, transfers: () => ({}) }),
    preview: { onWritten: vi.fn() },
    navigation: { http, onFailure: vi.fn(), onFileTarget: vi.fn() }
  });
  return { owner, git, request };
}

it.each([false, true])(
  'opens a Workspace submodule source as an ordinary writable file (cached Git marker=%s)',
  async (cachedGitMarker) => {
    const { owner, git, request } = createWorkbench('/root', '/root');
    try {
      const intent = git.changeIntent(entry)!;
      expect(intent.gitFile).toBeUndefined();
      expect(git.changeLocation(entry)).toEqual({ path: 'packages/child/src/main.ts' });
      await owner.openTab(intent);
      const sourceId = await owner.openWorktreeDiffText({
        ...intent,
        ...(cachedGitMarker ? { gitFile: true } : {})
      });
      const tab = owner.activeTab.value!;
      expect(sourceId).toBe(tab.id);
      const frame = owner.frames.value.find((candidate) => candidate.id === tab.id)!;
      expect(tab).toMatchObject({ kind: 'WORKTREE_TEXT', path: 'packages/child/src/main.ts' });
      expect(tab.gitFile).toBeUndefined();
      expect(frame.repositoryPath).toBeUndefined();
      expect(frame.worktreePath.value).toBeUndefined();
      await owner.saveFile(tab.id, 'export const value = 2;', 'r1');
      expect(request.mock.calls.some(([url]) => url.endsWith('/files/write'))).toBe(true);
      const readUrl = new URL(request.mock.calls[0]![0], 'http://fixture');
      expect(readUrl.searchParams.get('path')).toBe('packages/child/src/main.ts');
      expect(readUrl.searchParams.has('repositoryPath')).toBe(false);
      const requests = request.mock.calls.length;
      await owner.openTab(intent);
      await owner.openWorktreeDiffText(intent);
      expect(request.mock.calls).toHaveLength(requests);
      expect(frame.fileContent.value?.revision).toBe('r2');
      await owner.openFile('packages/child/src/main.ts');
      expect(owner.activeTab.value!.id).toBe(tab.id);
      expect(owner.tabList.value).toHaveLength(2);
    } finally {
      owner.dispose();
      git.reset();
    }
  }
);

it.each([
  ['parent repository', '/root/subdir', '/root', undefined],
  ['unknown root', '/root', undefined, undefined],
  ['linked worktree', '/root', '/root', '/linked']
] as const)(
  'keeps a %s source scoped and rejects writes',
  async (_name, workspacePath, repositoryRoot, worktreePath) => {
    const { owner, git, request } = createWorkbench(workspacePath, repositoryRoot);
    try {
      const intent = git.changeIntent({ ...entry, ...(worktreePath ? { worktreePath } : {}) })!;
      const sourceId = await owner.openWorktreeDiffText(intent);
      const frame = owner.frames.value[0]!;
      expect(sourceId).toBe(frame.id);
      expect(frame.fileContent.value?.path).toBe('src/main.ts');
      expect(frame.worktreePath.value).toBe(worktreePath);
      expect(frame.repositoryPath).toBe(worktreePath ? undefined : 'packages/child');
      await expect(owner.saveFile(frame.id, 'changed', 'r1')).rejects.toThrow('FILE_WRITE_INVALID');
      expect(request.mock.calls.some(([url]) => url.endsWith('/files/write'))).toBe(false);
    } finally {
      owner.dispose();
      git.reset();
    }
  }
);

it('does not reuse a same-named Git or historical preview for an ordinary file', async () => {
  const { owner, git } = createWorkbench('/root', '/root');
  try {
    await owner.openWorkspaceFile('src/main.ts', undefined, undefined, false, undefined, '');
    await owner.openHistoryText({
      kind: 'HISTORY_DIFF',
      ...target,
      path: 'src/main.ts',
      repositoryPath: '',
      worktreePath: '',
      commit: 'a'.repeat(40)
    });
    await owner.openFile('src/main.ts');
    const tab = owner.activeTab.value!;
    const frame = owner.frames.value.find((candidate) => candidate.id === tab.id)!;
    expect(owner.tabList.value).toHaveLength(3);
    expect(frame.repositoryPath).toBeUndefined();
    expect(frame.historySource).toBeUndefined();
    await owner.saveFile(tab.id, 'changed', 'r1');
  } finally {
    owner.dispose();
    git.reset();
  }
});

it.each(['src/main.ts', 'image.png'])(
  'waits for delayed Git metadata before opening a standalone %s source',
  async (path) => {
    const { owner, git, request } = createWorkbench('/root', '/root');
    try {
      const intent = git.changeIntent({ ...entry, path })!;
      git.reset();
      let resolve!: (value: unknown) => void;
      request.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
      const opening = path.endsWith('.png')
        ? owner.openStandalone({ ...target, path, tab: intent })
        : owner.openWorktreeDiffText(intent);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      expect(request.mock.calls[0]![0]).toContain('/changes?');
      expect(owner.frames.value).toHaveLength(0);
      resolve({ repositoryRoot: '/root', repositories: [] });
      await opening;
      const frame = owner.frames.value[0]!;
      expect(frame.repositoryPath).toBeUndefined();
      expect(frame.fileContent.value?.path).toBe(`packages/child/${path}`);
      const fileRead = new URL(
        path.endsWith('.png') ? frame.contentUrl.value! : request.mock.calls[1]![0],
        'http://fixture'
      );
      expect(fileRead.searchParams.get('path')).toBe(`packages/child/${path}`);
      expect(fileRead.searchParams.has('repositoryPath')).toBe(false);
    } finally {
      owner.dispose();
      git.reset();
    }
  }
);

it('keeps the standalone source read-only if Git metadata cannot be loaded', async () => {
  const { owner, git, request } = createWorkbench('/root', '/root');
  try {
    const intent = git.changeIntent(entry)!;
    git.reset();
    request.mockRejectedValueOnce(new Error('CHANGES_READ_FAILED'));
    await owner.openWorktreeDiffText(intent);
    const frame = owner.frames.value[0]!;
    expect(frame.repositoryPath).toBe('packages/child');
    expect(frame.fileContent.value?.path).toBe('src/main.ts');
    await expect(owner.saveFile(frame.id, 'changed', 'r1')).rejects.toThrow('FILE_WRITE_INVALID');
  } finally {
    owner.dispose();
    git.reset();
  }
});

it('does not reopen a source after its metadata wait is superseded', async () => {
  const { owner, git, request } = createWorkbench('/root', '/root');
  try {
    const intent = git.changeIntent(entry)!;
    git.reset();
    let resolve!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    const opening = owner.openWorktreeDiffText(intent);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await owner.openFile('other.ts');
    const activeId = owner.activeTab.value!.id;
    resolve({ repositoryRoot: '/root', repositories: [] });
    expect(await opening).toBeUndefined();
    expect(owner.activeTab.value!.id).toBe(activeId);
    expect(owner.tabList.value).toHaveLength(1);
    expect(owner.frames.value[0]!.fileContent.value?.path).toBe('other.ts');
  } finally {
    owner.dispose();
    git.reset();
  }
});

it.each(['/root', '/root/subdir'])(
  'does not return a source identity after its file read is superseded in %s',
  async (workspacePath) => {
    const { owner, git, request } = createWorkbench(workspacePath, '/root');
    try {
      const intent = git.changeIntent(entry)!;
      let resolve!: (value: unknown) => void;
      request.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
      const opening = owner.openWorktreeDiffText(intent);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      await owner.openFile('other.ts');
      const activeId = owner.activeTab.value!.id;
      resolve({
        file: {
          encoding: 'utf-8',
          content: 'original source',
          size: 15,
          nextOffset: null,
          revision: 'r1'
        }
      });
      expect(await opening).toBeUndefined();
      expect(owner.activeTab.value!.id).toBe(activeId);
      expect(owner.activeTab.value!.path).toBe('other.ts');
    } finally {
      owner.dispose();
      git.reset();
    }
  }
);
