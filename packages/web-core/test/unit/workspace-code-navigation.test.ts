import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceCodeNavigationService } from '../../src/service/workspace-code-navigation-service.js';

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const target = { path: 'src/target.ts', line: 4, kind: 'function', preview: 'function thing() {}' };
const response = (definition = {}) => ({
  definition: {
    state: 'READY',
    targets: [],
    references: [],
    paths: [],
    truncated: false,
    ...definition
  }
});
const source = { pageId: 1, nodeId: 'node-1', workspaceId: 'workspace-1', path: 'src/main.ts' };
const fileRequest = {
  reference: {
    languageId: 'ecmascript',
    extractorId: 'ecmascript-import',
    kind: 'module',
    value: './target',
    from: 0,
    to: 8
  },
  sourceContext: { text: 'import "./target"', position: 10 }
} as const;
function fixture() {
  const request = vi.fn();
  const onFailure = vi.fn();
  const onFileTarget = vi.fn();
  const service = createWorkspaceCodeNavigationService({
    http: { request },
    onFailure,
    onFileTarget
  });
  const page = service.page(1);
  return { request, onFailure, onFileTarget, service, page };
}
afterEach(() => vi.useRealTimers());

describe('Workspace code navigation', () => {
  it('shows declarations before references without reopening foreground loading', async () => {
    const f = fixture();
    const references = deferred();
    f.request
      .mockResolvedValueOnce(response({ targets: [target] }))
      .mockReturnValueOnce(references.promise);
    await f.service.navigate(source, { symbol: 'thing' });
    expect(f.page.navigationLoading.value).toBe(false);
    expect(f.page.navigationTargets.value).toEqual([{ ...target, source: 'DEFINITION' }]);
    const urls = f.request.mock.calls.map(([url]) => new URL(url, 'http://test.local'));
    expect(urls.map((url) => url.searchParams.get('references'))).toEqual(['0', '1']);
    expect(urls[0]?.searchParams.get('path')).toBe('src/main.ts');
    expect(urls[0]?.searchParams.get('symbol')).toBe('thing');
    references.resolve(
      response({ state: 'STALE', references: [{ ...target, column: 2, path: 'src/use.ts' }] })
    );
    await vi.waitFor(() =>
      expect(f.page.navigationTargets.value.map((entry) => entry.source)).toEqual([
        'DEFINITION',
        'REFERENCE'
      ])
    );
  });

  it('keeps newer navigation when old declarations, references or errors arrive', async () => {
    const f = fixture();
    const old = deferred();
    f.request
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(response({ targets: [target] }))
      .mockResolvedValueOnce(response({ targets: [target] }));
    const navigating = f.service.navigate(source, { symbol: 'old' });
    await f.service.navigate(source, { symbol: 'new' });
    old.reject(new Error('old failure'));
    await navigating;
    expect(f.onFailure).not.toHaveBeenCalled();
    expect(f.page.navigationTargets.value).toEqual([{ ...target, source: 'DEFINITION' }]);
    const references = deferred();
    f.request.mockResolvedValueOnce(response()).mockReturnValueOnce(references.promise);
    const pendingReferences = f.service.navigate(source, { symbol: 'old references' });
    await vi.waitFor(() =>
      expect(f.request).toHaveBeenLastCalledWith(expect.stringContaining('references=1'))
    );
    f.service.clear(1);
    references.resolve(response({ references: [{ ...target, column: 2 }] }));
    await pendingReferences;
    expect(f.page.navigationTargets.value).toEqual([]);
    expect(f.page.navigationNoDefinition.value).toBe(false);
  });

  it('bounds BUILDING retries and immediately releases the timer on cancellation or unmount', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.request.mockResolvedValue(response({ state: 'BUILDING' }));
    const navigating = f.service.navigate(source, { symbol: 'thing' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    f.service.reset();
    expect(vi.getTimerCount()).toBe(0);
    await navigating;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.request).toHaveBeenCalledTimes(1);
    f.service.page(1);
    const bounded = f.service.navigate(source, { symbol: 'thing' });
    await vi.advanceTimersByTimeAsync(120_000);
    await bounded;
    expect(f.request).toHaveBeenCalledTimes(121);
    expect(f.onFailure).toHaveBeenCalledWith(new Error('SYMBOL_INDEX_BUILD_FAILED'));
  });

  it('captures file scope and editor context for every retry', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const requestSource = { ...source };
    const request = {
      reference: { ...fileRequest.reference },
      sourceContext: { ...fileRequest.sourceContext }
    };
    f.request
      .mockResolvedValueOnce(response({ state: 'BUILDING' }))
      .mockResolvedValueOnce(response({ paths: [target] }));
    const navigating = f.service.navigate(requestSource, request);
    await vi.advanceTimersByTimeAsync(0);
    Object.assign(requestSource, {
      nodeId: 'other-node',
      workspaceId: 'other-workspace',
      path: 'other.ts'
    });
    Object.assign(request.reference, { value: './changed' });
    Object.assign(request.sourceContext, { text: 'changed editor buffer' });
    await vi.advanceTimersByTimeAsync(1_000);
    await navigating;
    const [first, second] = f.request.mock.calls;
    expect(second).toEqual(first);
    expect(JSON.parse(second![1].body)).toMatchObject({
      nodeId: 'node-1',
      path: 'src/main.ts',
      reference: { value: './target', sourceContext: fileRequest.sourceContext }
    });
    expect(f.onFileTarget).toHaveBeenCalledWith({ ...target, source: 'FILE' }, 1);
  });

  it('captures file POST input, opens a unique path and leaves ambiguous choices to the view', async () => {
    const f = fixture();
    const pending = deferred();
    f.request.mockReturnValueOnce(pending.promise);
    const navigating = f.service.navigate(source, fileRequest);
    const [url, init] = f.request.mock.calls[0]!;
    expect(url).toBe('/api/workspaces/workspace-1/symbols/definition');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      nodeId: 'node-1',
      path: 'src/main.ts',
      reference: { ...fileRequest.reference, sourceContext: fileRequest.sourceContext }
    });
    pending.resolve(response({ paths: [target] }));
    await navigating;
    expect(f.onFileTarget).toHaveBeenCalledWith({ ...target, source: 'FILE' }, 1);
    f.request.mockResolvedValueOnce(
      response({ paths: [target, { ...target, path: 'src/other.ts' }] })
    );
    await f.service.navigate(source, fileRequest);
    expect(f.page.navigationTargets.value).toHaveLength(2);
    expect(f.onFileTarget).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['symbol limit', { symbol: 'thing' }, 'FAILED', 'SYMBOL_INDEX_LIMIT_EXCEEDED', 'LIMITED'],
    ['file limit', fileRequest, 'FAILED', 'SYMBOL_INDEX_LIMIT_EXCEEDED', 'LIMITED'],
    ['missing Ctags', { symbol: 'thing' }, 'UNAVAILABLE', undefined, 'UNAVAILABLE']
  ] as const)(
    'shows %s as a local notice without reporting an error or an empty result',
    async (_label, input, state, failureCode, notice) => {
      const f = fixture();
      f.request.mockResolvedValue(response({ state, failureCode }));
      await f.service.navigate(source, input);
      expect(f.page.navigationNotice.value).toBe(notice);
      expect(f.page.navigationLoading.value).toBe(false);
      expect(f.page.navigationNoDefinition.value).toBe(false);
      expect(f.page.navigationTargets.value).toEqual([]);
      expect(f.onFailure).not.toHaveBeenCalled();
      expect(f.onFileTarget).not.toHaveBeenCalled();
      expect(f.request).toHaveBeenCalledOnce();

      f.request.mockResolvedValue(response({ paths: [target] }));
      await f.service.navigate(source, fileRequest);
      expect(f.page.navigationNotice.value).toBeUndefined();
      expect(f.onFileTarget).toHaveBeenCalledWith({ ...target, source: 'FILE' }, 1);
    }
  );

  it.each([false, true])(
    'preserves accepted declarations when references hit the limit (definitions=%s)',
    async (hasDefinitions) => {
      const f = fixture();
      f.request
        .mockResolvedValueOnce(response({ targets: hasDefinitions ? [target] : [] }))
        .mockResolvedValueOnce(
          response({ state: 'FAILED', failureCode: 'SYMBOL_INDEX_LIMIT_EXCEEDED' })
        );
      await f.service.navigate(source, { symbol: 'thing' });
      await Promise.resolve();
      expect(f.page.navigationTargets.value).toEqual(
        hasDefinitions ? [{ ...target, source: 'DEFINITION' }] : []
      );
      expect(f.page.navigationNotice.value).toBe('LIMITED');
      expect(f.page.navigationNoDefinition.value).toBe(false);
      expect(f.page.navigationLoading.value).toBe(false);
      expect(f.onFailure).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['build failure', false],
    ['build failure', true],
    ['invalid response', false],
    ['request failure', true]
  ] as const)(
    'reports a reference %s without pretending it is empty (definitions=%s)',
    async (failure, hasDefinitions) => {
      const f = fixture();
      f.request.mockResolvedValueOnce(response({ targets: hasDefinitions ? [target] : [] }));
      if (failure === 'request failure') f.request.mockRejectedValueOnce(new Error('offline'));
      else
        f.request.mockResolvedValueOnce(
          failure === 'invalid response' ? {} : response({ state: 'FAILED' })
        );
      await f.service.navigate(source, { symbol: 'thing' });
      await vi.waitFor(() => expect(f.onFailure).toHaveBeenCalledOnce());
      expect(f.page.navigationTargets.value).toEqual(
        hasDefinitions ? [{ ...target, source: 'DEFINITION' }] : []
      );
      expect(f.page.navigationNoDefinition.value).toBe(false);
      expect(f.page.navigationLoading.value).toBe(false);
    }
  );

  it.each([false, true])(
    'keeps reference polling separate and cancellable (cancel=%s)',
    async (cancel) => {
      vi.useFakeTimers();
      const f = fixture();
      f.request
        .mockResolvedValueOnce(response({ targets: [target] }))
        .mockResolvedValueOnce(response({ state: 'BUILDING' }))
        .mockResolvedValueOnce(response({ references: [{ ...target, column: 2 }] }));
      await f.service.navigate(source, { symbol: 'thing' });
      expect(f.page.navigationLoading.value).toBe(false);
      expect(f.page.navigationTargets.value).toEqual([{ ...target, source: 'DEFINITION' }]);
      if (cancel) f.service.clear(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.request).toHaveBeenCalledTimes(cancel ? 2 : 3);
      expect(f.page.navigationTargets.value.map((entry) => entry.source)).toEqual(
        cancel ? [] : ['DEFINITION', 'REFERENCE']
      );
      expect(f.onFailure).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('keeps loading visible until references arrive when there are no declarations', async () => {
    const f = fixture();
    const references = deferred();
    f.request
      .mockResolvedValueOnce(response({ targets: [] }))
      .mockReturnValueOnce(references.promise);
    const navigating = f.service.navigate(source, { symbol: 'thing' });
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
    expect(f.page.navigationLoading.value).toBe(true);
    references.resolve(response({ references: [{ ...target, column: 2 }] }));
    await navigating;
    expect(f.page.navigationLoading.value).toBe(false);
    expect(f.page.navigationTargets.value).toEqual([
      {
        path: target.path,
        line: target.line,
        preview: target.preview,
        column: 2,
        source: 'REFERENCE'
      }
    ]);
  });

  it('clears local notices and ignores a late limit response after cancellation', async () => {
    const f = fixture();
    const limited = response({ state: 'FAILED', failureCode: 'SYMBOL_INDEX_LIMIT_EXCEEDED' });
    f.request.mockResolvedValueOnce(limited);
    await f.service.navigate(source, { symbol: 'thing' });
    f.service.clear(1);
    expect(f.page.navigationNotice.value).toBeUndefined();
    const old = deferred();
    f.request.mockReturnValueOnce(old.promise);
    const navigating = f.service.navigate(source, { symbol: 'old' });
    f.service.cancel();
    old.resolve(limited);
    await navigating;
    expect(f.page.navigationNotice.value).toBeUndefined();
    expect(f.onFailure).not.toHaveBeenCalled();
  });

  it.each(['FAILED', 'invalid'])(
    'reports %s only for the current foreground query',
    async (state) => {
      const f = fixture();
      f.request.mockResolvedValue(response({ state }));
      await f.service.navigate(source, { symbol: 'thing' });
      expect(f.onFailure).toHaveBeenCalledOnce();
      expect(f.page.navigationLoading.value).toBe(false);
      expect(f.page.navigationTargets.value).toEqual([]);
    }
  );

  it('retains per-tab results, drops closed pages and suppresses stale Workspace responses', async () => {
    const f = fixture();
    const old = deferred();
    f.request.mockReturnValueOnce(old.promise);
    const navigating = f.service.navigate(source, fileRequest);
    f.service.release(1);
    const next = f.service.page(2);
    f.request.mockResolvedValueOnce(response({ paths: [target, { ...target, path: 'src/b.ts' }] }));
    await f.service.navigate({ ...source, pageId: 2, workspaceId: 'other' }, fileRequest);
    old.resolve(response({ paths: [target] }));
    await navigating;
    expect(next.navigationTargets.value).toHaveLength(2);
    expect(f.service.page(1).navigationTargets.value).toEqual([]);
    expect(f.onFileTarget).not.toHaveBeenCalled();
    expect(f.request.mock.calls[1]![0]).toBe('/api/workspaces/other/symbols/definition');
  });

  it('marks empty reference results but treats prewarming as best effort', async () => {
    const f = fixture();
    f.request.mockResolvedValue(response());
    await f.service.navigate(source, { symbol: 'missing' });
    await Promise.resolve();
    expect(f.page.navigationNoDefinition.value).toBe(true);
    await f.service.prewarm(source);
    expect(f.request.mock.calls.at(-1)![0]).toBe(
      '/api/workspaces/workspace-1/symbols/prepare?nodeId=node-1&path=src%2Fmain.ts'
    );
    expect(f.onFailure).not.toHaveBeenCalled();
  });
});
