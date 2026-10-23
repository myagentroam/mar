import type { MessageFeedback } from '../model/message-feedback.js';
import type { WorkspaceTarget } from '../model/workbench.js';
import type { Ref } from 'vue';
import type { NodeSummary, NodeWorkbenchManifest } from '../model/workbench.js';
import { translate } from './LocalePreferenceService.js';

interface WorkbenchCapabilityServiceOptions {
  readonly nodes: Ref<NodeSummary[]>;
  readonly serverVersion: Ref<string>;
  readonly manifest: Ref<NodeWorkbenchManifest | undefined>;
  readonly manifestLoading: Ref<boolean>;
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly onNodeConnected?: (nodeId: string) => void;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly notice: MessageFeedback;
  readonly errorMessage: (error: unknown) => string;
}

export function createWorkbenchCapabilityService(options: WorkbenchCapabilityServiceOptions) {
  const manifestsByNode = new Map<string, NodeWorkbenchManifest>();
  const manifestRequestsByNode = new Map<string, number>();
  let manifestRequest = 0;
  let nodesRequest = 0;

  function restoreNodeManifest(nodeId: string): NodeWorkbenchManifest | undefined {
    return manifestsByNode.get(nodeId);
  }

  function clearNodeManifest(nodeId: string): void {
    manifestsByNode.delete(nodeId);
    if (options.workspaceTarget.value?.nodeId === nodeId) options.manifest.value = undefined;
  }

  function invalidateNodeManifest(nodeId: string): void {
    manifestRequestsByNode.delete(nodeId);
    clearNodeManifest(nodeId);
    if (options.workspaceTarget.value?.nodeId === nodeId) options.manifestLoading.value = false;
  }

  function retainNodeManifests(nodeIds: ReadonlySet<string>): void {
    for (const nodeId of new Set([...manifestsByNode.keys(), ...manifestRequestsByNode.keys()]))
      if (!nodeIds.has(nodeId)) {
        manifestsByNode.delete(nodeId);
        manifestRequestsByNode.delete(nodeId);
      }
  }

  async function refreshNodes(): Promise<void> {
    const requestId = ++nodesRequest;
    try {
      const next = (await options.request<{ nodes: NodeSummary[] }>('/api/nodes')).nodes;
      if (requestId !== nodesRequest) return;
      const disconnected = new Set(
        options.nodes.value.filter((node) => !node.connected).map((node) => node.id)
      );
      options.nodes.value = next;
      for (const node of next)
        if (node.connected && disconnected.has(node.id)) options.onNodeConnected?.(node.id);
    } catch (error) {
      if (requestId !== nodesRequest) return;
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
      options.serverVersion.value =
        typeof capabilities.serverVersion === 'string' && capabilities.serverVersion.length > 0
          ? `v${capabilities.serverVersion.replace(/^v/i, '')}`
          : '';
    } catch {
      options.serverVersion.value = '';
    }
  }

  async function refreshNodeManifest(nodeId: string): Promise<void> {
    const requestId = ++manifestRequest;
    manifestRequestsByNode.set(nodeId, requestId);
    const current = () => manifestRequestsByNode.get(nodeId) === requestId;
    if (options.workspaceTarget.value?.nodeId === nodeId)
      options.manifestLoading.value = options.manifest.value === undefined;
    try {
      const result = await options.request<{ manifest: NodeWorkbenchManifest }>(
        `/api/nodes/${encodeURIComponent(nodeId)}/workbench-capabilities`
      );
      if (current()) {
        manifestsByNode.set(nodeId, result.manifest);
        if (options.workspaceTarget.value?.nodeId === nodeId)
          options.manifest.value = result.manifest;
      }
    } catch {
      if (current()) clearNodeManifest(nodeId);
    } finally {
      if (current() && options.workspaceTarget.value?.nodeId === nodeId)
        options.manifestLoading.value = false;
    }
  }

  return {
    refreshNodes,
    refreshServerCapabilities,
    refreshNodeManifest,
    restoreNodeManifest,
    invalidateNodeManifest,
    retainNodeManifests
  };
}
