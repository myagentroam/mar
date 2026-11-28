import type { WorkspaceDirectFileIdentity } from '../model/workspace-direct-file.js';
import type { NodeWorkbenchManifest } from '../model/workbench.js';
import { createWorkbenchLiveService } from './workbench-live-service.js';
import { createWorkspaceDirectTransferService } from './workspace-direct-transfer-service.js';
import { readWorkspaceFileObjectUrl } from './workspace-direct-object-url-service.js';
import { MAX_BINARY_PREVIEW_BYTES } from '../util/file-preview.js';
import { downloadWorkspaceFileToBrowser } from './workspace-direct-download-stream-service.js';
import type { ScopedHttpService } from './scoped-http-service.js';
import { createWorkbenchNodeConnectionService } from './workbench-node-connection-service.js';
import { createWorkspaceFileStreamClient } from './workspace-file-stream-client.js';
import {
  readWorkspaceDirectFileMetadata,
  readWorkspaceFileRange
} from './workspace-direct-file-read-service.js';

const INITIAL_DIRECT_WAIT_MS = 800;

/** Owns the independent window's transport and download lifetime, not its preview state. */
export function createStandaloneWorkspaceDirectTransferService(input: {
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly repositoryPath?: string;
  readonly worktreePath?: string;
  readonly activeDownloadWorker?: () => Promise<ServiceWorker | undefined>;
  readonly http: ScopedHttpService;
  readonly fileStreams?: ReturnType<typeof createWorkspaceFileStreamClient>;
}) {
  function fileResource(path: string) {
    return {
      kind: 'WORKSPACE_FILE' as const,
      workspaceId: input.workspaceId,
      path,
      ...(input.repositoryPath === undefined ? {} : { repositoryPath: input.repositoryPath }),
      ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath })
    };
  }
  const lifetime = new AbortController();
  const active = () => !lifetime.signal.aborted;
  const { http } = input;
  let generation: string | undefined;
  let initialization = 0;
  let settleReady: ((available: boolean) => void) | undefined;
  const ready = new Promise<boolean>((resolve) => {
    settleReady = resolve;
  });
  const readyTimer =
    input.fileStreams === undefined
      ? setTimeout(() => settleReady?.(false), INITIAL_DIRECT_WAIT_MS)
      : undefined;
  const direct = createWorkspaceDirectTransferService({
    send: (message) => live.sendDirect(message),
    onTransportReady: (nodeId) => void connections.directReady(nodeId),
    shouldRetryProbe: (nodeId, nodeGeneration) =>
      active() && nodeId === input.nodeId && nodeGeneration === generation
  });
  const live = createWorkbenchLiveService({
    canConnect: active,
    onEvent: () => undefined,
    onResyncRequired: () => undefined,
    onNodeConnection: (nodeId, connected) => {
      if (nodeId === input.nodeId && !connected) direct.invalidateNode(nodeId);
    },
    onNodeReplaced: (nodeId) => direct.invalidateNode(nodeId),
    onReconnect: () => undefined,
    onDisconnected: () => direct.invalidateControlConnection(),
    onReady: (_connectionId, resumed) => {
      if (!resumed) direct.invalidateNetwork();
      void initialize();
    },
    onDirectMessage: (message) => direct.handle(message),
    onUnauthenticated: () => settle(false),
    onInvalidMessage: () => undefined
  });
  const connections = createWorkbenchNodeConnectionService({
    http,
    // Like the selected Workspace, this window owns its single target until close.
    isNodeActive: active,
    async connectDirect(nodeId, signal) {
      // Reuse a warm peer; on a cold start the bounded ICE probe races Relay.
      if (generation === undefined || !direct.isConnected(nodeId, generation)) await ready;
      signal.throwIfAborted();
      const nodeGeneration = generation;
      if (nodeGeneration === undefined) throw new Error('NODE_DIRECT_UNAVAILABLE');
      const transport = direct.acquireTerminalTransport(nodeId, nodeGeneration);
      if (transport === undefined) throw new Error('NODE_DIRECT_UNAVAILABLE');
      try {
        const path = transport.streamPath;
        if (path === undefined) throw new Error('NODE_DIRECT_UNAVAILABLE');
        return {
          get closed() {
            return path.closed;
          },
          close: transport.release,
          openStream: (request, opening) =>
            request.kind === 'file-upload' || request.kind === 'file-download'
              ? direct.openFileStream(nodeId, nodeGeneration, request.descriptor, opening)
              : Promise.resolve(undefined)
        };
      } catch (error) {
        transport.release();
        throw error;
      }
    }
  });
  const files = input.fileStreams ?? createWorkspaceFileStreamClient(connections.openRoutedStream);

  async function initialize(): Promise<void> {
    const requestId = ++initialization;
    try {
      const manifestResponse = await fetch(
        `/api/nodes/${encodeURIComponent(input.nodeId)}/workbench-capabilities`,
        { credentials: 'same-origin' }
      );
      if (!manifestResponse.ok) throw new Error('DIRECT_UNAVAILABLE');
      const body = (await manifestResponse.json()) as {
        readonly manifest?: NodeWorkbenchManifest;
      };
      const manifest = body.manifest;
      if (!active() || requestId !== initialization) return;
      if (
        manifest?.directTransfer?.apiVersion !== 3 ||
        manifest.directTransfer.transport !== true ||
        manifest.directTransfer.download !== true ||
        typeof manifest.nodeGeneration !== 'string'
      ) {
        settle(false);
        return;
      }
      generation = manifest.nodeGeneration;
      const availability = await direct.ensureTransport(input.nodeId, generation);
      if (active() && requestId === initialization) settle(availability === 'DIRECT_AVAILABLE');
    } catch {
      if (active() && requestId === initialization) settle(false);
    }
  }

  function settle(available: boolean): void {
    clearTimeout(readyTimer);
    settleReady?.(available);
    settleReady = undefined;
  }

  async function readRange(
    path: string,
    offset: number,
    length: number,
    identity?: WorkspaceDirectFileIdentity
  ) {
    const resource = fileResource(path);
    // All non-native reads share the download carrier; a stream failure is not an HTTP retry.
    return readWorkspaceFileRange(
      {
        resource,
        fileName: path.split('/').at(-1) ?? 'file',
        offset,
        length,
        ...(identity === undefined ? {} : { identity }),
        signal: lifetime.signal,
        metadata: () => metadata(resource)
      },
      (transfer) => files.download({ ...transfer, nodeId: input.nodeId })
    );
  }

  async function objectUrl(path: string) {
    const resource = fileResource(path);
    const identity = await metadata(resource);
    if (identity.size > MAX_BINARY_PREVIEW_BYTES) return { ...identity, url: undefined };
    const signal = lifetime.signal;
    const fileName = path.split('/').at(-1) ?? 'file';
    const url = await readWorkspaceFileObjectUrl(fileName, signal, (sink) =>
      files.download({
        nodeId: input.nodeId,
        descriptor: { direction: 'DOWNLOAD', resource, fileName, ...identity },
        sink,
        signal
      })
    );
    return { url, ...identity };
  }

  async function metadata(resource: ReturnType<typeof fileResource>) {
    const signal = lifetime.signal;
    signal.throwIfAborted();
    const identity = await readWorkspaceDirectFileMetadata({
      request: http.request,
      nodeId: input.nodeId,
      resource,
      signal
    });
    signal.throwIfAborted();
    if (identity === undefined) throw new Error('NODE_RESPONSE_INVALID');
    return identity;
  }

  async function download(path: string): Promise<'COMPLETED' | 'CANCELLED'> {
    const signal = lifetime.signal;
    const resource = fileResource(path);
    const identity = await metadata(resource);
    const fileName = path.split('/').at(-1) ?? 'download';
    return downloadWorkspaceFileToBrowser({
      fileName,
      size: identity.size,
      ...(input.activeDownloadWorker === undefined
        ? {}
        : { activeWorker: input.activeDownloadWorker }),
      download: (sink, cancellation) =>
        files.download({
          nodeId: input.nodeId,
          descriptor: { direction: 'DOWNLOAD', resource, fileName, ...identity },
          sink,
          signal: cancellation === undefined ? signal : AbortSignal.any([signal, cancellation])
        })
    });
  }

  function networkChanged(): void {
    direct.invalidateNetwork();
  }

  function close(): void {
    lifetime.abort();
    settle(false);
    connections.reset();
    direct.invalidateNetwork();
    live.close();
  }

  if (input.fileStreams === undefined) live.connect();
  return { objectUrl, readRange, download, networkChanged, close };
}
