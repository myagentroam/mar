import { AgentError, type Agent, type AgentEvent, type ExecutionResult } from '@myagentroam/agent';
import { nativeChildSnapshot, projectChildEvent, type ChildSnapshot } from './snapshot.js';

/** Share only in-flight history pages within one parent scope; completed reads are never cached. */
export function sharedSessionHistory(
  agent: Pick<Agent, 'sessionHistory'>
): Pick<Agent, 'sessionHistory'> {
  const pending = new Map<string, ReturnType<Agent['sessionHistory']>>();
  return {
    sessionHistory(sessionId, options) {
      const key = JSON.stringify([sessionId, options?.limit ?? null, options?.cursor ?? null]);
      const existing = pending.get(key);
      if (existing) return existing;
      const request = agent.sessionHistory(sessionId, options);
      pending.set(key, request);
      void request
        .finally(() => {
          if (pending.get(key) === request) pending.delete(key);
        })
        .catch(() => {});
      return request;
    }
  };
}

/** Read the latest historical Execution without opening the Session. */
export async function historicalExecutionStatus(
  agent: Agent,
  sessionId: string,
  signal: AbortSignal,
  options: {
    details?: boolean;
    activeExecutionId?: string;
    history?: Pick<Agent, 'sessionHistory'>;
  } = {}
): Promise<{
  status: 'idle' | 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
  executionId?: string;
  details?: ReturnType<typeof nativeChildSnapshot>;
  errorCode?: string;
  errorMessage?: string;
  permissionStop?: ExecutionResult['permissionStop'];
}> {
  let cursor: string | undefined;
  let latest: AgentEvent | undefined;
  const pages: AgentEvent[][] = [];
  do {
    signal.throwIfAborted();
    const page = await (options.history ?? agent).sessionHistory(sessionId, {
      limit: 100,
      ...(cursor === undefined ? {} : { cursor })
    });
    signal.throwIfAborted();
    const events = page.entries.flatMap((entry) => (entry.kind === 'event' ? [entry.event] : []));
    latest ??= events.findLast(
      (event) =>
        event.type === 'execution.started' ||
        event.type === 'execution.completed' ||
        event.type === 'execution.failed' ||
        event.type === 'execution.cancelled'
    );
    if (latest && !options.details) break;
    if (latest) {
      const matching = events.filter((event) => event.executionId === latest!.executionId);
      pages.push(matching);
      if (matching.some((event) => event.type === 'execution.started')) break;
    }
    cursor = page.nextCursor;
  } while (cursor);
  if (!latest) return { status: 'idle' };
  let status: 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
  if (latest.type === 'execution.started') {
    if (latest.executionId === options.activeExecutionId) status = 'running';
    else {
      const interrupted = await agent.sessionExecutionWasInterrupted(
        sessionId,
        latest.executionId,
        { signal }
      );
      signal.throwIfAborted();
      if (!interrupted)
        throw new AgentError(
          'MAR_AGENT_SESSION_EXECUTION_CHANGED',
          'Session Execution changed during inspection.'
        );
      status = 'interrupted';
    }
  } else status = latest.type.slice('execution.'.length) as 'completed' | 'failed' | 'cancelled';
  const projection: ChildSnapshot = { changedFiles: [] };
  for (const events of pages.reverse())
    for (const event of events) projectChildEvent(projection, event, true);
  return {
    status,
    executionId: latest.executionId,
    ...(options.details ? { details: nativeChildSnapshot(projection) } : {}),
    ...(latest.type === 'execution.completed' && latest.permissionStop
      ? { permissionStop: latest.permissionStop }
      : {}),
    ...(latest.type === 'execution.failed'
      ? {
          errorCode: latest.code,
          ...(latest.message === undefined ? {} : { errorMessage: latest.message })
        }
      : {})
  };
}
