import type { NodeDatabase } from '../database.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import type { NodeAgentSession } from '../session/contracts.js';
import type { NativeSessionProjectionService } from '../session/native-session-projection-service.js';
import { sessionActivityStatus } from './session-recent-activity.js';

type AgentListSession = Pick<
  NodeAgentSession,
  'id' | 'workspaceId' | 'parentSessionId' | 'customTitle' | 'runnerTitle' | 'lastActivityAt'
>;

/** Read only registered relationships and live Node facts; never discover or resume a Runner. */
export async function listAgentNetworkSessions(
  source: NodeAgentSession | undefined,
  input: { readonly scope?: 'tree' | 'active'; readonly query?: string; readonly limit?: number },
  options: {
    readonly workspaceId: string;
    readonly runtime: NodeRuntimeState;
    readonly database: NodeDatabase | undefined;
    readonly projection: NativeSessionProjectionService;
  }
) {
  if (
    Object.keys(input).some((key) => !['scope', 'query', 'limit'].includes(key)) ||
    (input.scope !== undefined && !['tree', 'active'].includes(input.scope)) ||
    (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 160)) ||
    (input.limit !== undefined &&
      (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100))
  )
    throw Object.assign(new Error('Invalid Agent list input.'), { code: 'AGENT_LIST_INVALID' });
  const scope = input.scope ?? (source ? 'tree' : 'active');
  const known = new Map(
    options.runtime
      .listAgentSessions()
      .filter((session) => session.workspaceId === options.workspaceId)
      .map((session) => [session.id, session] as const)
  );
  if (source) known.set(source.id, source);
  let sessions: readonly AgentListSession[];
  if (scope === 'tree') {
    if (!source) throw new Error('AGENT_TARGET_REQUIRED');
    if (!options.database) throw new Error('DATABASE_UNAVAILABLE');
    const records = options.database.listSessionRecords(options.workspaceId);
    const parents = new Map(
      records.map((record) => [record.id, record.metadata.parentSessionId ?? null] as const)
    );
    for (const session of known.values()) parents.set(session.id, session.parentSessionId ?? null);
    let root = source.id;
    const ancestors = new Set([root]);
    while (true) {
      const parent = parents.get(root);
      if (!parent || !parents.has(parent)) break;
      if (ancestors.has(parent))
        throw Object.assign(new Error('Session ancestry contains a cycle.'), {
          code: 'SESSION_RELATION_INVALID'
        });
      ancestors.add(parent);
      root = parent;
    }
    const children = new Map<string, string[]>();
    for (const [id, parent] of parents) {
      if (parent === null) continue;
      const siblings = children.get(parent) ?? [];
      siblings.push(id);
      children.set(parent, siblings);
    }
    const ids = [root];
    for (let i = 0; i < ids.length; i++) ids.push(...(children.get(ids[i]!) ?? []).sort());
    const cached = new Map(
      options.projection.cachedNative().map((session) => [session.id, session])
    );
    const workspace = options.database.getWorkspace(options.workspaceId);
    const registered = new Map<string, AgentListSession>(
      workspace === undefined
        ? []
        : records.map((record) => [
            record.id,
            {
              id: record.id,
              workspaceId: record.workspaceId,
              parentSessionId: record.metadata.parentSessionId ?? null,
              customTitle: record.metadata.customTitle,
              runnerTitle: record.metadata.runnerTitle,
              lastActivityAt: 0
            }
          ])
    );
    sessions = ids
      .map((id) => known.get(id) ?? cached.get(id) ?? registered.get(id))
      .filter(
        (session): session is AgentListSession =>
          session !== undefined && session.workspaceId === options.workspaceId
      );
  } else {
    sessions = [...known.values()];
  }
  const query = input.query?.trim().normalize('NFKC').toLocaleLowerCase() ?? '';
  const matches = sessions
    .map((session) => {
      return {
        id: session.id,
        parentSessionId: session.parentSessionId ?? null,
        title: session.customTitle ?? session.runnerTitle ?? 'Untitled session',
        status: sessionActivityStatus(options.runtime, session.id),
        lastActivityAt: session.lastActivityAt
      };
    })
    .filter(
      (session) =>
        (scope !== 'active' || session.status !== 'IDLE') &&
        (!query || session.title.normalize('NFKC').toLocaleLowerCase().includes(query))
    )
    .sort(
      (left, right) =>
        Number(right.status !== 'IDLE') - Number(left.status !== 'IDLE') ||
        right.lastActivityAt - left.lastActivityAt ||
        left.id.localeCompare(right.id)
    );
  const limit = input.limit ?? 10;
  return {
    currentAgentId: source?.id ?? null,
    sessions: matches
      .slice(0, limit)
      .map(({ lastActivityAt: _lastActivityAt, ...session }) => session),
    truncated: matches.length > limit
  };
}
