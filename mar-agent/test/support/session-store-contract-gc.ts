import type { SessionStore } from '../../src/session/store/contracts.js';
import type {
  ContextGcCheckpointDraft,
  ContextGcMetrics
} from '../../src/session/context-gc-checkpoint.js';
import { contextGcApplyPatchInputReplacement } from '../../src/session/context-gc-replacements.js';

const economics = {
  version: 1,
  immediatePaybackRollouts: 3,
  maximumPaybackRollouts: 20,
  contextGrowthSampleWindow: 16,
  minimumContextGrowthSamples: 6,
  minimumObservationRollouts: 1,
  stageAProtectionRollouts: 2,
  largeExecProtectionRollouts: 6,
  normalInputCostRate: 1,
  cacheReadCostRate: 0.1,
  cacheWriteCostRate: 1.25,
  outputCostRate: 1,
  minimumGrossReductionRate: 0.2,
  minimumCacheInvestmentRoi: 0.1
} as const;

const metrics: ContextGcMetrics = {
  stage: 'STAGE_A',
  beforeTokens: 10,
  afterTokens: 8,
  reclaimedTokens: 2,
  grossReductionRate: 0.2,
  cacheRebuildPenaltyCostUnits: 0,
  compactDeferralCreditCostUnits: 0,
  requiredPositiveNetRollouts: 1,
  requiredTargetRoiRollouts: 1,
  projectedRolloutsUntilCompactAfterGc: 10,
  contextGrowthSampleCount: 0,
  contextGrowthP75Tokens: 0,
  expectedNetSavedCostUnits: 2,
  cacheInvestmentRoi: 0,
  minimumObservedRollouts: 2,
  protectedCandidateTokens: 0,
  eligibleCandidateCount: 1,
  eligibleTargetCount: 1,
  cachePenaltyKnown: true
};

async function appendSuccessfulRollout(
  store: SessionStore,
  sessionId: string,
  contextInputTokens: number
) {
  await store.append(sessionId, {
    type: 'model.attempt',
    payload: {
      purpose: 'EXECUTION',
      protocol: 'ANTHROPIC_MESSAGES',
      transport: 'HTTP',
      state: 'STARTED',
      attempt: 1,
      maxAttempts: 5,
      continuation: false,
      credentialReason: 'REQUEST'
    }
  });
  const usage = await store.append(sessionId, {
    type: 'usage.updated',
    payload: {
      type: 'usage.updated',
      inputTokens: contextInputTokens,
      contextInputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    }
  });
  const completed = await store.append(sessionId, {
    type: 'model.attempt',
    payload: {
      purpose: 'EXECUTION',
      protocol: 'ANTHROPIC_MESSAGES',
      transport: 'HTTP',
      state: 'SUCCEEDED',
      attempt: 1,
      maxAttempts: 5,
      continuation: false,
      credentialReason: 'REQUEST'
    }
  });
  return { usage, completed };
}

async function appendPatchDraft(
  store: SessionStore,
  sessionId: string,
  input: {
    callId: string;
    path: string;
    contextInputTokens: number;
    normalRolloutOrdinal: number;
    turnId?: string;
  }
): Promise<ContextGcCheckpointDraft> {
  const patch = [
    '*** Begin Patch',
    `*** Update File: ${input.path}`,
    '@@',
    '-before',
    '+after',
    '*** End Patch'
  ].join('\n');
  const recordInput = input.turnId ? { executionId: 'execution', turnId: input.turnId } : undefined;
  const call = await store.append(sessionId, {
    type: 'model.context',
    payload: {
      role: 'tool_call',
      content: '',
      callId: input.callId,
      name: 'apply_patch',
      arguments: patch,
      inputMode: 'freeform'
    },
    ...recordInput
  });
  const data = {
    files: [
      {
        path: input.path,
        operation: 'modified',
        addedLines: 1,
        deletedLines: 1
      }
    ],
    totals: { files: 1, addedLines: 1, deletedLines: 1 }
  };
  await store.append(sessionId, {
    type: 'tool.completed',
    payload: {
      type: 'tool.completed',
      toolName: 'apply_patch',
      callId: input.callId,
      summary: 'applied',
      data
    },
    ...recordInput
  });
  const result = await store.append(sessionId, {
    type: 'model.context',
    payload: { role: 'tool', callId: input.callId, content: JSON.stringify(data) },
    ...recordInput
  });
  await appendSuccessfulRollout(store, sessionId, input.contextInputTokens);
  const latest = await appendSuccessfulRollout(store, sessionId, input.contextInputTokens);
  const draft: ContextGcCheckpointDraft = {
    version: 1,
    base: { type: 'SESSION_START', firstSequence: 1 },
    boundarySequence: latest.completed.sequence,
    replacements: [
      {
        kind: 'TOOL_CALL_INPUT',
        toolName: 'apply_patch',
        callId: input.callId,
        target: {
          sequence: call.sequence,
          recordId: call.recordId,
          role: 'tool_call',
          callId: input.callId,
          toolName: 'apply_patch'
        },
        replacementArguments: contextGcApplyPatchInputReplacement(patch, {
          files: [
            {
              path: input.path,
              operation: 'modified',
              addedLines: 1,
              deletedLines: 1
            }
          ],
          totals: { files: 1, addedLines: 1, deletedLines: 1 }
        }),
        providerAliasTargets: [],
        evidenceSequence: result.sequence
      }
    ],
    trigger: {
      usageSequence: latest.usage.sequence,
      contextInputTokens: input.contextInputTokens,
      contextWindowTokens: 10_000,
      normalRolloutOrdinal: input.normalRolloutOrdinal,
      modelId: 'coding',
      platform: 'linux'
    },
    economics,
    metrics
  };
  return draft;
}

export async function prepareContractGcDraft(store: SessionStore, sessionId: string) {
  await store.append(sessionId, {
    type: 'turn.user',
    payload: { prompt: 'Update the source.' },
    executionId: 'execution',
    turnId: 'turn-1'
  });
  await store.append(sessionId, {
    type: 'execution.header',
    payload: { modelId: 'coding', contextWindowTokens: 10_000, mode: 'run' },
    executionId: 'execution',
    turnId: 'turn-1'
  });
  return appendPatchDraft(store, sessionId, {
    callId: 'patch-1',
    path: 'src/a.ts',
    contextInputTokens: 6_000,
    normalRolloutOrdinal: 2,
    turnId: 'turn-1'
  });
}
