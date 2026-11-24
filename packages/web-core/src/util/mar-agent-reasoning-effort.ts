import { marAgentReasoningEffortSchema, type MarAgentReasoningEffort } from '@myagentroam/protocol';

export const marAgentReasoningEffortOptions: readonly MarAgentReasoningEffort[] =
  marAgentReasoningEffortSchema.options;

const effortRank = new Map<string, number>(
  marAgentReasoningEffortOptions.map((effort, index) => [effort, index])
);

// Keep newer options in their reported order after the known strengths.
export function orderMarAgentReasoningEfforts<Effort extends string>(
  efforts: readonly Effort[]
): Effort[] {
  const rank = (effort: string) => effortRank.get(effort) ?? effortRank.size;
  return [...efforts].sort((left, right) => rank(left) - rank(right));
}
