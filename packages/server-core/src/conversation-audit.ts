import { auditConversationReceiptSchema } from '@myagentroam/protocol';
import type { AuditConversationInputMode, AuditConversationReceipt } from '@myagentroam/protocol';
export interface SharedConversationAuditReceipt {
  readonly sessionId?: string;
  readonly conversationTitle?: string;
  readonly runId?: string;
  readonly queueItemId?: string;
  readonly inputMode: AuditConversationInputMode;
}

export interface ConversationAuditObserver {
  recordSharedConversation(input: {
    readonly eventType:
      | 'shared_conversation_input_accepted'
      | 'shared_conversation_input_rejected'
      | 'shared_conversation_queue_updated'
      | 'shared_conversation_queue_deleted'
      | 'shared_conversation_queue_reordered'
      | 'shared_conversation_queue_execute_requested';
    readonly actorUserId: number;
    readonly nodeId: string;
    readonly workspaceId: string;
    readonly receipt: AuditConversationReceipt | SharedConversationAuditReceipt;
    readonly clientMessageId?: string;
    readonly userMessage?: string;
    readonly errorCode?: string;
    readonly result?: 'SUCCESS' | 'DENIED' | 'FAILED';
  }): Promise<void>;
}

type SharedConversationEventType =
  | 'shared_conversation_input_accepted'
  | 'shared_conversation_input_rejected'
  | 'shared_conversation_queue_updated'
  | 'shared_conversation_queue_deleted'
  | 'shared_conversation_queue_reordered'
  | 'shared_conversation_queue_execute_requested';

export async function recordSharedConversationAudit(input: {
  readonly audits: ConversationAuditObserver | undefined;
  readonly eventType: SharedConversationEventType;
  readonly actorUserId: number;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly nodeResult?: unknown;
  readonly fallbackReceipt?: SharedConversationAuditReceipt;
  readonly clientMessageId?: string;
  readonly userMessage?: string;
  readonly errorCode?: string;
  readonly result?: 'SUCCESS' | 'DENIED' | 'FAILED';
}): Promise<void> {
  if (input.audits === undefined) return;
  const nodeReceipt =
    input.nodeResult !== null &&
    typeof input.nodeResult === 'object' &&
    !Array.isArray(input.nodeResult) &&
    'auditReceipt' in input.nodeResult
      ? input.nodeResult.auditReceipt
      : undefined;
  const parsed = auditConversationReceiptSchema.safeParse(nodeReceipt);
  const receipt = parsed.success ? parsed.data : input.fallbackReceipt;
  if (receipt === undefined) {
    console.warn('AUDIT_RECEIPT_INVALID');
    return;
  }
  void Promise.resolve()
    .then(() =>
      input.audits!.recordSharedConversation({
        eventType: input.eventType,
        actorUserId: input.actorUserId,
        nodeId: input.nodeId,
        workspaceId: input.workspaceId,
        receipt,
        ...(input.clientMessageId === undefined ? {} : { clientMessageId: input.clientMessageId }),
        ...(input.userMessage === undefined ? {} : { userMessage: input.userMessage }),
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        ...(input.result === undefined ? {} : { result: input.result })
      })
    )
    .catch(() => console.warn('AUDIT_WRITE_FAILED'));
}

export function sharedConversationFailureResult(errorCode: string): 'DENIED' | 'FAILED' {
  return new Set([
    'INTERNAL_ERROR',
    'NODE_OFFLINE',
    'NODE_REQUEST_TIMEOUT',
    'NODE_SEND_FAILED',
    'NODE_CONTROL_CLOSED',
    'NODE_RESPONSE_INVALID'
  ]).has(errorCode)
    ? 'FAILED'
    : 'DENIED';
}
