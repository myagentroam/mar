import type { ModelUsageGrant } from '@myagentroam/protocol';

export interface UserNodeAuthorization {
  readonly usageGrant?: ModelUsageGrant | undefined;
  readonly userId: number;
  readonly sessionHash: string;
  /** Server-only context; never forwarded as a Node credential field. */
  readonly workspaceId?: string;
}

export type NodeRequestAuthorization = (
  userId: number,
  nodeId: string,
  operation: string,
  data: unknown,
  workspaceId?: string
) => boolean | Promise<boolean>;
