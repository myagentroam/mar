import { ref, toRaw } from 'vue';
import { isComposerAttachmentResourcePath } from '@myagentroam/protocol';
import { errorCode } from '../util/api-error.js';

export interface WorkspaceFileTreeEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: 'FILE' | 'DIRECTORY';
  readonly size: number | null;
}

export interface WorkspaceFileTreePage {
  readonly entries: readonly WorkspaceFileTreeEntry[];
  readonly nextCursor: string | null;
  readonly workspace?: WorkspaceFileTreeWorkspace;
}

export interface WorkspaceFileTreeWorkspace {
  readonly id: string;
  readonly path: string;
  readonly kind: 'DIRECTORY' | 'GIT_WORKSPACE';
  readonly gitSummary?: { readonly branch: string | null };
}

export interface WorkspaceFileTreeNode extends WorkspaceFileTreeEntry {
  name: string;
  children: WorkspaceFileTreeNode[];
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  failedAppend?: boolean | undefined;
  failure?: unknown;
  nextCursor: string | null;
  placeholder: boolean;
}

export interface WorkspaceFileTreeVisibleRow {
  readonly node: WorkspaceFileTreeNode;
  readonly depth: number;
  readonly loadMore: boolean;
}

export interface WorkspaceFileTreeWindow {
  readonly start: number;
  readonly end: number;
  readonly offset: number;
  readonly totalHeight: number;
}

export interface WorkspaceFileTreeSnapshot {
  readonly root: WorkspaceFileTreeNode;
  readonly selectedPath?: string;
}

interface WorkspaceFileTreeOptions {
  readonly workspaceName: () => string;
  readonly list: (path: string, cursor?: string) => Promise<WorkspaceFileTreePage>;
}

export function createWorkspaceFileTreeService(options: WorkspaceFileTreeOptions) {
  const root = ref(createRoot(options.workspaceName()));
  const selectedPath = ref<string>();
  const refreshError = ref<{ readonly cause: unknown }>();
  let generation = 0;
  let rootRevision = 0;
  const pendingLoads = new WeakMap<
    WorkspaceFileTreeNode,
    Promise<WorkspaceFileTreePage | undefined>
  >();

  async function load(
    node: WorkspaceFileTreeNode,
    append = false
  ): Promise<WorkspaceFileTreePage | undefined> {
    const pending = pendingLoads.get(node);
    if (pending !== undefined) return pending;
    const request = loadPage(node, append);
    pendingLoads.set(node, request);
    try {
      return await request;
    } finally {
      if (pendingLoads.get(node) === request) pendingLoads.delete(node);
    }
  }

  async function loadPage(
    node: WorkspaceFileTreeNode,
    append = false
  ): Promise<WorkspaceFileTreePage | undefined> {
    if (node.kind !== 'DIRECTORY' || node.loading) return undefined;
    const current = generation;
    const rootRequest = node === root.value ? rootRevision : undefined;
    const valid = () =>
      current === generation && (rootRequest === undefined || rootRequest === rootRevision);
    node.loading = true;
    try {
      const page = await options.list(
        node.path,
        append ? (node.nextCursor ?? undefined) : undefined
      );
      if (!valid()) return undefined;
      node.children = mergeChildren(append ? node.children : [], page.entries);
      node.nextCursor = page.nextCursor;
      node.loaded = true;
      node.failedAppend = undefined;
      node.failure = undefined;
      node.placeholder = false;
      return page;
    } catch (error) {
      if (valid()) {
        node.failedAppend = append;
        node.failure = error;
      }
      return undefined;
    } finally {
      if (valid()) {
        node.loading = false;
      }
    }
  }

  async function toggle(node: WorkspaceFileTreeNode): Promise<void> {
    if (node.kind !== 'DIRECTORY') return;
    node.expanded = !node.expanded;
    if (node.expanded && !node.loaded) await load(node);
  }

  function reset(): void {
    generation += 1;
    root.value = createRoot(options.workspaceName());
    selectedPath.value = undefined;
    refreshError.value = undefined;
  }

  async function refresh(): Promise<WorkspaceFileTreePage | undefined> {
    const expanded = expandedPaths(root.value);
    const loadedCounts = directoryChildCounts(root.value);
    const selected = selectedPath.value;
    generation += 1;
    const current = generation;
    const nextRoot = createRoot(options.workspaceName());
    const failed = (node: WorkspaceFileTreeNode) => {
      if (current === generation) refreshError.value = { cause: node.failure };
      return undefined;
    };
    const rootPage = await load(nextRoot);
    if (rootPage === undefined) return failed(nextRoot);
    if (!(await loadToCount(nextRoot, loadedCounts.get('.') ?? 0))) return failed(nextRoot);
    for (const path of expanded.filter((value) => value !== '.')) {
      const node = findNode(nextRoot, path);
      if (node?.kind !== 'DIRECTORY') continue;
      node.expanded = true;
      if ((await load(node)) === undefined) return failed(node);
      if (!(await loadToCount(node, loadedCounts.get(path) ?? 0))) return failed(node);
    }
    if (current !== generation) return undefined;
    root.value = nextRoot;
    refreshError.value = undefined;
    selectedPath.value =
      selected !== undefined && findNode(nextRoot, selected) ? selected : undefined;
    return rootPage;
  }

  async function loadToCount(node: WorkspaceFileTreeNode, count: number): Promise<boolean> {
    while (node.children.length < count && node.nextCursor !== null) {
      const cursor = node.nextCursor;
      if ((await load(node, true)) === undefined) return false;
      if (node.nextCursor === cursor) break;
    }
    return true;
  }

  async function reveal(path: string, needed: () => boolean = () => true): Promise<void> {
    const normalized = workspaceTreePath(path);
    if (normalized === undefined || !needed()) return;
    root.value.expanded = true;
    const currentRoot = root.value;
    if (!currentRoot.loaded && (await load(currentRoot)) === undefined) {
      if (
        currentRoot === root.value &&
        needed() &&
        errorCode(currentRoot.failure) === 'PERMISSION_DENIED'
      )
        throw currentRoot.failure;
      if (currentRoot !== root.value || !currentRoot.loaded) return;
    }
    if (!needed()) return;
    const segments = normalized.split('/');
    let parent = root.value;
    let current = '';
    for (const segment of segments.slice(0, -1)) {
      current = current === '' ? segment : `${current}/${segment}`;
      if (!findChild(parent, current))
        parent.children = sortNodes([...parent.children, placeholderNode(current, 'DIRECTORY')]);
      const directory = findChild(parent, current);
      if (directory === undefined) throw new Error('FILE_TREE_NODE_INVALID');
      directory.expanded = true;
      if (!directory.loaded && (await load(directory)) === undefined) {
        if (
          currentRoot === root.value &&
          needed() &&
          errorCode(directory.failure) === 'PERMISSION_DENIED'
        )
          throw directory.failure;
        return;
      }
      if (!needed()) return;
      parent = directory;
    }
    if (!findChild(parent, normalized))
      parent.children = sortNodes([...parent.children, placeholderNode(normalized, 'FILE')]);
  }

  function select(node: WorkspaceFileTreeNode): void {
    selectedPath.value = node.path;
  }

  function selectPath(path: string): void {
    const normalized = workspaceTreePath(path);
    if (normalized !== undefined && findNode(root.value, normalized) !== undefined)
      selectedPath.value = normalized;
  }

  function applyRootPage(page: WorkspaceFileTreePage): void {
    rootRevision += 1;
    pendingLoads.delete(root.value);
    root.value.children = mergeChildren(root.value.children, page.entries);
    root.value.nextCursor = page.nextCursor;
    root.value.loaded = true;
    root.value.loading = false;
    root.value.failedAppend = undefined;
    root.value.failure = undefined;
  }

  function setRootName(name: string): void {
    root.value.name = name;
  }

  function uploadDirectory(): string {
    const selected =
      selectedPath.value === undefined ? undefined : findNode(root.value, selectedPath.value);
    if (selected === undefined) return '.';
    if (selected.kind === 'DIRECTORY') return selected.path;
    const separator = selected.path.lastIndexOf('/');
    return separator < 0 ? '.' : selected.path.slice(0, separator);
  }

  function snapshot(): WorkspaceFileTreeSnapshot {
    return {
      // Snapshotting runs in the Workspace Tab switch path. The recursive clone unwraps every node
      // so loaded or paginated descendants do not pay Vue's deep reactive proxy cost.
      root: cloneNode(root.value),
      ...(selectedPath.value === undefined ? {} : { selectedPath: selectedPath.value })
    };
  }

  function restore(value: WorkspaceFileTreeSnapshot): void {
    generation += 1;
    root.value = cloneNode(value.root);
    selectedPath.value = value.selectedPath;
    refreshError.value = undefined;
  }

  return {
    root,
    selectedPath,
    refreshError,
    applyRootPage,
    loadMore: (node: WorkspaceFileTreeNode) => load(node, node.failedAppend ?? true),
    refresh,
    reset,
    restore,
    reveal,
    select,
    selectPath,
    setRootName,
    snapshot,
    toggle,
    uploadDirectory
  };
}

export function matchesWorkspaceDisplayFilter(value: string, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return normalizedQuery.length === 0 || value.toLocaleLowerCase().includes(normalizedQuery);
}

export function visibleWorkspaceFileTreeRows(
  root: WorkspaceFileTreeNode,
  query: string
): WorkspaceFileTreeVisibleRow[] {
  const rows: WorkspaceFileTreeVisibleRow[] = [];
  const visit = (node: WorkspaceFileTreeNode, depth: number) => {
    rows.push({ node, depth, loadMore: false });
    if (node.kind !== 'DIRECTORY' || !node.expanded) return;
    for (const child of node.children) visit(child, depth + 1);
    if (
      node.nextCursor !== null ||
      node.failedAppend !== undefined ||
      (node.loading && !node.loaded)
    )
      rows.push({ node, depth: depth + 1, loadMore: true });
  };
  visit(root, 0);

  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) return rows;
  const includedPaths = new Set<string>(['.']);
  for (const row of rows) {
    if (row.loadMore || !matchesWorkspaceDisplayFilter(row.node.path, normalizedQuery)) continue;
    let path = row.node.path;
    includedPaths.add(path);
    while (path !== '.') {
      const separator = path.lastIndexOf('/');
      path = separator < 0 ? '.' : path.slice(0, separator);
      includedPaths.add(path);
    }
  }
  return rows.filter((row) => includedPaths.has(row.node.path));
}

export function workspaceFileTreeWindow(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan: number
): WorkspaceFileTreeWindow {
  const safeRowCount = Math.max(0, Math.floor(rowCount));
  const safeRowHeight = Math.max(1, rowHeight);
  const safeViewportHeight = Math.max(0, viewportHeight);
  const totalHeight = safeRowCount * safeRowHeight;
  const maximumScrollTop = Math.max(0, totalHeight - safeViewportHeight);
  const boundedScrollTop = Math.max(0, Math.min(scrollTop, maximumScrollTop));
  const visibleStart = Math.floor(boundedScrollTop / safeRowHeight);
  const visibleEnd = Math.ceil((boundedScrollTop + safeViewportHeight) / safeRowHeight);
  const buffer = Math.max(0, Math.floor(overscan));
  const start = Math.max(0, visibleStart - buffer);
  const end = Math.min(safeRowCount, visibleEnd + buffer);
  return { start, end, offset: start * safeRowHeight, totalHeight };
}

function createRoot(name: string): WorkspaceFileTreeNode {
  return {
    path: '.',
    name,
    kind: 'DIRECTORY',
    size: null,
    children: [],
    expanded: true,
    loaded: false,
    loading: false,
    nextCursor: null,
    placeholder: false
  };
}

function placeholderNode(path: string, kind: 'FILE' | 'DIRECTORY'): WorkspaceFileTreeNode {
  return {
    path,
    name: path.split('/').at(-1) ?? path,
    kind,
    size: null,
    children: [],
    expanded: false,
    loaded: false,
    loading: false,
    nextCursor: null,
    placeholder: true
  };
}

function mergeChildren(
  current: readonly WorkspaceFileTreeNode[],
  entries: readonly WorkspaceFileTreeEntry[]
): WorkspaceFileTreeNode[] {
  const existing = new Map(current.map((node) => [node.path, node]));
  for (const entry of entries) {
    const node = existing.get(entry.path);
    if (node === undefined)
      existing.set(entry.path, {
        ...placeholderNode(entry.path, entry.kind),
        ...entry,
        placeholder: false
      });
    else {
      node.placeholder = false;
      Object.assign(node, entry);
    }
  }
  return sortNodes([...existing.values()]);
}

function sortNodes(nodes: WorkspaceFileTreeNode[]): WorkspaceFileTreeNode[] {
  return nodes.sort(
    (left, right) =>
      Number(right.kind === 'DIRECTORY') - Number(left.kind === 'DIRECTORY') ||
      left.name.localeCompare(right.name)
  );
}

function findChild(node: WorkspaceFileTreeNode, path: string): WorkspaceFileTreeNode | undefined {
  return node.children.find((child) => child.path === path);
}

function findNode(node: WorkspaceFileTreeNode, path: string): WorkspaceFileTreeNode | undefined {
  if (node.path === path) return node;
  for (const child of node.children) {
    const found = findNode(child, path);
    if (found !== undefined) return found;
  }
  return undefined;
}

function expandedPaths(node: WorkspaceFileTreeNode): string[] {
  return [
    ...(node.expanded ? [node.path] : []),
    ...node.children.flatMap((child) => expandedPaths(child))
  ];
}

function directoryChildCounts(node: WorkspaceFileTreeNode): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (current: WorkspaceFileTreeNode) => {
    if (current.kind !== 'DIRECTORY') return;
    counts.set(current.path, current.children.length);
    current.children.forEach(visit);
  };
  visit(node);
  return counts;
}

function cloneNode(node: WorkspaceFileTreeNode): WorkspaceFileTreeNode {
  const raw = toRaw(node);
  return { ...raw, loading: false, children: toRaw(raw.children).map(cloneNode) };
}

function normalizePath(path: string): string {
  return path
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^\/+|\/+$/g, '');
}

function workspaceTreePath(path: string): string | undefined {
  const slashed = path.replaceAll('\\', '/');
  if (isComposerAttachmentResourcePath(slashed)) return undefined;
  if (slashed.startsWith('/') || /^[a-z]:/iu.test(slashed)) return undefined;
  const normalized = normalizePath(slashed);
  if (normalized === '' || normalized.split('/').some((segment) => segment === '..'))
    return undefined;
  return normalized;
}
