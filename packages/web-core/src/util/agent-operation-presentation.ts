import { agentOperationPresentationSchema } from '@myagentroam/protocol';
import type { ConversationItem } from '../model/workbench.js';
import { conversationPayload } from './conversation-history.js';

export function agentOperation(payload: unknown) {
  const value = conversationPayload(payload);
  const parsed = agentOperationPresentationSchema.safeParse(value?.agentOperation);
  return parsed.success ? parsed.data : undefined;
}

/** Runner IDs are not product Session mappings. Legacy fields remain read-only evidence. */
export function agentOperationTargets(payload: unknown) {
  const operation = agentOperation(payload);
  if (operation) return operation.targets;
  const value = conversationPayload(payload);
  if (typeof value?.subagentId !== 'string' || !value.subagentId) return [];
  return [
    {
      agentId: value.subagentId,
      ...(typeof value.subagentSessionId === 'string' && value.subagentSessionId
        ? { sessionId: value.subagentSessionId }
        : {})
    }
  ];
}

export function agentOperationIdentity(payload: unknown): string {
  const operation = agentOperation(payload);
  // Discovery and multi-target operations must not merge with a single Agent's controls.
  if (operation?.action === 'LIST' || operation?.targetsTruncated) return '';
  const targets = agentOperationTargets(payload);
  return targets.length === 1 ? targets[0]!.agentId : '';
}

export function agentGroupSessions(items: readonly ConversationItem[]) {
  const sessions = new Map<string, { sessionId: string; title: string }>();
  for (const item of items) {
    for (const target of agentOperationTargets(item.payload)) {
      if (target.sessionId)
        sessions.set(target.sessionId, {
          sessionId: target.sessionId,
          title:
            ('title' in target ? target.title : undefined) ??
            sessions.get(target.sessionId)?.title ??
            target.agentId
        });
    }
  }
  return [...sessions.values()];
}
