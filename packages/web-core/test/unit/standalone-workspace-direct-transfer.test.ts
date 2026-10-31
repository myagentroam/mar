import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const direct = {
    ensureTransport: vi.fn(
      async (): Promise<'DIRECT_AVAILABLE' | 'RELAY_ONLY'> => 'DIRECT_AVAILABLE'
    ),
    isConnected: vi.fn(() => true),
    download: vi.fn(
      async (input: {
        readonly sink: {
          write(bytes: Uint8Array): Promise<void>;
          close(): Promise<void>;
        };
      }) => {
        await input.sink.write(new Uint8Array([1, 2, 3]));
        await input.sink.close();
      }
    ),
    handle: vi.fn(),
    invalidateNode: vi.fn(),
    invalidateControlConnection: vi.fn(),
    invalidateNetwork: vi.fn(),
    close: vi.fn()
  };
  let liveOptions: Record<string, (...args: never[]) => unknown> | undefined;
  const live = {
    connect: vi.fn(() => {
      void liveOptions?.['onReady']?.();
    }),
    sendDirect: vi.fn(() => true),
    close: vi.fn()
  };
  return {
    direct,
    live,
    createDirect: vi.fn(() => direct),
    getFileHandle: vi.fn(async () => ({
      createWritable: async () => ({
        write: async () => undefined,
        close: async () => undefined,
        abort: async () => undefined
      }),
      getFile: async () => new File([new Uint8Array([1, 2, 3])], 'image.bin')
    })),
    workerPost: vi.fn((_value: unknown, ports: readonly MessagePort[]) => {
      const port = ports[0]!;
      port.onmessage = (event) => {
        if (['close', 'abort'].includes(event.data.type)) {
          port.postMessage({ type: 'finished' });
          port.close();
        }
      };
      port.postMessage({ type: 'created' });
      port.postMessage({ type: 'pull' });
    }),
    createLive: vi.fn((options: Record<string, (...args: never[]) => unknown>) => {
      liveOptions = options;
      return live;
    })
  };
});

vi.mock('../../src/service/workspace-direct-transfer-service.js', () => ({
  createWorkspaceDirectTransferService: mocks.createDirect
}));
vi.mock('../../src/service/workbench-live-service.js', () => ({
  createWorkbenchLiveService: mocks.createLive
}));
import { createStandaloneWorkspaceDirectTransferService } from '../../src/service/standalone-workspace-direct-transfer-service.js';

beforeEach(() => {
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => ({
        getDirectoryHandle: async () => ({
          getFileHandle: mocks.getFileHandle,
          removeEntry: async () => undefined
        })
      })
    },
    serviceWorker: { controller: { postMessage: mocks.workerPost } }
  });
  vi.stubGlobal('document', {
    body: { append: vi.fn() },
    createElement: () => ({ style: {}, remove: vi.fn(), click: vi.fn() })
  });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:standalone-direct');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Standalone Workspace direct transfer', () => {
  it.each(['manifest-failure', 'transport-relay-only'] as const)(
    'ignores obsolete %s while the replacement transport becomes ready',
    async (phase) => {
      let failObsolete!: (error: Error) => void;
      const obsolete = new Promise<Response>((_resolve, reject) => {
        failObsolete = reject;
      });
      let finishObsoleteTransport!: (value: 'RELAY_ONLY') => void;
      const obsoleteTransport = new Promise<'RELAY_ONLY'>((resolve) => {
        finishObsoleteTransport = resolve;
      });
      let connectCurrent!: (value: 'DIRECT_AVAILABLE') => void;
      const current = new Promise<'DIRECT_AVAILABLE'>((resolve) => {
        connectCurrent = resolve;
      });
      if (phase === 'transport-relay-only')
        mocks.direct.ensureTransport.mockReturnValueOnce(obsoleteTransport);
      mocks.direct.ensureTransport.mockReturnValueOnce(current);
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockReturnValueOnce(
            phase === 'manifest-failure'
              ? obsolete
              : Promise.resolve(
                  Response.json({
                    manifest: {
                      nodeGeneration: 'generation-1',
                      directTransfer: { apiVersion: 3, transport: true, download: true }
                    }
                  })
                )
          )
          .mockResolvedValueOnce(
            Response.json({
              manifest: {
                nodeGeneration: 'generation-2',
                directTransfer: { apiVersion: 3, transport: true, download: true }
              }
            })
          )
          .mockResolvedValue(Response.json({ file: { size: 3, revision: 'r2' } }))
      );
      const service = createStandaloneWorkspaceDirectTransferService({
        nodeId: 'node-1',
        workspaceId: 'workspace-1'
      });
      try {
        if (phase === 'transport-relay-only')
          await vi.waitFor(() =>
            expect(mocks.direct.ensureTransport).toHaveBeenCalledWith('node-1', 'generation-1')
          );
        mocks.createLive.mock.calls.at(-1)?.[0]?.['onReady']?.();
        await vi.waitFor(() =>
          expect(mocks.direct.ensureTransport).toHaveBeenCalledWith('node-1', 'generation-2')
        );
        if (phase === 'manifest-failure') {
          failObsolete(new Error('OBSOLETE_CONNECTION_FAILED'));
          await obsolete.catch(() => undefined);
        } else {
          finishObsoleteTransport('RELAY_ONLY');
          await obsoleteTransport;
        }
        const preview = service.objectUrl('current.bin');
        connectCurrent('DIRECT_AVAILABLE');
        await expect(preview).resolves.toEqual({
          url: 'blob:standalone-direct',
          size: 3,
          revision: 'r2'
        });
        expect(mocks.direct.download).toHaveBeenCalledWith(
          expect.objectContaining({ nodeGeneration: 'generation-2' })
        );
      } finally {
        connectCurrent('DIRECT_AVAILABLE');
        service.close();
      }
    }
  );

  it('discards metadata arriving after window close without allocating an output', async () => {
    let finish!: (value: Response) => void;
    const metadata = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('workbench-capabilities')
        ? Response.json({
            manifest: {
              nodeGeneration: 'generation-1',
              directTransfer: { apiVersion: 3, transport: true, download: true }
            }
          })
        : metadata
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = createStandaloneWorkspaceDirectTransferService({
      nodeId: 'node-1',
      workspaceId: 'workspace-1'
    });
    const operation = service.objectUrl('late.bin');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    service.close();
    finish(Response.json({ file: { size: 3, revision: 'r1' } }));
    await expect(operation).resolves.toBeUndefined();
    expect(mocks.getFileHandle).not.toHaveBeenCalled();
    expect(mocks.direct.download).not.toHaveBeenCalled();
  });
  it.each(['close', 'replace'] as const)(
    'does not revive a late initialization after %s',
    async (action) => {
      let firstManifest!: (response: Response) => void;
      let reads = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          if (++reads === 1)
            return new Promise<Response>((resolve) => {
              firstManifest = resolve;
            });
          return response({
            manifest: {
              nodeGeneration: 'generation-2',
              directTransfer: { apiVersion: 3, transport: true, download: true }
            }
          });
        })
      );
      const service = createStandaloneWorkspaceDirectTransferService({
        nodeId: 'node-1',
        workspaceId: 'workspace-1'
      });
      if (action === 'close') service.close();
      else {
        const options = mocks.createLive.mock.calls[0]![0]!;
        options['onReady']!();
        await vi.waitFor(() =>
          expect(mocks.direct.ensureTransport).toHaveBeenCalledWith('node-1', 'generation-2')
        );
      }
      firstManifest(
        response({
          manifest: {
            nodeGeneration: 'generation-1',
            directTransfer: { apiVersion: 3, transport: true, download: true }
          }
        })
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(mocks.direct.ensureTransport).not.toHaveBeenCalledWith('node-1', 'generation-1');
      service.close();
    }
  );

  it('discards late metadata on close and never sends attachments through direct transfer', async () => {
    let finishMetadata!: (response: Response) => void;
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('workbench-capabilities')
        ? response({
            manifest: {
              nodeGeneration: 'generation-1',
              directTransfer: { apiVersion: 3, transport: true, download: true }
            }
          })
        : new Promise<Response>((resolve) => {
            finishMetadata = resolve;
          })
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = createStandaloneWorkspaceDirectTransferService({
      nodeId: 'node-1',
      workspaceId: 'workspace-1'
    });
    await vi.waitFor(() => expect(mocks.direct.ensureTransport).toHaveBeenCalledOnce());
    const attachment = 'mar-attachment://00000000-0000-4000-8000-000000000001/file.bin';
    await expect(service.objectUrl(attachment)).resolves.toBeUndefined();
    await expect(service.readRange(attachment, 0, 3)).resolves.toBeUndefined();
    await expect(service.download(attachment)).resolves.toBe('UNAVAILABLE');
    expect(fetchMock).toHaveBeenCalledOnce();
    const pending = service.objectUrl('late.bin');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    service.close();
    finishMetadata(response({ file: { size: 3, revision: 'revision' } }));
    await expect(pending).resolves.toBeUndefined();
    expect(mocks.direct.download).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { repositoryPath: '' },
    { repositoryPath: 'libs/module' },
    { worktreePath: '/linked' }
  ])('preserves the file target %j through metadata and direct transfers', async (target) => {
    const downloadOrder: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path === '/api/nodes/node-1/workbench-capabilities')
        return response({
          manifest: {
            nodeGeneration: 'generation-1',
            directTransfer: { apiVersion: 3, transport: true, download: true }
          }
        });
      if (path.includes('/files/direct-metadata?')) {
        const parameters = new URL(path, 'http://test.local').searchParams;
        expect(parameters.has('repositoryPath')).toBe('repositoryPath' in target);
        for (const [key, value] of Object.entries(target)) expect(parameters.get(key)).toBe(value);
        downloadOrder.push('metadata');
        return response({
          file: { size: 3, revision: 'a'.repeat(64) }
        });
      }
      throw new Error(`UNEXPECTED_FETCH:${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const service = createStandaloneWorkspaceDirectTransferService({
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      activeDownloadWorker: async () => navigator.serviceWorker.controller ?? undefined,
      ...target
    });
    await vi.waitFor(() =>
      expect(mocks.direct.ensureTransport).toHaveBeenCalledWith('node-1', 'generation-1')
    );

    await expect(service.objectUrl('assets/image.bin')).resolves.toEqual({
      url: 'blob:standalone-direct',
      size: 3,
      revision: 'a'.repeat(64)
    });
    expect(mocks.direct.download).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: 'node-1',
        nodeGeneration: 'generation-1',
        descriptor: expect.objectContaining({
          direction: 'DOWNLOAD',
          resource: {
            kind: 'WORKSPACE_FILE',
            workspaceId: 'workspace-1',
            path: 'assets/image.bin',
            ...target
          }
        })
      })
    );
    expect(mocks.getFileHandle).toHaveBeenCalledWith(expect.stringContaining('image.bin'), {
      create: true
    });

    downloadOrder.length = 0;
    await expect(service.download('assets/image.bin')).resolves.toBe('COMPLETED');
    expect(downloadOrder).toEqual(['metadata']);
    expect(mocks.workerPost).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'image.bin', size: 3 }),
      expect.any(Array)
    );

    await expect(service.readRange('assets/image.bin', 0, 3)).resolves.toMatchObject({
      bytes: new Uint8Array([1, 2, 3]),
      size: 3
    });
    for (const [input] of mocks.direct.download.mock.calls) {
      expect(input).toMatchObject({
        descriptor: {
          resource: {
            kind: 'WORKSPACE_FILE',
            workspaceId: 'workspace-1',
            path: 'assets/image.bin',
            ...target
          }
        }
      });
    }

    service.close();
    expect(mocks.direct.invalidateNetwork).toHaveBeenCalled();
    expect(mocks.live.close).toHaveBeenCalled();
  });

  it('returns unavailable without starting a transfer when capability or metadata is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) =>
        String(input) === '/api/nodes/node-1/workbench-capabilities'
          ? response({ manifest: { nodeGeneration: 'generation-1' } })
          : response({})
      )
    );

    const service = createStandaloneWorkspaceDirectTransferService({
      nodeId: 'node-1',
      workspaceId: 'workspace-1'
    });

    await expect(service.objectUrl('file.bin')).resolves.toBeUndefined();
    expect(mocks.direct.ensureTransport).not.toHaveBeenCalled();
    expect(mocks.direct.download).not.toHaveBeenCalled();
    service.close();
  });

  it('falls back quickly for the initial preview while allowing a late direct transport for download', async () => {
    vi.useFakeTimers();
    let completeTransport: ((result: 'DIRECT_AVAILABLE') => void) | undefined;
    mocks.direct.ensureTransport.mockImplementationOnce(
      () =>
        new Promise<'DIRECT_AVAILABLE'>((resolve) => {
          completeTransport = resolve;
        })
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path === '/api/nodes/node-1/workbench-capabilities')
          return response({
            manifest: {
              nodeGeneration: 'generation-1',
              directTransfer: { apiVersion: 3, transport: true, download: true }
            }
          });
        if (path.includes('/files/direct-metadata?'))
          return response({ file: { size: 3, revision: 'a'.repeat(64) } });
        throw new Error(`UNEXPECTED_FETCH:${path}`);
      })
    );

    const service = createStandaloneWorkspaceDirectTransferService({
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      activeDownloadWorker: async () => navigator.serviceWorker.controller ?? undefined
    });
    const initialRead = service.readRange('notes.txt', 0, 512);
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    expect(mocks.direct.ensureTransport).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(799);
    let settled = false;
    void initialRead.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(initialRead).resolves.toBeUndefined();

    completeTransport?.('DIRECT_AVAILABLE');
    for (let index = 0; index < 3; index += 1) await Promise.resolve();
    await expect(service.download('notes.txt')).resolves.toBe('COMPLETED');
    service.close();
  });
});

function response(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}
