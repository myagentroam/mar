import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { planContextGc } from '../../src/runtime/context/gc.js';
import { buildContextProjection } from '../../src/runtime/context/projection.js';
import {
  renderObservations,
  type CodeObservation,
  type CodeToolCallRecord
} from '../../src/session/code-observation-projection.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';

it.each(['unrelated observation first', 'target observation first', 'only call ledger'] as const)(
  'commits a Direct exec paired with the exact nested wait: %s',
  async (mode) => {
    const home = await mkdtemp(join(tmpdir(), 'mar-gc-exec-evidence-'));
    let store = await JsonlSessionStore.open(home);
    try {
      const workspace = '/workspace';
      const { id } = await store.createSession({ workspace, title: 'Exec evidence' });
      const append = (type: string, payload: unknown) =>
        store.append(id, { type, payload, executionId: 'execution', turnId: 'turn' });
      const usage = { inputTokens: 6000, contextInputTokens: 6000 };
      const command = `echo ${'command '.repeat(1000)}`;
      const output = (processId: string, status: 'running' | 'completed', stdout = '') => ({
        processId,
        status,
        stdout,
        stderr: '',
        exitCode: status === 'completed' ? 0 : null,
        truncated: false
      });
      await append('execution.header', { modelId: 'coding', contextWindowTokens: 10000 });
      await append('model.context', {
        role: 'tool_call',
        name: 'exec',
        callId: 'start',
        arguments: { command },
        content: ''
      });
      const running = output('target', 'running', 'stdout '.repeat(1000));
      await append('tool.completed', {
        type: 'tool.completed',
        toolName: 'exec',
        callId: 'start',
        truncated: false,
        data: running
      });
      await append('model.context', {
        role: 'tool',
        name: 'exec',
        callId: 'start',
        content: JSON.stringify(running)
      });
      await append('model.context', {
        role: 'tool_call',
        name: 'code_exec',
        callId: 'cell',
        arguments: { code: 'wait for both processes' },
        content: ''
      });
      const calls: CodeToolCallRecord[] = [];
      const observations: CodeObservation[] = [];
      for (const processId of ['unrelated', 'target']) {
        const callId = `${processId}-wait`;
        const toolName = 'exec_wait';
        const input = { processId };
        const data = output(processId, 'completed');
        const result = { content: JSON.stringify(data) };
        await append('tool.started', {
          type: 'tool.started',
          toolName,
          callId,
          parentCallId: 'cell',
          input
        });
        await append('tool.completed', {
          type: 'tool.completed',
          toolName,
          callId,
          parentCallId: 'cell',
          truncated: false,
          data
        });
        calls.push({ callId, toolName, input, status: 'completed', result });
        if (mode !== 'only call ledger')
          observations.push({
            type: 'tool_result',
            id: `${callId}-observation`,
            source: { callId, toolName, input },
            outcome: 'completed',
            result
          });
      }
      if (mode === 'target observation first') observations.reverse();
      await append('tool.completed', {
        type: 'tool.completed',
        toolName: 'code_exec',
        callId: 'cell',
        data: { cellId: 'cell', status: 'completed' }
      });
      await append('model.context', {
        role: 'tool',
        name: 'code_exec',
        callId: 'cell',
        content: renderObservations(observations, ''),
        calls,
        observations
      });
      for (let index = 0; index < 10; index++) {
        await append('model.attempt', { purpose: 'EXECUTION', state: 'STARTED' });
        await append('usage.updated', { type: 'usage.updated', ...usage });
        await append('model.attempt', { purpose: 'EXECUTION', state: 'SUCCEEDED' });
      }
      const { contextRecords: records } = await store.readExecutionState(id);
      const { entries } = buildContextProjection(records);
      const plan = planContextGc({
        records,
        messages: entries.map(({ message }) => message),
        messageSources: entries.map(({ record }) => record),
        system: '',
        tools: [],
        modelId: 'coding',
        contextWindowTokens: 10000,
        usage,
        workspace,
        platform: 'linux',
        activeProcessIds: new Set()
      });
      expect(plan).toBeDefined();
      const draft = plan!.draft;
      expect(draft.replacements.filter(({ callId }) => callId === 'start')).toMatchObject([
        { kind: 'TOOL_CALL_INPUT', terminalCallId: 'target-wait' },
        { kind: 'EXEC_OUTPUT', terminalCallId: 'target-wait' }
      ]);
      for (const kind of ['TOOL_CALL_INPUT', 'EXEC_OUTPUT']) {
        const wrongEvidence = draft.replacements.map((replacement) =>
          replacement.kind === kind && replacement.callId === 'start'
            ? { ...replacement, terminalCallId: 'unrelated-wait' }
            : replacement
        );
        await expect(
          store.commitContextGc(id, { ...draft, replacements: wrongEvidence }, records)
        ).rejects.toThrow('Context GC checkpoint validation failed.');
      }
      await store.commitContextGc(id, draft, records);
      await store.close();
      store = await JsonlSessionStore.open(home);
      const restored = buildContextProjection((await store.readExecutionState(id)).contextRecords);
      expect(restored.checkpoint?.replacements.filter(({ callId }) => callId === 'start')).toEqual(
        draft.replacements.filter(({ callId }) => callId === 'start')
      );
      expect(JSON.stringify(restored.entries.map(({ message }) => message))).not.toContain(command);
    } finally {
      await store.close();
      await rm(home, { recursive: true, force: true });
    }
  }
);
