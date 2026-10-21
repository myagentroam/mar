import { computed, ref, watch } from 'vue';
import { createManagementPageService, parseManagementPage } from './ManagementPageService.js';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

export function createCatalogPageService<T extends { readonly id: string }>(
  request: Request,
  path: string,
  field: string
) {
  const keyword = ref('');
  const category = ref('');
  const sortBy = ref<string>();
  const sortOrder = ref<string>();
  const error = ref<unknown>();
  const context = () =>
    JSON.stringify([keyword.value, category.value, sortBy.value, sortOrder.value]);
  const paging = createManagementPageService<T>({
    read: async (page) => {
      const query = new URLSearchParams({ page: String(page), limit: '20' });
      if (keyword.value) query.set('keyword', keyword.value);
      if (category.value) query.set('category', category.value);
      if (sortBy.value && sortOrder.value) {
        query.set('sortBy', sortBy.value);
        query.set('sortOrder', sortOrder.value);
      }
      return parseManagementPage<T>(await request<unknown>(`${path}?${query}`), field);
    },
    key: (item) => item.id,
    context,
    reportError: (caught) => {
      error.value = caught;
    }
  });
  const tags = computed(() => paging.result.value?.facets?.tags ?? []);
  const stop = watch(context, () => {
    error.value = undefined;
    void paging.load(true);
  });
  async function refresh(): Promise<void> {
    error.value = undefined;
    await paging.load(true);
    if (error.value !== undefined) throw error.value;
  }
  function sort(input: { prop?: string; order?: string | null }): void {
    sortBy.value = input.order ? input.prop : undefined;
    sortOrder.value = input.order === 'descending' ? 'desc' : input.order ? 'asc' : undefined;
  }
  return {
    ...paging,
    keyword,
    category,
    tags,
    error,
    refresh,
    sort,
    dispose() {
      stop();
      paging.dispose();
    }
  };
}

/** Resolve only installed/candidate references, in bounded requests, without fetching a catalog. */
export async function readCatalogReferences<T>(
  request: Request,
  path: string,
  field: string,
  ids: readonly string[],
  names: readonly string[]
): Promise<readonly T[]> {
  const uniqueIds = [...new Set(ids)];
  const uniqueNames = [...new Set(names)];
  const rows: T[] = [];
  for (let offset = 0; offset < Math.max(uniqueIds.length, uniqueNames.length); offset += 128) {
    const query = new URLSearchParams({
      ids: JSON.stringify(uniqueIds.slice(offset, offset + 128)),
      names: JSON.stringify(uniqueNames.slice(offset, offset + 128))
    });
    const result = await request<Record<string, readonly T[]>>(`${path}?${query}`);
    rows.push(...(result[field] ?? []));
  }
  return rows;
}
