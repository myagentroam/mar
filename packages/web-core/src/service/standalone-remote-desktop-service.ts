import {
  remoteDesktopCapabilitySchema,
  remoteDesktopDescriptionSchema,
  type RemoteDesktopCapability,
  type RemoteDesktopDescription
} from '@myagentroam/protocol';
import { createWorkbenchLiveService } from './workbench-live-service.js';
import { createWorkspaceDirectTransferService } from './workspace-direct-transfer-service.js';
import { createRemoteDesktopDirectClient } from './remote-desktop-direct-client.js';
import { createRemoteDesktopRelayClient } from './remote-desktop-relay-client.js';
import { createRemoteDesktopPageAttachments } from './remote-desktop-page-attachments.js';
import { RemoteDesktopClientError } from './remote-desktop-client-core.js';
import { apiErrorFromResponse } from '../util/api-error.js';

type AvailableCapability = Extract<RemoteDesktopCapability, { available: true }>;
export interface StandaloneDesktopDiscovery {
  readonly capability: AvailableCapability;
  readonly description: RemoteDesktopDescription;
}

/** Owns this tab's control connection and transports; attachment and native leases have separate owners. */
export function createStandaloneRemoteDesktopService(options: {
  readonly nodeId: string;
  readonly onDisconnected: (code: string) => void;
}) {
  let running = true;
  let connectionId: string | undefined;
  let discovery: StandaloneDesktopDiscovery | undefined;
  let discoveryRevision = 0;
  let closing: Promise<boolean> | undefined;
  const lifetime = new AbortController();
  const directTransport = createWorkspaceDirectTransferService({
    send: (message) => live.sendDirect(message),
    shouldRetryProbe: () => false
  });
  const direct = createRemoteDesktopDirectClient({
    send: (message) => live.sendDesktopDirect(message),
    acquire: (nodeId, generation) =>
      discovery?.capability.transports.includes('DIRECT')
        ? directTransport.acquireDesktopTransport(nodeId, generation)
        : undefined
  });
  const relay = createRemoteDesktopRelayClient({
    send: (message) => live.sendDesktopRelay(message),
    connectionId: () => connectionId
  });
  const attachments = createRemoteDesktopPageAttachments({
    direct,
    relay: {
      ...relay,
      attach: (input) =>
        discovery?.capability.transports.includes('RELAY')
          ? relay.attach(input)
          : Promise.resolve(undefined)
    }
  });
  const live = createWorkbenchLiveService({
    canConnect: () => running,
    onEvent: () => undefined,
    onResyncRequired: () => undefined,
    onNodeConnection: (nodeId, connected) => {
      if (nodeId === options.nodeId && !connected) terminate('NODE_OFFLINE');
    },
    onNodeReplaced: (nodeId) => {
      if (nodeId === options.nodeId) terminate('NODE_OFFLINE');
    },
    onReconnect: () => undefined,
    onDisconnected: () => terminate('DESKTOP_CONTROL_UNAVAILABLE'),
    onUnauthenticated: () => terminate('UNAUTHENTICATED'),
    onInvalidMessage: () => terminate('DESKTOP_CONTROL_UNAVAILABLE'),
    onReady: (id) => {
      connectionId = id;
    },
    onDirectMessage: (message) => directTransport.handle(message),
    onDesktopDirectMessage: (message) => direct.handle(message),
    onDesktopRelayMessage: (message) => relay.handle(message)
  });

  function terminate(code: string): void {
    if (!running) return;
    void close();
    options.onDisconnected(code);
  }

  async function discover(signal: AbortSignal): Promise<StandaloneDesktopDiscovery> {
    const revision = ++discoveryRevision;
    discovery = undefined;
    const combined = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(15_000)]);
    if (!(await waitFor(live.waitForReady(), combined)))
      throw new RemoteDesktopClientError('DESKTOP_CONTROL_UNAVAILABLE');
    const connection = connectionId;
    const response = await fetch(`/api/nodes/${encodeURIComponent(options.nodeId)}/desktop`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: combined
    });
    if (!response.ok) {
      const error = apiErrorFromResponse(await response.json().catch(() => ({})), response.status);
      if (error.code === 'UNAUTHENTICATED') terminate(error.code);
      throw error;
    }
    const value: unknown = await response.json();
    if (value === null || typeof value !== 'object')
      throw new RemoteDesktopClientError('DESKTOP_UNAVAILABLE');
    const data = value as { capability?: unknown; description?: unknown };
    const capability = remoteDesktopCapabilitySchema.safeParse(data.capability);
    const description = remoteDesktopDescriptionSchema.safeParse(data.description);
    if (
      !capability.success ||
      !capability.data.available ||
      !capability.data.supportsMultiDisplay ||
      !description.success
    )
      throw new RemoteDesktopClientError('DESKTOP_UNAVAILABLE');
    if (
      !running ||
      combined.aborted ||
      revision !== discoveryRevision ||
      connection !== connectionId
    )
      throw new RemoteDesktopClientError('DESKTOP_CONTROL_UNAVAILABLE');
    const result = { capability: capability.data, description: description.data };
    discovery = result;
    if (result.capability.transports.includes('DIRECT'))
      await waitFor(
        directTransport.ensureTransport(options.nodeId, result.capability.nodeGeneration),
        combined
      );
    if (
      !running ||
      combined.aborted ||
      revision !== discoveryRevision ||
      connection !== connectionId
    )
      throw new RemoteDesktopClientError('DESKTOP_CONTROL_UNAVAILABLE');
    return result;
  }

  function select(input: {
    readonly discovery: StandaloneDesktopDiscovery;
    readonly mode: 'VIEW' | 'CONTROL';
    readonly signal: AbortSignal;
    readonly onDisconnected: (code: string) => void;
  }) {
    if (
      !running ||
      input.discovery !== discovery ||
      (input.mode === 'CONTROL' && !input.discovery.capability.supportsControl)
    )
      return Promise.reject(new RemoteDesktopClientError('DESKTOP_UNAVAILABLE'));
    return attachments.select({
      nodeId: options.nodeId,
      nodeGeneration: input.discovery.capability.nodeGeneration,
      desktopGeneration: input.discovery.description.desktopGeneration,
      topologyRevision: input.discovery.description.topologyRevision,
      mode: input.mode,
      signal: AbortSignal.any([input.signal, lifetime.signal]),
      onDisconnected: input.onDisconnected
    });
  }

  function close(): Promise<boolean> {
    if (closing) return closing;
    running = false;
    discovery = undefined;
    discoveryRevision++;
    lifetime.abort();
    closing = attachments.close().finally(() => {
      directTransport.close();
      live.close();
      connectionId = undefined;
    });
    return closing;
  }

  live.connect();
  return { discover, select, close };
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new RemoteDesktopClientError('DESKTOP_CONTROL_UNAVAILABLE'));
    };
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}
