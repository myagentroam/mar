import { computed, ref, type Ref } from 'vue';
import { composerTagSchemas, type ComposerFileReference } from '@myagentroam/protocol';

export function normalizeComposerReferences(value: unknown): readonly ComposerFileReference[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 128).flatMap((entry) => {
    const result = composerTagSchemas.mar_references.shape.references.element.safeParse(entry);
    return result.success ? [result.data] : [];
  });
}

export interface FileReferenceMatch {
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

export interface FileReferenceEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: 'FILE' | 'DIRECTORY';
}

export function fileReferenceAtCursor(
  value: string,
  cursor = value.length
): FileReferenceMatch | undefined {
  const end = Math.max(0, Math.min(cursor, value.length));
  const beforeCursor = value.slice(0, end);
  const match = /(?:^|\s)@([^\s"]*)$/.exec(beforeCursor);
  if (match === null) return undefined;
  const query = match[1] ?? '';
  return { query, start: end - query.length - 1, end };
}

export function insertFileReference(
  value: string,
  cursor: number,
  path: string
): { readonly value: string; readonly cursor: number } {
  const match = fileReferenceAtCursor(value, cursor);
  if (match === undefined) return { value, cursor };
  const reference = /[\s"\\]/u.test(path) ? `@${JSON.stringify(path)}` : `@${path}`;
  const separator = /\s/u.test(value[match.end] ?? '') ? '' : ' ';
  const next = `${value.slice(0, match.start)}${reference}${separator}${value.slice(match.end)}`;
  return { value: next, cursor: match.start + reference.length + separator.length };
}

interface FileReferenceSearchOptions {
  readonly nodeId: Readonly<Ref<string | undefined>>;
  readonly workspaceId: Readonly<Ref<string | undefined>>;
  readonly ready: () => boolean;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly debounceMs?: number;
}

export function createFileReferenceService(
  input: Ref<string>,
  searchOptions?: FileReferenceSearchOptions,
  selected: Ref<readonly ComposerFileReference[]> = ref([])
) {
  const open = ref(false);
  const cursor = ref(input.value.length);
  const entries = ref<readonly FileReferenceEntry[]>([]);
  const activeIndex = ref(0);
  const loading = ref(false);
  const match = computed(() => fileReferenceAtCursor(input.value, cursor.value));
  let pickerQuery: string | undefined;
  let pickerStart: number | undefined;
  let pickerCursor = cursor.value;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchGeneration = 0;
  let searchKey: string | undefined;

  function update(nextCursor = input.value.length): void {
    cursor.value = nextCursor;
    open.value = match.value !== undefined;
    if (
      match.value?.query !== pickerQuery ||
      match.value?.start !== pickerStart ||
      nextCursor !== pickerCursor
    )
      activeIndex.value = 0;
    pickerQuery = match.value?.query;
    pickerStart = match.value?.start;
    pickerCursor = nextCursor;
    if (!open.value) entries.value = [];
  }

  function close(): void {
    cancelSearch();
    open.value = false;
    entries.value = [];
    activeIndex.value = 0;
    pickerQuery = undefined;
    pickerStart = undefined;
    pickerCursor = cursor.value;
  }

  function cancelSearch(): void {
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    searchTimer = undefined;
    searchKey = undefined;
    searchGeneration += 1;
    loading.value = false;
  }

  function scheduleSearch(): void {
    const currentMatch = match.value;
    const nodeId = searchOptions?.nodeId.value;
    const workspaceId = searchOptions?.workspaceId.value;
    if (
      searchOptions === undefined ||
      !open.value ||
      currentMatch === undefined ||
      currentMatch.query.length === 0 ||
      nodeId === undefined ||
      workspaceId === undefined ||
      !searchOptions.ready()
    ) {
      cancelSearch();
      entries.value = [];
      return;
    }
    const nextSearchKey = `${nodeId}\u0000${workspaceId}\u0000${currentMatch.query}`;
    if (nextSearchKey === searchKey) return;
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    searchKey = nextSearchKey;
    const generation = ++searchGeneration;
    searchTimer = setTimeout(
      () => void search(nodeId, workspaceId, currentMatch.query, generation),
      searchOptions.debounceMs ?? 120
    );
  }

  async function search(
    nodeId: string,
    workspaceId: string,
    query: string,
    generation: number
  ): Promise<void> {
    if (searchOptions === undefined) return;
    searchTimer = undefined;
    loading.value = true;
    try {
      const parameters = new URLSearchParams({ nodeId, q: query, includeDirectories: 'true' });
      const result = await searchOptions.request<{ files: { entries: FileReferenceEntry[] } }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/files/search?${parameters.toString()}`
      );
      if (
        generation !== searchGeneration ||
        searchOptions.nodeId.value !== nodeId ||
        searchOptions.workspaceId.value !== workspaceId ||
        match.value?.query !== query
      )
        return;
      entries.value = result.files.entries;
      activeIndex.value = 0;
    } catch {
      if (generation === searchGeneration) {
        searchKey = undefined;
        entries.value = [];
      }
    } finally {
      if (generation === searchGeneration) loading.value = false;
    }
  }

  function select(entry: FileReferenceEntry): number | undefined {
    const current = fileReferenceAtCursor(input.value, cursor.value);
    if (current === undefined || selected.value.length >= 128) return undefined;
    const token = {
      type: entry.kind === 'DIRECTORY' ? 'directory' : 'file',
      path: entry.path,
      label: entry.name
    } as const;
    if (normalizeComposerReferences([token]).length === 0) return undefined;
    if (!selected.value.some((value) => value.path === token.path))
      selected.value = [...selected.value, token];
    input.value = input.value.slice(0, current.start) + input.value.slice(current.end);
    close();
    cursor.value = current.start;
    return current.start;
  }

  return {
    open,
    cursor,
    entries,
    activeIndex,
    loading,
    match,
    selected,
    remove: (path: string) => {
      selected.value = selected.value.filter((value) => value.path !== path);
    },
    clear: () => {
      selected.value = [];
    },
    update,
    close,
    select,
    scheduleSearch,
    cancelSearch
  };
}
