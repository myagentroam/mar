import type { ModelUsageGrant } from '@myagentroam/protocol';

export interface UserNodeAuthorization {
  readonly usageGrant?: ModelUsageGrant | undefined;
  readonly userId: number;
  readonly sessionHash: string;
  /** Server-only context; never forwarded as a Node credential field. */
  readonly workspaceId?: string;
  /** Server-verified marctl caller; never derived from a request body or environment. */
  readonly marctlCaller?:
    | { readonly type: 'terminal' }
    | { readonly type: 'execution'; readonly sessionId: string; readonly executionId: string };
  /** Server-prepared target model resources, bound to a verified marctl Execution request. */
  readonly marctlExecutionResources?: Readonly<Record<string, unknown>>;
}

export type NodeRequestAuthorization = (
  userId: number,
  nodeId: string,
  operation: string,
  data: unknown,
  workspaceId?: string
) => boolean | Promise<boolean>;
