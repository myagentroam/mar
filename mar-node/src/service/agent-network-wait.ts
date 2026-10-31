import { AgentError } from '@myagentroam/agent';
import { waitForToolCondition, type ToolWaitInterrupt } from '@myagentroam/agent/extensions';
import type { AgentObservationSnapshot, ParentObservations } from './agent-network-observations.js';

export interface AgentWaitTarget {
  readonly agentId: string;
  readonly runId: string;
  readonly executionId: string | undefined;
  /** Reads this fixed execution from its owner, never the Session's later current Run. */
  read(): { readonly status: string };
}

export function validateAgentWaitOptions(input: {
  readonly mode?: 'any' | 'all';
  readonly waitFor?: 'message' | 'completion';
  readonly waitMs?: number;
}): void {
  if (
    (input.mode !== undefined && input.mode !== 'any' && input.mode !== 'all') ||
    (input.waitFor !== undefined &&
      input.waitFor !== 'message' &&
      input.waitFor !== 'completion') ||
    (input.waitMs !== undefined &&
      (!Number.isInteger(input.waitMs) || input.waitMs < 0 || input.waitMs > 300_000))
  )
    throw new AgentError(
      'AGENT_WAIT_INVALID',
      'The agent wait mode, condition or duration is invalid.'
    );
}

/** One deadline and one notification subscription, with Session-scoped consumption. */
export async function waitForAgentTargets(input: {
  readonly targets: readonly AgentWaitTarget[];
  readonly observations: Pick<ParentObservations, 'capture' | 'subscribe'>;
  readonly waitFor?: 'message' | 'completion';
  readonly mode?: 'any' | 'all';
  readonly waitMs?: number;
  readonly signal?: AbortSignal;
  readonly interrupt?: ToolWaitInterrupt;
  /** Single and untargeted calls return and consume at most one target. */
  readonly single?: boolean;
}): Promise<unknown> {
  const { targets, observations } = input;
  validateAgentWaitOptions(input);
  if (
    !targets.length ||
    (!input.single && targets.length > 8) ||
    new Set(targets.map((target) => target.agentId)).size !== targets.length
  )
    throw new AgentError('AGENT_WAIT_INVALID', 'The agent wait target selection is invalid.');
  input.signal?.throwIfAborted();
  const waitMs = input.waitMs ?? 30_000;
  const snapshot = waitMs === 0;
  const terminalSnapshots = new Map<string, AgentObservationSnapshot>();
  const read = (target: AgentWaitTarget) => {
    const state = target.read();
    const executionId = target.executionId;
    const observation =
      executionId === undefined
        ? undefined
        : (observations.capture(target.agentId, executionId) ??
          terminalSnapshots.get(JSON.stringify([target.agentId, target.runId, executionId])));
    const terminal = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(state.status);
    const message = observation?.updates.some((update) => update.kind === 'message') === true;
    return {
      state,
      executionId,
      observation,
      terminal,
      ready: terminal || (input.waitFor === 'message' && message)
    };
  };
  const satisfied = () => {
    const values = targets.map(read);
    return input.mode === 'all'
      ? values.every((value) => value.ready)
      : values.some((value) => value.ready);
  };
  let outcome: 'snapshot' | 'ready' | 'timeout' | 'interrupted' = 'snapshot';
  if (!snapshot) {
    outcome = await waitForToolCondition({
      ready: satisfied,
      subscribe: (listener) =>
        observations.subscribe((terminal) => {
          if (
            terminal &&
            targets.some(
              (target) =>
                target.agentId === terminal.childId &&
                target.runId === terminal.runId &&
                target.executionId === terminal.executionId
            )
          )
            terminalSnapshots.set(
              JSON.stringify([terminal.childId, terminal.runId, terminal.executionId]),
              terminal
            );
          listener();
        }),
      waitMs,
      signal: input.signal,
      interrupt: input.interrupt
    });
    input.signal?.throwIfAborted();
  }
  const values = targets.map((target) => ({ target, ...read(target) }));
  const pendingAgentIds = values
    .filter((value) => !value.ready)
    .map((value) => value.target.agentId);
  const ordered = input.single
    ? [...values].sort(
        (a, b) =>
          (a.observation?.firstRevision ?? Infinity) - (b.observation?.firstRevision ?? Infinity)
      )
    : values;
  const selected = input.single
    ? [
        ordered.find((value) => value.ready) ??
          ordered.find((value) => (value.observation?.updates.length ?? 0) > 0) ??
          values[0]!
      ]
    : values;
  const agents = selected.map(({ target, executionId, state, observation, terminal, ready }) => {
    const waitOutcome = snapshot
      ? 'snapshot'
      : terminal
        ? 'completion'
        : ready
          ? 'message'
          : outcome === 'timeout'
            ? 'timeout'
            : outcome === 'interrupted'
              ? 'interrupted'
              : 'snapshot';
    const include = !snapshot && (ready || outcome === 'timeout' || outcome === 'interrupted');
    const projection = include && terminal ? observation?.result : undefined;
    const updates =
      include && projection?.summary && !projection.summaryTruncated
        ? observation?.updates.filter((update) => !update.final)
        : include
          ? observation?.updates
          : undefined;
    if (include) observation?.acknowledge();
    return {
      agentId: target.agentId,
      runId: target.runId,
      ...(executionId === undefined ? {} : { executionId }),
      status: state.status,
      waitOutcome,
      ...projection,
      ...(updates?.length ? { updates } : {})
    };
  });
  const ready = values.filter((value) => value.ready);
  const groupOutcome =
    outcome === 'ready'
      ? ready.every((value) => value.terminal)
        ? 'completion'
        : 'message'
      : outcome;
  if (input.single)
    return {
      ...agents[0],
      waitFor: input.waitFor ?? 'completion',
      ...(groupOutcome === 'interrupted' ? { waitOutcome: 'interrupted' as const } : {}),
      ...(groupOutcome === 'interrupted' ? { reason: 'steer' as const } : {})
    };
  return {
    mode: input.mode ?? 'any',
    waitFor: input.waitFor ?? 'completion',
    waitOutcome: snapshot ? 'snapshot' : groupOutcome,
    ...(groupOutcome === 'interrupted' ? { reason: 'steer' as const } : {}),
    agents,
    pendingAgentIds
  };
}
