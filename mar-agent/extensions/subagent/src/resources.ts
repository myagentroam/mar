import { AgentError, type Agent, type AgentLiveSession } from '@myagentroam/agent';
import { historicalExecutionStatus } from './history.js';

/** Project live direct children first, followed by the sixteen most recently active terminals. */
export async function childResources(
  agent: Agent,
  parentId: string,
  signal: AbortSignal,
  disposed: () => boolean,
  history: Pick<Agent, 'sessionHistory'> = agent
): Promise<string[]> {
  signal.throwIfAborted();
  const parent = await agent.getSession(parentId);
  signal.throwIfAborted();
  if (disposed()) return [];
  const live = new Map<string, AgentLiveSession>();
  const registration = agent.observeSessionExecutions((session) => {
    if (session.source.parentSessionId === parentId && session.workspace === parent.workspace)
      live.set(session.id, session);
  });
  try {
    for (const session of registration.sessions)
      if (session.source.parentSessionId === parentId && session.workspace === parent.workspace)
        live.set(session.id, session);
    const terminals: Array<{ agentId: string; status: string; description: string }> = [];
    let cursor: string | undefined;
    let truncated = false;
    do {
      const page = await agent.listSessions({
        parentSessionId: parentId,
        limit: 100,
        ...(cursor === undefined ? {} : { cursor })
      });
      signal.throwIfAborted();
      if (disposed()) return [];
      for (const [index, session] of page.sessions.entries()) {
        if (session.workspace !== parent.workspace) continue;
        const knownLive = live.get(session.id);
        if (knownLive) {
          const snapshot = knownLive.subscribe(() => {});
          snapshot.unsubscribe();
          if (snapshot.activeExecutionId && !snapshot.terminalEvent) continue;
        }
        let state: Awaited<ReturnType<typeof historicalExecutionStatus>>;
        try {
          state = await historicalExecutionStatus(agent, session.id, signal, { history });
        } catch (error) {
          if (error instanceof AgentError && error.code === 'MAR_AGENT_SESSION_NOT_FOUND') continue;
          // A concurrent or foreign owner is not evidence of an interrupted Execution.
          // Leave its state to an explicit query instead of breaking the parent context.
          if (!(error instanceof AgentError) || error.code !== 'MAR_AGENT_SESSION_LOCKED')
            throw error;
          truncated = true;
          continue;
        }
        if (disposed()) return [];
        if (state.status === 'idle') continue;
        terminals.push({
          agentId: session.id,
          status: state.status,
          description:
            session.source.type === 'subagent' ? session.source.description : session.title
        });
        if (terminals.length === 16) {
          truncated ||= index + 1 < page.sessions.length || !!page.nextCursor;
          break;
        }
      }
      cursor = terminals.length === 16 ? undefined : page.nextCursor;
    } while (cursor);
    const active: Array<{ agentId: string; status: string; description: string }> = [];
    for (const session of live.values()) {
      signal.throwIfAborted();
      if (disposed()) return [];
      const snapshot = session.subscribe(() => {});
      snapshot.unsubscribe();
      if (!snapshot.activeExecutionId || snapshot.terminalEvent) continue;
      let summary: Awaited<ReturnType<Agent['getSession']>>;
      try {
        summary = await agent.getSession(session.id);
      } catch (error) {
        if (error instanceof AgentError && error.code === 'MAR_AGENT_SESSION_NOT_FOUND') continue;
        throw error;
      }
      signal.throwIfAborted();
      if (disposed()) return [];
      active.push({
        agentId: session.id,
        status: 'running',
        description: summary.source.type === 'subagent' ? summary.source.description : summary.title
      });
    }
    const activeIds = new Set(active.map((child) => child.agentId));
    const children = [...active, ...terminals.filter((child) => !activeIds.has(child.agentId))];
    return children.length || truncated
      ? [
          `Child Sessions (use agent_list for details): ${JSON.stringify({
            children,
            truncated
          }).replace(/[<>&]/g, (c) => (c === '<' ? '\\u003c' : c === '>' ? '\\u003e' : '\\u0026'))}`
        ]
      : [];
  } finally {
    registration.unsubscribe();
  }
}
