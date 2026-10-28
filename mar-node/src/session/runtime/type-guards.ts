import type { AgentRunStatus } from '@myagentroam/protocol';
import type { NodeAgentRun, NodeConversationTurn } from '../../runtime-model.js';
import { isPlainRecord } from '../../util/records.js';

export function isTerminalRunStatus(status: AgentRunStatus): boolean {
  return (
    status === 'SUCCEEDED' ||
    status === 'FAILED' ||
    status === 'CANCELLED' ||
    status === 'INTERRUPTED'
  );
}

export function isNodeAgentRun(value: unknown): value is NodeAgentRun {
  return (
    isPlainRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.status === 'string'
  );
}

export function isNodeConversationTurn(value: unknown): value is NodeConversationTurn {
  return (
    isPlainRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.sessionId === 'string' &&
    Array.isArray(value.items)
  );
}
