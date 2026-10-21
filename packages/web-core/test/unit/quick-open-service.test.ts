import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createQuickOpenQueryService,
  type QuickOpenTab
} from '../../src/service/QuickOpenService.js';
import type { ScopedHttpService } from '../../src/service/ScopedHttpService.js';
import { ApiError } from '../../src/util/api-error.js';

const services: ReturnType<typeof createQuickOpenQueryService>[] = [];
const ready = {
  state: 'READY',
  targets: [{ path: 'src/foo.ts', line: 2 }],
  references: [],
  paths: [],
  truncated: false,
  referenceTruncated: false
};
const building = { ...ready, state: 'BUILDING', targets: [] };

function fixture(initialTab: QuickOpenTab = 'SYMBOL', deadlineMs = 30_000) {
  let query = 'foo';
  let tab = initialTab;
  const request = vi.fn(async (_path: string, _init?: RequestInit): Promise<unknown> => ({
    definition: building
  }));
  const service = createQuickOpenQueryService({
    open: () => true,
    query: () => query,
    tab: () => tab,
    nodeId: () => 'node',
    workspaceId: () => 'workspace',
    filesReady: () => true,
    symbolsReady: () => true,
    nonblockingFiles: () => true,
    nodes: () => [],
    workspaceTabs: () => [],
    origin: () => 'http://localhost',
    http: { request: request as ScopedHttpService['request'] },
    deadlineMs
  });
  services.push(service);
  return {
    service,
    request,
    setQuery: (value: string) => {
      query = value;
      service.scheduleSearch();
    },
    setTab: (value: QuickOpenTab) => {
      tab = value;
      service.scheduleSearch();
    }
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  services.splice(0).forEach((service) => service.dispose());
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('Quick Open progressive queries', () => {
  it('shows definitions before a slow reference query and keeps them on reference failure', async () => {
    const { service, request } = fixture();
    let failReferences!: (error: unknown) => void;
    request.mockImplementation(async (path) =>
      path.includes('references=0')
        ? { definition: ready }
        : new Promise((_resolve, reject) => {
            failReferences = reject;
          })
    );
    service.scheduleSearch();
    await vi.advanceTimersByTimeAsync(120);
    expect(service.symbols.value.map((entry) => entry.source)).toEqual(['DEFINITION']);
    expect(service.symbolStatus.phase).toBe('READY');
    expect(service.referenceStatus.phase).toBe('SEARCHING');
    const error = new ApiError(
      'NODE_REQUEST_TIMEOUT',
      'The request timed out.',
      {},
      'bounded detail',
      'request-1'
    );
    failReferences(error);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.symbols.value).toHaveLength(1);
    expect(service.referenceStatus.phase).toBe('FAILED');
    expect(service.referenceStatus.error).toBe(error);
  });

  it('shows references even when a ready index has no definitions', async () => {
    const { service, request } = fixture();
    request.mockImplementation(async (path) => ({
      definition: {
        ...ready,
        targets: [],
        references: path.includes('references=1')
          ? [{ path: 'src/caller.ts', line: 4, column: 2, preview: 'foo()' }]
          : []
      }
    }));
    service.scheduleSearch();
    await vi.advanceTimersByTimeAsync(120);
    expect(service.symbols.value.map((entry) => entry.source)).toEqual(['REFERENCE']);
  });

  it('cancels a poll delay before another request is sent, including on disposal', async () => {
    const { service, request } = fixture();
    service.scheduleSearch();
    await vi.advanceTimersByTimeAsync(120);
    expect(request).toHaveBeenCalledTimes(1);
    const signal = request.mock.calls[0]?.[1]?.signal;
    service.dispose();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(signal?.aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses elapsed time rather than request counts for its foreground deadline', async () => {
    const { service, request } = fixture('SYMBOL', 700);
    request.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return { definition: building };
    });
    service.scheduleSearch();
    await vi.advanceTimersByTimeAsync(1_200);
    expect(request).toHaveBeenCalledTimes(1);
    expect(service.symbolStatus.phase).toBe('TIMED_OUT');
  });

  it('keeps timeout distinct from an empty result and preserves structured diagnostics', async () => {
    const { service, request } = fixture('FILE');
    const error = new ApiError(
      'NODE_REQUEST_TIMEOUT',
      'The request timed out.',
      {},
      'detail',
      'correlation'
    );
    request.mockRejectedValue(error);
    service.scheduleSearch();
    await vi.advanceTimersByTimeAsync(120);
    expect(service.files.value).toEqual([]);
    expect(service.fileStatus.phase).toBe('FAILED');
    expect(service.fileStatus.error).toBe(error);
  });

  it('joins nonblocking preparation and consumes authoritative scores and truncation', async () => {
    const { service, request } = fixture('FILE');
    request.mockResolvedValueOnce({
      files: { entries: [], nextCursor: null, truncated: false, indexState: 'BUILDING' }
    });
    request.mockResolvedValue({
      files: {
        entries: [
          { path: 'src/foo.ts', name: 'foo.ts', kind: 'FILE', size: 1, modifiedAt: 1, score: 999.9 }
        ],
        nextCursor: 'cursor',
        truncated: true,
        indexState: 'READY'
      }
    });
    service.scheduleSearch();
    await vi.advanceTimersByTimeAsync(120);
    expect(service.fileStatus.phase).toBe('BUILDING');
    expect(request.mock.calls[0]?.[0]).toContain('waitForIndex=false');
    await vi.advanceTimersByTimeAsync(250);
    expect(service.files.value[0]?.score).toBe(999.9);
    expect(service.fileStatus.truncated).toBe(true);
    expect(service.fileCursor.value).toBe('cursor');
  });

  it('never applies late results from a previous query', async () => {
    const { service, request, setQuery } = fixture('FILE');
    let release!: (value: unknown) => void;
    request.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    request.mockResolvedValue({
      files: {
        entries: [{ path: 'bar.ts', name: 'bar.ts', kind: 'FILE', size: 1, modifiedAt: 1 }],
        nextCursor: null,
        truncated: false
      }
    });
    service.scheduleSearch();
    await vi.advanceTimersByTimeAsync(120);
    setQuery('bar');
    await vi.advanceTimersByTimeAsync(120);
    release({
      files: {
        entries: [{ path: 'foo.ts', name: 'foo.ts', kind: 'FILE' }],
        nextCursor: null,
        truncated: false
      }
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(service.files.value.map((entry) => entry.path)).toEqual(['bar.ts']);
  });

  it('explains invalid complete-symbol input instead of pretending the server found no match', async () => {
    const { service, request, setQuery } = fixture();
    setQuery('foo.bar');
    await vi.advanceTimersByTimeAsync(500);
    expect(request).not.toHaveBeenCalled();
    expect(service.symbolStatus.phase).toBe('INVALID');
  });
});
