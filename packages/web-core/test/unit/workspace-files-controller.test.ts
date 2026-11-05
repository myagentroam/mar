import { expect, it, vi } from 'vitest';
import {
  createWorkspaceFilesController,
  workspaceFileTreeRootName
} from '../../src/service/workspace-files-controller.js';

const treeOptions = {
  workspaceName: () => 'workspace',
  list: async () => ({ entries: [], nextCursor: null }),
  onWorkspace: vi.fn(),
  onDeletedSelection: vi.fn(),
  onRevealSelection: vi.fn(async () => {}),
  onMutationFailure: vi.fn(),
  mutate: vi.fn(async () => undefined),
  revealLocal: vi.fn(async () => {})
};

it.each([
  ['/home/example/my-agent-roam', 'my-agent-roam'],
  ['/home/example/MyAgentRoam///', 'MyAgentRoam'],
  ['/project', 'project'],
  ['D:\\Work\\MyAgentRoam\\', 'MyAgentRoam'],
  ['\\\\server\\share\\project\\', 'project'],
  ['/', '/'],
  ['C:\\', 'C:\\']
])('uses the directory name for Workspace path %s', (path, expected) => {
  expect(workspaceFileTreeRootName(path, 'Workspace alias')).toBe(expected);
});

it('keeps current Workspace root naming when restoring an older tree snapshot', () => {
  let name = 'my-agent-roam';
  const controller = createWorkspaceFilesController({
    ...treeOptions,
    workspaceName: () => name,
    target: () => ({ nodeId: 'n', workspaceId: 'w' }),
    preflight: vi.fn(),
    queue: vi.fn(),
    onFailure: vi.fn()
  });
  const snapshot = controller.tree.snapshot();
  snapshot.root.name = 'Stale workspace alias';
  controller.restoreTree(snapshot);
  expect(controller.tree.root.value.name).toBe('my-agent-roam');
  name = 'ActualFolder';
  controller.tree.setRootName(name);
  expect(controller.tree.root.value.name).toBe('ActualFolder');
});

it.each(['success', 'failure'] as const)(
  'clears a hidden upload preflight and ignores its late %s',
  async (outcome) => {
    let resolve!: (value: { status: 'READY'; path: string }[]) => void;
    let reject!: (reason: unknown) => void;
    const onFailure = vi.fn();
    const queue = vi.fn();
    const controller = createWorkspaceFilesController({
      ...treeOptions,
      target: () => ({ nodeId: 'n', workspaceId: 'a' }),
      preflight: () => new Promise((accept, fail) => ((resolve = accept), (reject = fail))),
      queue,
      onFailure
    });
    const pending = controller.preflight([{ name: 'one' } as File], '.');
    expect(controller.preparing.value).toBe(true);
    controller.invalidate();
    expect(controller.preparing.value).toBe(false);
    if (outcome === 'success') resolve([{ status: 'READY', path: 'one' }]);
    else reject(new Error('late'));
    expect(await pending).toBeUndefined();
    expect(onFailure).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
  }
);

it('queues only valid upload choices synchronously against the captured target', async () => {
  let target = { nodeId: 'n', workspaceId: 'a' };
  const queue = vi.fn((_: readonly { file: File; directory: string; overwrite: boolean }[]) =>
    expect(target.workspaceId).toBe('a')
  );
  const controller = createWorkspaceFilesController({
    ...treeOptions,
    target: () => target,
    preflight: async () => [
      { status: 'READY', path: 'one' },
      { status: 'EXISTS_FILE', path: 'two' },
      { status: 'EXISTS_DIRECTORY', path: 'three' }
    ],
    queue,
    onFailure: vi.fn()
  });
  const files = ['one', 'two', 'three'].map((name) => ({ name }) as File);
  const transaction = (await controller.preflight(files, 'dir'))!;
  expect(controller.submit(transaction, [false, true, true])).toBe(1);
  target = { nodeId: 'n', workspaceId: 'b' };
  expect(queue).toHaveBeenCalledOnce();
  expect(queue.mock.calls[0]?.[0]).toEqual([
    { file: files[0], directory: 'dir', overwrite: false },
    { file: files[1], directory: 'dir', overwrite: true }
  ]);
  expect(controller.submit(transaction, [false, true, true])).toBeUndefined();
});

it('rejects a stale preflight after A to B to A without queuing or projecting failure', async () => {
  let target = { nodeId: 'n', workspaceId: 'a' };
  let reject!: (reason: unknown) => void;
  const queue = vi.fn();
  const onFailure = vi.fn();
  const controller = createWorkspaceFilesController({
    ...treeOptions,
    target: () => target,
    preflight: () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
    queue,
    onFailure
  });
  const pending = controller.preflight([{ name: 'one' } as File], '.');
  target = { nodeId: 'n', workspaceId: 'b' };
  controller.invalidate();
  target = { nodeId: 'n', workspaceId: 'a' };
  controller.invalidate();
  reject(new Error('old request'));
  expect(await pending).toBeUndefined();
  expect(controller.preparing.value).toBe(false);
  expect(queue).not.toHaveBeenCalled();
  expect(onFailure).not.toHaveBeenCalled();
});

it('does not submit an already prepared transaction after returning to the same target', async () => {
  let target = { nodeId: 'n', workspaceId: 'a' };
  const queue = vi.fn();
  const controller = createWorkspaceFilesController({
    ...treeOptions,
    target: () => target,
    preflight: async () => [{ status: 'READY', path: 'one' }],
    queue,
    onFailure: vi.fn()
  });
  const transaction = (await controller.preflight([{ name: 'one' } as File], '.'))!;
  target = { nodeId: 'n', workspaceId: 'b' };
  controller.invalidate();
  target = { nodeId: 'n', workspaceId: 'a' };
  controller.invalidate();
  expect(controller.isCurrentPreflight(transaction)).toBe(false);
  expect(controller.submit(transaction, [false])).toBeUndefined();
  expect(queue).not.toHaveBeenCalled();
});

it('does not apply an old file mutation after switching A to B and back to A', async () => {
  let target = { nodeId: 'n', workspaceId: 'a' };
  let resolve!: (path: string) => void;
  const mutate = vi.fn(() => new Promise<string>((accept) => (resolve = accept)));
  const controller = createWorkspaceFilesController({
    ...treeOptions,
    target: () => target,
    mutate,
    preflight: async () => [],
    queue: vi.fn(),
    onFailure: vi.fn()
  });
  const scope = controller.captureTarget()!;
  const pending = controller.mutate(scope, 'MOVE', 'old', 'new');
  target = { nodeId: 'n', workspaceId: 'b' };
  controller.resetTree();
  target = { nodeId: 'n', workspaceId: 'a' };
  controller.resetTree();
  resolve('new');
  expect(await pending).toBeUndefined();
  expect(controller.isCurrentTarget(scope)).toBe(false);
  expect(await controller.mutate(scope, 'DELETE', 'old')).toBeUndefined();
  expect(mutate).toHaveBeenCalledOnce();
});

it('does not let a stale tree refresh clear a new target refresh', async () => {
  let target = { nodeId: 'n', workspaceId: 'a' };
  const reads: Array<(value: { entries: never[]; nextCursor: null }) => void> = [];
  const controller = createWorkspaceFilesController({
    ...treeOptions,
    target: () => target,
    list: () => new Promise((resolve) => reads.push(resolve)),
    preflight: async () => [],
    queue: vi.fn(),
    onFailure: vi.fn()
  });
  const old = controller.requestRefresh();
  target = { nodeId: 'n', workspaceId: 'b' };
  controller.resetTree();
  const current = controller.requestRefresh();
  expect(controller.refreshing.value).toBe(true);
  reads[0]!({ entries: [], nextCursor: null });
  await old;
  expect(controller.refreshing.value).toBe(true);
  reads[1]!({ entries: [], nextCursor: null });
  await current;
  expect(controller.refreshing.value).toBe(false);
  expect(controller.tree.root.value.loaded).toBe(true);
});
