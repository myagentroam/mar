import type { NodeWorkbenchManifest } from '../model/workbench.js';
import type { DirectBrowserMessage, TerminalDirectBrowserMessage } from '@myagentroam/protocol';
import { createActiveNodeTransportService } from './active-node-transport-service.js';
import { createWorkspaceDirectTransferService } from './workspace-direct-transfer-service.js';
import { createTerminalDirectClient } from './terminal-direct-client.js';

interface TransportNode {
  readonly id: string;
  readonly connected: boolean;
  readonly disabled: boolean;
}
interface Options {
  readonly nodes: () => readonly TransportNode[];
  readonly discover: (nodeId: string) => Promise<NodeWorkbenchManifest | undefined>;
  readonly sendDirect: (message: DirectBrowserMessage) => boolean;
  readonly sendTerminalDirect: (message: TerminalDirectBrowserMessage) => boolean;
  readonly onChange: () => void;
}

/** Owns page-local direct transport discovery and lifecycle, not the control connection. */
export function createWorkbenchDirectTransportCoordinator(options: Options) {
  const capabilities = new Map<string, { generation: string; terminalDirect: boolean }>();
  // Promise identity fences stale replies and cleanup, including across reset/re-login.
  const requests = new Map<string, Promise<void>>();
  let connectionId: { readonly id: string } | undefined;
  let disposed = false;
  const workspace = createWorkspaceDirectTransferService({
    send: (message) => connectionId !== undefined && !disposed && options.sendDirect(message),
    onProbeResultChange: options.onChange,
    shouldRetryProbe: (nodeId, generation) =>
      eligible(nodeId) && capabilities.get(nodeId)?.generation === generation
  });
  const terminal = createTerminalDirectClient({
    send: (message) =>
      connectionId !== undefined && !disposed && options.sendTerminalDirect(message),
    acquire: (nodeId) => {
      const capability = capabilities.get(nodeId);
      return !eligible(nodeId) || capability?.terminalDirect !== true
        ? undefined
        : workspace.acquireTerminalTransport(nodeId, capability.generation);
    }
  });
  const activeNodes = createActiveNodeTransportService({
    activate: (nodeId) => {
      void refresh(nodeId);
    },
    release: (nodeId) => {
      requests.delete(nodeId);
      capabilities.delete(nodeId);
      workspace.releaseTransport(nodeId);
      options.onChange();
    }
  });

  function eligible(nodeId: string): boolean {
    return (
      !disposed &&
      connectionId !== undefined &&
      activeNodes.isActive(nodeId) &&
      options.nodes().some((node) => node.id === nodeId && node.connected && !node.disabled)
    );
  }

  function nodeInvalidated(nodeId: string): void {
    requests.delete(nodeId);
    capabilities.delete(nodeId);
    workspace.invalidateNode(nodeId);
    options.onChange();
  }

  function refresh(nodeId: string, force = false): Promise<void> {
    if (!eligible(nodeId)) return Promise.resolve();
    const existing = requests.get(nodeId);
    if (existing !== undefined && !force) return existing;
    const currentConnection = connectionId;
    const task = Promise.resolve()
      .then(async () => {
        if (
          requests.get(nodeId) !== task ||
          connectionId !== currentConnection ||
          !eligible(nodeId)
        )
          return;
        const manifest = await options.discover(nodeId).catch(() => undefined);
        if (
          requests.get(nodeId) !== task ||
          connectionId !== currentConnection ||
          !eligible(nodeId)
        )
          return;
        if (
          manifest?.directTransfer?.apiVersion !== 3 ||
          manifest.directTransfer.transport !== true ||
          typeof manifest.nodeGeneration !== 'string'
        ) {
          nodeInvalidated(nodeId);
          return;
        }
        capabilities.set(nodeId, {
          generation: manifest.nodeGeneration,
          terminalDirect: manifest.terminalDirect?.apiVersion === 1
        });
        void workspace.ensureTransport(nodeId, manifest.nodeGeneration);
        options.onChange();
      })
      .finally(() => {
        if (requests.get(nodeId) === task) requests.delete(nodeId);
      });
    requests.set(nodeId, task);
    return task;
  }

  async function reconcileNodes(): Promise<void> {
    if (disposed) return;
    for (const nodeId of new Set([
      ...capabilities.keys(),
      ...requests.keys(),
      // Expired Nodes may still own a transport retained by a file task or Terminal.
      ...workspace.transportNodeIds()
    ])) {
      const node = options.nodes().find((entry) => entry.id === nodeId);
      if (node === undefined || !node.connected || node.disabled) nodeInvalidated(nodeId);
    }
    const currentConnection = connectionId;
    if (currentConnection === undefined) return;
    const eligibleIds = options
      .nodes()
      .filter((node) => eligible(node.id))
      .map((node) => node.id);
    for (let index = 0; index < eligibleIds.length; index += 3) {
      if (disposed || connectionId !== currentConnection) return;
      await Promise.all(eligibleIds.slice(index, index + 3).map((nodeId) => refresh(nodeId)));
    }
  }

  function connectionLost(): void {
    if (connectionId === undefined) return;
    connectionId = undefined;
    requests.clear();
    capabilities.clear();
    terminal.invalidate();
    workspace.invalidateControlConnection();
    options.onChange();
  }

  function connectionReady(id: string, resumed: boolean): void {
    if (disposed) return;
    if (connectionId !== undefined && connectionId.id !== id) connectionLost();
    connectionId ??= { id };
    if (!resumed) {
      // A new logical connection fences all discovery, even if its public ID is reused.
      connectionId = { id };
      requests.clear();
      capabilities.clear();
      terminal.invalidate();
      workspace.invalidateNetwork();
      options.onChange();
    }
    void reconcileNodes();
  }

  function reset(): void {
    connectionLost();
    activeNodes.clear();
    workspace.close();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    reset();
  }

  function isConnected(nodeId: string): boolean {
    const capability = capabilities.get(nodeId);
    return (
      connectionId !== undefined &&
      !disposed &&
      capability !== undefined &&
      workspace.isConnected(nodeId, capability.generation)
    );
  }

  return {
    workspace: { upload: workspace.upload, download: workspace.download },
    terminal: { attach: terminal.attach },
    handleDirect: workspace.handle,
    handleTerminalDirect: terminal.handle,
    selectNode: (nodeId: string | undefined) => {
      if (!disposed) activeNodes.select(nodeId);
    },
    nodeInvalidated,
    refresh,
    reconcileNodes,
    connectionReady,
    connectionLost,
    reset,
    dispose,
    isConnected,
    networkInfo: (nodeId: string) => {
      const capability = capabilities.get(nodeId);
      return capability === undefined || !isConnected(nodeId)
        ? undefined
        : workspace.networkInfo(nodeId, capability.generation);
    }
  };
}
