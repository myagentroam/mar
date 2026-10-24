import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { MOBILE_WORKBENCH_VIEWPORT_QUERY } from '../util/mobile-workbench.js';

export const MANAGEMENT_PAGE_SIZE = 20;

export interface ManagementPaginationService {
  readonly mobileViewport: Ref<boolean>;
  readonly page: Ref<number>;
  readonly mobileVisibleCount: Ref<number>;
  readonly mobileVisible: ComputedRef<number>;
  start(): void;
  dispose(): void;
  reset(): void;
  reconcile(total: number): void;
  setPage(page: number): void;
  loadMore(): void;
}

export function createManagementPaginationService(
  pageSize = MANAGEMENT_PAGE_SIZE
): ManagementPaginationService {
  const mobileViewport = ref(
    typeof window !== 'undefined' && window.matchMedia(MOBILE_WORKBENCH_VIEWPORT_QUERY).matches
  );
  const page = ref(1);
  const mobileVisibleCount = ref(pageSize);
  let viewportQuery: MediaQueryList | undefined;

  function handleViewportChange(event: MediaQueryListEvent): void {
    mobileViewport.value = event.matches;
    page.value = 1;
    mobileVisibleCount.value = pageSize;
  }

  function start(): void {
    if (viewportQuery !== undefined) return;
    viewportQuery = window.matchMedia(MOBILE_WORKBENCH_VIEWPORT_QUERY);
    viewportQuery.addEventListener('change', handleViewportChange);
  }

  function dispose(): void {
    viewportQuery?.removeEventListener('change', handleViewportChange);
    viewportQuery = undefined;
  }

  function reset(): void {
    page.value = 1;
    mobileVisibleCount.value = pageSize;
  }

  function setPage(nextPage: number): void {
    page.value = Math.max(1, nextPage);
  }

  function reconcile(total: number): void {
    page.value = Math.min(page.value, Math.max(1, Math.ceil(total / pageSize)));
  }

  function loadMore(): void {
    mobileVisibleCount.value += pageSize;
  }

  return {
    mobileViewport,
    page,
    mobileVisibleCount,
    mobileVisible: computed(() => mobileVisibleCount.value),
    start,
    dispose,
    reset,
    reconcile,
    setPage,
    loadMore
  };
}

export function managementPageItems<T>(
  items: readonly T[],
  pagination: Pick<ManagementPaginationService, 'mobileViewport' | 'page' | 'mobileVisibleCount'>,
  pageSize = MANAGEMENT_PAGE_SIZE
): readonly T[] {
  if (pagination.mobileViewport.value) return items.slice(0, pagination.mobileVisibleCount.value);
  const start = (pagination.page.value - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
