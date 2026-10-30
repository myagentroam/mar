import { ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createComposerReferenceService } from '../../src/service/composer-reference-service.js';
import type { ComposerReference } from '@myagentroam/protocol';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('Composer reference sources', () => {
  afterEach(() => vi.useRealTimers());

  it('selects session tags without inserting markup and deduplicates by typed identity', () => {
    const input = ref('before @alphaSuffix after');
    const service = createComposerReferenceService(input);
    const edit = vi.fn((start: number, end: number, text: string) => {
      input.value = input.value.slice(0, start) + text + input.value.slice(end);
      return true;
    });
    const select = (id: string) => {
      service.update(10);
      service.sessions.value = [{ id, customTitle: 'Alpha & <review>' }] as never;
      return service.selectCandidate(service.candidates.value[0]!, edit);
    };
    expect(select('s1')).toBe(true);
    expect(input.value).toBe('before  after');
    expect(service.selected.value).toEqual([
      { type: 'session', sessionId: 's1', label: 'Alpha & <review>' }
    ]);
    input.value = 'before @alphaSuffix after';
    expect(select('s1')).toBe(true);
    expect(service.selected.value).toHaveLength(1);
    input.value = 'before @alphaSuffix after';
    expect(select('s2')).toBe(true);
    expect(service.selected.value).toHaveLength(2);
    input.value = '@alpha';
    service.update(6);
    service.entries.value = [{ path: 's1', name: 's1', kind: 'FILE' }];
    expect(service.selectCandidate(service.candidates.value[0]!, edit)).toBe(true);
    service.remove('session:s1');
    expect(service.selected.value).toEqual([
      { type: 'session', sessionId: 's2', label: 'Alpha & <review>' },
      { type: 'file', path: 's1', label: 's1' }
    ]);
    service.remove('file:s1');
    expect(service.selected.value).toHaveLength(1);
  });

  it('keeps the trigger and selections when session selection fails or reaches the shared limit', () => {
    const input = ref('@alpha');
    const selected = ref<readonly ComposerReference[]>([
      { type: 'file', path: 'src/main.ts', label: 'main.ts' }
    ]);
    const service = createComposerReferenceService(input, undefined, selected);
    const candidate = () => {
      service.update(input.value.length);
      service.sessions.value = [{ id: 's1', customTitle: 'Alpha' }] as never;
      return service.candidates.value[0]!;
    };
    expect(service.selectCandidate(candidate(), () => false)).toBe(false);
    expect(input.value).toBe('@alpha');
    expect(selected.value).toHaveLength(1);
    selected.value = Array.from({ length: 128 }, (_, index) => ({
      type: 'file',
      path: `f${index}`,
      label: `f${index}`
    }));
    const edit = vi.fn(() => true);
    expect(service.selectCandidate(candidate(), edit)).toBe(false);
    expect(edit).not.toHaveBeenCalled();
    expect(service.open.value).toBe(true);
    expect(selected.value).toHaveLength(128);
  });

  it('without a session source keeps @session as a file query and never requests the session directory', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (_path: string) => ({ files: { entries: [] } }));
    const service = createComposerReferenceService(ref('@session'), {
      nodeId: ref('node'),
      workspaceId: ref('workspace'),
      ready: () => true,
      request: request as never
    });
    service.update(8);
    service.scheduleSearch();
    await vi.advanceTimersByTimeAsync(120);
    expect(service.match.value?.sessionOnly).toBe(false);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toContain('/files/search?');
    expect(request.mock.calls[0]![0]).toContain('q=session');
  });

  it('queries registered main sessions independently when files are unavailable', async () => {
    vi.useFakeTimers();
    const input = ref('@');
    const request = vi.fn(async (_path: string) => ({
      sessions: [
        { id: 'current', runner: 'codex', runnerTitle: 'Current' },
        { id: 'other', runner: 'mar-agent', runnerTitle: 'Target' }
      ],
      nextCursor: 'next'
    }));
    const service = createComposerReferenceService(input, {
      nodeId: ref('node'),
      workspaceId: ref('workspace'),
      ready: () => false,
      request: request as never,
      sessions: { ready: () => true, currentSessionId: ref('current') }
    });
    service.update(1);
    service.scheduleSearch();
    await vi.advanceTimersByTimeAsync(120);
    expect(request).toHaveBeenCalledOnce();
    const url = new URL(request.mock.calls[0]![0] as string, 'http://example.test');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      nodeId: 'node',
      workspaceId: 'workspace',
      registeredOnly: 'true',
      sessionGroup: 'MAIN',
      limit: '10'
    });
    expect(service.candidates.value.map((entry) => entry.key)).toEqual(['session:other']);
    expect(service.sessionMore.value).toBe(true);
  });

  it('invalidates old candidates immediately and does not select after an edit failure', async () => {
    vi.useFakeTimers();
    const input = ref('@a');
    const service = createComposerReferenceService(input, {
      nodeId: ref('node'),
      workspaceId: ref('workspace'),
      ready: () => true,
      request: vi.fn(async () => ({
        files: { entries: [{ path: 'a', name: 'a', kind: 'FILE' }] }
      })) as never
    });
    service.update(2);
    service.scheduleSearch();
    await vi.advanceTimersByTimeAsync(120);
    const candidate = service.candidates.value[0]!;
    expect(service.selectCandidate(candidate, () => false)).toBe(false);
    expect(service.selected.value).toEqual([]);
    expect(service.open.value).toBe(true);
    input.value = '@b';
    service.update(2);
    service.scheduleSearch();
    expect(service.candidates.value).toEqual([]);
    expect(service.selectCandidate(candidate, () => true)).toBe(false);
  });

  it('keeps explicit session queries session-only while typing without a source filter', async () => {
    vi.useFakeTimers();
    const input = ref('@session fo');
    const request = vi.fn(async (path: string) =>
      path.startsWith('/api/agent-sessions?')
        ? { sessions: [], nextCursor: null }
        : { files: { entries: [], nextCursor: null } }
    );
    const service = createComposerReferenceService(input, {
      nodeId: ref('node'),
      workspaceId: ref('workspace'),
      ready: () => true,
      request: request as never,
      sessions: { ready: () => true, currentSessionId: ref('current') }
    });
    service.update(input.value.length);
    service.scheduleSearch();
    await vi.advanceTimersByTimeAsync(120);
    request.mockClear();
    input.value = '@session foo';
    service.update(input.value.length);
    service.scheduleSearch();
    await vi.advanceTimersByTimeAsync(120);
    expect(service.match.value?.sessionOnly).toBe(true);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toContain('/api/agent-sessions?');
  });

  it.each([false, true])(
    'prioritizes late session matches without stealing an explicit file selection: selected=%s',
    async (selected) => {
      vi.useFakeTimers();
      const sessions = deferred<unknown>();
      const service = createComposerReferenceService(ref('@alpha'), {
        nodeId: ref('node'),
        workspaceId: ref('workspace'),
        ready: () => true,
        sessions: { ready: () => true, currentSessionId: ref('current') },
        request: ((path: string) =>
          path.includes('/files/search')
            ? Promise.resolve({
                files: { entries: [{ path: 'alpha', name: 'alpha', kind: 'FILE' }] }
              })
            : sessions.promise) as never
      });
      service.update(6);
      service.scheduleSearch();
      await vi.advanceTimersByTimeAsync(120);
      expect(service.candidates.value.map((entry) => entry.key)).toEqual(['file:alpha']);
      if (selected) service.activeIndex.value = 0;
      sessions.resolve({
        sessions: [{ id: 'one', runner: 'codex', customTitle: 'Alpha session' }],
        nextCursor: null
      });
      await vi.waitFor(() => expect(service.candidates.value).toHaveLength(2));
      expect(service.candidates.value.map((entry) => entry.key)).toEqual([
        'session:one',
        'file:alpha'
      ]);
      expect(service.candidates.value[service.activeIndex.value]!.key).toBe(
        selected ? 'file:alpha' : 'session:one'
      );
    }
  );

  it('preserves the selected session when the file source arrives later', async () => {
    vi.useFakeTimers();
    const files = deferred<unknown>();
    const sessions = deferred<unknown>();
    const service = createComposerReferenceService(ref('@alpha'), {
      nodeId: ref('node'),
      workspaceId: ref('workspace'),
      ready: () => true,
      sessions: { ready: () => true, currentSessionId: ref('current') },
      request: ((path: string) =>
        path.includes('/files/search') ? files.promise : sessions.promise) as never
    });
    service.update(6);
    service.scheduleSearch();
    await vi.advanceTimersByTimeAsync(120);
    sessions.resolve({
      sessions: [
        { id: 'one', runner: 'codex', customTitle: 'One' },
        { id: 'two', runner: 'mar-agent', customTitle: 'Two' }
      ],
      nextCursor: null
    });
    await vi.waitFor(() => expect(service.candidates.value).toHaveLength(2));
    service.activeIndex.value = 1;
    files.resolve({
      files: { entries: [{ path: 'alpha', name: 'alpha', kind: 'FILE' }], nextCursor: null }
    });
    await vi.waitFor(() => expect(service.candidates.value).toHaveLength(3));
    expect(service.activeIndex.value).toBe(1);
    expect(service.candidates.value[service.activeIndex.value]!.key).toBe('session:two');
  });

  it('isolates source failures and rejects responses after session or workspace changes', async () => {
    vi.useFakeTimers();
    const files = deferred<unknown>();
    const sessions = deferred<unknown>();
    const workspace = ref('workspace');
    const current = ref('current');
    let fileResult = files;
    let sessionResult = sessions;
    const service = createComposerReferenceService(ref('@alpha'), {
      nodeId: ref('node'),
      workspaceId: workspace,
      ready: () => true,
      sessions: { ready: () => true, currentSessionId: current },
      request: ((path: string) =>
        path.includes('/files/search') ? fileResult.promise : sessionResult.promise) as never
    });
    service.update(6);
    service.scheduleSearch();
    await vi.advanceTimersByTimeAsync(120);
    sessions.resolve({
      sessions: [{ id: 'other', runner: 'codex', customTitle: 'Other' }],
      nextCursor: null
    });
    files.reject(new Error('file unavailable'));
    await vi.waitFor(() => expect(service.fileError.value).toBe(true));
    expect(service.candidates.value.map((entry) => entry.key)).toEqual(['session:other']);

    fileResult = deferred<unknown>();
    sessionResult = deferred<unknown>();
    service.close();
    service.update(6);
    service.scheduleSearch();
    await vi.advanceTimersByTimeAsync(120);
    workspace.value = 'other-workspace';
    fileResult.resolve({ files: { entries: [{ path: 'stale', name: 'stale', kind: 'FILE' }] } });
    sessionResult.resolve({ sessions: [{ id: 'stale', runner: 'codex' }], nextCursor: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(service.open.value).toBe(false);
    expect(service.candidates.value).toEqual([]);

    fileResult = deferred<unknown>();
    sessionResult = deferred<unknown>();
    service.update(6);
    service.scheduleSearch();
    await vi.advanceTimersByTimeAsync(120);
    current.value = 'different';
    fileResult.resolve({ files: { entries: [{ path: 'stale', name: 'stale', kind: 'FILE' }] } });
    sessionResult.resolve({ sessions: [{ id: 'stale', runner: 'codex' }], nextCursor: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(service.open.value).toBe(false);
    expect(service.candidates.value).toEqual([]);
  });
  it('does not remove a new file trigger at the limit, while an existing reference remains deduplicated', () => {
    const input = ref('@new');
    const selected = ref(
      Array.from({ length: 128 }, (_, index) => ({
        type: 'file' as const,
        path: `f${index}`,
        label: `f${index}`
      }))
    );
    const service = createComposerReferenceService(input, undefined, selected);
    const edit = vi.fn((start: number, end: number, text: string) => {
      input.value = input.value.slice(0, start) + text + input.value.slice(end);
      return true;
    });
    service.update(4);
    service.entries.value = [{ path: 'new', name: 'new', kind: 'FILE' }];
    expect(service.selectCandidate(service.candidates.value[0]!, edit)).toBe(false);
    expect(input.value).toBe('@new');
    expect(service.open.value).toBe(true);
    expect(edit).not.toHaveBeenCalled();
    service.entries.value = [{ path: 'f0', name: 'f0', kind: 'FILE' }];
    expect(service.selectCandidate(service.candidates.value[0]!, edit)).toBe(true);
    expect(input.value).toBe('');
    expect(selected.value).toHaveLength(128);
  });
});
