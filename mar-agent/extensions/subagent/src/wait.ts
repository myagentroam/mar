import {
  AgentError,
  type Agent,
  type AgentEvent,
  type AgentSession,
  type ExecutionResult
} from '@myagentroam/agent';
import {
  waitForToolCondition,
  type ExtensionOperationContext,
  type SessionExtensionContext
} from '@myagentroam/agent/extensions';
import { target } from './control.js';
import type { SessionObservations } from './observations.js';
import {
  boundedUtf8,
  nativeChildSnapshot,
  projectChildEvent,
  publicChildSnapshot,
  type ChildSnapshot
} from './snapshot.js';
import { modelWaitAgent } from './wait-output.js';

export type WaitInput = {
  agentId?: string | undefined;
  agentIds?: string[] | undefined;
  mode?: 'any' | 'all' | undefined;
  waitFor?: 'message' | 'completion' | undefined;
  waitMs?: number | undefined;
  untilSettled?: true | undefined;
};

type WaitTarget = {
  session: AgentSession;
  metadata?: {
    description: string;
    role?: 'general-purpose' | 'explore';
    modelId?: string;
    modelName?: string;
    reasoningEffort?: string;
    extensionId?: string;
  };
  executionId?: string;
  startedBeforeTerminal?: boolean;
  terminal(): Terminal | undefined;
  snapshot(): ChildSnapshot;
  subscribe(listener: () => void): () => void;
  close(): void;
};

type Terminal = {
  status: string;
  errorCode?: string;
  errorMessage?: string;
  permissionStop?: ExecutionResult['permissionStop'];
};
function terminalStatus(type: string | undefined): string | undefined {
  if (type === 'execution.completed') return 'completed';
  if (type === 'execution.failed') return 'failed';
  if (type === 'execution.cancelled') return 'cancelled';
  return undefined;
}
function terminalFact(event: AgentEvent | undefined, full = false): Terminal | undefined {
  const status = terminalStatus(event?.type);
  if (!status || !event) return undefined;
  return {
    status,
    ...(event.type === 'execution.failed'
      ? {
          errorCode: event.code,
          ...(event.message === undefined
            ? {}
            : { errorMessage: full ? event.message : boundedUtf8(event.message, 1000).value })
        }
      : {}),
    ...(event.type === 'execution.completed' && event.permissionStop !== undefined
      ? {
          permissionStop: full
            ? event.permissionStop
            : {
                ...event.permissionStop,
                reason: boundedUtf8(event.permissionStop.reason, 1000).value
              }
        }
      : {})
  };
}

async function captureTarget(
  agent: Agent,
  session: AgentSession,
  observations: SessionObservations,
  signal: AbortSignal,
  history: Pick<Agent, 'sessionHistory'>
): Promise<WaitTarget> {
  observations.observe(session);
  let executionId: string | undefined;
  let terminal: Terminal | undefined;
  let projection: ChildSnapshot = { changedFiles: [] };
  const listeners = new Set<() => void>();
  const snapshot = session.subscribe((event) => {
    if (event.executionId !== executionId) return;
    projectChildEvent(projection, event, observations.full);
    const fact = terminalFact(event, observations.full);
    if (!fact) return;
    terminal = fact;
    for (const listener of listeners) listener();
  });
  executionId = snapshot.activeExecutionId;
  if (executionId) projection = observations.snapshot(session.id, executionId);
  terminal = terminalFact(snapshot.terminalEvent, observations.full);
  if (executionId)
    return {
      session,
      executionId,
      startedBeforeTerminal: !terminal,
      terminal: () => terminal,
      snapshot: () => projection,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      close: () => {
        listeners.clear();
        snapshot.unsubscribe();
      }
    };
  snapshot.unsubscribe();
  let cursor: string | undefined;
  let last: AgentEvent | undefined;
  const pages: AgentEvent[][] = [];
  do {
    signal.throwIfAborted();
    const page = await history.sessionHistory(session.id, {
      limit: 100,
      ...(cursor === undefined ? {} : { cursor })
    });
    signal.throwIfAborted();
    if (!last)
      last = page.entries
        .flatMap((entry) => (entry.kind === 'event' ? [entry.event] : []))
        .findLast((event) => event.type === 'execution.started' || terminalStatus(event.type));
    const events = page.entries.flatMap((entry) =>
      entry.kind === 'event' && entry.event.executionId === last?.executionId ? [entry.event] : []
    );
    pages.push(events);
    cursor = events.some((event) => event.type === 'execution.started')
      ? undefined
      : page.nextCursor;
  } while (cursor);
  const observed = observations.terminal(session.id);
  if (
    observed &&
    (observed.executionId !== last?.executionId || last.type === 'execution.started')
  ) {
    const fact = terminalFact(observed, observations.full);
    return {
      session,
      executionId: observed.executionId,
      terminal: () => fact,
      snapshot: () => observations.snapshot(session.id, observed.executionId),
      subscribe: () => () => {},
      close: () => {}
    };
  }
  if (
    last &&
    (terminalStatus(last.type) ||
      (last.type === 'execution.started' &&
        (await agent.sessionExecutionWasInterrupted(session.id, last.executionId, { signal }))))
  ) {
    for (const events of pages.reverse())
      for (const event of events) projectChildEvent(projection, event, observations.full);
    const finalEvent = last;
    const fact =
      finalEvent.type === 'execution.started'
        ? { status: 'interrupted' }
        : terminalFact(finalEvent, observations.full);
    return {
      session,
      executionId: finalEvent.executionId,
      terminal: () => fact,
      snapshot: () => projection,
      subscribe: () => () => {},
      close: () => {}
    };
  }
  throw new AgentError(
    'MAR_AGENT_SUBAGENT_EXECUTION_NOT_FOUND',
    'Session has no Execution to wait for.'
  );
}

/** A foreground wait observes fixed Execution identities, never owning or cancelling them. */
export function registerWait(
  context: SessionExtensionContext,
  agent: Agent,
  observations: SessionObservations,
  history: Pick<Agent, 'sessionHistory'> = agent
): void {
  context.tools.register({
    name: 'agent_wait',
    description:
      'Wait for direct child completion or a message; defaults to completion for 30 seconds.',
    allowedCallers: ['direct', 'programmatic'],
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: ['string', 'null'], minLength: 1 },
        agentIds: {
          type: ['array', 'null'],
          minItems: 1,
          maxItems: 8,
          uniqueItems: true,
          items: { type: 'string', minLength: 1 }
        },
        mode: { type: ['string', 'null'], enum: ['any', 'all', null] },
        waitFor: { type: ['string', 'null'], enum: ['message', 'completion', null] },
        waitMs: { type: ['integer', 'null'], minimum: 0, maximum: 300000 }
      },
      additionalProperties: false
    },
    async execute(raw, call) {
      const value = raw as { [K in keyof WaitInput]: WaitInput[K] | null };
      const input: WaitInput = {
        agentId: value.agentId ?? undefined,
        agentIds: value.agentIds ?? undefined,
        mode: value.mode ?? undefined,
        waitFor: value.waitFor ?? undefined,
        waitMs: value.waitMs ?? undefined
      };
      return waitForChild(
        context,
        agent,
        observations,
        input,
        call,
        'model',
        observations,
        history
      );
    }
  });
}

/** Model and native callers share target capture and acknowledgement, not their limits or cursors. */
export async function waitForChild(
  context: SessionExtensionContext,
  agent: Agent,
  observations: SessionObservations,
  input: WaitInput,
  call: ExtensionOperationContext,
  mode: 'model' | 'native',
  receipts: SessionObservations = observations,
  history: Pick<Agent, 'sessionHistory'> = agent
) {
  call.signal.throwIfAborted();
  if (
    (input.agentId !== undefined && input.agentIds !== undefined) ||
    (input.mode !== undefined && input.agentIds === undefined) ||
    (input.agentIds &&
      (!input.agentIds.length ||
        (mode === 'model' && input.agentIds.length > 8) ||
        new Set(input.agentIds).size !== input.agentIds.length))
  )
    throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Invalid wait targets.');
  if (input.untilSettled && (mode !== 'native' || !input.agentId || input.waitFor === 'message'))
    throw new AgentError(
      'MAR_AGENT_TOOL_INPUT_INVALID',
      'An unbounded wait requires one completion target.'
    );
  if (
    input.waitMs !== undefined &&
    (!Number.isSafeInteger(input.waitMs) ||
      input.waitMs < 0 ||
      (mode === 'model' && input.waitMs > 300000))
  )
    throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Invalid wait duration.');
  const single = input.agentIds === undefined;
  let ids = input.agentIds ?? (input.agentId ? [input.agentId] : undefined);
  if (!ids) {
    const parent = await agent.getSession(context.sessionId);
    call.signal.throwIfAborted();
    const registration = agent.observeSessionExecutions(() => {});
    ids = registration.sessions
      .filter(
        (session) =>
          session.source.parentSessionId === context.sessionId &&
          session.workspace === parent.workspace
      )
      .map((session) => session.id);
    registration.unsubscribe();
    if (!ids.length) {
      const candidates: Array<{ id: string; createdAt: string }> = [];
      let cursor: string | undefined;
      do {
        call.signal.throwIfAborted();
        const page = await agent.listSessions({
          parentSessionId: context.sessionId,
          limit: 100,
          ...(cursor === undefined ? {} : { cursor })
        });
        call.signal.throwIfAborted();
        candidates.push(
          ...page.sessions
            .filter((session) => session.workspace === parent.workspace)
            .map(({ id, createdAt }) => ({ id, createdAt }))
        );
        cursor = page.nextCursor;
      } while (cursor);
      candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      for (const candidate of candidates) {
        call.signal.throwIfAborted();
        try {
          const child = await agent.getSession(candidate.id);
          if (
            child.source.parentSessionId === context.sessionId &&
            child.workspace === parent.workspace
          ) {
            ids = [candidate.id];
            break;
          }
        } catch (error) {
          if (!(error instanceof AgentError) || error.code !== 'MAR_AGENT_SESSION_NOT_FOUND')
            throw error;
        }
      }
    }
  }
  if (!ids.length)
    throw new AgentError('MAR_AGENT_SUBAGENT_NOT_FOUND', 'No direct child Session is available.');
  const sessions = await Promise.all(
    ids.map(async (id) => {
      const result = await target(agent, context.sessionId, id);
      if (!result.child)
        throw new AgentError('MAR_AGENT_SUBAGENT_NOT_FOUND', 'Session is not available.');
      const source = result.summary.source;
      return {
        session: result.session,
        metadata: {
          description: source.type === 'subagent' ? source.description : result.summary.title,
          ...(source.type === 'subagent'
            ? {
                role: source.role,
                ...(source.extensionId === undefined ? {} : { extensionId: source.extensionId })
              }
            : {}),
          ...(result.summary.modelId === undefined ? {} : { modelId: result.summary.modelId }),
          ...(result.summary.modelName === undefined
            ? {}
            : { modelName: result.summary.modelName }),
          ...(result.summary.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: result.summary.reasoningEffort })
        }
      };
    })
  );
  const targets: WaitTarget[] = [];
  const receiptIdentities: Array<{ clientMessageId: string; executionId: string } | undefined> = [];
  try {
    for (const { session, metadata } of sessions) {
      const captured = await captureTarget(agent, session, observations, call.signal, history);
      targets.push({ ...captured, metadata });
      const identity = receipts.receipt(session.id);
      const historical =
        mode === 'model' && !identity && captured.executionId
          ? await agent.sessionInputReceipt(session.id, {
              executionId: captured.executionId,
              source: {
                sessionId: context.sessionId,
                extensionId: 'subagent',
                actors: ['model', 'code-mode']
              },
              signal: call.signal
            })
          : undefined;
      receiptIdentities.push(
        identity ??
          (historical && {
            clientMessageId: historical.clientMessageId,
            executionId: historical.executionId
          })
      );
    }
    call.signal.throwIfAborted();
    const waitFor = input.waitFor ?? 'completion';
    const read = (item: WaitTarget) => {
      const observation = item.executionId
        ? observations.capture(item.session.id, item.executionId)
        : undefined;
      const snapshot = item.session.subscribe(() => {});
      snapshot.unsubscribe();
      const observed = observation?.updates.find((update) => update.kind === 'terminal');
      const observedStatus = terminalStatus(observed?.value);
      const terminal =
        item.terminal() ??
        (snapshot.activeExecutionId === item.executionId
          ? terminalFact(snapshot.terminalEvent)
          : undefined) ??
        (observedStatus === undefined
          ? undefined
          : {
              status: observedStatus,
              ...(observed?.errorCode === undefined ? {} : { errorCode: observed.errorCode }),
              ...(observed?.errorMessage === undefined
                ? {}
                : { errorMessage: observed.errorMessage }),
              ...(observed?.permissionStop === undefined
                ? {}
                : { permissionStop: observed.permissionStop })
            });
      const message = observation?.updates.some((update) => update.kind === 'message') === true;
      return { observation, terminal, ready: !!terminal || (waitFor === 'message' && message) };
    };
    const ready = () => {
      const items = targets.map(read);
      return input.mode === 'all'
        ? items.every((item) => item.ready)
        : items.some((item) => item.ready);
    };
    const duration = input.untilSettled
      ? Number.MAX_SAFE_INTEGER
      : (input.waitMs ?? (mode === 'model' ? 30000 : 0));
    let outcome: 'snapshot' | 'ready' | 'timeout' | 'interrupted' = 'snapshot';
    if (duration !== 0)
      outcome = await waitForToolCondition({
        ready,
        subscribe: (listener) => {
          const releases = [
            observations.wake.subscribe(listener),
            ...targets.map((target) => target.subscribe(listener))
          ];
          return () => {
            for (const release of releases) release();
          };
        },
        waitMs: mode === 'model' ? Math.max(10000, duration) : duration,
        signal: call.signal,
        ...(mode === 'model' ? { interrupt: call.waitInterrupt } : {})
      });
    call.signal.throwIfAborted();
    const values = targets.map((item) => ({ item, ...read(item) }));
    const selected = single
      ? [
          values.find((value) => value.ready) ??
            values.find((value) => value.observation) ??
            values[0]!
        ]
      : values;
    const receiptFacts = await Promise.all(
      selected.map(async ({ item }) => {
        const identity = receiptIdentities[targets.indexOf(item)];
        if (!identity) return undefined;
        const fact = await agent.sessionInputReceipt(item.session.id, identity);
        return fact &&
          (fact.executionId === item.executionId || fact.appliedExecutionId === item.executionId)
          ? fact
          : undefined;
      })
    );
    call.signal.throwIfAborted();
    const agents = selected.map(({ item, observation, terminal, ready: isReady }, index) => {
      const waitOutcome =
        outcome === 'snapshot'
          ? 'snapshot'
          : terminal
            ? 'completion'
            : isReady
              ? 'message'
              : outcome === 'interrupted'
                ? 'interrupted'
                : outcome === 'timeout'
                  ? 'timeout'
                  : 'snapshot';
      const include =
        outcome !== 'snapshot' && (isReady || outcome === 'timeout' || outcome === 'interrupted');
      const freshTerminal =
        include &&
        terminal &&
        item.executionId &&
        (observations.claimTerminal(item.session.id, item.executionId) ||
          item.startedBeforeTerminal);
      const progress =
        mode === 'native' && include && !terminal && observation
          ? nativeChildSnapshot(item.snapshot())
          : undefined;
      const projection = freshTerminal
        ? mode === 'native'
          ? nativeChildSnapshot(item.snapshot())
          : publicChildSnapshot(item.snapshot())
        : progress
          ? {
              ...(progress.latestMessage ? { latestMessage: progress.latestMessage } : {}),
              ...(progress.latestActivity ? { latestActivity: progress.latestActivity } : {})
            }
          : {};
      const updates =
        mode === 'model' &&
        'summary' in projection &&
        projection.summary &&
        !projection.summaryTruncated
          ? observation?.updates.filter((update) => !('final' in update && update.final))
          : observation?.updates;
      if (include) observation?.acknowledge();
      return {
        agentId: item.session.id,
        ...(item.executionId ? { executionId: item.executionId } : {}),
        ...(mode === 'native' ? item.metadata : {}),
        status: terminal?.status ?? 'running',
        waitOutcome,
        ...(terminal?.errorCode === undefined ? {} : { errorCode: terminal.errorCode }),
        ...(terminal?.errorMessage === undefined ? {} : { errorMessage: terminal.errorMessage }),
        ...(terminal?.permissionStop === undefined
          ? {}
          : { permissionStop: terminal.permissionStop }),
        ...projection,
        ...(receiptFacts[index] ? { receipt: receiptFacts[index] } : {}),
        ...(include && updates?.length ? { updates } : {})
      };
    });
    const groupOutcome =
      outcome === 'ready'
        ? values.filter((value) => value.ready).every((value) => value.terminal)
          ? 'completion'
          : 'message'
        : outcome;
    const data = single
      ? {
          ...agents[0],
          waitFor,
          ...(groupOutcome === 'interrupted' ? { waitOutcome: 'interrupted', reason: 'steer' } : {})
        }
      : {
          mode: input.mode ?? 'any',
          waitFor,
          waitOutcome: groupOutcome,
          ...(groupOutcome === 'interrupted' ? { reason: 'steer' } : {}),
          agents,
          pendingAgentIds: values
            .filter((value) => !value.ready)
            .map((value) => value.item.session.id)
        };
    if (mode === 'native') return { data, content: JSON.stringify(data) };
    const modelAgents = agents.map((item) =>
      modelWaitAgent(item, Math.floor(34000 / agents.length))
    );
    const modelData = single
      ? {
          ...modelAgents[0],
          waitFor,
          ...(groupOutcome === 'interrupted' ? { waitOutcome: 'interrupted', reason: 'steer' } : {})
        }
      : { ...data, agents: modelAgents };
    return { data, content: JSON.stringify(modelData) };
  } finally {
    for (const item of targets) item.close();
  }
}
