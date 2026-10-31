import { computed, reactive } from 'vue';
import type {
  PersonalUsageOverview,
  PersonalUsageQuery,
  PersonalUsageRecords
} from '@myagentroam/protocol';
import { createManagementPageService } from './management-page-service.js';

const REFRESH_INTERVAL = 60_000;

/** Owns request cancellation, paging and the short-lived personal usage projection. */
export class UsageStatisticsService {
  readonly pagination = createManagementPageService<PersonalUsageRecords['records'][number]>({
    context: () => JSON.stringify(this.recordsQuery ?? null),
    key: recordIdentity,
    reloadOnViewportChange: false,
    read: async (page) => {
      if (!this.recordsQuery) throw new Error('USAGE_QUERY_INVALID');
      this.begin();
      const result = await this.request<PersonalUsageRecords>(
        this.path('records', this.recordsQuery, page),
        { signal: this.abort!.signal, cache: 'no-store' }
      );
      return usagePage(result, page);
    }
  });
  readonly state = reactive({
    loading: false,
    loadingPage: computed(() => this.pagination.loading.value),
    refreshing: false,
    failed: false,
    refreshFailed: false,
    lastRefreshedAt: null as number | null,
    recordsStale: false,
    page: computed(() => this.pagination.page.value),
    total: computed(() => String(this.pagination.total.value)),
    overview: undefined as PersonalUsageOverview | undefined,
    records: computed(() => this.pagination.items.value),
    availableModels: [] as PersonalUsageOverview['models']
  });
  private generation = 0;
  private abort: AbortController | undefined;
  private query: PersonalUsageQuery | undefined;
  private recordsQuery: PersonalUsageQuery | undefined;
  private rollingWindow: number | undefined;
  private interacting = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private visibility:
    Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> | undefined;
  private nextRefreshAt = 0;
  private failures = 0;
  constructor(
    private readonly request: <T>(path: string, init?: RequestInit) => Promise<T>,
    private readonly reportError: (error: unknown) => void
  ) {}
  async load(
    query: PersonalUsageQuery,
    options: { reset?: boolean; rolling?: boolean } = {}
  ): Promise<boolean> {
    this.pagination.invalidate(options.reset !== false);
    const generation = this.begin();
    this.query = { ...query };
    this.rollingWindow = options.rolling ? query.to - query.from : undefined;
    this.state.loading = true;
    this.state.failed = false;
    if (options.reset !== false) {
      this.interacting = false;
      this.state.overview = undefined;
      this.state.lastRefreshedAt = null;
      this.state.recordsStale = false;
      this.recordsQuery = undefined;
    }
    return await this.readOverview(query, generation, false);
  }

  startAutoRefresh(
    visibility: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
  ): void {
    this.visibility?.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.visibility = visibility;
    visibility.addEventListener('visibilitychange', this.onVisibilityChange);
    if (!this.nextRefreshAt) this.nextRefreshAt = Date.now() + REFRESH_INTERVAL;
    this.schedule();
  }

  setRecordsInteracting(value: boolean): void {
    this.interacting = value;
  }

  private get preserveRecords(): boolean {
    return (
      this.state.page > 1 ||
      this.interacting ||
      this.state.recordsStale ||
      this.pagination.failure.value !== undefined
    );
  }

  private async readOverview(
    query: PersonalUsageQuery,
    generation: number,
    automatic: boolean
  ): Promise<boolean> {
    const preserve = automatic && this.preserveRecords;
    try {
      const init = { signal: this.abort!.signal, cache: 'no-store' as const };
      const [overview, records] = await Promise.all([
        this.request<PersonalUsageOverview>(this.path('overview', query), init),
        preserve
          ? Promise.resolve(undefined)
          : this.request<PersonalUsageRecords>(this.path('records', query), init)
      ]);
      if (generation !== this.generation) return false;
      const nextPage =
        records && (!automatic || !this.preserveRecords) ? usagePage(records, 1) : undefined;
      this.state.overview = overview;
      if (nextPage) {
        this.recordsQuery = { ...query };
        this.pagination.replace(nextPage);
        this.state.recordsStale = false;
      } else {
        this.state.recordsStale = true;
      }
      if (this.state.availableModels.length === 0 || this.isUnfiltered(query))
        this.state.availableModels = overview.models;
      this.state.lastRefreshedAt = Date.now();
      this.state.failed = false;
      this.state.refreshFailed = false;
      this.failures = 0;
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.abort?.abort();
      this.state.failed = true;
      this.state.refreshFailed = automatic;
      this.failures++;
      if (!automatic) this.reportError(error);
      return false;
    } finally {
      if (generation === this.generation) {
        this.state.loading = false;
        this.state.refreshing = false;
        this.nextRefreshAt =
          Date.now() + Math.min(300_000, REFRESH_INTERVAL * 2 ** Math.min(this.failures, 3));
        this.schedule();
      }
    }
  }

  async goToPage(page: number): Promise<void> {
    if (
      !this.recordsQuery ||
      this.state.loading ||
      this.state.loadingPage ||
      page < 1 ||
      page > Math.ceil(Number(this.state.total) / 20)
    )
      return;
    await this.pagination.setPage(page);
    this.schedule();
  }

  async loadMore(automatic = false): Promise<void> {
    if (!this.recordsQuery || this.state.loading) return;
    await this.pagination.loadMore(automatic);
    this.schedule();
  }

  async retryPage(): Promise<void> {
    await this.pagination.retry();
    this.schedule();
  }

  private begin(): number {
    this.clearTimer();
    this.abort?.abort();
    this.abort = new AbortController();
    this.state.loading = false;
    this.state.refreshing = false;
    return ++this.generation;
  }

  private readonly onVisibilityChange = (): void => {
    this.clearTimer();
    if (this.visibility?.visibilityState !== 'visible' && this.state.refreshing) {
      this.generation++;
      this.abort?.abort();
      this.state.refreshing = false;
    }
    this.schedule();
  };

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    this.clearTimer();
    if (
      this.visibility?.visibilityState !== 'visible' ||
      !this.query ||
      this.state.loading ||
      this.state.loadingPage ||
      this.state.refreshing
    )
      return;
    this.timer = setTimeout(
      () => {
        const query = { ...this.query! };
        if (this.rollingWindow !== undefined) {
          query.to = Date.now();
          query.from = query.to - this.rollingWindow;
        }
        const generation = this.begin();
        this.state.refreshing = true;
        void this.readOverview(query, generation, true);
      },
      Math.max(0, this.nextRefreshAt - Date.now())
    );
  }

  dispose(): void {
    this.clearTimer();
    this.visibility?.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.visibility = undefined;
    this.generation++;
    this.abort?.abort();
    this.query = undefined;
    this.recordsQuery = undefined;
    this.pagination.dispose();
    this.state.loading = false;
    this.state.refreshing = false;
    this.state.overview = undefined;
    this.state.availableModels = [];
  }
  private path(kind: string, query: PersonalUsageQuery, page = 1): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) params.set(key, String(value));
    if (kind === 'records') params.set('page', String(page));
    return `/api/me/usage/${kind}?${params}`;
  }
  private isUnfiltered(query: PersonalUsageQuery): boolean {
    return query.runner === undefined && query.model === undefined && query.mode === undefined;
  }
}

function usagePage(result: PersonalUsageRecords, requestedPage: number) {
  if (!/^(0|[1-9]\d*)$/u.test(result.total)) throw new Error('USAGE_PAGE_RESPONSE_INVALID');
  const total = Number(result.total);
  const page = result.page ?? requestedPage;
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(page) || page < 1)
    throw new Error('USAGE_PAGE_RESPONSE_INVALID');
  return {
    items: result.records,
    page,
    pageSize: 20,
    total,
    hasMore: BigInt(page) * 20n < BigInt(result.total)
  };
}

function recordIdentity(record: { recordId: string; ledgerId?: string }): string {
  return record.ledgerId ?? record.recordId;
}
