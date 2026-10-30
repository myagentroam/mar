import { randomUUID } from 'node:crypto';
import type { NodeAgentSession } from '../session/contracts.js';
import { isPlainRecord } from '../util/records.js';
import { safeErrorCode } from '../util/safe-error.js';
import { parseAgentGoal, type AgentGoalChange } from './agent-network-goal.js';
import type { AgentNetworkObservations } from './agent-network-observations.js';
import {
  validateAgentWaitOptions,
  waitForAgentTargets,
  type AgentWaitTarget
} from './agent-network-wait.js';
import type { ExtensionOperationContext, ToolWaitInterrupt } from '@myagentroam/agent/extensions';

export type AgentNetworkAction = 'start' | 'send' | 'wait' | 'stop' | 'list' | 'view';
export type ResolvedTargets = (sessions: readonly NodeAgentSession[]) => Promise<void>;
export type AgentNetworkInvoke = (
  executionId: string,
  action: AgentNetworkAction,
  input: Record<string, unknown>,
  context: ExtensionOperationContext,
  onResolved?: ResolvedTargets
) => Promise<unknown>;

export interface AgentNetworkActor {
  readonly sessionId: string;
  /** Per-call observation key for a terminal without a Session. */
  readonly observationId?: string;
  /** Captured by the authenticated execution, never taken from model tool arguments. */
  readonly runId?: string;
  readonly executionId?: string;
  readonly requestUserId?: number;
  readonly secretEnvironment?: Readonly<Record<string, string>>;
  readonly runnerConfiguration?: Readonly<Record<string, unknown>>;
  readonly usageGrant?: import('@myagentroam/protocol').ModelUsageGrant;
  readonly personalInstructions?: string;
}

export interface AgentNetworkListInput {
  readonly scope?: 'workspace' | 'children' | 'descendants' | 'profile';
  readonly agentId?: string;
  readonly parent?: string;
  readonly runner?: string;
  readonly query?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

interface AgentNetworkServiceOptions {
  readonly observations: AgentNetworkObservations;
  /** Resolves a target in the caller's actual Workspace. */
  readonly target: (actor: AgentNetworkActor, agentId: string) => Promise<NodeAgentSession>;
  readonly authorize: (
    actor: AgentNetworkActor,
    session: NodeAgentSession,
    operation: 'send' | 'goal' | 'stop' | 'wait'
  ) => Promise<void>;
  readonly children: (actor: AgentNetworkActor) => Promise<readonly NodeAgentSession[]>;
  /** Ensure the caller's automatic channel exists, only for a verified direct child. */
  readonly observe: (actor: AgentNetworkActor, session: NodeAgentSession) => void;
  readonly freezeExecution: (session: NodeAgentSession) => AgentWaitTarget | undefined;
  readonly start: (
    actor: AgentNetworkActor,
    input: {
      readonly content: string;
      readonly clientMessageId: string;
      readonly runner?: string;
      readonly modelId?: string;
      readonly effort?: string;
      readonly title?: string;
      readonly parentSessionId?: string;
      readonly attachments?: readonly unknown[];
      readonly attachmentIds?: readonly string[];
      readonly goal: AgentGoalChange;
    },
    signal?: AbortSignal
  ) => Promise<{ readonly session: NodeAgentSession; readonly result: unknown }>;
  readonly setGoal: (
    actor: AgentNetworkActor,
    session: NodeAgentSession,
    change: Exclude<AgentGoalChange, { kind: 'unchanged' }>,
    message?: {
      readonly clientMessageId: string;
      readonly content: string;
      readonly deliveryIntent: 'SEND' | 'QUEUE' | 'REPLACE_CURRENT';
      readonly attachments?: readonly unknown[];
      readonly attachmentIds?: readonly string[];
    },
    signal?: AbortSignal
  ) => Promise<unknown>;
  readonly message: (
    actor: AgentNetworkActor,
    session: NodeAgentSession,
    input: {
      readonly clientMessageId: string;
      readonly content: string;
      readonly deliveryIntent: 'SEND' | 'QUEUE' | 'REPLACE_CURRENT';
      readonly attachments?: readonly unknown[];
      readonly attachmentIds?: readonly string[];
    },
    signal?: AbortSignal
  ) => Promise<unknown>;
  readonly approval: (
    actor: AgentNetworkActor,
    session: NodeAgentSession,
    input: {
      readonly approvalId: string;
      readonly decision: 'approve' | 'reject';
    },
    signal?: AbortSignal
  ) =>
    | Promise<{
        readonly status: 'applied' | 'partial';
        readonly result?: unknown;
        readonly code?: string;
      }>
    | { readonly status: 'applied' | 'partial'; readonly result?: unknown; readonly code?: string };
  readonly validateApproval: (
    actor: AgentNetworkActor,
    session: NodeAgentSession,
    input: {
      readonly approvalId: string;
      readonly decision: 'approve' | 'reject';
    }
  ) => Promise<void>;
  readonly stop: (
    actor: AgentNetworkActor,
    session: NodeAgentSession,
    executionId: string
  ) => unknown;
  readonly goal: (sessionId: string) => unknown;
  readonly list: (actor: AgentNetworkActor, input: AgentNetworkListInput) => Promise<unknown>;
  readonly view: (
    actor: AgentNetworkActor,
    input: {
      readonly agentId: string;
      readonly includeHistory?: boolean;
      readonly limit?: number;
      readonly cursor?: string;
    },
    onResolved?: ResolvedTargets
  ) => Promise<unknown>;
}

/** Product collaboration delegates execution and Goal ownership to existing Node services. */
export class AgentNetworkService {
  constructor(private readonly options: AgentNetworkServiceOptions) {}

  list(actor: AgentNetworkActor, input: AgentNetworkListInput = {}): Promise<unknown> {
    return this.options.list(actor, input);
  }

  view(
    actor: AgentNetworkActor,
    input: {
      readonly agentId: string;
      readonly includeHistory?: boolean;
      readonly limit?: number;
      readonly cursor?: string;
    },
    onResolved?: ResolvedTargets
  ): Promise<unknown> {
    return this.options.view(actor, input, onResolved);
  }

  async start(
    actor: AgentNetworkActor,
    input: {
      readonly content?: string;
      readonly runner?: string;
      readonly modelId?: string;
      readonly effort?: string;
      readonly title?: string;
      readonly parentSessionId?: string;
      readonly goal?: unknown;
      readonly attachments?: readonly unknown[];
      readonly attachmentIds?: readonly string[];
      readonly clientMessageId?: string;
    },
    signal?: AbortSignal,
    onResolved?: ResolvedTargets
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const goal = parseAgentGoal(input.goal);
    const content = input.content ?? '';
    if (
      typeof content !== 'string' ||
      (!content.trim() && !input.attachments?.length && !input.attachmentIds?.length) ||
      (input.attachments !== undefined && !Array.isArray(input.attachments)) ||
      (input.attachmentIds !== undefined &&
        (!Array.isArray(input.attachmentIds) ||
          input.attachmentIds.some((id) => typeof id !== 'string' || !id))) ||
      (!!input.attachments?.length && !!input.attachmentIds?.length) ||
      !validOptionalString(input.runner) ||
      'model' in input ||
      !validOptionalString(input.modelId) ||
      !validOptionalString(input.effort) ||
      !validOptionalString(input.title) ||
      !validOptionalString(input.parentSessionId) ||
      !validOptionalString(input.clientMessageId)
    )
      throw new Error('AGENT_START_INVALID');
    const { goal: _goal, ...start } = input;
    const created = await this.options.start(
      actor,
      {
        ...start,
        content,
        clientMessageId: input.clientMessageId ?? randomUUID(),
        goal
      },
      signal
    );
    await onResolved?.([created.session]);
    try {
      if (created.session.parentSessionId === actor.sessionId)
        this.options.observe(actor, created.session);
      return { agentId: created.session.id, start: created.result };
    } catch (error) {
      return {
        agentId: created.session.id,
        start: created.result,
        observation: { status: 'failed', code: safeErrorCode(error, 'AGENT_OBSERVATION_FAILED') }
      };
    }
  }

  async send(
    actor: AgentNetworkActor,
    input: {
      readonly agentId: string;
      readonly content?: string;
      readonly goal?: unknown;
      readonly deliveryIntent?: 'SEND' | 'QUEUE' | 'REPLACE_CURRENT';
      readonly attachments?: readonly unknown[];
      readonly attachmentIds?: readonly string[];
      readonly clientMessageId?: string;
      readonly approval?: { readonly approvalId: string; readonly decision: 'approve' | 'reject' };
    },
    signal?: AbortSignal,
    onResolved?: ResolvedTargets
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const goal = parseAgentGoal(input.goal);
    const content = input.content ?? '';
    if (
      typeof input.agentId !== 'string' ||
      !input.agentId ||
      typeof content !== 'string' ||
      (!content.trim() &&
        !input.attachments?.length &&
        !input.attachmentIds?.length &&
        goal.kind === 'unchanged' &&
        input.approval === undefined) ||
      (input.attachments !== undefined && !Array.isArray(input.attachments)) ||
      (input.attachmentIds !== undefined &&
        (!Array.isArray(input.attachmentIds) ||
          input.attachmentIds.some((id) => typeof id !== 'string' || !id))) ||
      (!!input.attachments?.length && !!input.attachmentIds?.length) ||
      !validOptionalString(input.clientMessageId) ||
      (input.approval !== undefined &&
        (!isPlainRecord(input.approval) ||
          Object.keys(input.approval).some((key) => key !== 'approvalId' && key !== 'decision') ||
          typeof input.approval.approvalId !== 'string' ||
          !input.approval.approvalId ||
          !['approve', 'reject'].includes(input.approval.decision)))
    )
      throw new Error('AGENT_SEND_INVALID');
    if (
      input.deliveryIntent !== undefined &&
      !['SEND', 'QUEUE', 'REPLACE_CURRENT'].includes(input.deliveryIntent)
    )
      throw new Error('AGENT_SEND_INVALID');
    const hasMessage =
      !!content.trim() || !!input.attachments?.length || !!input.attachmentIds?.length;
    const session = await this.options.target(actor, input.agentId);
    signal?.throwIfAborted();
    if (hasMessage) await this.options.authorize(actor, session, 'send');
    if (goal.kind !== 'unchanged') await this.options.authorize(actor, session, 'goal');
    if (input.approval !== undefined)
      await this.options.validateApproval(actor, session, input.approval);
    signal?.throwIfAborted();
    await onResolved?.([session]);
    if (session.parentSessionId === actor.sessionId) this.options.observe(actor, session);
    const approvalResult =
      input.approval === undefined
        ? undefined
        : await this.options.approval(actor, session, input.approval, signal);
    const approvalReceipt = input.approval === undefined ? {} : { approval: approvalResult };
    if (approvalResult?.status === 'partial')
      return {
        agentId: session.id,
        ...approvalReceipt,
        ...(goal.kind === 'unchanged' ? {} : { goal: { status: 'not_attempted' } }),
        message: { status: 'not_attempted' }
      };
    if (signal?.aborted && approvalResult !== undefined)
      return {
        agentId: session.id,
        ...approvalReceipt,
        ...(goal.kind === 'unchanged' ? {} : { goal: { status: 'not_attempted' } }),
        message: { status: 'not_attempted' }
      };
    signal?.throwIfAborted();
    const captured = this.options.observations.get(actor.sessionId)?.captureBeforeSend(session.id);
    const message = hasMessage
      ? {
          clientMessageId: input.clientMessageId ?? randomUUID(),
          content,
          deliveryIntent: input.deliveryIntent ?? ('SEND' as const),
          ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
          ...(input.attachmentIds === undefined ? {} : { attachmentIds: input.attachmentIds })
        }
      : undefined;
    let goalResult: unknown;
    if (goal.kind !== 'unchanged') {
      const previous = this.options.goal(session.id);
      try {
        goalResult = await this.options.setGoal(
          actor,
          session,
          goal,
          goal.kind === 'set' ? message : undefined,
          signal
        );
        if (goal.kind === 'set' && message) captured?.acknowledge();
      } catch (error) {
        const current = this.options.goal(session.id);
        if (sameGoal(current, previous) && input.approval === undefined) throw error;
        return {
          agentId: session.id,
          ...approvalReceipt,
          goal: {
            status: 'failed',
            code: safeErrorCode(error, 'AGENT_GOAL_FAILED'),
            current: current ?? null
          },
          message: { status: goal.kind === 'set' && message ? 'unknown' : 'not_attempted' }
        };
      }
    }
    if (!message || goal.kind === 'set')
      return {
        agentId: session.id,
        ...approvalReceipt,
        ...(goal.kind === 'unchanged' ? {} : { goal: { status: 'applied', result: goalResult } }),
        message: message ? { status: 'accepted', result: goalResult } : null
      };
    if (signal?.aborted && (goal.kind !== 'unchanged' || approvalResult !== undefined))
      return {
        agentId: session.id,
        ...approvalReceipt,
        ...(goal.kind === 'unchanged' ? {} : { goal: { status: 'applied', result: goalResult } }),
        message: { status: 'not_attempted' }
      };
    signal?.throwIfAborted();
    try {
      const result = await this.options.message(actor, session, message, signal);
      captured?.acknowledge();
      return {
        agentId: session.id,
        ...approvalReceipt,
        ...(goal.kind === 'unchanged' ? {} : { goal: { status: 'applied', result: goalResult } }),
        message: { status: 'accepted', result }
      };
    } catch (error) {
      if (signal?.aborted && error === signal.reason) {
        if (goal.kind === 'unchanged' && approvalResult === undefined) throw error;
        return {
          agentId: session.id,
          ...approvalReceipt,
          ...(goal.kind === 'unchanged' ? {} : { goal: { status: 'applied', result: goalResult } }),
          message: { status: 'not_attempted' }
        };
      }
      return {
        agentId: session.id,
        ...approvalReceipt,
        ...(goal.kind === 'unchanged' ? {} : { goal: { status: 'applied', result: goalResult } }),
        message: { status: 'unknown', code: safeErrorCode(error, 'AGENT_SEND_FAILED') }
      };
    }
  }

  async stop(
    actor: AgentNetworkActor,
    input: {
      readonly agentId: string;
      readonly executionId: string;
    },
    onResolved?: ResolvedTargets
  ): Promise<unknown> {
    if (
      typeof input.agentId !== 'string' ||
      !input.agentId ||
      typeof input.executionId !== 'string' ||
      !input.executionId
    )
      throw new Error('AGENT_STOP_INVALID');
    const session = await this.options.target(actor, input.agentId);
    await this.options.authorize(actor, session, 'stop');
    await onResolved?.([session]);
    const goalBefore = this.options.goal(session.id);
    try {
      const result = this.options.stop(actor, session, input.executionId);
      return {
        agentId: session.id,
        executionId: input.executionId,
        cancel: { status: 'accepted', result },
        goal: {
          status:
            goalBefore != null && this.options.goal(session.id) == null ? 'cleared' : 'unchanged'
        }
      };
    } catch (error) {
      const code = safeErrorCode(error, 'AGENT_STOP_FAILED');
      if (code === 'RUN_EXECUTION_STALE' || code === 'RUN_OWNED_BY_ANOTHER_USER') throw error;
      const current = this.options.goal(session.id);
      return {
        agentId: session.id,
        executionId: input.executionId,
        cancel: { status: 'unknown', code },
        goal: { status: goalBefore != null && current == null ? 'cleared' : 'unchanged' }
      };
    }
  }

  async wait(
    actor: AgentNetworkActor,
    input: {
      readonly agentId?: string;
      readonly agentIds?: readonly string[];
      readonly mode?: 'any' | 'all';
      readonly waitFor?: 'message' | 'completion';
      readonly waitMs?: number;
      readonly signal?: AbortSignal;
      readonly interrupt?: ToolWaitInterrupt;
    },
    onResolved?: ResolvedTargets
  ): Promise<unknown> {
    validateAgentWaitOptions(input);
    if (
      (input.mode !== undefined && input.agentIds === undefined) ||
      (input.agentId !== undefined && input.agentIds !== undefined) ||
      (input.agentId !== undefined && (typeof input.agentId !== 'string' || !input.agentId)) ||
      (input.agentIds !== undefined &&
        (!Array.isArray(input.agentIds) ||
          input.agentIds.length === 0 ||
          input.agentIds.length > 8 ||
          input.agentIds.some((id) => typeof id !== 'string' || !id) ||
          new Set(input.agentIds).size !== input.agentIds.length))
    )
      throw new Error('AGENT_WAIT_INVALID');
    input.signal?.throwIfAborted();
    const ids = input.agentId === undefined ? input.agentIds : [input.agentId];
    let sessions: readonly NodeAgentSession[];
    if (ids) sessions = await Promise.all(ids.map((id) => this.options.target(actor, id)));
    else sessions = await this.options.children(actor);
    await Promise.all(sessions.map((session) => this.options.authorize(actor, session, 'wait')));
    input.signal?.throwIfAborted();
    let targets = sessions.flatMap((session) => {
      const target = this.options.freezeExecution(session);
      return target === undefined ? [] : [target];
    });
    if (ids && targets.length !== sessions.length) throw new Error('AGENT_EXECUTION_NOT_FOUND');
    if (!ids) {
      const active = targets.filter(
        (target) =>
          !['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(target.read().status)
      );
      if (active.length) {
        const creation = new Map(sessions.map((session) => [session.id, session.createdAt]));
        targets = active.sort(
          (a, b) => (creation.get(b.agentId) ?? 0) - (creation.get(a.agentId) ?? 0)
        );
      } else {
        const withExecution = new Set(targets.map((target) => target.agentId));
        const latest = [...sessions]
          .filter((session) => withExecution.has(session.id))
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        targets = targets.filter((target) => target.agentId === latest?.id);
      }
    }
    if (!targets.length) throw new Error('AGENT_EXECUTION_NOT_FOUND');
    const selected = new Set(targets.map((target) => target.agentId));
    await onResolved?.(
      targets.map((target) => sessions.find((session) => session.id === target.agentId)!)
    );
    const directChildren = new Set<string>();
    for (const session of sessions)
      if (selected.has(session.id) && session.parentSessionId === actor.sessionId) {
        this.options.observe(actor, session);
        directChildren.add(session.id);
      }
    const parent = this.options.observations.get(actor.observationId ?? actor.sessionId);
    if (directChildren.size && !parent) throw new Error('AGENT_OBSERVATION_UNAVAILABLE');
    const otherTargets = targets.filter((target) => !directChildren.has(target.agentId));
    const temporary =
      otherTargets.length && input.waitMs !== 0
        ? this.options.observations.watchExecutions(otherTargets)
        : undefined;
    try {
      return await waitForAgentTargets({
        targets,
        observations: {
          capture: (id, executionId) =>
            (directChildren.has(id) ? parent : temporary)?.capture(id, executionId),
          subscribe: (listener) => {
            const unsubscribeParent = directChildren.size ? parent?.subscribe(listener) : undefined;
            const unsubscribeTemporary = temporary?.subscribe(listener);
            return () => {
              unsubscribeParent?.();
              unsubscribeTemporary?.();
            };
          }
        },
        single: input.agentIds === undefined,
        waitMs: input.waitMs ?? 30_000,
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        ...(input.waitFor === undefined ? {} : { waitFor: input.waitFor }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.interrupt === undefined ? {} : { interrupt: input.interrupt })
      });
    } finally {
      temporary?.close();
    }
  }
}

function sameGoal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  return (
    isPlainRecord(left) &&
    isPlainRecord(right) &&
    typeof left.id === 'string' &&
    left.id === right.id &&
    typeof left.revision === 'number' &&
    left.revision === right.revision &&
    left.status === right.status
  );
}

function validOptionalString(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.trim().length > 0);
}
