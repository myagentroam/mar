import { formatReadContextItem } from '../../src/prompts/read-context.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ModelMessage, ModelUsage } from '../../src/model/contracts.js';
import {
  contextGcMinimumReclaimedTokens,
  inspectContextGc,
  planContextGc,
  type ContextGcPlannerInput
} from '../../src/runtime/context/gc.js';
import {
  contextGcExecInputReplacement,
  contextGcExecOutputReplacement
} from '../../src/session/context-gc-replacements.js';
import {
  buildContextProjection,
  applyContextGcReplacementsToMessages
} from '../../src/runtime/context/projection.js';
import { contextGcMessageTokens } from '../../src/runtime/context/gc-tokens.js';
import { validateContextGcCheckpoint } from '../../src/session/context-gc-checkpoint.js';
import type { SessionRecord } from '../../src/session/store/index.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { ContextGcRuntime } from '../../src/runtime/context/gc-runtime.js';
import { ResourceInputProjection } from '../../src/sdk/resource-input.js';
import { buildContextGcProtection } from '../../src/session/context-gc-protection.js';

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
  cacheReadTokens = 0,
  modelId = 'coding'
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
  add('model.context', {
    role: 'provider',
    content: '',
    provider: 'OPENAI_RESPONSES',
    providerModelId: modelId,
    item: {
      type: 'reasoning',
      id: 'complete-native-item',
      encrypted_content: 'opaque',
      summary: []
    }
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
  const projection = buildContextProjection(values);
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

function addPatchCandidate(fixture: ReturnType<typeof records>, id = 'source') {
  const path = 'src/a.ts';
  modelContext(fixture.add, {
    role: 'tool_call',
    content: '',
    callId: `read-${id}`,
    name: 'read',
    arguments: { reads: [{ path }] }
  });
  modelContext(fixture.add, {
    role: 'tool',
    callId: `read-${id}`,
    content: formatReadContextItem(
      0,
      {
        path,
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
    `*** Update File: ${path}`,
    '@@',
    '-alpha',
    '+beta',
    '*** End Patch'
  ].join('\n');
  modelContext(fixture.add, {
    role: 'tool_call',
    content: '',
    callId: `patch-${id}`,
    name: 'apply_patch',
    arguments: patch,
    inputMode: 'freeform'
  });
  fixture.add('tool.completed', {
    type: 'tool.completed',
    toolName: 'apply_patch',
    callId: `patch-${id}`,
    summary: 'applied',
    data: {
      files: [
        {
          path,
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
    callId: `patch-${id}`,
    content: JSON.stringify({
      files: [
        {
          path,
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

describe('context GC checkpoint eligibility across planner, runtime and store', () => {
  it.each([
    { modelId: 'other-model', contextWindowTokens: 10_000 },
    { modelId: 'coding', contextWindowTokens: 20_000 }
  ])(
    'counts maturity only in the current model/window scope: $modelId/$contextWindowTokens',
    (scope) => {
      const fixture = records();
      addPatchCandidate(fixture);
      for (let i = 0; i < 10; i++) successfulRollout(fixture.add, 6_000);
      expect(plan(fixture.values, { contextInputTokens: 6_000 })).toBeDefined();
      fixture.add('execution.header', { ...scope, mode: 'run' });
      const usage = Math.floor(scope.contextWindowTokens * 0.6);
      for (let i = 0; i < 9; i++) successfulRollout(fixture.add, usage, 0, scope.modelId);
      const anchor = fixture.values.find((record) => record.type === 'tool.completed')!.sequence;
      expect(
        buildContextGcProtection(fixture.values, scope.modelId, scope.contextWindowTokens).after(
          anchor
        ).rollouts
      ).toBe(9);
      successfulRollout(fixture.add, usage, 0, scope.modelId);
      const protection = buildContextGcProtection(
        fixture.values,
        scope.modelId,
        scope.contextWindowTokens
      ).after(anchor);
      expect(protection.rollouts).toBe(10);
      expect(protection.thinking).toBeGreaterThanOrEqual(3);
    }
  );

  it('does not apply no-candidate backoff to mature candidates below the batch threshold', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-gc-small-mature-'));
    const store = await JsonlSessionStore.open(home);
    try {
      const session = await store.createSession({ workspace: '/workspace' });
      const fixture = records();
      addTerminalExec(fixture, 'small-mature', 'line '.repeat(400));
      for (let i = 0; i < 10; i++) successfulRollout(fixture.add, 6_000);
      for (const record of fixture.values.slice(1))
        await store.append(session.id, {
          type: record.type,
          payload: record.payload,
          executionId: record.executionId,
          turnId: record.turnId
        });
      const reads = vi.spyOn(store, 'readExecutionState');
      const runtime = new ContextGcRuntime();
      const input = {
        store,
        sessionId: session.id,
        system: 'System.',
        tools: [],
        modelId: 'coding',
        modelProtocol: 'OPENAI_RESPONSES',
        contextWindowTokens: 10_000,
        usage: { contextInputTokens: 6_000 },
        workspace: '/workspace',
        platform: 'linux' as const,
        activeProcessIds: new Set<string>()
      };
      expect(await runtime.run(input)).toBe(false);
      expect(await runtime.run(input)).toBe(false);
      expect(reads).toHaveBeenCalledTimes(2);
    } finally {
      await store.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rechecks a protected candidate as it matures after a committed GC', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-gc-protected-retry-'));
    const store = await JsonlSessionStore.open(home);
    try {
      const session = await store.createSession({ workspace: '/workspace' });
      const fixture = records();
      addPatchCandidate(fixture);
      for (let i = 0; i < 8; i++) successfulRollout(fixture.add, 6_000);
      addTerminalExec(fixture, 'pending-output', 'pending '.repeat(1_600));
      for (let i = 0; i < 2; i++) successfulRollout(fixture.add, 6_000);
      let copied = 1;
      const append = async () => {
        for (const record of fixture.values.slice(copied))
          await store.append(session.id, {
            type: record.type,
            payload: record.payload,
            executionId: record.executionId,
            turnId: record.turnId
          });
        copied = fixture.values.length;
        return (await store.readExecutionState(session.id)).contextRecords;
      };
      const initial = await append();
      const first = plan(initial, { contextInputTokens: 6_000 });
      expect(first?.metrics.protectedCandidateTokens).toBeGreaterThan(0);
      await store.commitContextGc(session.id, first!.draft, initial);
      const commit = vi.spyOn(store, 'commitContextGc');
      const runtime = new ContextGcRuntime();
      const input = {
        store,
        sessionId: session.id,
        system: 'System.',
        tools: [],
        modelId: 'coding',
        modelProtocol: 'OPENAI_RESPONSES',
        contextWindowTokens: 10_000,
        usage: { contextInputTokens: 6_000 },
        workspace: '/workspace',
        platform: 'linux' as const,
        getActiveProcessIds: vi.fn(async () => new Set<string>())
      };
      expect(await runtime.run(input)).toBe(false);
      for (let i = 0; i < 7; i++) {
        successfulRollout(fixture.add, 6_000);
        await append();
        expect(await runtime.run(input)).toBe(false);
      }
      expect(commit).not.toHaveBeenCalled();
      successfulRollout(fixture.add, 6_000);
      await append();
      const result = await runtime.run(input);
      expect(result && result.projection.checkpoint?.generation).toBe(2);
      expect(
        result &&
          result.projection.checkpoint?.replacements.some((r) => r.callId === 'pending-output')
      ).toBe(true);
      expect(commit).toHaveBeenCalledTimes(1);
    } finally {
      await store.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each([6_000, 8_000])(
    'commits a newly mature candidate after one rollout at usage %i without a growth gate',
    async (usage) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-gc-capacity-repeat-'));
      const store = await JsonlSessionStore.open(home);
      try {
        const session = await store.createSession({ workspace: '/workspace' });
        const fixture = records();
        addPatchCandidate(fixture);
        successfulRollout(fixture.add, 6_000);
        addPatchCandidate(fixture, 'second');
        for (let i = 0; i < 9; i++) successfulRollout(fixture.add, 6_000);
        let copied = 1;
        const append = async () => {
          for (const record of fixture.values.slice(copied))
            await store.append(session.id, {
              type: record.type,
              payload: record.payload,
              executionId: record.executionId,
              turnId: record.turnId
            });
          copied = fixture.values.length;
          return (await store.readExecutionState(session.id)).contextRecords;
        };
        const initial = await append();
        const first = plan(initial, { contextInputTokens: 6_000 });
        expect(first).toBeDefined();
        expect(first!.draft.replacements.some((r) => r.callId === 'patch-second')).toBe(false);
        await store.commitContextGc(session.id, first!.draft, initial);
        const prior = await append();
        expect(plan(prior, { contextInputTokens: 6_000 })).toBeUndefined();
        successfulRollout(fixture.add, usage);
        const current = await append();
        const selected = plan(current, { contextInputTokens: usage });
        expect(selected?.draft.replacements.some((r) => r.callId === 'patch-second')).toBe(true);
        const isolated = records();
        addPatchCandidate(isolated, 'second');
        for (let i = 0; i < 10; i++) successfulRollout(isolated.add, usage);
        const isolatedPlan = plan(isolated.values, { contextInputTokens: usage });
        expect(isolatedPlan).toBeDefined();
        expect(selected?.metrics.reclaimedTokens).toBe(isolatedPlan?.metrics.reclaimedTokens);
        const runtime = new ContextGcRuntime();
        const result = await runtime.run({
          store,
          sessionId: session.id,
          system: 'System.',
          tools: [],
          modelId: 'coding',
          modelProtocol: 'OPENAI_RESPONSES',
          contextWindowTokens: 10_000,
          usage: { contextInputTokens: usage },
          workspace: '/workspace',
          platform: 'linux',
          activeProcessIds: new Set<string>()
        });
        expect(result && result.projection.checkpoint?.generation).toBe(2);
        expect(
          result &&
            result.projection.checkpoint?.replacements.some((r) => r.callId === 'patch-second')
        ).toBe(true);
        expect(
          (await store.read(session.id)).filter((r) => r.type === 'context.gc.completed')
        ).toHaveLength(2);
      } finally {
        await store.close();
        await rm(home, { recursive: true, force: true });
      }
    }
  );
});

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
    for (let index = 0; index < 10; index++) successfulRollout(fixture.add, 8_000);

    const selected = plan(fixture.values, {
      contextInputTokens: 8_000,
      cacheReadTokens: 0,
      outputTokens: 10
    });
    const replacement = selected?.draft.replacements.find((item) => item.kind === 'EXEC_OUTPUT');

    expect(selected?.stage).toBe('UNIFIED');
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
    for (let index = 0; index < 10; index++) successfulRollout(fixture.add, 8_000);

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
    for (let index = 0; index < 10; index++) successfulRollout(fixture.add, 8_000);

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
      for (let index = 0; index < 10; index++) successfulRollout(fixture.add, 8_000);

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

  it('uses the fixed window-relative threshold', () => {
    expect(contextGcMinimumReclaimedTokens(10_000)).toBe(1_001);
    expect(contextGcMinimumReclaimedTokens(100_003)).toBe(10_001);
  });

  it('rejects exactly ten percent but admits the same net reclaim just above ten percent', () => {
    const fixture = records();
    addPatchCandidate(fixture);
    for (let i = 0; i < 10; i++) successfulRollout(fixture.add, 6_000);
    const baseline = plan(fixture.values, { contextInputTokens: 6_000 });
    expect(baseline).toBeDefined();
    const reclaimed = baseline!.metrics.reclaimedTokens;
    const header = fixture.values.find((record) => record.type === 'execution.header')!;
    const setWindow = (window: number) => {
      (header.payload as { contextWindowTokens: number }).contextWindowTokens = window;
      return plan(
        fixture.values,
        { contextInputTokens: Math.floor(window * 0.6) },
        {
          contextWindowTokens: window
        }
      );
    };
    expect(setWindow(reclaimed * 10)).toBeUndefined();
    expect(setWindow(reclaimed * 10 - 1)?.metrics.reclaimedTokens).toBe(reclaimed);
  });

  it.each([
    [600, 1],
    [700, 1]
  ])(
    'uses the fixed threshold for a protected candidate retry hint (%i lines)',
    (length, retry) => {
      const fixture = records();
      addTerminalExec(fixture, 'protected', 'line '.repeat(length));
      for (let i = 0; i < 9; i++) successfulRollout(fixture.add, 6_000);
      const projection = buildContextProjection(fixture.values);
      const inspection = inspectContextGc({
        records: fixture.values,
        messages: projection.entries.map((entry) => entry.message),
        messageSources: projection.entries.map((entry) => entry.record),
        system: 'System.',
        tools: [],
        modelId: 'coding',
        modelProtocol: 'OPENAI_RESPONSES',
        contextWindowTokens: 10_000,
        usage: { contextInputTokens: 6_000, cacheReadTokens: 0 },
        workspace: '/workspace',
        platform: 'linux',
        activeProcessIds: new Set()
      });
      expect(inspection.plan).toBeUndefined();
      expect(inspection.retryAfterRollouts).toBe(retry);
    }
  );

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
    for (let index = 0; index < 10; index++) successfulRollout(fixture.add, 8_000);

    expect(
      plan(fixture.values, {
        contextInputTokens: 7_999,
        cacheReadTokens: 0,
        outputTokens: 10
      })?.stage
    ).toBe('UNIFIED');
    expect(
      plan(fixture.values, {
        contextInputTokens: 8_000,
        cacheReadTokens: 0,
        outputTokens: 10
      })?.stage
    ).toBe('UNIFIED');
  });

  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'])(
    'aggregates mature medium exec results and keeps nonpositive candidates under %s',
    (modelProtocol) => {
      const fixture = records();
      addTerminalExec(fixture, 'tiny', '');
      for (let i = 0; i < 4; i++) addTerminalExec(fixture, `medium-${i}`, 'line '.repeat(700));
      for (let i = 0; i < 9; i++) successfulRollout(fixture.add, 6_000);
      const usage = { contextInputTokens: 6_000, cacheReadTokens: 0, outputTokens: 10 };
      expect(plan(fixture.values, usage, { modelProtocol })).toBeUndefined();
      successfulRollout(fixture.add, 6_000);
      const selected = plan(fixture.values, usage, { modelProtocol });
      expect(selected).toBeDefined();
      expect(selected!.draft.replacements.some((r) => r.callId === 'tiny')).toBe(false);
      expect(selected!.draft.replacements.filter((r) => r.kind === 'EXEC_OUTPUT')).toHaveLength(4);
      const before = buildContextProjection(fixture.values);
      const beforeRecords = structuredClone(fixture.values);
      const checkpoint = fixture.add('context.gc.completed', {
        ...selected!.draft,
        checkpointId: 'medium-exec',
        generation: 1
      });
      expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();
      const restored = buildContextProjection(structuredClone(fixture.values));
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
    addTerminalExec(fixture, 'only-medium', 'line '.repeat(600));
    for (let i = 0; i < 10; i++) successfulRollout(fixture.add, 6_000);
    expect(plan(fixture.values, { contextInputTokens: 6_000, cacheReadTokens: 0 })).toBeUndefined();
  });

  it('collects a single mature terminal output when it clears the window threshold', () => {
    const fixture = records();
    addTerminalExec(fixture, 'only-medium', 'line '.repeat(1_500));
    for (let i = 0; i < 10; i++) successfulRollout(fixture.add, 6_000);
    const selected = plan(fixture.values, { contextInputTokens: 6_000, cacheReadTokens: 0 });
    expect(selected?.metrics.reclaimedTokens).toBeGreaterThan(1_000);
    expect(selected?.draft.replacements.some((item) => item.kind === 'EXEC_OUTPUT')).toBe(true);
  });

  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'])(
    'aggregates medium Web bodies without retiring tiny results or inputs under %s',
    (modelProtocol) => {
      const fixture = records();
      addWebResult(fixture, 'tiny-web', 'KEEP');
      for (let i = 0; i < 4; i++) addWebResult(fixture, `web-${i}`, 'evidence '.repeat(700));
      for (let i = 0; i < 9; i++) successfulRollout(fixture.add, 6_000);
      const usage = { contextInputTokens: 6_000, cacheReadTokens: 0 };
      expect(plan(fixture.values, usage, { modelProtocol })).toBeUndefined();
      successfulRollout(fixture.add, 6_000);
      const selected = plan(fixture.values, usage, { modelProtocol });
      expect(selected?.draft.replacements).toHaveLength(4);
      expect(selected!.draft.replacements.every((r) => r.kind === 'WEB_OUTPUT')).toBe(true);
      const original = buildContextProjection(fixture.values);
      const checkpoint = fixture.add('context.gc.completed', {
        ...selected!.draft,
        checkpointId: 'medium-web',
        generation: 1
      });
      expect(validateContextGcCheckpoint(fixture.values, checkpoint)).toBeDefined();
      const restored = buildContextProjection(structuredClone(fixture.values));
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
    for (let i = 0; i < 9; i++) successfulRollout(fixture.add, 6_000);
    const projection = buildContextProjection(fixture.values);
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
    for (let i = 0; i < 10; i++) successfulRollout(fixture.add, 6_000);
    const selected = plan(fixture.values, { contextInputTokens: 6_000, cacheReadTokens: 0 });
    const patch = selected?.draft.replacements.find((r) => r.kind === 'TOOL_CALL_INPUT');
    expect(patch).toBeDefined();
    const original = buildContextProjection(fixture.values);
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
    for (let i = 0; i < 10; i++) successfulRollout(fixture.add, 6_000);
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
    expect(buildContextProjection(structuredClone(fixture.values)).checkpoint?.checkpointId).toBe(
      'later-positive-group'
    );
  });

  it('does not collect a zero-reclaim candidate', () => {
    const fixture = records();
    addTerminalExec(fixture, 'empty', '');
    for (let i = 0; i < 10; i++) successfulRollout(fixture.add, 6_000);
    expect(plan(fixture.values, { contextInputTokens: 6_000 })).toBeUndefined();
  });

  it('makes the same combined capacity decision regardless of cache reads', () => {
    const fixture = records();
    addPatchCandidate(fixture);
    for (let i = 0; i < 10; i++) successfulRollout(fixture.add, 8_000);
    const uncached = plan(fixture.values, { contextInputTokens: 8_000, cacheReadTokens: 0 });
    const cached = plan(fixture.values, { contextInputTokens: 8_000, cacheReadTokens: 8_000 });
    expect(uncached).toBeDefined();
    expect(cached?.draft.replacements).toEqual(uncached?.draft.replacements);
    expect(cached?.metrics.reclaimedTokens).toBe(uncached?.metrics.reclaimedTokens);
    expect(cached?.draft).not.toHaveProperty('economics');
  });
});

describe('unified inline media GC', () => {
  async function mediaFixture(bytes = 3 * 1_048_576, text = false) {
    const fixture = records();
    for (const id of ['a', 'b'])
      modelContext(fixture.add, {
        role: 'tool',
        callId: id,
        name: 'view_image',
        content: `Viewed ${id} (1×1 px).`,
        images: [
          {
            resourceInputVersion: 1,
            mimeType: 'image/png',
            resourceId: id.repeat(64),
            byteSize: bytes
          }
        ]
      });
    if (text) addPatchCandidate(fixture);
    const tokens = text ? 6_000 : 1_000;
    for (let i = 0; i < (text ? 10 : 2); i++) successfulRollout(fixture.add, tokens);
    fixture.add('resource.window', {
      version: 1,
      consideredThrough: { sourceId: 'tool:b', imageIndex: 0 }
    });
    const projection = buildContextProjection(fixture.values);
    const window = new ResourceInputProjection(
      false,
      { readResource: async () => undefined },
      'session',
      projection.entries.map((entry) => entry.message),
      { records: fixture.values }
    );
    return { fixture, candidate: await window.gcCandidate(), tokens };
  }

  it.each([true, false])(
    'preserves the text retry hint when adding media GC (text plan=%s)',
    async (withText) => {
      const { fixture, candidate } = await mediaFixture(3 * 1_048_576, withText);
      expect(candidate?.reason).toBe('SOFT_LIMIT');
      addTerminalExec(fixture, 'next-rollout', 'pending '.repeat(1_600));
      for (let i = 0; i < 9; i++) successfulRollout(fixture.add, 6_000);
      const projection = buildContextProjection(fixture.values);
      const input: ContextGcPlannerInput = {
        records: fixture.values,
        messages: projection.entries.map((entry) => entry.message),
        messageSources: projection.entries.map((entry) => entry.record),
        system: 'System.',
        tools: [],
        modelId: 'coding',
        modelProtocol: 'OPENAI_RESPONSES',
        contextWindowTokens: 10_000,
        usage: { contextInputTokens: 6_000 },
        workspace: '/workspace',
        platform: 'linux',
        activeProcessIds: new Set()
      };
      const text = inspectContextGc(input);
      expect(Boolean(text.plan)).toBe(withText);
      expect(text.retryAfterRollouts).toBe(1);

      const combined = inspectContextGc({ ...input, inlineMedia: candidate! });
      expect(combined.plan?.draft.inlineMedia?.reason).toBe('SOFT_LIMIT');
      expect(combined.retryAfterRollouts).toBe(1);
    }
  );

  it('admits image pressure at low token usage without inventing text replacements', async () => {
    const { fixture, candidate, tokens } = await mediaFixture();
    expect(candidate?.reason).toBe('SOFT_LIMIT');
    const selected = plan(
      fixture.values,
      { contextInputTokens: tokens },
      { inlineMedia: candidate! }
    );
    expect(selected).toMatchObject({
      stage: 'INLINE_MEDIA',
      draft: { replacements: [], inlineMedia: { reason: 'SOFT_LIMIT' } }
    });
    const record = fixture.add('context.gc.completed', {
      ...selected!.draft,
      checkpointId: 'media',
      generation: 1
    });
    expect(validateContextGcCheckpoint(fixture.values, record)?.inlineMedia?.state).toEqual(
      candidate!.state
    );
    expect(
      validateContextGcCheckpoint(fixture.values, {
        ...record,
        payload: {
          ...selected!.draft,
          checkpointId: 'media',
          generation: 1,
          trigger: { ...selected!.draft.trigger, usageSequence: null, contextInputTokens: 0 }
        }
      })
    ).toBeUndefined();
  });

  it('does not independently collect a below-trigger text hitchhike candidate', async () => {
    const { fixture, candidate, tokens } = await mediaFixture(2 * 1_048_576);
    expect(candidate?.reason).toBe('TEXT_GC');
    expect(
      plan(fixture.values, { contextInputTokens: tokens }, { inlineMedia: candidate! })
    ).toBeUndefined();
  });

  it('keeps hard-limit media GC available at and above the async Compact threshold', async () => {
    const { fixture, candidate } = await mediaFixture();
    for (const contextInputTokens of [8_500, 9_000]) {
      const selected = plan(
        fixture.values,
        { contextInputTokens },
        { inlineMedia: { ...candidate!, reason: 'HARD_LIMIT' } }
      );
      expect(selected).toMatchObject({ stage: 'INLINE_MEDIA', draft: { replacements: [] } });
      expect(selected?.metrics.minimumRequiredReclaimedTokens).toBeUndefined();
    }
  });

  it.each(['size', 'protection'] as const)(
    'does not let image pressure relax the text %s gate',
    async (gate) => {
      const { fixture, candidate } = await mediaFixture();
      if (gate === 'size') addTerminalExec(fixture, 'small', 'line '.repeat(600));
      else addPatchCandidate(fixture);
      for (let i = 0; i < (gate === 'protection' ? 9 : 10); i++)
        successfulRollout(fixture.add, 6_000);
      const usage = { contextInputTokens: 6_000, cacheReadTokens: 6_000 };
      expect(plan(fixture.values, usage)).toBeUndefined();
      for (const reason of ['SOFT_LIMIT', 'HARD_LIMIT'] as const) {
        const selected = plan(fixture.values, usage, { inlineMedia: { ...candidate!, reason } });
        expect(selected).toMatchObject({ stage: 'INLINE_MEDIA', draft: { replacements: [] } });
      }
    }
  );

  it('persists media pressure with no text reclaim', async () => {
    const { fixture, candidate } = await mediaFixture(3 * 1_048_576);
    const selected = plan(
      fixture.values,
      { contextInputTokens: 1_000, outputTokens: 0 },
      {
        inlineMedia: { ...candidate!, project: (messages) => messages }
      }
    );
    expect(selected?.draft.metrics.reclaimedTokens).toBe(0);
    expect(selected?.draft).not.toHaveProperty('economics');
    const record = {
      ...fixture.values.at(-1)!,
      sequence: fixture.values.at(-1)!.sequence + 1,
      type: 'context.gc.completed',
      payload: JSON.parse(
        JSON.stringify({ ...selected!.draft, checkpointId: 'media-pressure', generation: 1 })
      )
    };
    expect(validateContextGcCheckpoint(fixture.values, record, '/workspace')).toBeDefined();
  });

  it('shares one checkpoint with eligible text GC at the lower image watermark', async () => {
    const { fixture, candidate, tokens } = await mediaFixture(2 * 1_048_576, true);
    expect(candidate?.reason).toBe('TEXT_GC');
    const selected = plan(
      fixture.values,
      { contextInputTokens: tokens },
      { inlineMedia: candidate! }
    );
    expect(selected?.draft.replacements.length).toBeGreaterThan(0);
    expect(selected?.draft.inlineMedia?.state).toEqual(candidate!.state);
    expect(selected?.metrics.reclaimedTokens).toBeGreaterThan(1_000);
    const record = fixture.add('context.gc.completed', {
      ...selected!.draft,
      checkpointId: 'combined',
      generation: 1
    });
    expect(validateContextGcCheckpoint(fixture.values, record)?.inlineMedia?.state).toEqual(
      candidate!.state
    );
  });

  it.each([false, true])(
    'anchors usage-free media checkpoints without permitting new text replacements (historical usage=%s)',
    async (historicalUsage) => {
      const { fixture, candidate, tokens } = await mediaFixture(3 * 1_048_576, true);
      const combined = plan(
        fixture.values,
        { contextInputTokens: tokens },
        { inlineMedia: candidate! }
      )!;
      expect(combined.draft.replacements.length).toBeGreaterThan(0);
      if (historicalUsage)
        fixture.add('execution.header', {
          modelId: 'coding',
          contextWindowTokens: 10_000,
          mode: 'run'
        });
      const withoutUsage = historicalUsage
        ? fixture.values
        : fixture.values.filter(
            (record) => (record.payload as { type?: string }).type !== 'usage.updated'
          );
      const selected = plan(withoutUsage, {}, { inlineMedia: candidate! })!;
      expect(selected.draft.trigger.usageSequence).toBeNull();
      expect(selected.draft.replacements).toEqual([]);
      const record = fixture.add('context.gc.completed', {
        ...selected.draft,
        checkpointId: 'without-usage',
        generation: 1
      });
      expect(validateContextGcCheckpoint(withoutUsage, record)).toBeDefined();
      expect(
        validateContextGcCheckpoint(withoutUsage, {
          ...record,
          payload: { ...(record.payload as object), replacements: combined.draft.replacements }
        })
      ).toBeUndefined();
    }
  );
});
