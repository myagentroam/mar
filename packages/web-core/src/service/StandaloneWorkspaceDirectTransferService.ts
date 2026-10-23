import type { NodeWorkbenchManifest } from '../model/workbench.js';
import { isComposerAttachmentResourcePath } from '@myagentroam/protocol';
import { createWorkbenchLiveService } from './WorkbenchLiveService.js';
import { createWorkspaceDirectTransferService } from './WorkspaceDirectTransferService.js';
import { readWorkspaceDirectObjectUrl } from './WorkspaceDirectObjectUrlService.js';
import {
  downloadWorkspaceDirectFile,
  type WorkspaceDirectDownloadResult
} from './WorkspaceDirectDownloadStreamService.js';
import {
  readWorkspaceDirectFileMetadata,
  readWorkspaceDirectFileRange,
  type WorkspaceDirectFileIdentity
} from './WorkspaceDirectFileReadService.js';

const INITIAL_DIRECT_WAIT_MS = 800;

export function createStandaloneWorkspaceDirectTransferService(input: {
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly repositoryPath?: string;
  readonly worktreePath?: string;
}) {
  function fileTarget() {
    return {
      ...(input.repositoryPath === undefined ? {} : { repositoryPath: input.repositoryPath }),
      ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath })
    };
  }
  let active = true;
  let generation: string | undefined;
  let initialization = 0;
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
      if (!active || requestId !== initialization) return;
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
      if (active && requestId === initialization) settle(availability === 'DIRECT_AVAILABLE');
    } catch {
      if (active && requestId === initialization) settle(false);
    }
  }

  function settle(available: boolean): void {
    clearTimeout(readyTimer);
    settleReady?.(available);
    settleReady = undefined;
  }

  async function fileOperation(path: string, waitForInitialReady = true) {
    if (isComposerAttachmentResourcePath(path)) return undefined;
    if (waitForInitialReady && !(await ready)) return undefined;
    const nodeGeneration = generation;
    if (
      !active ||
      nodeGeneration === undefined ||
      !direct.isConnected(input.nodeId, nodeGeneration)
    )
      return undefined;
    const resource = {
      kind: 'WORKSPACE_FILE' as const,
      workspaceId: input.workspaceId,
      path,
      ...fileTarget()
    };
    return {
      direct,
      nodeId: input.nodeId,
      nodeGeneration,
      resource,
      metadata: async () => {
        const identity = await readWorkspaceDirectFileMetadata({
          nodeId: input.nodeId,
          resource,
          request: async (url) => {
            const response = await fetch(url, { credentials: 'same-origin' });
            return response.ok ? response.json() : {};
          }
        });
        return active ? identity : undefined;
      }
    };
  }

  async function readRange(
    path: string,
    offset: number,
    length: number,
    identity?: WorkspaceDirectFileIdentity
  ) {
    const target = await fileOperation(path);
    if (target === undefined) return undefined;
    return readWorkspaceDirectFileRange({
      ...target,
      fileName: path.split('/').at(-1) ?? 'file',
      offset,
      length,
      ...(identity === undefined ? {} : { identity })
    }).catch(() => undefined);
  }

  async function objectUrl(path: string) {
    const target = await fileOperation(path);
    return target === undefined ? undefined : readWorkspaceDirectObjectUrl(target);
  }

  async function download(path: string): Promise<WorkspaceDirectDownloadResult> {
    const target = await fileOperation(path, false);
    return target === undefined ? 'UNAVAILABLE' : downloadWorkspaceDirectFile(target);
  }

  function networkChanged(): void {
    direct.invalidateNetwork();
  }

  function close(): void {
    active = false;
    initialization += 1;
    settle(false);
    direct.invalidateNetwork();
    live.close();
  }

  live.connect();
  return { objectUrl, readRange, download, networkChanged, close };
}
