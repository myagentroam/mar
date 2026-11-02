import { AgentError, type Agent } from '@myagentroam/agent';
import type { SessionExtensionContext } from '@myagentroam/agent/extensions';

/** Read-only local discovery uses the Core catalog and never opens historical Sessions. */
export function registerQueryTools(context: SessionExtensionContext, agent: Agent): void {
  context.tools.register({
    name: 'agent_list',
    description: 'List direct child Sessions or eligible model configurations.',
    allowedCallers: ['direct', 'programmatic'],
    parallelSafety: 'safe',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['children', 'profile'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        cursor: { type: 'string', minLength: 1 }
      },
      additionalProperties: false
    },
    async execute(raw) {
      const input = raw as { scope?: 'children' | 'profile'; limit?: number; cursor?: string };
      const current = await agent.getSession(context.sessionId);
      const data =
        input.scope === 'profile'
          ? {
              models: (context.models?.list() ?? []).filter(
                (model) => model.conversationModel && model.subagentModel
              )
            }
          : await agent
              .listSessions({
                parentSessionId: context.sessionId,
                ...(input.limit === undefined ? {} : { limit: input.limit }),
                ...(input.cursor === undefined ? {} : { cursor: input.cursor })
              })
              .then((page) => ({
                current: {
                  agentId: current.id,
                  parentSessionId: current.source.parentSessionId ?? null
                },
                agents: page.sessions
                  .filter((session) => session.workspace === current.workspace)
                  .map((session) => ({
                    agentId: session.id,
                    title: session.title,
                    parentSessionId: session.source.parentSessionId,
                    modelId: session.modelId,
                    lastActivityAt: session.lastActivityAt
                  })),
                ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
              }));
      return { data, content: JSON.stringify(data) };
    }
  });
  context.tools.register({
    name: 'agent_view',
    description: 'View a direct child or parent Session and its public history.',
    allowedCallers: ['direct', 'programmatic'],
    parallelSafety: 'safe',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', minLength: 1 },
        includeHistory: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        cursor: { type: 'string', minLength: 1 }
      },
      required: ['agentId'],
      additionalProperties: false
    },
    async execute(raw) {
      const input = raw as {
        agentId: string;
        includeHistory?: boolean;
        limit?: number;
        cursor?: string;
      };
      const [actor, session] = await Promise.all([
        agent.getSession(context.sessionId),
        agent.getSession(input.agentId)
      ]);
      if (
        actor.workspace !== session.workspace ||
        (session.id !== actor.id &&
          session.source.parentSessionId !== actor.id &&
          actor.source.parentSessionId !== session.id)
      )
        throw new AgentError('MAR_AGENT_SUBAGENT_NOT_FOUND', 'Session is not available.');
      const history = input.includeHistory
        ? await agent.sessionHistory(session.id, {
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor })
          })
        : undefined;
      const data = {
        agentId: session.id,
        title: session.title,
        parentSessionId: session.source.parentSessionId ?? null,
        modelId: session.modelId,
        reasoningEffort: session.reasoningEffort,
        lastActivityAt: session.lastActivityAt,
        ...(history
          ? {
              history: {
                entries: history.entries.flatMap((entry) => {
                  if (entry.kind === 'user')
                    return [{ kind: 'user', sequence: entry.sequence, text: entry.text }];
                  if (entry.event.type === 'message.completed')
                    return [
                      {
                        kind: 'message',
                        sequence: entry.sequence,
                        text: entry.event.text,
                        phase: entry.event.phase,
                        executionId: entry.event.executionId
                      }
                    ];
                  return [];
                }),
                ...(history.nextCursor ? { nextCursor: history.nextCursor } : {})
              }
            }
          : {})
      };
      return { data, content: JSON.stringify(data) };
    }
  });
}
