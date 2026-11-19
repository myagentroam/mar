import type { RunnerUsage, RunnerUsageName } from '../model/runner-usage.js';
import type { MessageFeedback } from '../model/message-feedback.js';
import type {
  WorkspaceTarget,
  NodeSummary,
  NodeWorkbenchManifest,
  Workspace
} from '../model/workbench.js';
import { computed, ref, type Ref } from 'vue';
import type { NodeUpgradeProgress } from '../model/node-upgrade.js';
import { translate } from './locale-preference-service.js';
import { errorCode } from '../util/api-error.js';

interface WorkbenchCapabilityServiceOptions {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly onNodeConnected?: (nodeId: string) => void;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly notice: MessageFeedback;
  readonly isNetworkUnavailable: () => boolean;
  readonly errorMessage: (error: unknown) => string;
}

const INITIAL_NODE_LIST_TIMEOUT_MS = 15_000;

/** Owns the account's authoritative Node inventory and cached workbench capabilities. */
export function createWorkbenchCapabilityService<WorkspaceType extends Workspace = Workspace>(
  options: WorkbenchCapabilityServiceOptions
) {
  const nodes = ref<NodeSummary[]>([]);
  const nodeListConfirmed = ref(false);
  const serverVersion = ref('');
  const workspaces = ref<WorkspaceType[]>([]) as Ref<WorkspaceType[]>;
  const manifest = ref<NodeWorkbenchManifest>();
  const manifestLoading = ref(false);
  const upgradeProgress = ref<Readonly<Record<string, NodeUpgradeProgress | null>>>({});
  const manifestsByNode = new Map<string, NodeWorkbenchManifest>();
  const manifestRequestsByNode = new Map<string, number>();
  let manifestRequest = 0;
  let nodesRequest = 0;
  let initialNodesRequest: Promise<void> | undefined;
  let initialNodeConnections: Map<string, boolean> | undefined;

  function applyUpgrade(nodeId: string, progress: NodeUpgradeProgress | null): void {
    upgradeProgress.value = { ...upgradeProgress.value, [nodeId]: progress };
    nodes.value = nodes.value.map((node) =>
      node.id === nodeId ? { ...node, upgradeProgress: progress } : node
    );
  }

  function replaceNode(node: NodeSummary): void {
    nodes.value = nodes.value.map((current) => (current.id === node.id ? node : current));
  }
  function removeNode(nodeId: string): void {
    nodes.value = nodes.value.filter((node) => node.id !== nodeId);
  }
  function setNodeConnection(nodeId: string, connected: boolean): boolean {
    initialNodeConnections?.set(nodeId, connected);
    const wasConnected = nodes.value.some((node) => node.id === nodeId && node.connected);
    nodes.value = nodes.value.map((node) => (node.id === nodeId ? { ...node, connected } : node));
    return wasConnected;
  }
  function replaceWorkspaces(values: readonly WorkspaceType[]): void {
    workspaces.value = [...values];
  }

  function clearUpgradeProgress(): void {
    upgradeProgress.value = {};
  }

  function resetResources(): void {
    nodesRequest += 1;
    initialNodesRequest = undefined;
    initialNodeConnections = undefined;
    nodeListConfirmed.value = false;
    nodes.value = [];
    serverVersion.value = '';
    clearUpgradeProgress();
  }

  function restoreNodeManifest(nodeId: string): NodeWorkbenchManifest | undefined {
    return manifestsByNode.get(nodeId);
  }

  function clearNodeManifest(nodeId: string): void {
    manifestsByNode.delete(nodeId);
    if (options.workspaceTarget.value?.nodeId === nodeId) manifest.value = undefined;
  }

  function invalidateNodeManifest(nodeId: string): void {
    manifestRequestsByNode.delete(nodeId);
    clearNodeManifest(nodeId);
    if (options.workspaceTarget.value?.nodeId === nodeId) manifestLoading.value = false;
  }

  function retainNodeManifests(nodeIds: ReadonlySet<string>): void {
    for (const nodeId of new Set([...manifestsByNode.keys(), ...manifestRequestsByNode.keys()]))
      if (!nodeIds.has(nodeId)) {
        manifestsByNode.delete(nodeId);
        manifestRequestsByNode.delete(nodeId);
      }
  }

  function refreshNodes(): Promise<void> {
    if (nodeListConfirmed.value) return readNodes();
    if (initialNodesRequest !== undefined) return initialNodesRequest;
    // The startup caller and any concurrent refresh must see the same first result.
    const connections = (initialNodeConnections = new Map<string, boolean>());
    const pending = readNodes(
      { signal: AbortSignal.timeout(INITIAL_NODE_LIST_TIMEOUT_MS) },
      connections
    ).finally(() => {
      if (initialNodesRequest !== pending) return;
      initialNodesRequest = undefined;
      initialNodeConnections = undefined;
    });
    initialNodesRequest = pending;
    return pending;
  }

  async function readNodes(
    init?: RequestInit,
    connections?: ReadonlyMap<string, boolean>
  ): Promise<void> {
    const requestId = ++nodesRequest;
    try {
      const inventory = (await options.request<{ nodes: NodeSummary[] }>('/api/nodes', init)).nodes;
      if (requestId !== nodesRequest) return;
      if (!Array.isArray(inventory)) throw new Error('Invalid Node list response.');
      // Live events can arrive before the first inventory is published; retain their connection
      // facts without treating them as proof that an unlisted Node is visible to this account.
      const next = connections?.size
        ? inventory.map((node) => ({
            ...node,
            connected: connections.get(node.id) ?? node.connected
          }))
        : inventory;
      const disconnected = new Set(
        nodes.value.filter((node) => !node.connected).map((node) => node.id)
      );
      nodes.value = next;
      nodeListConfirmed.value = true;
      for (const node of next)
        if (node.connected && disconnected.has(node.id)) options.onNodeConnected?.(node.id);
    } catch (error) {
      if (requestId !== nodesRequest) return;
      // The Work surface owns initial-load error feedback and offers retry.
      if (!nodeListConfirmed.value) return;
      if (errorCode(error) === 'NETWORK_UNAVAILABLE' && options.isNetworkUnavailable()) return;
      options.notice(
        translate('generated.workbenchCapabilityService.unableToLoadNodes', {
          value0: options.errorMessage(error)
        }),
        'error',
        error
      );
    }
  }

  async function refreshServerCapabilities(): Promise<void> {
    try {
      const capabilities = await options.request<{ serverVersion?: unknown }>(
        '/api/workbench-capabilities'
      );
      serverVersion.value =
        typeof capabilities.serverVersion === 'string' && capabilities.serverVersion.length > 0
          ? `v${capabilities.serverVersion.replace(/^v/i, '')}`
          : '';
    } catch {
      serverVersion.value = '';
    }
  }

  async function refreshNodeManifest(nodeId: string, throwOnError = false): Promise<void> {
    const requestId = ++manifestRequest;
    manifestRequestsByNode.set(nodeId, requestId);
    const current = () => manifestRequestsByNode.get(nodeId) === requestId;
    if (options.workspaceTarget.value?.nodeId === nodeId)
      manifestLoading.value = manifest.value === undefined;
    try {
      const result = await options.request<{ manifest: NodeWorkbenchManifest }>(
        `/api/nodes/${encodeURIComponent(nodeId)}/workbench-capabilities`
      );
      if (current()) {
        manifestsByNode.set(nodeId, result.manifest);
        if (options.workspaceTarget.value?.nodeId === nodeId) manifest.value = result.manifest;
      }
    } catch (error) {
      if (current()) {
        clearNodeManifest(nodeId);
        if (throwOnError) throw error;
      }
    } finally {
      if (current() && options.workspaceTarget.value?.nodeId === nodeId)
        manifestLoading.value = false;
    }
  }

  function selectNode(nodeId?: string): void {
    manifest.value = nodeId === undefined ? undefined : restoreNodeManifest(nodeId);
    manifestLoading.value = nodeId !== undefined && manifest.value === undefined;
  }

  return {
    nodes: computed(() => nodes.value),
    nodeListConfirmed: computed(() => nodeListConfirmed.value),
    serverVersion: computed(() => serverVersion.value),
    workspaces: computed(() => workspaces.value),
    replaceNode,
    removeNode,
    setNodeConnection,
    replaceWorkspaces,
    manifest: computed(() => manifest.value),
    manifestLoading: computed(() => manifestLoading.value),
    upgradeProgress: computed(() => upgradeProgress.value),
    applyUpgrade,
    clearUpgradeProgress,
    resetResources,
    selectNode,
    refreshNodes,
    refreshServerCapabilities,
    refreshNodeManifest,
    restoreNodeManifest,
    invalidateNodeManifest,
    retainNodeManifests
  };
}

export interface WorkbenchResourcesView {
  onlineNodeCount: number;
  serverVersion: string;
  nodeUpgradeProgress: Readonly<Record<string, NodeUpgradeProgress | null>>;
  nodeDetails: NodeSummary | undefined;
  nodeDetailsDialogOpen: boolean;
  nodeLabel: (node: NodeSummary) => string;
  nodeManifest: NodeWorkbenchManifest | undefined;
  nodeManifestLoading: boolean;
  nodeReady: boolean;
  nodes: NodeSummary[];
  refreshNodes: () => Promise<void>;
  runnerUsageDetails: RunnerUsage | undefined;
  runnerUsageDialogOpen: boolean;
  runnerUsageDisabledReason: (runner: RunnerUsageName) => string;
  runnerUsageLoading: RunnerUsageName | undefined;
  workspaceHost: NodeSummary | undefined;
  selectedNodeStatus: string | undefined;
  selectedWorkspace: Workspace | undefined;
  showNodeDetails: (node: NodeSummary) => void;
  showRunnerUsage: (runner: RunnerUsageName) => Promise<void>;
  workspaceBranchLabel: (workspace: Workspace) => string | undefined;
  workspaceDirectAvailable: (nodeId: string) => boolean;
  workspaceDirectDescription: (nodeId: string) => string | undefined;
  workspaceLocalFileManagerAvailable: boolean;
  workspaceKindLabel: (workspace: Workspace) => string;
}

export function createSelectedNodeStatus(input: {
  readonly host: Readonly<
    import('vue').Ref<import('../model/workbench.js').NodeSummary | undefined>
  >;
  readonly manifest: Readonly<
    import('vue').Ref<import('../model/workbench.js').NodeWorkbenchManifest | undefined>
  >;
  readonly loading: Readonly<import('vue').Ref<boolean>>;
}) {
  const workspaceHost = input.host;
  const nodeManifest = input.manifest;
  const nodeManifestLoading = input.loading;
  const selectedNodeStatus = computed<string | undefined>(() => {
    if (workspaceHost.value === undefined)
      return translate('generated.workbenchPageController.noNodeSelected');
    if (workspaceHost.value.disabled)
      return translate('generated.workbenchPageController.theNodeIsDisabledOnlyTheCurrent');
    if (!workspaceHost.value.connected)
      return translate('generated.workbenchPageController.theNodeIsOfflineLoadedContentIs');
    if (nodeManifestLoading.value) return undefined;
    if (nodeManifest.value === undefined) return undefined;
    if (nodeManifest.value.manifestVersion !== 1 || !nodeManifest.value.conversation.available)
      return translate(
        'generated.workbenchPageController.nodeWorkbenchCapabilitiesAreUnavailable',
        { value0: nodeManifest.value.conversation.reasonCode ?? 'INCOMPATIBLE_VERSION' }
      );
    return undefined;
  });

  return selectedNodeStatus;
}
