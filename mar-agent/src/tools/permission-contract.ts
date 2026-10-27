export type PermissionMode = 'auto' | 'full-access';
export interface ToolPermission {
  action: 'allow' | 'ask' | 'deny';
  reason?: string | null;
}
export interface PermissionStop {
  action: 'ask' | 'deny';
  reason: string;
  source: {
    sessionId: string;
    executionId: string;
    callId: string;
    toolName: string;
    parentCallId?: string;
  };
}
export interface ToolApprovalRequest {
  readonly approvalId: string;
  readonly reason: string;
  readonly source: PermissionStop['source'];
  readonly input: unknown;
  readonly expiresAt: number;
}
export type ToolApprovalDecision = 'APPROVED' | 'REJECTED';
export type ToolApprovalHandler = (
  request: ToolApprovalRequest,
  signal: AbortSignal
) => Promise<ToolApprovalDecision>;
