import {
  isComposerAttachmentResourcePath,
  type DirectTransferDescriptor,
  type ModelUsageGrant
} from '@myagentroam/protocol';

export interface NodeResourceScope {
  readonly nodeId: string;
  readonly workspaceId?: string;
}

export interface NodeOperationScope extends Partial<NodeResourceScope> {
  readonly userId?: number;
}

/** Select affected operations, not carriers. A Node change also covers its Workspaces. */
export function matchesNodeOperation(
  scope: NodeOperationScope,
  target: NodeResourceScope & { readonly userId: number }
): boolean {
  return (
    (scope.userId === undefined || scope.userId === target.userId) &&
    (scope.nodeId === undefined || scope.nodeId === target.nodeId) &&
    (scope.workspaceId === undefined || scope.workspaceId === target.workspaceId)
  );
}

/** Ordinary bytes are finite; staged writes still require a separately authorized commit. */
export function isOrdinaryFileStream(descriptor: DirectTransferDescriptor): boolean {
  return descriptor.direction === 'UPLOAD'
    ? descriptor.uploadId !== undefined
    : descriptor.resource.kind === 'GIT_COMMIT_BLOB' ||
        !isComposerAttachmentResourcePath(descriptor.resource.path);
}

export interface UserNodeAuthorization {
  readonly usageGrant?: ModelUsageGrant | undefined;
  readonly userId: number;
  readonly sessionHash: string;
  /** Set only on authenticated marctl Workbench connections. */
  readonly cliTerminal?: true;
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
