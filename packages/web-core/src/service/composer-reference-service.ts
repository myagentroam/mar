import { computed, ref, watch, type Ref } from 'vue';
import type { ComposerFileReference } from '@myagentroam/protocol';
import type { Session } from '../model/workbench.js';
import { sessionTitle } from '../util/session-presentation.js';
import { composerReferenceAtCursor } from '../util/composer-reference-query.js';
import { normalizeComposerReferences, type FileReferenceEntry } from './file-reference-service.js';

export type ComposerReferenceFilter = 'all' | 'file' | 'session';
export type ComposerReferenceCandidate =
  | { readonly type: 'file'; readonly key: string; readonly entry: FileReferenceEntry }
  | { readonly type: 'session'; readonly key: string; readonly session: Session };
export type ComposerRangeEdit = (start: number, end: number, text: string) => boolean;

interface FileReferenceSearchOptions {
  readonly nodeId: Readonly<Ref<string | undefined>>;
  readonly workspaceId: Readonly<Ref<string | undefined>>;
  readonly ready: () => boolean;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly debounceMs?: number;
  readonly sessions?: {
    readonly ready: () => boolean;
    readonly currentSessionId: Readonly<Ref<string | undefined>>;
  };
}

export function createComposerReferenceService(
  input: Ref<string>,
  searchOptions?: FileReferenceSearchOptions,
  selected: Ref<readonly ComposerFileReference[]> = ref([])
) {
  const open = ref(false);
  const cursor = ref(input.value.length);
  const entries = ref<readonly FileReferenceEntry[]>([]);
  const sessions = ref<readonly Session[]>([]);
  const filter = ref<ComposerReferenceFilter>('all');
  const activeIndex = ref(0);
  const loading = ref(false);
  const sessionLoading = ref(false);
  const fileError = ref(false);
  const sessionError = ref(false);
  const fileMore = ref(false);
  const sessionMore = ref(false);
  const match = computed(() =>
    composerReferenceAtCursor(input.value, cursor.value, searchOptions?.sessions !== undefined)
  );
  const candidates = computed<readonly ComposerReferenceCandidate[]>(() => [
    ...(filter.value === 'session'
      ? []
      : entries.value.map((entry) => ({
          type: 'file' as const,
          key: `file:${entry.path}`,
          entry
        }))),
    ...(filter.value === 'file'
      ? []
      : sessions.value.map((session) => ({
          type: 'session' as const,
          key: `session:${session.id}`,
          session
        })))
  ]);
  let pickerQuery: string | undefined;
  let pickerStart: number | undefined;
  let pickerSessionOnly: boolean | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchGeneration = 0;
  let searchKey: string | undefined;
  let searchController: AbortController | undefined;

  function clearResults(): void {
    entries.value = [];
    sessions.value = [];
    fileError.value = false;
    sessionError.value = false;
    fileMore.value = false;
    sessionMore.value = false;
    activeIndex.value = 0;
  }

  function update(nextCursor = input.value.length): void {
    cursor.value = nextCursor;
    const newContext =
      !open.value ||
      match.value?.start !== pickerStart ||
      match.value?.sessionOnly !== pickerSessionOnly;
    if (
      match.value?.query !== pickerQuery ||
      match.value?.start !== pickerStart ||
      match.value?.sessionOnly !== pickerSessionOnly
    ) {
      cancelSearch();
      clearResults();
      if (newContext) filter.value = match.value?.sessionOnly ? 'session' : 'all';
    }
    open.value = match.value !== undefined;
    pickerQuery = match.value?.query;
    pickerStart = match.value?.start;
    pickerSessionOnly = match.value?.sessionOnly;
    if (!open.value) clearResults();
  }

  function close(): void {
    cancelSearch();
    open.value = false;
    clearResults();
    pickerQuery = undefined;
    pickerStart = undefined;
    pickerSessionOnly = undefined;
  }

  function cancelSearch(): void {
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    searchController?.abort();
    searchController = undefined;
    searchTimer = undefined;
    searchKey = undefined;
    searchGeneration += 1;
    loading.value = false;
    sessionLoading.value = false;
  }

  function scheduleSearch(): void {
    const currentMatch = match.value;
    const nodeId = searchOptions?.nodeId.value;
    const workspaceId = searchOptions?.workspaceId.value;
    const searchFiles =
      searchOptions?.ready() === true && filter.value !== 'session' && !!currentMatch?.query;
    const searchSessions = searchOptions?.sessions?.ready() === true && filter.value !== 'file';
    if (
      searchOptions === undefined ||
      !open.value ||
      currentMatch === undefined ||
      nodeId === undefined ||
      workspaceId === undefined ||
      (!searchFiles && !searchSessions)
    ) {
      cancelSearch();
      clearResults();
      return;
    }
    const nextSearchKey = JSON.stringify([
      nodeId,
      workspaceId,
      currentMatch.query,
      filter.value,
      searchFiles,
      searchSessions
    ]);
    if (nextSearchKey === searchKey) return;
    cancelSearch();
    clearResults();
    searchKey = nextSearchKey;
    const generation = searchGeneration;
    const controller = new AbortController();
    searchController = controller;
    loading.value = searchFiles;
    sessionLoading.value = searchSessions;
    searchTimer = setTimeout(() => {
      searchTimer = undefined;
      if (searchFiles)
        void search(nodeId, workspaceId, currentMatch.query, generation, controller.signal);
      if (searchSessions)
        void searchSessionSource(
          nodeId,
          workspaceId,
          currentMatch.query,
          generation,
          controller.signal
        );
    }, searchOptions.debounceMs ?? 120);
  }

  async function search(
    nodeId: string,
    workspaceId: string,
    query: string,
    generation: number,
    signal: AbortSignal
  ): Promise<void> {
    if (searchOptions === undefined) return;
    try {
      const parameters = new URLSearchParams({
        nodeId,
        q: query,
        includeDirectories: 'true',
        limit: '10'
      });
      const result = await searchOptions.request<{
        files: { entries: FileReferenceEntry[]; nextCursor?: string | null; truncated?: boolean };
      }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/files/search?${parameters.toString()}`,
        { signal }
      );
      if (
        generation !== searchGeneration ||
        searchOptions.nodeId.value !== nodeId ||
        searchOptions.workspaceId.value !== workspaceId ||
        match.value?.query !== query
      )
        return;
      retainSelection(() => {
        entries.value = result.files.entries.slice(0, 10);
      });
      fileMore.value =
        result.files.truncated === true ||
        !!result.files.nextCursor ||
        result.files.entries.length > 10;
    } catch {
      if (generation === searchGeneration) fileError.value = true;
    } finally {
      if (generation === searchGeneration) loading.value = false;
    }
  }

  function retainSelection(update: () => void): void {
    const key = candidates.value[activeIndex.value]?.key;
    update();
    const index = candidates.value.findIndex((candidate) => candidate.key === key);
    activeIndex.value = index < 0 ? 0 : index;
  }

  async function searchSessionSource(
    nodeId: string,
    workspaceId: string,
    query: string,
    generation: number,
    signal: AbortSignal
  ): Promise<void> {
    if (!searchOptions?.sessions) return;
    try {
      const parameters = new URLSearchParams({
        nodeId,
        workspaceId,
        registeredOnly: 'true',
        sessionGroup: 'MAIN',
        limit: '10'
      });
      if (query) parameters.set('query', query);
      const result = await searchOptions.request<{
        sessions: Session[];
        nextCursor: string | null;
      }>(`/api/agent-sessions?${parameters}`, { signal });
      if (
        generation !== searchGeneration ||
        searchOptions.nodeId.value !== nodeId ||
        searchOptions.workspaceId.value !== workspaceId
      )
        return;
      retainSelection(() => {
        sessions.value = result.sessions
          .filter((session) => session.id !== searchOptions.sessions?.currentSessionId.value)
          .slice(0, 10);
      });
      sessionMore.value = !!result.nextCursor || result.sessions.length > 10;
    } catch {
      if (generation === searchGeneration) sessionError.value = true;
    } finally {
      if (generation === searchGeneration) sessionLoading.value = false;
    }
  }

  function setFilter(next: ComposerReferenceFilter): void {
    if (match.value?.sessionOnly && next !== 'session') return;
    if (filter.value === next) return;
    filter.value = next;
    cancelSearch();
    clearResults();
    scheduleSearch();
  }

  function selectCandidate(
    candidate: ComposerReferenceCandidate,
    edit: ComposerRangeEdit
  ): boolean {
    const current = match.value;
    if (!open.value || !current || !candidates.value.includes(candidate)) return false;
    if (candidate.type === 'file') {
      const token = {
        type: candidate.entry.kind === 'DIRECTORY' ? 'directory' : 'file',
        path: candidate.entry.path,
        label: candidate.entry.name
      } as const;
      const exists = selected.value.some((value) => value.path === token.path);
      if (!exists && selected.value.length >= 128) return false;
      if (
        normalizeComposerReferences([token]).length === 0 ||
        !edit(current.start, current.end, '')
      )
        return false;
      if (!exists) selected.value = [...selected.value, token];
    } else {
      const text = `<mar-session: ${sessionTitle(candidate.session)}>`;
      const separator =
        current.end < input.value.length && /\s/u.test(input.value[current.end]!) ? '' : ' ';
      if (!edit(current.start, current.end, text + separator)) return false;
    }
    close();
    return true;
  }

  watch(
    () => [
      searchOptions?.nodeId.value,
      searchOptions?.workspaceId.value,
      searchOptions?.sessions?.currentSessionId.value
    ],
    close,
    { flush: 'sync' }
  );

  return {
    open,
    cursor,
    entries,
    sessions,
    candidates,
    filter,
    activeIndex,
    loading,
    sessionLoading,
    fileError,
    sessionError,
    fileMore,
    sessionMore,
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
    selectCandidate,
    setFilter,
    sessionAvailable: () => searchOptions?.sessions?.ready() === true,
    scheduleSearch,
    cancelSearch
  };
}
