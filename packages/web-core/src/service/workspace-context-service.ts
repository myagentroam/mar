/**
 * Read-only resource context, derived only from target, catalog and capability owners.
 * Available before Panes connect; it owns no selection mutations, requests or lifecycle.
 * Pane/page presentation may depend on this context, never the other way around.
 */
import { computed, type Ref } from 'vue';
import type {
  NodeSummary,
  NodeWorkbenchManifest,
  Workspace,
  WorkspaceTarget
} from '../model/workbench.js';

interface WorkspaceEnvironmentOptions {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly nodes: Readonly<Ref<readonly NodeSummary[]>>;
  readonly nodeManifest: Readonly<Ref<NodeWorkbenchManifest | undefined>>;
}

/** Read-only resource projections are available before any Pane is connected. */
export function createWorkspaceEnvironment(options: WorkspaceEnvironmentOptions) {
  const workspaceHost = computed(() =>
    options.nodes.value.find((node) => node.id === options.workspaceTarget.value?.nodeId)
  );
  const nodeReady = computed(
    () =>
      workspaceHost.value?.connected === true &&
      workspaceHost.value.disabled !== true &&
      options.nodeManifest.value?.manifestVersion === 1 &&
      options.nodeManifest.value.conversation.available
  );
  const filesReady = computed(
    () => nodeReady.value && options.nodeManifest.value?.files?.available === true
  );
  const terminalReady = computed(
    () =>
      nodeReady.value &&
      options.nodeManifest.value?.terminal?.available === true &&
      options.nodeManifest.value.terminal.supportsReplay === true
  );
  return { workspaceHost, nodeReady, filesReady, terminalReady };
}

export function createWorkbenchWorkspaceContext(
  options: WorkspaceEnvironmentOptions & {
    readonly workspaces: Readonly<Ref<readonly Workspace[]>>;
  }
) {
  return {
    ...createWorkspaceEnvironment(options),
    selectedWorkspace: computed(() =>
      options.workspaces.value.find(
        (workspace) => workspace.id === options.workspaceTarget.value?.workspaceId
      )
    )
  };
}
