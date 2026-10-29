import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fileReferenceAtCursor,
  insertFileReference
} from '../../src/service/file-reference-service.js';
import { createComposerReferenceService } from '../../src/service/composer-reference-service.js';

describe('Web Composer File Reference', () => {
  afterEach(() => vi.useRealTimers());
  it('Recognize only @ queries at the beginning or after whitespace', () => {
    expect(fileReferenceAtCursor('@src/app', 8)).toMatchObject({ query: 'src/app', start: 0 });
    expect(fileReferenceAtCursor('View @src/app', 13)).toMatchObject({
      query: 'src/app',
      start: 5
    });
    expect(fileReferenceAtCursor('mail@example.com', 16)).toBeUndefined();
  });

  it('Replace the query at the cursor and quote paths that contain spaces', () => {
    expect(insertFileReference('See @src/ap follow-up', 11, 'src/App.vue')).toEqual({
      value: 'See @src/App.vue follow-up',
      cursor: 16
    });
    expect(insertFileReference('@my', 3, 'docs/my file.md')).toEqual({
      value: '@"docs/my file.md" ',
      cursor: 19
    });
    expect(insertFileReference('@quo', 4, 'docs/a "quote".md')).toEqual({
      value: '@"docs/a \\"quote\\".md" ',
      cursor: 23
    });
  });

  it('Do not reset keyboard selection for duplicate cursor events on the same query', () => {
    const input = { value: '@app' } as never;
    const state = createComposerReferenceService(input);
    state.update(4);
    state.activeIndex.value = 2;
    state.update(4);
    expect(state.activeIndex.value).toBe(2);
  });

  it('Debounce file searches and ignore late results after switching Workspaces', async () => {
    vi.useFakeTimers();
    const input = { value: '@app' } as never;
    const nodeId = { value: 'node-1' };
    const workspaceId = { value: 'workspace-1' };
    let resolveSearch: ((value: unknown) => void) | undefined;
    const request = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        })
    );
    const service = createComposerReferenceService(input, {
      nodeId: nodeId as never,
      workspaceId: workspaceId as never,
      ready: () => true,
      request: request as never
    });
    service.update(4);
    service.scheduleSearch();
    await vi.advanceTimersByTimeAsync(120);
    expect(request).toHaveBeenCalledOnce();

    workspaceId.value = 'workspace-2';
    resolveSearch?.({ files: { entries: [{ path: 'App.vue', name: 'App.vue', kind: 'FILE' }] } });
    await Promise.resolve();
    expect(service.entries.value).toEqual([]);
  });

  it('Keep search results for files and folders and select a folder reference token', async () => {
    vi.useFakeTimers();
    const input = { value: '@src' };
    const service = createComposerReferenceService(input as never, {
      nodeId: { value: 'node-1' } as never,
      workspaceId: { value: 'workspace-1' } as never,
      ready: () => true,
      request: vi.fn(async () => ({
        files: {
          entries: [
            { path: 'src/App.vue', name: 'App.vue', kind: 'FILE' },
            { path: 'src/components', name: 'components', kind: 'DIRECTORY' }
          ]
        }
      })) as never
    });

    service.update(4);
    service.scheduleSearch();
    await vi.advanceTimersByTimeAsync(120);
    expect(service.entries.value.map((entry) => entry.kind)).toEqual(['FILE', 'DIRECTORY']);

    service.selectCandidate(service.candidates.value[1]!, (start, end, text) => {
      input.value = input.value.slice(0, start) + text + input.value.slice(end);
      return true;
    });
    expect(input.value).toBe('');
    expect(service.selected.value).toEqual([
      { type: 'directory', path: 'src/components', label: 'components' }
    ]);
  });
});
