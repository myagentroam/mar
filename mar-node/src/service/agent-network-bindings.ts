import {
  auditConversationReceiptSchema,
  marAgentRuntimeModelConfigurationSchema
} from '@myagentroam/protocol';
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

import { sessionPage } from '../session/pagination.js';
import { marctlSessionSummary, marctlSessionDetail } from './session-recent-activity.js';
import type { RunnerProfile } from '@myagentroam/protocol';

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
  readonly listSessions: (input: Record<string, unknown>) => Promise<unknown>;
  readonly history: (input: Record<string, unknown>) => Promise<unknown>;
  readonly profiles: (
    environment: Readonly<Record<string, string>>,
    models: unknown
  ) => Promise<readonly RunnerProfile[]>;
}

/** Bind the collaboration use case to the existing Session, Run and Goal owners. */
export function createNodeAgentNetwork(options: Bindings): AgentNetworkService {
  async function actorSession(actor: AgentNetworkActor): Promise<NodeAgentSession> {
    if (!Number.isSafeInteger(actor.requestUserId) || (actor.requestUserId ?? 0) <= 0)
      throw new Error('USER_AUTHORIZATION_REQUIRED');
    const parent =
      options.runtime.getAgentSession(actor.sessionId) ??
      (await options.projection.resolve(actor.sessionId, true));
    if (!parent) throw new Error('SESSION_NOT_FOUND');
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
        throw new Error('AGENT_ACTOR_INVALID');
    }
    return parent;
  }
  async function target(actor: AgentNetworkActor, id: string): Promise<NodeAgentSession> {
    const terminal = terminalCalls.get(actor);
    const parent = terminal ? undefined : await actorSession(actor);
    const workspaceId = terminal?.workspaceId ?? parent?.workspaceId;
    const session =
      options.runtime.getAgentSession(id) ?? (await options.projection.resolve(id, true));
    if (!session || session.workspaceId !== workspaceId) throw new Error('SESSION_NOT_FOUND');
    return session;
  }
  function origin(parent: NodeAgentSession) {
    return {
      sessionId: parent.id,
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
      if (terminalCalls.has(actor)) throw new Error('AGENT_TARGET_REQUIRED');
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
          return id === undefined
            ? (options.runtime.getRun(runId) ?? { status: 'UNKNOWN' })
            : (options.runtime.executionSnapshot(id) ?? { status: 'UNKNOWN' });
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
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
        ...(input.attachmentIds === undefined ? {} : { attachmentIds: input.attachmentIds })
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
                ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
                ...(input.attachmentIds === undefined
                  ? {}
                  : { attachmentIds: input.attachmentIds }),
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
          ...(parent ? { messageOrigin: origin(parent) } : {}),
          ...(message === undefined
            ? {}
            : {
                messageContent: message.content,
                clientMessageId: message.clientMessageId,
                messageIntent: message.deliveryIntent,
                ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
                ...(message.attachmentIds === undefined
                  ? {}
                  : { attachmentIds: message.attachmentIds })
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
          ...(parent ? { __marctlOrigin: origin(parent) } : {})
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
      const current = source ? marctlSessionSummary(options.runtime, source) : null;
      const scope = input.scope ?? (terminal ? 'workspace' : 'children');
      if (scope === 'profile') {
        const runner = input.runner ?? source?.runner;
        if (!runner) throw new Error('RUNNER_REQUIRED');
        const profiles = await options.profiles(
          actor.secretEnvironment ?? {},
          actor.runnerConfiguration?.marAgentModels
        );
        const profile = profiles.find((item) => item.runner === runner);
        if (!profile) throw new Error('RUNNER_PROFILE_NOT_FOUND');
        const models =
          profile.runner !== 'mar-agent'
            ? profile.models
            : profile.models.filter((model) => {
                const configurations = [
                  actor.runnerConfiguration?.marAgentModel,
                  ...(Array.isArray(actor.runnerConfiguration?.marAgentModels)
                    ? actor.runnerConfiguration.marAgentModels
                    : [])
                ];
                return configurations.some(
                  (value) =>
                    isPlainRecord(value) &&
                    value.id === model.id &&
                    value.enabled === true &&
                    value.conversationModel === true &&
                    value.subagentModel === true
                );
              });
        return { current, runner: profile.runner, models, capabilities: profile.capabilities };
      }
      if (scope === 'workspace') {
        const result = await options.listSessions({
          workspaceId,
          view: 'marctl',
          registeredOnly: true,
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.parent === undefined ? {} : { parentSessionId: input.parent }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor })
        });
        if (!isPlainRecord(result)) throw new Error('SESSION_LIST_INVALID_RESULT');
        return { ...result, current };
      }
      if (scope !== 'children' && scope !== 'descendants') throw new Error('AGENT_LIST_INVALID');
      const root =
        input.agentId === undefined || input.agentId === source?.id
          ? source
          : await target(actor, input.agentId);
      if (!root) throw new Error('AGENT_TARGET_REQUIRED');
      const database = options.database();
      if (!database) throw new Error('DATABASE_UNAVAILABLE');
      const records =
        scope === 'children'
          ? database.listChildSessionRecords(root.workspaceId, root.id)
          : database.sessionTreeRecords(root.workspaceId, root.id).slice(1);
      const sessions = (
        await Promise.all(
          records.map(
            (record) =>
              options.runtime.getAgentSession(record.id) ??
              options.projection.resolve(record.id, true)
          )
        )
      )
        .filter((session): session is NodeAgentSession => session !== undefined)
        .filter(
          (session) =>
            !input.query ||
            (session.customTitle ?? session.runnerTitle ?? '')
              .normalize('NFKC')
              .toLocaleLowerCase()
              .includes(input.query.normalize('NFKC').toLocaleLowerCase())
        );
      const page = sessionPage(sessions, { limit: input.limit, cursor: input.cursor });
      return {
        current,
        sessions: page.sessions.map((session) => marctlSessionSummary(options.runtime, session)),
        nextCursor: page.nextCursor,
        truncated: page.nextCursor !== null
      };
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
        goal: publicGoal(options.goals.get(session.id)) ?? null,
        ...(input.includeHistory
          ? {
              history: await options.history({
                sessionId: session.id,
                workspaceId: session.workspaceId,
                registeredOnly: true,
                limit: input.limit,
                cursor: input.cursor
              })
            }
          : {})
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
