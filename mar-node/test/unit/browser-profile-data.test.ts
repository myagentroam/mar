import type { Worker } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserProfileData } from '../../src/browser/browser-profile-data.js';
import { createBrowserProfileOperation } from '../../src/browser/browser-resource-operations.js';

const target = {
  id: '86f6d7d4-279f-4910-bc5a-191b3615a111',
  kind: 'live',
  persistent: true
} as const;
const query = { text: 'fixture', startTime: 0 };
const history = (url: string, lastVisitTime = 1) => ({ url, title: 'Fixture', lastVisitTime });
const pages = Array.from({ length: 10 }, (_, index) => history(`https://fixture.test/${index}`));

function fixture(entries: typeof pages) {
  const search = vi.fn(async ({ maxResults }: { maxResults: number }) =>
    entries.slice(0, maxResults)
  );
  vi.stubGlobal('chrome', { history: { search } });
  const evaluate = vi.fn(async (run: (arg: unknown) => unknown, arg: unknown) => run(arg));
  const worker = { evaluate } as unknown as Worker;
  const data = new BrowserProfileData(worker);
  const profile = createBrowserProfileOperation(
    {
      describeProfile: async () => target,
      useProfile: async (_scope, _target, run) => run(data)
    },
    () => {}
  );
  return {
    evaluate,
    search,
    profile: (command: unknown) =>
      profile({ workspaceId: 'workspace', __requestUserId: 1, command })
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Browser profile history suggestions', () => {
  it('advertises bounded suggestions and reads only six native matches in the common case', async () => {
    const { profile, search } = fixture(pages);
    await expect(profile({ action: 'describe' })).resolves.toEqual({
      profile: target,
      historySuggestions: true
    });
    await expect(
      profile({ action: 'history', target, input: { ...query, suggestions: true } })
    ).resolves.toMatchObject({
      items: pages.slice(0, 6).map(({ url }) => ({ url })),
      capped: true
    });
    expect(search.mock.calls).toEqual([[{ ...query, maxResults: 6 }]]);
  });

  it('fills suggestions past excluded matches without sending extra entries to Node', async () => {
    const { evaluate, profile, search } = fixture([
      history('file:///tmp/fixture.html'),
      history('http://fixture.mar-workspace-preview.invalid/'),
      history('https://user:secret@fixture.test/'),
      ...pages
    ]);
    const result = await profile({
      action: 'history',
      target,
      input: { ...query, suggestions: true }
    });
    expect(result).toMatchObject({ items: pages.slice(0, 6).map(({ url }) => ({ url })) });
    expect(evaluate).toHaveBeenCalledTimes(1);
    await expect(evaluate.mock.results[0]?.value).resolves.toEqual(result);
    expect(search.mock.calls.map(([options]) => options.maxResults)).toEqual([6, 1_000]);
  });

  it('does not expand an exhausted suggestions query', async () => {
    const { profile, search } = fixture(pages.slice(0, 2));
    await expect(
      profile({ action: 'history', target, input: { ...query, suggestions: true } })
    ).resolves.toMatchObject({
      items: pages.slice(0, 2).map(({ url }) => ({ url })),
      capped: false
    });
    expect(search.mock.calls).toEqual([[{ ...query, maxResults: 6 }]]);
  });

  it('makes at most two native queries even if all matches are excluded', async () => {
    const { profile, search } = fixture(Array(1_001).fill(history('file:///tmp/fixture.html')));
    await expect(
      profile({ action: 'history', target, input: { ...query, suggestions: true } })
    ).resolves.toEqual({ items: [], capped: true });
    expect(search.mock.calls.map(([options]) => options.maxResults)).toEqual([6, 1_000]);
  });

  it('keeps the ordinary history query and its date range unchanged', async () => {
    const { profile, search } = fixture(pages);
    await expect(
      profile({ action: 'history', target, input: { ...query, endTime: 10 } })
    ).resolves.toMatchObject({ items: pages.map(({ url }) => ({ url })), capped: false });
    expect(search.mock.calls).toEqual([[{ ...query, endTime: 10, maxResults: 1_000 }]]);
  });

  it('preserves the UTF-8 byte budget for ordinary history', async () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({
      ...history(`https://fixture.test/${String(i).padStart(2, '0')}/${'a'.repeat(6_999)}`),
      title: '界'.repeat(512)
    }));
    const { profile } = fixture(entries);
    await expect(profile({ action: 'history', target, input: query })).resolves.toEqual({
      items: entries
        .slice(0, 30)
        .map(({ url, title, lastVisitTime }) => ({ url, title, visitedAt: lastVisitTime })),
      capped: true
    });
  });
});
