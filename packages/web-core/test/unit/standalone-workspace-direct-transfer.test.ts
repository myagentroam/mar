import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeStream } from '@myagentroam/protocol/node-stream';

const mocks = vi.hoisted(() => {
  const direct = {
    ensureTransport: vi.fn(
      async (): Promise<'DIRECT_AVAILABLE' | 'RELAY_ONLY'> => 'DIRECT_AVAILABLE'
    ),
    isConnected: vi.fn(() => true),
    acquireTerminalTransport: vi.fn(() => ({
      streamPath: { closed: false },
      release: vi.fn()
    })),
    openFileStream: vi.fn(async (..._args: unknown[]) => {
      const stream = new NodeStream(
        1,
        async () => {},
        () => {}
      );
      stream.receive({ type: 'DATA', streamId: 1, bytes: new Uint8Array([1, 2, 3]) });
      stream.receive({ type: 'FIN', streamId: 1 });
      return stream;
    }),
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
import { createStandaloneWorkspaceDirectTransferService as createTransfer } from '../../src/service/standalone-workspace-direct-transfer-service.js';
import { createScopedHttpService } from '../../src/service/scoped-http-service.js';

function createStandaloneWorkspaceDirectTransferService(
  options: Omit<Parameters<typeof createTransfer>[0], 'http'>
) {
  return createTransfer({ ...options, http: createScopedHttpService() });
}

beforeEach(() => {
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => ({
        getDirectoryHandle: async () => ({
          getDirectoryHandle: async () => ({
            getFileHandle: mocks.getFileHandle,
            removeEntry: async () => undefined,
            async *entries() {}
          })
        })
      })
    },
    locks: {
      request: async (_name: string, callback: () => Promise<void>) => callback()
    },
    serviceWorker: { controller: { postMessage: mocks.workerPost } }
  });
  vi.stubGlobal('document', {
    body: { append: vi.fn() },
    createElement: () => ({ style: {}, remove: vi.fn(), click: vi.fn() })
  });
  vi.stubGlobal('window', { location: { origin: 'http://test.local' } });
  // Here the mock ICE carrier is ready; Relay-only is covered by the browser fixture.
  vi.stubGlobal(
    'WebSocket',
    class {
      constructor() {
        throw new Error('RELAY_UNAVAILABLE');
      }
    }
  );
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
        expect(mocks.direct.openFileStream.mock.calls.map((call) => call[1])).toEqual([
          'generation-2'
        ]);
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
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.getFileHandle).not.toHaveBeenCalled();
    expect(mocks.direct.openFileStream).not.toHaveBeenCalled();
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

  it('uses the private resource reference for both an attachment preview and an explicit download', async () => {
    const attachment = 'mar-attachment://00000000-0000-4000-8000-000000000001/file.bin';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('workbench-capabilities')) {
          return response({
            manifest: {
              nodeGeneration: 'generation-1',
              directTransfer: { apiVersion: 3, transport: true, download: true }
            }
          });
        }
        const request = new URL(url, 'http://test.local');
        expect(request.pathname).toBe('/api/workspaces/workspace-1/files/direct-metadata');
        expect(request.searchParams.get('path')).toBe(attachment);
        return response({ file: { size: 3, revision: 'a'.repeat(64) } });
      })
    );
    const service = createStandaloneWorkspaceDirectTransferService({
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      activeDownloadWorker: async () => navigator.serviceWorker.controller ?? undefined
    });
    try {
      await expect(service.readRange(attachment, 0, 3)).resolves.toMatchObject({
        bytes: new Uint8Array([1, 2, 3]),
        nextOffset: null
      });
      expect(mocks.direct.openFileStream).toHaveBeenCalledExactlyOnceWith(
        'node-1',
        'generation-1',
        expect.objectContaining({
          resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace-1', path: attachment },
          range: { offset: 0, length: 3 }
        }),
        expect.any(AbortSignal)
      );
      mocks.direct.openFileStream.mockClear();
      await expect(service.download(attachment)).resolves.toBe('COMPLETED');
      expect(mocks.direct.openFileStream).toHaveBeenCalledExactlyOnceWith(
        'node-1',
        'generation-1',
        expect.objectContaining({
          direction: 'DOWNLOAD',
          resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace-1', path: attachment }
        }),
        expect.any(AbortSignal)
      );
    } finally {
      service.close();
    }
  });

  it('does not open an explicit download after the window closes during metadata lookup', async () => {
    const metadata = Promise.withResolvers<Response>();
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('workbench-capabilities') ? response({}) : metadata.promise
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = createStandaloneWorkspaceDirectTransferService({
      nodeId: 'node-1',
      workspaceId: 'workspace-1'
    });
    const pending = service.download('late.bin');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    service.close();
    metadata.resolve(response({ file: { size: 3, revision: 'a'.repeat(64) } }));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.getFileHandle).not.toHaveBeenCalled();
    expect(mocks.direct.openFileStream).not.toHaveBeenCalled();
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
    expect(mocks.getFileHandle).toHaveBeenCalledWith(expect.stringContaining('image.bin'), {
      create: true
    });

    downloadOrder.length = 0;
    mocks.direct.openFileStream.mockClear();
    await expect(service.download('assets/image.bin')).resolves.toBe('COMPLETED');
    expect(downloadOrder).toEqual(['metadata']);
    expect(mocks.workerPost).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'image.bin', size: 3 }),
      expect.any(Array)
    );
    expect(mocks.direct.openFileStream).toHaveBeenCalledExactlyOnceWith(
      'node-1',
      'generation-1',
      expect.objectContaining({
        direction: 'DOWNLOAD',
        resource: {
          kind: 'WORKSPACE_FILE',
          workspaceId: 'workspace-1',
          path: 'assets/image.bin',
          ...target
        },
        size: 3,
        revision: 'a'.repeat(64)
      }),
      expect.any(AbortSignal)
    );

    await expect(service.readRange('assets/image.bin', 0, 3)).resolves.toMatchObject({
      bytes: new Uint8Array([1, 2, 3]),
      size: 3
    });
    for (const [, , descriptor] of mocks.direct.openFileStream.mock.calls) {
      expect(descriptor).toMatchObject({
        resource: {
          kind: 'WORKSPACE_FILE',
          workspaceId: 'workspace-1',
          path: 'assets/image.bin',
          ...target
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

    await expect(service.objectUrl('file.bin')).rejects.toThrow('NODE_RESPONSE_INVALID');
    expect(mocks.direct.ensureTransport).not.toHaveBeenCalled();
    expect(mocks.direct.openFileStream).not.toHaveBeenCalled();
    service.close();
  });

  it('bounds the initial ICE wait without a Relay and can use a late Direct path for download', async () => {
    vi.useFakeTimers();
    let completeManifest!: (result: Response) => void;
    const manifest = new Promise<Response>((resolve) => {
      completeManifest = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path === '/api/nodes/node-1/workbench-capabilities') return manifest;
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
    const rejected = expect(initialRead).rejects.toBeInstanceOf(AggregateError);
    await vi.advanceTimersByTimeAsync(799);
    let settled = false;
    void initialRead.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;

    completeManifest(
      response({
        manifest: {
          nodeGeneration: 'generation-1',
          directTransfer: { apiVersion: 3, transport: true, download: true }
        }
      })
    );
    for (let index = 0; index < 3; index += 1) await Promise.resolve();
    await expect(service.download('notes.txt')).resolves.toBe('COMPLETED');
    service.close();
  });
});

function response(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}
