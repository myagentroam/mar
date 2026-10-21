import { formatReadContextItem } from '../../src/agent-core/tools/local/read-context.js';
import { describe, expect, it } from 'vitest';
import {
  renderObservations,
  type CodeObservation
} from '../../src/agent-core/tools/code-mode/observations.js';
import type { ModelMessage } from '../../src/agent-core/model/contracts.js';
import type { SessionRecord } from '../../src/agent-core/session/store/index.js';
import { retainedCodeInputs } from '../../src/agent-core/session/context-gc-observations.js';
import { formatExecResult, type ExecResult } from '../../src/agent-core/tools/local/exec.js';
import { planContextGc } from '../../src/agent-core/runtime/context/gc.js';
import {
  contextGcMessageTokens,
  contextGcReclaimedTokens
} from '../../src/agent-core/runtime/context/gc-tokens.js';
import {
  buildContextProjection,
  applyContextGcReplacementsToMessages
} from '../../src/agent-core/runtime/context/projection.js';
import {
  validateContextGcCheckpoint,
  parseContextGcCheckpoint
} from '../../src/agent-core/session/context-gc-checkpoint.js';
function records() {
  const values: SessionRecord[] = [];
  let sequence = 0;
  const add = (type: string, payload: unknown) => {
    const record: SessionRecord = {
      schemaVersion: 1,
      recordId: `record-${++sequence}`,
      sequence,
      timestamp: new Date().toISOString(),
      sessionId: 'session',
      executionId: 'execution',
      turnId: 'turn',
      type,
      payload
    };
    values.push(record);
    return record;
  };
  add('session.created', { title: 'observations', workspace: '/workspace' });
  add('execution.header', { modelId: 'coding', contextWindowTokens: 10000 });
  return { values, add };
}
function modelContext(add: ReturnType<typeof records>['add'], message: ModelMessage) {
  return add('model.context', message);
}
function successfulRollout(add: ReturnType<typeof records>['add']) {
  add('model.attempt', { purpose: 'EXECUTION', state: 'STARTED' });
  add('usage.updated', {
    type: 'usage.updated',
    inputTokens: 6000,
    contextInputTokens: 6000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  });
  add('model.attempt', { purpose: 'EXECUTION', state: 'SUCCEEDED' });
}
function requestProjection(values: readonly SessionRecord[]) {
  const projection = buildContextProjection(values, '/workspace');
  return {
    messages: projection.entries.flatMap((e) => (e.message ? [e.message] : [])),
    messageSources: projection.entries.flatMap((e) => (e.message ? [e.record] : []))
  };
}
function plan(values: readonly SessionRecord[], modelProtocol?: string) {
  return planContextGc({
    records: values,
    ...requestProjection(values),
    system: 'System.',
    tools: [],
    modelId: 'coding',
    ...(modelProtocol === undefined ? {} : { modelProtocol }),
    contextWindowTokens: 10000,
    usage: { inputTokens: 6000, contextInputTokens: 6000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    workspace: '/workspace',
    platform: 'linux',
    activeProcessIds: new Set()
  });
}
function readOutput(path: string, body: string, index = 0): string {
  return formatReadContextItem(
    index,
    {
      path,
      encoding: 'utf-8',
      newline: 'lf',
      startLine: 1,
      endLine: 2,
      eof: true,
      truncated: false
    },
    body
  );
}

describe('Code Mode observation GC parity', () => {
  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'])(
    'aggregates medium values in one cell while preserving short input, aliases and other observations under %s',
    (modelProtocol) => {
      const fixture = records();
      const code = 'observe.text(state.get("summary"));';
      if (modelProtocol === 'OPENAI_RESPONSES')
        modelContext(fixture.add, {
          role: 'provider',
          provider: 'OPENAI_RESPONSES',
          providerModelId: 'coding',
          content: '',
          item: {
            type: 'custom_tool_call',
            call_id: 'values-cell',
            id: 'values-alias',
            name: 'code_exec',
            input: code
          }
        });
      modelContext(fixture.add, {
        role: 'tool_call',
        callId: 'values-cell',
        name: 'code_exec',
        content: '',
        arguments: modelProtocol === 'OPENAI_RESPONSES' ? code : { code },
        ...(modelProtocol === 'OPENAI_RESPONSES' ? { inputMode: 'freeform' as const } : {})
      });
      fixture.add('tool.completed', {
        type: 'tool.completed',
        callId: 'values-cell',
        toolName: 'code_exec',
        truncated: false,
        data: { cellId: 'values-cell', status: 'completed' }
      });
      const observations: CodeObservation[] = [
        { type: 'value', id: 'keep', format: 'text', value: 'KEEP' },
        ...Array.from({ length: 4 }, (_, i): CodeObservation => ({
          type: 'value',
          id: `medium-${i}`,
          format: 'text',
          value: 'derived '.repeat(700)
        }))
      ];
      modelContext(fixture.add, {
        role: 'tool',
        callId: 'values-cell',
        name: 'code_exec',
        content: renderObservations(observations),
        observations,
        calls: []
      });
      for (let i = 0; i < 5; i++) successfulRollout(fixture.add);
      expect(plan(fixture.values, modelProtocol)).toBeUndefined();
      successfulRollout(fixture.add);
      const selected = plan(fixture.values, modelProtocol)!;
      expect(selected).toBeDefined();
      expect(selected.draft.replacements).toHaveLength(4);
      expect(selected.draft.replacements.every((r) => r.kind === 'CODE_MODE_OUTPUT')).toBe(true);
      const original = requestProjection(fixture.values);
      const applied = applyContextGcReplacementsToMessages(
        original.messages,
        original.messageSources,
        selected.draft.replacements
      );
      expect(
        contextGcReclaimedTokens(
          { modelId: 'coding', modelProtocol, system: 'System.', tools: [] },
          original.messages,
          applied.messages
        )
      ).toBe(selected.metrics.reclaimedTokens);
      const checkpoint = fixture.add('context.gc.completed', {
        ...selected.draft,
        checkpointId: 'medium-values',
        generation: 1
      });
      expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();
      const restored = requestProjection(structuredClone(fixture.values));
      expect(restored).toEqual(applied);
      expect(
        restored.messages.filter((m) => m.role === 'tool_call' || m.role === 'provider')
      ).toEqual(original.messages.filter((m) => m.role === 'tool_call' || m.role === 'provider'));
      const result = restored.messages.find((m) => m.role === 'tool' && m.callId === 'values-cell');
      expect(result?.observations?.[0]).toEqual(observations[0]);
      expect(result?.observations?.map((o) => o.id)).toEqual(observations.map((o) => o.id));
    }
  );

  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'])(
    'retires medium call code independently of tiny observations under %s',
    (modelProtocol) => {
      const fixture = records();
      for (let i = 0; i < 4; i++) {
        const id = `source-${i}`;
        const code = '/* ' + 'completed work '.repeat(140) + ' */';
        if (modelProtocol === 'OPENAI_RESPONSES')
          modelContext(fixture.add, {
            role: 'provider',
            provider: 'OPENAI_RESPONSES',
            providerModelId: 'coding',
            content: '',
            item: {
              type: 'custom_tool_call',
              call_id: id,
              id: `alias-${i}`,
              name: 'code_exec',
              input: code
            }
          });
        modelContext(fixture.add, {
          role: 'tool_call',
          callId: id,
          name: 'code_exec',
          content: '',
          arguments: modelProtocol === 'OPENAI_RESPONSES' ? code : { code },
          ...(modelProtocol === 'OPENAI_RESPONSES' ? { inputMode: 'freeform' as const } : {})
        });
        fixture.add('tool.completed', {
          type: 'tool.completed',
          callId: id,
          toolName: 'code_exec',
          truncated: false,
          data: { cellId: id, status: 'completed' }
        });
        const observations: CodeObservation[] = [
          { type: 'value', id: `keep-${i}`, format: 'text', value: `KEEP_${i}` }
        ];
        modelContext(fixture.add, {
          role: 'tool',
          name: 'code_exec',
          callId: id,
          content: renderObservations(observations),
          observations,
          calls: []
        });
      }
      for (let i = 0; i < 5; i++) successfulRollout(fixture.add);
      expect(plan(fixture.values, modelProtocol)).toBeUndefined();
      successfulRollout(fixture.add);
      const selected = plan(fixture.values, modelProtocol);
      expect(selected).toBeDefined();
      expect(selected!.draft.replacements).toHaveLength(4);
      expect(selected!.draft.replacements.every((r) => r.kind === 'TOOL_CALL_INPUT')).toBe(true);
      const original = requestProjection(fixture.values);
      const checkpoint = fixture.add('context.gc.completed', {
        ...selected!.draft,
        checkpointId: 'medium-source',
        generation: 1
      });
      expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();
      const restored = requestProjection(structuredClone(fixture.values));
      expect(restored.messages.filter((m) => m.role === 'tool')).toEqual(
        original.messages.filter((m) => m.role === 'tool')
      );
      const budget = { modelId: 'coding', modelProtocol, system: '', tools: [] };
      expect(contextGcReclaimedTokens(budget, original.messages, restored.messages)).toBe(
        selected!.metrics.reclaimedTokens
      );
      expect(restored.messages.some((m) => m.role === 'provider')).toBe(false);
      expect(contextGcMessageTokens(budget, restored.messages)).toBeLessThan(
        contextGcMessageTokens(budget, original.messages)
      );
    }
  );

  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'])(
    'keeps original call code when retained instructions expand its input under %s',
    (modelProtocol) => {
      const fixture = records();
      const code = 'observe.result(await tools.exec(state.get("arguments")));';
      const call = modelContext(fixture.add, {
        role: 'tool_call',
        name: 'code_exec',
        callId: 'cell',
        content: '',
        arguments: modelProtocol === 'OPENAI_RESPONSES' ? code : { code },
        ...(modelProtocol === 'OPENAI_RESPONSES' ? { inputMode: 'freeform' as const } : {})
      });
      if (modelProtocol === 'OPENAI_RESPONSES')
        modelContext(fixture.add, {
          role: 'provider',
          provider: 'OPENAI_RESPONSES',
          providerModelId: 'coding',
          content: '',
          item: {
            type: 'custom_tool_call',
            id: 'alias',
            call_id: 'cell',
            name: 'code_exec',
            input: code
          }
        });
      const input = { command: 'verify ' + 'required argument '.repeat(80) };
      fixture.add('tool.started', {
        type: 'tool.started',
        toolName: 'exec',
        callId: 'nested',
        parentCallId: 'cell',
        input
      });
      const data = {
        processId: 'done',
        status: 'completed',
        exitCode: 1,
        truncated: false,
        stdout: 'verification output '.repeat(1000),
        stderr: '',
        stdoutBytes: Buffer.byteLength('verification output '.repeat(1000)),
        stderrBytes: 0,
        stdoutDroppedBytes: 0,
        stderrDroppedBytes: 0
      };
      fixture.add('tool.completed', {
        type: 'tool.completed',
        toolName: 'exec',
        callId: 'nested',
        parentCallId: 'cell',
        data,
        truncated: false
      });
      fixture.add('tool.completed', {
        type: 'tool.completed',
        toolName: 'code_exec',
        callId: 'cell',
        truncated: false,
        data: { cellId: 'cell', status: 'completed' }
      });
      const observations: CodeObservation[] = [
        {
          type: 'tool_result',
          id: 'exec-body',
          outcome: 'completed',
          source: { callId: 'nested', toolName: 'exec', input },
          result: { content: formatExecResult(data as ExecResult).content }
        }
      ];
      modelContext(fixture.add, {
        role: 'tool',
        callId: 'cell',
        name: 'code_exec',
        observations,
        content: renderObservations(observations)
      });
      for (let i = 0; i < 6; i++) successfulRollout(fixture.add);
      const selected = plan(fixture.values, modelProtocol);
      expect(selected).toBeDefined();
      expect(
        selected!.draft.replacements.some(
          (r) => r.kind === 'TOOL_CALL_INPUT' && r.toolName === 'code_exec'
        )
      ).toBe(false);
      expect(selected!.draft.replacements.some((r) => r.kind === 'EXEC_OUTPUT')).toBe(true);
      const before = requestProjection(fixture.values);
      const applied = applyContextGcReplacementsToMessages(
        before.messages,
        before.messageSources,
        selected!.draft.replacements
      );
      expect(applied.messages.find((m) => m.role === 'tool_call' && m.callId === 'cell')).toEqual(
        call.payload
      );
      expect(applied.messages.filter((m) => m.role === 'provider')).toEqual(
        before.messages.filter((m) => m.role === 'provider')
      );
    }
  );

  it('preserves explicit model text on restore and aligns blocks after a whole-result replacement', () => {
    const f = records();
    const observations: CodeObservation[] = [
      { type: 'value', id: 'original', format: 'text', value: 'original observation' }
    ];
    modelContext(f.add, {
      role: 'tool_call',
      name: 'code_exec',
      callId: 'call',
      content: '',
      arguments: {}
    });
    const message: ModelMessage = {
      role: 'tool',
      callId: 'call',
      name: 'code_exec',
      content: 'edited observation',
      observations,
      textBlocks: [{ text: 'edited observation', cache: true }]
    };
    const row = modelContext(f.add, message);
    const projected = requestProjection(f.values);
    expect(projected.messages.at(-1)).toEqual(message);
    const gc = applyContextGcReplacementsToMessages(projected.messages, projected.messageSources, [
      {
        kind: 'CODE_MODE_OUTPUT',
        callId: 'call',
        evidenceSequence: row.sequence,
        replacementContent: 'compacted observation',
        target: {
          sequence: row.sequence,
          recordId: row.recordId,
          role: 'tool',
          callId: 'call',
          toolName: 'code_exec'
        }
      }
    ]);
    expect(gc.messages.at(-1)).toMatchObject({
      content: 'compacted observation',
      textBlocks: [{ text: 'compacted observation' }],
      observations
    });
    expect(
      applyContextGcReplacementsToMessages(projected.messages, projected.messageSources, [
        {
          kind: 'CODE_MODE_OUTPUT',
          callId: 'call',
          evidenceSequence: row.sequence,
          replacementContent: 'must not apply',
          target: {
            sequence: row.sequence,
            recordId: row.recordId,
            role: 'tool',
            callId: 'call',
            toolName: 'exec'
          }
        }
      ]).messages.at(-1)
    ).toEqual(message);
    expect(row.payload).toEqual(message);
  });

  it('protects an active cell even when its unobserved patch already completed', () => {
    const { fixture } = scenario(false);
    for (const record of fixture.values) {
      const payload = record.payload as { toolName?: string; data?: { status: string } };
      if (record.type === 'tool.completed' && payload.toolName === 'code_exec' && payload.data)
        payload.data.status = 'running';
    }
    for (let i = 0; i < 6; i++) successfulRollout(fixture.add);
    expect(plan(fixture.values)).toBeUndefined();
  });
  function scenario(observePatch = true, resultName?: string) {
    const fixture = records();
    modelContext(fixture.add, {
      role: 'tool_call',
      name: 'code_exec',
      callId: 'code',
      content: '',
      arguments: 'observe.result(await tools.read({reads:[]}));',
      inputMode: 'freeform'
    });
    const observations: CodeObservation[] = [];
    const nested = (name: string, id: string, input: unknown, content: string, data?: unknown) => {
      fixture.add('tool.started', {
        type: 'tool.started',
        toolName: name,
        callId: id,
        parentCallId: 'code',
        input
      });
      fixture.add('tool.completed', {
        type: 'tool.completed',
        toolName: name,
        callId: id,
        parentCallId: 'code',
        summary: 'done',
        truncated: false,
        ...(data ? { data } : {})
      });
      observations.push({
        type: 'tool_result',
        id: `obs-${id}`,
        source: { callId: id, toolName: name, input },
        outcome: 'completed',
        result: { content, truncated: false }
      });
    };
    nested(
      'read',
      'read',
      { reads: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] },
      readOutput('src/a.ts', '1\t' + 'old source '.repeat(7000), 0) +
        '\n' +
        readOutput('src/b.ts', '1\tKEEP_B', 1)
    );
    nested(
      'apply_patch',
      'patch',
      '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Update File: src/b.ts\n@@\n KEEP_B\n*** End Patch',
      'PATCH_SUCCESS',
      {
        files: [{ path: 'src/a.ts', operation: 'modified', addedLines: 1, deletedLines: 1 }],
        totals: { files: 1, addedLines: 1, deletedLines: 1 }
      }
    );
    observations.push({ type: 'value', id: 'value', format: 'text', value: 'FINAL_ANALYSIS_KEEP' });
    const patch = observations.find(
      (value) => value.type === 'tool_result' && value.source.toolName === 'apply_patch'
    )!;
    const calls =
      patch.type === 'tool_result'
        ? [{ ...patch.source, status: 'completed' as const, result: { content: '' } }]
        : [];
    if (!observePatch) observations.splice(observations.indexOf(patch), 1);
    fixture.add('tool.completed', {
      type: 'tool.completed',
      toolName: 'code_exec',
      callId: 'code',
      summary: 'done',
      truncated: false,
      data: { cellId: 'cell', status: 'completed' }
    });
    const result = modelContext(fixture.add, {
      role: 'tool',
      callId: 'code',
      ...(resultName === undefined ? {} : { name: resultName }),
      content: renderObservations(observations),
      observations,
      calls
    });
    return { fixture, result, observations };
  }
  it.each(['running', 'failed', 'cancelled'])(
    'rejects observation checkpoints for a %s cell, including later completion evidence',
    (status) => {
      const { fixture } = scenario(false);
      successfulRollout(fixture.add);
      successfulRollout(fixture.add);
      const planned = plan(fixture.values)!;
      expect(planned).toBeDefined();
      const completed = fixture.values.find(
        (record) =>
          record.type === 'tool.completed' &&
          (record.payload as { toolName: string }).toolName === 'code_exec'
      )!;
      (completed.payload as { data: { status: string } }).data.status = status;
      const checkpoint = fixture.add('context.gc.completed', {
        ...planned.draft,
        checkpointId: 'nonterminal-cell',
        generation: 1
      });
      expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeUndefined();
      fixture.add('code.cell.completed', { cellId: 'cell', status: 'completed' });
      expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeUndefined();
    }
  );
  it.each([
    undefined,
    {},
    { files: [{ path: 'src/a.ts' }], totals: { files: 1, addedLines: 1, deletedLines: 1 } }
  ])('retains patch inputs without valid durable file evidence: %j', (data) => {
    const { fixture } = scenario(false);
    const completed = fixture.values.find(
      (record) =>
        record.type === 'tool.completed' &&
        (record.payload as { toolName: string }).toolName === 'apply_patch'
    )!;
    (completed.payload as { data?: unknown }).data = data;
    expect(retainedCodeInputs(fixture.values, 'code')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callId: 'patch', toolName: 'apply_patch' })
      ])
    );
  });
  it('drops successful patch inputs only with validated file evidence', () => {
    const { fixture } = scenario(false);
    expect(retainedCodeInputs(fixture.values, 'code')).toEqual([
      expect.objectContaining({ callId: 'read', toolName: 'read' })
    ]);
    fixture.add('tool.failed', { callId: 'patch', toolName: 'apply_patch', parentCallId: 'code' });
    expect(retainedCodeInputs(fixture.values, 'code')).toEqual(
      expect.arrayContaining([expect.objectContaining({ callId: 'patch' })])
    );
  });
  it.each(
    ['cell', 'unrelated-cell'].flatMap((cellId) =>
      [undefined, 'code_exec_wait'].map((resultName) => ({ cellId, resultName }))
    )
  )(
    'matches retained observation evidence only to its own wait cell: $cellId, name=$resultName',
    ({ cellId, resultName }) => {
      const { fixture, result, observations } = scenario(false);
      const initial = fixture.values.find(
        (record) =>
          record.type === 'tool.completed' &&
          (record.payload as { toolName: string }).toolName === 'code_exec'
      )!;
      (initial.payload as { data: { status: string } }).data.status = 'running';
      const payload = result.payload as ModelMessage;
      const calls = payload.calls;
      payload.observations = [];
      payload.calls = [];
      payload.content = renderObservations([]);
      modelContext(fixture.add, {
        role: 'tool_call',
        name: 'code_exec_wait',
        callId: 'wait',
        content: '',
        arguments: { cellId }
      });
      fixture.add('tool.completed', {
        type: 'tool.completed',
        toolName: 'code_exec_wait',
        callId: 'wait',
        truncated: false,
        data: { cellId, status: 'completed' }
      });
      modelContext(fixture.add, {
        role: 'tool',
        callId: 'wait',
        ...(resultName === undefined ? {} : { name: resultName }),
        content: renderObservations(observations),
        observations,
        ...(calls === undefined ? {} : { calls })
      });
      successfulRollout(fixture.add);
      successfulRollout(fixture.add);
      const planned = plan(fixture.values);
      if (cellId !== 'cell') {
        expect(planned).toBeUndefined();
        return;
      }
      expect(planned?.draft.replacements.some((r) => r.kind === 'READ_OUTPUT_ITEMS')).toBe(true);
      const original = requestProjection(fixture.values);
      const projected = applyContextGcReplacementsToMessages(
        original.messages,
        original.messageSources,
        planned!.draft.replacements
      );
      const checkpoint = fixture.add('context.gc.completed', {
        ...planned!.draft,
        checkpointId: 'retained-observation',
        generation: 1
      });
      expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();
      expect(requestProjection(structuredClone(fixture.values))).toEqual(projected);
      const wait = projected.messages.find(
        (value) => value.role === 'tool' && value.callId === 'wait'
      );
      expect(wait).toMatchObject({ observations: expect.any(Array) });
      expect(wait?.name).toBe(resultName);
    }
  );
  it.each(
    [true, false].flatMap((observePatch) =>
      [undefined, 'code_exec'].flatMap((resultName) =>
        ['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'].map((modelProtocol) => ({
          observePatch,
          resultName,
          modelProtocol
        }))
      )
    )
  )(
    'reclaims and restores stale read items with observed patch=$observePatch, result name=$resultName and protocol=$modelProtocol',
    ({ observePatch, resultName, modelProtocol }) => {
      const { fixture, observations } = scenario(observePatch, resultName);
      successfulRollout(fixture.add);
      successfulRollout(fixture.add);
      const original = requestProjection(fixture.values);
      const planned = plan(fixture.values, modelProtocol);
      expect(planned).toBeDefined();
      const read = planned!.draft.replacements.find((value) => value.kind === 'READ_OUTPUT_ITEMS');
      expect(read?.target.observationId).toBe('obs-read');
      expect(read?.kind === 'READ_OUTPUT_ITEMS' && read.items.map((value) => value.path)).toEqual([
        'src/a.ts'
      ]);
      const projected = applyContextGcReplacementsToMessages(
        ...(() => {
          const projection = requestProjection(fixture.values);
          return [
            projection.messages,
            projection.messageSources,
            planned!.draft.replacements
          ] as const;
        })()
      );
      const result = projected.messages.find(
        (value) => value.callId === 'code' && value.role === 'tool'
      );
      expect(result?.content).toContain('KEEP_B');
      expect(result?.content.includes('PATCH_SUCCESS')).toBe(observePatch);
      expect(result?.content).toContain('FINAL_ANALYSIS_KEEP');
      expect(result?.observations?.map((value) => value.id)).toEqual(
        observations.map((value) => value.id)
      );
      expect(result?.content).not.toContain('old source old source');
      expect(result?.name).toBe(resultName);
      const budget = { modelId: 'coding', modelProtocol, system: 'System.', tools: [] };
      expect(contextGcMessageTokens(budget, projected.messages)).toBeLessThan(
        contextGcMessageTokens(budget, original.messages)
      );
      const checkpoint = fixture.add('context.gc.completed', {
        ...planned!.draft,
        checkpointId: 'observations-checkpoint',
        generation: 1
      });
      expect(parseContextGcCheckpoint(checkpoint)).toBeDefined();
      expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();
      const restored = requestProjection(structuredClone(fixture.values));
      expect(restored).toEqual(projected);
      expect(contextGcMessageTokens(budget, restored.messages)).toBe(
        contextGcMessageTokens(budget, projected.messages)
      );
      expect(observations[0]?.type === 'tool_result' && observations[0].result.content).toContain(
        'old source old source'
      );
    }
  );
  it.each(['toolName', 'observationId'] as const)(
    'rejects forged %s at commit and restores committed observations by identity',
    (field) => {
      const { fixture } = scenario(false, 'code_exec');
      successfulRollout(fixture.add);
      successfulRollout(fixture.add);
      const planned = plan(fixture.values)!;
      expect(planned).toBeDefined();
      const replacement = structuredClone(
        planned.draft.replacements.find((value) => value.kind === 'READ_OUTPUT_ITEMS')!
      );
      Object.assign(replacement, {
        target: {
          ...replacement.target,
          [field]: 'forged'
        }
      });
      const original = requestProjection(fixture.values);
      const applied = applyContextGcReplacementsToMessages(
        original.messages,
        original.messageSources,
        [replacement]
      );
      expect(applied).toEqual(original);
      const checkpoint = fixture.add('context.gc.completed', {
        ...planned.draft,
        replacements: [replacement],
        checkpointId: 'forged-observation',
        generation: 1
      });
      expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeUndefined();
      expect(requestProjection(structuredClone(fixture.values))).toEqual(applied);
    }
  );
  it('rejects forged tool provenance and does not reclaim original tools by blanket Code Mode output GC', () => {
    const { fixture, result, observations } = scenario();
    if (observations[0]?.type === 'tool_result') observations[0].source.callId = 'forged';
    if (result.payload && typeof result.payload === 'object')
      (result.payload as { content: string }).content = renderObservations(observations);
    for (let i = 0; i < 6; i++) successfulRollout(fixture.add);
    const planned = plan(fixture.values);
    expect(
      planned?.draft.replacements.some((value) => value.target.observationId === 'obs-read')
    ).not.toBe(true);
    expect(
      planned?.draft.replacements.some(
        (value) => value.kind === 'CODE_MODE_OUTPUT' && value.target.observationId === undefined
      )
    ).not.toBe(true);
  });
  it.each(
    ['exec', 'web_fetch', 'value'].flatMap((kind) =>
      [undefined, 'code_exec'].map((resultName) => ({ kind, resultName }))
    )
  )(
    'collects $kind records independently and validates recovery with result name=$resultName',
    ({ kind, resultName }) => {
      const fixture = records();
      modelContext(fixture.add, {
        role: 'tool_call',
        name: 'code_exec',
        callId: 'code',
        content: '',
        arguments: '// ' + 'large source '.repeat(6000),
        inputMode: 'freeform'
      });
      const input = kind === 'exec' ? { command: 'echo fixture' } : { url: 'https://example.test' };
      const data =
        kind === 'exec'
          ? {
              processId: 'process',
              status: 'completed',
              stdout: 'large stdout '.repeat(7000),
              stderr: '',
              exitCode: 0,
              truncated: false,
              stdoutBytes: 91000,
              stderrBytes: 0,
              stdoutDroppedBytes: 0,
              stderrDroppedBytes: 0
            }
          : undefined;
      fixture.add('tool.started', {
        type: 'tool.started',
        toolName: kind,
        callId: 'nested',
        parentCallId: 'code',
        input
      });
      fixture.add('tool.completed', {
        type: 'tool.completed',
        toolName: kind,
        callId: 'nested',
        parentCallId: 'code',
        summary: 'done',
        truncated: false,
        ...(data ? { data } : {})
      });
      const observation: CodeObservation =
        kind === 'value'
          ? { type: 'value', id: 'large', format: 'text', value: 'long analysis '.repeat(7000) }
          : {
              type: 'tool_result',
              id: 'large',
              source: { callId: 'nested', toolName: kind, input },
              outcome: 'completed',
              result: { content: data ? JSON.stringify(data) : 'long web response '.repeat(7000) }
            };
      fixture.add('tool.completed', {
        type: 'tool.completed',
        toolName: 'code_exec',
        callId: 'code',
        summary: 'done',
        truncated: false,
        data: { cellId: 'cell', status: 'completed' }
      });
      modelContext(fixture.add, {
        role: 'tool',
        callId: 'code',
        ...(resultName === undefined ? {} : { name: resultName }),
        content: renderObservations([observation]),
        observations: [observation]
      });
      for (let i = 0; i < 6; i++) successfulRollout(fixture.add);
      const planned = plan(fixture.values);
      expect(planned?.draft.replacements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind:
              kind === 'exec'
                ? 'EXEC_OUTPUT'
                : kind === 'value'
                  ? 'CODE_MODE_OUTPUT'
                  : 'WEB_OUTPUT',
            target: expect.objectContaining({ observationId: 'large' })
          })
        ])
      );
      const original = requestProjection(fixture.values);
      const projected = applyContextGcReplacementsToMessages(
        original.messages,
        original.messageSources,
        planned!.draft.replacements
      );
      expect(projected.messages).not.toEqual(original.messages);
      const checkpoint = fixture.add('context.gc.completed', {
        ...planned!.draft,
        checkpointId: 'recovered',
        generation: 1
      });
      expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();
      expect(requestProjection(structuredClone(fixture.values))).toEqual(projected);
    }
  );

  it.each(
    [true, false].flatMap((observedFinal) =>
      [undefined, 'code_exec'].map((resultName) => ({ observedFinal, resultName }))
    )
  )(
    'matches an exec terminal call with observed final=$observedFinal and result name=$resultName',
    ({ observedFinal, resultName }) => {
      const fixture = records();
      modelContext(fixture.add, {
        role: 'tool_call',
        name: 'code_exec',
        callId: 'code',
        content: '',
        arguments: 'fixture',
        inputMode: 'freeform'
      });
      const observations: CodeObservation[] = [];
      const calls = [];
      for (const [index, status] of ['running', 'completed'].entries()) {
        const input = index === 0 ? { command: 'fixture' } : { processId: 'proc' };
        const toolName = index === 0 ? 'exec' : 'exec_wait';
        const callId = 'call-' + index;
        const data = {
          processId: 'proc',
          status,
          stdout: index === 0 ? 'long process output '.repeat(5000) : 'done',
          stderr: '',
          exitCode: index === 0 ? null : 0,
          truncated: false,
          stdoutBytes: index === 0 ? 100000 : 4,
          stderrBytes: 0,
          stdoutDroppedBytes: 0,
          stderrDroppedBytes: 0
        };
        fixture.add('tool.started', {
          type: 'tool.started',
          toolName,
          callId,
          parentCallId: 'code',
          input
        });
        fixture.add('tool.completed', {
          type: 'tool.completed',
          toolName,
          callId,
          parentCallId: 'code',
          data,
          truncated: false
        });
        calls.push({
          callId,
          toolName,
          input,
          status: 'completed' as const,
          result: { content: '' }
        });
        if (index === 0 || observedFinal)
          observations.push({
            type: 'tool_result',
            id: callId,
            source: { callId, toolName, input },
            outcome: 'completed',
            result: { content: JSON.stringify(data) }
          });
      }
      fixture.add('tool.completed', {
        type: 'tool.completed',
        toolName: 'code_exec',
        callId: 'code',
        truncated: false,
        data: { cellId: 'cell', status: 'completed' }
      });
      modelContext(fixture.add, {
        role: 'tool',
        callId: 'code',
        ...(resultName === undefined ? {} : { name: resultName }),
        content: renderObservations(observations),
        observations,
        calls
      });
      for (let i = 0; i < 6; i++) successfulRollout(fixture.add);
      const planned = plan(fixture.values);
      expect(planned).toBeDefined();
      expect(
        planned!.draft.replacements.some(
          (r) => r.kind === 'EXEC_OUTPUT' && r.target.observationId === 'call-0'
        )
      ).toBe(true);
      const checkpoint = fixture.add('context.gc.completed', {
        ...planned!.draft,
        checkpointId: 'exec-lifecycle',
        generation: 1
      });
      expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();
    }
  );

  it.each(
    [true, false].flatMap((observedFinal) =>
      [undefined, 'code_exec'].map((resultName) => ({ observedFinal, resultName }))
    )
  )(
    'matches same-cell subagent snapshots with observed final=$observedFinal and result name=$resultName',
    ({ observedFinal, resultName }) => {
      const fixture = records();
      modelContext(fixture.add, {
        role: 'tool_call',
        name: 'code_exec',
        callId: 'code',
        content: '',
        arguments: 'fixture',
        inputMode: 'freeform'
      });
      const observations: CodeObservation[] = [];
      const calls = [];
      for (const [index, status] of ['running', 'completed'].entries()) {
        const callId = 'wait-' + index;
        const input = { agentId: 'child' };
        const text = index === 0 ? 'working progress '.repeat(5000) : 'Verified final result';
        const data = {
          agentId: 'child',
          description: 'Inspect implementation',
          status,
          latestMessage: {
            itemId: 'message-' + index,
            turnId: 'child-turn',
            phase: index === 0 ? 'commentary' : 'final_answer',
            text,
            timestamp: '2026-10-02T00:00:00Z',
            truncated: false
          },
          ...(index === 1 ? { summary: text } : {})
        };
        fixture.add('tool.started', {
          type: 'tool.started',
          toolName: 'agent_wait',
          callId,
          parentCallId: 'code',
          input
        });
        fixture.add('tool.completed', {
          type: 'tool.completed',
          toolName: 'agent_wait',
          callId,
          parentCallId: 'code',
          data,
          truncated: false
        });
        calls.push({
          callId,
          toolName: 'agent_wait',
          input,
          status: 'completed' as const,
          result: { content: '' }
        });
        if (index === 0 || observedFinal)
          observations.push({
            type: 'tool_result',
            id: callId,
            source: { callId, toolName: 'agent_wait', input },
            outcome: 'completed',
            result: { content: JSON.stringify(data) }
          });
      }
      fixture.add('tool.completed', {
        type: 'tool.completed',
        toolName: 'code_exec',
        callId: 'code',
        truncated: false,
        data: { cellId: 'cell', status: 'completed' }
      });
      modelContext(fixture.add, {
        role: 'tool',
        callId: 'code',
        ...(resultName === undefined ? {} : { name: resultName }),
        content: renderObservations(observations),
        observations,
        calls
      });
      successfulRollout(fixture.add);
      successfulRollout(fixture.add);
      const planned = plan(fixture.values);
      expect(planned).toBeDefined();
      expect(
        planned!.draft.replacements.some(
          (r) => r.kind === 'SUBAGENT_OUTPUT' && r.target.observationId === 'wait-0'
        )
      ).toBe(true);
      const checkpoint = fixture.add('context.gc.completed', {
        ...planned!.draft,
        checkpointId: 'subagent',
        generation: 1
      });
      expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();
    }
  );
});
