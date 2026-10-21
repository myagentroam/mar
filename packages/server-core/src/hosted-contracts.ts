import type { Pool, PoolConnection } from 'mysql2/promise';
import type { UserNodeAuthorization } from './node-request-channel.js';
export interface TemplateAuditEvent {
  eventType: string;
  actorUserId: number;
  targetType: string;
  targetId: string;
  nodeId: string;
  workspaceId: string;
  metadata: string;
}
export interface TemplateStore {
  readonly raw: Pool;
  audit(event: TemplateAuditEvent): Promise<void>;
  auditWithConnection(
    connection: Pick<PoolConnection, 'execute'>,
    event: TemplateAuditEvent
  ): Promise<void>;
}
export interface TemplateResourcePolicy {
  assertCanHostConversationTemplate(nodeId: string): Promise<void>;
  assertCanUseWorkspace(userId: number, nodeId: string, workspaceId: string): Promise<unknown>;
  canUseTemplate(userId: number, templateId: string): Promise<boolean>;
}
export interface HostedDirectoryNode {
  readonly id: string;
  readonly metadata: string;
  readonly connected: boolean;
  readonly disabled: boolean;
}
export interface HostedNodeControl {
  listNodes(): readonly HostedDirectoryNode[] | Promise<readonly HostedDirectoryNode[]>;
  ownsWorkbenchConnection(sessionHash: string, connectionId: string): boolean;
  requestHostedConversationNode(
    nodeId: string,
    operation: string,
    data: unknown,
    user: UserNodeAuthorization,
    timeoutMs?: number
  ): Promise<unknown>;
}
