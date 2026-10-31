import { formatReadContextItem } from '../../src/prompts/read-context.js';
import { describe, expect, it } from 'vitest';
import {
  renderObservations,
  type CodeObservation
} from '../../src/session/code-observation-projection.js';
import type { ModelMessage } from '../../src/model/contracts.js';
import type { SessionRecord } from '../../src/session/store/index.js';
import {
  codeObservationEvidence,
  retainedCodeInputs
} from '../../src/session/context-gc-observations.js';
import { terminalExecLifecycles } from '../../src/session/context-gc-exec-lifecycle.js';
import { formatExecResult, type ExecResult } from '../../src/tools/local/exec.js';
import { planContextGc } from '../../src/runtime/context/gc.js';
import {
  contextGcMessageTokens,
  contextGcReclaimedTokens
} from '../../src/runtime/context/gc-tokens.js';
import {
  buildContextProjection,
  applyContextGcReplacementsToMessages
} from '../../src/runtime/context/projection.js';
import {
  validateContextGcCheckpoint,
  parseContextGcCheckpoint
} from '../../src/session/context-gc-checkpoint.js';
function records() {
  const values: SessionRecord[] = [];
  let sequence = 0;
  const add = (type: string, payload: unknown) => {
    const record: SessionRecord = {
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
  add('model.context', {
    role: 'provider',
    content: '',
    provider: 'OPENAI_RESPONSES',
    providerModelId: 'coding',
    item: {
      type: 'reasoning',
      id: 'complete-native-item',
      encrypted_content: 'opaque',
      summary: []
    }
  });
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
  const projection = buildContextProjection(values);
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
  it('only checks missing process results before the first terminal result', () => {
    const result = (status: 'running' | 'completed') => ({
      source: 'STRUCTURED' as const,
      status,
      processId: 'p',
      truncated: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutDroppedBytes: 0,
      stderrDroppedBytes: 0,
      stdout: '',
      stderr: ''
    });
    const start = {
      value: 'start',
      callId: 'start',
      toolName: 'exec',
      sequence: 1,
      input: { command: 'run' },
      result: result('running')
    };
    const done = {
      value: 'done',
      callId: 'done',
      toolName: 'exec_wait',
      sequence: 2,
      input: { processId: 'p' },
      result: result('completed')
    };
    const failed = {
      value: 'failed',
      callId: 'failed',
      toolName: 'exec_wait',
      sequence: 3,
      input: { processId: 'p' }
    };
    expect(
      terminalExecLifecycles([start, done, failed], new Set()).map((items) =>
        items.map((item) => item.value)
      )
    ).toEqual([['start', 'done']]);
    expect(
      terminalExecLifecycles(
        [start, { ...failed, sequence: 2 }, { ...done, sequence: 3 }],
        new Set()
      )
    ).toEqual([]);
  });
  it('uses a later code_exec_wait snapshot and exec_wait terminal to summarize the whole process lifecycle', () => {
    const f = records();
    const startInput = { command: 'echo ' + 'S'.repeat(5000) };
    const waitInput = { processId: 'process', data: 'W'.repeat(5000) };
    const execResult = (status: 'running' | 'completed') => ({
      status,
      processId: 'process',
      exitCode: status === 'completed' ? 1 : null,
      truncated: false,
      stdout: '',
      stderr: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutDroppedBytes: 0,
      stderrDroppedBytes: 0
    });
    const cell = modelContext(f.add, {
      role: 'tool_call',
      name: 'code_exec',
      callId: 'cell',
      content: '',
      arguments: { code: 'source '.repeat(9000) }
    });
    f.add('tool.started', {
      type: 'tool.started',
      toolName: 'exec',
      callId: 'start',
      parentCallId: 'cell',
      input: startInput
    });
    f.add('tool.completed', {
      type: 'tool.completed',
      toolName: 'exec',
      callId: 'start',
      parentCallId: 'cell',
      truncated: false,
      data: execResult('running')
    });
    f.add('tool.completed', {
      type: 'tool.completed',
      toolName: 'code_exec',
      callId: 'cell',
      truncated: false,
      data: { cellId: 'c1', status: 'running' }
    });
    const value: CodeObservation[] = [
      { type: 'value', id: 'v1', format: 'text', value: 'still running' }
    ];
    const startCall = {
      callId: 'start',
      toolName: 'exec',
      input: startInput,
      status: 'completed' as const,
      result: { content: '' }
    };
    modelContext(f.add, {
      role: 'tool',
      name: 'code_exec',
      callId: 'cell',
      content: renderObservations(value),
      observations: value,
      calls: [startCall]
    });
    modelContext(f.add, {
      role: 'tool_call',
      name: 'code_exec_wait',
      callId: 'cell-wait',
      arguments: { cellId: 'c1' },
      content: ''
    });
    f.add('tool.started', {
      type: 'tool.started',
      toolName: 'exec_wait',
      callId: 'wait',
      parentCallId: 'cell',
      input: waitInput
    });
    f.add('tool.completed', {
      type: 'tool.completed',
      toolName: 'exec_wait',
      callId: 'wait',
      parentCallId: 'cell',
      truncated: false,
      data: execResult('completed')
    });
    f.add('code.cell.completed', { cellId: 'c1', status: 'completed' });
    f.add('tool.completed', {
      type: 'tool.completed',
      toolName: 'code_exec_wait',
      callId: 'cell-wait',
      truncated: false,
      data: { cellId: 'c1', status: 'completed' }
    });
    const later: CodeObservation[] = [
      { type: 'value', id: 'v2', format: 'text', value: 'finished' }
    ];
    modelContext(f.add, {
      role: 'tool',
      name: 'code_exec_wait',
      callId: 'cell-wait',
      content: renderObservations(later),
      observations: later,
      calls: [
        startCall,
        {
          callId: 'wait',
          toolName: 'exec_wait',
          input: waitInput,
          status: 'completed',
          result: { content: '' }
        }
      ]
    });
    for (let i = 0; i < 6; i++) successfulRollout(f.add);
    const selected = plan(f.values);
    const replacement = selected?.draft.replacements.find(
      (item) => item.kind === 'TOOL_CALL_INPUT' && item.target.sequence === cell.sequence
    );
    expect(replacement?.kind).toBe('TOOL_CALL_INPUT');
    const rendered = JSON.stringify(replacement);
    expect(rendered.match(/terminal_exec_input/g)).toHaveLength(2);
    expect(rendered.includes(startInput.command)).toBe(false);
    expect(rendered.includes(waitInput.data)).toBe(false);
    expect(
      validateContextGcCheckpoint(
        f.values,
        f.add('context.gc.completed', {
          ...selected!.draft,
          checkpointId: 'exec-chain',
          generation: 1
        })
      )
    ).toBeDefined();
  });
  it.each(['terminal', 'running', 'active', 'failed'] as const)(
    'summarizes nested exec inputs only for an eligible process lifecycle: %s',
    (state) => {
      const f = records();
      const command = `echo ${'Z'.repeat(5000)}`;
      const input = { command };
      const result = {
        status: state === 'running' ? 'running' : 'completed',
        processId: 'process',
        exitCode: 2,
        truncated: false,
        stdout: 'result',
        stderr: '',
        stdoutBytes: 6,
        stderrBytes: 0,
        stdoutDroppedBytes: 0,
        stderrDroppedBytes: 0
      };
      const cell = modelContext(f.add, {
        role: 'tool_call',
        name: 'code_exec',
        callId: 'cell-exec',
        content: '',
        arguments: { code: 'cell-source '.repeat(5000) }
      });
      f.add('tool.started', {
        type: 'tool.started',
        toolName: 'exec',
        callId: 'inner-exec',
        parentCallId: 'cell-exec',
        input
      });
      if (state === 'failed')
        f.add('tool.failed', {
          type: 'tool.failed',
          toolName: 'exec',
          callId: 'inner-exec',
          parentCallId: 'cell-exec',
          code: 'TEST_ERROR'
        });
      else
        f.add('tool.completed', {
          type: 'tool.completed',
          toolName: 'exec',
          callId: 'inner-exec',
          parentCallId: 'cell-exec',
          truncated: false,
          data: result
        });
      f.add('tool.completed', {
        type: 'tool.completed',
        toolName: 'code_exec',
        callId: 'cell-exec',
        truncated: false,
        data: { cellId: 'cell-exec', status: 'completed' }
      });
      const observations: CodeObservation[] = [
        { type: 'value', id: 'v', format: 'text', value: 'ok' }
      ];
      modelContext(f.add, {
        role: 'tool',
        name: 'code_exec',
        callId: 'cell-exec',
        content: renderObservations(observations),
        observations,
        calls: [
          {
            callId: 'inner-exec',
            toolName: 'exec',
            input,
            status: state === 'failed' ? 'failed' : 'completed',
            result: { content: '' }
          }
        ]
      });
      for (let i = 0; i < 6; i++) successfulRollout(f.add);
      const selected = planContextGc({
        records: f.values,
        ...requestProjection(f.values),
        system: 'System.',
        tools: [],
        modelId: 'coding',
        contextWindowTokens: 10000,
        usage: {
          inputTokens: 6000,
          contextInputTokens: 6000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0
        },
        workspace: '/workspace',
        platform: 'linux',
        activeProcessIds: state === 'active' ? new Set(['process']) : new Set()
      });
      const replacement = selected?.draft.replacements.find(
        (item) => item.kind === 'TOOL_CALL_INPUT' && item.target.sequence === cell.sequence
      );
      expect(replacement?.kind).toBe('TOOL_CALL_INPUT');
      const summary = JSON.stringify(replacement);
      expect(summary.includes('terminal_exec_input')).toBe(state === 'terminal');
      expect(summary.includes(command)).toBe(state !== 'terminal');
      expect(
        validateContextGcCheckpoint(
          f.values,
          f.add('context.gc.completed', {
            ...selected!.draft,
            checkpointId: `exec-${state}`,
            generation: 1
          })
        )
      ).toBeDefined();
    }
  );
  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'])(
    'deduplicates visible tool-search definitions by name under %s',
    (protocol) => {
      const f = records();
      const definition = (name: string, version: string) => ({
        name,
        description: `${version} `.repeat(2000),
        inputSchema: { type: 'object', properties: {} }
      });
      const search = (callId: string, tools: ReturnType<typeof definition>[]) => {
        if (protocol === 'OPENAI_RESPONSES')
          modelContext(f.add, {
            role: 'provider',
            provider: 'OPENAI_RESPONSES',
            providerModelId: 'coding',
            content: '',
            item: {
              type: 'tool_search_call',
              id: `item-${callId}`,
              call_id: callId,
              status: 'completed',
              execution: 'client',
              arguments: { query: 'test' }
            }
          });
        modelContext(f.add, {
          role: 'tool_call',
          callId,
          name: 'tool_search',
          content: '',
          arguments: { query: 'test' }
        });
        f.add('tool.completed', {
          type: 'tool.completed',
          toolName: 'tool_search',
          callId,
          truncated: false
        });
        return modelContext(f.add, {
          role: 'tool',
          callId,
          name: 'tool_search',
          content: JSON.stringify({ tools: tools.map((tool) => tool.name) }),
          toolSearchTools: tools
        });
      };
      const old = search('search-old', [definition('A', 'OLD_A'), definition('B', 'OLD_B')]);
      search('search-new', [definition('A', 'NEW_A'), definition('C', 'NEW_C')]);
      for (let i = 0; i < 6; i++) {
        f.add('model.attempt', { purpose: 'EXECUTION', state: 'STARTED' });
        f.add('model.context', {
          role: 'provider',
          content: '',
          provider: 'OPENAI_RESPONSES',
          providerModelId: 'coding',
          item: { type: 'reasoning', id: `search-${i}`, encrypted_content: 'opaque', summary: [] }
        });
        f.add('usage.updated', {
          type: 'usage.updated',
          inputTokens: 6000,
          contextInputTokens: 6000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0
        });
        f.add('model.attempt', { purpose: 'EXECUTION', state: 'SUCCEEDED' });
      }
      const selected = plan(f.values, protocol);
      const replacement = selected?.draft.replacements.find(
        (item) => item.kind === 'TOOL_OUTPUT' && item.target.sequence === old.sequence
      );
      if (protocol === 'ANTHROPIC_MESSAGES') {
        expect(replacement).toBeUndefined();
        return;
      }
      expect(replacement).toMatchObject({ toolName: 'tool_search', retainedToolNames: ['B'] });
      const applied = applyContextGcReplacementsToMessages(
        requestProjection(f.values).messages,
        requestProjection(f.values).messageSources,
        selected!.draft.replacements
      );
      expect(
        applied.messages
          .find((message) => message.callId === 'search-old' && message.role === 'tool')
          ?.toolSearchTools?.map((tool) => tool.name)
      ).toEqual(['B']);
      expect(
        validateContextGcCheckpoint(
          f.values,
          f.add('context.gc.completed', {
            ...selected!.draft,
            checkpointId: 'search',
            generation: 1
          })
        )
      ).toBeDefined();
    }
  );
  it('summarizes a superseded Todo input only when creating the whole-cell replacement', () => {
    const f = records();
    const items = Array.from({ length: 30 }, (_, i) => ({
      id: `old-${i}`,
      step: 'OLD_TASK '.repeat(70),
      status: 'pending'
    }));
    const input = { items };
    const cell = modelContext(f.add, {
      role: 'tool_call',
      callId: 'cell-todo',
      name: 'code_exec',
      content: '',
      arguments: { code: 'task '.repeat(5000) }
    });
    f.add('tool.started', {
      type: 'tool.started',
      toolName: 'todo_write',
      callId: 'old-write',
      parentCallId: 'cell-todo',
      input
    });
    f.add('tool.completed', {
      type: 'tool.completed',
      toolName: 'todo_write',
      callId: 'old-write',
      parentCallId: 'cell-todo',
      truncated: false,
      data: { revision: 1, items }
    });
    f.add('tool.completed', {
      type: 'tool.completed',
      toolName: 'code_exec',
      callId: 'cell-todo',
      truncated: false,
      data: { cellId: 'cell-todo', status: 'completed' }
    });
    const observations: CodeObservation[] = [
      {
        type: 'tool_result',
        id: 'todo-result',
        outcome: 'completed',
        source: { callId: 'old-write', toolName: 'todo_write', input },
        result: { content: '{"revision":1,"count":30}' }
      }
    ];
    modelContext(f.add, {
      role: 'tool',
      callId: 'cell-todo',
      name: 'code_exec',
      observations,
      content: renderObservations(observations),
      calls: [
        {
          callId: 'old-write',
          toolName: 'todo_write',
          input,
          status: 'completed',
          result: { content: '{"revision":1,"count":30}' }
        }
      ]
    });
    f.add('tool.completed', {
      type: 'tool.completed',
      toolName: 'todo_write',
      callId: 'unseen',
      truncated: false,
      data: { revision: 2, items: [] }
    });
    for (let i = 0; i < 6; i++) {
      f.add('model.attempt', { purpose: 'EXECUTION', state: 'STARTED' });
      f.add('model.context', {
        role: 'provider',
        content: '',
        provider: 'OPENAI_RESPONSES',
        providerModelId: 'coding',
        item: { type: 'reasoning', id: `cell-todo-${i}`, encrypted_content: 'opaque', summary: [] }
      });
      f.add('usage.updated', {
        type: 'usage.updated',
        inputTokens: 6000,
        contextInputTokens: 6000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      });
      f.add('model.attempt', { purpose: 'EXECUTION', state: 'SUCCEEDED' });
    }
    const selected = plan(f.values);
    const replacement = selected?.draft.replacements.find(
      (item) => item.kind === 'TOOL_CALL_INPUT' && item.target.sequence === cell.sequence
    );
    expect(replacement).toBeDefined();
    expect(JSON.stringify(replacement)).toContain('supersededByRevision');
    expect(JSON.stringify(replacement)).not.toContain('OLD_TASK');
    expect(
      validateContextGcCheckpoint(
        f.values,
        f.add('context.gc.completed', {
          ...selected!.draft,
          checkpointId: 'cell-todo',
          generation: 1
        })
      )
    ).toBeDefined();
  });
  it('uses successful Todo revisions to retire old input and snapshot without exposing unseen items', () => {
    const f = records();
    const firstItems = [{ id: 'old', step: 'OLD_TODO '.repeat(2000), status: 'pending' }];
    const laterItems = [{ id: 'next', step: 'UNOBSERVED_NEW_TODO', status: 'pending' }];
    const writeCall = modelContext(f.add, {
      role: 'tool_call',
      callId: 'w1',
      name: 'todo_write',
      content: '',
      arguments: { items: firstItems }
    });
    f.add('tool.completed', {
      type: 'tool.completed',
      toolName: 'todo_write',
      callId: 'w1',
      truncated: false,
      data: { revision: 1, items: firstItems }
    });
    modelContext(f.add, {
      role: 'tool',
      name: 'todo_write',
      callId: 'w1',
      content: JSON.stringify({ revision: 1, count: 1 })
    });
    modelContext(f.add, {
      role: 'tool_call',
      callId: 'r1',
      name: 'todo_read',
      content: '',
      arguments: {}
    });
    f.add('tool.completed', {
      type: 'tool.completed',
      toolName: 'todo_read',
      callId: 'r1',
      truncated: false,
      data: { revision: 1, items: firstItems }
    });
    const oldRead = modelContext(f.add, {
      role: 'tool',
      name: 'todo_read',
      callId: 'r1',
      content: JSON.stringify({ revision: 1, items: firstItems })
    });
    const latestCall = modelContext(f.add, {
      role: 'tool_call',
      callId: 'w2',
      name: 'todo_write',
      content: '',
      arguments: { items: laterItems }
    });
    f.add('tool.completed', {
      type: 'tool.completed',
      toolName: 'todo_write',
      callId: 'w2',
      truncated: false,
      data: { revision: 2, items: laterItems }
    });
    for (let i = 0; i < 6; i++) {
      f.add('model.attempt', { purpose: 'EXECUTION', state: 'STARTED' });
      f.add('model.context', {
        role: 'provider',
        content: '',
        provider: 'OPENAI_RESPONSES',
        providerModelId: 'coding',
        item: { type: 'reasoning', id: `todo-${i}`, encrypted_content: 'opaque', summary: [] }
      });
      f.add('usage.updated', {
        type: 'usage.updated',
        inputTokens: 6000,
        contextInputTokens: 6000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      });
      f.add('model.attempt', { purpose: 'EXECUTION', state: 'SUCCEEDED' });
    }
    const selected = plan(f.values);
    expect(selected).toBeDefined();
    expect(selected!.draft.replacements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'TOOL_CALL_INPUT',
          toolName: 'todo_write',
          target: expect.objectContaining({ sequence: writeCall.sequence })
        }),
        expect.objectContaining({
          kind: 'TOOL_OUTPUT',
          toolName: 'todo_read',
          target: expect.objectContaining({ sequence: oldRead.sequence })
        })
      ])
    );
    expect(
      selected!.draft.replacements.some(
        (replacement) => replacement.target.sequence === latestCall.sequence
      )
    ).toBe(false);
    expect(JSON.stringify(selected!.draft.replacements)).not.toContain('UNOBSERVED_NEW_TODO');
    expect(
      validateContextGcCheckpoint(
        f.values,
        f.add('context.gc.completed', { ...selected!.draft, checkpointId: 'todo', generation: 1 })
      )
    ).toBeDefined();
  });
  it('reclaims a read item only after a later visible read fully covers its range', () => {
    const f = records();
    const read = (id: string, startLine: number, endLine: number, previewComplete: boolean) => {
      modelContext(f.add, {
        role: 'tool_call',
        callId: id,
        name: 'read',
        content: '',
        arguments: { reads: [{ path: 'src/a.ts' }] }
      });
      f.add('tool.completed', {
        type: 'tool.completed',
        toolName: 'read',
        callId: id,
        truncated: false
      });
      return modelContext(f.add, {
        role: 'tool',
        callId: id,
        name: 'read',
        content: formatReadContextItem(
          0,
          {
            path: 'src/a.ts',
            encoding: 'utf-8',
            newline: 'lf',
            startLine,
            endLine,
            eof: false,
            truncated: false,
            previewComplete
          },
          'line '.repeat(5000)
        )
      });
    };
    const old = read('old', 5, 10, true);
    read('partial', 5, 9, true);
    read('incomplete', 1, 20, false);
    const successor = read('successor', 1, 20, true);
    for (let i = 0; i < 6; i++) {
      f.add('model.attempt', { purpose: 'EXECUTION', state: 'STARTED' });
      f.add('model.context', {
        role: 'provider',
        content: '',
        provider: 'OPENAI_RESPONSES',
        providerModelId: 'coding',
        item: { type: 'reasoning', id: `r-${i}`, encrypted_content: 'opaque', summary: [] }
      });
      f.add('usage.updated', {
        type: 'usage.updated',
        inputTokens: 6000,
        contextInputTokens: 6000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      });
      f.add('model.attempt', { purpose: 'EXECUTION', state: 'SUCCEEDED' });
    }
    const selected = plan(f.values);
    expect(selected).toBeDefined();
    const replacement = selected!.draft.replacements.find(
      (item) => item.kind === 'READ_OUTPUT_ITEMS' && item.target.sequence === old.sequence
    );
    expect(replacement).toMatchObject({
      items: [{ supersededByCallId: 'successor', evidenceSequence: successor.sequence }]
    });
    expect(
      validateContextGcCheckpoint(
        f.values,
        f.add('context.gc.completed', {
          ...selected!.draft,
          checkpointId: 'read-cover',
          generation: 1
        })
      )
    ).toBeDefined();
  });
  it('only replaces an older Skill after a same-name complete successor is visible and mature', () => {
    const f = records();
    const skill = (id: string, name: string, content: string) => {
      modelContext(f.add, {
        role: 'tool_call',
        callId: id,
        name: 'skill',
        content: '',
        arguments: { name }
      });
      f.add('tool.completed', {
        type: 'tool.completed',
        toolName: 'skill',
        callId: id,
        truncated: false
      });
      return modelContext(f.add, { role: 'tool', callId: id, name: 'skill', content });
    };
    const old = skill('skill-old', 'guide', 'OLD_INSTRUCTION '.repeat(1200));
    const current = skill('skill-current', 'guide', 'CURRENT_INSTRUCTION '.repeat(1200));
    skill('other', 'another', 'OTHER_INSTRUCTION '.repeat(1200));
    for (let i = 0; i < 6; i++) {
      f.add('model.attempt', { purpose: 'EXECUTION', state: 'STARTED' });
      f.add('model.context', {
        role: 'provider',
        content: '',
        provider: 'OPENAI_RESPONSES',
        providerModelId: 'coding',
        item: { type: 'reasoning', id: `thinking-${i}`, encrypted_content: 'opaque', summary: [] }
      });
      f.add('usage.updated', {
        type: 'usage.updated',
        inputTokens: 6000,
        contextInputTokens: 6000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      });
      f.add('model.attempt', { purpose: 'EXECUTION', state: 'SUCCEEDED' });
    }
    const selected = plan(f.values);
    expect(selected).toBeDefined();
    expect(selected!.draft.replacements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'TOOL_OUTPUT',
          target: expect.objectContaining({ sequence: old.sequence })
        })
      ])
    );
    expect(
      selected!.draft.replacements.some(
        (replacement) => replacement.target.sequence === current.sequence
      )
    ).toBe(false);
    const checkpoint = f.add('context.gc.completed', {
      ...selected!.draft,
      checkpointId: 'skill',
      generation: 1
    });
    expect(validateContextGcCheckpoint(f.values, checkpoint)).toBeDefined();
  });
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
      expect(
        restored.messages.some((m) => m.role === 'provider' && m.item.type === 'custom_tool_call')
      ).toBe(false);
      expect(restored.messages.filter((m) => m.role === 'provider')).toEqual(
        original.messages.filter((m) => m.role === 'provider' && m.item.type === 'reasoning')
      );
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

  it('reclaims an observed nested read even while its parent cell remains active', () => {
    const { fixture } = scenario(false);
    for (const record of fixture.values) {
      const payload = record.payload as { toolName?: string; data?: { status: string } };
      if (record.type === 'tool.completed' && payload.toolName === 'code_exec' && payload.data)
        payload.data.status = 'running';
    }
    for (let i = 0; i < 6; i++) successfulRollout(fixture.add);
    const selected = plan(fixture.values);
    expect(
      selected?.draft.replacements.some((replacement) => replacement.kind === 'READ_OUTPUT_ITEMS')
    ).toBe(true);
    expect(
      selected?.draft.replacements.some(
        (replacement) =>
          replacement.kind === 'TOOL_CALL_INPUT' && replacement.toolName === 'code_exec'
      )
    ).toBe(false);
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
    'associates a completed nested observation with different event input while the cell is %s',
    (status) => {
      const { fixture, result, observations } = scenario();
      const started = fixture.values.find(
        (record) =>
          record.type === 'tool.started' &&
          (record.payload as { callId?: string }).callId === 'read'
      )!;
      (started.payload as { input: unknown }).input = {};
      const outer = fixture.values.find(
        (record) =>
          record.type === 'tool.completed' &&
          (record.payload as { toolName?: string }).toolName === 'code_exec'
      )!;
      (outer.payload as { data: { status: string } }).data.status = status;
      const observation = observations[0];
      if (observation.type !== 'tool_result') throw new Error('Expected tool observation');
      expect(codeObservationEvidence(fixture.values, result, observation)?.callId).toBe('read');
    }
  );
  it('associates a successful observation when the outer tool emitted a failure', () => {
    const { fixture, result, observations } = scenario();
    const outer = fixture.values.find(
      (record) =>
        record.type === 'tool.completed' &&
        (record.payload as { toolName?: string }).toolName === 'code_exec'
    )!;
    (outer as { type: string }).type = 'tool.failed';
    (outer.payload as { type: string }).type = 'tool.failed';
    const observation = observations[0];
    if (observation.type !== 'tool_result') throw new Error('Expected tool observation');
    expect(codeObservationEvidence(fixture.values, result, observation)?.callId).toBe('read');
    const nested = fixture.values.find(
      (record) =>
        record.type === 'tool.completed' &&
        (record.payload as { callId?: string }).callId === 'read'
    )!;
    (nested as { type: string }).type = 'tool.failed';
    (nested.payload as { type: string }).type = 'tool.failed';
    expect(codeObservationEvidence(fixture.values, result, observation)).toBeUndefined();
  });
  it('retains nested inputs from the matching cell call snapshot rather than the event projection', () => {
    const { fixture, result } = scenario(false);
    const read = fixture.values.find(
      (record) =>
        record.type === 'tool.started' && (record.payload as { callId?: string }).callId === 'read'
    )!;
    (read.payload as { input: unknown }).input = {};
    (result.payload as { calls: unknown[] }).calls.push({
      callId: 'read',
      toolName: 'read',
      status: 'completed',
      input: { reads: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] },
      result: { content: 'PRIVATE_RESULT' }
    });
    expect(retainedCodeInputs(fixture.values, 'code')).toContainEqual({
      callId: 'read',
      toolName: 'read',
      input: { reads: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] }
    });
    expect(JSON.stringify(retainedCodeInputs(fixture.values, 'code'))).not.toContain(
      'PRIVATE_RESULT'
    );
  });
  it('associates retained wait snapshots with the correct cell, not a later unrelated cell', () => {
    const fixture = records();
    fixture.add('tool.started', {
      toolName: 'read',
      callId: 'nested',
      parentCallId: 'parent',
      input: { path: 'fallback' }
    });
    fixture.add('tool.completed', {
      toolName: 'code_exec',
      callId: 'parent',
      data: { cellId: 'cell' }
    });
    for (const [id, cellId, path] of [
      ['wait-a', 'cell', 'correct'],
      ['wait-b', 'other', 'incorrect']
    ]) {
      fixture.add('tool.completed', {
        toolName: 'code_exec_wait',
        callId: id,
        data: { cellId }
      });
      fixture.add('model.context', {
        role: 'tool',
        callId: id,
        content: '',
        calls: [{ callId: 'nested', toolName: 'read', status: 'completed', input: { path } }]
      });
    }
    expect(retainedCodeInputs(fixture.values, 'parent')).toEqual([
      { callId: 'nested', toolName: 'read', input: { path: 'correct' } }
    ]);
  });
  it('uses a later direct wait for a nested process without treating another process as terminal', () => {
    const fixture = records();
    const command = 'nested '.repeat(1000);
    modelContext(fixture.add, {
      role: 'tool_call',
      name: 'code_exec',
      callId: 'parent',
      content: '',
      arguments: { code: '' }
    });
    fixture.add('tool.started', {
      toolName: 'exec',
      callId: 'nested',
      parentCallId: 'parent',
      input: { command }
    });
    fixture.add('tool.completed', {
      type: 'tool.completed',
      toolName: 'exec',
      callId: 'nested',
      parentCallId: 'parent',
      data: { status: 'running', processId: 'nested-process', stdout: '', stderr: '' }
    });
    fixture.add('tool.completed', {
      toolName: 'code_exec',
      callId: 'parent',
      data: { cellId: 'cell', status: 'running' }
    });
    modelContext(fixture.add, {
      role: 'tool',
      callId: 'parent',
      content: '',
      calls: [{ callId: 'nested', toolName: 'exec', status: 'completed', input: { command } }]
    });
    const wait = (callId: string, processId: string) => {
      modelContext(fixture.add, {
        role: 'tool_call',
        name: 'exec_wait',
        callId,
        content: '',
        arguments: { processId }
      });
      fixture.add('tool.completed', {
        type: 'tool.completed',
        toolName: 'exec_wait',
        callId,
        truncated: false
      });
      modelContext(fixture.add, {
        role: 'tool',
        name: 'exec_wait',
        callId,
        content: JSON.stringify({ status: 'completed', processId, stdout: '', stderr: '' })
      });
    };
    const selected = (activeProcessIds: ReadonlySet<string> = new Set()) =>
      retainedCodeInputs(fixture.values, 'parent', undefined, {
        activeProcessIds,
        evidenceMature: () => true
      });
    wait('other-wait', 'other-process');
    expect(JSON.stringify(selected())).toContain(command);
    wait('right-wait', 'nested-process');
    expect(JSON.stringify(selected())).not.toContain(command);
    modelContext(fixture.add, {
      role: 'tool_call',
      name: 'exec_wait',
      callId: 'cached-failed',
      content: '',
      arguments: { processId: 'nested-process' }
    });
    fixture.add('tool.failed', {
      type: 'tool.failed',
      toolName: 'exec_wait',
      callId: 'cached-failed'
    });
    modelContext(fixture.add, { role: 'tool', callId: 'cached-failed', content: 'poll failed' });
    expect(JSON.stringify(selected())).not.toContain(command);
    expect(JSON.stringify(selected(new Set(['nested-process'])))).toContain(command);
  });
  it.each([false, true])(
    'scans unrelated lifecycle records linearly with real nested exec=%s',
    (withNestedExec) => {
      const accesses = [100, 200, 400].map((count) => {
        const fixture = records();
        if (withNestedExec) {
          modelContext(fixture.add, {
            role: 'tool_call',
            name: 'code_exec',
            callId: 'parent',
            content: '',
            arguments: { code: 'exec' }
          });
          fixture.add('tool.started', {
            toolName: 'exec',
            callId: 'nested-exec',
            parentCallId: 'parent',
            input: { command: 'x'.repeat(5000) }
          });
          fixture.add('tool.completed', {
            type: 'tool.completed',
            toolName: 'exec',
            callId: 'nested-exec',
            parentCallId: 'parent',
            data: { status: 'completed', processId: 'p', stdout: '', stderr: '' }
          });
        }
        fixture.add('tool.completed', {
          toolName: 'code_exec',
          callId: 'parent',
          data: { cellId: 'cell' }
        });
        if (withNestedExec)
          fixture.add('model.context', {
            role: 'tool',
            callId: 'parent',
            content: '',
            calls: [
              {
                callId: 'nested-exec',
                toolName: 'exec',
                status: 'completed',
                input: { command: 'x'.repeat(5000) }
              }
            ]
          });
        for (let i = 0; i < count; i++) {
          fixture.add('model.context', {
            role: 'tool_call',
            name: 'exec',
            callId: `other-${i}`,
            arguments: { command: 'echo unrelated' },
            content: ''
          });
          fixture.add('tool.completed', { toolName: 'exec', callId: `other-${i}` });
          fixture.add('model.context', {
            role: 'tool',
            callId: `other-${i}`,
            content: '',
            ...(i % 2 === 0
              ? {
                  calls: [
                    { callId: `nested-${i}`, toolName: 'read', status: 'completed', input: {} }
                  ]
                }
              : {})
          });
        }
        let reads = 0;
        const observed = fixture.values.map(
          (record) =>
            new Proxy(record, {
              get(target, key, receiver) {
                if (key === 'type' || key === 'sequence') reads++;
                return Reflect.get(target, key, receiver);
              }
            })
        );
        const inputs = retainedCodeInputs(observed, 'parent', undefined, {
          activeProcessIds: new Set(),
          evidenceMature: () => true
        });
        if (withNestedExec) {
          expect(inputs).toHaveLength(1);
          expect(JSON.stringify(inputs)).not.toContain('x'.repeat(5000));
        } else expect(inputs).toEqual([]);
        expect(reads).toBeLessThan(fixture.values.length * 40);
        return reads;
      });
      expect(accesses[2]).toBeLessThan(accesses[1]! * 2.2);
      expect(accesses[1]).toBeLessThan(accesses[0]! * 2.2);
    }
  );
  it('does not let a later observation delay an older stale read and patch input', () => {
    const { fixture, result, observations } = scenario(false);
    for (let i = 0; i < 6; i++) {
      fixture.add('model.attempt', { purpose: 'EXECUTION', state: 'STARTED' });
      modelContext(fixture.add, {
        role: 'provider',
        provider: 'OPENAI_RESPONSES',
        providerModelId: 'coding',
        content: '',
        item: { type: 'reasoning', id: `reason-${i}`, encrypted_content: 'opaque', summary: [] }
      });
      fixture.add('usage.updated', {
        type: 'usage.updated',
        inputTokens: 6000,
        contextInputTokens: 6000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      });
      fixture.add('model.attempt', { purpose: 'EXECUTION', state: 'SUCCEEDED' });
    }
    modelContext(fixture.add, {
      role: 'tool_call',
      name: 'code_exec_wait',
      callId: 'wait',
      content: '',
      arguments: { cellId: 'cell' }
    });
    fixture.add('tool.completed', {
      type: 'tool.completed',
      toolName: 'code_exec_wait',
      callId: 'wait',
      data: { cellId: 'cell', status: 'completed' }
    });
    const late = observations[0];
    if (late.type !== 'tool_result') throw new Error('Expected tool observation');
    const delayed = [{ ...late, id: 'late-read' }];
    const lateResult = modelContext(fixture.add, {
      role: 'tool',
      name: 'code_exec_wait',
      callId: 'wait',
      observations: delayed,
      content: renderObservations(delayed)
    });
    const planned = plan(fixture.values, 'OPENAI_RESPONSES');
    expect(planned).toBeDefined();
    expect(
      planned!.draft.replacements.some(
        (replacement) =>
          replacement.kind === 'READ_OUTPUT_ITEMS' &&
          replacement.target.sequence === result.sequence
      )
    ).toBe(true);
    expect(
      planned!.draft.replacements.some(
        (replacement) => replacement.target.sequence === lateResult.sequence
      )
    ).toBe(false);
  });
  it.each(['running', 'failed', 'cancelled'])(
    'accepts successful nested observations from a %s cell but rejects a failed nested result',
    (status) => {
      const { fixture } = scenario(false);
      for (let i = 0; i < 6; i++) successfulRollout(fixture.add);
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
      expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();
      fixture.add('code.cell.completed', { cellId: 'cell', status: 'completed' });
      expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();
      const nested = fixture.values.find(
        (record) =>
          record.type === 'tool.completed' &&
          (record.payload as { callId?: string }).callId === 'read'
      )!;
      (nested as { type: string }).type = 'tool.failed';
      (nested.payload as { type: string }).type = 'tool.failed';
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
      for (let i = 0; i < 6; i++) successfulRollout(fixture.add);
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
      for (let i = 0; i < 6; i++) successfulRollout(fixture.add);
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
  it.each(['running', 'failed'] as const)(
    'reclaims an observed value independently of a %s parent cell',
    (status) => {
      const fixture = records();
      modelContext(fixture.add, {
        role: 'tool_call',
        name: 'code_exec',
        callId: 'code',
        content: '',
        arguments: 'observe.text(value)',
        inputMode: 'freeform'
      });
      fixture.add(status === 'failed' ? 'tool.failed' : 'tool.completed', {
        type: status === 'failed' ? 'tool.failed' : 'tool.completed',
        toolName: 'code_exec',
        callId: 'code',
        summary: status,
        truncated: false,
        data: { cellId: 'cell', status }
      });
      const observation: CodeObservation = {
        type: 'value',
        id: 'value',
        format: 'text',
        value: 'visible value '.repeat(7000)
      };
      modelContext(fixture.add, {
        role: 'tool',
        callId: 'code',
        name: 'code_exec',
        content: renderObservations([observation]),
        observations: [observation]
      });
      for (let i = 0; i < 6; i++) successfulRollout(fixture.add);
      const original = requestProjection(fixture.values);
      const planned = plan(fixture.values);
      expect(planned?.draft.replacements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'CODE_MODE_OUTPUT',
            target: expect.objectContaining({ observationId: 'value' })
          })
        ])
      );
      const projected = applyContextGcReplacementsToMessages(
        original.messages,
        original.messageSources,
        planned!.draft.replacements
      );
      const checkpoint = fixture.add('context.gc.completed', {
        ...planned!.draft,
        checkpointId: 'value-checkpoint',
        generation: 1
      });
      expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();
      expect(requestProjection(structuredClone(fixture.values))).toEqual(projected);
    }
  );
  it.each(['toolName', 'observationId'] as const)(
    'rejects forged %s at commit and restores committed observations by identity',
    (field) => {
      const { fixture } = scenario(false, 'code_exec');
      for (let i = 0; i < 6; i++) successfulRollout(fixture.add);
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
});
