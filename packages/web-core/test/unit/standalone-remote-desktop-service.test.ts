import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state: { liveOptions?: any; directOptions?: any; relayOptions?: any } = {};
  const live = {
    connect: vi.fn(),
    close: vi.fn(),
    waitForReady: vi.fn(async () => true),
    sendDirect: vi.fn(() => true),
    sendDesktopDirect: vi.fn(() => true),
    sendDesktopRelay: vi.fn(() => true)
  };
  const transport = {
    ensureTransport: vi.fn(async () => 'DIRECT_AVAILABLE'),
    acquireDesktopTransport: vi.fn(),
    handle: vi.fn(),
    close: vi.fn()
  };
  const direct = { attach: vi.fn(), handle: vi.fn(), close: vi.fn() };
  const relay = { attach: vi.fn(), handle: vi.fn(), close: vi.fn() };
  return { state, live, transport, direct, relay };
});
vi.mock('../../src/service/workbench-live-service.js', () => ({
  createWorkbenchLiveService: (options: unknown) => {
    mocks.state.liveOptions = options;
    return mocks.live;
  }
}));
vi.mock('../../src/service/workspace-direct-transfer-service.js', () => ({
  createWorkspaceDirectTransferService: () => mocks.transport
}));
vi.mock('../../src/service/remote-desktop-direct-client.js', () => ({
  createRemoteDesktopDirectClient: (options: unknown) => {
    mocks.state.directOptions = options;
    return mocks.direct;
  }
}));
vi.mock('../../src/service/remote-desktop-relay-client.js', () => ({
  createRemoteDesktopRelayClient: (options: unknown) => {
    mocks.state.relayOptions = options;
    return mocks.relay;
  }
}));
import { createStandaloneRemoteDesktopService } from '../../src/service/standalone-remote-desktop-service.js';

const capability = {
  apiVersion: 1,
  available: true,
  nodeGeneration: 'generation-123',
  backend: 'TIGERVNC_X0',
  supportsView: true,
  supportsControl: true,
  supportsMultiDisplay: true,
  supportsUnicodePaste: true,
  transports: ['DIRECT', 'RELAY']
};
const description = {
  desktopGeneration: 'desktop-123',
  topologyRevision: 1,
  framebuffer: { width: 800, height: 600 },
  displays: [
    {
      displayId: 'primary-1',
      name: 'Primary',
      primary: true,
      nativeBounds: { x: 0, y: 0, width: 800, height: 600 },
      framebufferBounds: { x: 0, y: 0, width: 800, height: 600 },
      nativeToFramebuffer: [1, 0, 0, 1, 0, 0]
    }
  ]
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
function response(value: unknown) {
  return { ok: true, json: async () => value };
}
function fixture() {
  const onDisconnected = vi.fn();
  const service = createStandaloneRemoteDesktopService({ nodeId: 'node 1', onDisconnected });
  mocks.state.liveOptions.onReady('page-connection', false);
  return { service, onDisconnected };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.direct.attach.mockResolvedValue(undefined);
  mocks.relay.attach.mockResolvedValue(undefined);
  mocks.live.waitForReady.mockResolvedValue(true);
  mocks.transport.ensureTransport.mockResolvedValue('DIRECT_AVAILABLE');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response({ capability, description, nodeName: 'Studio desktop' }))
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('standalone Remote Desktop page composition', () => {
  it('preserves the server-provided Node name without deriving it from the internal ID', async () => {
    const f = fixture();
    try {
      const snapshot = await f.service.discover(new AbortController().signal);
      expect(snapshot.nodeName).toBe('Studio desktop');
    } finally {
      await f.service.close();
    }
  });
  it.each([true, false])(
    'opens VIEW with multi-display support reported as %s',
    async (supportsMultiDisplay) => {
      vi.mocked(fetch).mockResolvedValueOnce(
        response({
          capability: {
            ...capability,
            backend: supportsMultiDisplay ? 'TIGERVNC_X0' : 'MACVNC',
            supportsMultiDisplay
          },
          description
        }) as never
      );
      const f = fixture();
      const snapshot = await f.service.discover(new AbortController().signal);
      expect(snapshot.capability.supportsMultiDisplay).toBe(supportsMultiDisplay);
      const handle = { channel: {}, ready: vi.fn(), close: vi.fn(async () => true) };
      mocks.direct.attach.mockResolvedValueOnce(handle);
      const selected = await f.service.select({
        discovery: snapshot,
        mode: 'VIEW',
        signal: new AbortController().signal,
        onDisconnected: vi.fn()
      });
      expect(fetch).toHaveBeenCalledWith(
        '/api/nodes/node%201/desktop',
        expect.objectContaining({
          credentials: 'same-origin',
          cache: 'no-store'
        })
      );
      expect(mocks.transport.ensureTransport).toHaveBeenCalledWith('node 1', 'generation-123');
      expect(mocks.direct.attach).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: 'node 1',
          nodeGeneration: 'generation-123',
          desktopGeneration: 'desktop-123',
          topologyRevision: 1,
          mode: 'VIEW'
        })
      );
      expect(mocks.state.relayOptions.connectionId()).toBe('page-connection');
      selected.ready();
      expect(handle.ready).toHaveBeenCalledOnce();
      expect(await f.service.close()).toBe(true);
      expect(handle.close).toHaveBeenCalledOnce();
    }
  );

  it.each([
    {
      capability: {
        apiVersion: 1,
        available: false,
        nodeGeneration: 'generation-123',
        reasonCode: 'DESKTOP_UNAVAILABLE'
      },
      description
    },
    { capability, description: { ...description, framebuffer: { width: 0, height: 600 } } }
  ])('still rejects unavailable or malformed discovery %#', async (value) => {
    vi.mocked(fetch).mockResolvedValueOnce(response(value) as never);
    const f = fixture();
    try {
      await expect(f.service.discover(new AbortController().signal)).rejects.toMatchObject({
        code: 'DESKTOP_UNAVAILABLE'
      });
      expect(mocks.transport.ensureTransport).not.toHaveBeenCalled();
      expect(mocks.direct.attach).not.toHaveBeenCalled();
      expect(mocks.relay.attach).not.toHaveBeenCalled();
    } finally {
      await f.service.close();
    }
  });

  it('keeps the control connection until attachment settlement and fails closed on loss', async () => {
    const f = fixture();
    const snapshot = await f.service.discover(new AbortController().signal);
    const settlement = deferred<boolean>();
    const handle = { channel: {}, ready: vi.fn(), close: vi.fn(() => settlement.promise) };
    mocks.direct.attach.mockResolvedValueOnce(handle);
    await f.service.select({
      discovery: snapshot,
      mode: 'CONTROL',
      signal: new AbortController().signal,
      onDisconnected: vi.fn()
    });
    mocks.state.liveOptions.onDisconnected();
    expect(handle.close).toHaveBeenCalledOnce();
    expect(f.onDisconnected).toHaveBeenCalledWith('DESKTOP_CONTROL_UNAVAILABLE');
    expect(mocks.live.close).not.toHaveBeenCalled();
    await expect(
      f.service.select({
        discovery: snapshot,
        mode: 'VIEW',
        signal: new AbortController().signal,
        onDisconnected: vi.fn()
      })
    ).rejects.toMatchObject({ code: 'DESKTOP_UNAVAILABLE' });
    settlement.resolve(false);
    expect(await f.service.close()).toBe(false);
    expect(mocks.transport.close).toHaveBeenCalledOnce();
    expect(mocks.live.close).toHaveBeenCalledOnce();
  });

  it('rejects late discovery and never prepares its transport after termination', async () => {
    const f = fixture();
    const pending = deferred<ReturnType<typeof response>>();
    vi.mocked(fetch).mockReturnValueOnce(pending.promise as never);
    const discovery = f.service.discover(new AbortController().signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    mocks.state.liveOptions.onNodeConnection('node 1', false);
    pending.resolve(response({ capability, description }));
    await expect(discovery).rejects.toMatchObject({ code: 'DESKTOP_CONTROL_UNAVAILABLE' });
    expect(mocks.transport.ensureTransport).not.toHaveBeenCalled();
    expect(f.onDisconnected).toHaveBeenCalledWith('NODE_OFFLINE');
    await f.service.close();
  });

  it('does not fall back to an unadvertised Relay path and preserves HTTP error codes', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      response({ capability: { ...capability, transports: ['DIRECT'] }, description }) as never
    );
    const f = fixture();
    const snapshot = await f.service.discover(new AbortController().signal);
    await expect(
      f.service.select({
        discovery: snapshot,
        mode: 'VIEW',
        signal: new AbortController().signal,
        onDisconnected: vi.fn()
      })
    ).rejects.toMatchObject({ code: 'DESKTOP_CONTROL_UNAVAILABLE' });
    expect(mocks.relay.attach).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({
        error: { code: 'NODE_ACCESS_DENIED', message: 'Node access is denied.' }
      })
    } as never);
    await expect(f.service.discover(new AbortController().signal)).rejects.toMatchObject({
      code: 'NODE_ACCESS_DENIED'
    });
    await f.service.close();
  });
});
