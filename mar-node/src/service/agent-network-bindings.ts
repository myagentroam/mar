import {
  auditConversationReceiptSchema,
  marAgentRuntimeModelConfigurationSchema
} from '@myagentroam/protocol';
import { AgentError } from '@myagentroam/agent';
import type { RunnerRegistry } from '../runner/runner-registry.js';
import { resolvedPersonalInstructions } from '../runner/personal-instructions.js';
import type { NodeDatabase } from '../database.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import type { NodeAgentSession } from '../session/contracts.js';
import type { SessionLifecycleService } from '../session/session-lifecycle-service.js';
import type { SessionMessageService } from '../session/session-message-service.js';
import type { NativeSessionProjectionService } from '../session/native-session-projection-service.js';
import type { ExternalSessionResumeService } from './external-session-resume-service.js';
import type { GoalContinuationCoordinator } from './goal-continuation-coordinator.js';
import type { GoalRuntime } from './goal-runtime.js';
import type { RunWorkbenchService } from './run-workbench-service.js';
import type { AgentNetworkObservations, ParentObservations } from './agent-network-observations.js';
import { AgentNetworkService, type AgentNetworkActor } from './agent-network-service.js';
import { isPlainRecord } from '../util/records.js';
import { safeErrorCode } from '../util/safe-error.js';
import { SESSION_ADMISSION_SIGNAL } from '../session/operation-admission.js';
import { assertSessionControlOwner } from './run-ownership-policy.js';
const terminalCalls = new WeakMap<AgentNetworkActor, { readonly workspaceId: string }>();

/** Bind a terminal actor only after the Node request boundary has authenticated its caller. */
export function actorForAuthenticatedTerminal(
  actor: AgentNetworkActor,
  workspaceId: string
): AgentNetworkActor {
  const authenticated = Object.freeze({ ...actor });
  terminalCalls.set(authenticated, { workspaceId });
  return authenticated;
}

import { marctlSessionDetail } from './session-recent-activity.js';
import { listAgentNetworkSessions } from './agent-network-list.js';

interface Bindings {
  readonly runtime: NodeRuntimeState;
  readonly database: () => NodeDatabase | undefined;
  readonly runners: RunnerRegistry;
  readonly projection: NativeSessionProjectionService;
  readonly resume: ExternalSessionResumeService;
  readonly lifecycle: SessionLifecycleService;
  readonly messages: SessionMessageService;
  readonly coordinator: GoalContinuationCoordinator;
  readonly goals: GoalRuntime;
  readonly runs: RunWorkbenchService;
  readonly observations: AgentNetworkObservations;
  readonly ensureObservations: (actor: AgentNetworkActor) => ParentObservations;
  readonly withGrant: <T>(actor: AgentNetworkActor, work: () => T) => T;
}

/** Bind the collaboration use case to the existing Session, Run and Goal owners. */
export function createNodeAgentNetwork(options: Bindings): AgentNetworkService {
  async function actorSession(actor: AgentNetworkActor): Promise<NodeAgentSession> {
    if (!Number.isSafeInteger(actor.requestUserId) || (actor.requestUserId ?? 0) <= 0)
      throw new AgentError(
        'USER_AUTHORIZATION_REQUIRED',
        'An authenticated user is required for agent operations.'
      );
    const parent =
      options.runtime.getAgentSession(actor.sessionId) ??
      (await options.projection.resolve(actor.sessionId, true));
    if (!parent)
      throw new AgentError('SESSION_NOT_FOUND', 'The calling agent session was not found.');
    if (actor.runId !== undefined) {
      const run = options.runtime.getRun(actor.runId);
      if (
        !run ||
        run.sessionId !== parent.id ||
        options.runtime.activeSessionRun(parent.id)?.id !== run.id ||
        (actor.executionId !== undefined &&
          options.runtime.currentExecutionId(run.id) !== actor.executionId) ||
        run.initiatedByUserId !== actor.requestUserId
      )
        throw new AgentError(
          'AGENT_ACTOR_INVALID',
          'The calling agent execution identity is invalid.'
        );
    }
    return parent;
  }
  async function target(actor: AgentNetworkActor, id: string): Promise<NodeAgentSession> {
    const terminal = terminalCalls.get(actor);
    const parent = terminal ? undefined : await actorSession(actor);
    const workspaceId = terminal?.workspaceId ?? parent?.workspaceId;
    const session =
      options.runtime.getAgentSession(id) ?? (await options.projection.resolve(id, true));
    if (!session || session.workspaceId !== workspaceId)
      throw new AgentError(
        'SESSION_NOT_FOUND',
        'The target agent session was not found in this Workspace.'
      );
    return session;
  }
  function ancestorDistance(source: NodeAgentSession, targetId: string): number {
    const seen = new Set([source.id]);
    let parentId = source.parentSessionId;
    let distance = 1;
    while (parentId) {
      if (seen.has(parentId))
        throw Object.assign(new Error('Session ancestry contains a cycle.'), {
          code: 'SESSION_RELATION_INVALID'
        });
      seen.add(parentId);
      if (parentId === targetId) return distance;
      const parent = options.runtime.getAgentSession(parentId);
      if (parent?.id === targetId) return distance;
      parentId = parent
        ? parent.parentSessionId
        : options.database()?.getSessionRecord(parentId)?.metadata.parentSessionId;
      distance++;
    }
    return 0;
  }
  function origin(parent: NodeAgentSession, targetId?: string) {
    const distance = targetId === undefined ? 0 : ancestorDistance(parent, targetId);
    return {
      sessionId: parent.id,
      ...(distance === 0
        ? {}
        : { relation: distance === 1 ? ('child' as const) : ('descendant' as const) }),
      name: parent.customTitle?.trim() || parent.runnerTitle?.trim() || parent.id
    };
  }
  function childEnvironment(actor: AgentNetworkActor): Readonly<Record<string, string>> {
    // Retained only inside Node; dispatch exchanges its delegation before creating the child process.
    return actor.secretEnvironment ?? {};
  }
  function executionInput(
    actor: AgentNetworkActor,
    runner?: string,
    model?: string | null,
    requireSubagent = true
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {
      ...actor.runnerConfiguration,
      secretEnvironment: childEnvironment(actor),
      ...(actor.personalInstructions === undefined
        ? {}
        : { personalInstructions: resolvedPersonalInstructions(actor.personalInstructions) }),
      ...(actor.requestUserId === undefined ? {} : { __requestUserId: actor.requestUserId }),
      ...(actor.usageGrant === undefined ? {} : { __usageGrant: actor.usageGrant })
    };
    if (runner === 'mar-agent') {
      const candidates = [
        result.marAgentModel,
        ...(Array.isArray(result.marAgentModels) ? result.marAgentModels : [])
      ];
      const selected = candidates.flatMap((value) => {
        const parsed = marAgentRuntimeModelConfigurationSchema.safeParse(value);
        return parsed.success && parsed.data.id === model ? [parsed.data] : [];
      })[0];
      if (
        !selected ||
        !selected.enabled ||
        !selected.conversationModel ||
        (requireSubagent && !selected.subagentModel)
      )
        throw new Error('MAR_AGENT_SUBAGENT_MODEL_UNAVAILABLE');
      result.marAgentModel = selected;
    }
    return result;
  }
  async function validateApproval(
    actor: AgentNetworkActor,
    session: NodeAgentSession,
    input: { readonly approvalId: string }
  ): Promise<void> {
    if (!terminalCalls.has(actor)) await actorSession(actor);
    assertSessionControlOwner(options.runtime, session.id, actor.requestUserId);
    const approval = options.runtime.getApproval(input.approvalId);
    if (!approval) throw new Error('APPROVAL_NOT_FOUND');
    const runId = options.runtime.canonicalRunId(approval.runId);
    const run = options.runtime.getRun(runId);
    const active = options.runtime.activeSessionRun(session.id);
    if (
      !run ||
      run.sessionId !== session.id ||
      active?.id !== runId ||
      (approval.runId !== runId && approval.runId !== options.runtime.currentExecutionId(runId))
    )
      throw new Error('APPROVAL_NOT_FOUND');
    if (approval.status === 'EXPIRED') throw new Error('APPROVAL_EXPIRED');
    if (approval.status !== 'PENDING') throw new Error('APPROVAL_ALREADY_DECIDED');
  }
  return new AgentNetworkService({
    observations: options.observations,
    target,
    authorize: async (actor, session) => {
      if (!terminalCalls.has(actor)) await actorSession(actor);
      assertSessionControlOwner(options.runtime, session.id, actor.requestUserId);
    },
    children: async (actor) => {
      if (terminalCalls.has(actor))
        throw new AgentError(
          'AGENT_TARGET_REQUIRED',
          'A terminal caller must specify an agent to wait for.'
        );
      const parent = await actorSession(actor);
      const records =
        options.database()?.listChildSessionRecords(parent.workspaceId, parent.id) ?? [];
      const resolved = await Promise.all(
        records.map(
          (record) =>
            options.runtime.getAgentSession(record.id) ??
            options.projection.resolve(record.id, true)
        )
      );
      return resolved.filter((session): session is NodeAgentSession => session !== undefined);
    },
    validateSend: async (actor, session) => {
      if (terminalCalls.has(actor)) return;
      const source = await actorSession(actor);
      if (ancestorDistance(source, session.id) === 0) return;
      const run = options.runtime.activeSessionRun(session.id);
      if (!run || run.status === 'CANCELLING')
        throw Object.assign(new Error('Cannot send messages to an inactive ancestor session.'), {
          code: 'AGENT_ANCESTOR_NOT_ACTIVE'
        });
    },
    observe: (actor) => {
      options.ensureObservations(actor);
    },
    freezeExecution: (session) => {
      const snapshot = options.runtime.latestSessionExecution(session.id);
      const run = options.runtime.activeSessionRun(session.id);
      const runId = snapshot?.runId ?? run?.id;
      if (!runId) return undefined;
      let executionId = snapshot?.executionId;
      const currentId = () => {
        executionId ??= options.runtime.latestRunExecution(runId)?.executionId;
        return executionId;
      };
      return {
        agentId: session.id,
        runId,
        get executionId() {
          return currentId();
        },
        read: () => {
          const id = currentId();
          const state =
            id === undefined
              ? options.runtime.getRun(runId)
              : options.runtime.executionSnapshot(id);
          if (!state)
            throw new AgentError(
              'AGENT_EXECUTION_NOT_FOUND',
              'The execution selected for this wait is no longer available.',
              {
                details: {
                  agentId: session.id,
                  runId,
                  ...(id === undefined ? {} : { executionId: id })
                }
              }
            );
          return state;
        }
      };
    },
    start: async (actor, input, signal) => {
      const terminal = terminalCalls.get(actor);
      const parent = terminal
        ? input.parentSessionId === undefined
          ? undefined
          : await target(actor, input.parentSessionId)
        : await actorSession(actor);
      if (!terminal && input.parentSessionId !== undefined && input.parentSessionId !== parent?.id)
        throw new Error('AGENT_TARGET_NOT_AUTHORIZED');
      signal?.throwIfAborted();
      options.ensureObservations(actor);
      const runner = input.runner ?? parent?.runner;
      if (!runner) throw new Error('RUNNER_REQUIRED');
      const runnerAdapter = options.runners.product(runner);
      const database = options.database();
      const workspaceId = terminal?.workspaceId ?? parent?.workspaceId;
      const workspace = workspaceId === undefined ? undefined : database?.getWorkspace(workspaceId);
      if (!runnerAdapter || !database || !workspace) throw new Error('SESSION_INVALID');
      const model =
        input.modelId ??
        database.getRunnerDefaults().find((entry) => entry.runner === runner)?.modelId ??
        runnerAdapter.defaultConfiguration(
          workspace,
          actor.secretEnvironment ?? {},
          runnerAdapter.prepareExecutionContext(actor.runnerConfiguration ?? {})
        ).modelId;
      const request = {
        ...executionInput(actor, runner, model, parent !== undefined),
        workspaceId: workspace.id,
        ...(signal ? { [SESSION_ADMISSION_SIGNAL]: signal } : {}),
        ...(parent ? { parentSessionId: parent.id } : {}),
        runner,
        cwd: parent?.cwd ?? workspace.path,
        content: input.content,
        clientMessageId: input.clientMessageId,
        __suppressNotifications: true,
        ...(!terminal && parent ? { __marctlOrigin: origin(parent) } : {}),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(model ? { modelId: model } : {}),
        ...(input.effort === undefined ? {} : { effort: input.effort })
      };
      signal?.throwIfAborted();
      const result = await options.withGrant(actor, () =>
        input.goal.kind === 'set'
          ? options.lifecycle.startAgentWithGoal(request, (session, executionContext) =>
              options.coordinator.start({
                session,
                executionContext,
                objective: input.goal.kind === 'set' ? input.goal.objective : '',
                secretEnvironment: childEnvironment(actor),
                messageContent: input.content,
                suppressNotifications: true,
                ...(!terminal && parent ? { messageOrigin: origin(parent) } : {}),
                clientMessageId: input.clientMessageId,
                ...(actor.requestUserId === undefined
                  ? {}
                  : { initiatedByUserId: actor.requestUserId }),
                ...(actor.usageGrant === undefined ? {} : { usageGrant: actor.usageGrant }),
                ...(actor.personalInstructions === undefined
                  ? {}
                  : { personalInstructions: actor.personalInstructions })
              })
            )
          : options.lifecycle.operations()['session.start']!(request)
      );
      if (
        !isPlainRecord(result) ||
        !isPlainRecord(result.session) ||
        typeof result.session.id !== 'string'
      )
        throw new Error('SESSION_START_INVALID_RESULT');
      const session = await target(actor, result.session.id);
      return {
        session,
        result: { ...publicReceipt(result), clientMessageId: input.clientMessageId }
      };
    },
    setGoal: async (actor, session, change, message, signal) => {
      const parent = terminalCalls.has(actor) ? undefined : await actorSession(actor);
      signal?.throwIfAborted();
      if (change.kind === 'clear') return publicReceipt(options.coordinator.clear(session));
      const current = await options.resume.resolveForMessage(session.id);
      const executionContext = options.runners
        .require(current.runner)
        .prepareExecutionContext(
          executionInput(actor, current.runner, current.modelId, current.parentSessionId != null)
        );
      signal?.throwIfAborted();
      const result = await options.withGrant(actor, () =>
        options.coordinator.start({
          session: current,
          objective: change.objective,
          executionContext,
          suppressNotifications: true,
          secretEnvironment: childEnvironment(actor),
          ...(actor.requestUserId === undefined ? {} : { initiatedByUserId: actor.requestUserId }),
          ...(actor.personalInstructions === undefined
            ? {}
            : { personalInstructions: actor.personalInstructions }),
          ...(actor.usageGrant === undefined ? {} : { usageGrant: actor.usageGrant }),
          preserveActiveRun: true,
          ...(parent ? { messageOrigin: origin(parent, session.id) } : {}),
          ...(message === undefined
            ? {}
            : {
                messageContent: message.content,
                clientMessageId: message.clientMessageId,
                messageIntent: message.deliveryIntent
              })
        })
      );
      return publicReceipt(result);
    },
    message: async (actor, session, input, signal) => {
      const parent = terminalCalls.has(actor) ? undefined : await actorSession(actor);
      signal?.throwIfAborted();
      const result = await options.withGrant(actor, () =>
        options.messages.operations()['session.message']!({
          ...executionInput(
            actor,
            session.runner,
            session.modelId,
            session.parentSessionId != null
          ),
          ...input,
          ...(signal ? { [SESSION_ADMISSION_SIGNAL]: signal } : {}),
          sessionId: session.id,
          __suppressNotifications: true,
          ...(parent ? { __marctlOrigin: origin(parent, session.id) } : {})
        })
      );
      return publicReceipt(result);
    },
    validateApproval,
    approval: async (actor, session, input, signal) => {
      await validateApproval(actor, session, input);
      signal?.throwIfAborted();
      const approval = options.runtime.getApproval(input.approvalId)!;
      const runId = options.runtime.canonicalRunId(approval.runId);
      const decision = input.decision === 'approve' ? 'APPROVED' : 'REJECTED';
      try {
        options.runs.operations()['run.approval.decide']!({
          runId,
          approvalId: input.approvalId,
          decision,
          __requestUserId: actor.requestUserId
        });
        return {
          status: 'applied' as const,
          result: { approvalId: input.approvalId, decision: input.decision }
        };
      } catch (error) {
        if (
          approval.status === 'PENDING' &&
          options.runtime.getApproval(input.approvalId)?.status === decision
        )
          return {
            status: 'partial' as const,
            code: safeErrorCode(error, 'APPROVAL_DECISION_FAILED'),
            result: { approvalId: input.approvalId, decision: input.decision }
          };
        throw error;
      }
    },
    stop: (actor, session, executionId) =>
      publicReceipt(
        options.runs.stopAgentExecution({
          sessionId: session.id,
          executionId,
          ...(actor.requestUserId === undefined ? {} : { requestUserId: actor.requestUserId })
        })
      ),
    goal: (sessionId) => publicGoal(options.goals.get(sessionId)),
    list: async (actor, input) => {
      const terminal = terminalCalls.get(actor);
      const source = terminal ? undefined : await actorSession(actor);
      const workspaceId = terminal?.workspaceId ?? source?.workspaceId;
      if (!workspaceId) throw new Error('SESSION_INVALID');
      return listAgentNetworkSessions(source, input, {
        workspaceId,
        runtime: options.runtime,
        database: options.database(),
        projection: options.projection
      });
    },
    view: async (actor, input, onResolved) => {
      const source = terminalCalls.has(actor) ? undefined : await actorSession(actor);
      const session = input.agentId === source?.id ? source : await target(actor, input.agentId);
      assertSessionControlOwner(options.runtime, session.id, actor.requestUserId);
      await onResolved?.([session]);
      return {
        session: marctlSessionDetail(
          options.runtime,
          session,
          options.runtime.sessionQueue(session.id).itemIds.length
        ),
        goal: publicGoal(options.goals.get(session.id)) ?? null
      };
    }
  });
}

function publicGoal(goal: ReturnType<GoalRuntime['get']>) {
  return goal === undefined
    ? undefined
    : {
        id: goal.id,
        objective: goal.objective,
        status: goal.status,
        revision: goal.revision,
        startedAt: goal.startedAt,
        turns: goal.turns
      };
}

/** Project receipts without leaking Session internals or execution credentials. */
function publicReceipt(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) return {};
  const result: Record<string, unknown> = {};
  const audit = auditConversationReceiptSchema.safeParse(value.auditReceipt);
  if (audit.success) result.auditReceipt = audit.data;
  for (const key of ['delivery', 'queueItemId', 'idempotent', 'cleared', 'goalAccessChanged'])
    if (typeof value[key] === 'string' || typeof value[key] === 'boolean') result[key] = value[key];
  if (isPlainRecord(value.run) && typeof value.run.id === 'string')
    result.run = { id: value.run.id, status: value.run.status };
  if (isPlainRecord(value.turn) && typeof value.turn.id === 'string')
    result.turn = { id: value.turn.id, status: value.turn.status };
  if (isPlainRecord(value.goal)) {
    const goal = value.goal;
    result.goal = {
      id: goal.id,
      objective: goal.objective,
      status: goal.status,
      revision: goal.revision
    };
  }
  if (isPlainRecord(value.goalExit)) result.goalExit = value.goalExit;
  return result;
}
