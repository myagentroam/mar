import { agentOperationPresentationSchema } from '@myagentroam/protocol';
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
  return [{ agentId: value.subagentId }];
}

export function agentOperationIdentity(payload: unknown): string {
  const operation = agentOperation(payload);
  // Discovery and multi-target operations must not merge with a single Agent's controls.
  if (operation?.action === 'LIST' || operation?.targetsTruncated) return '';
  const targets = agentOperationTargets(payload);
  return targets.length === 1 ? targets[0]!.agentId : '';
}
