import { computed, ref, watch, type Ref } from 'vue';
import type { ComposerReference } from '@myagentroam/protocol';
import type { Session } from '../model/workbench.js';
import { sessionTitle } from '../util/session-presentation.js';
import { composerReferenceAtCursor } from '../util/composer-reference-query.js';
import { composerReferenceKey } from '../util/composer-reference.js';
import { normalizeComposerReferences, type FileReferenceEntry } from './file-reference-service.js';

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
  selected: Ref<readonly ComposerReference[]> = ref([])
) {
  const open = ref(false);
  const cursor = ref(input.value.length);
  const entries = ref<readonly FileReferenceEntry[]>([]);
  const sessions = ref<readonly Session[]>([]);
  const selectedIndex = ref(0);
  let selectionMoved = false;
  const activeIndex = computed({
    get: () => selectedIndex.value,
    set: (index: number) => {
      selectedIndex.value = index;
      selectionMoved = true;
    }
  });
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
    ...sessions.value.map((session) => ({
      type: 'session' as const,
      key: `session:${session.id}`,
      session
    })),
    ...entries.value.map((entry) => ({
      type: 'file' as const,
      key: `file:${entry.path}`,
      entry
    }))
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
    selectedIndex.value = 0;
    selectionMoved = false;
  }

  function update(nextCursor = input.value.length): void {
    cursor.value = nextCursor;
    if (
      match.value?.query !== pickerQuery ||
      match.value?.start !== pickerStart ||
      match.value?.sessionOnly !== pickerSessionOnly
    ) {
      cancelSearch();
      clearResults();
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
      searchOptions?.ready() === true && !currentMatch?.sessionOnly && !!currentMatch?.query;
    const searchSessions = searchOptions?.sessions?.ready() === true;
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
      currentMatch.sessionOnly,
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
    const key = selectionMoved ? candidates.value[selectedIndex.value]?.key : undefined;
    update();
    const index = candidates.value.findIndex((candidate) => candidate.key === key);
    selectedIndex.value = index < 0 ? 0 : index;
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

  function selectCandidate(
    candidate: ComposerReferenceCandidate,
    edit: ComposerRangeEdit
  ): boolean {
    const current = match.value;
    if (!open.value || !current || !candidates.value.includes(candidate)) return false;
    const token: ComposerReference =
      candidate.type === 'file'
        ? {
            type: candidate.entry.kind === 'DIRECTORY' ? 'directory' : 'file',
            path: candidate.entry.path,
            label: candidate.entry.name
          }
        : {
            type: 'session',
            sessionId: candidate.session.id,
            label: sessionTitle(candidate.session)
          };
    const key = composerReferenceKey(token);
    const exists = selected.value.some((value) => composerReferenceKey(value) === key);
    if (!exists && selected.value.length >= 128) return false;
    if (normalizeComposerReferences([token]).length === 0 || !edit(current.start, current.end, ''))
      return false;
    if (!exists) selected.value = [...selected.value, token];
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
    activeIndex,
    loading,
    sessionLoading,
    fileError,
    sessionError,
    fileMore,
    sessionMore,
    match,
    selected,
    remove: (key: string) => {
      selected.value = selected.value.filter((value) => composerReferenceKey(value) !== key);
    },
    clear: () => {
      selected.value = [];
    },
    update,
    close,
    selectCandidate,
    sessionAvailable: () => searchOptions?.sessions?.ready() === true,
    scheduleSearch,
    cancelSearch
  };
}
