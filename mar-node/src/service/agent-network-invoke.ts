import type { ExtensionOperationContext } from '@myagentroam/agent/extensions';
import type { NodeRuntimeState } from '../runtime-state.js';
import type { ContinuousRunCoordinator } from './continuous-run-coordinator.js';
import type {
  AgentNetworkAction,
  AgentNetworkActor,
  AgentNetworkInvoke,
  AgentNetworkService,
  ResolvedTargets
} from './agent-network-service.js';
import { actorForAuthenticatedTerminal } from './agent-network-bindings.js';
import type { AgentNetworkObservations } from './agent-network-observations.js';
import { isPlainRecord } from '../util/records.js';
import { randomUUID } from 'node:crypto';
import { modelUsageGrantSchema } from '@myagentroam/protocol';

/** Bind each native invocation to the actual live Node Execution and its captured resources. */
export function agentNetworkInvoke(input: {
  readonly sessionId: string;
  readonly runtime: NodeRuntimeState;
  readonly coordinator: ContinuousRunCoordinator<unknown>;
  readonly service: AgentNetworkService;
}): AgentNetworkInvoke {
  return async (executionId, action, payload, context, onResolved) => {
    const actor = executionAgentActor({ ...input, executionId });
    return invokeAgentNetwork(
      input.service,
      actor,
      action,
      payload,
      context,
      undefined,
      onResolved
    );
  };
}

/** Read actor resources from the current Node-owned Execution, not caller arguments. */
export function executionAgentActor(input: {
  readonly sessionId: string;
  readonly executionId: string;
  readonly runtime: NodeRuntimeState;
  readonly coordinator: ContinuousRunCoordinator<unknown>;
}): AgentNetworkActor {
  const { executionId } = input;
  // Warm runtimes and execution credentials may retain the bootstrap Session ID.
  const sessionId = input.runtime.getAgentSessionById(input.sessionId)?.id;
  const execution = input.runtime.executionSnapshot(executionId);
  const prepared = input.coordinator.pending(executionId);
  const run = execution && input.runtime.getRun(execution.runId);
  if (
    !sessionId ||
    !execution ||
    !prepared ||
    !run ||
    execution.sessionId !== sessionId ||
    prepared.sessionId !== sessionId ||
    input.runtime.activeSessionRun(sessionId)?.id !== run.id ||
    input.runtime.currentExecutionId(run.id) !== executionId ||
    !['STARTING', 'RUNNING'].includes(execution.status) ||
    !Number.isSafeInteger(run.initiatedByUserId)
  )
    throw new Error('AGENT_ACTOR_NOT_ACTIVE');
  const captured =
    prepared.executionContext.runner === 'mar-agent' &&
    isPlainRecord(prepared.executionContext.runnerInput)
      ? prepared.executionContext.runnerInput
      : {};
  return {
    sessionId,
    runId: run.id,
    executionId,
    ...(run.initiatedByUserId === undefined ? {} : { requestUserId: run.initiatedByUserId }),
    secretEnvironment: prepared.secretEnvironment,
    ...(prepared.usageGrant === undefined ? {} : { usageGrant: prepared.usageGrant }),
    ...(prepared.personalInstructions === undefined
      ? {}
      : { personalInstructions: prepared.personalInstructions }),
    runnerConfiguration: {
      marAgentModel: captured.model,
      marAgentModels: captured.models,
      marAgentCompact: captured.compact,
      marAgentRuntimeScopeId: captured.runtimeScopeId
    }
  };
}

/** Shared command dispatch; callers must bind actor authority at their trusted boundary. */
export async function invokeAgentNetwork(
  service: AgentNetworkService,
  actor: AgentNetworkActor,
  action: AgentNetworkAction,
  payload: Record<string, unknown>,
  context?: ExtensionOperationContext,
  requestSignal?: AbortSignal,
  onResolved?: ResolvedTargets
): Promise<unknown> {
  const signal = context?.signal ?? requestSignal;
  switch (action) {
    case 'start':
      if (
        (context || actor.executionId) &&
        (typeof payload.title !== 'string' || !payload.title.trim())
      )
        throw new Error('AGENT_START_INVALID');
      if (
        !context &&
        !actor.executionId &&
        typeof payload.title === 'string' &&
        !payload.title.trim()
      ) {
        const { title: _title, ...withoutTitle } = payload;
        return service.start(
          actor,
          withoutTitle as Parameters<AgentNetworkService['start']>[1],
          signal,
          onResolved
        );
      }
      return service.start(
        actor,
        {
          ...payload,
          ...(typeof payload.title === 'string' ? { title: payload.title.trim() } : {})
        } as Parameters<AgentNetworkService['start']>[1],
        signal,
        onResolved
      );
    case 'send':
      return service.send(
        actor,
        payload as Parameters<AgentNetworkService['send']>[1],
        signal,
        onResolved
      );
    case 'stop':
      return service.stop(actor, payload as Parameters<AgentNetworkService['stop']>[1], onResolved);
    case 'wait':
      return service.wait(
        actor,
        {
          ...payload,
          ...(context
            ? { signal: context.signal, interrupt: context.waitInterrupt }
            : requestSignal
              ? { signal: requestSignal }
              : {})
        } as Parameters<AgentNetworkService['wait']>[1],
        onResolved
      );
    case 'list':
      return service.list(actor, payload);
    case 'view':
      return service.view(actor, payload as Parameters<AgentNetworkService['view']>[1], onResolved);
  }
}

/** Node broker injects the caller only after validating the Server-issued Execution credential. */
export function agentNetworkExecutionCommand(input: {
  readonly runtime: NodeRuntimeState;
  readonly coordinator: ContinuousRunCoordinator<unknown>;
  readonly service: AgentNetworkService;
  readonly observations?: AgentNetworkObservations;
}): (data: unknown) => Promise<unknown> {
  return async (data) => {
    if (
      !isPlainRecord(data) ||
      !isPlainRecord(data.__marctlCaller) ||
      typeof data.__requestUserId !== 'number' ||
      typeof data.workspaceId !== 'string' ||
      !['start', 'send', 'wait', 'stop', 'list', 'view'].includes(String(data.action)) ||
      !isPlainRecord(data.input)
    )
      throw new Error('MARCTL_EXECUTION_CREDENTIAL_INVALID');
    if (data.__marctlCaller.type === 'terminal') {
      if (
        !input.observations ||
        !Number.isSafeInteger(data.__requestUserId) ||
        data.__requestUserId <= 0
      )
        throw new Error('MARCTL_EXECUTION_CREDENTIAL_INVALID');
      const observationId = `terminal:${randomUUID()}`;
      const observer = input.observations.attach(observationId);
      const environment =
        isPlainRecord(data.secretEnvironment) &&
        Object.values(data.secretEnvironment).every((value) => typeof value === 'string')
          ? (data.secretEnvironment as Record<string, string>)
          : {};
      const usageGrant = modelUsageGrantSchema.safeParse(data.__usageGrant);
      const actor = actorForAuthenticatedTerminal(
        {
          sessionId: '',
          observationId,
          requestUserId: data.__requestUserId,
          secretEnvironment: environment,
          runnerConfiguration: {
            marAgentModel: data.marAgentModel,
            marAgentModels: data.marAgentModels,
            marAgentCompact: data.marAgentCompact,
            marAgentRuntimeScopeId: data.marAgentRuntimeScopeId
          },
          ...(usageGrant.success ? { usageGrant: usageGrant.data } : {}),
          ...(typeof data.personalInstructions === 'string'
            ? { personalInstructions: data.personalInstructions }
            : {})
        },
        data.workspaceId
      );
      try {
        return await invokeAgentNetwork(
          input.service,
          actor,
          data.action as AgentNetworkAction,
          data.input,
          undefined,
          data.__requestAbortSignal instanceof AbortSignal ? data.__requestAbortSignal : undefined
        );
      } finally {
        observer.close();
      }
    }
    if (
      data.__marctlCaller.type !== 'execution' ||
      typeof data.__marctlCaller.sessionId !== 'string' ||
      typeof data.__marctlCaller.executionId !== 'string'
    )
      throw new Error('MARCTL_EXECUTION_CREDENTIAL_INVALID');
    const actor = executionAgentActor({
      ...input,
      sessionId: data.__marctlCaller.sessionId,
      executionId: data.__marctlCaller.executionId
    });
    const session = input.runtime.getAgentSession(actor.sessionId);
    if (actor.requestUserId !== data.__requestUserId || session?.workspaceId !== data.workspaceId)
      throw new Error('MARCTL_EXECUTION_CREDENTIAL_INVALID');
    const profileQuery =
      data.action === 'list' && data.input.scope === 'profile' && data.input.runner === 'mar-agent';
    const resources =
      (['start', 'send'].includes(String(data.action)) || profileQuery) &&
      isPlainRecord(data.__marctlExecutionResources)
        ? data.__marctlExecutionResources
        : undefined;
    const boundActor =
      resources === undefined
        ? actor
        : {
            ...actor,
            runnerConfiguration: {
              ...actor.runnerConfiguration,
              marAgentModel: resources.marAgentModel,
              marAgentModels: resources.marAgentModels,
              marAgentCompact: resources.marAgentCompact,
              marAgentRuntimeScopeId: resources.marAgentRuntimeScopeId
            }
          };
    return invokeAgentNetwork(
      input.service,
      boundActor,
      data.action as AgentNetworkAction,
      data.input,
      undefined,
      data.__requestAbortSignal instanceof AbortSignal ? data.__requestAbortSignal : undefined
    );
  };
}
