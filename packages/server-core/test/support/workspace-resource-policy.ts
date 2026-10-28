import type { WorkspaceResourcePolicy } from '../../src/workspace-route-contracts.js';

/** Permissive route fixture; policy behavior is tested with explicit injected implementations. */
export function personalWorkspacePolicy(): WorkspaceResourcePolicy {
  return {
    projectNodeWorkspaces: async (_userId, _nodeId, workspaces) => workspaces,
    resolveWorkspaceOwnership: async (userId, _nodeId, requested) =>
      requested ?? { ownerType: 'PERSONAL', ownerUserId: userId },
    registerWorkspace: async () => undefined,
    assertCanManageWorkspace: async () => undefined,
    assertCanUnregisterWorkspace: async () => undefined,
    unregisterWorkspace: async () => undefined,
    updateWorkspaceGroupName: async () => undefined,
    updateWorkspace: async () => undefined
  };
}
