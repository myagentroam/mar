import type { Session } from '../model/workbench.js';

/** Session-scoped settings use Node metadata, never account personal instructions. */
export function createSessionPromptService(options: {
  readonly nodeId: string;
  readonly sessionId: string;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
}) {
  const nodeId = options.nodeId;
  const path = `/api/agent-sessions/${encodeURIComponent(options.sessionId)}`;
  return {
    async read(): Promise<string> {
      const result = await options.request<{ session: Session }>(
        `${path}?nodeId=${encodeURIComponent(nodeId)}`
      );
      return result.session.sessionPrompt ?? '';
    },
    async save(value: string): Promise<void> {
      await options.request(`${path}/metadata`, {
        method: 'PATCH',
        body: JSON.stringify({ nodeId, sessionPrompt: value.trim() || null })
      });
    }
  };
}
