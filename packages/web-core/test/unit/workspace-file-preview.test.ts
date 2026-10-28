import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceFilePreviewTransfers,
  WorkspaceFilePreviewTarget
} from '../../src/model/workspace-file-preview.js';
import type { ScopedHttpService } from '../../src/service/scoped-http-service.js';
import type { WorkspaceDirectFileRange } from '../../src/service/workspace-direct-file-read-service.js';
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

function textFile(content: string, revision = 'server-revision', size?: number) {
  return {
    file: {
      encoding: 'utf-8' as const,
      size: size ?? new TextEncoder().encode(content).byteLength,
      content,
      nextOffset: null,
      revision
    }
  };
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
  const request = vi.fn(options.request ?? (async () => textFile('server text')));
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
  const onFailure = vi.fn();
  const onWritten = options.onWritten ?? vi.fn<(target: WorkspaceFilePreviewTarget) => void>();
  const preview = createWorkspaceFilePreviewService({
    http,
    transfers: () => options.transfers ?? {},
    fetchContent,
    onFailure,
    onWritten
  });
  return { preview, request, fetchContent, onFailure, onWritten };
}

async function openServerText(
  preview: ReturnType<typeof createWorkspaceFilePreviewService>,
  id: number,
  target: WorkspaceFilePreviewTarget = defaultTarget
) {
  await preview.open(id, target, { serverOnly: true, textPreview: true });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Workspace file preview service', () => {
  it('reads ordinary text through one bounded direct probe', async () => {
    const content = 'Hello, preview.';
    const directFileReadRange = vi.fn(async () => directRange(content));
    const { preview, request } = createHarness({ transfers: { directFileReadRange } });

    await preview.open(1, defaultTarget);

    expect(preview.page(1).fileContent.value).toMatchObject({
      path: 'notes.txt',
      content,
      size: new TextEncoder().encode(content).byteLength,
      encoding: 'utf-8',
      truncated: false,
      revision: createHash('sha256').update(content).digest('hex')
    });
    expect(directFileReadRange).toHaveBeenCalledExactlyOnceWith(
      'notes.txt',
      0,
      4096,
      undefined,
      undefined,
      undefined
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps an empty text file readable with its empty-content revision', async () => {
    const directFileReadRange = vi.fn(async () => directRange(''));
    const { preview } = createHarness({ transfers: { directFileReadRange } });

    await preview.open(1, defaultTarget);

    expect(preview.page(1).fileContent.value).toMatchObject({
      path: 'notes.txt',
      content: '',
      size: 0,
      encoding: 'utf-8',
      truncated: false,
      revision: createHash('sha256').update('').digest('hex')
    });
    expect(directFileReadRange).toHaveBeenCalledExactlyOnceWith(
      'notes.txt',
      0,
      4096,
      undefined,
      undefined,
      undefined
    );
  });

  it('limits a large text preview to the probe and configured preview ranges', async () => {
    const previewBytes = new Uint8Array(512 * 1024).fill('x'.charCodeAt(0));
    const directFileReadRange = vi.fn(async (_path: string, _offset: number, length: number) =>
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
    const { preview } = createHarness({ transfers: { directFileReadRange } });

    await preview.open(1, defaultTarget);

    expect(directFileReadRange.mock.calls.map((call) => call[2])).toEqual([4096, 512 * 1024]);
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
      await preview.open(index + 1, target, { serverOnly: true, textPreview: true });
      await expect(preview.save(index + 1, 'edited', 'expected-revision')).rejects.toThrow(
        'FILE_WRITE_INVALID'
      );
    }

    expect(request.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  });

  it('captures the write target, content, and expected revision and accepts the saved identity', async () => {
    const target = fileTarget({ workspaceId: 'workspace one', path: 'docs/edit.txt' });
    const { preview, request, onWritten } = createHarness({
      request: async (_path, init) =>
        init?.method === 'PUT'
          ? { file: { revision: 'revision-after-save', size: 8 } }
          : textFile('before', 'revision-before')
    });
    await openServerText(preview, 1, target);

    await expect(preview.save(1, 'after λ', 'revision-before')).resolves.toBe(
      'revision-after-save'
    );

    const [writePath, writeInit] = request.mock.calls[1]!;
    expect(writePath).toBe('/api/workspaces/workspace%20one/files/write');
    expect(writeInit?.method).toBe('PUT');
    expect(JSON.parse(String(writeInit?.body))).toEqual({
      nodeId: 'node-1',
      path: 'docs/edit.txt',
      content: 'after λ',
      expectedRevision: 'revision-before'
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
      request: async (_path, init) => {
        if (init?.method === 'PUT') throw conflict;
        return textFile('original text', 'revision-before');
      }
    });
    await openServerText(preview, 1);
    const original = preview.page(1).fileContent.value;

    await expect(preview.save(1, 'replacement text', 'stale-revision')).rejects.toBe(conflict);

    expect(preview.page(1).fileContent.value).toBe(original);
    expect(preview.page(1).fileContent.value).toMatchObject({
      content: 'original text',
      revision: 'revision-before'
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
      request: async (_path, init) => {
        if (init?.method === 'PUT') return writeRequests[writeIndex++]!.promise;
        const content = readContents[readIndex++]!;
        return textFile(content, `read-revision-${readIndex}`);
      }
    });
    const originalTargets = [
      fileTarget({ path: 'reload.txt' }),
      fileTarget({ path: 'replace.txt' }),
      fileTarget({ path: 'close.txt' })
    ];

    for (const [index, target] of originalTargets.entries()) {
      await openServerText(preview, index + 1, target);
    }
    const saves = [
      preview.save(1, 'late reload write', 'read-revision-1'),
      preview.save(2, 'late replacement write', 'read-revision-2'),
      preview.save(3, 'late closed write', 'read-revision-3')
    ];

    await openServerText(preview, 1, originalTargets[0]!);
    await openServerText(preview, 2, fileTarget({ path: 'new-target.txt' }));
    preview.close(3);
    await openServerText(preview, 3, fileTarget({ path: 'reopened.txt' }));

    writeRequests[0]!.resolve({ file: { revision: 'saved-reload', size: 17 } });
    writeRequests[1]!.resolve({ file: { revision: 'saved-replacement', size: 23 } });
    writeRequests[2]!.resolve({ file: { revision: 'saved-closed', size: 16 } });
    await Promise.all(saves);

    expect(preview.page(1).fileContent.value).toMatchObject({
      path: 'reload.txt',
      content: 'reload wins',
      revision: 'read-revision-4'
    });
    expect(preview.page(2).fileContent.value).toMatchObject({
      path: 'new-target.txt',
      content: 'replacement wins',
      revision: 'read-revision-5'
    });
    expect(preview.page(3).fileContent.value).toMatchObject({
      path: 'reopened.txt',
      content: 'reopened after close',
      revision: 'read-revision-6'
    });
    expect(onWritten).toHaveBeenCalledTimes(3);
  });

  it('keeps a successful write successful when its refresh callback throws', async () => {
    const { preview } = createHarness({
      request: async (_path, init) =>
        init?.method === 'PUT'
          ? { file: { revision: 'revision-after-save', size: 7 } }
          : textFile('before', 'revision-before'),
      onWritten: () => {
        throw new Error('REFRESH_FAILED');
      }
    });
    await openServerText(preview, 1);

    await expect(preview.save(1, 'after', 'revision-before')).resolves.toBe('revision-after-save');
    expect(preview.page(1).fileContent.value).toMatchObject({
      content: 'after',
      revision: 'revision-after-save',
      size: 7
    });
  });

  it('restarts a failed direct read at server offset zero with the same workspace resource', async () => {
    const target = fileTarget({
      path: 'src/file.txt',
      repositoryPath: 'repo/root',
      worktreePath: 'repo/worktree'
    });
    const directFileReadRange: NonNullable<
      WorkspaceFilePreviewTransfers['directFileReadRange']
    > = async (_path, _offset, _length, _worktreePath, identity) => {
      if (identity === undefined) {
        return directRange('p'.repeat(4096), 9000, 4096, 'direct-revision');
      }
      throw new Error('DIRECT_FILE_READ_FAILED');
    };
    const directRead = vi.fn(directFileReadRange);
    let serverReadIndex = 0;
    const { preview, request } = createHarness({
      transfers: { directFileReadRange: directRead },
      request: async () => {
        serverReadIndex += 1;
        return serverReadIndex === 1
          ? {
              file: {
                encoding: 'utf-8',
                size: 9000,
                content: 'server probe from zero',
                nextOffset: 4096,
                revision: 'server-revision'
              }
            }
          : {
              file: {
                encoding: 'utf-8',
                size: 9000,
                content: 'server body from zero',
                nextOffset: null,
                revision: 'server-revision'
              }
            };
      }
    });

    await preview.open(1, target);

    expect(directRead.mock.calls).toHaveLength(2);
    expect(directRead.mock.calls[1]?.[4]).toEqual({ revision: 'direct-revision', size: 9000 });
    expect(request.mock.calls).toHaveLength(2);
    for (const [path] of request.mock.calls) {
      const url = new URL(path, 'http://workspace.test');
      expect(url.searchParams.get('nodeId')).toBe('node-1');
      expect(url.searchParams.get('path')).toBe('src/file.txt');
      expect(url.searchParams.get('repositoryPath')).toBe('repo/root');
      expect(url.searchParams.get('worktreePath')).toBe('repo/worktree');
      expect(url.searchParams.get('offset')).toBe('0');
    }
    expect(preview.page(1).fileContent.value).toMatchObject({
      content: 'server body from zero',
      revision: 'server-revision',
      truncated: false
    });
  });

  it('pins history read identity and refs before fetching the selected revision', async () => {
    const refs = ['main', 'release/1'];
    const historyTarget = fileTarget({
      path: 'docs/guide.txt',
      history: { commit: 'commit/42', repositoryPath: 'repo root', refs }
    });
    const directGitFileReadRange = vi.fn(async () => undefined);
    const fetchContent = vi.fn<typeof fetch>(
      async () =>
        new Response('historic', {
          status: 206,
          headers: { 'content-range': 'bytes 0-7/8' }
        })
    );
    const { preview } = createHarness({
      transfers: { directGitFileReadRange },
      fetchContent
    });
    const opening = preview.open(1, historyTarget);
    refs.splice(0, refs.length, 'changed-after-open');

    await opening;

    expect(directGitFileReadRange).toHaveBeenCalledExactlyOnceWith(
      'commit/42',
      'docs/guide.txt',
      'repo root',
      ['main', 'release/1'],
      0,
      512 * 1024
    );
    const [fetchUrl, fetchInit] = fetchContent.mock.calls[0]!;
    const url = new URL(String(fetchUrl), 'http://workspace.test');
    expect(url.pathname).toBe('/api/workspaces/workspace-1/git/commits/commit%2F42/files/content');
    expect(url.searchParams.get('nodeId')).toBe('node-1');
    expect(url.searchParams.get('path')).toBe('docs/guide.txt');
    expect(url.searchParams.get('repositoryPath')).toBe('repo root');
    expect(url.searchParams.getAll('refs')).toEqual(['main', 'release/1']);
    expect((fetchInit?.headers as Record<string, string>).range).toBe('bytes=0-524287');
    expect(preview.page(1).fileContent.value).toMatchObject({
      path: 'docs/guide.txt',
      content: 'historic',
      size: 8
    });
  });

  it('keeps media previews on a Range-capable content URL', async () => {
    const target = fileTarget({ path: 'media/demo.mp4' });
    const directFileObjectUrl = vi.fn(async () => 'blob:unused');
    const { preview, request, fetchContent } = createHarness({
      transfers: { directFileObjectUrl }
    });

    await preview.open(1, target);

    const contentUrl = preview.page(1).contentUrl.value;
    expect(contentUrl).toContain('/api/workspaces/workspace-1/files/content?');
    expect(new URL(contentUrl!, 'http://workspace.test').searchParams.get('path')).toBe(
      'media/demo.mp4'
    );
    expect(directFileObjectUrl).not.toHaveBeenCalled();
    expect(fetchContent).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('releases blob previews on replacement, late resolution, and close', async () => {
    const pendingReplacement = deferred<string | undefined>();
    const directFileObjectUrl = vi
      .fn<NonNullable<WorkspaceFilePreviewTransfers['directFileObjectUrl']>>()
      .mockResolvedValueOnce('blob:first')
      .mockImplementationOnce(() => pendingReplacement.promise)
      .mockResolvedValueOnce('blob:latest');
    const { preview } = createHarness({ transfers: { directFileObjectUrl } });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    await preview.open(1, fileTarget({ path: 'first.png' }));
    const replacing = preview.open(1, fileTarget({ path: 'second.png' }));
    expect(revoke).toHaveBeenCalledWith('blob:first');
    await preview.open(1, fileTarget({ path: 'third.png' }));
    pendingReplacement.resolve('blob:stale');
    await replacing;

    expect(revoke).toHaveBeenCalledWith('blob:stale');
    expect(preview.page(1).contentUrl.value).toBe('blob:latest');
    preview.close(1);
    expect(revoke).toHaveBeenCalledWith('blob:latest');
  });

  it('keeps the latest page when reads for replaced targets resolve out of order', async () => {
    const readA = deferred<WorkspaceDirectFileRange | undefined>();
    const readB = deferred<WorkspaceDirectFileRange | undefined>();
    let call = 0;
    const directFileReadRange = vi.fn(() => (call++ === 0 ? readA.promise : readB.promise));
    const { preview, onFailure } = createHarness({ transfers: { directFileReadRange } });

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
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('isolates late successes and failures after reset and close', async () => {
    const resetSuccess = deferred<WorkspaceDirectFileRange | undefined>();
    const resetFailure = deferred<WorkspaceDirectFileRange | undefined>();
    const closeSuccess = deferred<WorkspaceDirectFileRange | undefined>();
    const closeFailure = deferred<WorkspaceDirectFileRange | undefined>();
    const pendingByPath = new Map([
      ['reset-stale-success.txt', resetSuccess],
      ['reset-stale-failure.txt', resetFailure],
      ['close-stale-success.txt', closeSuccess],
      ['close-stale-failure.txt', closeFailure]
    ]);
    const directFileReadRange = vi.fn(
      (path: string) =>
        pendingByPath.get(path)?.promise ?? Promise.resolve(directRange(`fresh:${path}`))
    );
    const { preview, onFailure } = createHarness({ transfers: { directFileReadRange } });

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
    }
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('refuses writes while loading and settles loading when the page closes', async () => {
    const read = deferred<ReturnType<typeof textFile>>();
    const { preview, request, onFailure } = createHarness({ request: async () => read.promise });
    const page = preview.page(7);
    const opening = preview.open(7, fileTarget());
    expect(page.loading.value).toBe(true);
    await expect(preview.save(7, 'edited', 'a'.repeat(64))).rejects.toThrow('FILE_WRITE_INVALID');
    preview.close(7);
    expect(page.loading.value).toBe(false);
    read.resolve(textFile('late result'));
    await opening;
    expect(page.loading.value).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it.each([
    { encoding: 'utf-8' as const, nextOffset: 8 },
    { encoding: 'base64' as const, nextOffset: null }
  ])(
    'keeps partial or binary previews read-only ($encoding, $nextOffset)',
    async ({ encoding, nextOffset }) => {
      const { preview, request } = createHarness({
        request: async () => ({ file: { ...textFile('bounded').file, encoding, nextOffset } })
      });
      await preview.open(8, fileTarget());
      await expect(preview.save(8, 'edited', 'a'.repeat(64))).rejects.toThrow('FILE_WRITE_INVALID');
      expect(request.mock.calls.every(([, init]) => init?.method !== 'PUT')).toBe(true);
    }
  );

  it('decodes legacy source in a read-only preview and refuses to save it', async () => {
    const { preview, request } = createHarness({
      request: async () => ({
        file: {
          ...textFile().file,
          encoding: 'base64',
          content: Buffer.from([47, 47, 32, 0xd6, 0xd0, 0xce, 0xc4]).toString('base64')
        }
      })
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
        directFileReadRange: async () => ({
          revision: 'legacy-revision',
          size: bytes.length,
          offset: 0,
          bytes,
          nextOffset: null
        }),
        directGitFileReadRange: async () => ({
          bytes,
          revision: 'history-revision',
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

  it.each([
    { result: 'COMPLETED' as const, browserFallback: false },
    { result: 'UNAVAILABLE' as const, browserFallback: true },
    { result: 'CANCELLED' as const, browserFallback: false },
    { result: 'FAILED' as const, browserFallback: false }
  ])(
    'handles direct download result $result according to its availability',
    async ({ result, browserFallback }) => {
      const directFileDownload = vi.fn(async () => result);
      const anchor = {
        href: '',
        download: '',
        style: { display: '' },
        click: vi.fn(),
        remove: vi.fn()
      };
      const append = vi.fn();
      vi.stubGlobal('document', {
        createElement: vi.fn(() => anchor),
        body: { append }
      });
      const { preview } = createHarness({ transfers: { directFileDownload } });

      await preview.downloadTarget(fileTarget({ path: 'docs/guide.txt' }));

      expect(directFileDownload).toHaveBeenCalledExactlyOnceWith(
        'docs/guide.txt',
        undefined,
        undefined
      );
      expect(anchor.click).toHaveBeenCalledTimes(browserFallback ? 1 : 0);
      if (browserFallback) {
        expect(anchor.href).toContain('download=1');
        expect(anchor.download).toBe('guide.txt');
        expect(append).toHaveBeenCalledExactlyOnceWith(anchor);
        expect(anchor.remove).toHaveBeenCalledOnce();
      }
    }
  );
});
