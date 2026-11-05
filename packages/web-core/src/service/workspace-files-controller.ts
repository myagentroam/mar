import { readonly, ref } from 'vue';
import type {
  WorkspaceFileOperationTarget,
  WorkspaceUploadCandidate
} from './workspace-file-operation-service.js';
import {
  createWorkspaceFileTreeService,
  type WorkspaceFileTreePage,
  type WorkspaceFileTreeWorkspace
} from './workspace-file-tree-service.js';
import { createTrailingTask } from '../util/trailing-task.js';

export function workspaceFileTreeRootName(path: string | undefined, fallback: string): string {
  if (!path) return fallback;
  if (/^[a-z]:[\\/]+$/iu.test(path)) return path;
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

export interface WorkspaceUploadPreflight {
  readonly target: WorkspaceFileOperationTarget;
  readonly generation: number;
  readonly directory: string;
  readonly files: readonly File[];
  readonly candidates: readonly WorkspaceUploadCandidate[];
}

export interface WorkspaceFilesTarget {
  readonly target: WorkspaceFileOperationTarget;
  readonly generation: number;
}

export function createWorkspaceFilesController(options: {
  readonly target: () => WorkspaceFileOperationTarget | undefined;
  readonly preflight: (
    target: WorkspaceFileOperationTarget,
    directory: string,
    names: readonly string[]
  ) => Promise<readonly WorkspaceUploadCandidate[]>;
  readonly queue: (
    uploads: readonly { file: File; directory: string; overwrite: boolean }[]
  ) => void;
  readonly onFailure: (error: unknown) => void;
  readonly workspaceName: () => string;
  readonly list: (
    target: WorkspaceFileOperationTarget,
    path: string,
    cursor?: string
  ) => Promise<WorkspaceFileTreePage>;
  readonly onWorkspace: (workspace: WorkspaceFileTreeWorkspace) => void;
  readonly onDeletedSelection: () => void;
  readonly onRevealSelection: (path: string, current: () => boolean) => Promise<void>;
  readonly onMutationFailure: (
    error: unknown,
    context: 'operation' | 'move',
    target: WorkspaceFileOperationTarget,
    path: string
  ) => void;
  readonly mutate: (
    target: WorkspaceFileOperationTarget,
    action: 'CREATE_FILE' | 'CREATE_DIRECTORY' | 'MOVE' | 'DELETE',
    path: string,
    destination: string | undefined,
    current: () => boolean
  ) => Promise<string | undefined>;
  readonly revealLocal: (target: WorkspaceFileOperationTarget, path: string) => Promise<void>;
}) {
  let generation = 0;
  const preparing = ref(false);
  const refreshing = ref(false);
  let treeGeneration = 0;
  function captureTarget(): WorkspaceFilesTarget | undefined {
    const target = options.target();
    return target === undefined ? undefined : { target: { ...target }, generation: treeGeneration };
  }
  function isCurrentTarget(scope: WorkspaceFilesTarget): boolean {
    const target = options.target();
    return (
      scope.generation === treeGeneration &&
      target?.nodeId === scope.target.nodeId &&
      target.workspaceId === scope.target.workspaceId
    );
  }
  async function mutate(
    scope: WorkspaceFilesTarget,
    action: 'CREATE_FILE' | 'CREATE_DIRECTORY' | 'MOVE' | 'DELETE',
    path: string,
    destination?: string,
    context: 'operation' | 'move' = 'operation'
  ): Promise<string | undefined> {
    if (!isCurrentTarget(scope)) return undefined;
    const current = () => isCurrentTarget(scope);
    const previousSelection = tree.selectedPath.value;
    let result: string | undefined;
    try {
      result = await options.mutate(scope.target, action, path, destination, current);
    } catch (error) {
      options.onMutationFailure(error, context, scope.target, path);
      return undefined;
    }
    try {
      if (!current()) return undefined;
      if (action === 'DELETE') {
        if (previousSelection === path || previousSelection?.startsWith(`${path}/`))
          options.onDeletedSelection();
      } else if (result !== undefined) {
        const selected =
          action === 'MOVE' && previousSelection?.startsWith(`${path}/`)
            ? `${result}${previousSelection.slice(path.length)}`
            : result;
        await tree.reveal(selected, current);
        if (!current()) return undefined;
        tree.selectPath(selected);
        await options.onRevealSelection(selected, current);
      }
      return current() ? result : undefined;
    } catch (error) {
      if (current()) options.onMutationFailure(error, context, scope.target, path);
      return undefined;
    }
  }
  async function revealLocal(scope: WorkspaceFilesTarget, path: string): Promise<void> {
    if (isCurrentTarget(scope)) await options.revealLocal(scope.target, path);
  }
  const tree = createWorkspaceFileTreeService({
    workspaceName: options.workspaceName,
    async list(path, cursor) {
      const target = options.target();
      if (target === undefined) throw new Error('FILE_TREE_NOT_READY');
      return options.list({ ...target }, path, cursor);
    }
  });
  async function refresh(): Promise<void> {
    const generation = treeGeneration;
    const target = options.target();
    if (target === undefined) return;
    const page = await tree.refresh();
    const active = options.target();
    if (
      generation === treeGeneration &&
      active?.nodeId === target.nodeId &&
      active.workspaceId === target.workspaceId &&
      page?.workspace !== undefined
    )
      options.onWorkspace(page.workspace);
  }
  function makeRefreshTask() {
    const generation = treeGeneration;
    return createTrailingTask(async () => {
      if (generation !== treeGeneration) return;
      refreshing.value = true;
      try {
        await refresh();
      } finally {
        if (generation === treeGeneration) refreshing.value = false;
      }
    });
  }
  let refreshTask = makeRefreshTask();
  function invalidateTree(): void {
    treeGeneration += 1;
    refreshing.value = false;
    refreshTask = makeRefreshTask();
  }
  function resetTree(): void {
    invalidateTree();
    tree.reset();
  }
  function restoreTree(snapshot: Parameters<typeof tree.restore>[0]): void {
    invalidateTree();
    tree.restore(snapshot);
    tree.setRootName(options.workspaceName());
  }
  function invalidate(): void {
    generation += 1;
    preparing.value = false;
  }
  function current(transaction: Pick<WorkspaceUploadPreflight, 'target' | 'generation'>): boolean {
    const target = options.target();
    return (
      transaction.generation === generation &&
      target?.nodeId === transaction.target.nodeId &&
      target.workspaceId === transaction.target.workspaceId
    );
  }
  async function preflight(
    files: readonly File[],
    directory: string
  ): Promise<WorkspaceUploadPreflight | undefined> {
    const target = options.target();
    if (target === undefined || files.length === 0) return undefined;
    const transaction = { target: { ...target }, generation: ++generation };
    const selected = [...files];
    preparing.value = true;
    try {
      const candidates = await options.preflight(
        transaction.target,
        directory,
        selected.map((file) => file.name)
      );
      if (!current(transaction)) return undefined;
      return { ...transaction, directory, files: selected, candidates };
    } catch (error) {
      if (current(transaction)) options.onFailure(error);
      return undefined;
    } finally {
      if (current(transaction)) preparing.value = false;
    }
  }
  function submit(
    transaction: WorkspaceUploadPreflight,
    overwrite: readonly boolean[]
  ): number | undefined {
    if (!current(transaction)) return undefined;
    const accepted = transaction.files.flatMap((file, index) => {
      const candidate = transaction.candidates[index];
      const replace = overwrite[index] === true;
      return candidate?.status === 'READY' || (candidate?.status === 'EXISTS_FILE' && replace)
        ? [{ file, directory: transaction.directory, overwrite: replace }]
        : [];
    });
    invalidate();
    if (accepted.length > 0) options.queue(accepted);
    return transaction.files.length - accepted.length;
  }
  return {
    tree,
    captureTarget,
    isCurrentTarget,
    mutate,
    revealLocal,
    refreshing: readonly(refreshing),
    refresh,
    requestRefresh: () => refreshTask.request(),
    resetTree,
    invalidateTree,
    restoreTree,
    preflight,
    submit,
    invalidate,
    isCurrentPreflight: current,
    preparing: readonly(preparing)
  };
}
