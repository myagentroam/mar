import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagementPage } from '@myagentroam/protocol';
import {
  createManagementPageService,
  parseManagementPage
} from '../../src/service/management-page-service.js';
import { createCatalogPageService } from '../../src/service/catalog-page-service.js';

interface Item {
  readonly id: string;
}

function page(
  items: readonly Item[],
  pageNumber = 1,
  total = items.length,
  hasMore = false
): ManagementPage<Item> {
  return { items, page: pageNumber, pageSize: 20, total, hasMore };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('management page response parser', () => {
  it('parses item arrays, metadata and optional tag facets', () => {
    expect(
      parseManagementPage(
        {
          records: [{ id: 7, label: 'seven' }],
          page: 2,
          pageSize: 20,
          total: 25,
          hasMore: true,
          facets: { tags: ['alpha', 'beta'] }
        },
        'records',
        (value) => ({ id: String((value as { id: number }).id) })
      )
    ).toEqual({
      items: [{ id: '7' }],
      page: 2,
      pageSize: 20,
      total: 25,
      hasMore: true,
      facets: { tags: ['alpha', 'beta'] }
    });
  });

  it.each([
    ['null envelope', null],
    ['missing item field', { page: 1, pageSize: 20, total: 0, hasMore: false }],
    ['non-array item field', { records: {}, page: 1, pageSize: 20, total: 0, hasMore: false }],
    ['invalid page metadata', { records: [], page: 0, pageSize: 20, total: 0, hasMore: false }]
  ])('rejects a %s', (_label, raw) => {
    expect(() => parseManagementPage(raw, 'records')).toThrow('MANAGEMENT_PAGE_RESPONSE_INVALID');
  });

  it('rejects malformed tag facets', () => {
    expect(() =>
      parseManagementPage(
        {
          records: [],
          page: 1,
          pageSize: 20,
          total: 0,
          hasMore: false,
          facets: { tags: ['ok', 3] }
        },
        'records'
      )
    ).toThrow('MANAGEMENT_PAGE_RESPONSE_INVALID');
    expect(() =>
      parseManagementPage(
        {
          records: [],
          page: 1,
          pageSize: 20,
          total: 0,
          hasMore: false,
          facets: null
        },
        'records'
      )
    ).toThrow();
  });
});

describe('management page service lifecycle', () => {
  it('exposes catalog initial, refresh and append failures through the same page owner', async () => {
    const initialError = new Error('initial');
    const refreshError = new Error('refresh');
    const appendError = new Error('append');
    const request = vi
      .fn()
      .mockRejectedValueOnce(initialError)
      .mockResolvedValueOnce({
        entries: [{ id: 'first' }],
        page: 1,
        pageSize: 20,
        total: 21,
        hasMore: true
      })
      .mockRejectedValueOnce(refreshError)
      .mockRejectedValueOnce(appendError)
      .mockResolvedValueOnce({
        entries: [{ id: 'second' }],
        page: 2,
        pageSize: 20,
        total: 21,
        hasMore: false
      });
    const service = createCatalogPageService<Item>(request, '/catalog', 'entries');
    await service.load();
    expect(service.error.value).toBe(initialError);
    expect(service.failure.value).toMatchObject({ page: 1, append: false });
    await service.retry();
    expect(service.error.value).toBeUndefined();
    await expect(service.refresh()).rejects.toBe(refreshError);
    expect(service.items.value).toEqual([{ id: 'first' }]);
    expect(service.failure.value).toMatchObject({ page: 1, append: false });
    await service.loadMore();
    expect(service.error.value).toBe(appendError);
    expect(service.failure.value).toMatchObject({ page: 2, append: true });
    await service.loadMore(true);
    expect(request).toHaveBeenCalledTimes(4);
    await service.retry();
    expect(service.error.value).toBeUndefined();
    expect(service.items.value).toEqual([{ id: 'first' }, { id: 'second' }]);
    service.dispose();
  });
  it('ignores stale generations and contexts without letting them clear the current loading state', async () => {
    let context = 'first';
    const requests = [
      deferred<ManagementPage<Item>>(),
      deferred<ManagementPage<Item>>(),
      deferred<ManagementPage<Item>>()
    ];
    let requestIndex = 0;
    const read = vi.fn(() => requests[requestIndex++]!.promise);
    const service = createManagementPageService({
      read,
      key: (item) => item.id,
      context: () => context
    });

    const oldGeneration = service.load();
    expect(service.loading.value).toBe(true);
    const currentGeneration = service.load(true);
    requests[0]!.resolve(page([{ id: 'old-generation' }]));
    await oldGeneration;
    expect(service.loading.value).toBe(true);
    expect(service.items.value).toEqual([]);

    context = 'second';
    const currentContext = service.load();
    requests[1]!.resolve(page([{ id: 'old-context' }]));
    await currentGeneration;
    expect(service.loading.value).toBe(true);
    expect(service.items.value).toEqual([]);

    requests[2]!.resolve(page([{ id: 'current' }]));
    await currentContext;
    expect(service.items.value).toEqual([{ id: 'current' }]);
    expect(service.loading.value).toBe(false);
    service.dispose();
  });

  it('appends mobile pages once, deduplicates identities, suppresses failed automatic retries and permits manual retry', async () => {
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
    });
    let failNextPage = true;
    const read = vi.fn(async (requestedPage: number) => {
      if (requestedPage === 2 && failNextPage) throw new Error('offline');
      return requestedPage === 1
        ? page([{ id: 'a' }, { id: 'b' }], 1, 3, true)
        : page([{ id: 'b' }, { id: 'c' }], 2, 3, false);
    });
    const service = createManagementPageService({
      read,
      key: (item) => item.id,
      context: () => 'mobile-list'
    });

    await service.load();
    await service.loadMore(true);
    expect(service.items.value).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(service.failure.value?.error).toBeInstanceOf(Error);
    expect(service.loading.value).toBe(false);
    expect(service.loadingMore.value).toBe(false);
    const callsAfterFailure = read.mock.calls.length;

    await service.loadMore(true);
    expect(read).toHaveBeenCalledTimes(callsAfterFailure);
    failNextPage = false;
    await service.retry();
    await service.loadMore();
    expect(read).toHaveBeenCalledTimes(callsAfterFailure + 1);
    expect(service.items.value).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(service.page.value).toBe(2);
    service.dispose();
  });

  it.each(['resolve', 'reject'] as const)(
    'retains a loaded directory during same-context refresh and its %s outcome',
    async (outcome) => {
      let context = 'current';
      const response = deferred<ManagementPage<Item>>();
      const read = vi
        .fn()
        .mockResolvedValueOnce(page([{ id: 'a' }], 1, 3, true))
        .mockResolvedValueOnce(page([{ id: 'b' }], 2, 3, true))
        .mockImplementationOnce(() => response.promise)
        .mockResolvedValueOnce(page([{ id: 'other-context' }]));
      const service = createManagementPageService<Item>({
        read,
        key: (item) => item.id,
        context: () => context
      });
      await service.load();
      await service.loadMore();
      const items = service.items.value;
      const metadata = service.result.value;
      const refresh = service.load(true);
      expect(service.items.value).toBe(items);
      expect(service.result.value).toBe(metadata);
      expect(service.loading.value).toBe(true);
      expect(read.mock.calls.map(([number]) => number)).toEqual([1, 2, 1]);
      if (outcome === 'resolve') response.resolve(page([{ id: 'refreshed' }]));
      else response.reject(new Error('Refresh failed.'));
      await refresh;
      expect(service.loading.value).toBe(false);
      if (outcome === 'resolve') {
        expect(service.items.value).toEqual([{ id: 'refreshed' }]);
        expect(service.page.value).toBe(1);
      } else {
        expect(service.items.value).toBe(items);
        expect(service.result.value).toBe(metadata);
        expect(service.page.value).toBe(2);
        expect(service.failure.value?.error).toBeInstanceOf(Error);
      }
      context = 'next';
      const switching = service.load(true);
      expect(service.items.value).toEqual([]);
      expect(service.result.value).toBeUndefined();
      await switching;
      expect(service.items.value).toEqual([{ id: 'other-context' }]);
      service.dispose();
    }
  );

  it.each(['resolve', 'reject'] as const)(
    'does not let a superseded append %s clear the current append indicator',
    async (outcome) => {
      const stale = deferred<ManagementPage<Item>>();
      const refreshResponse = deferred<ManagementPage<Item>>();
      const current = deferred<ManagementPage<Item>>();
      const read = vi
        .fn()
        .mockResolvedValueOnce(page([{ id: 'initial' }], 1, 40, true))
        .mockImplementationOnce(() => stale.promise)
        .mockImplementationOnce(() => refreshResponse.promise)
        .mockImplementationOnce(() => current.promise);
      const service = createManagementPageService<Item>({
        read,
        key: (item) => item.id,
        context: () => 'same-directory'
      });
      await service.load();
      const oldAppend = service.loadMore();
      expect(service.loadingMore.value).toBe(true);
      const refresh = service.load(true);
      expect(service.loadingMore.value).toBe(false);
      refreshResponse.resolve(page([{ id: 'refreshed' }], 1, 40, true));
      await refresh;
      const newAppend = service.loadMore();
      expect(service.loadingMore.value).toBe(true);
      if (outcome === 'resolve') stale.resolve(page([{ id: 'stale' }], 2, 40, false));
      else stale.reject(new Error('Stale append failed.'));
      await oldAppend;
      expect(service.loading.value).toBe(true);
      expect(service.loadingMore.value).toBe(true);
      expect(service.items.value).toEqual([{ id: 'refreshed' }]);
      expect(service.failure.value).toBeUndefined();
      current.resolve(page([{ id: 'current' }], 2, 40, false));
      await newAppend;
      expect(service.loading.value).toBe(false);
      expect(service.loadingMore.value).toBe(false);
      expect(service.items.value).toEqual([{ id: 'refreshed' }, { id: 'current' }]);
      service.dispose();
    }
  );

  it('resets and rereads page one when an append response is clamped to the current page', async () => {
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
    });
    const read = vi
      .fn()
      .mockResolvedValueOnce(page([{ id: 'initial' }], 1, 40, true))
      .mockResolvedValueOnce(page([{ id: 'stale-page' }], 1, 12, false))
      .mockResolvedValueOnce(page([{ id: 'refreshed-page-one' }], 1, 12, false));
    const service = createManagementPageService<Item>({
      read,
      key: (item) => item.id,
      context: () => 'clamped-list'
    });

    await service.load();
    await service.loadMore();

    expect(read.mock.calls.map(([requestedPage]) => requestedPage)).toEqual([1, 2, 1]);
    expect(service.items.value).toEqual([{ id: 'refreshed-page-one' }]);
    expect(service.page.value).toBe(1);
    expect(service.hasMore.value).toBe(false);
    service.dispose();
  });

  it('retains the loaded page when a clamped append cannot reload page one', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(page([{ id: 'retained' }], 1, 40, true))
      .mockResolvedValueOnce(page([{ id: 'clamped' }], 1, 12, false))
      .mockRejectedValueOnce(new Error('Reload failed.'));
    const service = createManagementPageService<Item>({
      read,
      key: (item) => item.id,
      context: () => 'clamped-list'
    });
    await service.load();
    const items = service.items.value;
    const metadata = service.result.value;
    await service.loadMore();
    expect(service.items.value).toBe(items);
    expect(service.result.value).toBe(metadata);
    expect(service.page.value).toBe(1);
    expect(service.loading.value).toBe(false);
    expect(service.loadingMore.value).toBe(false);
    expect(service.failure.value?.error).toBeInstanceOf(Error);
    service.dispose();
  });

  it('accepts a server-clamped direct page and stores the returned page number', async () => {
    const read = vi.fn(async (requestedPage: number) =>
      requestedPage === 1
        ? page([{ id: 'one' }], 1, 45, true)
        : page([{ id: 'last' }], 3, 45, false)
    );
    const service = createManagementPageService({
      read,
      key: (item) => item.id,
      context: () => 'desktop-list'
    });

    await service.load();
    await service.setPage(9);
    expect(read.mock.calls.map(([requestedPage]) => requestedPage)).toEqual([1, 9]);
    expect(service.page.value).toBe(3);
    expect(service.result.value?.page).toBe(3);
    service.dispose();
  });
});
