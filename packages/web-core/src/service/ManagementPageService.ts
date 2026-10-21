import { computed, ref, shallowRef, watch } from 'vue';
import { managementPageMetadataSchema, type ManagementPage } from '@myagentroam/protocol';
import { createManagementPaginationService } from './ManagementPaginationService.js';

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
  readonly reportError: (error: unknown) => void;
}) {
  const viewport = createManagementPaginationService();
  const items = shallowRef<readonly T[]>([]);
  const result = shallowRef<ManagementPage<T>>();
  const loading = ref(false);
  const page = ref(1);
  let generation = 0;
  let context = input.context();
  let autoFailed = false;
  let disposed = false;
  const total = computed(() => result.value?.total ?? 0);
  const hasMore = computed(() => result.value?.hasMore ?? false);

  function clear(): void {
    items.value = [];
    result.value = undefined;
    page.value = 1;
    autoFailed = false;
  }

  async function request(nextPage: number, append: boolean, reset: boolean): Promise<void> {
    if (disposed) return;
    const key = input.context();
    if (reset || context !== key) {
      clear();
      context = key;
    }
    const current = ++generation;
    loading.value = true;
    autoFailed = false;
    try {
      let response = await input.read(nextPage);
      if (current !== generation || key !== input.context() || disposed) return;
      if (append && response.page <= page.value) {
        clear();
        response = await input.read(1);
        if (current !== generation || key !== input.context() || disposed) return;
        append = false;
      }
      const identities = new Set<string | number>();
      items.value = (append ? [...items.value, ...response.items] : response.items).filter(
        (item) => {
          const identity = input.key(item);
          if (identities.has(identity)) return false;
          identities.add(identity);
          return true;
        }
      );
      result.value = response;
      page.value = response.page;
    } catch (error) {
      if (current === generation && key === input.context() && !disposed) {
        autoFailed = true;
        input.reportError(error);
      }
    } finally {
      if (current === generation && key === input.context() && !disposed) loading.value = false;
    }
  }

  function load(reset = false): Promise<void> {
    return request(reset || viewport.mobileViewport.value ? 1 : page.value, false, reset);
  }
  function setPage(nextPage: number): Promise<void> {
    if (nextPage === page.value || !Number.isSafeInteger(nextPage) || nextPage < 1)
      return Promise.resolve();
    return request(nextPage, false, false);
  }
  function loadMore(automatic = false): Promise<void> {
    if (loading.value || !hasMore.value || (automatic && autoFailed)) return Promise.resolve();
    return request(page.value + 1, true, false);
  }
  const stop = watch(viewport.mobileViewport, () => {
    void load(true);
  });
  function dispose(): void {
    disposed = true;
    generation++;
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
    mobileViewport: viewport.mobileViewport,
    mobileVisibleCount: computed(() => items.value.length),
    load,
    setPage,
    loadMore,
    start: viewport.start,
    dispose
  };
}
