import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceContentSearchService } from '../../src/service/workspace-content-search-service.js';

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const match = { path: 'src/你好.ts', line: 3, column: 2, preview: 'export const thing = 1;' };
const result = (preview: string) => ({
  search: { matches: [{ ...match, preview }], truncated: true }
});
function fixture() {
  const request = vi.fn();
  const onFailure = vi.fn();
  const service = createWorkspaceContentSearchService({ http: { request }, onFailure });
  return { request, onFailure, service };
}
const input = { nodeId: 'node-1', workspaceId: 'workspace / 1', query: 'thing', useRegex: false };

describe('Workspace content search', () => {
  it('retries the exact failed query and keeps accepted results while pending', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce(result('accepted')).mockRejectedValueOnce(new Error('offline'));
    await f.service.search(input);
    const draft = { ...input, query: 'failed', useRegex: true };
    await f.service.search(draft);
    draft.query = 'edited';
    const response = deferred();
    f.request.mockReturnValueOnce(response.promise);
    const retry = f.service.retry();
    await f.service.retry();
    expect(f.request).toHaveBeenCalledTimes(3);
    expect(new URL(f.request.mock.calls[2]![0], 'http://test.local').searchParams.get('q')).toBe(
      'failed'
    );
    expect(f.service.matches.value[0]?.preview).toBe('accepted');
    expect(f.service.loading.value).toBe(true);
    response.resolve(result('retried'));
    await retry;
    expect(f.service.error.value).toBeUndefined();
    expect(f.service.appliedQuery.value).toBe('failed');
  });
  it('captures query and regex together, including edits made while the request is pending', async () => {
    const f = fixture();
    const response = deferred();
    f.request.mockReturnValue(response.promise);
    const draft = { ...input };
    const searching = f.service.search(draft);
    draft.query = 'edited';
    draft.useRegex = true;
    const url = new URL(f.request.mock.calls[0]![0], 'http://test.local');
    expect(url.pathname).toBe('/api/workspaces/workspace%20%2F%201/content/search');
    expect(url.searchParams.get('nodeId')).toBe('node-1');
    expect(url.searchParams.get('q')).toBe('thing');
    expect(url.searchParams.has('regex')).toBe(false);
    response.resolve(result('thing'));
    await searching;
    expect(f.service.appliedQuery.value).toBe('thing');
    expect(f.service.appliedUseRegex.value).toBe(false);
    expect(f.service.matches.value).toEqual([{ ...match, preview: 'thing' }]);
    expect(f.service.truncated.value).toBe(true);
    expect(f.service.loading.value).toBe(false);
  });

  it('keeps B results and loading when A completes out of order or fails', async () => {
    const f = fixture();
    const a = deferred();
    const b = deferred();
    f.request.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first = f.service.search(input);
    const second = f.service.search({ ...input, query: '^B', useRegex: true });
    a.reject(new Error('old failure'));
    await first;
    expect(f.service.loading.value).toBe(true);
    expect(f.onFailure).not.toHaveBeenCalled();
    b.resolve(result('B'));
    await second;
    expect(
      new URL(f.request.mock.calls[1]![0], 'http://test.local').searchParams.get('regex')
    ).toBe('true');
    expect(f.service.appliedQuery.value).toBe('^B');
    expect(f.service.appliedUseRegex.value).toBe(true);
    const late = deferred();
    f.request.mockReturnValueOnce(late.promise).mockResolvedValueOnce(result('newest'));
    const old = f.service.search(input);
    await f.service.search({ ...input, query: 'newest' });
    late.resolve(result('old'));
    await old;
    expect(f.service.matches.value[0]?.preview).toBe('newest');
  });

  it('preserves accepted results on invalid responses or failures and reports only the current error', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce(result('accepted'));
    await f.service.search(input);
    f.request.mockResolvedValueOnce({
      search: { matches: [{ ...match, line: 0 }], truncated: false }
    });
    await f.service.search(input);
    expect(f.onFailure).toHaveBeenLastCalledWith(new Error('NODE_RESPONSE_INVALID'));
    expect(f.service.matches.value[0]?.preview).toBe('accepted');
    const failure = new Error('offline');
    f.request.mockRejectedValueOnce(failure);
    await f.service.search(input);
    expect(f.service.error.value).toBe(failure);
    expect(f.service.loading.value).toBe(false);
  });

  it('invalidates pending requests on reset, restore and disposal without replaying them', async () => {
    const f = fixture();
    const pending = deferred();
    f.request.mockReturnValue(pending.promise);
    const searching = f.service.search(input);
    f.service.restore({
      contentAppliedQuery: 'cached',
      contentAppliedUseRegex: true,
      contentMatches: [match, { ...match, column: 0 }],
      contentSearchTruncated: true
    });
    pending.resolve(result('late'));
    await searching;
    expect(f.service.appliedQuery.value).toBe('cached');
    expect(f.service.matches.value).toEqual([match]);
    expect(f.service.appliedUseRegex.value).toBe(true);
    expect(f.service.loading.value).toBe(false);
    f.service.reset();
    expect(f.service.matches.value).toEqual([]);
    expect(f.service.appliedQuery.value).toBe('');
    await f.service.search({ ...input, query: '' });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
});
