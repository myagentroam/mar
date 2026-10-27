export interface ModelUsage {
  /** Normalized total input including cache; distinct from protocol-native inputTokens. */
  totalInputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  inputTokens?: number | undefined;
  contextInputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  rolloutBudgetUnits?: number | undefined;
  hostedSearches?: number | undefined;
  hostedFetches?: number | undefined;
}

/** Safe request facts, independent of conversation events and provider payloads. */
export interface ModelRequestUsage {
  readonly recordId: string;
  readonly requestId: string;
  readonly revision: number;
  readonly modelConfigurationId: string;
  readonly modelName: string;
  readonly provider: string;
  readonly requestedModel: string;
  readonly actualModel?: string;
  readonly responseId?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  readonly inputTokens?: string;
  readonly outputTokens?: string;
  readonly cacheReadTokens?: string;
  readonly cacheWriteTokens?: string;
  readonly reasoningTokens?: string;
}

export interface ModelUsageObservation extends ModelRequestUsage {
  readonly sessionId: string;
  readonly executionId?: string;
  readonly purpose: 'conversation' | 'compact' | 'title' | 'other';
  readonly agentRole: 'root' | 'subagent';
}

export type ModelUsageObserver = (usage: ModelUsageObservation) => Promise<void> | void;
