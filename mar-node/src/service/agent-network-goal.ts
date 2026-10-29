import { isPlainRecord } from '../util/records.js';

export type AgentGoalChange =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'set'; readonly objective: string }
  | { readonly kind: 'clear' };

/** Shared Goal input contract for native tools and CLI. */
export function parseAgentGoal(input: unknown): AgentGoalChange {
  if (input === undefined || input === null) return { kind: 'unchanged' };
  if (!isPlainRecord(input)) throw new Error('AGENT_GOAL_INVALID');
  const keys = Object.keys(input);
  if (keys.length !== 1) throw new Error('AGENT_GOAL_INVALID');
  if (keys[0] === 'clear' && input.clear === true) return { kind: 'clear' };
  if (keys[0] === 'objective' && typeof input.objective === 'string') {
    const objective = input.objective.trim();
    if (objective.length > 0 && objective.length <= 20_000) return { kind: 'set', objective };
  }
  throw new Error('AGENT_GOAL_INVALID');
}
