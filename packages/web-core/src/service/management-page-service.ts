import { computed, ref, shallowRef, watch } from 'vue';
import { managementPageMetadataSchema, type ManagementPage } from '@myagentroam/protocol';
import { createManagementPaginationService } from './management-pagination-service.js';
import { AuthenticationContextChangedError } from './workbench-http-service.js';

export { watchManagementPageFailure } from './management-page-feedback.js';

export function parseManagementPage<T>(
  raw: unknown,
  field: string,
  parseItem?: (value: unknown) => T
): ManagementPage<T> {
  if (
    raw === null ||
    typeof raw !== 'object' ||
    !Array.isArray((raw as Record<string, unknown>)[field])
  )
    throw new Error('MANAGEMENT_PAGE_RESPONSE_INVALID');
  const record = raw as Record<string, unknown>;
  const metadata = managementPageMetadataSchema.safeParse(record);
  if (!metadata.success) throw new Error('MANAGEMENT_PAGE_RESPONSE_INVALID');
  const values = record[field] as unknown[];
  const facets = record['facets'] as { tags?: unknown } | undefined;
  if (
    facets !== undefined &&
    (facets === null ||
      typeof facets !== 'object' ||
      !Array.isArray(facets.tags) ||
      facets.tags.some((tag) => typeof tag !== 'string'))
  )
    throw new Error('MANAGEMENT_PAGE_RESPONSE_INVALID');
  return {
    ...metadata.data,
    items: parseItem === undefined ? (values as T[]) : values.map(parseItem),
    ...(facets === undefined ? {} : { facets: { tags: facets.tags as string[] } })
  };
}

/** Coordinates page requests only; domain services own filters and network contracts. */
export function createManagementPageService<T>(input: {
  readonly read: (page: number) => Promise<ManagementPage<T>>;
  readonly key: (item: T) => string | number;
  readonly context: () => string;
  readonly reloadOnViewportChange?: boolean;
}) {
  const viewport = createManagementPaginationService();
  const items = shallowRef<readonly T[]>([]);
  const result = shallowRef<ManagementPage<T>>();
  const contextKey = ref(input.context());
  const loading = ref(false);
  const loadingMore = ref(false);
  const failure = shallowRef<{
    readonly error: unknown;
    readonly page: number;
    readonly append: boolean;
    readonly incremental: boolean;
  }>();
  const page = ref(1);
  let generation = 0;
  let context = input.context();
  let disposed = false;
  const total = computed(() => result.value?.total ?? 0);
  const hasMore = computed(() => result.value?.hasMore ?? false);

  function clear(): void {
    items.value = [];
    result.value = undefined;
    page.value = 1;
    failure.value = undefined;
  }

  function invalidate(clearData = false): void {
    generation++;
    loading.value = false;
    loadingMore.value = false;
    failure.value = undefined;
    if (clearData) clear();
  }

  function replace(response: ManagementPage<T>): void {
    invalidate();
    context = input.context();
    contextKey.value = context;
    const identities = new Set<string | number>();
    items.value = response.items.filter((item) => {
      const identity = input.key(item);
      if (identities.has(identity)) return false;
      identities.add(identity);
      return true;
    });
    result.value = response;
    page.value = response.page;
  }

  async function request(
    nextPage: number,
    append: boolean,
    retrying = false,
    incremental = append
  ): Promise<void> {
    if (disposed) return;
    const key = input.context();
    if (context !== key) {
      clear();
      context = key;
      contextKey.value = key;
    }
    const current = ++generation;
    if (!retrying) failure.value = undefined;
    loading.value = true;
    loadingMore.value = incremental;
    let requestPage = nextPage;
    let requestAppend = append;
    try {
      let response = await input.read(requestPage);
      if (current !== generation || key !== input.context() || disposed) return;
      if (requestAppend && response.page <= page.value) {
        requestPage = 1;
        requestAppend = false;
        response = await input.read(requestPage);
        if (current !== generation || key !== input.context() || disposed) return;
      }
      const identities = new Set<string | number>();
      items.value = (requestAppend ? [...items.value, ...response.items] : response.items).filter(
        (item) => {
          const identity = input.key(item);
          if (identities.has(identity)) return false;
          identities.add(identity);
          return true;
        }
      );
      result.value = response;
      page.value = response.page;
      failure.value = undefined;
    } catch (error) {
      if (current === generation && key === input.context() && !disposed) {
        failure.value =
          error instanceof AuthenticationContextChangedError
            ? undefined
            : { error, page: requestPage, append: requestAppend, incremental };
      }
    } finally {
      if (current === generation && key === input.context() && !disposed) {
        loading.value = false;
        loadingMore.value = false;
      }
    }
  }

  function load(reset = false): Promise<void> {
    return request(reset || viewport.mobileViewport.value ? 1 : page.value, false);
  }
  function setPage(nextPage: number): Promise<void> {
    if (nextPage === page.value || !Number.isSafeInteger(nextPage) || nextPage < 1)
      return Promise.resolve();
    return request(nextPage, false);
  }
  function loadMore(automatic = false): Promise<void> {
    if (loading.value || !hasMore.value || (automatic && failure.value !== undefined))
      return Promise.resolve();
    return request(page.value + 1, true);
  }
  function retry(): Promise<void> {
    if (loading.value || failure.value === undefined) return Promise.resolve();
    return request(failure.value.page, failure.value.append, true, failure.value.incremental);
  }
  const stop = watch(viewport.mobileViewport, () => {
    if (input.reloadOnViewportChange !== false) void load(true);
  });
  function dispose(): void {
    disposed = true;
    invalidate(true);
    stop();
    viewport.dispose();
  }

  return {
    items,
    result,
    page,
    total,
    hasMore,
    loading,
    loadingMore,
    failure,
    contextKey,
    mobileViewport: viewport.mobileViewport,
    mobileVisibleCount: computed(() => items.value.length),
    load,
    setPage,
    loadMore,
    retry,
    invalidate,
    replace,
    start: viewport.start,
    dispose
  };
}
