import { AgentError } from '@myagentroam/agent';
import type { NodeRuntimeState } from '../runtime-state.js';
import type { ContinuousRunCoordinator } from '../service/continuous-run-coordinator.js';

/** Resolve trusted execution identity. Callers project only the resources their operation needs. */
export function requireOrchestrationExecution(input: {
  readonly sessionId: string;
  readonly executionId: string;
  readonly runtime: NodeRuntimeState;
  readonly coordinator: ContinuousRunCoordinator<unknown>;
}) {
  const { executionId, runtime } = input;
  // A warm runner can retain its Session's bootstrap alias.
  const sessionId = runtime.getAgentSessionById(input.sessionId)?.id;
  const execution = runtime.executionSnapshot(executionId);
  const prepared = input.coordinator.pending(executionId);
  const run = execution && runtime.getRun(execution.runId);
  if (
    !sessionId ||
    !execution ||
    !prepared ||
    !run ||
    execution.sessionId !== sessionId ||
    prepared.sessionId !== sessionId ||
    runtime.activeSessionRun(sessionId)?.id !== run.id ||
    runtime.currentExecutionId(run.id) !== executionId ||
    execution.status !== 'RUNNING' ||
    !Number.isSafeInteger(run.initiatedByUserId)
  )
    throw new AgentError(
      'AGENT_ACTOR_NOT_ACTIVE',
      'The calling agent execution is no longer active.'
    );
  return { sessionId, run, prepared };
}
