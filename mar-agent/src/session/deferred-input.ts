import { AgentError } from '../error.js';
import type { SessionRecord } from './store/types.js';

/** The application is self-contained; the receive record may precede the Compact window. */
export function appliedInputRecord(record: SessionRecord): SessionRecord | undefined {
  if (record.type !== 'model.context' || !record.payload || typeof record.payload !== 'object')
    return undefined;
  const payload = record.payload as Record<string, unknown>;
  if (payload.inputRef === undefined) return undefined;
  const input = payload.input;
  if (
    payload.role !== 'user' ||
    typeof payload.content !== 'string' ||
    typeof payload.inputRef !== 'string' ||
    !payload.inputRef ||
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    typeof (input as Record<string, unknown>).prompt !== 'string' ||
    (input as Record<string, unknown>).deferred !== true ||
    payload.content !==
      ((input as Record<string, unknown>).modelText ?? (input as Record<string, unknown>).prompt)
  )
    throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Deferred input application is invalid.');
  return { ...record, type: 'turn.user', recordId: payload.inputRef, payload: input };
}

/** Only the last checkpoint and its tail are needed, never a historical consume index. */
export function pendingDeferredInputs(
  records: readonly SessionRecord[]
): Map<string, SessionRecord> {
  const pending = new Map<string, SessionRecord>();
  const applied = new Set<string>();
  for (const record of records) {
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    if (record.type === 'compact.completed' && typeof payload.summary === 'string') {
      pending.clear();
      applied.clear();
      if (payload.pendingInputs !== undefined) {
        if (!Array.isArray(payload.pendingInputs)) corrupt();
        for (const item of payload.pendingInputs as SessionRecord[]) {
          if (
            !item ||
            item.type !== 'turn.user' ||
            item.sessionId !== record.sessionId ||
            typeof item.recordId !== 'string' ||
            !Number.isSafeInteger(item.sequence) ||
            item.sequence < 1 ||
            item.sequence >= record.sequence ||
            !item.payload ||
            (item.payload as Record<string, unknown>).deferred !== true ||
            typeof (item.payload as Record<string, unknown>).prompt !== 'string' ||
            pending.has(item.recordId)
          )
            corrupt();
          pending.set(item.recordId, item);
        }
      }
    } else if (record.type === 'turn.user' && payload.deferred === true) {
      if (
        typeof payload.prompt !== 'string' ||
        pending.has(record.recordId) ||
        applied.has(record.recordId)
      )
        corrupt();
      pending.set(record.recordId, record);
    } else {
      const input = appliedInputRecord(record);
      if (!input) continue;
      if (applied.has(input.recordId)) corrupt();
      applied.add(input.recordId);
      pending.delete(input.recordId);
    }
  }
  return new Map([...pending].sort(([, a], [, b]) => a.sequence - b.sequence));
}

function corrupt(): never {
  throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Deferred input state is invalid.');
}
