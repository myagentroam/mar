import { NODE_MCP } from '../mcp/naming.js';
import { randomUUID } from 'node:crypto';
import { parseComposerTags, serializeComposerTag } from '@myagentroam/protocol';

export type GoalStatus = 'active' | 'completed' | 'blocked';

export interface GoalState {
  readonly id: string;
  readonly sessionId: string;
  readonly objective: string;
  readonly inputTags?: string;
  readonly startedAt: number;
  readonly revisionStartedAt: number;
  readonly revision: number;
  readonly status: GoalStatus;
  readonly turns: number;
  readonly retryRequired: boolean;
  readonly retryStartedAtTurn: number | null;
  readonly consecutiveNoProgressTurns: number;
}

export interface GoalExitSummary {
  readonly status: 'removed' | 'stopped';
  readonly elapsedWallMs: number;
  readonly turns: number;
}

export type GoalExecutionDisposition = 'continue' | 'blocked' | 'completed';

export function goalUnrestrictedAccess(
  runner: 'codex' | 'claude-code' | 'opencode' | 'mar-agent',
  currentAccess?: string | null
): string {
  if (runner === 'mar-agent') return currentAccess ?? 'full-access';
  if (runner === 'codex') return 'full-access';
  if (runner === 'claude-code') return 'bypass';
  return 'auto';
}

export function publicGoalStartText(objective: string): string {
  return serializeComposerTag('mar_goal_start', { objective: objective.trim() });
}

export function stripGoalStartPrompt(text: string): string {
  const first = parseComposerTags(text)[0];
  return first?.kind === 'mar_goal_start' || first?.kind === 'mar_goal_continue'
    ? text.slice(first.raw.length).trimStart()
    : text;
}

export function publicGoalHistoryText(text: string): string {
  const first = parseComposerTags(text)[0];
  if (first?.kind === 'mar_restart') return serializeComposerTag('mar_restart', {});
  if (first?.kind !== 'mar_goal_start' && first?.kind !== 'mar_goal_continue') return text;
  const marker =
    first.kind === 'mar_goal_start'
      ? serializeComposerTag('mar_goal_start', { objective: first.payload.objective })
      : serializeComposerTag('mar_goal_continue', {});
  return [marker, stripGoalStartPrompt(text)].filter(Boolean).join('\n');
}

export class GoalRuntime {
  private readonly goals = new Map<string, GoalState>();
  private readonly executionFailures = new Map<string, number>();

  constructor(
    private readonly changed: (goal: GoalState | undefined) => void,
    private readonly now: () => number = Date.now
  ) {}

  get(sessionId: string): GoalState | undefined {
    return this.goals.get(sessionId);
  }

  restartState(sessionId: string): { goal: GoalState; executionFailures: number } | undefined {
    const goal = this.goals.get(sessionId);
    return goal === undefined
      ? undefined
      : { goal: { ...goal }, executionFailures: this.executionFailures.get(sessionId) ?? 0 };
  }

  restoreRestartState(state: { goal: GoalState; executionFailures: number }): void {
    this.goals.set(state.goal.sessionId, { ...state.goal });
    this.executionFailures.set(state.goal.sessionId, state.executionFailures);
    this.changed(state.goal);
  }

  migrateSession(previousId: string, nextId: string): void {
    if (previousId === nextId) return;
    const goal = this.goals.get(previousId);
    if (goal !== undefined) {
      this.goals.delete(previousId);
      this.goals.set(nextId, { ...goal, sessionId: nextId });
    }
    const failures = this.executionFailures.get(previousId);
    if (failures !== undefined) {
      this.executionFailures.delete(previousId);
      this.executionFailures.set(nextId, failures);
    }
  }

  start(sessionId: string, objective: string, inputTags?: string): GoalState {
    const normalized = objective.trim();
    if (normalized.length === 0 || normalized.length > 20_000)
      throw new Error('GOAL_OBJECTIVE_INVALID');
    const current = this.goals.get(sessionId);
    const continuing = current?.status === 'active';
    const selectedInputTags = inputTags ?? (continuing ? current?.inputTags : undefined);
    const now = this.now();
    const goal: GoalState = {
      id: continuing ? current.id : randomUUID(),
      sessionId,
      objective: normalized,
      ...(selectedInputTags ? { inputTags: selectedInputTags } : {}),
      startedAt: continuing ? current.startedAt : now,
      revisionStartedAt: now,
      revision: continuing ? current.revision + 1 : 1,
      status: 'active',
      turns: 0,
      retryRequired: false,
      retryStartedAtTurn: null,
      consecutiveNoProgressTurns: 0
    };
    this.goals.set(sessionId, goal);
    this.executionFailures.delete(sessionId);
    this.changed(goal);
    return goal;
  }

  elapsedWallMs(goal: GoalState): number {
    return Math.max(0, this.now() - goal.startedAt);
  }

  exitSummary(sessionId: string, status: GoalExitSummary['status']): GoalExitSummary | undefined {
    const goal = this.get(sessionId);
    if (goal === undefined || goal.status !== 'active') return undefined;
    return { status, elapsedWallMs: this.elapsedWallMs(goal), turns: goal.turns };
  }

  recordTurn(sessionId: string): GoalState | undefined {
    const current = this.goals.get(sessionId);
    if (current?.status !== 'active') return current;
    const goal = { ...current, turns: current.turns + 1 };
    this.goals.set(sessionId, goal);
    return goal;
  }

  recordExecutionResult(
    sessionId: string,
    input: { readonly failed: boolean; readonly progressed: boolean }
  ): GoalExecutionDisposition {
    const current = this.goals.get(sessionId);
    if (current?.status !== 'active') return 'continue';
    if (!input.failed && !input.progressed) {
      this.executionFailures.delete(sessionId);
      const consecutiveNoProgressTurns = current.consecutiveNoProgressTurns + 1;
      const completed = consecutiveNoProgressTurns >= 3;
      const goal = {
        ...current,
        consecutiveNoProgressTurns,
        ...(completed ? { status: 'completed' as const } : {})
      };
      this.goals.set(sessionId, goal);
      this.changed(goal);
      return completed ? 'completed' : 'continue';
    }
    if (!input.failed) {
      this.executionFailures.delete(sessionId);
      if (current.consecutiveNoProgressTurns > 0) {
        const goal = {
          ...current,
          consecutiveNoProgressTurns: 0
        };
        this.goals.set(sessionId, goal);
        this.changed(goal);
      }
      return 'continue';
    }
    if (current.consecutiveNoProgressTurns > 0) {
      const goal = {
        ...current,
        consecutiveNoProgressTurns: 0
      };
      this.goals.set(sessionId, goal);
    }
    const failures = (this.executionFailures.get(sessionId) ?? 0) + 1;
    this.executionFailures.set(sessionId, failures);
    if (failures <= 3) return 'continue';
    const blocked = {
      ...(this.goals.get(sessionId) ?? current),
      status: 'blocked' as const
    };
    this.goals.set(sessionId, blocked);
    this.changed(blocked);
    return 'blocked';
  }

  resume(sessionId: string): GoalState | undefined {
    const current = this.goals.get(sessionId);
    if (current?.status !== 'active') return current;
    if (current.consecutiveNoProgressTurns === 0) return current;
    const goal = {
      ...current,
      consecutiveNoProgressTurns: 0
    };
    this.goals.set(sessionId, goal);
    this.changed(goal);
    return goal;
  }

  blockAfterRuntimeFailure(sessionId: string, goalId: string, revision: number): GoalState {
    const current = this.requireCurrent(sessionId, goalId, revision);
    const blocked = { ...current, status: 'blocked' as const };
    this.goals.set(sessionId, blocked);
    this.executionFailures.delete(sessionId);
    this.changed(blocked);
    return blocked;
  }

  update(
    sessionId: string,
    goalId: string,
    revision: number,
    status: Exclude<GoalStatus, 'active'>
  ): GoalState {
    const current = this.requireCurrent(sessionId, goalId, revision);
    if (status === 'blocked') {
      if (current.turns < 3) throw new Error('GOAL_BLOCKED_TOO_EARLY');
      if (!current.retryRequired) {
        const retry = {
          ...current,
          retryRequired: true,
          retryStartedAtTurn: current.turns
        };
        this.goals.set(sessionId, retry);
        this.changed(retry);
        return retry;
      }
      if (current.retryStartedAtTurn === null || current.turns <= current.retryStartedAtTurn)
        throw new Error('GOAL_BLOCKED_RETRY_REQUIRED');
    }
    const goal = { ...current, status };
    this.goals.set(sessionId, goal);
    this.changed(goal);
    return goal;
  }

  clear(sessionId: string): boolean {
    const removed = this.goals.delete(sessionId);
    this.executionFailures.delete(sessionId);
    if (removed) this.changed(undefined);
    return removed;
  }

  prompt(sessionId: string, kind: 'start' | 'continue'): string {
    const goal = this.goals.get(sessionId);
    if (goal?.status !== 'active') throw new Error('GOAL_NOT_ACTIVE');
    const heading =
      kind === 'start' ? 'A Goal has started or changed.' : 'Continue the active Goal.';
    const instruction = `${heading}

Continue executing this Goal across turns:
- This Goal is owned by the Node's ${NODE_MCP.goal.name} MCP server. Prefer ${NODE_MCP.goal.name}.${NODE_MCP.goal.tools.update} to complete it. In Codex, a runner-native Goal created during this Goal may also complete it when Codex reports that native Goal complete; native Goal state from another task or turn does not count. Do not claim completion based only on a final message or an unrelated Goal.\n- Work on the objective now. If it is incomplete, use tools to finish a coherent unit or obtain decisive evidence; do not stop at an acknowledgement, status, plan, or promise.\n- Preserve the original scope. Before completion, review the full objective and verify it with real evidence, then call ${NODE_MCP.goal.tools.update} with status=completed when available.\n- Adapt and retry after individual failures. Request blocked only after the same blocker persists for three turns and the required additional retry.\n- Use ${NODE_MCP.goal.tools.get} only when you need to reread the authoritative objective or status.\n- After ${NODE_MCP.goal.tools.update} confirms completed or finally blocked, summarize the completed work, verification evidence, remaining issues, and the tool-reported elapsedWallMs converted from milliseconds into a concise readable duration in your final user-facing response. If Codex instead confirms completion with its native Goal, summarize the work without claiming a MAR elapsedWallMs value. Name whether the Goal completed or is finally blocked. MAR elapsedWallMs includes waiting and retries through the status update, not tool execution time or the final response. If blocked returns active for the required retry, continue work instead of claiming a final summary.`;
    const marker = serializeComposerTag(kind === 'start' ? 'mar_goal_start' : 'mar_goal_continue', {
      objective: goal.objective,
      instruction
    });
    return [marker, goal.inputTags].filter(Boolean).join('\n');
  }

  private requireCurrent(sessionId: string, goalId: string, revision: number): GoalState {
    const current = this.goals.get(sessionId);
    if (current === undefined || current.id !== goalId) throw new Error('GOAL_NOT_FOUND');
    if (current.revision !== revision) throw new Error('GOAL_REVISION_STALE');
    if (current.status !== 'active') throw new Error('GOAL_NOT_ACTIVE');
    return current;
  }
}
