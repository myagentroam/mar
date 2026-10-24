import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalAgentHost, SecretValue, type MarAgentModelConfiguration } from '../../src/index.js';
import { createMarAgentWithAdapter } from '../../src/agent-core/sdk/agent.js';
import type {
  ModelAdapter,
  ModelMessage,
  ModelRequest
} from '../../src/agent-core/model/contracts.js';
import { JsonlSessionStore, type SessionRecord } from '../../src/agent-core/session/store/index.js';
import { planContextGc } from '../../src/agent-core/runtime/context/gc.js';
import { buildContextProjection } from '../../src/agent-core/runtime/context/projection.js';
import { restoreMessages } from '../../src/agent-core/runtime/context/restore.js';
import { validateContextGcCheckpoint } from '../../src/agent-core/session/context-gc-checkpoint.js';
import { contextGcApplyPatchInputReplacement } from '../../src/agent-core/session/context-gc-replacements.js';
import { retainedCodeInputs } from '../../src/agent-core/session/context-gc-observations.js';
import { structuredToolFailureData } from '../../src/agent-core/tools/output-projection.js';
import { MarAgentError } from '../../src/agent-core/error.js';
import { formatReadContextItem } from '../../src/agent-core/tools/local/read-context.js';
import {
  renderObservations,
  type CodeObservation
} from '../../src/agent-core/tools/code-mode/observations.js';

const patch =
  '*** Begin Patch\n*** Update File: applied.txt\n@@\n-before\n+after\n*** Update File: failed.txt\n@@\n-missing\n+after\n*** Update File: pending.txt\n@@\n-before\n+after\n*** End Patch';
const partialData = {
  files: [{ path: 'applied.txt', operation: 'modified' as const, addedLines: 1, deletedLines: 1 }],
  totals: { files: 1, addedLines: 1, deletedLines: 1 },
  failedFile: 'failed.txt',
  pendingFiles: ['pending.txt']
};

describe('partial patch execution facts', () => {
  it('projects only validated patch facts, not arbitrary error details or ordinary failures', () => {
    const error = new MarAgentError('MAR_AGENT_PATCH_PARTIAL', 'partial', {
      details: { ...partialData, privateDetail: 'not public' }
    });
    expect(structuredToolFailureData('apply_patch', error)).toEqual(partialData);
    expect(structuredToolFailureData('read', error)).toBeUndefined();
    expect(
      structuredToolFailureData(
        'apply_patch',
        new MarAgentError('MAR_AGENT_PATCH_CONFLICT', 'conflict', { details: partialData })
      )
    ).toBeUndefined();
  });
  it.each(
    [
      { codeMode: false, observeError: false },
      { codeMode: true, observeError: true },
      { codeMode: true, observeError: false }
    ].flatMap(({ codeMode, observeError }) =>
      ['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'].map((protocol) => ({
        codeMode,
        observeError,
        protocol: protocol as 'OPENAI_RESPONSES' | 'ANTHROPIC_MESSAGES'
      }))
    )
  )(
    'persists failed patch facts with codeMode=$codeMode, observeError=$observeError and protocol=$protocol without reporting success',
    async ({ codeMode, observeError, protocol }) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-partial-patch-'));
      const workspace = join(home, 'workspace');
      await mkdir(workspace);
      for (const path of ['applied.txt', 'failed.txt', 'pending.txt'])
        await writeFile(join(workspace, path), 'before\n');
      const configuration: MarAgentModelConfiguration = {
        id: 'coding',
        name: 'Coding',
        modelId: 'test',
        protocol,
        baseUrl: 'https://example.test',
        apiKey: new SecretValue('test-key'),
        contextWindowTokens: 200_000,
        maxOutputTokens: 4096,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: ['high'],
        defaultReasoningEffort: 'high',
        titleGeneration: false,
        hostedWebSearch: false,
        codeMode,
        enabled: true
      };
      const requests: ModelRequest[] = [];
      const adapter: ModelAdapter = {
        configuration,
        async *start(request) {
          requests.push(request);
          if (requests.length === 1) {
            yield {
              type: 'client_tool.call',
              callId: 'patch-call',
              name: codeMode ? 'code_exec' : 'apply_patch',
              arguments: codeMode
                ? observeError
                  ? `try { await tools.apply_patch(${JSON.stringify(patch)}); } catch (error) { observe.result(error); }`
                  : `await tools.apply_patch(${JSON.stringify(patch)});`
                : patch
            };
            yield { type: 'completed', reason: 'tool_use' };
          } else {
            yield { type: 'text.completed', itemId: 'done', text: 'done' };
            yield { type: 'completed', reason: 'completed' };
          }
        }
      };
      const agent = await createMarAgentWithAdapter({
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [configuration],
        adapterFactory: () => adapter
      });
      try {
        const session = await agent.createSession({ workspace, title: 'Partial patch' });
        const run = session.run({ prompt: 'Apply the patch.' });
        const events = [];
        for await (const event of run) events.push(event);
        expect((await run.result()).status).toBe('completed');
        const failure = events.find(
          (event) => event.type === 'tool.failed' && event.toolName === 'apply_patch'
        );
        expect(failure).toMatchObject({
          type: 'tool.failed',
          code: 'MAR_AGENT_PATCH_PARTIAL',
          data: partialData,
          ...(codeMode ? { parentCallId: 'patch-call' } : {})
        });
        expect(
          events.some(
            (event) => event.type === 'tool.completed' && event.toolName === 'apply_patch'
          )
        ).toBe(false);
        expect(await readFile(join(workspace, 'applied.txt'), 'utf8')).toBe('after\n');
        for (const path of ['failed.txt', 'pending.txt'])
          expect(await readFile(join(workspace, path), 'utf8')).toBe('before\n');
        const store = await JsonlSessionStore.open(home);
        const records = await store.read(session.id);
        expect(
          records.find(
            (record) =>
              record.type === 'tool.failed' &&
              (record.payload as { toolName?: string }).toolName === 'apply_patch'
          )?.payload
        ).toMatchObject({ data: partialData });
        const output = requests[1]!.messages.find(
          (message) => message.role === 'tool' && message.callId === 'patch-call'
        )!;
        expect(output.content).toContain('MAR_AGENT_PATCH_PARTIAL');
        if (!codeMode) expect(JSON.parse(output.content)).toMatchObject({ data: partialData });
        else
          expect(output.calls).toContainEqual(
            expect.objectContaining({ toolName: 'apply_patch', status: 'failed' })
          );
        if (codeMode && observeError)
          expect(output.observations?.[0]).toMatchObject({
            type: 'tool_result',
            outcome: 'failed',
            result: { data: partialData }
          });
        const restored = await restoreMessages(store, session.id, records, {
          includeImages: false
        });
        expect(
          restored.messages.find(
            (message) => message.role === 'tool' && message.callId === 'patch-call'
          )
        ).toMatchObject({ content: output.content });
        await store.close();
      } finally {
        await agent.dispose();
        await rm(home, { recursive: true, force: true });
      }
    }
  );
});

function gcFixture(
  codeMode: boolean,
  operation: 'modified' | 'deleted' | 'moved' | 'added' = 'modified',
  wait = false,
  outerStatus: 'completed' | 'failed' | 'cancelled' = 'completed'
) {
  const values: SessionRecord[] = [];
  const add = (type: string, payload: unknown) => {
    const sequence = values.length + 1;
    const record: SessionRecord = {
      schemaVersion: 1,
      recordId: `record-${sequence}`,
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
  const context = (message: ModelMessage) => add('model.context', message);
  add('session.created', { title: 'partial', workspace: '/workspace' });
  add('execution.header', { modelId: 'coding', contextWindowTokens: 10_000 });
  const paths = ['applied.txt', 'failed.txt', 'pending.txt', 'target.txt', 'unapplied.txt'];
  const readInput = { reads: paths.map((path) => ({ path })) };
  const readContent = paths
    .map((path, index) =>
      formatReadContextItem(
        index,
        {
          path,
          encoding: 'utf-8',
          newline: 'lf',
          startLine: 1,
          endLine: 1,
          eof: true,
          truncated: false
        },
        `1\t${path === 'applied.txt' ? 'old source '.repeat(7000) : `KEEP_${path}`}`
      )
    )
    .join('\n');
  const observations: CodeObservation[] = [];
  if (codeMode && outerStatus === 'completed') {
    context({
      role: 'tool_call',
      name: 'code_exec',
      callId: 'code',
      content: '',
      arguments: 'try { await tools.apply_patch(patch); } catch (e) {}'
    });
    add('tool.started', {
      type: 'tool.started',
      toolName: 'read',
      callId: 'read',
      parentCallId: 'code',
      input: readInput
    });
    add('tool.completed', {
      type: 'tool.completed',
      toolName: 'read',
      callId: 'read',
      parentCallId: 'code',
      truncated: false
    });
    observations.push({
      type: 'tool_result',
      id: 'read-observation',
      outcome: 'completed',
      source: { toolName: 'read', callId: 'read', input: readInput },
      result: { content: readContent }
    });
    add('tool.started', {
      type: 'tool.started',
      toolName: 'apply_patch',
      callId: 'patch',
      parentCallId: 'code',
      input: patch
    });
  } else {
    if (codeMode) {
      context({
        role: 'tool_call',
        name: 'code_exec',
        callId: 'read-cell',
        content: '',
        arguments: 'observe.result(await tools.read(input));'
      });
      add('tool.started', {
        type: 'tool.started',
        toolName: 'read',
        callId: 'read',
        parentCallId: 'read-cell',
        input: readInput
      });
      add('tool.completed', {
        type: 'tool.completed',
        toolName: 'read',
        callId: 'read',
        parentCallId: 'read-cell'
      });
      add('tool.completed', {
        type: 'tool.completed',
        toolName: 'code_exec',
        callId: 'read-cell',
        data: { cellId: 'first-cell', status: 'completed' }
      });
      const readObservation: CodeObservation = {
        type: 'tool_result',
        id: 'prior-read',
        outcome: 'completed',
        source: { toolName: 'read', callId: 'read', input: readInput },
        result: { content: readContent }
      };
      context({
        role: 'tool',
        callId: 'read-cell',
        content: renderObservations([readObservation]),
        observations: [readObservation],
        calls: []
      });
    } else {
      context({
        role: 'tool_call',
        name: 'read',
        callId: 'read',
        content: '',
        arguments: readInput
      });
      context({ role: 'tool', callId: 'read', content: readContent });
    }
    if (codeMode) {
      context({
        role: 'tool_call',
        name: 'code_exec',
        callId: 'code',
        content: '',
        arguments: 'await tools.apply_patch(patch);'
      });
      add('tool.started', {
        type: 'tool.started',
        toolName: 'apply_patch',
        callId: 'patch',
        parentCallId: 'code',
        input: patch
      });
    } else
      context({
        role: 'tool_call',
        name: 'apply_patch',
        callId: 'patch',
        content: '',
        arguments: patch
      });
  }
  const failure = add('tool.failed', {
    type: 'tool.failed',
    toolName: 'apply_patch',
    callId: 'patch',
    ...(codeMode ? { parentCallId: 'code' } : {}),
    code: 'MAR_AGENT_PATCH_PARTIAL',
    message: 'Patch partially applied.',
    data: {
      ...structuredClone(partialData),
      files: [
        {
          ...partialData.files[0],
          operation,
          ...(operation === 'moved' ? { targetPath: 'target.txt' } : {})
        }
      ]
    }
  });
  if (codeMode) {
    if (wait) {
      add('tool.completed', {
        type: 'tool.completed',
        toolName: 'code_exec',
        callId: 'code',
        data: { cellId: 'cell', status: 'running' }
      });
      context({ role: 'tool', callId: 'code', content: 'running', observations: [], calls: [] });
      context({
        role: 'tool_call',
        callId: 'wait',
        name: 'code_exec_wait',
        content: '',
        arguments: { cellId: 'cell' }
      });
    }
    const terminalType = outerStatus === 'completed' ? 'tool.completed' : 'tool.failed';
    add(terminalType, {
      type: terminalType,
      toolName: wait ? 'code_exec_wait' : 'code_exec',
      callId: wait ? 'wait' : 'code',
      data: { cellId: 'cell', status: outerStatus }
    });
    context({
      role: 'tool',
      callId: wait ? 'wait' : 'code',
      content: renderObservations(observations),
      observations,
      calls: [
        {
          callId: 'patch',
          toolName: 'apply_patch',
          input: patch,
          status: 'failed',
          error: { code: 'MAR_AGENT_PATCH_PARTIAL', message: 'partial' }
        }
      ]
    });
  } else
    context({
      role: 'tool',
      callId: 'patch',
      content: JSON.stringify({ error: 'MAR_AGENT_PATCH_PARTIAL', data: partialData })
    });
  for (let i = 0; i < 2; i++) {
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
  return { values, add, failure };
}

function plan(values: SessionRecord[]) {
  const entries = buildContextProjection(values).entries;
  return planContextGc({
    records: values,
    messages: entries.flatMap((entry) => (entry.message ? [entry.message] : [])),
    messageSources: entries.flatMap((entry) => (entry.message ? [entry.record] : [])),
    system: 'System.',
    tools: [],
    modelId: 'coding',
    contextWindowTokens: 10_000,
    usage: { inputTokens: 6000, contextInputTokens: 6000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    workspace: '/workspace',
    platform: 'linux',
    activeProcessIds: new Set()
  });
}

describe('partial patch stale-read GC', () => {
  it.each([false, true])(
    'rejects patch input reclamation and invalid checkpoint evidence with codeMode=%s',
    (codeMode) => {
      const fixture = gcFixture(codeMode);
      const planned = plan(fixture.values)!;
      const checkpoint = fixture.add('context.gc.completed', {
        ...planned.draft,
        generation: 1,
        checkpointId: 'negative'
      });
      expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();
      const readReplacement = planned.draft.replacements[0]!;
      if (readReplacement.kind !== 'READ_OUTPUT_ITEMS') throw new Error('Expected stale read');
      const evidenceSequence = readReplacement.evidenceSequences[0]!;
      const altered = {
        ...checkpoint,
        payload: structuredClone(checkpoint.payload as typeof planned.draft)
      };
      const patchCall = fixture.values.find(
        (record) =>
          record.type === (codeMode ? 'tool.started' : 'model.context') &&
          (record.payload as { callId?: string; role?: string }).callId === 'patch'
      )!;
      altered.payload = {
        ...altered.payload,
        replacements: [
          {
            kind: 'TOOL_CALL_INPUT',
            toolName: 'apply_patch',
            callId: 'patch',
            evidenceSequence: evidenceSequence,
            providerAliasTargets: [],
            replacementArguments: contextGcApplyPatchInputReplacement(patch, partialData),
            target: {
              sequence: patchCall.sequence,
              recordId: patchCall.recordId,
              role: 'tool_call',
              callId: 'patch',
              toolName: 'apply_patch'
            }
          }
        ]
      };
      expect(validateContextGcCheckpoint(fixture.values, altered)).toBeUndefined();
      const failurePayload = fixture.failure.payload as { code: string };
      failurePayload.code = 'MAR_AGENT_PATCH_CONFLICT';
      expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeUndefined();
      if (codeMode)
        expect(retainedCodeInputs(fixture.values, 'code')).toContainEqual({
          callId: 'patch',
          toolName: 'apply_patch',
          input: patch
        });
    }
  );

  it.each(['failed', 'cancelled'] as const)(
    'uses only durable writes from a %s cell, including its terminal wait',
    (status) => {
      for (const wait of [false, true]) {
        const fixture = gcFixture(true, 'modified', wait, status);
        const planned = plan(fixture.values)!;
        expect(planned?.draft.replacements.map((replacement) => replacement.kind)).toEqual([
          'READ_OUTPUT_ITEMS'
        ]);
        const checkpoint = fixture.add('context.gc.completed', {
          ...planned.draft,
          generation: 1,
          checkpointId: 'failed-cell'
        });
        expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();
        expect(retainedCodeInputs(fixture.values, 'code')).toContainEqual({
          callId: 'patch',
          toolName: 'apply_patch',
          input: patch
        });
      }
    }
  );

  it.each(['running', 'failed', 'cancelled'])(
    'protects partial patch observations in a %s cell',
    (status) => {
      const fixture = gcFixture(true);
      const outer = fixture.values.find(
        (record) =>
          record.type === 'tool.completed' &&
          (record.payload as { toolName?: string }).toolName === 'code_exec'
      )!;
      (outer.payload as { data: { status: string } }).data.status = status;
      expect(plan(fixture.values)).toBeUndefined();
    }
  );

  it('rejects a stale read checkpoint when the nested read completed after the partial patch', () => {
    const fixture = gcFixture(true);
    const planned = plan(fixture.values)!;
    const read = fixture.values.find(
      (record) =>
        record.type === 'tool.completed' &&
        (record.payload as { toolName?: string }).toolName === 'read'
    )!;
    [read.sequence, fixture.failure.sequence] = [fixture.failure.sequence, read.sequence];
    fixture.values.sort((a, b) => a.sequence - b.sequence);
    const checkpoint = fixture.add('context.gc.completed', {
      ...planned.draft,
      generation: 1,
      checkpointId: 'late-read'
    });
    expect(plan(fixture.values)).toBeUndefined();
    expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeUndefined();
  });

  it.each(
    [false, true].flatMap((codeMode) =>
      ['modified', 'deleted', 'moved'].map((operation) => ({
        codeMode,
        operation: operation as 'modified' | 'deleted' | 'moved'
      }))
    )
  )(
    'reclaims only applied $operation source with codeMode=$codeMode and restores a validated checkpoint',
    ({ codeMode, operation }) => {
      const fixture = gcFixture(codeMode, operation);
      const planned = plan(fixture.values);
      expect(planned).toBeDefined();
      expect(planned!.draft.replacements).toHaveLength(1);
      const replacement = planned!.draft.replacements[0]!;
      expect(replacement.kind).toBe('READ_OUTPUT_ITEMS');
      if (replacement.kind !== 'READ_OUTPUT_ITEMS') throw new Error('Expected read replacement');
      expect(replacement.items.map((item) => item.path)).toEqual(['applied.txt']);
      expect(replacement.target.observationId).toBe(codeMode ? 'read-observation' : undefined);
      const checkpoint = fixture.add('context.gc.completed', {
        ...planned!.draft,
        generation: 1,
        checkpointId: 'partial'
      });
      expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();
      const restored = buildContextProjection(structuredClone(fixture.values));
      const text = restored.entries.map((entry) => entry.message?.content ?? '').join('\n');
      expect(text).not.toContain('old source old source');
      for (const path of ['failed.txt', 'pending.txt', 'target.txt', 'unapplied.txt'])
        expect(text).toContain(`KEEP_${path}`);
      const retainedPatch = restored.entries.find(
        (entry) =>
          entry.message?.role === 'tool_call' &&
          entry.message.callId === (codeMode ? 'code' : 'patch')
      );
      expect(retainedPatch?.message?.arguments).toEqual(
        codeMode ? 'try { await tools.apply_patch(patch); } catch (e) {}' : patch
      );
      expect(fixture.failure.type).toBe('tool.failed');
      expect(buildContextProjection(structuredClone(fixture.values))).toEqual(restored);
    }
  );

  it('resolves a failed unobserved patch through its terminal cell wait', () => {
    const fixture = gcFixture(true, 'modified', true);
    const planned = plan(fixture.values);
    expect(planned?.draft.replacements[0]?.kind).toBe('READ_OUTPUT_ITEMS');
    const checkpoint = fixture.add('context.gc.completed', {
      ...planned!.draft,
      generation: 1,
      checkpointId: 'wait-partial'
    });
    expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();
  });

  it.each([false, true])(
    'rejects added or malformed failure evidence with codeMode=%s',
    (codeMode) => {
      expect(plan(gcFixture(codeMode, 'added').values)).toBeUndefined();
      for (const mutate of [
        (payload: any) => {
          payload.code = 'MAR_AGENT_PATCH_CONFLICT';
        },
        (payload: any) => {
          payload.data.totals.files = 2;
        },
        (payload: any) => {
          payload.data.pendingFiles = 'pending.txt';
        },
        (payload: any) => {
          delete payload.data;
        },
        (payload: any) => {
          payload.callId = 'other';
        }
      ]) {
        const fixture = gcFixture(codeMode);
        mutate(fixture.failure.payload);
        expect(plan(fixture.values)).toBeUndefined();
      }
    }
  );
});
