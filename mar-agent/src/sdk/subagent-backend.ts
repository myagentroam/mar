import { AgentError } from '../error.js';
import type { SessionStore } from '../session/store/contracts.js';
import type { SessionSource } from '../session/types.js';
import type { SubagentSessionControllerBackend } from '../subagent/session-controller.js';
export function createSubagentBackend(
  store: Pick<
    SessionStore,
    'createSession' | 'delete' | 'listSubagentChildren' | 'getSession' | 'read'
  >,
  workspace: string
): SubagentSessionControllerBackend {
  return {
    createSession: async (input) => {
      const session = await store.createSession({
        workspace,
        title: input.title,
        source: input.source
      });
      return { id: session.id };
    },
    deleteSession: async (sessionId) => {
      await store.delete(sessionId);
    },
    listChildren: async (parentSessionId) => {
      const sessions = await store.listSubagentChildren(parentSessionId);
      return sessions.map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt,
        source: session.source as Extract<SessionSource, { type: 'subagent' }>
      }));
    },
    loadChild: async (parentSessionId, childSessionId) => {
      try {
        const session = await store.getSession(childSessionId);
        if (
          session.source.type !== 'subagent' ||
          session.source.parentSessionId !== parentSessionId
        )
          return undefined;
        return {
          id: session.id,
          createdAt: session.createdAt,
          lastActivityAt: session.lastActivityAt,
          source: session.source,
          records: await store.read(session.id)
        };
      } catch (error) {
        if (error instanceof AgentError && error.code === 'MAR_AGENT_SESSION_NOT_FOUND') {
          // A history read failure is not proof that the child was deleted.
          const children = await store.listSubagentChildren(parentSessionId);
          if (!children.some((child) => child.id === childSessionId)) return undefined;
        }
        throw error;
      }
    }
  };
}
