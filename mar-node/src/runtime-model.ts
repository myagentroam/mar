import type { AgentRunStatus, RunnerName, PermissionStop } from '@myagentroam/protocol';

export interface NodeMessageAttachmentInput {
  readonly name: string;
  readonly mime: string;
  readonly dataBase64: string;
}

export type RunRecoveryState = 'ACTIVE' | 'SUSPECT' | 'LOST';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export interface NodeAgentRun {
  readonly id: string;
  readonly sessionId: string;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly runner: RunnerName;
  readonly status: AgentRunStatus;
  readonly recoveryState: RunRecoveryState;
  readonly version: number;
  readonly clientMessageId: string;
  readonly source?: 'SCHEDULED';
  readonly suppressNotifications?: boolean;
  readonly initiatedByUserId?: number;
  readonly createdAt: number;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly updatedAt: number;
}

export interface NodeQueueItem {
  readonly id: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly runner: RunnerName;
  readonly clientMessageId: string;
  readonly content: string;
  readonly suppressNotifications?: boolean;
  readonly attachments: readonly NodeMessageAttachmentInput[];
  readonly initiatedByUserId?: number;
  readonly createdAt: number;
}

export interface NodeRunnerExecution {
  readonly id: string;
  readonly runId: string;
  readonly turnId: string;
  readonly status: 'STARTING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';
  readonly startedAt: number;
  readonly completedAt: number | null;
}

export interface NodeRunEvent {
  readonly id: number;
  readonly runId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly payload: unknown;
  readonly status?: AgentRunStatus;
  readonly createdAt: number;
}

export interface ConversationPage {
  readonly turns: readonly NodeConversationTurn[];
  readonly nextCursor: string | null;
}

export interface ConversationItemPage {
  readonly items: readonly NodeConversationItem[];
  readonly nextCursor: string | null;
}

export interface NodeConversationItem {
  /** Runner-owned canonical source identity; internal, not a transport or storage field. */
  readonly sourceItemId?: string;
  readonly processGroup?: { readonly id: string; readonly isStart?: true };
  /** Time of the latest observed public update, not a polling heartbeat. */
  readonly updatedAt?: number;
  readonly permissionStop?: PermissionStop;
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string | null;
  readonly parentItemId: string | null;
  readonly sourceSequence: number | null;
  readonly revision: number;
  readonly kind: string;
  readonly status: string;
  readonly payload: unknown;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
}

export interface NodeConversationTurn {
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string | null;
  readonly userItemId: string | null;
  readonly status: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly access: string | null;
  readonly rewind?: { readonly before: string | null; readonly after: string };
  readonly items: readonly NodeConversationItem[];
  readonly startedAt: number | null;
  readonly completedAt: number | null;
}

export interface NodeApproval {
  readonly id: string;
  readonly runId: string;
  readonly status: ApprovalStatus;
  readonly payload: unknown;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly decidedAt: number | null;
}
