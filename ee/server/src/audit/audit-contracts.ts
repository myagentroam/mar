import type { AuditEvent } from '@myagentroam/server-core/audit';

export interface SharedConversationAuditInput extends AuditEvent {
  readonly organizationId: number;
  readonly idempotencyKey: string;
  readonly conversationId?: string;
  readonly conversationTitle?: string;
  readonly userMessage?: string;
}
