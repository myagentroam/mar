import { AgentError } from '../error.js';
import type { SessionRecord } from './store/types.js';

export type AgentSessionRollbackInput =
  | { readonly boundaryTurnId: string | null; readonly beforeInput?: never }
  | {
      readonly boundaryTurnId?: never;
      readonly beforeInput: { readonly turnId: string; readonly clientMessageId: string };
    };

/** Resolve the retained prefix only from records read under the Session maintenance lease. */
export function rollbackBoundaryIndex(
  records: readonly SessionRecord[],
  input: AgentSessionRollbackInput
): number {
  const invalid = () =>
    new AgentError(
      'MAR_AGENT_ROLLBACK_TARGET_INVALID',
      'Session rollback target was not found or is ambiguous.'
    );
  if (input.beforeInput !== undefined) {
    const target = input.beforeInput;
    if (
      input.boundaryTurnId !== undefined ||
      target === null ||
      typeof target !== 'object' ||
      typeof target.turnId !== 'string' ||
      !target.turnId.trim() ||
      typeof target.clientMessageId !== 'string' ||
      !target.clientMessageId.trim()
    )
      throw invalid();
    let firstInput = -1;
    let selected = -1;
    for (const [index, record] of records.entries()) {
      if (record.type !== 'turn.user' || record.turnId !== target.turnId) continue;
      if (firstInput < 0) firstInput = index;
      const payload = record.payload;
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) continue;
      if ((payload as Record<string, unknown>).clientMessageId !== target.clientMessageId) continue;
      if (selected >= 0) throw invalid();
      selected = index;
    }
    if (selected < 0) throw invalid();
    // The initial input owns execution-start records; subsequent inputs own only their tail.
    return (
      (selected === firstInput
        ? records.findIndex((record) => record.turnId === target.turnId)
        : selected) - 1
    );
  }
  if (input.boundaryTurnId === null) return 0;
  if (typeof input.boundaryTurnId !== 'string' || !input.boundaryTurnId.trim()) throw invalid();
  const index = records.findLastIndex((record) => record.turnId === input.boundaryTurnId);
  if (index < 0) throw invalid();
  return index;
}
