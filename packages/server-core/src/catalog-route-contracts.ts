import type { SessionLookup } from './session.js';
export interface CatalogResourcePolicy {
  assertCanManageNode(userId: number, nodeId: string): Promise<unknown>;
  assertCanUseWorkspace(userId: number, nodeId: string, workspaceId: string): Promise<unknown>;
  assertCanManageWorkspace(userId: number, nodeId: string, workspaceId: string): Promise<unknown>;
}
export type SkillTargetStore = SessionLookup & {
  authenticateNode(nodeId: string, credential: string): unknown | Promise<unknown>;
};
