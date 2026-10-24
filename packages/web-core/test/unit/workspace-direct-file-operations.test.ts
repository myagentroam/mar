import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readWorkspaceDirectFileMetadata,
  readGitDirectFileMetadata,
  readWorkspaceDirectFileRange
} from '../../src/service/workspace-direct-file-read-service.js';
import {
  readWorkspaceDirectObjectUrl,
  revokeWorkspaceDirectObjectUrl
} from '../../src/service/workspace-direct-object-url-service.js';
import { downloadWorkspaceDirectFile } from '../../src/service/workspace-direct-download-stream-service.js';

const resource = {
  kind: 'WORKSPACE_FILE' as const,
  workspaceId: 'workspace/one',
  path: 'assets/image.bin',
  repositoryPath: '',
  worktreePath: '/linked tree'
};
const identity = { size: 3, revision: 'revision-7' };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Workspace direct file operations', () => {
  it('preserves explicit Workspace targets and parses the same metadata body as standalone', async () => {
    const request = vi.fn(async (_path: string) => ({ file: identity }));
    await expect(
      readWorkspaceDirectFileMetadata({ request, nodeId: 'node-1', resource })
    ).resolves.toEqual(identity);
    const url = new URL(request.mock.calls[0]![0]!, 'http://test.local');
    expect(url.pathname).toBe('/api/workspaces/workspace%2Fone/files/direct-metadata');
    expect([...url.searchParams]).toEqual([
      ['nodeId', 'node-1'],
      ['path', resource.path],
      ['repositoryPath', ''],
      ['worktreePath', '/linked tree']
    ]);
  });

  it('keeps Git commit and refs distinct from the Workspace resource', async () => {
    const request = vi.fn(async (_path: string) => ({ file: identity }));
    const gitResource = {
      kind: 'GIT_COMMIT_BLOB' as const,
      workspaceId: resource.workspaceId,
      path: resource.path,
      commit: 'branch/topic',
      repositoryPath: 'nested/repo'
    };
    await expect(
      readGitDirectFileMetadata({
        request,
        nodeId: 'node-2',
        resource: gitResource,
        refs: ['refs/heads/main', 'refs/tags/v1']
      })
    ).resolves.toEqual(identity);
    const url = new URL(request.mock.calls[0]![0], 'http://test.local');
    expect(url.pathname).toBe(
      '/api/workspaces/workspace%2Fone/git/commits/branch%2Ftopic/files/direct-metadata'
    );
    expect(url.searchParams.get('repositoryPath')).toBe('nested/repo');
    expect(url.searchParams.getAll('refs')).toEqual(['refs/heads/main', 'refs/tags/v1']);
    expect(url.searchParams.get('nodeId')).toBe('node-2');
    expect(url.searchParams.get('path')).toBe(resource.path);
  });

  it.each([{}, { file: { size: '3', revision: 'r' } }, { file: { size: 3 } }])(
    'returns unavailable for malformed metadata %j without swallowing request errors',
    async (body) => {
      await expect(
        readWorkspaceDirectFileMetadata({ request: async () => body, nodeId: 'node', resource })
      ).resolves.toBeUndefined();
      await expect(
        readWorkspaceDirectFileMetadata({
          request: async () => {
            throw new Error('HTTP_403');
          },
          nodeId: 'node',
          resource
        })
      ).rejects.toThrow('HTTP_403');
    }
  );

  it('binds late metadata and Range bytes to the captured resource and generation', async () => {
    let release!: (value: typeof identity) => void;
    const metadata = () =>
      new Promise<typeof identity>((resolve) => {
        release = resolve;
      });
    const direct = {
      download: vi.fn(async (input) => {
        expect(input).toMatchObject({
          nodeId: 'node-old',
          nodeGeneration: 'generation-old',
          descriptor: {
            resource,
            revision: identity.revision,
            size: 3,
            range: { offset: 1, length: 2 }
          }
        });
        await input.sink.write(new Uint8Array([8, 9]));
        await input.sink.close();
      })
    };
    const read = readWorkspaceDirectFileRange({
      direct,
      nodeId: 'node-old',
      nodeGeneration: 'generation-old',
      resource,
      fileName: 'image.bin',
      offset: 1,
      length: 20,
      metadata
    });
    expect(direct.download).not.toHaveBeenCalled();
    release(identity);
    await expect(read).resolves.toEqual({
      ...identity,
      offset: 1,
      nextOffset: null,
      bytes: new Uint8Array([8, 9])
    });
  });

  it('does not keep partial Range output after a body failure or integrity failure', async () => {
    for (const fail of [true, false]) {
      const direct = {
        download: vi.fn(async (input) => {
          await input.sink.write(new Uint8Array([1]));
          if (fail) throw new Error('BODY_FAILED');
        })
      };
      await expect(
        readWorkspaceDirectFileRange({
          direct,
          nodeId: 'node',
          nodeGeneration: 'old',
          resource,
          fileName: 'image.bin',
          offset: 0,
          length: 3,
          metadata: async () => identity
        })
      ).rejects.toThrow(fail ? 'BODY_FAILED' : 'DIRECT_INTEGRITY_FAILED');
    }
  });

  it('retains preview ownership on success and removes temporary output on body failure', async () => {
    const removeEntry = vi.fn(async () => undefined);
    const writable = {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined)
    };
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: async () => ({
          getDirectoryHandle: async () => ({
            removeEntry,
            getFileHandle: async () => ({
              createWritable: async () => writable,
              getFile: async () => new File(['abc'], 'image.bin')
            })
          })
        })
      }
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:owned-preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const direct = {
      download: vi.fn(async (input) => {
        await input.sink.close();
      })
    };
    const operation = {
      direct,
      nodeId: 'node',
      nodeGeneration: 'old',
      resource,
      metadata: async () => identity
    };
    await expect(readWorkspaceDirectObjectUrl(operation)).resolves.toEqual({
      url: 'blob:owned-preview',
      ...identity
    });
    expect(removeEntry).not.toHaveBeenCalled();
    revokeWorkspaceDirectObjectUrl('blob:owned-preview');
    await Promise.resolve();
    expect(removeEntry).toHaveBeenCalledOnce();
    direct.download.mockRejectedValueOnce(new Error('BODY_FAILED'));
    await expect(readWorkspaceDirectObjectUrl(operation)).resolves.toBeUndefined();
    expect(writable.abort).toHaveBeenCalledOnce();
    expect(removeEntry).toHaveBeenCalledTimes(2);
  });

  it.each(['metadata', 'before-start', 'after-start', 'cancel', 'success'] as const)(
    'keeps browser download fallback semantics at %s',
    async (phase) => {
      const ports: MessagePort[] = [];
      const messages: unknown[] = [];
      const click = vi.fn();
      vi.stubGlobal('navigator', {
        serviceWorker: {
          controller: {
            postMessage(_value: unknown, transferred: MessagePort[]) {
              const port = transferred[0]!;
              ports.push(port);
              port.onmessage = (event) => messages.push(event.data);
              port.postMessage({ type: 'created' });
              port.postMessage({ type: 'pull' });
            }
          }
        }
      });
      vi.stubGlobal('document', {
        body: { append: vi.fn() },
        createElement: () => ({
          style: {},
          click,
          remove: vi.fn()
        })
      });
      const direct = {
        download: vi.fn(async (input) => {
          if (phase === 'before-start') throw new Error('PREPARE_FAILED');
          if (phase === 'cancel') {
            const cancelled = new Promise<void>((resolve) =>
              input.signal!.addEventListener('abort', () => resolve(), { once: true })
            );
            ports[0]!.postMessage({ type: 'cancel', reason: 'DIRECT_DOWNLOAD_CANCELLED' });
            await cancelled;
            throw new Error('CANCELLED');
          }
          await input.sink.write(new Uint8Array([1, 2, 3]));
          if (phase === 'after-start') throw new Error('CONSUMER_FAILED');
          await input.sink.close();
        })
      };
      try {
        await expect(
          downloadWorkspaceDirectFile({
            direct,
            nodeId: 'node',
            nodeGeneration: 'old',
            resource,
            metadata: async () => {
              if (phase === 'metadata') throw new Error('HTTP_FAILED');
              return identity;
            }
          })
        ).resolves.toBe(
          phase === 'success'
            ? 'COMPLETED'
            : phase === 'cancel'
              ? 'CANCELLED'
              : phase === 'after-start'
                ? 'FAILED'
                : 'UNAVAILABLE'
        );
        expect(click).toHaveBeenCalledTimes(phase === 'after-start' || phase === 'success' ? 1 : 0);
        expect(direct.download).toHaveBeenCalledTimes(phase === 'metadata' ? 0 : 1);
      } finally {
        for (const port of ports) port.close();
      }
    }
  );
});
