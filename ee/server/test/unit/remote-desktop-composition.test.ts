import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteDesktopCapability } from '@myagentroam/protocol';
import type { DirectTransferCoordinatorOptions } from '@myagentroam/server-core/direct-transfer-coordinator';
import type { RemoteDesktopDirectOptions } from '@myagentroam/server-core/remote-desktop-direct-coordinator';
import type { RemoteDesktopRelayOptions } from '@myagentroam/server-core/remote-desktop-relay-coordinator';
import type { NodeControlComponents, NodeControlTransport } from '../../src/node-control.js';

const captured = vi.hoisted(() => ({
  compose: undefined as ((transport: NodeControlTransport) => NodeControlComponents) | undefined,
  transport: undefined as DirectTransferCoordinatorOptions | undefined,
  direct: undefined as RemoteDesktopDirectOptions | undefined,
  relay: undefined as RemoteDesktopRelayOptions | undefined
}));
vi.mock('../../src/node-control.js', () => ({
  NodeControl: class {
    constructor(_store: unknown, compose: typeof captured.compose) {
      captured.compose = compose;
    }
  }
}));
vi.mock('@myagentroam/server-core/direct-transfer-coordinator', () => ({
  DirectTransferCoordinator: class {
    constructor(options: DirectTransferCoordinatorOptions) {
      captured.transport = options;
    }
    close() {}
  }
}));
vi.mock('@myagentroam/server-core/remote-desktop-direct-coordinator', () => ({
  RemoteDesktopDirectCoordinator: class {
    constructor(options: RemoteDesktopDirectOptions) {
      captured.direct = options;
    }
    close() {}
  }
}));
vi.mock('@myagentroam/server-core/remote-desktop-relay-coordinator', () => ({
  RemoteDesktopRelayCoordinator: class {
    constructor(options: RemoteDesktopRelayOptions) {
      captured.relay = options;
    }
    close() {}
  }
}));
import { createNodeControl } from '../../src/composition/node-control-factory.js';

let components: NodeControlComponents | undefined;
afterEach(() => {
  for (const component of Object.values(components ?? {})) {
    if ('close' in component && typeof component.close === 'function') component.close();
  }
  components = undefined;
  vi.restoreAllMocks();
});

function fixture() {
  let capability: RemoteDesktopCapability = {
    apiVersion: 1,
    available: true,
    nodeGeneration: 'node-generation',
    backend: 'MACVNC',
    supportsView: true,
    supportsControl: true,
    supportsMultiDisplay: false,
    supportsUnicodePaste: false,
    transports: ['DIRECT', 'RELAY']
  };
  const description = {
    desktopGeneration: 'desktop-generation',
    topologyRevision: 1,
    framebuffer: { width: 800, height: 600 },
    displays: [
      {
        displayId: 'primary-display',
        name: 'Primary',
        primary: true,
        nativeBounds: { x: 0, y: 0, width: 800, height: 600 },
        framebufferBounds: { x: 0, y: 0, width: 800, height: 600 },
        nativeToFramebuffer: [1, 0, 0, 1, 0, 0]
      }
    ]
  };
  const authorize = vi.fn(async () => true);
  const request = vi.fn(async () => description);
  createNodeControl({} as never, authorize, {} as never, {} as never);
  components = captured.compose!({
    capabilities: () => ({ remoteDesktop: capability }),
    request,
    socketFor: vi.fn(),
    allows: vi.fn(),
    sendNode: vi.fn(),
    send: vi.fn(),
    sendInvalid: vi.fn()
  } as unknown as NodeControlTransport);
  return {
    authorize,
    request,
    description,
    setCapability: (value: RemoteDesktopCapability) => {
      capability = value;
    }
  };
}

const request = {
  requestId: 'request-identity',
  nodeId: 'node',
  nodeGeneration: 'node-generation',
  desktopGeneration: 'desktop-generation',
  topologyRevision: 1,
  mode: 'VIEW' as const
};
const identity = { userId: 1, sessionHash: 'session', workbenchConnectionId: 'page-connection' };

function preflight(path: 'DIRECT' | 'RELAY') {
  const signal = new AbortController().signal;
  return path === 'DIRECT'
    ? captured.direct!.preflight(
        { ...request, type: 'desktop.direct.prepare', transportSessionId: 'transport-session' },
        identity,
        signal
      )
    : captured.relay!.preflight({ ...request, type: 'desktop.relay.prepare' }, identity, signal);
}

describe('Remote Desktop server composition admission', () => {
  it.each(['DIRECT', 'RELAY'] as const)(
    'admits a single display through %s without bypassing authorization',
    async (path) => {
      const f = fixture();
      const options = path === 'DIRECT' ? captured.direct! : captured.relay!;
      expect(await captured.transport!.authorizeTransport!(1, 'node')).toBe(true);
      expect(await options.authorize(1, 'node', 'VIEW')).toBe(true);
      expect(await options.authorize(1, 'node', 'CONTROL')).toBe(true);
      await expect(preflight(path)).resolves.toBeUndefined();
      expect(f.request).toHaveBeenCalledOnce();
      f.authorize.mockResolvedValue(false);
      expect(await options.authorize(1, 'node', 'VIEW')).toBe(false);
      expect(await captured.transport!.authorizeTransport!(1, 'node')).toBe(false);
    }
  );

  it.each(['DIRECT', 'RELAY'] as const)(
    'rechecks single-display capability after asynchronous %s preflight',
    async (path) => {
      const f = fixture();
      f.request.mockImplementation(async () => {
        f.setCapability({
          apiVersion: 1,
          available: false,
          nodeGeneration: 'node-generation',
          reasonCode: 'DESKTOP_UNAVAILABLE'
        });
        return f.description;
      });
      await expect(preflight(path)).rejects.toThrow('Desktop unavailable');
      expect(f.request).toHaveBeenCalledOnce();
    }
  );
});
