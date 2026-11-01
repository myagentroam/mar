import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { formatReadContextItem } from '../../src/prompts/read-context.js';
import { planContextGc } from '../../src/runtime/context/gc.js';
import { buildContextProjection } from '../../src/runtime/context/projection.js';
import {
  renderObservations,
  type CodeToolCallRecord
} from '../../src/session/code-observation-projection.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';

it('commits Direct read invalidation against the matching unobserved patch in a multi-call cell', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mar-gc-patch-calls-'));
  let store = await JsonlSessionStore.open(home);
  try {
    const session = await store.createSession({ workspace: '/workspace', title: 'Patch calls' });
    const append = (type: string, payload: unknown) =>
      store.append(session.id, { type, payload, executionId: 'execution', turnId: 'turn' });
    await append('execution.header', { modelId: 'coding', contextWindowTokens: 10000 });
    const paths = ['src/a.ts', 'src/b.ts'];
    await append('model.context', {
      role: 'tool_call',
      name: 'read',
      callId: 'read',
      arguments: { reads: paths.map((path) => ({ path })) },
      content: ''
    });
    await append('tool.completed', {
      type: 'tool.completed',
      toolName: 'read',
      callId: 'read',
      truncated: false
    });
    const read = await append('model.context', {
      role: 'tool',
      name: 'read',
      callId: 'read',
      content: paths
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
              truncated: false,
              previewComplete: true
            },
            `STALE_${index} `.repeat(1600)
          )
        )
        .join('\n')
    });
    await append('model.context', {
      role: 'tool_call',
      name: 'code_exec',
      callId: 'cell',
      arguments: { code: 'for (const patch of patches) await tools.apply_patch({ patch });' },
      content: ''
    });
    const calls: CodeToolCallRecord[] = [];
    for (const [index, path] of paths.entries()) {
      const callId = `patch-${index}`;
      const input = {
        patch: `*** Begin Patch\n*** Update File: ${path}\n@@\n-before\n+after\n*** End Patch`
      };
      await append('tool.started', {
        type: 'tool.started',
        toolName: 'apply_patch',
        callId,
        parentCallId: 'cell',
        input
      });
      await append('tool.completed', {
        type: 'tool.completed',
        toolName: 'apply_patch',
        callId,
        parentCallId: 'cell',
        truncated: false,
        data: {
          files: [{ path, operation: 'modified', addedLines: 1, deletedLines: 1 }],
          totals: { files: 1, addedLines: 1, deletedLines: 1 }
        }
      });
      calls.push({ callId, toolName: 'apply_patch', input, status: 'completed' });
    }
    await append('tool.completed', {
      type: 'tool.completed',
      toolName: 'code_exec',
      callId: 'cell',
      truncated: false,
      data: { cellId: 'cell', status: 'completed' }
    });
    await append('model.context', {
      role: 'tool',
      name: 'code_exec',
      callId: 'cell',
      content: renderObservations([]),
      observations: [],
      calls
    });
    for (let i = 0; i < 10; i++) {
      await append('model.attempt', { purpose: 'EXECUTION', state: 'STARTED' });
      await append('model.context', {
        role: 'provider',
        content: '',
        provider: 'OPENAI_RESPONSES',
        providerModelId: 'coding',
        item: { type: 'reasoning', id: `thinking-${i}`, encrypted_content: 'opaque' }
      });
      await append('usage.updated', {
        type: 'usage.updated',
        inputTokens: 6000,
        contextInputTokens: 6000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      });
      await append('model.attempt', { purpose: 'EXECUTION', state: 'SUCCEEDED' });
    }
    const records = (await store.readExecutionState(session.id)).contextRecords;
    const projection = buildContextProjection(records);
    const plan = planContextGc({
      records,
      messages: projection.entries.flatMap((entry) => (entry.message ? [entry.message] : [])),
      messageSources: projection.entries.flatMap((entry) => (entry.message ? [entry.record] : [])),
      modelId: 'coding',
      modelProtocol: 'OPENAI_RESPONSES',
      contextWindowTokens: 10000,
      usage: {
        inputTokens: 6000,
        contextInputTokens: 6000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      },
      system: 'System.',
      tools: [],
      workspace: '/workspace',
      platform: 'linux',
      activeProcessIds: new Set()
    });
    expect(plan).toBeDefined();
    await store.commitContextGc(session.id, plan!.draft);
    const replacement = plan!.draft.replacements.find(
      (value) => value.kind === 'READ_OUTPUT_ITEMS' && value.target.sequence === read.sequence
    );
    expect(replacement).toMatchObject({
      items: [
        { index: 0, supersededByCallId: 'patch-0' },
        { index: 1, supersededByCallId: 'patch-1' }
      ]
    });
    await store.close();
    store = await JsonlSessionStore.open(home);
    const visible = JSON.stringify(
      buildContextProjection(
        (await store.readExecutionState(session.id)).contextRecords
      ).entries.flatMap((entry) => entry.message ?? [])
    );
    expect(visible).not.toContain('STALE_0 STALE_0');
    expect(visible).not.toContain('STALE_1 STALE_1');
    expect(visible).toContain('stale_read');
  } finally {
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
});
