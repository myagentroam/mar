import type { InlineMediaGcCheckpoint } from './inline-media-contract.js';

export type ContextGcWebToolName = 'web_search' | 'web_fetch';
export type ContextGcSubagentToolName =
  'agent_start' | 'agent_wait' | 'agent_message' | 'agent_cancel';

export type ContextGcPlatform = 'linux' | 'darwin' | 'win32';

export interface ContextGcEconomicsPolicy {
  readonly version: 1;
  readonly immediatePaybackRollouts: number;
  readonly maximumPaybackRollouts: number;
  readonly contextGrowthSampleWindow: number;
  readonly minimumContextGrowthSamples: number;
  readonly minimumObservationRollouts: number;
  readonly stageAProtectionRollouts: number;
  readonly largeExecProtectionRollouts: number;
  readonly normalInputCostRate: number;
  readonly cacheReadCostRate: number;
  readonly cacheWriteCostRate: number;
  readonly outputCostRate: number;
  readonly minimumGrossReductionRate: number;
  readonly minimumCacheInvestmentRoi: number;
}

export type ContextGcBase =
  | { readonly type: 'SESSION_START'; readonly firstSequence: number }
  | { readonly type: 'COMPACT'; readonly sequence: number; readonly recordId: string };

export interface ContextGcTarget {
  readonly observationId?: string;
  readonly sequence: number;
  readonly recordId: string;
  readonly role: 'tool_call' | 'tool' | 'provider';
  readonly callId?: string;
  readonly toolName?: string;
}

export interface ContextGcReadItemReplacement {
  readonly supersededByCallId?: string;
  readonly index: number;
  readonly path: string;
  readonly replacement: string;
  readonly evidenceSequence: number;
}

export type ContextGcReplacement =
  | {
      readonly kind: 'READ_OUTPUT_ITEMS';
      readonly callId: string;
      readonly target: ContextGcTarget;
      readonly items: readonly ContextGcReadItemReplacement[];
      readonly evidenceSequences: readonly number[];
    }
  | {
      readonly kind: 'TOOL_CALL_INPUT';
      readonly toolName: 'apply_patch' | 'exec' | 'exec_wait' | 'code_exec';
      readonly callId: string;
      readonly target: ContextGcTarget;
      readonly replacementArguments: unknown;
      readonly providerAliasTargets: readonly ContextGcTarget[];
      readonly evidenceSequence: number;
    }
  | {
      readonly kind: 'EXEC_OUTPUT';
      readonly terminalCallId?: string;
      readonly callId: string;
      readonly target: ContextGcTarget;
      readonly replacementContent: string;
      readonly evidenceSequence: number;
    }
  | {
      readonly kind: 'CODE_MODE_OUTPUT';
      readonly callId: string;
      readonly target: ContextGcTarget;
      readonly replacementContent: string;
      readonly evidenceSequence: number;
    }
  | {
      readonly kind: 'SUBAGENT_OUTPUT';
      readonly toolName: 'agent_wait' | 'agent_message' | 'agent_cancel';
      readonly callId: string;
      readonly target: ContextGcTarget;
      readonly replacementContent: string;
      readonly terminalToolName: ContextGcSubagentToolName;
      readonly terminalCallId: string;
      readonly evidenceSequence: number;
      readonly retainedPriorFinal?: {
        readonly toolName: ContextGcSubagentToolName;
        readonly callId: string;
        readonly evidenceSequence: number;
      };
    }
  | {
      readonly kind: 'WEB_OUTPUT';
      readonly toolName: ContextGcWebToolName;
      readonly callId: string;
      readonly target: ContextGcTarget;
      readonly replacementContent: string;
      readonly evidenceSequence: number;
    };

export interface ContextGcMetrics {
  readonly stage: 'STAGE_A' | 'STAGE_A_AND_EXEC' | 'INLINE_MEDIA';
  readonly tokenEstimator?: 'UTF8_BYTES_V1';
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly reclaimedTokens: number;
  readonly grossReductionRate: number;
  readonly effectiveMinimumGrossReductionRate?: number;
  readonly minimumRequiredReclaimedTokens?: number;
  readonly cacheRebuildPenaltyCostUnits: number;
  readonly compactDeferralCreditCostUnits: number;
  readonly imminentCompactAvoidanceCreditCostUnits?: number;
  readonly appliedCompactCreditCostUnits?: number;
  readonly requiredPositiveNetRollouts: number | null;
  readonly requiredTargetRoiRollouts: number | null;
  readonly projectedRolloutsUntilCompactAfterGc: number;
  readonly projectedTokensBeforeGc?: number;
  readonly projectedTokensAfterGc?: number;
  readonly contextGrowthSampleCount: number;
  readonly contextGrowthP75Tokens: number;
  readonly expectedNetSavedCostUnits: number;
  readonly cacheInvestmentRoi: number;
  readonly minimumObservedRollouts: number;
  readonly protectedCandidateTokens: number;
  readonly eligibleCandidateCount: number;
  readonly eligibleTargetCount: number;
  readonly cachePenaltyKnown?: boolean;
}

export interface ContextGcCheckpointDraft {
  readonly inlineMedia?: InlineMediaGcCheckpoint;
  readonly version: 1;
  readonly base: ContextGcBase;
  readonly boundarySequence: number;
  readonly replacements: readonly ContextGcReplacement[];
  readonly trigger: {
    readonly usageSequence: number | null;
    readonly contextInputTokens: number;
    readonly contextWindowTokens: number;
    readonly normalRolloutOrdinal: number;
    readonly modelId: string;
    readonly platform: ContextGcPlatform;
  };
  readonly economics: ContextGcEconomicsPolicy;
  readonly metrics: ContextGcMetrics;
}

export interface ContextGcCheckpointPayload extends ContextGcCheckpointDraft {
  readonly checkpointId: string;
  readonly generation: number;
}
