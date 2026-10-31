import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildContextProjection } from '../../src/runtime/context/projection.js';
import { planContextGc } from '../../src/runtime/context/gc.js';
import {
  renderObservations,
  type CodeObservation
} from '../../src/session/code-observation-projection.js';
import { formatExecResult, type ExecResult } from '../../src/tools/local/exec.js';
import {
  contextGcCheckpointIntervalEligible,
  normalizeContextGcReplacements,
  parseContextGcCheckpoint,
  type ContextGcCheckpointDraft,
  type ContextGcReplacement,
  type ContextGcMetrics
} from '../../src/session/context-gc-checkpoint.js';
import {
  contextGcApplyPatchInputReplacement,
  contextGcStaleReadReplacement
} from '../../src/session/context-gc-replacements.js';
import { formatReadContextItem } from '../../src/prompts/read-context.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { activeSessionDirectory } from '../support/jsonl-session-path.js';

const homes: string[] = [];

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

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function appendSuccessfulRollout(
  store: JsonlSessionStore,
  sessionId: string,
  contextInputTokens: number
) {
  await store.append(sessionId, {
    type: 'model.attempt',
    executionId: 'execution',
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
  await store.append(sessionId, {
    type: 'model.context',
    executionId: 'execution',
    payload: {
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
    executionId: 'execution',
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
  store: JsonlSessionStore,
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
  for (let i = 0; i < 5; i++)
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
      normalRolloutOrdinal: input.normalRolloutOrdinal * 3,
      modelId: 'coding',
      platform: 'linux'
    },
    economics,
    metrics
  };
  return draft;
}

async function createFixture(title: string) {
  const home = await mkdtemp(join(tmpdir(), 'mar-context-gc-store-'));
  homes.push(home);
  const store = await JsonlSessionStore.open(home);
  const session = await store.createSession({ workspace: '/workspace', title });
  await store.append(session.id, {
    type: 'turn.user',
    payload: { prompt: 'Update the source.' },
    executionId: 'execution',
    turnId: 'turn-1'
  });
  await store.append(session.id, {
    type: 'execution.header',
    payload: { modelId: 'coding', contextWindowTokens: 10_000, mode: 'run' },
    executionId: 'execution',
    turnId: 'turn-1'
  });
  const draft = await appendPatchDraft(store, session.id, {
    callId: 'patch-1',
    path: 'src/a.ts',
    contextInputTokens: 6_000,
    normalRolloutOrdinal: 2,
    turnId: 'turn-1'
  });
  return { home, store, session, draft };
}

describe('context GC checkpoint store', () => {
  it('commits and restores a whole-cell summary with a terminal nested exec input', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-context-gc-exec-cell-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({
      workspace: '/workspace',
      title: 'Exec cell checkpoint'
    });
    const append = (type: string, payload: unknown) =>
      store.append(session.id, { type, payload, executionId: 'execution', turnId: 'turn' });
    const command = 'echo ' + 'LONG_COMMAND_'.repeat(1000);
    const input = { command };
    const result = {
      status: 'completed',
      processId: 'process',
      exitCode: 4,
      truncated: false,
      stdout: '',
      stderr: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutDroppedBytes: 0,
      stderrDroppedBytes: 0
    };
    try {
      await append('execution.header', {
        modelId: 'coding',
        contextWindowTokens: 10000,
        mode: 'run'
      });
      await append('model.context', {
        role: 'tool_call',
        name: 'code_exec',
        callId: 'cell',
        content: '',
        arguments: { code: 'cell source '.repeat(10000) }
      });
      await append('tool.started', {
        type: 'tool.started',
        toolName: 'exec',
        callId: 'exec',
        parentCallId: 'cell',
        input
      });
      await append('tool.completed', {
        type: 'tool.completed',
        toolName: 'exec',
        callId: 'exec',
        parentCallId: 'cell',
        truncated: false,
        data: result
      });
      await append('tool.completed', {
        type: 'tool.completed',
        toolName: 'code_exec',
        callId: 'cell',
        truncated: false,
        data: { cellId: 'cell', status: 'completed' }
      });
      const observations: CodeObservation[] = [
        { type: 'value', id: 'value', format: 'text', value: 'done' }
      ];
      await append('model.context', {
        role: 'tool',
        name: 'code_exec',
        callId: 'cell',
        content: renderObservations(observations),
        observations,
        calls: [
          { callId: 'exec', toolName: 'exec', input, status: 'completed', result: { content: '' } }
        ]
      });
      for (let i = 0; i < 6; i++) await appendSuccessfulRollout(store, session.id, 6000);
      const records = await store.read(session.id);
      const projection = buildContextProjection(records);
      const plan = planContextGc({
        records,
        messages: projection.entries.flatMap((entry) => (entry.message ? [entry.message] : [])),
        messageSources: projection.entries.flatMap((entry) =>
          entry.message ? [entry.record] : []
        ),
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
        activeProcessIds: new Set()
      });
      expect(plan).toBeDefined();
      await store.commitContextGc(session.id, plan!.draft);
      const restored = buildContextProjection(
        (await store.readExecutionState(session.id)).contextRecords
      );
      const call = restored.entries.find(
        (entry) => entry.message?.role === 'tool_call' && entry.message.callId === 'cell'
      )?.message;
      expect(JSON.stringify(call?.arguments)).toContain('terminal_exec_input');
      expect(JSON.stringify(call?.arguments).includes(command)).toBe(false);
    } finally {
      await store.close();
    }
  });
  it('persists partial tool-search deduplication across successive checkpoint generations', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-context-gc-search-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({
      workspace: '/workspace',
      title: 'Search checkpoints'
    });
    const append = (type: string, payload: unknown) =>
      store.append(session.id, { type, payload, executionId: 'execution', turnId: 'turn' });
    const definition = (name: string, version: string) => ({
      name,
      description: `${version} `.repeat(6000),
      inputSchema: { type: 'object', properties: {} }
    });
    const search = async (id: string, tools: ReturnType<typeof definition>[]) => {
      await append('model.context', {
        role: 'provider',
        provider: 'OPENAI_RESPONSES',
        providerModelId: 'coding',
        content: '',
        item: {
          type: 'tool_search_call',
          id: `item-${id}`,
          call_id: id,
          execution: 'client',
          status: 'completed',
          arguments: { query: id }
        }
      });
      await append('model.context', {
        role: 'tool_call',
        name: 'tool_search',
        callId: id,
        arguments: { query: id },
        content: ''
      });
      await append('tool.completed', {
        type: 'tool.completed',
        toolName: 'tool_search',
        callId: id,
        truncated: false
      });
      await append('model.context', {
        role: 'tool',
        name: 'tool_search',
        callId: id,
        content: JSON.stringify({ tools: tools.map((tool) => tool.name) }),
        toolSearchTools: tools
      });
    };
    const mature = async (tag: string, usage: number) => {
      for (let i = 0; i < 6; i++) {
        await append('model.attempt', { purpose: 'EXECUTION', state: 'STARTED' });
        await append('model.context', {
          role: 'provider',
          content: '',
          provider: 'OPENAI_RESPONSES',
          providerModelId: 'coding',
          item: { type: 'reasoning', id: `${tag}-${i}`, encrypted_content: 'opaque', summary: [] }
        });
        await append('usage.updated', {
          type: 'usage.updated',
          inputTokens: usage,
          contextInputTokens: usage,
          cacheReadTokens: 0,
          cacheWriteTokens: 0
        });
        await append('model.attempt', { purpose: 'EXECUTION', state: 'SUCCEEDED' });
      }
    };
    const commit = async (usage: number) => {
      const records = await store.read(session.id);
      const projection = buildContextProjection(records);
      const plan = planContextGc({
        records,
        messages: projection.entries.flatMap((entry) => (entry.message ? [entry.message] : [])),
        messageSources: projection.entries.flatMap((entry) =>
          entry.message ? [entry.record] : []
        ),
        system: 'System.',
        tools: [],
        modelId: 'coding',
        modelProtocol: 'OPENAI_RESPONSES',
        contextWindowTokens: 10000,
        usage: {
          inputTokens: usage,
          contextInputTokens: usage,
          cacheReadTokens: 0,
          cacheWriteTokens: 0
        },
        workspace: '/workspace',
        platform: 'linux',
        activeProcessIds: new Set()
      });
      expect(plan).toBeDefined();
      await store.commitContextGc(session.id, plan!.draft);
    };
    const definitions = async (id: string) =>
      buildContextProjection(
        (await store.readExecutionState(session.id)).contextRecords
      ).entries.find((entry) => entry.message?.role === 'tool' && entry.message.callId === id)
        ?.message?.toolSearchTools;
    try {
      await append('execution.header', {
        modelId: 'coding',
        contextWindowTokens: 10000,
        mode: 'run'
      });
      await search('old', [definition('a', 'OLD_A'), definition('b', 'OLD_B')]);
      await search('new-a', [definition('a', 'LATEST_A')]);
      await mature('first', 6000);
      await commit(6000);
      expect((await definitions('old'))?.map((tool) => tool.name)).toEqual(['b']);
      await search('empty', []);
      await search('new-b', [definition('b', 'LATEST_B')]);
      await mature('second', 8000);
      await commit(8000);
      expect(await definitions('old')).toEqual([]);
      expect((await definitions('new-a'))?.map((tool) => tool.name)).toEqual(['a']);
      expect((await definitions('new-b'))?.map((tool) => tool.name)).toEqual(['b']);
      expect(await definitions('empty')).toEqual([]);
    } finally {
      await store.close();
    }
  });
  it('commits and restores superseded Direct and cell Todo inputs and a visible snapshot', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-context-gc-todo-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: '/workspace', title: 'Todo revisions' });
    const append = (type: string, payload: unknown) =>
      store.append(session.id, { type, payload, executionId: 'execution', turnId: 'turn' });
    try {
      await append('execution.header', {
        modelId: 'coding',
        contextWindowTokens: 10000,
        mode: 'run'
      });
      const items = Array.from({ length: 30 }, (_, i) => ({
        id: `old-${i}`,
        step: 'OLD_TODO '.repeat(70),
        status: 'pending'
      }));
      await append('model.context', {
        role: 'tool_call',
        name: 'todo_write',
        callId: 'direct',
        arguments: { items },
        content: ''
      });
      await append('tool.completed', {
        type: 'tool.completed',
        toolName: 'todo_write',
        callId: 'direct',
        truncated: false,
        data: { revision: 1, items }
      });
      await append('model.context', {
        role: 'tool',
        name: 'todo_write',
        callId: 'direct',
        content: '{"revision":1,"count":30}'
      });
      await append('model.context', {
        role: 'tool_call',
        name: 'code_exec',
        callId: 'cell',
        arguments: { code: 'task '.repeat(4000) },
        content: ''
      });
      await append('tool.started', {
        type: 'tool.started',
        toolName: 'todo_write',
        callId: 'nested',
        parentCallId: 'cell',
        input: { items }
      });
      await append('tool.completed', {
        type: 'tool.completed',
        toolName: 'todo_write',
        callId: 'nested',
        parentCallId: 'cell',
        truncated: false,
        data: { revision: 2, items }
      });
      await append('tool.completed', {
        type: 'tool.completed',
        toolName: 'code_exec',
        callId: 'cell',
        truncated: false,
        data: { cellId: 'cell', status: 'completed' }
      });
      const observations: CodeObservation[] = [
        {
          type: 'tool_result',
          id: 'nested-result',
          outcome: 'completed',
          source: { callId: 'nested', toolName: 'todo_write', input: { items } },
          result: { content: '{"revision":2,"count":30}' }
        }
      ];
      await append('model.context', {
        role: 'tool',
        name: 'code_exec',
        callId: 'cell',
        observations,
        content: renderObservations(observations),
        calls: [
          {
            callId: 'nested',
            toolName: 'todo_write',
            input: { items },
            status: 'completed',
            result: { content: '{"revision":2,"count":30}' }
          }
        ]
      });
      await append('model.context', {
        role: 'tool_call',
        name: 'todo_read',
        callId: 'read',
        arguments: {},
        content: ''
      });
      await append('tool.completed', {
        type: 'tool.completed',
        toolName: 'todo_read',
        callId: 'read',
        truncated: false,
        data: { revision: 2, items }
      });
      await append('model.context', {
        role: 'tool',
        name: 'todo_read',
        callId: 'read',
        content: JSON.stringify({ revision: 2, items })
      });
      await append('tool.completed', {
        type: 'tool.completed',
        toolName: 'todo_write',
        callId: 'unseen',
        truncated: false,
        data: { revision: 3, items: [{ id: 'secret', step: 'UNOBSERVED_TODO', status: 'pending' }] }
      });
      for (let i = 0; i < 6; i++) {
        await append('model.attempt', { purpose: 'EXECUTION', state: 'STARTED' });
        await append('model.context', {
          role: 'provider',
          content: '',
          provider: 'OPENAI_RESPONSES',
          providerModelId: 'coding',
          item: { type: 'reasoning', id: `item-${i}`, encrypted_content: 'opaque', summary: [] }
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
      const records = await store.read(session.id);
      const projection = buildContextProjection(records);
      const plan = planContextGc({
        records,
        messages: projection.entries.flatMap((entry) => (entry.message ? [entry.message] : [])),
        messageSources: projection.entries.flatMap((entry) =>
          entry.message ? [entry.record] : []
        ),
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
        activeProcessIds: new Set()
      });
      expect(plan?.draft.replacements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'TOOL_CALL_INPUT', toolName: 'todo_write' }),
          expect.objectContaining({ kind: 'TOOL_CALL_INPUT', toolName: 'code_exec' }),
          expect.objectContaining({ kind: 'TOOL_OUTPUT', toolName: 'todo_read' })
        ])
      );
      await store.commitContextGc(session.id, plan!.draft);
      const visible = JSON.stringify(
        buildContextProjection(
          (await store.readExecutionState(session.id)).contextRecords
        ).entries.map(({ message }) =>
          message?.role === 'tool_call' ? message.arguments : message?.content
        )
      );
      expect(visible.includes('OLD_TODO')).toBe(false);
      expect(visible.includes('UNOBSERVED_TODO')).toBe(false);
      expect(visible).toContain('supersededByRevision');
    } finally {
      await store.close();
    }
  });
  it('commits a same-cell Skill successor selected after another Skill alongside an exec replacement', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-context-gc-skill-cell-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: '/workspace', title: 'Skill cell' });
    const append = (type: string, payload: unknown) =>
      store.append(session.id, { type, payload, executionId: 'execution', turnId: 'turn' });
    try {
      await append('execution.header', {
        modelId: 'coding',
        contextWindowTokens: 10000,
        mode: 'run'
      });
      await append('model.context', {
        role: 'tool_call',
        name: 'skill',
        callId: 'old-x',
        arguments: { name: 'X' },
        content: ''
      });
      await append('tool.completed', {
        type: 'tool.completed',
        toolName: 'skill',
        callId: 'old-x',
        truncated: false
      });
      await append('model.context', {
        role: 'tool',
        name: 'skill',
        callId: 'old-x',
        content: 'OLD_X '.repeat(4000)
      });
      await append('model.context', {
        role: 'tool_call',
        name: 'code_exec',
        callId: 'cell',
        arguments: { code: 'observe tools' },
        content: ''
      });
      const nested = async (name: string, id: string, input: unknown, data: unknown) => {
        await append('tool.started', {
          type: 'tool.started',
          toolName: name,
          callId: id,
          parentCallId: 'cell',
          input
        });
        await append('tool.completed', {
          type: 'tool.completed',
          toolName: name,
          callId: id,
          parentCallId: 'cell',
          truncated: false,
          data
        });
      };
      await nested('skill', 'new-y', { name: 'Y' }, {});
      await nested('skill', 'new-x', { name: 'X' }, {});
      const stdout = 'EXEC_OUTPUT '.repeat(4000);
      const execData = {
        processId: 'done',
        status: 'completed',
        exitCode: 0,
        truncated: false,
        stdout,
        stderr: '',
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: 0,
        stdoutDroppedBytes: 0,
        stderrDroppedBytes: 0
      };
      await nested('exec', 'exec', { command: 'verify' }, execData);
      await append('tool.completed', {
        type: 'tool.completed',
        toolName: 'code_exec',
        callId: 'cell',
        truncated: false,
        data: { cellId: 'cell', status: 'completed' }
      });
      const observations: CodeObservation[] = [
        {
          type: 'tool_result',
          id: 'y',
          outcome: 'completed',
          source: { callId: 'new-y', toolName: 'skill', input: { name: 'Y' } },
          result: { content: 'LATEST_Y '.repeat(1000) }
        },
        {
          type: 'tool_result',
          id: 'x',
          outcome: 'completed',
          source: { callId: 'new-x', toolName: 'skill', input: { name: 'X' } },
          result: { content: 'LATEST_X '.repeat(1000) }
        },
        {
          type: 'tool_result',
          id: 'exec-result',
          outcome: 'completed',
          source: { callId: 'exec', toolName: 'exec', input: { command: 'verify' } },
          result: { content: formatExecResult(execData as ExecResult).content }
        }
      ];
      await append('model.context', {
        role: 'tool',
        name: 'code_exec',
        callId: 'cell',
        observations,
        content: renderObservations(observations)
      });
      for (let i = 0; i < 6; i++) {
        await append('model.attempt', { purpose: 'EXECUTION', state: 'STARTED' });
        await append('model.context', {
          role: 'provider',
          content: '',
          provider: 'OPENAI_RESPONSES',
          providerModelId: 'coding',
          item: { type: 'reasoning', id: `item-${i}`, encrypted_content: 'opaque', summary: [] }
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
      const records = await store.read(session.id);
      const projection = buildContextProjection(records);
      const plan = planContextGc({
        records,
        messages: projection.entries.flatMap((entry) => (entry.message ? [entry.message] : [])),
        messageSources: projection.entries.flatMap((entry) =>
          entry.message ? [entry.record] : []
        ),
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
        activeProcessIds: new Set()
      });
      expect(plan?.draft.replacements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'TOOL_OUTPUT', toolName: 'skill', callId: 'old-x' }),
          expect.objectContaining({
            kind: 'EXEC_OUTPUT',
            target: expect.objectContaining({ observationId: 'exec-result' })
          })
        ])
      );
      await store.commitContextGc(session.id, plan!.draft);
      const visible = JSON.stringify(
        buildContextProjection(
          (await store.readExecutionState(session.id)).contextRecords
        ).entries.map((entry) => entry.message)
      );
      expect(visible).not.toContain('OLD_X OLD_X');
      expect(visible).toContain('LATEST_X');
      expect(visible).toContain('LATEST_Y');
      expect(visible.includes(stdout)).toBe(false);
      expect(visible).toContain('context GC omitted middle');
    } finally {
      await store.close();
    }
  });
  it('commits and restores an observed nested read after its outer cell fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-context-gc-outer-failure-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({
      workspace: '/workspace',
      title: 'Failed outer cell'
    });
    const append = (type: string, payload: unknown) =>
      store.append(session.id, { type, payload, executionId: 'execution', turnId: 'turn' });
    try {
      await append('execution.header', {
        modelId: 'coding',
        contextWindowTokens: 10000,
        mode: 'run'
      });
      await append('model.context', {
        role: 'tool_call',
        name: 'code_exec',
        callId: 'cell',
        arguments: { code: 'observe.result(await tools.read({reads:[{path:"src/a.ts"}]}));' },
        content: ''
      });
      await append('tool.started', {
        type: 'tool.started',
        toolName: 'read',
        callId: 'nested-read',
        parentCallId: 'cell',
        input: {}
      });
      await append('tool.completed', {
        type: 'tool.completed',
        toolName: 'read',
        callId: 'nested-read',
        parentCallId: 'cell',
        truncated: false
      });
      const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch';
      const patchData = {
        files: [{ path: 'src/a.ts', operation: 'modified', addedLines: 1, deletedLines: 1 }],
        totals: { files: 1, addedLines: 1, deletedLines: 1 }
      };
      await append('tool.started', {
        type: 'tool.started',
        toolName: 'apply_patch',
        callId: 'nested-patch',
        parentCallId: 'cell',
        input: patch
      });
      await append('tool.completed', {
        type: 'tool.completed',
        toolName: 'apply_patch',
        callId: 'nested-patch',
        parentCallId: 'cell',
        truncated: false,
        data: patchData
      });
      await append('tool.failed', {
        type: 'tool.failed',
        toolName: 'code_exec',
        callId: 'cell',
        error: { code: 'TEST_FAILURE' }
      });
      const observations: CodeObservation[] = [
        {
          type: 'tool_result',
          id: 'read-result',
          outcome: 'completed',
          source: {
            callId: 'nested-read',
            toolName: 'read',
            input: { reads: [{ path: 'src/a.ts' }] }
          },
          result: {
            content: formatReadContextItem(
              0,
              {
                path: 'src/a.ts',
                encoding: 'utf-8',
                newline: 'lf',
                startLine: 1,
                endLine: 2,
                eof: true,
                truncated: false,
                previewComplete: true
              },
              'STALE_SOURCE '.repeat(4000)
            )
          }
        }
      ];
      await append('model.context', {
        role: 'tool',
        name: 'code_exec',
        callId: 'cell',
        observations,
        content: renderObservations(observations),
        calls: [
          {
            callId: 'nested-patch',
            toolName: 'apply_patch',
            input: patch,
            status: 'completed',
            result: { content: '' }
          }
        ]
      });
      for (let i = 0; i < 6; i++) {
        await append('model.attempt', { purpose: 'EXECUTION', state: 'STARTED' });
        await append('model.context', {
          role: 'provider',
          content: '',
          provider: 'OPENAI_RESPONSES',
          providerModelId: 'coding',
          item: { type: 'reasoning', id: `item-${i}`, encrypted_content: 'opaque', summary: [] }
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
      const records = await store.read(session.id);
      const projection = buildContextProjection(records);
      const plan = planContextGc({
        records,
        messages: projection.entries.flatMap((entry) => (entry.message ? [entry.message] : [])),
        messageSources: projection.entries.flatMap((entry) =>
          entry.message ? [entry.record] : []
        ),
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
        activeProcessIds: new Set()
      });
      expect(plan?.draft.replacements).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'READ_OUTPUT_ITEMS' })])
      );
      await store.commitContextGc(session.id, plan!.draft);
      const visible = JSON.stringify(
        buildContextProjection(
          (await store.readExecutionState(session.id)).contextRecords
        ).entries.map((entry) => entry.message)
      );
      expect(visible).not.toContain('STALE_SOURCE STALE_SOURCE');
      expect(visible).toContain('stale_read');
    } finally {
      await store.close();
    }
  });
  it('commits and restores visible Skill and read successors selected by the planner', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-context-gc-successors-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({
      workspace: '/workspace',
      title: 'Successor checkpoint'
    });
    const append = (type: string, payload: unknown) =>
      store.append(session.id, { type, payload, executionId: 'execution', turnId: 'turn' });
    try {
      await append('execution.header', {
        modelId: 'coding',
        contextWindowTokens: 10000,
        mode: 'run'
      });
      const result = async (name: string, callId: string, args: unknown, content: string) => {
        await append('model.context', {
          role: 'tool_call',
          name,
          callId,
          arguments: args,
          content: ''
        });
        await append('tool.completed', {
          type: 'tool.completed',
          toolName: name,
          callId,
          truncated: false
        });
        return append('model.context', { role: 'tool', name, callId, content });
      };
      await result('skill', 's1', { name: 'guide' }, 'OLD_SKILL '.repeat(2500));
      await result('skill', 's2', { name: 'guide' }, 'LATEST_SKILL '.repeat(2500));
      const read = (startLine: number, endLine: number, body: string) =>
        formatReadContextItem(
          0,
          {
            path: 'src/a.ts',
            encoding: 'utf-8',
            newline: 'lf',
            startLine,
            endLine,
            eof: false,
            truncated: false,
            previewComplete: true
          },
          body
        );
      await result(
        'read',
        'r1',
        { reads: [{ path: 'src/a.ts' }] },
        read(5, 10, 'OLD_READ '.repeat(3000))
      );
      await result(
        'read',
        'r2',
        { reads: [{ path: 'src/a.ts' }] },
        read(1, 20, 'LATEST_READ '.repeat(3000))
      );
      const decision = `${'BEFORE '.repeat(1000)}KEEP_DECISION_IN_MIDDLE${' AFTER'.repeat(1000)}`;
      const question = { questionId: 'question-1', prompt: 'Choose a direction' };
      await result('question', 'q1', question, decision);
      for (const status of ['running', 'failed'] as const) {
        const callId = `code-${status}`;
        await append('model.context', {
          role: 'tool_call',
          name: 'code_exec',
          callId,
          arguments: 'observe.text(value)',
          content: ''
        });
        const type = status === 'failed' ? 'tool.failed' : 'tool.completed';
        await append(type, {
          type,
          toolName: 'code_exec',
          callId,
          truncated: false,
          data: { cellId: `cell-${status}`, status }
        });
        const observation = {
          type: 'value' as const,
          id: `value-${status}`,
          format: 'text' as const,
          value: `VALUE_${status} `.repeat(5000)
        };
        await append('model.context', {
          role: 'tool',
          name: 'code_exec',
          callId,
          content: renderObservations([observation]),
          observations: [observation]
        });
      }
      for (let i = 0; i < 6; i++) {
        await append('model.attempt', { purpose: 'EXECUTION', state: 'STARTED' });
        await append('model.context', {
          role: 'provider',
          content: '',
          provider: 'OPENAI_RESPONSES',
          providerModelId: 'coding',
          item: { type: 'reasoning', id: `item-${i}`, encrypted_content: 'opaque', summary: [] }
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
      const records = await store.read(session.id);
      const projection = buildContextProjection(records);
      const plan = planContextGc({
        records,
        messages: projection.entries.flatMap((entry) => (entry.message ? [entry.message] : [])),
        messageSources: projection.entries.flatMap((entry) =>
          entry.message ? [entry.record] : []
        ),
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
        activeProcessIds: new Set()
      });
      expect(plan).toBeDefined();
      expect(
        plan!.draft.replacements.filter(
          (replacement) =>
            replacement.kind === 'CODE_MODE_OUTPUT' &&
            replacement.target.observationId?.startsWith('value-')
        )
      ).toHaveLength(2);
      await store.commitContextGc(session.id, plan!.draft);
      const restored = buildContextProjection(
        (await store.readExecutionState(session.id)).contextRecords
      );
      const visible = JSON.stringify(restored.entries.map((entry) => entry.message));
      expect(visible).not.toContain('OLD_SKILL OLD_SKILL');
      expect(visible).not.toContain('OLD_READ OLD_READ');
      expect(visible).toContain('LATEST_SKILL');
      expect(visible).toContain('LATEST_READ');
      const messages = restored.entries.flatMap((entry) => (entry.message ? [entry.message] : []));
      expect(
        messages.find((message) => message.role === 'tool_call' && message.callId === 'q1')
      ).toMatchObject({ arguments: question });
      expect(
        messages.find((message) => message.role === 'tool' && message.callId === 'q1')
      ).toMatchObject({ content: decision });
      for (const status of ['running', 'failed'] as const) {
        const message = messages.find(
          (entry) => entry.role === 'tool' && entry.callId === `code-${status}`
        );
        const observation = message?.observations?.find((entry) => entry.id === `value-${status}`);
        expect(observation?.type).toBe('value');
        if (observation?.type !== 'value') throw new Error('Missing restored value');
        expect(observation.value.length).toBeLessThan(`VALUE_${status} `.repeat(5000).length);
      }
    } finally {
      await store.close();
    }
  });
  it.each([
    { window: 10_000, growth: 1_999, rollouts: 2, allowed: false },
    { window: 10_000, growth: 2_000, rollouts: 2, allowed: true },
    { window: 100_000, growth: 4_999, rollouts: 2, allowed: false },
    { window: 100_000, growth: 5_000, rollouts: 2, allowed: true },
    { window: 100_000, growth: 5_000, rollouts: 1, allowed: false }
  ])(
    'requires both trigger thresholds: $window/$growth/$rollouts',
    ({ window, growth, rollouts, allowed }) => {
      const previous: ContextGcCheckpointDraft['trigger'] = {
        usageSequence: 100,
        contextInputTokens: 60_000,
        contextWindowTokens: window,
        normalRolloutOrdinal: 10,
        modelId: 'coding',
        platform: 'linux'
      };
      const trigger = {
        ...previous,
        normalRolloutOrdinal: previous.normalRolloutOrdinal + rollouts,
        contextInputTokens: previous.contextInputTokens + growth
      };
      expect(contextGcCheckpointIntervalEligible(trigger, previous)).toBe(allowed);
    }
  );

  it('rejects unknown replacement and target fields', async () => {
    const { store, draft } = await createFixture('Unknown checkpoint fields');
    try {
      for (const mutate of [
        (replacement: Record<string, unknown>) => {
          replacement.unexpected = true;
        },
        (replacement: Record<string, unknown>) => {
          (replacement.target as Record<string, unknown>).unexpected = true;
        },
        (replacement: Record<string, unknown>) => {
          (replacement.target as Record<string, unknown>).sourceHash = 'obsolete';
        },
        (replacement: Record<string, unknown>) => {
          replacement.providerAliasTargets = [
            {
              ...(replacement.target as Record<string, unknown>),
              role: 'provider',
              sourceHash: 'obsolete'
            }
          ];
        }
      ]) {
        const corrupted = structuredClone(draft);
        mutate(corrupted.replacements[0] as unknown as Record<string, unknown>);
        expect(normalizeContextGcReplacements(corrupted.replacements)).toBeUndefined();
      }
    } finally {
      await store.close();
    }
  });

  it('normalizes large read maps with linear evidence-field reads', () => {
    const count = 1_024;
    let reads = 0;
    const replacement: ContextGcReplacement = {
      kind: 'READ_OUTPUT_ITEMS',
      callId: 'read',
      target: { sequence: 2, recordId: 'read-result', role: 'tool', callId: 'read' },
      items: Array.from({ length: count }, (_, index) => ({
        index,
        path: `src/${index}.ts`,
        replacement: 'Re-read the path.',
        get evidenceSequence() {
          reads++;
          return index + 3;
        }
      })),
      evidenceSequences: Array.from({ length: count }, (_, index) => index + 3)
    };
    expect(normalizeContextGcReplacements([replacement])?.[0]).toEqual(replacement);
    expect(reads).toBeLessThanOrEqual(count * 8);
  });

  it.each([false, true])('merges read fragments by item index with overwrite=%s', (overwrite) => {
    const fragment = (index: number, evidenceSequence: number): ContextGcReplacement => ({
      kind: 'READ_OUTPUT_ITEMS',
      callId: 'read',
      target: { sequence: 2, recordId: 'read-result', role: 'tool', callId: 'read' },
      items: [{ index, path: `src/${index}.ts`, replacement: 'Re-read.', evidenceSequence }],
      evidenceSequences: [evidenceSequence]
    });
    const first = fragment(0, 3);
    const second = fragment(1, 4);
    const replacements = [first, second, ...(overwrite ? [fragment(0, 5)] : [])];
    const normalized = normalizeContextGcReplacements(replacements)!;
    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({
      items: [
        { index: 0, evidenceSequence: overwrite ? 5 : 3 },
        { index: 1, evidenceSequence: 4 }
      ],
      evidenceSequences: [overwrite ? 5 : 3, 4]
    });
    expect(first).toMatchObject({ items: [{ index: 0, evidenceSequence: 3 }] });
    expect(second).toMatchObject({ items: [{ index: 1, evidenceSequence: 4 }] });
  });

  it('rejects a changed durable boundary instead of trusting the planning snapshot', async () => {
    const { store, session, draft } = await createFixture('Changed boundary');
    try {
      const records = (await store.readExecutionState(session.id)).contextRecords;
      const append = store.append(session.id, {
        type: 'turn.user',
        payload: { prompt: 'New work.' }
      });
      const commit = store.commitContextGc(session.id, draft, records);
      await append;
      await expect(commit).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_CORRUPT'
      });
      expect(
        (await store.read(session.id)).some((record) => record.type === 'context.gc.completed')
      ).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('commits targets by record identity without payload hashes', async () => {
    const { store, session, draft } = await createFixture('Record identity');
    try {
      const records = (await store.readExecutionState(session.id)).contextRecords;
      const committed = await store.commitContextGc(session.id, draft, records);
      const payload = parseContextGcCheckpoint(committed)!;
      expect(payload).toBeDefined();
      expect(committed.payload).toEqual(payload);
      for (const replacement of payload.replacements) {
        expect(replacement.target).not.toHaveProperty('sourceHash');
        if (replacement.kind === 'TOOL_CALL_INPUT')
          for (const alias of replacement.providerAliasTargets)
            expect(alias).not.toHaveProperty('sourceHash');
      }
    } finally {
      await store.close();
    }
  });

  it('trusts writer serialization without rereading or hashing the complete planning history', async () => {
    const { home, store, session, draft } = await createFixture('Changed source');
    try {
      const records = (await store.readExecutionState(session.id)).contextRecords;
      const path = join(await activeSessionDirectory(home, session.id), 'events-000001.jsonl');
      const contents = await readFile(path, 'utf8');
      await writeFile(
        path,
        contents.replace('*** Update File: src/a.ts', '*** Update File: src/b.ts')
      );
      const archived = records.find((record) => record.type === 'turn.user')!;
      Object.defineProperty(archived, 'payload', {
        get() {
          throw new Error('Unrelated archived messages must not be hashed.');
        }
      });
      const read = vi.spyOn(store, 'readExecutionState');
      try {
        await expect(store.commitContextGc(session.id, draft, records)).resolves.toMatchObject({
          type: 'context.gc.completed'
        });
        expect(read).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
      }
    } finally {
      await store.close();
    }
  });

  it.each(['none', 'new', 'committed'] as const)(
    'validates only changed cumulative replacements with invalid replacement=%s',
    async (invalid) => {
      const { store, session, draft } = await createFixture('Cumulative plan');
      try {
        const first = parseContextGcCheckpoint(await store.commitContextGc(session.id, draft))!;
        const next = await appendPatchDraft(store, session.id, {
          callId: 'patch-2',
          path: 'src/b.ts',
          contextInputTokens: 8_000,
          normalRolloutOrdinal: 4
        });
        const records = (await store.readExecutionState(session.id)).contextRecords;
        const archived = records.find(
          (record) => record.sequence === first.replacements[0]!.target.sequence
        )!;
        const archivedInput = vi.fn(() => {
          throw new Error('Committed replacement sources must not be rebuilt.');
        });
        if (invalid !== 'committed')
          Object.defineProperty(archived.payload, 'arguments', { get: archivedInput });
        const cumulative = {
          ...next,
          replacements: [
            ...first.replacements.map((replacement) =>
              invalid === 'committed' && replacement.kind === 'TOOL_CALL_INPUT'
                ? { ...replacement, replacementArguments: 'Invalid changed replacement.' }
                : replacement
            ),
            ...next.replacements.map((replacement) =>
              invalid === 'new' && replacement.kind === 'TOOL_CALL_INPUT'
                ? { ...replacement, replacementArguments: 'Invalid new replacement.' }
                : replacement
            )
          ]
        };
        if (invalid !== 'none')
          await expect(
            store.commitContextGc(session.id, cumulative, records)
          ).rejects.toMatchObject({
            code: 'MAR_AGENT_SESSION_CORRUPT'
          });
        else {
          const committed = await store.commitContextGc(session.id, cumulative, records);
          expect(parseContextGcCheckpoint(committed)).toMatchObject({
            generation: 2,
            replacements: [
              expect.objectContaining({ callId: 'patch-1' }),
              expect.objectContaining({ callId: 'patch-2' })
            ]
          });
        }
        expect(archivedInput).not.toHaveBeenCalled();
      } finally {
        await store.close();
      }
    }
  );

  it('preserves committed read items when a later generation submits only an item delta', async () => {
    const { store, session } = await createFixture('Cumulative read');
    try {
      await store.append(session.id, {
        type: 'model.context',
        payload: { role: 'tool_call', callId: 'read', name: 'read', arguments: {} }
      });
      const read = await store.append(session.id, {
        type: 'model.context',
        payload: {
          role: 'tool',
          callId: 'read',
          content: ['b', 'c']
            .map((name, index) =>
              formatReadContextItem(
                index,
                { path: `src/${name}.ts`, pathTruncated: false },
                `before ${name}`
              )
            )
            .join('\n')
        }
      });
      const firstDraft = await appendPatchDraft(store, session.id, {
        callId: 'patch-2',
        path: 'src/b.ts',
        contextInputTokens: 8_000,
        normalRolloutOrdinal: 4
      });
      const evidence = firstDraft.replacements.find(
        (replacement) => replacement.kind === 'TOOL_CALL_INPUT'
      )!.evidenceSequence;
      const firstRead: Extract<ContextGcReplacement, { kind: 'READ_OUTPUT_ITEMS' }> = {
        kind: 'READ_OUTPUT_ITEMS',
        callId: 'read',
        target: { sequence: read.sequence, recordId: read.recordId, role: 'tool', callId: 'read' },
        items: [
          {
            index: 0,
            path: 'src/b.ts',
            replacement: contextGcStaleReadReplacement({
              path: 'src/b.ts',
              content: 'before b',
              operation: 'modified'
            }),
            evidenceSequence: evidence
          }
        ],
        evidenceSequences: [evidence]
      };
      await store.commitContextGc(session.id, {
        ...firstDraft,
        replacements: [...firstDraft.replacements, firstRead]
      });
      const next = await appendPatchDraft(store, session.id, {
        callId: 'patch-3',
        path: 'src/c.ts',
        contextInputTokens: 10_000,
        normalRolloutOrdinal: 6
      });
      const nextEvidence = next.replacements.find(
        (replacement) => replacement.kind === 'TOOL_CALL_INPUT'
      )!.evidenceSequence;
      const records = (await store.readExecutionState(session.id)).contextRecords;
      const archived = records.find(
        (record) =>
          record.type === 'tool.completed' &&
          (record.payload as { callId?: string }).callId === 'patch-2'
      )!;
      const archivedData = vi.fn(() => {
        throw new Error('Committed read-item evidence must not be replayed.');
      });
      Object.defineProperty(archived.payload, 'data', { get: archivedData });
      const committed = await store.commitContextGc(
        session.id,
        {
          ...next,
          replacements: [
            ...next.replacements,
            {
              ...firstRead,
              items: [
                {
                  index: 1,
                  path: 'src/c.ts',
                  replacement: contextGcStaleReadReplacement({
                    path: 'src/c.ts',
                    content: 'before c',
                    operation: 'modified'
                  }),
                  evidenceSequence: nextEvidence
                }
              ],
              evidenceSequences: [nextEvidence]
            }
          ]
        },
        records
      );
      const retained = parseContextGcCheckpoint(committed)!.replacements.find(
        (replacement) => replacement.kind === 'READ_OUTPUT_ITEMS'
      );
      expect(retained?.items.map((item) => item.index)).toEqual([0, 1]);
      expect(archivedData).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });

  it.each([
    { path: '/workspace/src/b.ts', valid: true },
    { path: '/outside/src/b.ts', valid: false }
  ])(
    'validates $path against the Session Workspace at Compact-sliced commit',
    async ({ path, valid }) => {
      const { store, session } = await createFixture('Workspace validation');
      try {
        await store.compact(session.id, {
          summary: 'A new context base.',
          modelId: 'coding',
          contextWindowTokens: 10_000
        });
        await store.append(session.id, {
          type: 'model.context',
          payload: { role: 'tool_call', callId: 'read', name: 'read', arguments: {} }
        });
        const read = await store.append(session.id, {
          type: 'model.context',
          payload: {
            role: 'tool',
            callId: 'read',
            content: formatReadContextItem(0, { path, pathTruncated: false }, 'before b')
          }
        });
        const draft = await appendPatchDraft(store, session.id, {
          callId: 'patch-2',
          path: 'src/b.ts',
          contextInputTokens: 8_000,
          normalRolloutOrdinal: 2
        });
        const records = (await store.readExecutionState(session.id)).contextRecords;
        expect(records[0]?.type).toBe('compact.completed');
        expect(records.some((record) => record.type === 'session.created')).toBe(false);
        const evidenceSequence = draft.replacements.find(
          (replacement) => replacement.kind === 'TOOL_CALL_INPUT'
        )!.evidenceSequence;
        const commit = store.commitContextGc(
          session.id,
          {
            ...draft,
            base: {
              type: 'COMPACT',
              sequence: records[0]!.sequence,
              recordId: records[0]!.recordId
            },
            replacements: [
              {
                kind: 'READ_OUTPUT_ITEMS',
                callId: 'read',
                target: {
                  sequence: read.sequence,
                  recordId: read.recordId,
                  role: 'tool',
                  callId: 'read'
                },
                items: [
                  {
                    index: 0,
                    path,
                    replacement: contextGcStaleReadReplacement({
                      path,
                      content: 'before b',
                      operation: 'modified'
                    }),
                    evidenceSequence
                  }
                ],
                evidenceSequences: [evidenceSequence]
              }
            ]
          },
          records
        );
        if (valid) {
          await expect(commit).resolves.toMatchObject({ type: 'context.gc.completed' });
          const restored = await store.readExecutionState(session.id);
          expect(
            buildContextProjection(restored.contextRecords).checkpoint?.replacements
          ).toHaveLength(1);
        } else {
          await expect(commit).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
          expect(
            (await store.read(session.id)).some((record) => record.type === 'context.gc.completed')
          ).toBe(false);
        }
      } finally {
        await store.close();
      }
    }
  );

  it('restores cumulative generations from records despite obsolete GC index fields', async () => {
    const { home, store, session, draft } = await createFixture('GC');
    const first = await store.commitContextGc(session.id, draft);
    expect(first.payload).not.toHaveProperty('sourceProjectionHash');
    const secondDraft = await appendPatchDraft(store, session.id, {
      callId: 'patch-2',
      path: 'src/b.ts',
      contextInputTokens: 8_000,
      normalRolloutOrdinal: 4
    });
    const second = await store.commitContextGc(session.id, secondDraft);
    expect(second).toMatchObject({
      type: 'context.gc.completed',
      payload: expect.objectContaining({ generation: 2, checkpointId: expect.any(String) })
    });
    expect(
      (second.payload as { replacements: Array<{ callId: string }> }).replacements.map(
        (replacement) => replacement.callId
      )
    ).toEqual(['patch-1', 'patch-2']);
    const expectedProjection = buildContextProjection(
      (await store.readExecutionState(session.id)).contextRecords
    );
    await store.close();

    const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    Object.assign(index.sessions.find((item: { id: string }) => item.id === session.id).resume, {
      gcSequence: first.sequence,
      gcGeneration: 999,
      gcBaseSequence: second.sequence + 100
    });
    await writeFile(indexPath, JSON.stringify(index));

    const reopened = await JsonlSessionStore.open(home);
    const state = await reopened.readExecutionState(session.id);
    expect(buildContextProjection(state.contextRecords)).toEqual(expectedProjection);
    expect(buildContextProjection(state.contextRecords).checkpoint).toMatchObject({
      checkpointId: expect.any(String),
      generation: 2
    });
    const raw = await reopened.read(session.id);
    expect(JSON.stringify(raw)).toContain('*** Update File: src/a.ts');
    expect(JSON.stringify(raw)).toContain('*** Update File: src/b.ts');
    expect(first.sequence).toBeLessThan(second.sequence);
    await reopened.append(session.id, { type: 'turn.user', payload: { prompt: 'Continue.' } });
    await reopened.close();

    const rewritten = await JsonlSessionStore.open(home);
    try {
      const restored = await rewritten.readExecutionState(session.id);
      expect(buildContextProjection(restored.contextRecords)).toEqual(expectedProjection);
      expect(restored.contextRecords.at(-1)?.payload).toEqual({ prompt: 'Continue.' });
    } finally {
      await rewritten.close();
    }
  });

  it('rejects empty checkpoints and trigger sequences that are not matching usage records', async () => {
    const { store, session, draft } = await createFixture('Invalid GC');
    await expect(
      store.commitContextGc(session.id, { ...structuredClone(draft), replacements: [] })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
    await expect(
      store.commitContextGc(session.id, {
        ...structuredClone(draft),
        trigger: { ...draft.trigger, usageSequence: draft.boundarySequence }
      })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
    await expect(
      store.commitContextGc(session.id, {
        ...structuredClone(draft),
        trigger: { ...draft.trigger, normalRolloutOrdinal: 99 }
      })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
    expect(
      (await store.read(session.id)).some((record) => record.type === 'context.gc.completed')
    ).toBe(false);
    await store.close();
  });

  it('does not copy GC checkpoints into a fork even when the boundary contains one', async () => {
    const { store, session, draft } = await createFixture('Source');
    await store.commitContextGc(session.id, draft);
    await store.append(session.id, {
      type: 'message.completed',
      payload: {
        type: 'message.completed',
        itemId: 'answer',
        phase: 'final_answer',
        text: 'Done.'
      },
      executionId: 'execution',
      turnId: 'turn-1'
    });
    const fork = await store.forkSession(session.id, {
      boundaryTurnId: 'turn-1',
      title: 'Fork'
    });
    const forkRecords = await store.read(fork.id);
    expect(forkRecords.some((record) => record.type === 'context.gc.completed')).toBe(false);
    expect(JSON.stringify(forkRecords)).toContain('*** Update File: src/a.ts');
    await store.close();
  });

  it('restores the retained GC generation when rollback truncates a later generation', async () => {
    const { home, store, session, draft } = await createFixture('Rollback');
    const first = await store.commitContextGc(session.id, draft);
    await store.append(session.id, {
      type: 'turn.user',
      payload: { prompt: 'Keep this boundary.' },
      executionId: 'execution-2',
      turnId: 'turn-2'
    });
    await store.append(session.id, {
      type: 'message.completed',
      payload: {
        type: 'message.completed',
        itemId: 'answer-2',
        phase: 'final_answer',
        text: 'Kept.'
      },
      executionId: 'execution-2',
      turnId: 'turn-2'
    });
    const secondDraft = await appendPatchDraft(store, session.id, {
      callId: 'patch-2',
      path: 'src/b.ts',
      contextInputTokens: 8_000,
      normalRolloutOrdinal: 4
    });
    await store.commitContextGc(session.id, secondDraft);

    await store.rollbackSession(session.id, { boundaryTurnId: 'turn-2' });
    const state = await store.readExecutionState(session.id);
    expect(buildContextProjection(state.contextRecords).checkpoint).toMatchObject({
      generation: 1
    });
    const records = await store.read(session.id);
    expect(records.filter((record) => record.type === 'context.gc.completed')).toHaveLength(1);
    expect(records.some((record) => JSON.stringify(record.payload).includes('src/b.ts'))).toBe(
      false
    );
    await store.close();

    const reopened = await JsonlSessionStore.open(home);
    try {
      const restored = await reopened.readExecutionState(session.id);
      expect(buildContextProjection(restored.contextRecords)).toEqual(
        buildContextProjection(state.contextRecords)
      );
      expect(buildContextProjection(restored.contextRecords).checkpoint?.checkpointId).toBe(
        parseContextGcCheckpoint(first)!.checkpointId
      );
    } finally {
      await reopened.close();
    }
  });

  it('drops the active GC generation when Compact establishes a new context base', async () => {
    const { home, store, session, draft } = await createFixture('Compact');
    await store.commitContextGc(session.id, draft);
    const items = [{ id: 'resume', step: 'Continue after Compact', status: 'in_progress' }];
    const todo = await store.append(session.id, {
      type: 'todo.updated',
      payload: { revision: 1, items }
    });
    await store.compact(session.id, {
      summary: 'Continue after Compact.',
      modelId: 'coding',
      contextWindowTokens: 10_000,
      usage: {
        inputTokens: 5_000,
        contextInputTokens: 6_000,
        cacheReadTokens: 1_000,
        cacheWriteTokens: 0,
        outputTokens: 100
      }
    });
    const state = await store.readExecutionState(session.id);
    expect(state.contextRecords[0]?.type).toBe('compact.completed');
    expect(buildContextProjection(state.contextRecords).checkpoint).toBeUndefined();
    expect(state.todo).toEqual({ revision: 1, items });
    await store.close();

    const index = JSON.parse(
      await readFile(join(home, '.mar', 'agent', 'sessions', 'index.json'), 'utf8')
    ) as {
      sessions: Array<{
        id: string;
        resume?: { compactSequence?: number; todoSequence?: number; todoRevision: number };
      }>;
    };
    const resume = index.sessions.find((item) => item.id === session.id)?.resume;
    expect(resume).toMatchObject({
      compactSequence: state.contextRecords[0]!.sequence,
      todoSequence: todo.sequence,
      todoRevision: 1
    });
    const reopened = await JsonlSessionStore.open(home);
    try {
      const restored = await reopened.readExecutionState(session.id);
      expect(restored.todo).toEqual(state.todo);
      expect(restored.contextRecords).toEqual(state.contextRecords);
      expect(buildContextProjection(restored.contextRecords).checkpoint).toBeUndefined();
    } finally {
      await reopened.close();
    }
  });
});
