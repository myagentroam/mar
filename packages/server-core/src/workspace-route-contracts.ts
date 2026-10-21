import type { ResourceOwnership } from '@myagentroam/protocol';
import type { UserNodeAuthorization } from './node-request-channel.js';

export interface WorkspaceUpdate {
  readonly ownership?: ResourceOwnership;
  readonly displayName?: string;
}

/** Implementations must authorize each fixed operation before sending it to a Node. */
export interface WorkspaceNodeControl {
  requestNode(
    nodeId: string,
    operation: string,
    data: unknown,
    user: UserNodeAuthorization,
    timeoutMs?: number
  ): Promise<unknown>;
  ownsWorkbenchConnection(sessionHash: string, connectionId: string): boolean;
  revalidateTerminalAuthorizations(): Promise<void>;
}

/** Resource persistence and product-specific ownership decisions remain with the host. */
export interface WorkspaceResourcePolicy {
  projectNodeWorkspaces<T extends { readonly id: string }>(
    userId: number,
    nodeId: string,
    workspaces: readonly T[]
  ): Promise<readonly T[]>;
  resolveWorkspaceOwnership(
    userId: number,
    nodeId: string,
    requestedOwnership?: ResourceOwnership
  ): Promise<ResourceOwnership>;
  registerWorkspace(
    userId: number,
    nodeId: string,
    workspaceId: string,
    ownership: ResourceOwnership,
    displayName?: string
  ): Promise<void>;
  assertCanManageWorkspace(userId: number, nodeId: string, workspaceId: string): Promise<void>;
  assertCanUnregisterWorkspace(userId: number, nodeId: string, workspaceId: string): Promise<void>;
  unregisterWorkspace(userId: number, nodeId: string, workspaceId: string): Promise<void>;
  changeWorkspaceOwnership(
    userId: number,
    nodeId: string,
    workspaceId: string,
    ownership: ResourceOwnership
  ): Promise<void>;
  renameWorkspace(
    userId: number,
    nodeId: string,
    workspaceId: string,
    displayName: string
  ): Promise<void>;
  updateWorkspaceGroupName(
    userId: number,
    nodeId: string,
    workspaceId: string,
    groupName: string | null
  ): Promise<void>;
  updateWorkspace(
    userId: number,
    nodeId: string,
    workspaceId: string,
    update: WorkspaceUpdate
  ): Promise<void>;
}
