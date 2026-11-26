import type { NodeRuntimeState } from '../../runtime-state.js';
import type { NodeAgentRun } from '../../runtime-model.js';
import type { RunnerExecutionStatus } from '../../runner/contracts.js';
import type { AgentNetworkActor } from './agent-network-service.js';
import {
  AgentNetworkObservations,
  agentObservationFromRunEvent,
  type ParentObservations
} from './agent-network-observations.js';
import { sessionPendingApprovals } from '../../service/session-recent-activity.js';

/** Projects normalized Execution observations and owns transient observers through Run settlement.
 * Run-keyed handles survive Session identity promotion without borrowing a replacement's lifetime.
 * Runner-owned context observers remain with the Runner; this owner only borrows their delivery port.
 */
export class AgentNetworkRunProjection {
  private readonly transient = new Map<string, ParentObservations>();

  constructor(
    private readonly runtime: NodeRuntimeState,
    private readonly observations: AgentNetworkObservations
  ) {}

  readonly ensureObservations = (actor: AgentNetworkActor) => {
    const existing = this.observations.get(actor.observationId ?? actor.sessionId);
    if (existing) return existing;
    const run = actor.runId === undefined ? undefined : this.runtime.getRun(actor.runId);
    if (
      !run ||
      run.sessionId !== actor.sessionId ||
      this.runtime.activeSessionRun(actor.sessionId)?.id !== run.id
    )
      throw new Error('AGENT_ACTOR_NOT_ACTIVE');
    const observer = this.observations.attach(actor.sessionId);
    this.transient.set(run.id, observer);
    return observer;
  };

  readonly accept = ({
    run,
    executionId,
    eventType,
    payload,
    terminalStatus,
    runTerminal
  }: {
    readonly run: NodeAgentRun;
    readonly executionId: string;
    readonly eventType: string;
    readonly payload: unknown;
    readonly terminalStatus?: RunnerExecutionStatus;
    readonly runTerminal?: true;
  }): void => {
    const child = this.runtime.getAgentSession(run.sessionId);
    if (!child) return;
    const parent =
      child.parentSessionId == null
        ? undefined
        : this.runtime.getAgentSession(child.parentSessionId);
    let observation = agentObservationFromRunEvent({ eventType, payload, terminalStatus });
    if (eventType === 'approval.request') {
      const approvals = sessionPendingApprovals(this.runtime, child.id).pendingApprovals;
      if (approvals.length)
        observation = { kind: 'message', value: JSON.stringify({ pendingApprovals: approvals }) };
    }
    if (observation)
      this.observations.publishChild({
        ...(parent?.workspaceId === child.workspaceId ? { parentId: parent.id } : {}),
        childId: child.id,
        runId: run.id,
        executionId,
        ...observation
      });
    if (runTerminal) {
      const observer = this.transient.get(run.id);
      this.transient.delete(run.id);
      observer?.close();
    }
  };

  dispose(): void {
    for (const observer of this.transient.values()) observer.close();
    this.transient.clear();
  }
}
