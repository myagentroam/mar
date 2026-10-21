import { formatReadContextItem } from '../../src/agent-core/tools/local/read-context.js';
import { describe, expect, it } from 'vitest';
import type { ModelMessage, ModelUsage } from '../../src/agent-core/model/contracts.js';
import {
  contextGcAppliedCompactCreditCostUnits,
  contextGcImminentCompactAvoidanceCredit,
  contextGcMinimumGrossReductionRate,
  contextGcMinimumReclaimedTokens,
  evaluateContextGcEconomics,
  inspectContextGc,
  planContextGc,
  type ContextGcPlannerInput
} from '../../src/agent-core/runtime/context/gc.js';
import {
  contextGcExecInputReplacement,
  contextGcExecOutputReplacement
} from '../../src/agent-core/session/context-gc-replacements.js';
import {
  buildContextProjection,
  applyContextGcReplacementsToMessages
} from '../../src/agent-core/runtime/context/projection.js';
import { contextGcMessageTokens } from '../../src/agent-core/runtime/context/gc-tokens.js';
import { validateContextGcCheckpoint } from '../../src/agent-core/session/context-gc-checkpoint.js';
import type { SessionRecord } from '../../src/agent-core/session/store/index.js';

function records() {
  let sequence = 0;
  const values: SessionRecord[] = [];
  const add = (type: string, payload: unknown) => {
    const record: SessionRecord = {
      schemaVersion: 1,
      recordId: `record-${++sequence}`,
      sequence,
      timestamp: new Date(1_800_000_000_000 + sequence).toISOString(),
      sessionId: 'session',
      executionId: 'execution',
      turnId: 'turn',
      type,
      payload
    };
    values.push(record);
    return record;
  };
  add('session.created', { title: 'GC policy', workspace: '/workspace' });
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

function successfulRollout(
  add: ReturnType<typeof records>['add'],
  contextInputTokens: number,
  cacheReadTokens = 0
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
  const usage = add('usage.updated', {
    type: 'usage.updated',
    inputTokens: contextInputTokens,
    contextInputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    outputTokens: 10
  });
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
  return usage;
}

function plan(
  values: readonly SessionRecord[],
  usage: ModelUsage,
  overrides: Partial<ContextGcPlannerInput> = {}
) {
  const projection = buildContextProjection(values, '/workspace');
  return planContextGc({
    records: values,
    messages: projection.entries.map((entry) => entry.message),
    messageSources: projection.entries.map((entry) => entry.record),
    system: 'System.',
    tools: [],
    modelId: 'coding',
    modelProtocol: 'OPENAI_RESPONSES',
    contextWindowTokens: 10_000,
    usage,
    workspace: '/workspace',
    platform: 'linux',
    activeProcessIds: new Set(),
    ...overrides
  });
}

function addTruncatedExec(
  fixture: ReturnType<typeof records>,
  input: { toolResultTruncated: boolean }
) {
  const call = modelContext(fixture.add, {
    role: 'tool_call',
    content: '',
    callId: 'exec-large',
    name: 'exec',
    arguments: {
      action: 'start',
      command: 'run-large-verification',
      cwd: '/workspace',
      yieldMs: 30_000
    }
  });
  fixture.add('tool.completed', {
    type: 'tool.completed',
    toolName: 'exec',
    callId: 'exec-large',
    summary: 'completed',
    truncated: input.toolResultTruncated,
    data: {
      status: 'completed',
      exitCode: 1,
      truncated: false,
      stdoutBytes: 80_000,
      stderrBytes: 20_000,
      stdoutDroppedBytes: 0,
      stderrDroppedBytes: 0
    }
  });
  const content = `{"status":"completed","stdout":"${'x'.repeat(
    20_000
  )}\n...[tool output omitted middle]...\n${'y'.repeat(20_000)}","exitCode":1,"truncated":false}`;
  const result = modelContext(fixture.add, {
    role: 'tool',
    callId: 'exec-large',
    content
  });
  return { call, result, content };
}

function addTerminalExec(fixture: ReturnType<typeof records>, id: string, stdout: string) {
  const metadata = {
    processId: `process-${id}`,
    status: 'completed',
    exitCode: 1,
    truncated: false,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: 0,
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0
  };
  modelContext(fixture.add, {
    role: 'tool_call',
    callId: id,
    name: 'exec',
    arguments: { command: `verify ${id}` },
    content: ''
  });
  fixture.add('tool.completed', {
    type: 'tool.completed',
    toolName: 'exec',
    callId: id,
    summary: 'done',
    truncated: false,
    data: metadata
  });
  modelContext(fixture.add, {
    role: 'tool',
    callId: id,
    content: JSON.stringify({ ...metadata, stdout, stderr: '' })
  });
}

function addPatchCandidate(fixture: ReturnType<typeof records>) {
  modelContext(fixture.add, {
    role: 'tool_call',
    content: '',
    callId: 'read-source',
    name: 'read',
    arguments: { reads: [{ path: 'src/a.ts' }] }
  });
  modelContext(fixture.add, {
    role: 'tool',
    callId: 'read-source',
    content: formatReadContextItem(
      0,
      {
        path: 'src/a.ts',
        encoding: 'utf-8',
        newline: 'lf',
        startLine: 1,
        endLine: 1,
        eof: true,
        truncated: false
      },
      `1\t${'alpha '.repeat(1_200)}`
    )
  });
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/a.ts',
    '@@',
    '-alpha',
    '+beta',
    '*** End Patch'
  ].join('\n');
  modelContext(fixture.add, {
    role: 'tool_call',
    content: '',
    callId: 'patch-source',
    name: 'apply_patch',
    arguments: patch,
    inputMode: 'freeform'
  });
  fixture.add('tool.completed', {
    type: 'tool.completed',
    toolName: 'apply_patch',
    callId: 'patch-source',
    summary: 'applied',
    data: {
      files: [
        {
          path: 'src/a.ts',
          operation: 'modified',
          addedLines: 1,
          deletedLines: 1
        }
      ],
      totals: { files: 1, addedLines: 1, deletedLines: 1 }
    }
  });
  modelContext(fixture.add, {
    role: 'tool',
    callId: 'patch-source',
    content: JSON.stringify({
      files: [
        {
          path: 'src/a.ts',
          operation: 'modified',
          addedLines: 1,
          deletedLines: 1
        }
      ],
      totals: { files: 1, addedLines: 1, deletedLines: 1 }
    })
  });
}

function addWebResult(fixture: ReturnType<typeof records>, id: string, content: string) {
  modelContext(fixture.add, {
    role: 'tool_call',
    content: '',
    callId: id,
    name: 'web_fetch',
    arguments: { url: 'https://example.test/evidence' }
  });
  fixture.add('tool.completed', {
    type: 'tool.completed',
    toolName: 'web_fetch',
    callId: id,
    truncated: false,
    data: { status: 200 }
  });
  modelContext(fixture.add, { role: 'tool', callId: id, content });
}

describe('context GC high-water policy', () => {
  it('keeps short exec input intact and long input recoverable without model-visible hashes', () => {
    expect(
      contextGcExecInputReplacement({
        command: 'printf short',
        cwd: '/workspace'
      })
    ).toMatchObject({ action: 'start', command: 'printf short' });

    const command = `head-${'x'.repeat(1_000)}-tail`;
    const replacement = contextGcExecInputReplacement({ action: 'start', command }) as Record<
      string,
      unknown
    >;
    expect(replacement).not.toHaveProperty('command');
    expect(replacement.commandPreview).toContain('head-');
    expect(replacement.commandPreview).toContain('-tail');
    expect(replacement.commandBytes).toBe(Buffer.byteLength(command));
    expect(replacement).not.toHaveProperty('commandSha256');
    expect(replacement.contextGc).not.toHaveProperty('originalSha256');
  });

  it('marks exec output preview completeness and retained line counts', () => {
    const stdout = Array.from({ length: 700 }, (_, index) => `line-${index}`).join('\n');
    const replacement = JSON.parse(
      contextGcExecOutputReplacement({
        source: 'STRUCTURED',
        status: 'completed',
        exitCode: 0,
        truncated: false,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: 0,
        stdoutDroppedBytes: 0,
        stderrDroppedBytes: 0,
        stdout,
        stderr: ''
      })
    ) as Record<string, unknown>;
    expect(replacement.stdoutLines).toBe(700);
    expect(replacement.stderrLines).toBe(0);
    expect(replacement.stdoutPreviewComplete).toBe(false);
    expect(replacement.stderrPreviewComplete).toBe(true);
    expect(replacement).not.toHaveProperty('stdoutSha256');
    expect(replacement).not.toHaveProperty('stderrSha256');
    expect(replacement.contextGc).toContain('preview is not the complete result');
  });

  it('marks a short exec preview incomplete when bytes were dropped before persistence', () => {
    const replacement = JSON.parse(
      contextGcExecOutputReplacement({
        source: 'STRUCTURED',
        status: 'completed',
        exitCode: 0,
        truncated: false,
        stdoutBytes: 10,
        stderrBytes: 0,
        stdoutDroppedBytes: 4,
        stderrDroppedBytes: 0,
        stdout: 'short',
        stderr: ''
      })
    ) as Record<string, unknown>;
    expect(replacement.stdoutPreview).toBe('short');
    expect(replacement.stdoutPreviewComplete).toBe(false);
    expect(replacement.stderrPreviewComplete).toBe(true);
  });

  it('recovers a model-truncated terminal exec result with deterministic evidence', () => {
    const fixture = records();
    const exec = addTruncatedExec(fixture, { toolResultTruncated: true });
    for (let index = 0; index < 6; index++) successfulRollout(fixture.add, 8_000);

    const selected = plan(fixture.values, {
      contextInputTokens: 8_000,
      cacheReadTokens: 0,
      outputTokens: 10
    });
    const replacement = selected?.draft.replacements.find((item) => item.kind === 'EXEC_OUTPUT');

    expect(selected?.stage).toBe('STAGE_A_AND_EXEC');
    expect(replacement).toMatchObject({
      kind: 'EXEC_OUTPUT',
      target: expect.objectContaining({ sequence: exec.result.sequence })
    });
    expect(JSON.parse(replacement!.replacementContent)).toHaveProperty(
      'modelContextTruncated',
      true
    );
    expect(JSON.parse(replacement!.replacementContent)).toHaveProperty(
      'modelContextBytes',
      Buffer.byteLength(exec.content)
    );
    expect(replacement?.replacementContent).not.toContain('x'.repeat(2_000));

    const checkpoint = fixture.add('context.gc.completed', {
      ...selected!.draft,
      checkpointId: 'checkpoint-truncated-exec',
      generation: 1
    });
    expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();

    const corrupted = structuredClone(fixture.values);
    const payload = corrupted.at(-1)!.payload as {
      replacements: Array<{ kind: string; replacementContent?: string }>;
    };
    const output = payload.replacements.find((item) => item.kind === 'EXEC_OUTPUT')!;
    output.replacementContent = `${output.replacementContent}tampered`;
    expect(validateContextGcCheckpoint(corrupted, corrupted.at(-1)!)).toBeUndefined();
  });

  it('does not trust malformed exec text without an explicit model-result truncation marker', () => {
    const fixture = records();
    addTruncatedExec(fixture, { toolResultTruncated: false });
    for (let index = 0; index < 6; index++) successfulRollout(fixture.add, 8_000);

    expect(
      plan(fixture.values, {
        contextInputTokens: 8_000,
        cacheReadTokens: 0,
        outputTokens: 10
      })
    ).toBeUndefined();
  });

  it('rejects model-truncated exec fallback when terminal metadata is malformed', () => {
    const fixture = records();
    addTruncatedExec(fixture, { toolResultTruncated: true });
    const completed = fixture.values.find(
      (record) =>
        record.type === 'tool.completed' &&
        (record.payload as { callId?: string }).callId === 'exec-large'
    )!;
    (
      completed.payload as {
        data: { stdoutBytes: number };
      }
    ).data.stdoutBytes = -1;
    for (let index = 0; index < 6; index++) successfulRollout(fixture.add, 8_000);

    expect(
      plan(fixture.values, {
        contextInputTokens: 8_000,
        cacheReadTokens: 0,
        outputTokens: 10
      })
    ).toBeUndefined();
  });

  it.each(['exec', 'exec_wait'])(
    'uses model-truncated %s terminal evidence for the complete lifecycle',
    (waitTool) => {
      const fixture = records();
      const processId = 'process-large';
      const startCall = modelContext(fixture.add, {
        role: 'tool_call',
        content: '',
        callId: 'exec-start',
        name: 'exec',
        arguments: { command: 'long-running-verification', yieldMs: 10 }
      });
      fixture.add('tool.completed', {
        type: 'tool.completed',
        toolName: 'exec',
        callId: 'exec-start',
        summary: 'running',
        truncated: false,
        data: {
          status: 'running',
          processId,
          truncated: false,
          stdoutBytes: 0,
          stderrBytes: 0,
          stdoutDroppedBytes: 0,
          stderrDroppedBytes: 0
        }
      });
      const startResult = modelContext(fixture.add, {
        role: 'tool',
        callId: 'exec-start',
        content: JSON.stringify({
          status: 'running',
          processId,
          stdout: '',
          stderr: '',
          truncated: false,
          stdoutBytes: 0,
          stderrBytes: 0,
          stdoutDroppedBytes: 0,
          stderrDroppedBytes: 0
        })
      });
      const pollCall = modelContext(fixture.add, {
        role: 'tool_call',
        content: '',
        callId: 'exec-poll',
        name: waitTool,
        arguments: {
          ...(waitTool === 'exec' ? { action: 'poll' } : {}),
          processId,
          yieldMs: 30_000
        }
      });
      fixture.add('tool.completed', {
        type: 'tool.completed',
        toolName: waitTool,
        callId: 'exec-poll',
        summary: 'completed',
        truncated: true,
        data: {
          status: 'completed',
          exitCode: 0,
          truncated: false,
          stdoutBytes: 100_000,
          stderrBytes: 0,
          stdoutDroppedBytes: 0,
          stderrDroppedBytes: 0
        }
      });
      const pollResult = modelContext(fixture.add, {
        role: 'tool',
        callId: 'exec-poll',
        content: `{"status":"completed","stdout":"${'x'.repeat(
          20_000
        )}\n...[tool output omitted middle]...\n${'y'.repeat(20_000)}","exitCode":0}`
      });
      for (let index = 0; index < 6; index++) successfulRollout(fixture.add, 8_000);

      const selected = plan(fixture.values, {
        contextInputTokens: 8_000,
        cacheReadTokens: 0,
        outputTokens: 10
      });
      expect(
        selected?.draft.replacements.map((replacement) => replacement.target.sequence)
      ).toEqual(
        expect.arrayContaining([
          startCall.sequence,
          startResult.sequence,
          pollCall.sequence,
          pollResult.sequence
        ])
      );
      const terminal = selected?.draft.replacements.find(
        (replacement) =>
          replacement.kind === 'EXEC_OUTPUT' && replacement.target.sequence === pollResult.sequence
      );
      if (terminal?.kind !== 'EXEC_OUTPUT') throw new Error('Missing exec replacement.');
      expect(JSON.parse(terminal!.replacementContent)).toHaveProperty(
        'modelContextTruncated',
        true
      );

      const checkpoint = fixture.add('context.gc.completed', {
        ...selected!.draft,
        checkpointId: 'checkpoint-truncated-lifecycle',
        generation: 1
      });
      expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();
    }
  );

  it('decreases only the high-water gross threshold and keeps a window-relative floor', () => {
    expect(contextGcMinimumGrossReductionRate(0.5)).toBe(0.2);
    expect(contextGcMinimumGrossReductionRate(0.7)).toBe(0.2);
    expect(contextGcMinimumGrossReductionRate(0.8)).toBeCloseTo(0.15);
    expect(contextGcMinimumGrossReductionRate(0.85)).toBeCloseTo(0.125);
    expect(contextGcMinimumGrossReductionRate(0.9)).toBeCloseTo(0.1);

    expect(contextGcMinimumReclaimedTokens(7_000, 10_000)).toBe(1_400);
    expect(contextGcMinimumReclaimedTokens(8_000, 10_000)).toBe(1_200);
    expect(contextGcMinimumReclaimedTokens(8_800, 10_000)).toBe(968);
    expect(contextGcMinimumReclaimedTokens(1_000, 10_000)).toBe(500);
  });

  it('uses the whole-plan gross gate rather than a per-exec size threshold', () => {
    const fixture = records();
    const output = 'result '.repeat(1_350);
    modelContext(fixture.add, {
      role: 'tool_call',
      content: '',
      callId: 'exec-dynamic-threshold',
      name: 'exec',
      arguments: { action: 'start', command: 'run medium verification' }
    });
    fixture.add('tool.completed', {
      type: 'tool.completed',
      toolName: 'exec',
      callId: 'exec-dynamic-threshold',
      summary: 'completed',
      truncated: false,
      data: {
        status: 'completed',
        exitCode: 0,
        truncated: false,
        stdoutBytes: Buffer.byteLength(output),
        stderrBytes: 0,
        stdoutDroppedBytes: 0,
        stderrDroppedBytes: 0
      }
    });
    modelContext(fixture.add, {
      role: 'tool',
      callId: 'exec-dynamic-threshold',
      content: JSON.stringify({
        status: 'completed',
        exitCode: 0,
        truncated: false,
        stdoutBytes: Buffer.byteLength(output),
        stderrBytes: 0,
        stdoutDroppedBytes: 0,
        stderrDroppedBytes: 0,
        stdout: output,
        stderr: ''
      })
    });
    for (let index = 0; index < 6; index++) successfulRollout(fixture.add, 8_000);

    expect(
      plan(fixture.values, {
        contextInputTokens: 7_999,
        cacheReadTokens: 0,
        outputTokens: 10
      })?.stage
    ).toBe('STAGE_A_AND_EXEC');
    expect(
      plan(fixture.values, {
        contextInputTokens: 8_000,
        cacheReadTokens: 0,
        outputTokens: 10
      })?.stage
    ).toBe('STAGE_A_AND_EXEC');
  });

  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'])(
    'aggregates mature medium exec results and keeps nonpositive candidates under %s',
    (modelProtocol) => {
      const fixture = records();
      addTerminalExec(fixture, 'tiny', '');
      for (let i = 0; i < 4; i++) addTerminalExec(fixture, `medium-${i}`, 'line '.repeat(700));
      for (let i = 0; i < 5; i++) successfulRollout(fixture.add, 6_000);
      const usage = { contextInputTokens: 6_000, cacheReadTokens: 0, outputTokens: 10 };
      expect(plan(fixture.values, usage, { modelProtocol })).toBeUndefined();
      successfulRollout(fixture.add, 6_000);
      const selected = plan(fixture.values, usage, { modelProtocol });
      expect(selected).toBeDefined();
      expect(selected!.draft.replacements.some((r) => r.callId === 'tiny')).toBe(false);
      expect(selected!.draft.replacements.filter((r) => r.kind === 'EXEC_OUTPUT')).toHaveLength(4);
      const before = buildContextProjection(fixture.values, '/workspace');
      const beforeRecords = structuredClone(fixture.values);
      const checkpoint = fixture.add('context.gc.completed', {
        ...selected!.draft,
        checkpointId: 'medium-exec',
        generation: 1
      });
      expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();
      const restored = buildContextProjection(structuredClone(fixture.values), '/workspace');
      expect(restored.checkpoint?.checkpointId).toBe('medium-exec');
      const tiny = before.entries.find(
        (e) => e.message.callId === 'tiny' && e.message.role === 'tool'
      );
      expect(
        restored.entries.find((e) => e.record.recordId === tiny?.record.recordId)?.message
      ).toEqual(tiny?.message);
      for (const entry of restored.entries.filter(
        (e) => e.message.role === 'tool' && e.message.callId?.startsWith('medium-')
      )) {
        expect(JSON.parse(entry.message.content)).toHaveProperty('exitCode', 1);
        expect(entry.message.content).not.toContain('line '.repeat(700));
      }
      expect(
        plan(beforeRecords, usage, {
          modelProtocol,
          activeProcessIds: new Set([
            'process-medium-0',
            'process-medium-1',
            'process-medium-2',
            'process-medium-3'
          ])
        })
      ).toBeUndefined();
    }
  );

  it('does not collect a medium terminal output that fails the aggregate gross gate', () => {
    const fixture = records();
    addTerminalExec(fixture, 'only-medium', 'line '.repeat(700));
    for (let i = 0; i < 6; i++) successfulRollout(fixture.add, 6_000);
    expect(plan(fixture.values, { contextInputTokens: 6_000, cacheReadTokens: 0 })).toBeUndefined();
  });

  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'])(
    'aggregates medium Web bodies without retiring tiny results or inputs under %s',
    (modelProtocol) => {
      const fixture = records();
      addWebResult(fixture, 'tiny-web', 'KEEP');
      for (let i = 0; i < 4; i++) addWebResult(fixture, `web-${i}`, 'evidence '.repeat(700));
      for (let i = 0; i < 5; i++) successfulRollout(fixture.add, 6_000);
      const usage = { contextInputTokens: 6_000, cacheReadTokens: 0 };
      expect(plan(fixture.values, usage, { modelProtocol })).toBeUndefined();
      successfulRollout(fixture.add, 6_000);
      const selected = plan(fixture.values, usage, { modelProtocol });
      expect(selected?.draft.replacements).toHaveLength(4);
      expect(selected!.draft.replacements.every((r) => r.kind === 'WEB_OUTPUT')).toBe(true);
      const original = buildContextProjection(fixture.values, '/workspace');
      const checkpoint = fixture.add('context.gc.completed', {
        ...selected!.draft,
        checkpointId: 'medium-web',
        generation: 1
      });
      expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();
      const restored = buildContextProjection(structuredClone(fixture.values), '/workspace');
      expect(restored.entries.filter((e) => e.message.role === 'tool_call')).toEqual(
        original.entries.filter((e) => e.message.role === 'tool_call')
      );
      expect(
        restored.entries.find((e) => e.message.role === 'tool' && e.message.callId === 'tiny-web')
          ?.message.content
      ).toBe('KEEP');
      const web = restored.entries.find(
        (e) => e.message.callId === 'web-0' && e.message.role === 'tool'
      );
      expect(JSON.parse(web!.message.content)).toHaveProperty('previewComplete', false);
    }
  );

  it('does not count nonpositive candidates toward protected scheduling capacity', () => {
    const fixture = records();
    for (let i = 0; i < 32; i++) {
      addTerminalExec(fixture, `tiny-${i}`, '');
      addWebResult(fixture, `tiny-web-${i}`, 'KEEP');
    }
    for (let i = 0; i < 5; i++) successfulRollout(fixture.add, 6_000);
    const projection = buildContextProjection(fixture.values, '/workspace');
    expect(
      inspectContextGc({
        records: fixture.values,
        messages: projection.entries.map((e) => e.message),
        messageSources: projection.entries.map((e) => e.record),
        system: 'System.',
        tools: [],
        modelId: 'coding',
        modelProtocol: 'OPENAI_RESPONSES',
        contextWindowTokens: 10_000,
        usage: { contextInputTokens: 6_000, cacheReadTokens: 0 },
        workspace: '/workspace',
        platform: 'linux',
        activeProcessIds: new Set()
      })
    ).toEqual({});
  });

  it('keeps dependent stale-read and patch replacements grouped when patch input expands', () => {
    const fixture = records();
    addPatchCandidate(fixture);
    for (let i = 0; i < 2; i++) successfulRollout(fixture.add, 6_000);
    const selected = plan(fixture.values, { contextInputTokens: 6_000, cacheReadTokens: 0 });
    const patch = selected?.draft.replacements.find((r) => r.kind === 'TOOL_CALL_INPUT');
    expect(patch).toBeDefined();
    const original = buildContextProjection(fixture.values, '/workspace');
    const messages = original.entries.map((e) => e.message);
    const sources = original.entries.map((e) => e.record);
    const patchOnly = applyContextGcReplacementsToMessages(messages, sources, [patch!]);
    const budget = {
      modelId: 'coding',
      modelProtocol: 'OPENAI_RESPONSES',
      system: 'System.',
      tools: []
    };
    expect(contextGcMessageTokens(budget, patchOnly.messages)).toBeGreaterThan(
      contextGcMessageTokens(budget, messages)
    );
    expect(selected?.draft.replacements.some((r) => r.kind === 'READ_OUTPUT_ITEMS')).toBe(true);
  });

  it('lets a later positive patch group claim read items rejected with an earlier nonpositive group', () => {
    const fixture = records();
    addPatchCandidate(fixture);
    const read = fixture.values.find(
      (r) =>
        r.type === 'model.context' &&
        (r.payload as ModelMessage).role === 'tool' &&
        (r.payload as ModelMessage).callId === 'read-source'
    )!;
    read.payload = {
      ...(read.payload as ModelMessage),
      content: (read.payload as ModelMessage).content.replace('alpha '.repeat(1_200), 'alpha')
    };
    modelContext(fixture.add, {
      role: 'tool_call',
      content: '',
      callId: 'later-patch',
      name: 'apply_patch',
      inputMode: 'freeform',
      arguments:
        '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-beta\n+' +
        'gamma '.repeat(2_000) +
        '\n*** End Patch'
    });
    const data = {
      files: [{ path: 'src/a.ts', operation: 'modified', addedLines: 1, deletedLines: 1 }],
      totals: { files: 1, addedLines: 1, deletedLines: 1 }
    };
    fixture.add('tool.completed', {
      type: 'tool.completed',
      toolName: 'apply_patch',
      callId: 'later-patch',
      data
    });
    const evidence = modelContext(fixture.add, {
      role: 'tool',
      callId: 'later-patch',
      content: JSON.stringify(data)
    });
    for (let i = 0; i < 2; i++) successfulRollout(fixture.add, 6_000);
    const selected = plan(fixture.values, { contextInputTokens: 6_000, cacheReadTokens: 0 });
    expect(selected).toBeDefined();
    expect(selected!.draft.replacements.some((r) => r.callId === 'patch-source')).toBe(false);
    const replacement = selected!.draft.replacements.find((r) => r.kind === 'READ_OUTPUT_ITEMS');
    expect(
      replacement?.kind === 'READ_OUTPUT_ITEMS' && replacement.items[0]?.evidenceSequence
    ).toBe(evidence.sequence);
    const checkpoint = fixture.add('context.gc.completed', {
      ...selected!.draft,
      checkpointId: 'later-positive-group',
      generation: 1
    });
    expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();
    expect(
      buildContextProjection(structuredClone(fixture.values), '/workspace').checkpoint?.checkpointId
    ).toBe('later-positive-group');
  });

  it('never accepts a zero-token reclaim even with a zero override and Compact credit', () => {
    expect(
      evaluateContextGcEconomics({
        contextUsageTokens: 8_800,
        reclaimedTokens: 0,
        reclaimedCachedTokens: 0,
        cacheReadTokens: 0,
        preservedCachedPrefixTokens: 0,
        compactDeferralCreditCostUnits: 7_040,
        projectedRolloutsUntilCompactAfterGc: 20,
        contextGrowthSampleCount: 16,
        minimumGrossReductionRate: 0,
        minimumReclaimedTokens: 0
      }).passes
    ).toBe(false);
  });

  it('uses discounted imminent Compact value only when GC restores a safe high-water margin', () => {
    const fixture = records();
    addPatchCandidate(fixture);
    for (let usage = 8_000; usage <= 8_800; usage += 100)
      successfulRollout(fixture.add, usage, 8_000);
    const usage: ModelUsage = {
      contextInputTokens: 8_800,
      cacheReadTokens: 8_000,
      outputTokens: 10
    };

    const beforePending = plan(fixture.values, usage);
    expect(beforePending).toBeUndefined();

    modelContext(fixture.add, {
      role: 'tool',
      callId: 'pending-output',
      content: 'pending '.repeat(500)
    });
    const selected = plan(fixture.values, usage);

    expect(selected?.metrics.grossReductionRate).toBeLessThan(0.2);
    expect(selected?.metrics.effectiveMinimumGrossReductionRate).toBeCloseTo(0.11);
    expect(selected?.metrics.minimumRequiredReclaimedTokens).toBe(968);
    expect(selected?.metrics.projectedTokensBeforeGc).toBeGreaterThanOrEqual(9_000);
    expect(selected?.metrics.projectedTokensAfterGc).toBeLessThanOrEqual(8_500);
    expect(selected?.metrics.imminentCompactAvoidanceCreditCostUnits).toBe(7_040);
    expect(selected?.metrics.appliedCompactCreditCostUnits).toBe(7_040);
    expect(selected?.metrics.requiredTargetRoiRollouts).toBeLessThanOrEqual(20);
  });

  it('rejects imminent Compact credit unless every high-water safety condition holds', () => {
    const base = {
      contextUsageTokens: 8_800,
      contextWindowTokens: 10_000,
      compactThresholdTokens: 9_000,
      projectedTokensBeforeGc: 9_100,
      projectedTokensAfterGc: 8_500,
      contextGrowthP75Tokens: 100
    };

    expect(contextGcImminentCompactAvoidanceCredit(base)).toBe(7_040);
    expect(
      contextGcImminentCompactAvoidanceCredit({
        ...base,
        contextGrowthP75Tokens: 0
      })
    ).toBe(0);
    expect(
      contextGcImminentCompactAvoidanceCredit({
        ...base,
        projectedTokensBeforeGc: 8_999
      })
    ).toBe(0);
    expect(
      contextGcImminentCompactAvoidanceCredit({
        ...base,
        projectedTokensAfterGc: 8_501
      })
    ).toBe(0);
    expect(
      contextGcImminentCompactAvoidanceCredit({
        ...base,
        contextUsageTokens: 9_000
      })
    ).toBe(0);
    expect(contextGcAppliedCompactCreditCostUnits(2_000, 7_040)).toBe(7_040);
    expect(contextGcAppliedCompactCreditCostUnits(8_000, 7_040)).toBe(8_000);
  });
});
