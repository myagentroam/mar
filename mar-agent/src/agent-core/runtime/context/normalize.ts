import type { ModelMessage } from '../../model/contracts.js';

export interface NormalizeModelContextInput {
  supportsImages: boolean;
}

// Normalization only shapes the model-visible request for one invocation; it
// never writes back to JSONL or the recoverable session history.
export function normalizeMessagesForModel(
  messages: readonly ModelMessage[],
  input: NormalizeModelContextInput
): ModelMessage[] {
  const answered = new Set<string>();
  for (const message of messages)
    if (message.role === 'tool' && typeof message.callId === 'string') answered.add(message.callId);
  const result: ModelMessage[] = [];
  for (const message of messages) {
    result.push(stripUnsupportedImages(message, input));
    const callId = pendingToolCallId(message);
    if (!callId || answered.has(callId)) continue;
    answered.add(callId);
    result.push({
      role: 'tool',
      callId,
      content: `[tool result unavailable for call ${callId}: the execution was interrupted before the result was recorded]`
    });
  }
  // A record committed during tool execution may precede its results in physical history.
  // Delay only user rows in the request projection; never reorder persisted events.
  const projected: ModelMessage[] = [];
  const deferred: ModelMessage[] = [];
  const pending = new Set<string>();
  for (const message of result) {
    if (message.role === 'user' && pending.size) {
      deferred.push(message);
      continue;
    }
    projected.push(message);
    const callId = pendingToolCallId(message);
    if (callId) pending.add(callId);
    if (message.role === 'tool' && message.callId) pending.delete(message.callId);
    if (!pending.size && deferred.length) projected.push(...deferred.splice(0));
  }
  projected.push(...deferred);
  return projected;
}

function pendingToolCallId(message: ModelMessage): string | undefined {
  if (message.role === 'tool_call')
    return typeof message.callId === 'string' ? message.callId : undefined;
  if (message.role !== 'provider' || !message.item) return undefined;
  const type = message.item['type'];
  if (type !== 'function_call' && type !== 'custom_tool_call') return undefined;
  const callId = message.item['call_id'];
  return typeof callId === 'string' ? callId : undefined;
}

function stripUnsupportedImages(
  message: ModelMessage,
  input: NormalizeModelContextInput
): ModelMessage {
  if (input.supportsImages || !message.images?.length) return message;
  const rest = { ...message };
  delete rest.images;
  return rest;
}
