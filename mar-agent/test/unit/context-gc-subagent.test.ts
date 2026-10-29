import { describe, expect, it } from 'vitest';
import type { ModelMessage, ModelUsage } from '../../src/model/contracts.js';
import { planContextGc } from '../../src/runtime/context/gc.js';
import { buildContextProjection } from '../../src/runtime/context/projection.js';
import { validateContextGcCheckpoint } from '../../src/session/context-gc-checkpoint.js';
import type { SessionRecord } from '../../src/session/store/index.js';
import type {
  ContextGcSubagentSnapshot,
  ContextGcSubagentToolName
} from '../../src/session/context-gc-subagent.js';

function records() {
  let sequence = 0;
  const values: SessionRecord[] = [];
  const add = (type: string, payload: unknown) => {
    const record: SessionRecord = {
      recordId: `record-${++sequence}`,
      sequence,
      timestamp: new Date(1_800_000_000_000 + sequence).toISOString(),
      sessionId: 'session',
      executionId: 'execution',
      turnId: 'parent-turn',
      type,
      payload
    };
    values.push(record);
    return record;
  };
  add('session.created', { title: 'Subagent GC', workspace: '/workspace' });
  add('execution.header', {
    modelId: 'coding',
    contextWindowTokens: 10_000,
    mode: 'run'
  });
  return { values, add };
}

function modelContext(
  add: ReturnType<typeof records>['add'],
  message: ModelMessage
): SessionRecord {
  return add('model.context', message);
}

function addSubagentRound(
  fixture: ReturnType<typeof records>,
  input: {
    toolName: ContextGcSubagentToolName;
    callId: string;
    arguments: Record<string, unknown>;
    snapshot: ContextGcSubagentSnapshot;
    completedData?: ContextGcSubagentSnapshot;
  }
) {
  const call = modelContext(fixture.add, {
    role: 'tool_call',
    content: '',
    callId: input.callId,
    name: input.toolName,
    arguments: input.arguments
  });
  fixture.add('tool.completed', {
    type: 'tool.completed',
    toolName: input.toolName,
    callId: input.callId,
    summary: input.snapshot.status,
    truncated: false,
    data: input.completedData ?? input.snapshot
  });
  const result = modelContext(fixture.add, {
    role: 'tool',
    callId: input.callId,
    content: JSON.stringify(input.snapshot)
  });
  return { call, result };
}

function successfulRollout(
  add: ReturnType<typeof records>['add'],
  usage: ModelUsage = {
    inputTokens: 8_000,
    contextInputTokens: 8_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 10
  }
) {
  add('model.attempt', {
    purpose: 'EXECUTION',
    protocol: 'OPENAI_RESPONSES',
    transport: 'HTTP',
    state: 'STARTED',
    attempt: 1,
    maxAttempts: 5,
    continuation: false,
    credentialReason: 'REQUEST'
  });
  add('usage.updated', { type: 'usage.updated', ...usage });
  add('model.attempt', {
    purpose: 'EXECUTION',
    protocol: 'OPENAI_RESPONSES',
    transport: 'HTTP',
    state: 'SUCCEEDED',
    attempt: 1,
    maxAttempts: 5,
    continuation: false,
    credentialReason: 'REQUEST'
  });
}

function plannerInput(values: readonly SessionRecord[]) {
  const projection = buildContextProjection(values);
  return {
    records: values,
    messages: projection.entries.map((entry) => entry.message),
    messageSources: projection.entries.map((entry) => entry.record),
    system: 'System.',
    tools: [],
    modelId: 'coding',
    modelProtocol: 'OPENAI_RESPONSES',
    contextWindowTokens: 10_000,
    usage: {
      inputTokens: 8_000,
      contextInputTokens: 8_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 10
    },
    workspace: '/workspace',
    platform: 'linux' as const,
    activeProcessIds: new Set<string>()
  };
}

function latestMessage(
  turnId: string,
  phase: 'commentary' | 'final_answer',
  text: string,
  itemId = `${turnId}-${phase}`
): NonNullable<ContextGcSubagentSnapshot['latestMessage']> {
  return {
    itemId,
    turnId,
    phase,
    text,
    timestamp: '2027-01-15T08:00:00.000Z',
    truncated: false
  };
}

function runningSnapshot(
  turnId: string,
  text = `progress-marker ${'working '.repeat(1_500)}`
): ContextGcSubagentSnapshot {
  return {
    agentId: 'child-1',
    description: 'Inspect implementation',
    status: 'running',
    modelId: 'child-model',
    modelName: 'Child Model',
    reasoningEffort: 'medium',
    latestMessage: latestMessage(turnId, 'commentary', text),
    changedFiles: ['src/a.ts'],
    verification: ['unit tests pending'],
    evidence: [{ path: 'src/a.ts', startLine: 1, endLine: 20 }]
  };
}

function completedSnapshot(
  turnId: string,
  input: Partial<ContextGcSubagentSnapshot> = {}
): ContextGcSubagentSnapshot {
  const finalText = `Completed child result for ${turnId}. ${'verified '.repeat(300)}`;
  return {
    agentId: 'child-1',
    description: 'Inspect implementation',
    status: 'completed',
    modelId: 'child-model',
    modelName: 'Child Model',
    reasoningEffort: 'medium',
    latestMessage: latestMessage(turnId, 'final_answer', finalText),
    summary: finalText,
    changedFiles: ['src/a.ts'],
    verification: ['unit tests pending', 'unit tests passed'],
    evidence: [{ path: 'src/a.ts', startLine: 1, endLine: 20 }],
    ...input
  };
}

describe('ordinary GC and legacy child-result checkpoints', () => {
  it.each(['agent_wait', 'custom_tool'])(
    'reclaims %s as ordinary output after protection and restores it',
    (toolName) => {
      const f = records();
      modelContext(f.add, {
        role: 'tool_call',
        name: toolName,
        callId: 'call',
        content: '',
        arguments: {}
      });
      f.add('tool.completed', {
        type: 'tool.completed',
        toolName,
        callId: 'call',
        summary: 'done',
        truncated: false
      });
      const original = JSON.stringify({
        status: 'running',
        content: 'large content '.repeat(2000)
      });
      const result = modelContext(f.add, { role: 'tool', callId: 'call', content: original });
      for (let i = 0; i < 5; i++) successfulRollout(f.add);
      expect(
        planContextGc(plannerInput(f.values))?.draft.replacements.some(
          (item) => item.kind === 'TOOL_OUTPUT'
        ) ?? false
      ).toBe(false);
      successfulRollout(f.add);
      const plan = planContextGc(plannerInput(f.values));
      const replacements = plan?.draft.replacements.filter((item) => item.kind === 'TOOL_OUTPUT');
      expect(replacements).toHaveLength(1);
      expect(replacements![0]).toMatchObject({
        toolName,
        callId: 'call',
        target: { recordId: result.recordId }
      });
      const checkpoint = f.add('context.gc.completed', {
        ...plan!.draft,
        checkpointId: 'ordinary-output',
        generation: 1
      });
      expect(validateContextGcCheckpoint(f.values, checkpoint)).toBeDefined();
      const restored = buildContextProjection(structuredClone(f.values)).entries.find(
        (entry) => entry.record.recordId === result.recordId
      )?.message.content;
      expect(restored).toBe(replacements![0]!.replacementContent);
      expect(restored).not.toBe(original);
    }
  );
  it('does not infer a child-result replacement from tool names or old-shaped data', () => {
    const fixture = records();
    addSubagentRound(fixture, {
      toolName: 'agent_wait',
      callId: 'wait-1',
      arguments: { agentId: 'child-1' },
      snapshot: runningSnapshot('child-turn')
    });
    addSubagentRound(fixture, {
      toolName: 'agent_wait',
      callId: 'wait-2',
      arguments: { agentId: 'child-1' },
      snapshot: completedSnapshot('child-turn')
    });
    successfulRollout(fixture.add);
    successfulRollout(fixture.add);
    expect(
      planContextGc(plannerInput(fixture.values))?.draft.replacements.some(
        (replacement) => replacement.kind === 'SUBAGENT_OUTPUT'
      ) ?? false
    ).toBe(false);
  });

  it('restores the saved projection of a legacy committed checkpoint', () => {
    const fixture = records();
    const source = addSubagentRound(fixture, {
      toolName: 'agent_wait',
      callId: 'wait-old',
      arguments: { agentId: 'child-1' },
      snapshot: runningSnapshot('child-turn')
    });
    const terminal = addSubagentRound(fixture, {
      toolName: 'agent_wait',
      callId: 'wait-final',
      arguments: { agentId: 'child-1' },
      snapshot: completedSnapshot('child-turn')
    });
    successfulRollout(fixture.add);
    successfulRollout(fixture.add);
    const boundarySequence = fixture.values.at(-1)!.sequence;
    const replacementContent = 'previously committed replacement';
    const checkpoint = fixture.add('context.gc.completed', {
      version: 1,
      checkpointId: 'legacy-child-output',
      generation: 1,
      base: { type: 'SESSION_START', firstSequence: 1 },
      boundarySequence,
      replacements: [
        {
          kind: 'SUBAGENT_OUTPUT',
          toolName: 'agent_wait',
          callId: 'wait-old',
          target: {
            sequence: source.result.sequence,
            recordId: source.result.recordId,
            role: 'tool',
            callId: 'wait-old'
          },
          replacementContent,
          terminalToolName: 'agent_wait',
          terminalCallId: 'wait-final',
          evidenceSequence: terminal.result.sequence
        }
      ],
      trigger: {
        usageSequence: null,
        contextInputTokens: 8000,
        contextWindowTokens: 10000,
        normalRolloutOrdinal: 2,
        modelId: 'coding',
        platform: 'linux'
      },
      economics: {
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
      },
      metrics: {
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
      }
    });
    const projection = buildContextProjection(fixture.values);
    expect(
      projection.entries.find((entry) => entry.record.sequence === source.result.sequence)?.message
        .content
    ).toBe(replacementContent);
    expect(fixture.values.at(-1)).toBe(checkpoint);
  });
});
