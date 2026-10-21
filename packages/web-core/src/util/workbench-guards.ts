import type { RunEvent } from '../model/workbench.js';
import type { AgentRun, Session } from '../model/workbench.js';

export function isAgentRun(value: unknown): value is AgentRun & { readonly sessionId: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly id?: unknown }).id === 'string' &&
    typeof (value as { readonly sessionId?: unknown }).sessionId === 'string' &&
    typeof (value as { readonly status?: unknown }).status === 'string'
  );
}

export function isRunEvent(value: unknown): value is RunEvent & { readonly runId: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly runId?: unknown }).runId === 'string' &&
    typeof (value as { readonly sequence?: unknown }).sequence === 'number' &&
    typeof (value as { readonly eventType?: unknown }).eventType === 'string'
  );
}

export function isSession(value: unknown): value is Session {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Session).id === 'string' &&
    typeof (value as Session).workspaceId === 'string' &&
    ((value as Session).runner === 'codex' ||
      (value as Session).runner === 'claude-code' ||
      (value as Session).runner === 'opencode' ||
      (value as Session).runner === 'mar-agent') &&
    !(value as Session).id.startsWith('draft:')
  );
}
