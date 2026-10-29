import {
  AgentError,
  type Agent,
  type AgentEvent,
  type AgentReasoningEffort,
  type AgentSessionInputReceipt,
  type ExecutionResult
} from '@myagentroam/agent';
import type { ExtensionServiceKey, SessionExtensionContext } from '@myagentroam/agent/extensions';
import type { ExtensionServiceConsumer } from '@myagentroam/agent/extensions';
import { SessionObservations } from './observations.js';
import { startChild, type StartAdmission } from './start.js';
import { sendChild, stopChild } from './control.js';
import { waitForChild, type WaitInput } from './wait.js';
import { nativeChildSnapshot, projectChildEvent, type ChildSnapshot } from './snapshot.js';
import { historicalExecutionStatus } from './history.js';

export interface NativeSpawnInput {
  readonly prompt: string;
  readonly description?: string;
  readonly role?: 'general-purpose' | 'explore';
  readonly modelId?: string;
  readonly reasoningEffort?: AgentReasoningEffort;
  readonly background?: boolean;
  readonly waitFor?: 'start' | 'completion';
  readonly signal?: AbortSignal;
  readonly turnSignal?: AbortSignal;
}
export interface NativeWaitInput extends WaitInput {
  readonly signal?: AbortSignal;
}
export interface NativeAgentSnapshot extends Record<string, unknown> {
  readonly agentId: string;
  readonly description: string;
  readonly status:
    'idle' | 'not-started' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  readonly executionId?: string;
  readonly role?: 'general-purpose' | 'explore';
  readonly extensionId?: string;
  readonly modelId?: string;
  readonly modelName?: string;
  readonly reasoningEffort?: string;
  readonly summary?: string;
  readonly turnId?: string;
  readonly receipt?: AgentSessionInputReceipt;
  readonly changedFiles?: readonly string[];
  readonly latestMessage?: ChildSnapshot['latestMessage'];
  readonly latestActivity?: ChildSnapshot['latestActivity'];
  readonly verification?: readonly string[];
  readonly evidence?: readonly { path: string; startLine?: number; endLine?: number }[];
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly permissionStop?: ExecutionResult['permissionStop'];
  readonly waitOutcome?: 'snapshot' | 'message' | 'completion' | 'timeout' | 'interrupted';
}
export interface NativeAgentGroup extends Record<string, unknown> {
  readonly mode: 'any' | 'all';
  readonly waitFor: 'message' | 'completion';
  readonly waitOutcome: 'snapshot' | 'message' | 'completion' | 'timeout' | 'interrupted';
  readonly agents: readonly NativeAgentSnapshot[];
  readonly pendingAgentIds: readonly string[];
}
export interface NativeSubagentClient {
  spawn(input: NativeSpawnInput): Promise<NativeAgentSnapshot>;
  wait(input: NativeWaitInput): Promise<NativeAgentSnapshot | NativeAgentGroup>;
  list(input?: { signal?: AbortSignal }): Promise<readonly NativeAgentSnapshot[]>;
  inspect(input: { agentId: string; signal?: AbortSignal }): Promise<NativeAgentSnapshot>;
  message(input: {
    agentId: string;
    message: string;
    delivery?: 'append' | 'replace';
    signal?: AbortSignal;
  }): Promise<Record<string, unknown>>;
  cancel(input: {
    agentId: string;
    executionId?: string;
    signal?: AbortSignal;
  }): Promise<NativeAgentSnapshot>;
  close(): Promise<void>;
}
export interface NativeSubagentService {
  open(): NativeSubagentClient;
}
export type ExtensionAgentSnapshot = NativeAgentSnapshot;
export type ExtensionAgentManySnapshot = NativeAgentGroup;
export type ExtensionAgentSpawnInput = NativeSpawnInput;
export type ExtensionAgentWaitInput = NativeWaitInput;
export type ExtensionAgentsApi = NativeSubagentClient;
interface NativeProvider extends NativeSubagentService {
  bind(consumer: ExtensionServiceConsumer): NativeSubagentService;
}
export const SUBAGENT_NATIVE_SERVICE: ExtensionServiceKey<NativeSubagentService> = {
  id: 'subagent.native',
  scope: 'session',
  bindConsumer: (service, consumer) => (service as NativeProvider).bind(consumer)
};

/** Each native client owns an independent observation cursor, never a Session Execution. */
export function nativeSubagentService(
  context: SessionExtensionContext,
  agent: Agent,
  admission: StartAdmission,
  warmObservations: ReadonlyMap<string, SessionObservations>,
  parentWorkspace: string,
  historyReader: Pick<Agent, 'sessionHistory'> = agent
): { service: NativeSubagentService; close(): Promise<void> } {
  const clients = new Set<() => Promise<void>>();
  let closed = false;
  return {
    service: {
      open() {
        throw new AgentError('MAR_AGENT_EXTENSION_SERVICE_SCOPE', 'A consumer scope is required.');
      },
      bind(consumer: ExtensionServiceConsumer) {
        return {
          open() {
            if (closed)
              throw new AgentError('MAR_AGENT_EXTENSION_DISPOSED', 'Subagent service is closed.');
            const observations = new SessionObservations(true, historyReader);
            const pending = new Set<Promise<unknown>>();
            const closingSignal = new AbortController();
            let clientClosed = false;
            const observe = (
              session: Parameters<Parameters<Agent['observeSessionExecutions']>[0]>[0]
            ) => {
              if (
                !clientClosed &&
                session.source.parentSessionId === context.sessionId &&
                session.workspace === parentWorkspace
              )
                observations.observe(session);
            };
            const registration = agent.observeSessionExecutions(observe);
            for (const session of registration.sessions) observe(session);
            let closing: Promise<void> | undefined;
            const close = () =>
              (closing ??= (async () => {
                clientClosed = true;
                closingSignal.abort();
                registration.unsubscribe();
                await Promise.allSettled([...pending]);
                observations.close();
                clients.delete(close);
              })());
            clients.add(close);
            try {
              consumer.onDispose(close);
            } catch (error) {
              void close().catch(() => {});
              throw error;
            }
            const run = <T>(
              action: Parameters<typeof consumer.run<T>>[0],
              signal?: AbortSignal
            ) => {
              if (clientClosed)
                throw new AgentError('MAR_AGENT_EXTENSION_DISPOSED', 'Subagent client is closed.');
              const effectiveSignal = signal
                ? AbortSignal.any([signal, closingSignal.signal])
                : closingSignal.signal;
              const operation = consumer.run(action, effectiveSignal);
              pending.add(operation);
              void operation.finally(() => pending.delete(operation)).catch(() => {});
              return operation;
            };
            return {
              async spawn(input) {
                if (
                  !input ||
                  typeof input.prompt !== 'string' ||
                  !input.prompt.trim() ||
                  (input.description !== undefined && !input.description.trim()) ||
                  (input.role !== undefined &&
                    !['general-purpose', 'explore'].includes(input.role)) ||
                  (input.waitFor !== undefined &&
                    !['start', 'completion'].includes(input.waitFor)) ||
                  (input.background !== undefined && typeof input.background !== 'boolean')
                )
                  throw new AgentError(
                    'MAR_AGENT_EXTENSION_AGENT_INPUT_INVALID',
                    'Agent spawn input is invalid.'
                  );
                return run(async (call) => {
                  const started = await startChild(
                    context,
                    agent,
                    admission,
                    {
                      prompt: input.prompt,
                      description: input.description ?? 'Extension agent',
                      role: input.role ?? 'general-purpose',
                      ...(input.turnSignal === undefined ? {} : { turnSignal: input.turnSignal }),
                      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
                      ...(input.reasoningEffort === undefined
                        ? {}
                        : { reasoningEffort: input.reasoningEffort })
                    },
                    call,
                    'native'
                  );
                  if (
                    !started.execution ||
                    !(
                      input.waitFor === 'completion' ||
                      (input.waitFor === undefined && input.background === false)
                    )
                  )
                    return started.data as NativeAgentSnapshot;
                  const result = await waitForChild(
                    context,
                    agent,
                    observations,
                    { agentId: String(started.data.agentId), untilSettled: true },
                    call,
                    'native',
                    observations,
                    historyReader
                  );
                  return { ...started.data, ...result.data } as NativeAgentSnapshot;
                }, input.signal);
              },
              async wait(input) {
                if (!input || typeof input !== 'object')
                  throw new AgentError(
                    'MAR_AGENT_EXTENSION_AGENT_INPUT_INVALID',
                    'Agent wait input is invalid.'
                  );
                return run(
                  async (call) =>
                    (
                      await waitForChild(
                        context,
                        agent,
                        observations,
                        input,
                        call,
                        'native',
                        observations,
                        historyReader
                      )
                    ).data as NativeAgentSnapshot | NativeAgentGroup,
                  input.signal
                );
              },
              async list(input = {}) {
                return run(async (call) => {
                  const parent = await agent.getSession(context.sessionId);
                  const children: Array<{ createdAt: string; snapshot: NativeAgentSnapshot }> = [];
                  const live = new Map<
                    string,
                    Parameters<Parameters<Agent['observeSessionExecutions']>[0]>[0]
                  >();
                  const registration = agent.observeSessionExecutions((session) => {
                    live.set(session.id, session);
                  });
                  for (const session of registration.sessions) live.set(session.id, session);
                  let cursor: string | undefined;
                  try {
                    do {
                      call.signal.throwIfAborted();
                      const page = await agent.listSessions({
                        parentSessionId: context.sessionId,
                        limit: 100,
                        ...(cursor ? { cursor } : {})
                      });
                      for (const session of page.sessions)
                        if (session.workspace === parent.workspace) {
                          call.signal.throwIfAborted();
                          const subscription = live.get(session.id)?.subscribe(() => {});
                          const terminalEvent = subscription?.terminalEvent;
                          const active = subscription?.activeExecutionId;
                          subscription?.unsubscribe();
                          let history: Awaited<ReturnType<typeof historicalExecutionStatus>>;
                          try {
                            history = await historicalExecutionStatus(
                              agent,
                              session.id,
                              call.signal,
                              {
                                details: true,
                                history: historyReader,
                                ...(active ? { activeExecutionId: active } : {})
                              }
                            );
                          } catch (error) {
                            if (
                              error instanceof Error &&
                              'code' in error &&
                              error.code === 'MAR_AGENT_SESSION_NOT_FOUND'
                            )
                              continue;
                            throw error;
                          }
                          let status: NativeAgentSnapshot['status'] = active
                            ? 'running'
                            : history.status;
                          let currentExecutionId = active ?? history.executionId;
                          if (terminalEvent)
                            status = terminalEvent.type.slice(
                              'execution.'.length
                            ) as NativeAgentSnapshot['status'];
                          else if (!active) {
                            const latest = live.get(session.id)?.subscribe(() => {});
                            if (latest?.activeExecutionId && !latest.terminalEvent) {
                              status = 'running';
                              currentExecutionId = latest.activeExecutionId;
                            } else if (latest?.terminalEvent) {
                              status = latest.terminalEvent.type.slice(
                                'execution.'.length
                              ) as NativeAgentSnapshot['status'];
                              currentExecutionId = latest.activeExecutionId;
                            }
                            latest?.unsubscribe();
                          }
                          const observed = observations.terminal(session.id);
                          if (
                            status !== 'running' &&
                            !terminalEvent &&
                            observed &&
                            observed.executionId !== history.executionId
                          ) {
                            status = observed.type.slice(
                              'execution.'.length
                            ) as NativeAgentSnapshot['status'];
                            currentExecutionId = observed.executionId;
                          }
                          const details =
                            history.executionId === currentExecutionId
                              ? history.details
                              : currentExecutionId
                                ? nativeChildSnapshot(
                                    observations.snapshot(session.id, currentExecutionId)
                                  )
                                : undefined;
                          const visibleDetails =
                            status === 'running' && details
                              ? {
                                  ...(details.latestMessage
                                    ? { latestMessage: details.latestMessage }
                                    : {}),
                                  ...(details.latestActivity
                                    ? { latestActivity: details.latestActivity }
                                    : {})
                                }
                              : details;
                          children.push({
                            createdAt: session.createdAt,
                            snapshot: {
                              agentId: session.id,
                              status,
                              description:
                                session.source.type === 'subagent'
                                  ? session.source.description
                                  : session.title,
                              ...(currentExecutionId === undefined
                                ? {}
                                : { executionId: currentExecutionId }),
                              ...visibleDetails,
                              ...(history.executionId === currentExecutionId &&
                              history.errorCode !== undefined
                                ? {
                                    errorCode: history.errorCode,
                                    ...(history.errorMessage === undefined
                                      ? {}
                                      : { errorMessage: history.errorMessage })
                                  }
                                : {}),
                              ...(history.executionId === currentExecutionId &&
                              history.permissionStop
                                ? { permissionStop: history.permissionStop }
                                : {}),
                              ...(observed?.type === 'execution.failed' &&
                              observed.executionId === currentExecutionId
                                ? {
                                    errorCode: observed.code,
                                    ...(observed.message === undefined
                                      ? {}
                                      : { errorMessage: observed.message })
                                  }
                                : {}),
                              ...(session.modelId === undefined
                                ? {}
                                : { modelId: session.modelId }),
                              ...(session.modelName === undefined
                                ? {}
                                : { modelName: session.modelName }),
                              ...(session.reasoningEffort === undefined
                                ? {}
                                : { reasoningEffort: session.reasoningEffort }),
                              ...(session.source.type === 'subagent'
                                ? {
                                    role: session.source.role,
                                    ...(session.source.extensionId === undefined
                                      ? {}
                                      : { extensionId: session.source.extensionId })
                                  }
                                : {})
                            }
                          });
                        }
                      cursor = page.nextCursor;
                    } while (cursor);
                  } finally {
                    registration.unsubscribe();
                  }
                  return children
                    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
                    .map(({ snapshot }) => snapshot);
                }, input.signal);
              },
              async inspect(input) {
                if (!input || typeof input.agentId !== 'string' || !input.agentId)
                  throw new AgentError(
                    'MAR_AGENT_EXTENSION_AGENT_INPUT_INVALID',
                    'Agent target is invalid.'
                  );
                return run(async (call) => {
                  const parent = await agent.getSession(context.sessionId);
                  const child = await agent.getSession(input.agentId);
                  if (
                    child.workspace !== parent.workspace ||
                    child.source.parentSessionId !== parent.id
                  )
                    throw new AgentError(
                      'MAR_AGENT_SUBAGENT_NOT_FOUND',
                      'Session is not available.'
                    );
                  call.signal.throwIfAborted();
                  try {
                    const state = (
                      await waitForChild(
                        context,
                        agent,
                        observations,
                        { agentId: child.id, waitMs: 0 },
                        call,
                        'native',
                        observations,
                        historyReader
                      )
                    ).data as NativeAgentSnapshot;
                    const pages: AgentEvent[][] = [];
                    let cursor: string | undefined;
                    if (state.executionId)
                      do {
                        call.signal.throwIfAborted();
                        const page = await historyReader.sessionHistory(child.id, {
                          limit: 100,
                          ...(cursor === undefined ? {} : { cursor })
                        });
                        call.signal.throwIfAborted();
                        const events = page.entries.flatMap((entry) =>
                          entry.kind === 'event' && entry.event.executionId === state.executionId
                            ? [entry.event]
                            : []
                        );
                        pages.push(events);
                        cursor = events.some((event) => event.type === 'execution.started')
                          ? undefined
                          : page.nextCursor;
                      } while (cursor);
                    const full: ChildSnapshot = { changedFiles: [] };
                    for (const events of pages.reverse())
                      for (const event of events) projectChildEvent(full, event, true);
                    if (state.executionId) {
                      const live = observations.snapshot(child.id, state.executionId);
                      if (live.summary !== undefined) {
                        full.summary = live.summary;
                        if (live.turnId === undefined) delete full.turnId;
                        else full.turnId = live.turnId;
                      }
                      for (const file of live.changedFiles)
                        if (!full.changedFiles.includes(file)) full.changedFiles.push(file);
                    }
                    return {
                      ...state,
                      ...nativeChildSnapshot(full),
                      modelId: child.modelId,
                      description:
                        child.source.type === 'subagent' ? child.source.description : child.title
                    } as NativeAgentSnapshot;
                  } catch (error) {
                    if (
                      !(error instanceof AgentError) ||
                      error.code !== 'MAR_AGENT_SUBAGENT_EXECUTION_NOT_FOUND'
                    )
                      throw error;
                    return {
                      agentId: child.id,
                      status: 'idle',
                      modelId: child.modelId,
                      description:
                        child.source.type === 'subagent' ? child.source.description : child.title
                    };
                  }
                }, input.signal);
              },
              async message(input) {
                if (
                  !input ||
                  typeof input.agentId !== 'string' ||
                  !input.agentId ||
                  typeof input.message !== 'string' ||
                  !input.message.trim() ||
                  (input.delivery !== undefined && !['append', 'replace'].includes(input.delivery))
                )
                  throw new AgentError(
                    'MAR_AGENT_EXTENSION_AGENT_INPUT_INVALID',
                    'Agent message input is invalid.'
                  );
                return run(async (call) => {
                  const result = await sendChild(
                    context,
                    agent,
                    observations,
                    warmObservations,
                    admission,
                    {
                      agentId: input.agentId,
                      content: input.message,
                      ...(input.delivery ? { delivery: input.delivery } : {})
                    },
                    call,
                    'native'
                  );
                  return result;
                }, input.signal);
              },
              async cancel(input) {
                if (!input || typeof input.agentId !== 'string' || !input.agentId)
                  throw new AgentError(
                    'MAR_AGENT_EXTENSION_AGENT_INPUT_INVALID',
                    'Agent target is invalid.'
                  );
                return run(async (call) => {
                  const result = await stopChild(context, agent, observations, input, call);
                  const child = await agent.getSession(input.agentId);
                  return {
                    ...result,
                    description:
                      child.source.type === 'subagent' ? child.source.description : child.title,
                    modelId: child.modelId
                  } as NativeAgentSnapshot;
                }, input.signal);
              },
              close
            };
          }
        };
      }
    } as NativeProvider,
    async close() {
      closed = true;
      await Promise.all([...clients].map((close) => close()));
    }
  };
}
