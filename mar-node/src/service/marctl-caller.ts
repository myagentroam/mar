import type { NodeRuntimeState } from '../runtime-state.js';
import { isPlainRecord } from '../util/records.js';
import type { ContinuousRunCoordinator } from './continuous-run-coordinator.js';
import type { NodeAgentSession } from '../session/contracts.js';
import { assertSessionControlOwner } from './run-ownership-policy.js';

const executionReadOperations = new Set([
  'agent.network',
  'session.cli.context',
  'session.get',
  'session.list',
  'session.graph',
  'session.runs',
  'session.goal.get',
  'session.turns.list',
  'workspace.queue.get',
  'session.schedule.list',
  'session.schedule.get',
  'runner.profiles.list',
  'session.watch',
  'session.unwatch'
]);
const executionManagementOperations = new Set([
  'session.metadata.update',
  'session.config.update',
  'session.schedule.agent.save'
]);

/** Keep execution management within its authenticated Workspace and Run ownership. */
export async function authorizeMarctlExecutionOperation(input: {
  readonly caller: unknown;
  readonly operation: string;
  readonly data: unknown;
  readonly userId: number;
  readonly runtime: NodeRuntimeState;
  readonly resolveSession: (sessionId: string) => Promise<NodeAgentSession | undefined>;
}): Promise<void> {
  if (!isPlainRecord(input.caller)) throw new Error('MARCTL_EXECUTION_CREDENTIAL_INVALID');
  if (input.caller.type === 'terminal') return;
  if (input.caller.type !== 'execution' || typeof input.caller.sessionId !== 'string')
    throw new Error('MARCTL_EXECUTION_CREDENTIAL_INVALID');
  if (executionReadOperations.has(input.operation)) return;
  if (!isPlainRecord(input.data) || typeof input.data.workspaceId !== 'string')
    throw new Error('MARCTL_AGENT_NETWORK_REQUIRED');
  let sessionId: string;
  if (input.operation === 'run.approval.decide') {
    const run =
      typeof input.data.runId === 'string' ? input.runtime.getRun(input.data.runId) : undefined;
    if (!run) throw new Error('RUN_NOT_FOUND');
    sessionId = run.sessionId;
  } else {
    if (
      !executionManagementOperations.has(input.operation) ||
      typeof input.data.sessionId !== 'string'
    )
      throw new Error('MARCTL_AGENT_NETWORK_REQUIRED');
    sessionId = input.data.sessionId;
  }
  const source = input.runtime.getAgentSession(input.caller.sessionId);
  const target =
    input.runtime.getAgentSession(sessionId) ?? (await input.resolveSession(sessionId));
  if (
    !source ||
    !target ||
    source.workspaceId !== input.data.workspaceId ||
    target.workspaceId !== source.workspaceId
  )
    throw new Error('AGENT_TARGET_NOT_AUTHORIZED');
  assertSessionControlOwner(input.runtime, target.id, input.userId);
}

/** Resolve only Server-verified credentials against the current Node Execution owner. */
export function resolveMarctlCaller(input: {
  readonly caller: unknown;
  readonly userId: number;
  readonly data: unknown;
  readonly runtime: NodeRuntimeState;
  readonly coordinator: ContinuousRunCoordinator<unknown>;
}):
  | { readonly type: 'terminal' }
  | {
      readonly type: 'execution';
      readonly sessionId: string;
      readonly executionId: string;
    }
  | undefined {
  if (!isPlainRecord(input.caller)) return undefined;
  if (input.caller.type === 'terminal') return { type: 'terminal' };
  if (
    input.caller.type !== 'execution' ||
    typeof input.caller.sessionId !== 'string' ||
    typeof input.caller.executionId !== 'string' ||
    !isPlainRecord(input.data) ||
    typeof input.data.workspaceId !== 'string'
  )
    return undefined;
  const session = input.runtime.getAgentSession(input.caller.sessionId);
  const execution = input.runtime.executionSnapshot(input.caller.executionId);
  const prepared = input.coordinator.pending(input.caller.executionId);
  const run = execution && input.runtime.getRun(execution.runId);
  if (
    !session ||
    !execution ||
    !prepared ||
    !run ||
    session.workspaceId !== input.data.workspaceId ||
    execution.sessionId !== session.id ||
    prepared.sessionId !== session.id ||
    prepared.workspaceId !== session.workspaceId ||
    run.initiatedByUserId !== input.userId ||
    !['STARTING', 'RUNNING'].includes(execution.status) ||
    input.runtime.activeSessionRun(session.id)?.id !== run.id ||
    input.runtime.currentExecutionId(run.id) !== execution.executionId
  )
    return undefined;
  return { type: 'execution', sessionId: session.id, executionId: execution.executionId };
}
