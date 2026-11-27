import { createFileAccessFixture } from '../support/file-access-fixture.js';
import type { WorkspaceFilePreviewTransfers } from '../support/file-access-fixture.js';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceFilePreviewTarget } from '../../src/model/workspace-file-preview.js';
import type { ScopedHttpService } from '../../src/service/scoped-http-service.js';
import type { WorkspaceDirectFileRange } from '../../src/model/workspace-direct-file.js';
import { createWorkspaceFilePreviewService } from '../../src/service/workspace-file-preview-service.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function contentRevision(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

function directRange(
  content: string,
  size = new TextEncoder().encode(content).byteLength,
  nextOffset: number | null = null,
  revision = 'direct-revision'
): WorkspaceDirectFileRange {
  return {
    revision,
    size,
    offset: 0,
    bytes: new TextEncoder().encode(content),
    nextOffset
  };
}

const defaultTarget: WorkspaceFilePreviewTarget = {
  nodeId: 'node-1',
  workspaceId: 'workspace-1',
  path: 'notes.txt'
};

function fileTarget(
  overrides: Partial<WorkspaceFilePreviewTarget> = {}
): WorkspaceFilePreviewTarget {
  return { ...defaultTarget, ...overrides };
}

function createHarness(
  options: {
    readonly transfers?: WorkspaceFilePreviewTransfers;
    readonly request?: (path: string, init?: RequestInit) => Promise<unknown>;
    readonly fetchContent?: typeof fetch;
    readonly onWritten?: (target: WorkspaceFilePreviewTarget) => void;
  } = {}
) {
  const request = vi.fn(
    options.request ??
      (async () => {
        throw new Error('Unexpected HTTP request');
      })
  );
  const http: ScopedHttpService = {
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      return (await request(path, init)) as T;
    }
  };
  const fetchContent =
    options.fetchContent ??
    vi.fn(
      async () =>
        new Response('historic', {
          status: 206,
          headers: { 'content-range': 'bytes 0-7/8' }
        })
    );
  const onWritten = options.onWritten ?? vi.fn<(target: WorkspaceFilePreviewTarget) => void>();
  const preview = createWorkspaceFilePreviewService({
    access: createFileAccessFixture({
      http,
      transfers: () => ({
        readPreviewRange: async () => directRange('preview text'),
        ...options.transfers
      }),
      fetchContent
    }),
    onWritten
  });
  return { preview, request, fetchContent, onWritten };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Workspace file preview service', () => {
  it.each([defaultTarget.path, 'mar-attachment://00000000-0000-4000-8000-000000000001/notes.txt'])(
    'keeps one stream snapshot and does not retry a failed range over HTTP (%s)',
    async (path) => {
      const failure = new Error('DIRECT_FILE_REVISION_CHANGED');
      const readPreviewRange = vi
        .fn<NonNullable<WorkspaceFilePreviewTransfers['readPreviewRange']>>()
        .mockResolvedValueOnce(directRange('first', 100, 5, 'snapshot'))
        .mockRejectedValueOnce(failure);
      const { preview, request, fetchContent } = createHarness({ transfers: { readPreviewRange } });
      const page = preview.page(1);
      await preview.open(1, fileTarget({ path }));
      expect(readPreviewRange).toHaveBeenCalledTimes(2);
      expect(readPreviewRange.mock.calls[0]?.[2]).toBeUndefined();
      expect(readPreviewRange.mock.calls[1]?.[2]).toEqual({ revision: 'snapshot', size: 100 });
      expect(page.error.value).toBe(failure);
      expect(page.fileContent.value?.content).toBe('');
      expect(request).not.toHaveBeenCalled();
      expect(fetchContent).not.toHaveBeenCalled();
    }
  );
  it('keeps read failures on their file page and clears them when retrying', async () => {
    const failure = new Error('File was not found.');
    const retry = deferred<WorkspaceDirectFileRange>();
    const readPreviewRange = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockReturnValueOnce(retry.promise);
    const { preview } = createHarness({ transfers: { readPreviewRange } });
    const page = preview.page(1);

    await preview.open(1, defaultTarget);
    expect(page.error.value).toBe(failure);
    expect(page.loading.value).toBe(false);
    expect(preview.page(2).error.value).toBeUndefined();

    const opening = preview.open(1, defaultTarget);
    expect(page.error.value).toBeUndefined();
    expect(page.loading.value).toBe(true);
    retry.resolve(directRange('Recovered content'));
    await opening;
    expect(page.fileContent.value?.content).toBe('Recovered content');
    expect(page.error.value).toBeUndefined();
    expect(page.loading.value).toBe(false);
  });

  it('cancels an in-flight stream read when its tab closes', async () => {
    const pending = deferred<WorkspaceDirectFileRange>();
    const readPreviewRange = vi.fn<NonNullable<WorkspaceFilePreviewTransfers['readPreviewRange']>>(
      () => pending.promise
    );
    const { preview } = createHarness({ transfers: { readPreviewRange } });
    const opening = preview.open(1, defaultTarget);
    const signal = readPreviewRange.mock.calls[0]?.[3];
    expect(signal).toBeInstanceOf(AbortSignal);
    preview.close(1);
    expect(signal?.aborted).toBe(true);
    pending.resolve(directRange('late'));
    await opening;
    expect(preview.page(1).error.value).toBeUndefined();
  });

  it('cancels the previous direct range when opening a new target in the tab', async () => {
    const pending = deferred<WorkspaceDirectFileRange>();
    const readPreviewRange = vi
      .fn<NonNullable<WorkspaceFilePreviewTransfers['readPreviewRange']>>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(directRange('next'));
    const { preview } = createHarness({ transfers: { readPreviewRange } });
    const opening = preview.open(1, defaultTarget);
    const signal = readPreviewRange.mock.calls[0]?.[3];
    expect(signal).toBeInstanceOf(AbortSignal);
    const next = preview.open(1, fileTarget({ path: 'next.txt' }));
    expect(signal?.aborted).toBe(true);
    pending.resolve(directRange('late'));
    await Promise.all([opening, next]);
    expect(preview.page(1).fileContent.value?.path).toBe('next.txt');
  });

  it('reads ordinary text through one bounded direct probe', async () => {
    const content = 'Hello, preview.';
    const readPreviewRange = vi.fn(async () => directRange(content));
    const { preview, request } = createHarness({ transfers: { readPreviewRange } });

    await preview.open(1, defaultTarget);

    expect(preview.page(1).fileContent.value).toMatchObject({
      path: 'notes.txt',
      content,
      size: new TextEncoder().encode(content).byteLength,
      encoding: 'utf-8',
      truncated: false,
      revision: createHash('sha256').update(content).digest('hex')
    });
    expect(readPreviewRange).toHaveBeenCalledExactlyOnceWith(
      defaultTarget,
      4096,
      undefined,
      expect.any(AbortSignal)
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps an empty text file readable with its empty-content revision', async () => {
    const readPreviewRange = vi.fn(async () => directRange(''));
    const { preview } = createHarness({ transfers: { readPreviewRange } });

    await preview.open(1, defaultTarget);

    expect(preview.page(1).fileContent.value).toMatchObject({
      path: 'notes.txt',
      content: '',
      size: 0,
      encoding: 'utf-8',
      truncated: false,
      revision: createHash('sha256').update('').digest('hex')
    });
    expect(readPreviewRange).toHaveBeenCalledExactlyOnceWith(
      defaultTarget,
      4096,
      undefined,
      expect.any(AbortSignal)
    );
  });

  it('limits a large text preview to the probe and configured preview ranges', async () => {
    const previewBytes = new Uint8Array(512 * 1024).fill('x'.charCodeAt(0));
    const readPreviewRange = vi.fn<NonNullable<WorkspaceFilePreviewTransfers['readPreviewRange']>>(
      async (_target, length) =>
        length === 4096
          ? directRange('x'.repeat(4096), 900_000, 4096, 'large-file-revision')
          : {
              revision: 'large-file-revision',
              size: 900_000,
              offset: 0,
              bytes: previewBytes,
              nextOffset: 512 * 1024
            }
    );
    const { preview } = createHarness({ transfers: { readPreviewRange } });

    await preview.open(1, defaultTarget);

    expect(readPreviewRange.mock.calls.map((call) => call[1])).toEqual([4096, 512 * 1024]);
    expect(preview.page(1).fileContent.value).toMatchObject({
      size: 900_000,
      encoding: 'utf-8',
      truncated: true
    });
    expect(preview.page(1).fileContent.value?.content).toHaveLength(512 * 1024);
  });

  it('refuses writes to repository, worktree, history, and attachment resources', async () => {
    const attachmentPath = 'mar-attachment://00000000-0000-0000-0000-000000000000/note.txt';
    const targets: readonly WorkspaceFilePreviewTarget[] = [
      fileTarget({ repositoryPath: 'repo/root' }),
      fileTarget({ worktreePath: 'repo/worktree' }),
      fileTarget({
        history: { commit: 'commit-1', repositoryPath: 'repo/root', refs: ['main'] }
      }),
      fileTarget({ path: attachmentPath })
    ];
    const { preview, request } = createHarness();

    for (const [index, target] of targets.entries()) {
      await preview.open(index + 1, target);
      await expect(preview.save(index + 1, 'edited', 'expected-revision')).rejects.toThrow(
        'FILE_WRITE_INVALID'
      );
    }

    expect(request.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  });

  it('captures the write target, content, and expected revision and accepts the saved identity', async () => {
    const target = fileTarget({ workspaceId: 'workspace one', path: 'docs/edit.txt' });
    const { preview, request, onWritten } = createHarness({
      transfers: { readPreviewRange: async () => directRange('before') },
      request: async () => ({ file: { revision: 'revision-after-save', size: 8 } })
    });
    await preview.open(1, target);

    await expect(preview.save(1, 'after λ', contentRevision('before'))).resolves.toBe(
      'revision-after-save'
    );

    const [writePath, writeInit] = request.mock.calls[0]!;
    expect(writePath).toBe('/api/workspaces/workspace%20one/files/write');
    expect(writeInit?.method).toBe('PUT');
    expect(JSON.parse(String(writeInit?.body))).toEqual({
      nodeId: 'node-1',
      path: 'docs/edit.txt',
      content: 'after λ',
      expectedRevision: contentRevision('before')
    });
    expect(preview.page(1).fileContent.value).toMatchObject({
      path: 'docs/edit.txt',
      content: 'after λ',
      revision: 'revision-after-save',
      size: 8
    });
    expect(onWritten).toHaveBeenCalledExactlyOnceWith(preview.page(1).target.value);
  });

  it('preserves the original text when the revision-checked write conflicts', async () => {
    const conflict = new Error('FILE_WRITE_CONFLICT');
    const { preview } = createHarness({
      transfers: { readPreviewRange: async () => directRange('original text') },
      request: async () => {
        throw conflict;
      }
    });
    await preview.open(1, defaultTarget);
    const original = preview.page(1).fileContent.value;

    await expect(preview.save(1, 'replacement text', 'stale-revision')).rejects.toBe(conflict);

    expect(preview.page(1).fileContent.value).toBe(original);
    expect(preview.page(1).fileContent.value).toMatchObject({
      content: 'original text',
      revision: contentRevision('original text')
    });
  });

  it('does not let a late write replace a reloaded, replaced, or reopened page', async () => {
    const writeRequests = [deferred<unknown>(), deferred<unknown>(), deferred<unknown>()];
    const readContents = [
      'before reload',
      'before replacement',
      'before close',
      'reload wins',
      'replacement wins',
      'reopened after close'
    ];
    let readIndex = 0;
    let writeIndex = 0;
    const { preview, onWritten } = createHarness({
      transfers: { readPreviewRange: async () => directRange(readContents[readIndex++]!) },
      request: () => writeRequests[writeIndex++]!.promise
    });
    const originalTargets = [
      fileTarget({ path: 'reload.txt' }),
      fileTarget({ path: 'replace.txt' }),
      fileTarget({ path: 'close.txt' })
    ];

    for (const [index, target] of originalTargets.entries()) {
      await preview.open(index + 1, target);
    }
    const saves = [
      preview.save(1, 'late reload write', contentRevision(readContents[0]!)),
      preview.save(2, 'late replacement write', contentRevision(readContents[1]!)),
      preview.save(3, 'late closed write', contentRevision(readContents[2]!))
    ];

    await preview.open(1, originalTargets[0]!);
    await preview.open(2, fileTarget({ path: 'new-target.txt' }));
    preview.close(3);
    await preview.open(3, fileTarget({ path: 'reopened.txt' }));

    writeRequests[0]!.resolve({ file: { revision: 'saved-reload', size: 17 } });
    writeRequests[1]!.resolve({ file: { revision: 'saved-replacement', size: 23 } });
    writeRequests[2]!.resolve({ file: { revision: 'saved-closed', size: 16 } });
    await Promise.all(saves);

    expect(preview.page(1).fileContent.value).toMatchObject({
      path: 'reload.txt',
      content: 'reload wins',
      revision: contentRevision(readContents[3]!)
    });
    expect(preview.page(2).fileContent.value).toMatchObject({
      path: 'new-target.txt',
      content: 'replacement wins',
      revision: contentRevision(readContents[4]!)
    });
    expect(preview.page(3).fileContent.value).toMatchObject({
      path: 'reopened.txt',
      content: 'reopened after close',
      revision: contentRevision(readContents[5]!)
    });
    expect(onWritten).toHaveBeenCalledTimes(3);
  });

  it('keeps a successful write successful when its refresh callback throws', async () => {
    const { preview } = createHarness({
      transfers: { readPreviewRange: async () => directRange('before') },
      request: async () => ({ file: { revision: 'revision-after-save', size: 7 } }),
      onWritten: () => {
        throw new Error('REFRESH_FAILED');
      }
    });
    await preview.open(1, defaultTarget);

    await expect(preview.save(1, 'after', contentRevision('before'))).resolves.toBe(
      'revision-after-save'
    );
    expect(preview.page(1).fileContent.value).toMatchObject({
      content: 'after',
      revision: 'revision-after-save',
      size: 7
    });
  });

  it('surfaces a failed expanded stream read without switching resources or retrying over HTTP', async () => {
    const target = fileTarget({
      path: 'src/file.txt',
      repositoryPath: 'repo/root',
      worktreePath: 'repo/worktree'
    });
    const failure = new Error('DIRECT_FILE_READ_FAILED');
    const readPreviewRange = vi
      .fn<NonNullable<WorkspaceFilePreviewTransfers['readPreviewRange']>>()
      .mockResolvedValueOnce(directRange('p'.repeat(4096), 9000, 4096, 'stream-revision'))
      .mockRejectedValueOnce(failure);
    const { preview, request, fetchContent } = createHarness({ transfers: { readPreviewRange } });

    await preview.open(1, target);

    const signal = expect.any(AbortSignal);
    expect(readPreviewRange.mock.calls).toEqual([
      [target, 4096, undefined, signal],
      [target, 512 * 1024, { revision: 'stream-revision', size: 9000 }, signal]
    ]);
    expect(preview.page(1).error.value).toBe(failure);
    expect(preview.page(1).fileContent.value?.content).toBe('');
    expect(request).not.toHaveBeenCalled();
    expect(fetchContent).not.toHaveBeenCalled();
  });

  it('pins history read identity and refs before fetching the selected revision', async () => {
    const refs = ['main', 'release/1'];
    const historyTarget = fileTarget({
      path: 'docs/guide.txt',
      history: { commit: 'commit/42', repositoryPath: 'repo root', refs }
    });
    const readPreviewRange = vi.fn(async () => directRange('historic'));
    const { preview, request, fetchContent } = createHarness({ transfers: { readPreviewRange } });
    const opening = preview.open(1, historyTarget);
    refs.splice(0, refs.length, 'changed-after-open');

    await opening;

    expect(readPreviewRange).toHaveBeenCalledExactlyOnceWith(
      { ...historyTarget, history: { ...historyTarget.history, refs: ['main', 'release/1'] } },
      4096,
      undefined,
      expect.any(AbortSignal)
    );
    expect(request).not.toHaveBeenCalled();
    expect(fetchContent).not.toHaveBeenCalled();
    expect(preview.page(1).fileContent.value).toMatchObject({
      path: 'docs/guide.txt',
      content: 'historic',
      size: 8
    });
  });

  it.each(['media/demo.mp4', 'image.png', 'image.jpg', 'image.svg'])(
    'keeps %s on its specialized content URL',
    async (path) => {
      const target = fileTarget({ path });
      const readPreviewObject = vi.fn();
      const { preview, request, fetchContent } = createHarness({
        transfers: { readPreviewObject }
      });

      await preview.open(1, target);

      const contentUrl = preview.page(1).contentUrl.value;
      expect(contentUrl).toContain('/api/workspaces/workspace-1/files/content?');
      expect(new URL(contentUrl!, 'http://workspace.test').searchParams.get('path')).toBe(path);
      expect(readPreviewObject).not.toHaveBeenCalled();
      expect(fetchContent).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    }
  );

  it.each(['image.png', 'image.svg', 'media/clip.mp4', 'media/song.mp3'])(
    'keeps the Git preview and size probe for %s on HTTP even when ICE is ready',
    async (path) => {
      const readPreviewRange = vi.fn();
      const readPreviewObject = vi.fn();
      const fetchContent = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(null, { status: 206, headers: { 'content-range': 'bytes 0-0/1024' } })
        );
      const { preview } = createHarness({
        transfers: { readPreviewRange, readPreviewObject },
        fetchContent
      });
      const history = { commit: 'a'.repeat(40), repositoryPath: '', refs: ['main'] };

      await preview.open(1, fileTarget({ path, history }));

      const { contentUrl, fileContent } = preview.page(1);
      expect(contentUrl.value).toContain(`/git/commits/${history.commit}/files/content?`);
      expect(fileContent.value?.size).toBe(1024);
      expect(fetchContent).toHaveBeenCalledExactlyOnceWith(
        contentUrl.value,
        expect.objectContaining({ method: 'HEAD', headers: { range: 'bytes=0-0' } })
      );
      expect(readPreviewRange).not.toHaveBeenCalled();
      expect(readPreviewObject).not.toHaveBeenCalled();
    }
  );

  it('leaves a known binary Git file without a viewer downloadable without reading its body', async () => {
    const readPreviewRange = vi.fn();
    const readPreviewObject = vi.fn();
    const { preview, request, fetchContent } = createHarness({
      transfers: { readPreviewRange, readPreviewObject }
    });
    const target = fileTarget({
      path: 'archive.zip',
      history: { commit: 'a'.repeat(40), repositoryPath: '', refs: ['main'] }
    });
    await preview.open(1, target, { textPreview: false });
    expect(preview.page(1).fileContent.value).toMatchObject({
      path: target.path,
      encoding: 'base64'
    });
    expect(preview.page(1).contentUrl.value).toBeUndefined();
    expect(readPreviewRange).not.toHaveBeenCalled();
    expect(readPreviewObject).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(fetchContent).not.toHaveBeenCalled();
  });

  it('keeps Git media playable without using the range length as the file size', async () => {
    const fetchContent = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 206, headers: { 'content-length': '1' } }));
    const { preview } = createHarness({ fetchContent });
    const history = { commit: 'a'.repeat(40), repositoryPath: '', refs: ['main'] };

    await preview.open(1, fileTarget({ path: 'media/clip.mp4', history }));

    expect(preview.page(1).contentUrl.value).toContain(
      `/git/commits/${history.commit}/files/content?`
    );
    expect(preview.page(1).fileContent.value?.size).toBeUndefined();
    expect(preview.page(1).error.value).toBeUndefined();
  });

  it('keeps metadata and no content URL for an oversized binary preview', async () => {
    const readPreviewObject = vi.fn().mockResolvedValue({ size: 25_000_000, revision: 'r' });
    const { preview, fetchContent } = createHarness({ transfers: { readPreviewObject } });

    await preview.open(1, fileTarget({ path: 'large.pdf' }));

    expect(preview.page(1).fileContent.value).toMatchObject({ size: 25_000_000, content: '' });
    expect(preview.page(1).contentUrl.value).toBeUndefined();
    expect(preview.page(1).error.value).toBeUndefined();
    expect(fetchContent).not.toHaveBeenCalled();
  });

  it('downloads through the file service even when a preview object URL exists', async () => {
    const readPreviewObject = vi.fn().mockResolvedValue({ url: 'blob:preview', size: 4 });
    const directFileDownload = vi.fn().mockResolvedValue('COMPLETED');
    const { preview } = createHarness({ transfers: { readPreviewObject, directFileDownload } });

    await preview.open(1, fileTarget({ path: 'report.pdf' }));
    expect(preview.page(1).contentUrl.value).toBe('blob:preview');
    await preview.download(1);

    expect(directFileDownload).toHaveBeenCalledExactlyOnceWith('report.pdf', undefined, undefined);
    expect(preview.page(1).contentUrl.value).toBe('blob:preview');
  });

  it('releases blob previews on replacement, late resolution, and close', async () => {
    const object = (url: string) => ({ url, size: 4, revision: 'r' });
    const pendingReplacement = deferred<ReturnType<typeof object>>();
    const readPreviewObject = vi
      .fn<NonNullable<WorkspaceFilePreviewTransfers['readPreviewObject']>>()
      .mockResolvedValueOnce(object('blob:first'))
      .mockImplementationOnce(() => pendingReplacement.promise)
      .mockResolvedValueOnce(object('blob:latest'));
    const { preview } = createHarness({ transfers: { readPreviewObject } });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    await preview.open(1, fileTarget({ path: 'first.pdf' }));
    const replacing = preview.open(1, fileTarget({ path: 'second.pdf' }));
    const replacementSignal = readPreviewObject.mock.calls[1]?.[1];
    expect(replacementSignal).toBeInstanceOf(AbortSignal);
    expect(revoke).toHaveBeenCalledWith('blob:first');
    await preview.open(1, fileTarget({ path: 'third.pdf' }));
    expect(replacementSignal?.aborted).toBe(true);
    pendingReplacement.resolve(object('blob:stale'));
    await replacing;

    expect(revoke).toHaveBeenCalledWith('blob:stale');
    expect(preview.page(1).contentUrl.value).toBe('blob:latest');
    preview.close(1);
    expect(revoke).toHaveBeenCalledWith('blob:latest');
  });

  it('keeps the latest page when reads for replaced targets resolve out of order', async () => {
    const readA = deferred<WorkspaceDirectFileRange>();
    const readB = deferred<WorkspaceDirectFileRange>();
    let call = 0;
    const readPreviewRange = vi.fn(() => (call++ === 0 ? readA.promise : readB.promise));
    const { preview } = createHarness({ transfers: { readPreviewRange } });

    const openingA = preview.open(1, fileTarget({ path: 'a.txt' }));
    const openingB = preview.open(1, fileTarget({ path: 'b.txt' }));
    readB.resolve(directRange('content B'));
    await openingB;
    readA.resolve(directRange('content A'));
    await openingA;

    expect(preview.page(1).target.value?.path).toBe('b.txt');
    expect(preview.page(1).fileContent.value).toMatchObject({
      path: 'b.txt',
      content: 'content B'
    });
    expect(preview.page(1).loading.value).toBe(false);
    expect(preview.page(1).error.value).toBeUndefined();
  });

  it('isolates late successes and failures after reset and close', async () => {
    const resetSuccess = deferred<WorkspaceDirectFileRange>();
    const resetFailure = deferred<WorkspaceDirectFileRange>();
    const closeSuccess = deferred<WorkspaceDirectFileRange>();
    const closeFailure = deferred<WorkspaceDirectFileRange>();
    const pendingByPath = new Map([
      ['reset-stale-success.txt', resetSuccess],
      ['reset-stale-failure.txt', resetFailure],
      ['close-stale-success.txt', closeSuccess],
      ['close-stale-failure.txt', closeFailure]
    ]);
    const readPreviewRange = vi.fn<NonNullable<WorkspaceFilePreviewTransfers['readPreviewRange']>>(
      ({ path }) =>
        pendingByPath.get(path)?.promise ?? Promise.resolve(directRange(`fresh:${path}`))
    );
    const { preview } = createHarness({ transfers: { readPreviewRange } });

    const resetOldSuccess = preview.open(1, fileTarget({ path: 'reset-stale-success.txt' }));
    const resetOldFailure = preview.open(2, fileTarget({ path: 'reset-stale-failure.txt' }));
    preview.reset();
    await preview.open(1, fileTarget({ path: 'reset-current-success.txt' }));
    await preview.open(2, fileTarget({ path: 'reset-current-failure.txt' }));

    const closeOldSuccess = preview.open(3, fileTarget({ path: 'close-stale-success.txt' }));
    const closeOldFailure = preview.open(4, fileTarget({ path: 'close-stale-failure.txt' }));
    preview.close(3);
    preview.close(4);
    await preview.open(3, fileTarget({ path: 'close-current-success.txt' }));
    await preview.open(4, fileTarget({ path: 'close-current-failure.txt' }));

    resetSuccess.resolve(directRange('stale reset success'));
    resetFailure.reject(new Error('STALE_RESET_FAILURE'));
    closeSuccess.resolve(directRange('stale close success'));
    closeFailure.reject(new Error('STALE_CLOSE_FAILURE'));
    await Promise.all([resetOldSuccess, resetOldFailure, closeOldSuccess, closeOldFailure]);

    for (const id of [1, 2, 3, 4]) {
      const content = preview.page(id).target.value?.path;
      expect(preview.page(id).fileContent.value?.content).toBe(`fresh:${content}`);
      expect(preview.page(id).error.value).toBeUndefined();
    }
    expect(preview.page(1).error.value).toBeUndefined();
  });

  it('refuses writes while loading and settles loading when the page closes', async () => {
    const read = deferred<WorkspaceDirectFileRange>();
    const readPreviewRange = vi.fn(() => read.promise);
    const { preview, request } = createHarness({ transfers: { readPreviewRange } });
    const page = preview.page(7);
    const opening = preview.open(7, fileTarget());
    expect(page.loading.value).toBe(true);
    await expect(preview.save(7, 'edited', 'a'.repeat(64))).rejects.toThrow('FILE_WRITE_INVALID');
    preview.close(7);
    expect(page.loading.value).toBe(false);
    read.resolve(directRange('late result'));
    await opening;
    expect(page.loading.value).toBe(false);
    expect(readPreviewRange).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    expect(page.error.value).toBeUndefined();
  });

  it.each([
    { encoding: 'utf-8' as const, nextOffset: 8 },
    { encoding: 'base64' as const, nextOffset: null }
  ])(
    'keeps partial or binary previews read-only ($encoding, $nextOffset)',
    async ({ encoding, nextOffset }) => {
      const { preview, request } = createHarness({
        transfers: {
          readPreviewRange: async () =>
            encoding === 'utf-8'
              ? directRange('bounded', 9, nextOffset)
              : { ...directRange('', 3), bytes: Uint8Array.of(0, 1, 2) }
        }
      });
      await preview.open(8, fileTarget());
      await expect(preview.save(8, 'edited', 'a'.repeat(64))).rejects.toThrow('FILE_WRITE_INVALID');
      expect(request.mock.calls.every(([, init]) => init?.method !== 'PUT')).toBe(true);
    }
  );

  it('decodes legacy source in a read-only preview and refuses to save it', async () => {
    const bytes = Uint8Array.from([47, 47, 32, 0xd6, 0xd0, 0xce, 0xc4]);
    const { preview, request } = createHarness({
      transfers: { readPreviewRange: async () => ({ ...directRange('', bytes.length), bytes }) }
    });
    await preview.open(8, fileTarget({ path: 'DisplayBoard.c' }));
    expect(preview.page(8).fileContent.value).toMatchObject({
      encoding: 'utf-8',
      content: '// 中文',
      previewEncoding: 'gb18030'
    });
    await expect(preview.save(8, 'edited', 'a'.repeat(64))).rejects.toThrow('FILE_WRITE_INVALID');
    expect(request.mock.calls.every(([, init]) => init?.method !== 'PUT')).toBe(true);
  });

  it('uses the same legacy decoding for direct and Git history reads', async () => {
    const bytes = Uint8Array.from([47, 47, 32, 0xd6, 0xd0, 0xce, 0xc4]);
    const { preview, request, fetchContent } = createHarness({
      transfers: {
        readPreviewRange: async ({ history }) => ({
          offset: 0,
          bytes,
          revision: history === undefined ? 'legacy-revision' : 'history-revision',
          size: bytes.length,
          nextOffset: null
        })
      }
    });
    const target = fileTarget({ path: 'DisplayBoard.c' });
    await preview.open(1, target);
    await preview.open(2, {
      ...target,
      history: { commit: 'commit-1', repositoryPath: '.', refs: ['main'] }
    });
    for (const id of [1, 2]) {
      expect(preview.page(id).fileContent.value).toMatchObject({
        encoding: 'utf-8',
        content: '// 中文',
        previewEncoding: 'gb18030'
      });
      await expect(preview.save(id, 'edited', 'legacy-revision')).rejects.toThrow(
        'FILE_WRITE_INVALID'
      );
    }
    expect(request).not.toHaveBeenCalled();
    expect(fetchContent).not.toHaveBeenCalled();
  });

  it.each(['COMPLETED', 'CANCELLED'] as const)(
    'does not start an HTTP download when the file stream is %s',
    async (result) => {
      const directFileDownload = vi.fn(async () => result);
      const createElement = vi.fn();
      vi.stubGlobal('document', { createElement });
      const { preview } = createHarness({ transfers: { directFileDownload } });

      await preview.downloadTarget(fileTarget({ path: 'docs/guide.txt' }));

      expect(directFileDownload).toHaveBeenCalledExactlyOnceWith(
        'docs/guide.txt',
        undefined,
        undefined
      );
      expect(createElement).not.toHaveBeenCalled();
    }
  );

  it('preserves an explicit download failure without using the HTTP preview URL', async () => {
    const directFileDownload = vi.fn().mockRejectedValue(new Error('NODE_STREAM_DISCONNECTED'));
    const createElement = vi.fn();
    vi.stubGlobal('document', { createElement });
    const { preview, fetchContent } = createHarness({ transfers: { directFileDownload } });

    await expect(preview.downloadTarget(fileTarget())).rejects.toThrow('NODE_STREAM_DISCONNECTED');
    expect(createElement).not.toHaveBeenCalled();
    expect(fetchContent).not.toHaveBeenCalled();
  });
});
