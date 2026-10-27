import { describe, expect, it } from 'vitest';
import type { ModelMessage, ModelUsage } from '../../src/model/contracts.js';
import { inspectContextGc, planContextGc } from '../../src/runtime/context/gc.js';
import { buildContextProjection } from '../../src/runtime/context/projection.js';
import { validateContextGcCheckpoint } from '../../src/session/context-gc-checkpoint.js';
import type { SessionRecord } from '../../src/session/store/index.js';
import type {
  ContextGcSubagentSnapshot,
  ContextGcSubagentToolName
} from '../../src/session/context-gc-subagent.js';
import {
  contextGcCompletedSubagentTurnId,
  contextGcSubagentPriorFinalIsRetained,
  normalizeContextGcSubagentSnapshot
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

describe('context GC superseded subagent snapshots', () => {
  it('accepts independent Turn identity without accepting partial delivery receipts', () => {
    const snapshot = completedSnapshot('child-turn', {
      latestMessage: undefined,
      turnId: 'child-turn'
    });
    const normalize = (value: ContextGcSubagentSnapshot) =>
      normalizeContextGcSubagentSnapshot(
        JSON.stringify(value),
        { type: 'tool.completed', toolName: 'agent_wait', data: value },
        'agent_wait'
      );
    expect(normalize(snapshot)?.turnId).toBe('child-turn');
    for (const partial of [
      { messageId: 'message' },
      { deliveryStatus: 'applied' as const },
      { messageId: 'message', deliveryStatus: 'applied' as const, turnId: undefined }
    ])
      expect(normalize({ ...snapshot, ...partial })).toBeUndefined();
    expect(
      normalize({ ...snapshot, messageId: 'message', deliveryStatus: 'applied' })
    ).toBeDefined();
  });

  it('requires exact final text and Turn identity when a retained summary replaces a message', () => {
    const source = {
      ...runningSnapshot('current-turn'),
      turnId: 'current-turn',
      latestMessage: latestMessage('prior-turn', 'final_answer', 'Verified result.')
    };
    const retained = completedSnapshot('prior-turn', {
      turnId: 'prior-turn',
      summary: 'Verified result.',
      latestMessage: undefined
    });
    expect(contextGcSubagentPriorFinalIsRetained(source, retained)).toBe(true);
    expect(
      contextGcSubagentPriorFinalIsRetained(source, { ...retained, summary: 'Other result.' })
    ).toBe(false);
    expect(
      contextGcSubagentPriorFinalIsRetained(source, { ...retained, turnId: 'other-turn' })
    ).toBe(false);
  });

  it.each([
    { summary: undefined, turnId: 'child-turn' },
    { summary: 'Done.', turnId: undefined },
    { summary: '', turnId: 'child-turn' }
  ])('rejects a message-free terminal without summary and Turn identity: %#', (override) => {
    const snapshot = completedSnapshot('child-turn', { latestMessage: undefined, ...override });
    expect(contextGcCompletedSubagentTurnId(snapshot)).toBeUndefined();
  });

  it.each([false, true])('reclaims observed work, message omitted=%s', (omitMessage) => {
    const fixture = records();
    const turnId = 'child-turn-1';
    const started = addSubagentRound(fixture, {
      toolName: 'agent_start',
      callId: 'agent-start',
      arguments: {
        description: 'Inspect implementation',
        prompt: 'Inspect the implementation and report evidence.',
        role: 'explore',
        background: true
      },
      snapshot: {
        agentId: 'child-1',
        description: 'Inspect implementation',
        status: 'running',
        modelId: 'child-model',
        modelName: 'Child Model',
        reasoningEffort: 'medium'
      }
    });
    const running = addSubagentRound(fixture, {
      toolName: 'agent_wait',
      callId: 'agent-wait-running',
      arguments: { agentId: 'child-1', waitMs: 30_000 },
      snapshot: { ...runningSnapshot(turnId), waitOutcome: 'timeout' }
    });
    const terminalSnapshot = completedSnapshot(turnId, {
      waitOutcome: 'completion',
      ...(omitMessage ? { latestMessage: undefined, turnId } : {})
    });
    const terminal = addSubagentRound(fixture, {
      toolName: 'agent_wait',
      callId: 'agent-wait-terminal',
      arguments: { agentId: 'child-1', waitMs: 30_000 },
      snapshot: terminalSnapshot
    });
    successfulRollout(fixture.add);
    successfulRollout(fixture.add);

    const selected = planContextGc(plannerInput(fixture.values));
    const replacement = selected?.draft.replacements.find(
      (item) => item.kind === 'SUBAGENT_OUTPUT'
    );

    expect(selected?.stage).toBe('STAGE_A');
    expect(replacement).toMatchObject({
      kind: 'SUBAGENT_OUTPUT',
      toolName: 'agent_wait',
      callId: 'agent-wait-running',
      terminalToolName: 'agent_wait',
      terminalCallId: 'agent-wait-terminal',
      evidenceSequence: terminal.result.sequence
    });
    expect(replacement?.target.sequence).toBe(running.result.sequence);
    if (replacement?.kind !== 'SUBAGENT_OUTPUT') throw new Error('Missing replacement.');
    expect(replacement.replacementContent).toContain('superseded_subagent_snapshot');
    expect(JSON.parse(replacement.replacementContent)).toHaveProperty('waitOutcome', 'timeout');
    expect(replacement.replacementContent).not.toContain('progress-marker');
    expect(replacement.replacementContent).not.toContain('Sha256');
    expect(replacement.replacementContent).not.toContain('terminalCallId');
    expect(replacement.replacementContent).not.toContain('evidenceSequence');
    expect(replacement.replacementContent).not.toContain('"itemId"');
    expect(
      selected?.draft.replacements.some(
        (item) =>
          item.target.sequence === started.result.sequence ||
          item.target.sequence === terminal.result.sequence
      )
    ).toBe(false);

    const checkpoint = fixture.add('context.gc.completed', {
      ...selected!.draft,
      checkpointId: 'subagent-running',
      generation: 1
    });
    expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();

    const projection = buildContextProjection(fixture.values);
    const projectedRunning = projection.entries.find(
      (entry) => entry.record.sequence === running.result.sequence
    )?.message;
    const projectedTerminal = projection.entries.find(
      (entry) => entry.record.sequence === terminal.result.sequence
    )?.message;
    expect(projectedRunning?.role).toBe('tool');
    expect(projectedRunning?.content).toBe(replacement.replacementContent);
    expect(projectedTerminal?.role).toBe('tool');
    expect(projectedTerminal?.content).toBe(JSON.stringify(terminalSnapshot));

    const tampered = structuredClone(checkpoint);
    (
      tampered.payload as {
        replacements: Array<{ replacementContent?: string }>;
      }
    ).replacements[0]!.replacementContent = '{"tampered":true}';
    expect(validateContextGcCheckpoint(fixture.values, tampered)).toBeUndefined();

    const mismatchedToolName = structuredClone(checkpoint);
    (
      mismatchedToolName.payload as {
        replacements: Array<{ toolName?: string }>;
      }
    ).replacements[0]!.toolName = 'agent_message';
    expect(validateContextGcCheckpoint(fixture.values, mismatchedToolName)).toBeUndefined();

    const mismatchedTargetToolName = structuredClone(checkpoint);
    (
      mismatchedTargetToolName.payload as {
        replacements: Array<{ target: { toolName?: string } }>;
      }
    ).replacements[0]!.target.toolName = 'agent_message';
    expect(validateContextGcCheckpoint(fixture.values, mismatchedTargetToolName)).toBeUndefined();
  });

  it('reclaims an earlier duplicate completion only after a later identical terminal observation', () => {
    const fixture = records();
    const turnId = 'child-turn-duplicate';
    const snapshot = completedSnapshot(turnId);
    const first = addSubagentRound(fixture, {
      toolName: 'agent_wait',
      callId: 'agent-wait-terminal-first',
      arguments: { agentId: 'child-1', waitMs: 30_000 },
      snapshot
    });
    const last = addSubagentRound(fixture, {
      toolName: 'agent_wait',
      callId: 'agent-wait-terminal-last',
      arguments: { agentId: 'child-1', waitMs: 0 },
      snapshot
    });
    successfulRollout(fixture.add);
    successfulRollout(fixture.add);

    const selected = planContextGc(plannerInput(fixture.values));
    const replacements = selected?.draft.replacements.filter(
      (item) => item.kind === 'SUBAGENT_OUTPUT'
    );

    expect(replacements).toHaveLength(1);
    expect(replacements?.[0]).toMatchObject({
      callId: 'agent-wait-terminal-first',
      terminalCallId: 'agent-wait-terminal-last',
      evidenceSequence: last.result.sequence
    });
    expect(replacements?.[0]?.target.sequence).toBe(first.result.sequence);
    expect(
      selected?.draft.replacements.some((item) => item.target.sequence === last.result.sequence)
    ).toBe(false);
  });

  for (const status of ['cancelled', 'failed', 'interrupted'] as const) {
    it(`reclaims only precisely covered ${status} snapshots`, () => {
      const fixture = records();
      const turnId = `child-turn-${status}`;
      const terminalSnapshot: ContextGcSubagentSnapshot = {
        ...runningSnapshot(turnId),
        status,
        ...(status === 'failed'
          ? {
              errorCode: 'MAR_AGENT_SUBAGENT_FAILED',
              errorMessage: 'Child failed after reporting progress.'
            }
          : {})
      };
      const duplicate = addSubagentRound(fixture, {
        toolName: 'agent_cancel',
        callId: `agent-${status}-first`,
        arguments: { agentId: 'child-1' },
        snapshot: terminalSnapshot
      });
      const retained = addSubagentRound(fixture, {
        toolName: 'agent_wait',
        callId: `agent-${status}-last`,
        arguments: { agentId: 'child-1', waitMs: 0 },
        snapshot: terminalSnapshot
      });
      successfulRollout(fixture.add);
      successfulRollout(fixture.add);

      const selected = planContextGc(plannerInput(fixture.values));
      const replacement = selected?.draft.replacements.find(
        (item) => item.kind === 'SUBAGENT_OUTPUT'
      );
      expect(replacement).toMatchObject({
        callId: `agent-${status}-first`,
        terminalCallId: `agent-${status}-last`,
        evidenceSequence: retained.result.sequence
      });
      expect(replacement?.target.sequence).toBe(duplicate.result.sequence);
      expect(
        selected?.draft.replacements.some(
          (item) => item.target.sequence === retained.result.sequence
        )
      ).toBe(false);
      if (replacement?.kind !== 'SUBAGENT_OUTPUT') throw new Error('Missing replacement.');
      expect(JSON.parse(replacement.replacementContent)).toHaveProperty(
        'contextGc.terminalStatus',
        status
      );
      expect(replacement.replacementContent).not.toContain(
        terminalSnapshot.latestMessage?.text ?? ''
      );

      const checkpoint = fixture.add('context.gc.completed', {
        ...selected!.draft,
        checkpointId: `subagent-${status}`,
        generation: 1
      });
      expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();
    });
  }

  it('keeps a unique non-completed commentary snapshot', () => {
    const fixture = records();
    const turnId = 'child-turn-cancelled-unique';
    addSubagentRound(fixture, {
      toolName: 'agent_wait',
      callId: 'agent-running-unique',
      arguments: { agentId: 'child-1', waitMs: 30_000 },
      snapshot: runningSnapshot(turnId, 'Unique commentary that is not present later.')
    });
    addSubagentRound(fixture, {
      toolName: 'agent_cancel',
      callId: 'agent-cancelled-different',
      arguments: { agentId: 'child-1' },
      snapshot: {
        ...runningSnapshot(turnId, 'Different retained commentary.'),
        status: 'cancelled'
      }
    });
    successfulRollout(fixture.add);
    successfulRollout(fixture.add);

    expect(planContextGc(plannerInput(fixture.values))).toBeUndefined();
  });

  it.each([false, true])('keeps follow-up, prior message omitted=%s', (omitMessage) => {
    const fixture = records();
    const previousTurn = 'child-turn-previous';
    const currentTurn = 'child-turn-current';
    const previousFinalText = `Previous retained final answer. ${'context '.repeat(1_500)}`;
    const previousMessage = latestMessage(previousTurn, 'final_answer', previousFinalText);
    const previousTerminalSnapshot = completedSnapshot(previousTurn, {
      latestMessage: previousMessage,
      summary: previousFinalText,
      ...(omitMessage ? { latestMessage: undefined, turnId: previousTurn } : {})
    });
    addSubagentRound(fixture, {
      toolName: 'agent_wait',
      callId: 'agent-wait-previous-terminal',
      arguments: { agentId: 'child-1', waitMs: 30_000 },
      snapshot: previousTerminalSnapshot
    });
    const receiptSnapshot: ContextGcSubagentSnapshot = {
      ...runningSnapshot(previousTurn),
      latestMessage: previousMessage,
      messageId: 'message-current',
      turnId: currentTurn,
      deliveryStatus: 'accepted'
    };
    const instruction = 'Review the tests before finishing.';
    const message = addSubagentRound(fixture, {
      toolName: 'agent_message',
      callId: 'agent-message-current',
      arguments: {
        agentId: 'child-1',
        delivery: 'append',
        message: instruction
      },
      snapshot: receiptSnapshot
    });
    const terminalSnapshot = completedSnapshot(currentTurn, {
      messageId: 'message-current',
      turnId: currentTurn,
      deliveryStatus: 'applied'
    });
    addSubagentRound(fixture, {
      toolName: 'agent_wait',
      callId: 'agent-wait-current-terminal',
      arguments: { agentId: 'child-1', waitMs: 30_000 },
      snapshot: terminalSnapshot
    });
    successfulRollout(fixture.add);
    successfulRollout(fixture.add);

    const selected = planContextGc(plannerInput(fixture.values));
    const replacement = selected?.draft.replacements.find(
      (item) => item.kind === 'SUBAGENT_OUTPUT'
    );
    expect(replacement).toMatchObject({
      kind: 'SUBAGENT_OUTPUT',
      toolName: 'agent_message',
      callId: 'agent-message-current',
      retainedPriorFinal: {
        toolName: 'agent_wait',
        callId: 'agent-wait-previous-terminal'
      }
    });
    expect(replacement?.target.sequence).toBe(message.result.sequence);
    const checkpoint = fixture.add('context.gc.completed', {
      ...selected!.draft,
      checkpointId: 'subagent-message',
      generation: 1
    });
    expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();
    const projected = buildContextProjection(fixture.values);
    const projectedInput = projected.entries.find(
      (entry) => entry.record.sequence === message.call.sequence
    )?.message;
    expect(projectedInput?.role).toBe('tool_call');
    expect(projectedInput?.arguments).toMatchObject({ message: instruction });

    const mismatchedRetainedFinal = structuredClone(checkpoint);
    (
      mismatchedRetainedFinal.payload as {
        replacements: Array<{ retainedPriorFinal?: { callId: string } }>;
      }
    ).replacements[0]!.retainedPriorFinal!.callId = 'missing-prior-completion';
    expect(validateContextGcCheckpoint(fixture.values, mismatchedRetainedFinal)).toBeUndefined();
  });

  it('waits for two successful parent rollouts after the terminal evidence', () => {
    const fixture = records();
    const turnId = 'child-turn-protected';
    addSubagentRound(fixture, {
      toolName: 'agent_wait',
      callId: 'agent-wait-protected-running',
      arguments: { agentId: 'child-1', waitMs: 30_000 },
      snapshot: runningSnapshot(turnId)
    });
    addSubagentRound(fixture, {
      toolName: 'agent_wait',
      callId: 'agent-wait-protected-terminal',
      arguments: { agentId: 'child-1', waitMs: 30_000 },
      snapshot: completedSnapshot(turnId)
    });
    successfulRollout(fixture.add);

    const inspection = inspectContextGc(plannerInput(fixture.values));
    expect(inspection.plan).toBeUndefined();
    expect(inspection.retryAfterRollouts).toBe(1);
  });

  it('rejects cross-turn, failed, uncovered, and mismatched terminal evidence', () => {
    const { summary: _summary, ...failedTerminal } = completedSnapshot('failed-turn');
    const scenarios: Array<{
      name: string;
      source: ContextGcSubagentSnapshot;
      terminal: ContextGcSubagentSnapshot;
      completedData?: ContextGcSubagentSnapshot;
      sourceToolName?: ContextGcSubagentToolName;
      sourceArguments?: Record<string, unknown>;
    }> = [
      {
        name: 'different turn',
        source: runningSnapshot('source-turn'),
        terminal: completedSnapshot('terminal-turn')
      },
      {
        name: 'failed terminal',
        source: runningSnapshot('failed-turn'),
        terminal: {
          ...failedTerminal,
          status: 'failed',
          errorCode: 'MAR_AGENT_SUBAGENT_FAILED',
          errorMessage: 'Child failed.'
        }
      },
      {
        name: 'failed source',
        source: {
          ...runningSnapshot('failed-source-turn'),
          status: 'failed',
          errorCode: 'MAR_AGENT_SUBAGENT_FAILED',
          errorMessage: 'Child failed before the later observation.'
        },
        terminal: completedSnapshot('failed-source-turn')
      },
      {
        name: 'uncovered structured evidence',
        source: {
          ...runningSnapshot('evidence-turn'),
          changedFiles: ['src/only-in-progress.ts']
        },
        terminal: completedSnapshot('evidence-turn')
      },
      {
        name: 'failed message receipt',
        source: {
          ...runningSnapshot('receipt-turn'),
          messageId: 'failed-message',
          turnId: 'receipt-turn',
          deliveryStatus: 'failed'
        },
        terminal: completedSnapshot('receipt-turn', {
          messageId: 'failed-message',
          turnId: 'receipt-turn',
          deliveryStatus: 'applied'
        }),
        sourceToolName: 'agent_message',
        sourceArguments: {
          agentId: 'child-1',
          delivery: 'append',
          message: 'Follow up.'
        }
      },
      {
        name: 'unretained previous final',
        source: {
          ...runningSnapshot('previous-unretained'),
          latestMessage: latestMessage(
            'previous-unretained',
            'final_answer',
            'This prior result has no separately retained completed snapshot.'
          ),
          messageId: 'new-message',
          turnId: 'current-with-unretained-previous',
          deliveryStatus: 'accepted'
        },
        terminal: completedSnapshot('current-with-unretained-previous', {
          messageId: 'new-message',
          turnId: 'current-with-unretained-previous',
          deliveryStatus: 'applied'
        }),
        sourceToolName: 'agent_message',
        sourceArguments: {
          agentId: 'child-1',
          delivery: 'append',
          message: 'Start another turn.'
        }
      },
      {
        name: 'source error metadata',
        source: {
          ...runningSnapshot('source-error-turn'),
          errorCode: 'MAR_AGENT_SUBAGENT_RETRYING',
          errorMessage: 'A prior attempt failed.'
        },
        terminal: completedSnapshot('source-error-turn')
      },
      {
        name: 'unapplied terminal receipt',
        source: runningSnapshot('terminal-receipt-turn'),
        terminal: completedSnapshot('terminal-receipt-turn', {
          messageId: 'pending-message',
          turnId: 'terminal-receipt-turn',
          deliveryStatus: 'accepted'
        })
      },
      {
        name: 'mismatched completed data',
        source: runningSnapshot('mismatch-turn'),
        terminal: completedSnapshot('mismatch-turn'),
        completedData: completedSnapshot('mismatch-turn', { summary: 'Different data.' })
      }
    ];

    for (const scenario of scenarios) {
      const fixture = records();
      addSubagentRound(fixture, {
        toolName: scenario.sourceToolName ?? 'agent_wait',
        callId: `${scenario.name}-source`,
        arguments: scenario.sourceArguments ?? { agentId: 'child-1', waitMs: 30_000 },
        snapshot: scenario.source
      });
      addSubagentRound(fixture, {
        toolName: 'agent_wait',
        callId: `${scenario.name}-terminal`,
        arguments: { agentId: 'child-1', waitMs: 30_000 },
        snapshot: scenario.terminal,
        ...(scenario.completedData === undefined ? {} : { completedData: scenario.completedData })
      });
      successfulRollout(fixture.add);
      successfulRollout(fixture.add);

      expect(planContextGc(plannerInput(fixture.values)), scenario.name).toBeUndefined();
    }
  });
});
