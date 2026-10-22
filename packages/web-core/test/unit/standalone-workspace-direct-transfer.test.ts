import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const direct = {
    ensureTransport: vi.fn(async () => 'DIRECT_AVAILABLE' as const),
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
  let streamStarted = false;
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
    createObjectUrlSink: vi.fn(async () => ({
      sink: {
        write: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined)
      },
      objectUrl: vi.fn(async () => 'blob:standalone-direct')
    })),
    createDownloadStream: vi.fn(async () => ({
      sink: {
        write: vi.fn(async () => {
          streamStarted = true;
        }),
        close: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined)
      },
      signal: new AbortController().signal,
      started: () => streamStarted,
      cancelled: () => false
    })),
    createLive: vi.fn((options: Record<string, (...args: never[]) => unknown>) => {
      liveOptions = options;
      return live;
    })
  };
});

vi.mock('../../src/service/WorkspaceDirectTransferService.js', () => ({
  createWorkspaceDirectTransferService: mocks.createDirect
}));
vi.mock('../../src/service/WorkbenchLiveService.js', () => ({
  createWorkbenchLiveService: mocks.createLive
}));
vi.mock('../../src/service/WorkspaceDirectObjectUrlService.js', () => ({
  createWorkspaceDirectObjectUrlSink: mocks.createObjectUrlSink,
  revokeWorkspaceDirectObjectUrl: vi.fn()
}));
vi.mock('../../src/service/WorkspaceDirectDownloadStreamService.js', () => ({
  createWorkspaceDirectDownloadStream: mocks.createDownloadStream
}));

import { createStandaloneWorkspaceDirectTransferService } from '../../src/service/StandaloneWorkspaceDirectTransferService.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Standalone Workspace direct transfer', () => {
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
    const createObjectURL = vi.fn(() => 'blob:standalone-direct');
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL }));

    const service = createStandaloneWorkspaceDirectTransferService({
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
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
    expect(mocks.createObjectUrlSink).toHaveBeenCalledWith('image.bin');

    downloadOrder.length = 0;
    await expect(service.download('assets/image.bin')).resolves.toBe('COMPLETED');
    expect(downloadOrder).toEqual(['metadata']);
    expect(mocks.createDownloadStream).toHaveBeenCalledWith('image.bin', 3);

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
      workspaceId: 'workspace-1'
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
