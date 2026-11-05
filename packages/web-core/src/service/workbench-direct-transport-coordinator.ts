import { computed, ref, watch } from 'vue';
import { translate } from './locale-preference-service.js';
import type { NodeWorkbenchManifest } from '../model/workbench.js';
import type { DirectBrowserMessage, TerminalDirectBrowserMessage } from '@myagentroam/protocol';
import { createActiveNodeTransportService } from './active-node-transport-service.js';
import { createWorkspaceDirectTransferService } from './workspace-direct-transfer-service.js';
import { createTerminalDirectClient } from './terminal-direct-client.js';

interface TransportNode {
  readonly id: string;
  readonly connected: boolean;
  readonly disabled: boolean;
  readonly nodeAppVersion?: string;
}
interface Options {
  readonly nodes: () => readonly TransportNode[];
  readonly discover: (nodeId: string) => Promise<NodeWorkbenchManifest | undefined>;
  readonly sendDirect: (message: DirectBrowserMessage) => boolean;
  readonly sendTerminalDirect: (message: TerminalDirectBrowserMessage) => boolean;
  readonly selectedNode: () => string | undefined;
}

/** Owns page-local direct transport discovery and lifecycle, not the control connection. */
export function createWorkbenchDirectTransportCoordinator(options: Options) {
  const workspaceDirectProbeRevision = ref(0);
  const onChange = () => {
    workspaceDirectProbeRevision.value += 1;
  };
  const capabilities = new Map<string, { generation: string; terminalDirect: boolean }>();
  // Promise identity fences stale replies and cleanup, including across reset/re-login.
  const requests = new Map<string, Promise<void>>();
  let connectionId: { readonly id: string } | undefined;
  let disposed = false;
  const workspace = createWorkspaceDirectTransferService({
    send: (message) => connectionId !== undefined && !disposed && options.sendDirect(message),
    onProbeResultChange: onChange,
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
      onChange();
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
    onChange();
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
        onChange();
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
    onChange();
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
      onChange();
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
    stopNodeWatch();
    stopSelectionWatch();
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

  function networkInfo(nodeId: string) {
    const capability = capabilities.get(nodeId);
    return capability === undefined || !isConnected(nodeId)
      ? undefined
      : workspace.networkInfo(nodeId, capability.generation);
  }
  const directTransportEligibilityKey = computed(() =>
    options
      .nodes()
      .map(
        (node) =>
          `${node.id}\0${node.connected ? '1' : '0'}\0${node.disabled ? '1' : '0'}\0${node.nodeAppVersion}`
      )
      .join('\n')
  );
  const stopNodeWatch = watch(directTransportEligibilityKey, () => void reconcileNodes());
  const stopSelectionWatch = watch(
    options.selectedNode,
    (nodeId) => {
      activeNodes.select(nodeId);
    },
    { immediate: true, flush: 'sync' }
  );

  const workspaceDirectAvailable = (nodeId: string): boolean => {
    void workspaceDirectProbeRevision.value;
    return isConnected(nodeId);
  };

  const workspaceDirectDescription = (nodeId: string): string | undefined => {
    if (!workspaceDirectAvailable(nodeId)) return undefined;
    const info = networkInfo(nodeId);
    if (info === undefined) return translate('workspaceTabs.directAvailable');
    const scope = translate(
      `workspaceTabs.networkScope.${info.scope.toLowerCase()}` as
        | 'workspaceTabs.networkScope.loopback'
        | 'workspaceTabs.networkScope.private'
        | 'workspaceTabs.networkScope.public'
        | 'workspaceTabs.networkScope.vpn_tun'
        | 'workspaceTabs.networkScope.unknown'
    );
    const ipVersion =
      info.ipVersion === 'UNKNOWN'
        ? ''
        : translate(
            `workspaceTabs.ipVersion.${info.ipVersion.toLowerCase()}` as
              'workspaceTabs.ipVersion.ipv4' | 'workspaceTabs.ipVersion.ipv6'
          );
    const protocol = info.protocol === 'UNKNOWN' ? '' : info.protocol;
    const interfaceType =
      info.interfaceType === 'UNKNOWN' ||
      (info.scope === 'VPN_TUN' && info.interfaceType === 'VPN') ||
      (info.scope === 'LOOPBACK' && info.interfaceType === 'LOOPBACK')
        ? ''
        : translate(
            `workspaceTabs.interfaceType.${info.interfaceType.toLowerCase()}` as
              | 'workspaceTabs.interfaceType.ethernet'
              | 'workspaceTabs.interfaceType.wifi'
              | 'workspaceTabs.interfaceType.cellular'
              | 'workspaceTabs.interfaceType.vpn'
              | 'workspaceTabs.interfaceType.loopback'
          );
    return translate('workspaceTabs.directAvailableWithNetwork', {
      network: [scope, ipVersion, protocol, interfaceType].filter(Boolean).join(' ')
    });
  };

  const workspaceLocalFileManagerAvailable = computed(() => {
    void workspaceDirectProbeRevision.value;
    const nodeId = options.selectedNode();
    return nodeId !== undefined && networkInfo(nodeId)?.scope === 'LOOPBACK';
  });

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
    networkInfo,
    workspaceDirectAvailable,
    workspaceDirectDescription,
    workspaceLocalFileManagerAvailable
  };
}
