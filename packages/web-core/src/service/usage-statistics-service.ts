import { reactive } from 'vue';
import type {
  PersonalUsageOverview,
  PersonalUsageQuery,
  PersonalUsageRecords
} from '@myagentroam/protocol';

const REFRESH_INTERVAL = 60_000;

/** Owns request cancellation, paging and the short-lived personal usage projection. */
export class UsageStatisticsService {
  readonly state = reactive({
    loading: false,
    loadingPage: false,
    refreshing: false,
    failed: false,
    refreshFailed: false,
    lastRefreshedAt: null as number | null,
    recordsStale: false,
    page: 1,
    total: '0',
    overview: undefined as PersonalUsageOverview | undefined,
    records: [] as PersonalUsageRecords['records'],
    availableModels: [] as PersonalUsageOverview['models']
  });
  private generation = 0;
  private abort: AbortController | undefined;
  private query: PersonalUsageQuery | undefined;
  private recordsQuery: PersonalUsageQuery | undefined;
  private pageFailed = false;
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
    const generation = this.begin();
    this.query = { ...query };
    this.rollingWindow = options.rolling ? query.to - query.from : undefined;
    this.state.loading = true;
    this.state.failed = false;
    if (options.reset !== false) {
      this.interacting = false;
      this.state.overview = undefined;
      this.state.records = [];
      this.state.total = '0';
      this.state.lastRefreshedAt = null;
      this.state.recordsStale = false;
      this.state.page = 1;
      this.pageFailed = false;
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
    return this.state.page > 1 || this.interacting || this.state.recordsStale;
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
      this.state.overview = overview;
      if (records && (!automatic || !this.preserveRecords)) {
        this.applyPage(records, 1);
        this.recordsQuery = { ...query };
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
    await this.readPage(page, false);
  }

  async loadMore(automatic = false): Promise<void> {
    if (automatic && this.pageFailed) return;
    await this.readPage(this.state.page + 1, true);
  }

  private async readPage(page: number, append: boolean): Promise<void> {
    if (
      !this.recordsQuery ||
      this.state.loading ||
      this.state.loadingPage ||
      !Number.isInteger(page) ||
      page === this.state.page ||
      page < 1 ||
      page > Math.ceil(Number(this.state.total) / 20)
    )
      return;
    const generation = this.begin();
    this.pageFailed = false;
    this.state.loadingPage = true;
    try {
      const records = await this.request<PersonalUsageRecords>(
        this.path('records', this.recordsQuery, page),
        { signal: this.abort!.signal, cache: 'no-store' }
      );
      if (generation !== this.generation) return;
      this.applyPage(records, page, append);
    } catch (error) {
      if (generation === this.generation) {
        this.pageFailed = true;
        this.reportError(error);
      }
    } finally {
      if (generation === this.generation) {
        this.state.loadingPage = false;
        this.schedule();
      }
    }
  }

  private applyPage(page: PersonalUsageRecords, number: number, append = false): void {
    const identities = new Set<string>();
    this.state.records = (append ? [...this.state.records, ...page.records] : page.records).filter(
      (record) => {
        const identity = recordIdentity(record);
        if (identities.has(identity)) return false;
        identities.add(identity);
        return true;
      }
    );
    this.state.total = page.total;
    this.state.page = page.page ?? number;
    this.pageFailed = false;
  }

  private begin(): number {
    this.clearTimer();
    this.abort?.abort();
    this.abort = new AbortController();
    this.state.loading = false;
    this.state.loadingPage = false;
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
    this.pageFailed = false;
    this.state.loading = false;
    this.state.loadingPage = false;
    this.state.refreshing = false;
    this.state.overview = undefined;
    this.state.records = [];
    this.state.total = '0';
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

function recordIdentity(record: { recordId: string; ledgerId?: string }): string {
  return record.ledgerId ?? record.recordId;
}
