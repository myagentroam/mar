import { ref, type Ref } from 'vue';
import type {
  NodeSummary,
  NodeWorkbenchManifest,
  Session,
  Workspace,
  WorkspaceTarget
} from '../model/workbench.js';

export function createWorkbenchSelectionStateService<
  WorkspaceType extends Workspace = Workspace
>() {
  const workspaceTarget = ref<WorkspaceTarget>();
  return {
    nodes: ref<NodeSummary[]>([]),
    serverVersion: ref(''),
    workspaces: ref<Workspace[]>([]) as Ref<WorkspaceType[]>,
    sessions: ref<Session[]>([]),
    workspaceTarget,
    selectedSessionId: ref<string>(),
    nodeManifest: ref<NodeWorkbenchManifest>(),
    loading: ref(false)
  };
}
