import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ElSelect, ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PersonalUsageOverview,
  PersonalUsageQuery,
  PersonalUsageRecords,
  UsageTotals
} from '@myagentroam/protocol';
import { PersonalUsageService } from '../../src/service/PersonalUsageService.js';
import * as personalUsageServiceModule from '../../src/service/PersonalUsageService.js';
import PersonalUsageSettings from '../../src/view/settings/PersonalUsageSettings.vue';
import InteractivePersonalUsageSettings from '../../src/view/settings/PersonalUsageSettings.vue?unit-render';
import ManagementPagination from '../../src/view/settings/ManagementPagination.vue';
import { MANAGEMENT_PAGE_SIZE } from '../../src/service/ManagementPaginationService.js';
import { commonMessages } from '../../src/i18n/messages.js';
import { personalSettingsEnUS } from '../../src/i18n/personal-settings.en-US.js';
import { personalSettingsZhCN } from '../../src/i18n/personal-settings.zh-CN.js';
import { i18n, localePreferenceService } from '../../src/service/LocalePreferenceService.js';
import { absoluteMessageTime } from '../../src/util/time-presentation.js';
import { absoluteMessageTime as conversationTime } from '../../src/util/conversation-presentation.js';
import { cacheHitRate } from '../../src/util/personal-usage-presentation.js';
import { flushComponent, renderComponent, textContent } from './support/component-renderer.js';

type Requester = <T>(path: string, init?: RequestInit) => Promise<T>;
type UsageRecord = PersonalUsageRecords['records'][number] & { ledgerId?: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function totals(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return {
    inputTokens: '0',
    outputTokens: '0',
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: '0',
    requests: '0',
    completeRequests: '0',
    partialRequests: '0',
    unknownRequests: '0',
    ...overrides
  };
}

function overview(overrides: Partial<PersonalUsageOverview> = {}): PersonalUsageOverview {
  return {
    asOf: 1_700_000_000_000,
    availableFrom: 1_692_224_000_000,
    firstRecordedAt: 1_699_900_000_000,
    lastReceivedAt: 1_700_000_000_000,
    last24Hours: totals({ totalTokens: '24', requests: '1', completeRequests: '1' }),
    last7Days: totals({ totalTokens: '168', requests: '7', completeRequests: '7' }),
    selected: totals({ totalTokens: '24', requests: '1', completeRequests: '1' }),
    buckets: [
      {
        from: 1_699_900_000_000,
        to: 1_700_000_000_000,
        ...totals({
          inputTokens: '10',
          outputTokens: '14',
          totalTokens: '24',
          requests: '1',
          completeRequests: '1'
        })
      }
    ],
    runners: [
      {
        key: 'mar-agent',
        label: 'MAR Agent',
        ...totals({ totalTokens: '24', requests: '1', completeRequests: '1' })
      }
    ],
    models: [
      {
        key: 'model-a',
        label: 'Model A',
        ...totals({ totalTokens: '24', requests: '1', completeRequests: '1' })
      },
      {
        key: 'model-b',
        label: 'Model B',
        ...totals({ totalTokens: '12', requests: '1', completeRequests: '1' })
      }
    ],
    coverage: 'observed-only',
    ...overrides
  };
}

function record(recordId: string, overrides: Record<string, unknown> = {}): UsageRecord {
  return {
    schemaVersion: 1,
    recordId,
    requestId: `request-${recordId}`,
    revision: 1,
    scopeId: '00000000-0000-4000-8000-000000000001',
    runner: 'mar-agent',
    sessionId: 'session-1',
    runId: 'run-1',
    requestedModel: 'model-a',
    actualModel: 'model-a',
    responseId: `response-${recordId}`,
    purpose: 'conversation',
    agentRole: 'root',
    startedAt: 1_699_999_000_000,
    endedAt: 1_700_000_000_000,
    state: 'succeeded',
    inputTokens: '10',
    outputTokens: '14',
    totalTokens: '24',
    mode: 'conversation',
    coverage: 'request',
    ...overrides
  } as UsageRecord;
}

function query(overrides: Partial<PersonalUsageQuery> = {}): PersonalUsageQuery {
  return { from: 1_699_900_000_000, to: 1_700_000_000_000, timeZone: 'UTC', ...overrides };
}

const originalLocale = localePreferenceService().locale.value;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localePreferenceService().setLocale(originalLocale);
});

describe('personal usage service', () => {
  it('uses the real total for direct unvisited page jumps instead of discovering pages incrementally', async () => {
    const request = vi.fn(async (path: string): Promise<unknown> => {
      if (path.includes('/overview')) return overview();
      const page = Number(new URL(path, 'http://test').searchParams.get('page') ?? 1);
      return { records: [record(`page-${page}`)], total: '61', page, nextCursor: null };
    });
    const service = new PersonalUsageService(request as Requester, vi.fn());
    await service.load(query());
    expect(service.state.total).toBe('61');
    await service.goToPage(4);
    expect(service.state.page).toBe(4);
    expect(service.state.records[0]?.recordId).toBe('page-4');
    expect(service.state.total).toBe('61');
    expect(request).toHaveBeenCalledTimes(3);
    await service.goToPage(5);
    expect(request).toHaveBeenCalledTimes(3);
    service.dispose();
  });
  it('appends mobile pages once, deduplicates ledger identities and allows manual retry after a failed automatic load', async () => {
    let fail = true;
    const request = vi.fn(async (path: string): Promise<unknown> => {
      if (path.includes('/overview')) return overview();
      const page = Number(new URL(path, 'http://test').searchParams.get('page') ?? 1);
      if (page === 2 && fail) throw new Error('offline');
      return {
        records: page === 1 ? [record('first')] : [record('first'), record('second')],
        total: '21',
        page,
        nextCursor: null
      };
    });
    const service = new PersonalUsageService(request as Requester, vi.fn());
    await service.load(query());
    await service.loadMore(true);
    const calls = request.mock.calls.length;
    await service.loadMore(true);
    expect(request).toHaveBeenCalledTimes(calls);
    expect(service.state.records.map((value) => value.recordId)).toEqual(['first']);
    fail = false;
    await Promise.all([service.loadMore(), service.loadMore()]);
    expect(request).toHaveBeenCalledTimes(calls + 1);
    expect(service.state.records.map((value) => value.recordId)).toEqual(['first', 'second']);
    await service.loadMore();
    expect(request).toHaveBeenCalledTimes(calls + 1);
    await service.load(query({ runner: 'codex' }));
    expect(service.state.page).toBe(1);
    expect(service.state.records).toHaveLength(1);
    service.dispose();
  });
  it('jumps directly to a previously visited page without fetching intervening pages', async () => {
    const request = vi.fn(async (path: string): Promise<unknown> => {
      if (path.includes('/overview')) return overview();
      const page = Number(new URL(path, 'http://test').searchParams.get('page') ?? 1);
      const cursor = page === 3 ? 'third' : page === 2 ? 'second' : null;
      return {
        records: [record(cursor ?? 'first')],
        total: '60',
        nextCursor: cursor === 'third' ? null : cursor === 'second' ? 'third' : 'second'
      };
    });
    const service = new PersonalUsageService(request as Requester, vi.fn());
    await service.load(query());
    await service.goToPage(2);
    await service.goToPage(3);
    const calls = request.mock.calls.length;
    await service.goToPage(1);
    expect(request).toHaveBeenCalledTimes(calls + 1);
    expect(service.state.page).toBe(1);
    expect(service.state.records[0]?.recordId).toBe('first');
    await service.goToPage(4);
    await service.goToPage(1.5);
    expect(request).toHaveBeenCalledTimes(calls + 1);
    service.dispose();
  });
  it('cancels an in-flight automatic refresh when hidden and discards its late response', async () => {
    vi.useFakeTimers();
    const visibility = Object.assign(new EventTarget(), {
      visibilityState: 'visible' as DocumentVisibilityState
    });
    const pending = deferred<PersonalUsageOverview>();
    const request = vi
      .fn<(path: string, init?: RequestInit) => Promise<unknown>>()
      .mockResolvedValueOnce(overview())
      .mockResolvedValueOnce({ records: [record('original')], total: '60', nextCursor: null })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ records: [record('late')], total: '60', nextCursor: null });
    const service = new PersonalUsageService(request as Requester, vi.fn());
    await service.load(query());
    service.startAutoRefresh(visibility);
    await vi.advanceTimersByTimeAsync(60_000);
    visibility.visibilityState = 'hidden';
    visibility.dispatchEvent(new Event('visibilitychange'));
    expect(request.mock.calls[2]?.[1]?.signal?.aborted).toBe(true);
    pending.resolve(overview());
    await vi.advanceTimersByTimeAsync(300_000);
    expect(service.state.records[0]?.recordId).toBe('original');
    expect(request).toHaveBeenCalledTimes(4);
    expect(service.state.refreshing).toBe(false);
    service.dispose();
  });

  it('discards a late page response when filters change', async () => {
    const pending = deferred<PersonalUsageRecords>();
    const request = vi
      .fn<(path: string, init?: RequestInit) => Promise<unknown>>()
      .mockResolvedValueOnce(overview())
      .mockResolvedValueOnce({ records: [record('original')], total: '60', nextCursor: 'next' })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(overview())
      .mockResolvedValueOnce({ records: [record('filtered')], total: '60', nextCursor: null });
    const service = new PersonalUsageService(request as Requester, vi.fn());
    await service.load(query());
    const page = service.goToPage(2);
    await service.load(query({ runner: 'codex' }));
    expect(request.mock.calls[2]?.[1]?.signal?.aborted).toBe(true);
    pending.resolve({ records: [record('late')], total: '60', nextCursor: null });
    await page;
    expect(service.state.page).toBe(1);
    expect(service.state.records[0]?.recordId).toBe('filtered');
    expect(service.state.loadingPage).toBe(false);
    service.dispose();
  });

  it('navigates back with the original query, retains the page on failure, and resets on filtering', async () => {
    const request = vi.fn(async (path: string): Promise<unknown> =>
      path.includes('/overview')
        ? overview()
        : {
            records: [record(path.includes('page=2') ? 'second' : 'first')],
            total: '60',
            nextCursor: path.includes('page=2') ? null : 'next'
          }
    );
    const report = vi.fn();
    const service = new PersonalUsageService(request as Requester, report);
    await service.load(query());
    await service.goToPage(2);
    expect(service.state.records.map((row) => row.recordId)).toEqual(['second']);
    request.mockRejectedValueOnce(new Error('page unavailable'));
    await service.goToPage(1);
    expect(service.state.page).toBe(2);
    expect(service.state.records[0]?.recordId).toBe('second');
    expect(report).toHaveBeenCalledOnce();
    await service.goToPage(1);
    expect(service.state.page).toBe(1);
    expect(request.mock.calls.at(-1)?.[0]).toContain('page=1');
    await service.goToPage(2);
    await service.load(query({ runner: 'codex' }));
    expect(service.state.page).toBe(1);
    expect(service.state.records[0]?.recordId).toBe('first');
    service.dispose();
  });

  it('refreshes rolling windows only while visible and releases the timer on disposal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(query().to);
    const visibility = Object.assign(new EventTarget(), {
      visibilityState: 'visible' as DocumentVisibilityState
    });
    let models = overview().models.slice(0, 1);
    const request = vi.fn(async (path: string): Promise<unknown> =>
      path.includes('/overview')
        ? overview({ models })
        : { records: [record('first')], total: '60', nextCursor: 'next' }
    );
    const service = new PersonalUsageService(request as Requester, vi.fn());
    await service.load(query({ purpose: 'conversation' }), { rolling: true });
    expect(service.state.availableModels).toEqual(models);
    models = overview().models;
    service.startAutoRefresh(visibility);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(4);
    expect(service.state.availableModels).toEqual(models);
    const refreshed = new URL(request.mock.calls[2]![0], 'http://test');
    expect(Number(refreshed.searchParams.get('to'))).toBe(query().to + 60_000);
    expect(Number(refreshed.searchParams.get('from'))).toBe(query().from + 60_000);
    visibility.visibilityState = 'hidden';
    visibility.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(180_000);
    expect(request).toHaveBeenCalledTimes(4);
    visibility.visibilityState = 'visible';
    visibility.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(6);
    service.dispose();
    visibility.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(request).toHaveBeenCalledTimes(6);
  });

  it('keeps paginated records and their cursor query when the overview rolls forward', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(query().to);
    const visibility = Object.assign(new EventTarget(), {
      visibilityState: 'visible' as DocumentVisibilityState
    });
    const request = vi.fn(async (path: string): Promise<unknown> =>
      path.includes('/overview')
        ? overview()
        : {
            records: [record(path.includes('page=2') ? 'second' : 'first')],
            total: '60',
            nextCursor: path.includes('page=2') ? null : 'next'
          }
    );
    const service = new PersonalUsageService(request as Requester, vi.fn());
    await service.load(query(), { rolling: true });
    await service.goToPage(2);
    service.startAutoRefresh(visibility);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(4);
    expect(service.state.page).toBe(2);
    expect(service.state.records[0]?.recordId).toBe('second');
    expect(service.state.recordsStale).toBe(true);
    await service.goToPage(1);
    expect(request.mock.calls.at(-1)?.[0]).toContain(`to=${query().to}`);
    await service.load(query({ to: Date.now() }), { reset: false });
    expect(service.state.page).toBe(1);
    expect(service.state.recordsStale).toBe(false);
    service.dispose();
  });

  it('keeps custom windows fixed, retains data on automatic failure and backs off without error toasts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(query().to);
    const visibility = Object.assign(new EventTarget(), {
      visibilityState: 'visible' as DocumentVisibilityState
    });
    const request = vi.fn(async (path: string): Promise<unknown> =>
      path.includes('/overview')
        ? overview()
        : { records: [record('first')], total: '60', nextCursor: null }
    );
    const report = vi.fn();
    const service = new PersonalUsageService(request as Requester, report);
    await service.load(query());
    const lastRefreshed = service.state.lastRefreshedAt;
    service.startAutoRefresh(visibility);
    request.mockRejectedValueOnce(new Error('offline'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request.mock.calls[2]?.[0]).toBe(request.mock.calls[0]?.[0]);
    expect(service.state.overview).toBeDefined();
    expect(service.state.records[0]?.recordId).toBe('first');
    expect(service.state.lastRefreshedAt).toBe(lastRefreshed);
    expect(service.state.refreshFailed).toBe(true);
    expect(report).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(6);
    expect(service.state.refreshFailed).toBe(false);
    service.dispose();
  });

  it('does not replace records when interaction starts during an automatic request', async () => {
    vi.useFakeTimers();
    const visibility = Object.assign(new EventTarget(), {
      visibilityState: 'visible' as DocumentVisibilityState
    });
    const request = vi
      .fn<(path: string) => Promise<unknown>>()
      .mockResolvedValueOnce(overview())
      .mockResolvedValueOnce({ records: [record('original')], total: '60', nextCursor: null });
    const service = new PersonalUsageService(request as Requester, vi.fn());
    await service.load(query());
    const pending = deferred<PersonalUsageOverview>();
    request
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ records: [record('new')], total: '60', nextCursor: null });
    service.startAutoRefresh(visibility);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.state.records[0]?.recordId).toBe('original');
    expect(service.state.refreshing).toBe(true);
    service.setRecordsInteracting(true);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(request).toHaveBeenCalledTimes(4);
    pending.resolve(overview());
    await vi.advanceTimersByTimeAsync(0);
    expect(service.state.recordsStale).toBe(true);
    expect(service.state.records[0]?.recordId).toBe('original');
    service.dispose();
  });

  it('gives manual loads priority over an automatic request and retains the old view until success', async () => {
    vi.useFakeTimers();
    const visibility = Object.assign(new EventTarget(), {
      visibilityState: 'visible' as DocumentVisibilityState
    });
    const request = vi
      .fn<(path: string, init?: RequestInit) => Promise<unknown>>()
      .mockResolvedValueOnce(overview())
      .mockResolvedValueOnce({ records: [record('original')], total: '60', nextCursor: null });
    const service = new PersonalUsageService(request as Requester, vi.fn());
    await service.load(query());
    const pending = deferred<PersonalUsageOverview>();
    request
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ records: [record('auto')], total: '60', nextCursor: null });
    service.startAutoRefresh(visibility);
    await vi.advanceTimersByTimeAsync(60_000);
    request
      .mockResolvedValueOnce(overview())
      .mockResolvedValueOnce({ records: [record('manual')], total: '60', nextCursor: null });
    const manual = service.load(query(), { reset: false });
    expect(service.state.records[0]?.recordId).toBe('original');
    expect(request.mock.calls[2]?.[1]?.signal?.aborted).toBe(true);
    await manual;
    pending.resolve(overview());
    await vi.advanceTimersByTimeAsync(0);
    expect(service.state.records[0]?.recordId).toBe('manual');
    service.dispose();
  });

  it('cancels the previous generation and ignores its late success', async () => {
    const firstOverview = deferred<PersonalUsageOverview>();
    const firstRecords = deferred<PersonalUsageRecords>();
    const secondOverview = deferred<PersonalUsageOverview>();
    const secondRecords = deferred<PersonalUsageRecords>();
    const calls: { path: string; init: RequestInit | undefined }[] = [];
    const request = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>((path, init) => {
      calls.push({ path, init });
      const generation = calls.length <= 2 ? 1 : 2;
      if (generation === 1)
        return path.includes('/overview') ? firstOverview.promise : firstRecords.promise;
      return path.includes('/overview') ? secondOverview.promise : secondRecords.promise;
    });
    const reportError = vi.fn();
    const service = new PersonalUsageService(request as Requester, reportError);

    const oldLoad = service.load(
      query({ runner: 'codex', model: 'model/a', mode: 'work', purpose: 'conversation' })
    );
    const newLoad = service.load(query({ from: 1_699_800_000_000 }));

    expect(calls[0]?.path).toBe(
      '/api/me/usage/overview?from=1699900000000&to=1700000000000&timeZone=UTC&runner=codex&model=model%2Fa&mode=work&purpose=conversation'
    );
    expect(calls[1]?.path).toContain('/api/me/usage/records?');
    expect((calls[0]?.init?.signal as AbortSignal).aborted).toBe(true);

    secondOverview.resolve(
      overview({ selected: totals({ totalTokens: '99', requests: '2', completeRequests: '2' }) })
    );
    secondRecords.resolve({ records: [record('new')], total: '60', nextCursor: null });
    expect(await newLoad).toBe(true);
    firstOverview.resolve(
      overview({ selected: totals({ totalTokens: '1', requests: '1', completeRequests: '1' }) })
    );
    firstRecords.resolve({ records: [record('stale')], total: '60', nextCursor: 'stale' });
    expect(await oldLoad).toBe(false);

    expect(service.state.overview?.selected.totalTokens).toBe('99');
    expect(service.state.records.map((entry) => entry.recordId)).toEqual(['new']);
    expect(service.state.failed).toBe(false);
    expect(reportError).not.toHaveBeenCalled();
  });

  it.each(['conversation', 'compact'] as const)(
    'refreshes model options for explicit %s queries without merging distinct models',
    async (purpose) => {
      const fast = { key: 'model-fast', label: 'GPT-6.1-Sol Fast', ...totals() };
      const sol = { key: 'model-sol', label: 'GPT-6.1-Sol', ...totals() };
      let models = [fast];
      const request = vi.fn(async (path: string): Promise<unknown> =>
        path.includes('/overview')
          ? overview({ models })
          : { records: [], total: '0', nextCursor: null }
      );
      const service = new PersonalUsageService(request as Requester, vi.fn());
      await service.load(query({ purpose }));
      expect(service.state.availableModels).toEqual([fast]);

      models = [sol, fast];
      await service.load(query({ purpose, from: query().to - 7 * 86_400_000 }));
      expect(service.state.overview?.models).toEqual([sol, fast]);
      expect(service.state.availableModels).toEqual([sol, fast]);

      models = [];
      await service.load(query({ purpose }));
      expect(service.state.availableModels).toEqual([]);
      service.dispose();
    }
  );

  it('replaces pages once, deduplicates by ledgerId, and keeps the unfiltered model options', async () => {
    const page = deferred<PersonalUsageRecords>();
    const request = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>();
    request
      .mockResolvedValueOnce(overview())
      .mockResolvedValueOnce({
        records: [record('first', { ledgerId: 'ledger-first' })],
        total: '60',
        nextCursor: 'cursor-1'
      })
      .mockReturnValueOnce(page.promise)
      .mockResolvedValueOnce(
        overview({ models: [{ key: 'model-a', label: 'Model A', ...totals() }] })
      )
      .mockResolvedValueOnce({ records: [record('filtered')], total: '60', nextCursor: null });
    const service = new PersonalUsageService(request as Requester, vi.fn());

    await service.load(query({ purpose: 'conversation' }));
    expect(service.state.availableModels.map((model) => model.key)).toEqual(['model-a', 'model-b']);

    const firstMore = service.goToPage(2);
    const secondMore = service.goToPage(2);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[0]).toContain('page=2');
    page.resolve({
      records: [
        record('same', { ledgerId: 'ledger-a' }),
        record('same', { ledgerId: 'ledger-b' }),
        record('same', { ledgerId: 'ledger-b' })
      ],
      total: '60',
      nextCursor: null
    });
    await Promise.all([firstMore, secondMore]);
    expect(service.state.page).toBe(2);
    expect(service.state.records.map((entry) => (entry as UsageRecord).ledgerId)).toEqual([
      'ledger-a',
      'ledger-b'
    ]);

    await service.load(query({ runner: 'codex', purpose: 'conversation' }));
    expect(service.state.availableModels.map((model) => model.key)).toEqual(['model-a', 'model-b']);
  });

  it('reports a failed refresh, then clears the failure on the next successful load', async () => {
    const error = new Error('fixture failure');
    const request = vi
      .fn<(path: string, init?: RequestInit) => Promise<unknown>>()
      .mockRejectedValue(error);
    const reportError = vi.fn();
    const service = new PersonalUsageService(request as Requester, reportError);

    await service.load(query());
    expect(service.state.failed).toBe(true);
    expect(reportError).toHaveBeenCalledWith(error);

    request.mockReset();
    request
      .mockResolvedValueOnce(overview())
      .mockResolvedValueOnce({ records: [], total: '60', nextCursor: null });
    await service.load(query({ from: 1_699_800_000_000 }));
    expect(service.state.failed).toBe(false);
    expect(service.state.overview).toBeDefined();
    expect(service.state.records).toEqual([]);
  });

  it('releases the active request state when disposed', async () => {
    const pending = deferred<unknown>();
    const request = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(
      () => pending.promise
    );
    const service = new PersonalUsageService(request as Requester, vi.fn());
    const loading = service.load(query());

    service.dispose();
    expect((request.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
    expect(service.state.loading).toBe(false);
    expect(service.state.loadingPage).toBe(false);
    pending.resolve(overview());
    await loading;
  });
});

describe('personal usage settings contract', () => {
  it.each(['en-US', 'zh-CN'] as const)('renders missing usage as zero in %s', async (locale) => {
    localePreferenceService().setLocale(locale);
    const request = vi.fn();
    const service = new PersonalUsageService(request, vi.fn());
    service.state.overview = overview();
    vi.spyOn(personalUsageServiceModule, 'PersonalUsageService').mockImplementation(function () {
      return service;
    });
    const app = createSSRApp({ render: () => h(PersonalUsageSettings, { request }) });
    // Tooltip layout is browser-only; SSR has no tooltip output.
    app.directive('tooltip', {});
    app.use(i18n).use(ElementPlus);
    app.provide(ID_INJECTION_KEY, { prefix: 942, current: 0 });
    app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
    const html = await renderToString(app);
    const summary = html.match(/<div class="section-heading"[^>]*>([\s\S]*?)<\/div>/u)?.[1];
    expect(summary).toBeDefined();
    expect(summary).toContain('0 (0%)');
    expect(summary).not.toContain(commonMessages[locale].modelUsage.unknown);
  });

  it.each([
    ['1', '3', '33.3%'],
    ['1', '16', '6.3%'],
    ['0', '100', '0%'],
    ['100', '100', '100%'],
    ['225179981368524828086419725308641972', '900719925474099312345678901234567890', '25%'],
    [null, '100', '0%'],
    ['1', undefined, '0%'],
    ['0', '0', '0%'],
    [undefined, undefined, '0%']
  ])('formats cache hit rate from exact known counters: %s / %s', (cache, input, expected) => {
    for (const locale of ['en-US', 'zh-CN'])
      expect(cacheHitRate(cache, input, locale)).toBe(expected);
  });
  it('shares the full-year, 24-hour local timestamp with conversation messages in both locales', () => {
    expect(conversationTime).toBe(absoluteMessageTime);
    for (const locale of ['en-US', 'zh-CN'] as const) {
      localePreferenceService().setLocale(locale);
      const date = new Date(2026, 9, 14, 9, 4, 3);
      expect(absoluteMessageTime(date.getTime())).toBe('2026-10-14 09:04:03');
      expect(absoluteMessageTime(new Date(2026, 0, 2, 0, 0, 0).getTime())).toBe(
        '2026-01-02 00:00:00'
      );
    }
  });
  it.each([
    {
      props: { total: 41 },
      total: true,
      pages: Math.ceil(41 / MANAGEMENT_PAGE_SIZE),
      disabled: false
    },
    {
      props: { total: 41, mobile: true, mobileVisibleCount: 20 },
      total: false,
      pages: 0,
      disabled: false
    },
    {
      props: { page: 2, pageSize: 20, total: 61, loading: true },
      total: true,
      pages: 4,
      disabled: true
    },
    {
      props: { page: 2, pageSize: 20, cursor: { hasNext: true } },
      total: false,
      pages: 3,
      disabled: false
    },
    {
      props: { page: 2, pageSize: 20, cursor: { hasNext: false }, loading: true },
      total: false,
      pages: 2,
      disabled: true
    }
  ])(
    'renders the shared management pager without invented cursor totals: $props',
    async ({ props, total, pages, disabled }) => {
      const app = createSSRApp({
        render: () =>
          h(ManagementPagination, { page: 1, mobile: false, mobileVisibleCount: 0, ...props })
      });
      app.directive('tooltip', {});
      app.use(i18n).use(ElementPlus);
      app.provide(ID_INJECTION_KEY, { prefix: 941, current: 0 });
      app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
      const html = await renderToString(app);
      expect(html.includes('el-pagination__total')).toBe(total);
      expect(html.match(/class="(?:[^"]* )?number(?: [^"]*)?"/gu)?.length ?? 0).toBe(pages);
      const next = html.match(/<button\b[^>]*class="[^"]*btn-next[^"]*"[^>]*>/u)?.[0];
      if (pages === 0) {
        expect(next).toBeUndefined();
        expect(html).toContain('management-mobile-status');
        expect(html).toContain(
          commonMessages[localePreferenceService().locale.value].common.loadMore
        );
        return;
      }
      expect(next).toBeDefined();
      expect(/\sdisabled(?:[\s=>])/u.test(next!)).toBe(disabled);
    }
  );
  it.each(['en-US', 'zh-CN'] as const)(
    'renders independent overview windows, reactive model choices and accessible records in %s',
    async (locale) => {
      localePreferenceService().setLocale(locale);
      vi.stubGlobal('window', {
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
      });
      vi.stubGlobal('document', {});
      vi.stubGlobal('HTMLElement', class {});
      const request = vi.fn();
      const service = new PersonalUsageService(request, vi.fn());
      vi.spyOn(service, 'load').mockResolvedValue(true);
      vi.spyOn(service, 'startAutoRefresh').mockImplementation(() => undefined);
      Object.assign(service.state, {
        overview: overview({
          last24Hours: totals({ inputTokens: '41' }),
          last7Days: totals({ inputTokens: '73' }),
          selected: totals({ inputTokens: '5' })
        }),
        availableModels: [
          { ...overview().models[0]!, key: 'initial-model', label: 'Initial choice' }
        ],
        records: [
          record('shared-record', { ledgerId: 'ledger-one', state: 'failed' }),
          record('shared-record', { ledgerId: 'ledger-two', state: 'succeeded' })
        ]
      });
      vi.spyOn(personalUsageServiceModule, 'PersonalUsageService').mockImplementation(function () {
        return service;
      });
      const view = renderComponent(InteractivePersonalUsageSettings, { request });
      try {
        await flushComponent();
        const cards = view
          .findAll('section')
          .filter((node) => node.props['class'] === 'overview-cell');
        expect(cards.map(textContent)).toEqual([
          expect.stringContaining(commonMessages[locale].modelUsage.last24Hours),
          expect.stringContaining(commonMessages[locale].modelUsage.last7Days)
        ]);
        expect(textContent(cards[0]!)).toContain('41');
        expect(textContent(cards[1]!)).toContain('73');
        expect(view.findAll('ElOption').map((node) => node.props['value'])).toContain(
          'initial-model'
        );
        service.state.availableModels = [];
        service.state.overview = overview({
          models: [{ ...overview().models[0]!, key: 'fallback-model', label: 'Fallback choice' }]
        });
        await flushComponent();
        const choices = view.findAll('ElOption').map((node) => node.props['value']);
        expect(choices).toContain('fallback-model');
        expect(choices).not.toContain('initial-model');
        const statuses = view.findAll('ElTag').filter((node) => node.props['role'] === 'status');
        expect(statuses.map((node) => node.props['aria-label'])).toEqual([
          commonMessages[locale].modelUsage.states.failed,
          commonMessages[locale].modelUsage.states.succeeded
        ]);
        expect(statuses.map((node) => node.props['type'])).toEqual(['danger', 'info']);
        service.state.records = [
          record('running', { state: 'running' }),
          record('cancelled', { state: 'cancelled' }),
          record('interrupted', { state: 'interrupted' })
        ];
        await flushComponent();
        expect(
          view
            .findAll('ElTag')
            .filter((node) => node.props['role'] === 'status')
            .map((node) => node.props['type'])
        ).toEqual(['primary', 'info', 'warning']);
        service.state.records = [
          record('shared-record', { ledgerId: 'ledger-one', state: 'failed' }),
          record('shared-record', { ledgerId: 'ledger-two', state: 'succeeded' })
        ];
        await flushComponent();
        expect(
          view.findAll('svg').find((node) => node.props['role'] === 'img')?.props['aria-label']
        ).toBe(commonMessages[locale].modelUsage.trend);
        expect(textContent(view.findAll('summary')[0]!)).toBe(
          commonMessages[locale].modelUsage.chartData
        );
        const recordTable = view
          .findAll('ElTable')
          .find((node) => typeof node.props['row-key'] === 'function')!;
        const key = recordTable.props['row-key'] as (record: UsageRecord) => string;
        expect(service.state.records.map(key)).toEqual(['ledger-one', 'ledger-two']);
        expect(key(record('legacy-record'))).toBe('legacy-record');
      } finally {
        view.unmount();
      }
    }
  );

  it.each(['en-US', 'zh-CN'] as const)(
    'renders the public settings shell in %s',
    async (locale) => {
      localePreferenceService().setLocale(locale);
      const request = vi.fn();
      const app = createSSRApp({ render: () => h(PersonalUsageSettings, { request }) });
      app.directive('tooltip', {});
      app.use(i18n).use(ElementPlus);
      let selectedRange: unknown;
      app.component(
        'el-select',
        defineComponent({
          props: ['modelValue', 'ariaLabel'],
          setup(props, { attrs, slots }) {
            if (props.ariaLabel === commonMessages[locale].modelUsage.range) {
              selectedRange = props.modelValue;
            }
            return () => h(ElSelect, { ...attrs, ...props }, slots);
          }
        })
      );
      app.provide(ID_INJECTION_KEY, { prefix: 940, current: 0 });
      app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
      const html = await renderToString(app);

      expect(html).toContain(commonMessages[locale].modelUsage.title);
      expect(html).not.toContain(locale === 'en-US' ? 'About these statistics' : '统计说明');
      expect(html).toContain(commonMessages[locale].modelUsage.range);
      expect(selectedRange).toBe('24h');
      const refreshButton = html.match(/<button\b[\s\S]*?<\/button>/u)?.[0];
      expect(refreshButton).toContain('<svg');
      expect(refreshButton).toContain(commonMessages[locale].modelUsage.refresh);
      expect(request).not.toHaveBeenCalled();
    }
  );

  it.each(['en-US', 'zh-CN'] as const)(
    'renders category-only chart legends while retaining cache counts in the summary in %s',
    async (locale) => {
      localePreferenceService().setLocale(locale);
      const request = vi.fn();
      const service = new PersonalUsageService(request, vi.fn());
      service.state.overview = overview({
        selected: totals({
          inputTokens: '1000',
          cacheReadTokens: '750',
          outputTokens: '200',
          totalTokens: '1200',
          requests: '1'
        })
      });
      vi.spyOn(personalUsageServiceModule, 'PersonalUsageService').mockImplementation(function () {
        return service;
      });
      const app = createSSRApp({ render: () => h(PersonalUsageSettings, { request }) });
      app.directive('tooltip', {});
      app.use(i18n).use(ElementPlus);
      app.provide(ID_INJECTION_KEY, { prefix: 941, current: 0 });
      app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
      const html = await renderToString(app);
      const legend = html.match(/<div class="legend"[^>]*>([\s\S]*?)<\/div>/u)?.[1];
      expect(legend).toBeDefined();
      const legendText = legend!.replace(/<[^>]*>/gu, '');
      for (const category of ['input', 'cache', 'output'] as const) {
        expect(legendText).toContain(commonMessages[locale].modelUsage[category]);
      }
      expect(legendText).not.toMatch(/[\d%]/u);
      const summary = html.match(/<div class="section-heading"[^>]*>([\s\S]*?)<\/div>/u)?.[1];
      expect(summary).toBeDefined();
      expect(summary).toContain('750 (75%)');
      expect(request).not.toHaveBeenCalled();
      service.dispose();
    }
  );

  it('keeps every personal usage message key and placeholder aligned across locales', () => {
    const leaves = (value: unknown, prefix = ''): [string, string][] => {
      if (typeof value === 'string') return [[prefix, value]];
      return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
        leaves(child, prefix ? `${prefix}.${key}` : key)
      );
    };
    const zh = leaves(personalSettingsZhCN.modelUsage);
    const en = leaves(personalSettingsEnUS.modelUsage);
    expect(zh.map(([key]) => key)).toEqual(en.map(([key]) => key));
    for (const [key, value] of zh) {
      const english = en.find(([candidate]) => candidate === key)?.[1];
      expect(value, `zh-CN ${key}`).not.toBe('');
      expect(english, `en-US ${key}`).toBeTypeOf('string');
      expect(value.match(/\{[^}]+\}/gu) ?? [], `zh-CN ${key} placeholders`).toEqual(
        english?.match(/\{[^}]+\}/gu) ?? []
      );
    }
  });
});
