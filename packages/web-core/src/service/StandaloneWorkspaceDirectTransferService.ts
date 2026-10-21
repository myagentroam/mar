import type { NodeWorkbenchManifest } from '../model/workbench.js';
import { isComposerAttachmentResourcePath } from '@myagentroam/protocol';
import { createWorkbenchLiveService } from './WorkbenchLiveService.js';
import { createWorkspaceDirectTransferService } from './WorkspaceDirectTransferService.js';
import { createWorkspaceDirectObjectUrlSink } from './WorkspaceDirectObjectUrlService.js';
import {
  createWorkspaceDirectDownloadStream,
  type WorkspaceDirectDownloadResult
} from './WorkspaceDirectDownloadStreamService.js';
import {
  readWorkspaceDirectFileRange,
  type WorkspaceDirectFileIdentity
} from './WorkspaceDirectFileReadService.js';

const INITIAL_DIRECT_WAIT_MS = 800;

export function createStandaloneWorkspaceDirectTransferService(input: {
  readonly nodeId: string;
  readonly workspaceId: string;
}) {
  let active = true;
  let generation: string | undefined;
  let settleReady: ((available: boolean) => void) | undefined;
  const ready = new Promise<boolean>((resolve) => {
    settleReady = resolve;
  });
  const readyTimer = setTimeout(() => settleReady?.(false), INITIAL_DIRECT_WAIT_MS);
  const direct = createWorkspaceDirectTransferService({
    send: (message) => live.sendDirect(message),
    shouldRetryProbe: (nodeId, nodeGeneration) =>
      active && nodeId === input.nodeId && nodeGeneration === generation
  });
  const live = createWorkbenchLiveService({
    canConnect: () => active,
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

  async function initialize(): Promise<void> {
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
      settle((await direct.ensureTransport(input.nodeId, generation)) === 'DIRECT_AVAILABLE');
    } catch {
      settle(false);
    }
  }

  function settle(available: boolean): void {
    clearTimeout(readyTimer);
    settleReady?.(available);
    settleReady = undefined;
  }

  async function metadata(path: string, waitForInitialReady = true) {
    if (isComposerAttachmentResourcePath(path)) return undefined;
    if (waitForInitialReady && !(await ready)) return undefined;
    if (generation === undefined || !direct.isConnected(input.nodeId, generation)) return undefined;
    const parameters = new URLSearchParams({ nodeId: input.nodeId, path });
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(input.workspaceId)}/files/direct-metadata?${parameters.toString()}`,
      { credentials: 'same-origin' }
    );
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      readonly file?: {
        readonly size?: unknown;
        readonly revision?: unknown;
      };
    };
    return typeof body.file?.size === 'number' && typeof body.file.revision === 'string'
      ? {
          size: body.file.size,
          revision: body.file.revision,
          generation
        }
      : undefined;
  }

  async function readRange(
    path: string,
    offset: number,
    length: number,
    identity?: WorkspaceDirectFileIdentity
  ) {
    if (isComposerAttachmentResourcePath(path)) return undefined;
    if (!(await ready) || generation === undefined) return undefined;
    return readWorkspaceDirectFileRange({
      direct,
      nodeId: input.nodeId,
      nodeGeneration: generation,
      resource: { kind: 'WORKSPACE_FILE', workspaceId: input.workspaceId, path },
      fileName: path.split('/').at(-1) ?? 'file',
      offset,
      length,
      ...(identity === undefined ? {} : { identity }),
      metadata: () => metadata(path)
    }).catch(() => undefined);
  }

  async function objectUrl(
    path: string
  ): Promise<
    { readonly url: string; readonly size: number; readonly revision: string } | undefined
  > {
    const value = await metadata(path).catch(() => undefined);
    if (value === undefined) return undefined;
    try {
      const target = await createWorkspaceDirectObjectUrlSink(path.split('/').at(-1) ?? 'file');
      await direct.download({
        nodeId: input.nodeId,
        nodeGeneration: value.generation,
        descriptor: {
          direction: 'DOWNLOAD',
          resource: { kind: 'WORKSPACE_FILE', workspaceId: input.workspaceId, path },
          fileName: path.split('/').at(-1) ?? 'file',
          revision: value.revision,
          size: value.size
        },
        sink: target.sink
      });
      return {
        url: await target.objectUrl(),
        size: value.size,
        revision: value.revision
      };
    } catch {
      return undefined;
    }
  }

  async function download(path: string): Promise<WorkspaceDirectDownloadResult> {
    if (generation === undefined || !direct.isConnected(input.nodeId, generation))
      return 'UNAVAILABLE';
    const value = await metadata(path, false).catch(() => undefined);
    if (value === undefined) return 'UNAVAILABLE';
    const fileName = path.split('/').at(-1) ?? 'download';
    let target: Awaited<ReturnType<typeof createWorkspaceDirectDownloadStream>> | undefined;
    try {
      target = await createWorkspaceDirectDownloadStream(fileName, value.size);
      await direct.download({
        nodeId: input.nodeId,
        nodeGeneration: value.generation,
        descriptor: {
          direction: 'DOWNLOAD',
          resource: { kind: 'WORKSPACE_FILE', workspaceId: input.workspaceId, path },
          fileName,
          revision: value.revision,
          size: value.size
        },
        sink: target.sink,
        signal: target.signal
      });
      return 'COMPLETED';
    } catch {
      if (target?.cancelled() === true) return 'CANCELLED';
      return target?.started() === true ? 'FAILED' : 'UNAVAILABLE';
    }
  }

  function networkChanged(): void {
    direct.invalidateNetwork();
  }

  function close(): void {
    active = false;
    settle(false);
    direct.invalidateNetwork();
    live.close();
  }

  live.connect();
  return { objectUrl, readRange, download, networkChanged, close };
}
