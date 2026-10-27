export const SUBAGENT_LIMITS = Object.freeze({
  agentWaitMinWaitMs: 0,
  agentWaitWaitFloorMs: 10_000,
  agentWaitDefaultWaitMs: 30_000,
  agentWaitMaxWaitMs: 300_000,
  agentWaitMaxAgents: 8,
  subagentDescriptionMaxCharacters: 80,
  subagentPromptMaxBytes: 131_072,
  subagentMessageMaxBytes: 131_072,
  subagentReasoningEffortMaxCharacters: 64,
  subagentSummaryMaxBytes: 16_384,
  subagentUpdateMaxBytes: 32_768,
  subagentRunningLatestMessageMaxCharacters: 2_000,
  subagentEvidenceMaxItems: 64,
  subagentVerificationMaxItems: 16,
  subagentChangedFilesMaxItems: 200
});
