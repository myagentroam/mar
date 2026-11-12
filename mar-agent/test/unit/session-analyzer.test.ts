import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeSessionDirectory, formatSessionAnalysis } from '../tools/session-analysis.mjs';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

describe('session analyzer', () => {
  it('separates handled external Compact snapshots and retains concurrent and following usage', async () => {
    const directory = await createSessionDirectory();
    const progress = {
      compactionId: 'compact',
      extensionOutcome: 'HANDLED',
      extension: { modelId: 'luna', providerModelId: 'gpt-5.6-luna', state: 'SUCCEEDED' }
    };
    await writeRecords(directory, 'events-000001.jsonl', [
      record(1, 'context.compacting', { compactionId: 'compact' }, 'compact-exec'),
      record(2, 'compact.progress', progress, 'compact-exec'),
      record(3, 'execution.header', { modelId: 'main', mode: 'compact' }, 'compact-exec'),
      record(
        4,
        'usage.updated',
        { purpose: 'compact', inputTokens: 100, contextInputTokens: 100 },
        'compact-exec'
      ),
      record(
        5,
        'usage.updated',
        { inputTokens: 1000, contextInputTokens: 1000, cacheReadTokens: 900, outputTokens: 5 },
        'concurrent'
      ),
      record(
        6,
        'usage.updated',
        {
          purpose: 'compact',
          inputTokens: 100,
          contextInputTokens: 100,
          cacheReadTokens: 0,
          outputTokens: 3
        },
        'compact-exec'
      ),
      record(7, 'compact.progress', { ...progress, state: 'FINISHED' }, 'compact-exec'),
      record(8, 'compact.completed', {}, 'compact-exec'),
      record(
        9,
        'usage.updated',
        { inputTokens: 1000, contextInputTokens: 1000, cacheReadTokens: 500, outputTokens: 5 },
        'compact-exec'
      ),
      record(10, 'context.gc.completed', { metrics: { reclaimedTokens: 100 } }, 'compact-exec'),
      record(
        11,
        'usage.updated',
        { inputTokens: 1000, contextInputTokens: 1000, cacheReadTokens: 0, outputTokens: 5 },
        'compact-exec'
      )
    ]);
    const report = await analyzeSessionDirectory(directory);
    expect(report.usage).toMatchObject({
      requestCount: 4,
      contextInputTokens: 3100,
      cacheReadTokens: 1400,
      cacheHitRate: 1400 / 3000,
      overallCacheHitRate: 1400 / 3100,
      externalCompactUsage: { requestCount: 1, contextInputTokens: 100, outputTokens: 3 },
      executionUsage: { requestCount: 3, contextInputTokens: 3000, cacheReadTokens: 1400 }
    });
    const filtered = await analyzeSessionDirectory(directory, { sinceSequence: 6 });
    expect(filtered.usage.externalCompactUsage).toMatchObject({
      requestCount: 1,
      contextInputTokens: 100
    });
    expect(filtered.usage.executionUsage.requestCount).toBe(2);
    expect(formatSessionAnalysis(report)).toContain('External Compact:');
  });

  it.each([
    ['execution final arrives first', false],
    ['Compact final arrives first', true]
  ])(
    'keeps interleaved execution and Compact snapshots separate when %s',
    async (_order, compactFinalFirst) => {
      const directory = await createSessionDirectory();
      const compactInitial = record(
        5,
        'usage.updated',
        {
          purpose: 'compact',
          inputTokens: 140_871,
          contextInputTokens: 140_871,
          cacheReadTokens: 0
        },
        'exec-1'
      );
      const executionInitial = record(
        7,
        'usage.updated',
        {
          inputTokens: 167_086,
          contextInputTokens: 167_086,
          cacheReadTokens: 164_864
        },
        'exec-1'
      );
      const executionFinal = record(
        compactFinalFirst ? 9 : 8,
        'usage.updated',
        {
          inputTokens: 166_800,
          contextInputTokens: 167_086,
          cacheReadTokens: 164_000,
          outputTokens: 698
        },
        'exec-1'
      );
      const compactFinal = record(
        compactFinalFirst ? 8 : 10,
        'usage.updated',
        {
          purpose: 'compact',
          inputTokens: 140_871,
          contextInputTokens: 140_871,
          cacheReadTokens: 10_752,
          cacheWriteTokens: 256,
          outputTokens: 2_570
        },
        'exec-1'
      );
      const records = [
        record(1, 'context.gc.completed', {}, undefined),
        record(2, 'execution.started', {}, 'exec-1'),
        record(3, 'context.compacting', { compactionId: 'compact-1' }, 'exec-1'),
        record(
          4,
          'compact.progress',
          { compactionId: 'compact-1', extensionOutcome: 'HANDLED' },
          'exec-1'
        ),
        compactInitial,
        record(
          6,
          'model.attempt',
          { purpose: 'EXECUTION', state: 'STARTED', attempt: 1 },
          'exec-1'
        ),
        executionInitial,
        ...(compactFinalFirst ? [compactFinal, executionFinal] : [executionFinal]),
        record(
          compactFinalFirst ? 10 : 9,
          'tool.started',
          { toolName: 'read', callId: 'tool-1' },
          'exec-1'
        ),
        ...(!compactFinalFirst ? [compactFinal] : []),
        record(11, 'compact.completed', { automatic: true }, 'exec-1')
      ];
      await writeRecords(directory, 'events-000001.jsonl', records.slice(0, 5));
      await writeRecords(directory, 'events-000002.jsonl', records.slice(5));

      const report = await analyzeSessionDirectory(directory);

      expect(report.usage).toMatchObject({
        requestCount: 2,
        inputTokens: 307_671,
        contextInputTokens: 307_957,
        outputTokens: 3_268,
        cacheReadTokens: 174_752,
        cacheWriteTokens: 256,
        executionUsage: {
          requestCount: 1,
          inputTokens: 166_800,
          contextInputTokens: 167_086,
          outputTokens: 698,
          cacheReadTokens: 164_000
        },
        externalCompactUsage: {
          requestCount: 1,
          inputTokens: 140_871,
          contextInputTokens: 140_871,
          outputTokens: 2_570,
          cacheReadTokens: 10_752,
          cacheWriteTokens: 256
        }
      });
      expect(report.executions[0].usage).toMatchObject({
        requestCount: 2,
        contextInputTokens: 307_957
      });
      expect(report.executions[0].firstUsage).toMatchObject({
        requestCount: 1,
        inputTokens: 166_800,
        contextInputTokens: 167_086,
        outputTokens: 698,
        cacheReadTokens: 164_000
      });
      expect(report.gc[0]).toMatchObject({
        followingUsageCount: 2,
        firstFollowingUsage: {
          sequence: 5,
          contextInputTokens: 140_871,
          cacheReadTokens: 10_752
        },
        secondFollowingUsage: {
          sequence: 7,
          contextInputTokens: 167_086,
          cacheReadTokens: 164_000
        }
      });
      expect(report.compacts[0].followingUsageCount).toBe(0);
      expect((await analyzeSessionDirectory(directory, { sinceSequence: 7 })).usage).toEqual(
        report.usage
      );
    }
  );

  it('requires both compact purpose and explicit HANDLED evidence for external Compact usage', async () => {
    const directory = await createSessionDirectory();
    await writeRecords(directory, 'events-000001.jsonl', [
      record(1, 'context.compacting', { compactionId: 'handled' }, 'handled'),
      record(
        2,
        'compact.progress',
        { compactionId: 'handled', extensionOutcome: 'HANDLED' },
        'handled'
      ),
      record(
        3,
        'usage.updated',
        { purpose: 'compact', contextInputTokens: 100, outputTokens: 10 },
        'handled'
      ),
      record(4, 'context.compacting', { compactionId: 'builtin' }, 'builtin'),
      record(5, 'compact.progress', { compactionId: 'builtin' }, 'builtin'),
      record(
        6,
        'usage.updated',
        { purpose: 'compact', contextInputTokens: 200, outputTokens: 20 },
        'builtin'
      ),
      record(7, 'context.compacting', { compactionId: 'unknown' }, 'unknown'),
      record(
        8,
        'compact.progress',
        { compactionId: 'unknown', extensionOutcome: 'DECLINED' },
        'unknown'
      ),
      record(
        9,
        'usage.updated',
        { purpose: 'compact', contextInputTokens: 300, outputTokens: 30 },
        'unknown'
      ),
      record(
        10,
        'usage.updated',
        { purpose: 'compact', contextInputTokens: 400, outputTokens: 40 },
        'purpose-only'
      )
    ]);

    const report = await analyzeSessionDirectory(directory);

    expect(report.usage).toMatchObject({
      requestCount: 4,
      contextInputTokens: 1_000,
      outputTokens: 100,
      executionUsage: {
        requestCount: 3,
        contextInputTokens: 900,
        outputTokens: 90
      },
      externalCompactUsage: {
        requestCount: 1,
        contextInputTokens: 100,
        outputTokens: 10
      }
    });
  });

  it('retains prior observation evidence when a filtered wait returns only new values', async () => {
    const directory = await createSessionDirectory();
    const observation = {
      type: 'tool_result',
      id: 'read-observed',
      source: { callId: 'read', toolName: 'read' },
      result: { content: 'PRIVATE_BODY' }
    };
    await writeRecords(directory, 'events-000001.jsonl', [
      record(1, 'tool.started', { toolName: 'code_exec', callId: 'cell' }),
      record(2, 'tool.started', { toolName: 'read', callId: 'read', parentCallId: 'cell' }),
      record(3, 'tool.completed', { toolName: 'read', callId: 'read', parentCallId: 'cell' }),
      record(4, 'tool.completed', {
        toolName: 'code_exec',
        callId: 'cell',
        data: { cellId: 'handle', status: 'running' }
      }),
      record(5, 'model.context', {
        role: 'tool',
        callId: 'cell',
        observations: [observation],
        calls: [null]
      }),
      record(6, 'tool.started', {
        toolName: 'code_exec_wait',
        callId: 'wait',
        input: { cellId: 'handle' }
      }),
      record(7, 'tool.completed', {
        toolName: 'code_exec_wait',
        callId: 'wait',
        data: { cellId: 'handle', status: 'completed' }
      }),
      record(8, 'model.context', {
        role: 'tool',
        callId: 'wait',
        observations: [{ type: 'value', id: 'value', format: 'text' }],
        calls: []
      })
    ]);
    const report = await analyzeSessionDirectory(directory, { sinceSequence: 6 });
    expect(report.codeMode).toMatchObject({
      cellCount: 1,
      nestedCallCount: 1,
      unobservedCompletedCallCount: 0,
      observations: { value: 1 }
    });
    expect(report.codeMode.observations.tool_result ?? 0).toBe(0);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_BODY');
  });

  it('distinguishes recovery of retries from another purpose or a new request', async () => {
    const directory = await createSessionDirectory();
    await writeRecords(directory, 'events-000001.jsonl', [
      record(1, 'model.attempt', {
        purpose: 'COMPACT',
        state: 'FAILED',
        attempt: 1,
        errorCode: 'MAR_AGENT_MODEL_PROTOCOL_ERROR'
      }),
      record(2, 'model.attempt', { purpose: 'EXECUTION', state: 'SUCCEEDED', attempt: 1 }),
      record(3, 'model.attempt', {
        purpose: 'EXECUTION',
        state: 'FAILED',
        attempt: 8,
        errorCode: 'MAR_AGENT_MODEL_PROTOCOL_ERROR'
      }),
      record(4, 'model.attempt', { purpose: 'EXECUTION', state: 'STARTED', attempt: 1 }),
      record(5, 'model.attempt', { purpose: 'EXECUTION', state: 'SUCCEEDED', attempt: 1 }),
      record(6, 'model.attempt', {
        purpose: 'EXECUTION',
        state: 'FAILED',
        attempt: 1,
        errorCode: 'MAR_AGENT_MODEL_PROTOCOL_ERROR'
      }),
      record(7, 'model.attempt', { purpose: 'EXECUTION', state: 'STARTED', attempt: 2 }),
      record(8, 'model.attempt', { purpose: 'EXECUTION', state: 'SUCCEEDED', attempt: 2 }),
      record(9, 'model.attempt', {
        purpose: 'EXECUTION',
        state: 'FAILED',
        attempt: 1,
        errorCode: 'MAR_AGENT_RESPONSES_CONTINUATION_RESET'
      }),
      record(10, 'model.attempt', {
        purpose: 'EXECUTION',
        state: 'STARTED',
        attempt: 1,
        continuation: false
      }),
      record(11, 'model.attempt', { purpose: 'EXECUTION', state: 'SUCCEEDED', attempt: 1 })
    ]);
    const report = await analyzeSessionDirectory(directory);
    expect(report.failures).toMatchObject({
      modelAttemptFailureCount: 4,
      recoveredModelAttemptCount: 2
    });
    expect(report.failures.modelAttempts.map((attempt) => attempt.recovered)).toEqual([
      false,
      false,
      true,
      true
    ]);
  });

  it('does not label successful cell-source reclamation as lost partial patch input', async () => {
    const directory = await createSessionDirectory();
    await writeRecords(directory, 'events-000001.jsonl', [
      record(1, 'tool.started', { toolName: 'code_exec', callId: 'cell' }),
      record(2, 'tool.failed', {
        toolName: 'apply_patch',
        callId: 'partial',
        parentCallId: 'cell',
        code: 'MAR_AGENT_PATCH_PARTIAL',
        data: { files: [], pendingFiles: [] }
      }),
      record(3, 'tool.completed', {
        toolName: 'code_exec',
        callId: 'cell',
        data: { cellId: 'handle', status: 'completed' }
      }),
      record(4, 'context.gc.completed', {
        replacements: [{ kind: 'TOOL_CALL_INPUT', target: { callId: 'cell' } }]
      }),
      record(5, 'context.gc.completed', {
        replacements: [{ kind: 'TOOL_CALL_INPUT', target: { callId: 'partial' } }]
      })
    ]);
    const report = await analyzeSessionDirectory(directory, { checkpointValidator: () => false });
    expect(report.gc.map((gc) => gc.evidence.partialPatchInputTargetCount)).toEqual([0, 1]);
    expect(report.gc.map((gc) => gc.validation)).toEqual(['invalid', 'invalid']);
    expect(formatSessionAnalysis(report)).toContain('validation=invalid');
  });

  it('keeps filter tails, incomplete intervals and bounded examples distinct from observed failures', async () => {
    const directory = await createSessionDirectory();
    await writeRecords(
      directory,
      'events-000001.jsonl',
      [
        record(1, 'tool.started', { toolName: 'code_exec', callId: 'cell' }, 'selected'),
        record(
          2,
          'tool.started',
          { toolName: 'read', callId: 'read', parentCallId: 'cell', input: { reads: 'malformed' } },
          'selected'
        ),
        record(
          3,
          'model.attempt',
          { state: 'FAILED', errorCode: 'MAR_AGENT_MODEL_PROTOCOL_ERROR' },
          'selected'
        ),
        record(4, 'model.attempt', { state: 'SUCCEEDED' }, 'other'),
        record(
          5,
          'tool.completed',
          { toolName: 'read', callId: 'read', parentCallId: 'cell' },
          'other'
        ),
        record(
          6,
          'tool.started',
          { toolName: 'exec', callId: 'other-child', parentCallId: 'cell' },
          'other'
        ),
        record(
          7,
          'tool.started',
          { toolName: 'exec', callId: 'foreign', parentCallId: 'not-a-code-cell' },
          'other'
        )
      ],
      '{"PRIVATE_SECRET": broken}\nnull\n'
    );
    const report = await analyzeSessionDirectory(directory, { executionId: 'selected' });
    expect(report.codeMode).toMatchObject({
      cellCount: 1,
      nestedCallCount: 1,
      concurrentCellCount: 0,
      incompleteNestedIntervalCount: 1
    });
    expect(report.failures.recoveredModelAttemptCount).toBe(0);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_SECRET');
    const all = await analyzeSessionDirectory(directory, { timelineLimit: 1 });
    expect(all.codeMode.cellCount).toBe(1);
    expect(all.failures.modelAttempts).toHaveLength(1);
    const withoutExamples = await analyzeSessionDirectory(directory, { timelineLimit: 0 });
    expect(withoutExamples.failures.modelAttemptFailureCount).toBe(1);
    expect(withoutExamples.failures.modelAttempts).toEqual([]);
  });

  it('deduplicates cell snapshots and measures concurrency from tool intervals, not source text', async () => {
    const directory = await createSessionDirectory();
    const result = (callId: string, type: string, toolName?: string) => ({
      type,
      id: `${callId}-${type}`,
      source: { callId, toolName },
      result: { content: 'PRIVATE_TOOL_BODY' },
      format: 'text',
      value: 'PRIVATE_VALUE'
    });
    await writeRecords(directory, 'events-000001.jsonl', [
      record(1, 'model.context', {
        role: 'tool_call',
        name: 'code_exec',
        callId: 'cell',
        arguments: '"Promise.all in a command" PRIVATE_SOURCE'
      }),
      record(2, 'tool.started', { toolName: 'code_exec', callId: 'cell' }),
      record(3, 'tool.started', { toolName: 'read', callId: 'a', parentCallId: 'cell' }),
      record(4, 'tool.started', { toolName: 'exec', callId: 'b', parentCallId: 'cell' }),
      record(5, 'tool.completed', { toolName: 'read', callId: 'a', parentCallId: 'cell' }),
      record(6, 'tool.completed', {
        toolName: 'exec',
        callId: 'b',
        parentCallId: 'cell',
        data: { processId: 'p', status: 'running' }
      }),
      record(7, 'tool.completed', {
        toolName: 'code_exec',
        callId: 'cell',
        data: { cellId: 'handle', status: 'running' }
      }),
      record(8, 'model.context', {
        role: 'tool',
        callId: 'cell',
        observations: [result('a', 'tool_result', 'read'), result('v', 'value')],
        calls: [
          { callId: 'a', toolName: 'read', status: 'completed' },
          { callId: 'b', toolName: 'exec', status: 'completed' }
        ]
      }),
      record(9, 'tool.started', {
        toolName: 'code_exec_wait',
        callId: 'wait',
        input: { cellId: 'handle' }
      }),
      record(10, 'tool.completed', {
        toolName: 'code_exec_wait',
        callId: 'wait',
        data: { cellId: 'handle', status: 'completed' }
      }),
      record(11, 'model.context', {
        role: 'tool',
        callId: 'wait',
        observations: [result('a', 'tool_result', 'read'), result('v', 'value')],
        calls: [
          { callId: 'a', toolName: 'read', status: 'completed' },
          { callId: 'b', toolName: 'exec', status: 'completed' }
        ]
      }),
      record(12, 'tool.started', { toolName: 'web_search', callId: 'search' }),
      record(13, 'tool.started', { toolName: 'web_search', callId: 'search' }),
      record(14, 'tool.completed', { toolName: 'web_search', callId: 'search' }),
      record(15, 'tool.started', { toolName: 'code_exec', callId: 'second' }),
      record(16, 'tool.started', { toolName: 'read', callId: 'c', parentCallId: 'second' }),
      record(17, 'tool.completed', { toolName: 'read', callId: 'c', parentCallId: 'second' }),
      record(18, 'tool.started', { toolName: 'read', callId: 'd', parentCallId: 'second' }),
      record(19, 'tool.completed', { toolName: 'read', callId: 'd', parentCallId: 'second' }),
      record(20, 'tool.completed', {
        toolName: 'code_exec',
        callId: 'second',
        data: { cellId: 'second-handle', status: 'completed' }
      })
    ]);
    const report = await analyzeSessionDirectory(directory);
    expect(report.codeMode).toMatchObject({
      cellCount: 2,
      nestedCallCount: 4,
      multiToolCellCount: 2,
      concurrentCellCount: 1,
      waitCallCount: 1,
      observations: { tool_result: 1, value: 1 },
      unobservedCompletedCallCount: 3
    });
    expect(report.tools.startedByName.web_search).toBe(1);
    const filtered = await analyzeSessionDirectory(directory, { sinceSequence: 9 });
    expect(filtered.codeMode).toMatchObject({ cellCount: 2, concurrentCellCount: 1 });
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_(?:TOOL_BODY|VALUE|SOURCE)/);
  });

  it('retains independent unknown-cell wait failures alongside correlated nested failures', async () => {
    const directory = await createSessionDirectory();
    const error = 'MAR_AGENT_CODE_CELL_NOT_FOUND';
    await writeRecords(directory, 'events-000001.jsonl', [
      record(1, 'tool.started', { toolName: 'code_exec', callId: 'cell' }),
      record(2, 'tool.started', { toolName: 'apply_patch', callId: 'patch', parentCallId: 'cell' }),
      record(3, 'tool.failed', {
        toolName: 'apply_patch',
        callId: 'patch',
        code: 'MAR_AGENT_PATCH_CONFLICT'
      }),
      record(4, 'tool.failed', {
        toolName: 'code_exec',
        callId: 'cell',
        code: 'MAR_AGENT_PATCH_CONFLICT'
      }),
      record(5, 'tool.started', {
        toolName: 'code_exec_wait',
        callId: 'wait-1',
        input: { cellId: 'unknown-1' }
      }),
      record(6, 'tool.failed', { toolName: 'code_exec_wait', callId: 'wait-1', code: error }),
      record(7, 'tool.started', {
        toolName: 'code_exec_wait',
        callId: 'wait-2',
        input: { cellId: 'unknown-2' }
      }),
      record(8, 'tool.failed', { toolName: 'code_exec_wait', callId: 'wait-2', code: error })
    ]);
    const report = await analyzeSessionDirectory(directory);
    expect(report.failures).toMatchObject({
      failedToolCallCount: 4,
      correlatedCellFailureCount: 1,
      distinctToolFailureCount: 3
    });
    const isolated = await analyzeSessionDirectory(directory, { sinceSequence: 7 });
    expect(isolated.failures).toMatchObject({
      failedToolCallCount: 1,
      correlatedCellFailureCount: 0,
      distinctToolFailureCount: 1
    });
  });

  it('separates correlated cell failures, command exits and model retries without logging diagnostics', async () => {
    const directory = await createSessionDirectory();
    await writeRecords(directory, 'events-000001.jsonl', [
      record(1, 'tool.started', { toolName: 'code_exec', callId: 'cell' }),
      record(2, 'tool.started', {
        toolName: 'apply_patch',
        callId: 'patch',
        parentCallId: 'cell',
        input: 'PRIVATE_PATCH'
      }),
      record(3, 'tool.failed', {
        toolName: 'apply_patch',
        callId: 'patch',
        parentCallId: 'cell',
        code: 'MAR_AGENT_PATCH_PARTIAL',
        message: 'PRIVATE_ERROR',
        data: {
          files: [{ path: 'PRIVATE_PATH', operation: 'modified' }],
          failedFile: 'PRIVATE_FAILED',
          pendingFiles: []
        }
      }),
      record(4, 'tool.failed', {
        toolName: 'code_exec',
        callId: 'cell',
        code: 'MAR_AGENT_PATCH_PARTIAL',
        message: 'PRIVATE_ERROR',
        data: { cellId: 'handle', status: 'failed' }
      }),
      record(5, 'tool.completed', {
        toolName: 'exec',
        callId: 'exec',
        data: { processId: 'process', status: 'completed', exitCode: 2 }
      }),
      record(6, 'tool.completed', {
        toolName: 'exec_wait',
        callId: 'poll',
        data: { processId: 'process', status: 'completed', exitCode: 2, cached: true }
      }),
      record(
        7,
        'model.attempt',
        {
          state: 'FAILED',
          errorCode: 'MAR_AGENT_MODEL_PROTOCOL_ERROR',
          message: 'PRIVATE_PROVIDER'
        },
        'execution'
      ),
      record(8, 'model.attempt', { state: 'SUCCEEDED' }, 'execution'),
      record(
        9,
        'model.attempt',
        { state: 'FAILED', errorCode: 'MAR_AGENT_CANCELLED' },
        'cancelled'
      ),
      record(10, 'tool.started', {
        toolName: 'code_exec_wait',
        callId: 'wait',
        input: { cellId: 'handle' }
      }),
      record(11, 'tool.failed', {
        toolName: 'code_exec_wait',
        callId: 'wait',
        code: 'MAR_AGENT_PATCH_PARTIAL'
      })
    ]);
    const report = await analyzeSessionDirectory(directory);
    expect(report.failures).toMatchObject({
      failedToolCallCount: 3,
      correlatedCellFailureCount: 2,
      distinctToolFailureCount: 1,
      nonzeroProcessCount: 1,
      modelAttemptFailureCount: 2,
      cancelledModelAttemptCount: 1,
      recoveredModelAttemptCount: 1
    });
    expect(report.failures.partialPatches[0]).toMatchObject({
      sequence: 3,
      appliedFileCount: 1,
      pendingFileCount: 0
    });
    expect(JSON.stringify(report)).not.toContain('PRIVATE_');
  });

  it('annotates GC evidence and adjacent usage without claiming checkpoint validation by default', async () => {
    const directory = await createSessionDirectory();
    await writeRecords(directory, 'events-000001.jsonl', [
      record(1, 'tool.started', {
        toolName: 'read',
        callId: 'read',
        input: { reads: [{ path: 'a.txt' }] }
      }),
      record(2, 'tool.completed', { toolName: 'read', callId: 'read' }),
      record(3, 'tool.failed', {
        toolName: 'apply_patch',
        callId: 'patch',
        parentCallId: 'cell',
        code: 'MAR_AGENT_PATCH_PARTIAL',
        data: {
          files: [{ path: 'a.txt', operation: 'modified' }],
          failedFile: 'b.txt',
          pendingFiles: []
        }
      }),
      record(
        4,
        'usage.updated',
        { inputTokens: 100, contextInputTokens: 100, cacheReadTokens: 90 },
        'execution'
      ),
      record(5, 'context.gc.completed', {
        replacements: [
          {
            kind: 'READ_OUTPUT_ITEMS',
            target: { callId: 'read' },
            items: [{ path: 'a.txt', supersededByCallId: 'patch' }]
          }
        ]
      }),
      record(
        6,
        'usage.updated',
        { inputTokens: 60, contextInputTokens: 60, cacheReadTokens: 10 },
        'execution'
      ),
      record(7, 'model.attempt', { state: 'SUCCEEDED' }, 'execution'),
      record(
        8,
        'usage.updated',
        { inputTokens: 62, contextInputTokens: 62, cacheReadTokens: 60 },
        'execution'
      )
    ]);
    const report = await analyzeSessionDirectory(directory);
    expect(report.gc[0]).toMatchObject({
      validation: 'not_requested',
      beforeUsage: { contextInputTokens: 100 },
      adjacentInputReductionRate: 0.4,
      secondFollowingUsage: { contextInputTokens: 62, cacheReadTokens: 60 },
      evidence: {
        replacementKinds: { READ_OUTPUT_ITEMS: 1 },
        partialPatchReadItemCount: 1,
        partialPatchInputTargetCount: 0
      }
    });
    expect(report.failures.partialPatches[0]).toMatchObject({ priorStructuredReadCount: 1 });
    const calls: number[][] = [];
    const verified = await analyzeSessionDirectory(directory, {
      sinceSequence: 5,
      checkpointValidator: (
        records: Array<{ sequence: number }>,
        checkpoint: { sequence: number }
      ) => {
        calls.push(records.map((r) => r.sequence));
        return checkpoint.sequence === 5;
      }
    });
    expect(calls).toEqual([[1, 2, 3, 4, 5]]);
    expect(verified.gc[0].validation).toBe('valid');
    expect(verified.failures.partialPatches).toHaveLength(0);
    expect(verified.gc[0].evidence.partialPatchReadItemCount).toBe(1);
  });

  it('coalesces input and final snapshots across segments, filters, and GC horizons', async () => {
    const directory = await createSessionDirectory();
    const input = { inputTokens: 20, contextInputTokens: 100, cacheReadTokens: 80 };
    await writeRecords(directory, 'events-000001.jsonl', [
      record(1, 'execution.started', {}, 'exec-1'),
      record(2, 'context.gc.completed', {}, undefined),
      record(3, 'usage.updated', input, 'exec-1'),
      record(4, 'reasoning.summary', { text: 'PRIVATE_MARKER_MUST_NOT_APPEAR' }, 'exec-1'),
      record(5, 'message.completed', { text: 'PRIVATE_MARKER_MUST_NOT_APPEAR' }, 'exec-1')
    ]);
    await writeRecords(directory, 'events-000002.jsonl', [
      record(6, 'usage.updated', { ...input, outputTokens: 10 }, 'exec-1'),
      record(7, 'tool.started', { toolName: 'read' }, 'exec-1'),
      record(8, 'usage.updated', input, 'exec-1'),
      record(9, 'usage.updated', { ...input, outputTokens: 10 }, 'exec-1'),
      record(10, 'usage.updated', { ...input, outputTokens: 10 }, 'exec-1'),
      record(11, 'execution.completed', {}, 'exec-1')
    ]);
    const report = await analyzeSessionDirectory(directory);
    expect(report.usage).toMatchObject({
      requestCount: 3,
      inputTokens: 60,
      contextInputTokens: 300,
      cacheReadTokens: 240,
      outputTokens: 30,
      cacheHitRate: 0.8
    });
    expect(report.executions[0].usage).toEqual(report.usage);
    expect(report.executions[0].firstUsage).toMatchObject({ requestCount: 1, outputTokens: 10 });
    expect(report.gc[0]).toMatchObject({
      followingUsageCount: 3,
      firstFollowingUsage: { sequence: 3, cacheHitRate: 0.8 }
    });
    const filtered = await analyzeSessionDirectory(directory, {
      sinceSequence: 5,
      executionId: 'exec-1'
    });
    expect(filtered.usage).toEqual(report.usage);
    expect(filtered.range.firstSequence).toBe(5);
    expect(filtered.executions[0].firstUsage.outputTokens).toBe(10);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_MARKER_MUST_NOT_APPEAR');
  });

  it('selects metrics in a half-open timestamp window while retaining prefix pairing context', async () => {
    const directory = await createSessionDirectory();
    const windowStart = '2026-11-12T13:00:00.000Z';
    const windowEnd = '2026-11-12T14:00:00.000Z';
    await writeRecords(directory, 'events-000001.jsonl', [
      {
        ...record(1, 'tool.started', { callId: 'prefix-call', toolName: 'exec' }, 'exec-1'),
        timestamp: '2026-11-12T12:59:59.000Z'
      },
      {
        ...record(
          2,
          'usage.updated',
          { inputTokens: 20, contextInputTokens: 100, cacheReadTokens: 80 },
          'exec-1'
        ),
        timestamp: '2026-11-12T12:59:59.500Z'
      },
      {
        ...record(
          3,
          'usage.updated',
          { inputTokens: 25, contextInputTokens: 125, cacheReadTokens: 100, outputTokens: 5 },
          'exec-1'
        ),
        timestamp: '2026-11-12T08:00:00.000-05:00'
      },
      {
        ...record(4, 'execution.started', {}, 'exec-2'),
        timestamp: '2026-11-12T13:30:00.000Z'
      },
      {
        ...record(5, 'tool.completed', { callId: 'prefix-call', toolName: 'exec' }, 'exec-1'),
        timestamp: '2026-11-12T13:45:00.000Z'
      },
      {
        ...record(
          6,
          'usage.updated',
          { inputTokens: 999, contextInputTokens: 999, outputTokens: 99 },
          'exec-1'
        ),
        timestamp: '2026-11-12T15:00:00.000+01:00'
      }
    ]);

    const legacy = await analyzeSessionDirectory(directory, {
      sinceSequence: 3,
      executionId: 'exec-1'
    });
    expect(legacy.range.recordCount).toBe(3);
    expect(legacy.usage.requestCount).toBe(2);

    const filtered = await analyzeSessionDirectory(directory, {
      sinceSequence: 3,
      executionId: 'exec-1',
      windowStart,
      windowEnd
    });
    expect(filtered.range).toMatchObject({ recordCount: 2, firstSequence: 3, lastSequence: 5 });
    expect(filtered.usage).toMatchObject({
      requestCount: 1,
      inputTokens: 25,
      contextInputTokens: 125,
      cacheReadTokens: 100,
      outputTokens: 5
    });
    expect(filtered.tools.completedByName.exec).toBe(1);
  });

  it('validates an optional timestamp window before reading session records', async () => {
    await expect(
      analyzeSessionDirectory('/missing-session-directory', {
        windowStart: 'not-a-timestamp',
        windowEnd: '2026-11-12T14:00:00.000Z'
      })
    ).rejects.toThrow(TypeError);
    await expect(
      analyzeSessionDirectory('/missing-session-directory', {
        windowStart: '2026-11-12T13:00:00.000Z'
      })
    ).rejects.toThrow(TypeError);
    await expect(
      analyzeSessionDirectory('/missing-session-directory', {
        windowStart: '2026-11-12T14:00:00.000Z',
        windowEnd: '2026-11-12T14:00:00.000Z'
      })
    ).rejects.toThrow(TypeError);
  });

  it('retains partial usage at retry, execution, structural, and end-of-log boundaries', async () => {
    const directory = await createSessionDirectory();
    const input = { inputTokens: 5, contextInputTokens: 20, cacheReadTokens: 15 };
    await writeRecords(directory, 'events-000001.jsonl', [
      record(1, 'usage.updated', input, 'exec-1'),
      record(2, 'model.attempt', { state: 'FAILED' }, 'exec-1'),
      record(3, 'model.attempt', { state: 'STARTED' }, 'exec-1'),
      record(4, 'usage.updated', { ...input, outputTokens: 0 }, 'exec-1'),
      record(5, 'usage.updated', input, 'exec-1'),
      record(6, 'usage.updated', input, 'exec-1'),
      record(7, 'execution.failed', {}, 'exec-1'),
      record(8, 'usage.updated', input, 'exec-2'),
      record(9, 'context.gc.completed', {}, undefined),
      record(10, 'usage.updated', { ...input, outputTokens: 2 }, 'exec-2'),
      record(11, 'usage.updated', input, 'exec-2'),
      record(12, 'usage.updated', { ...input, inputTokens: 6, outputTokens: 3 }, 'exec-2'),
      record(13, 'usage.updated', input, 'exec-2')
    ]);
    const report = await analyzeSessionDirectory(directory);
    expect(report.usage).toMatchObject({ requestCount: 8, inputTokens: 41, outputTokens: 5 });
    expect(report.executions.map((item) => item.requestCount)).toEqual([4, 4]);
    expect(report.gc[0].followingUsageCount).toBe(3);
    const partial = await analyzeSessionDirectory(directory, { sinceSequence: 13 });
    expect(partial.usage).toMatchObject({ requestCount: 1, inputTokens: 5, outputTokens: 0 });
  });

  it('keeps background tool events inside a response and accepts final input corrections', async () => {
    const directory = await createSessionDirectory();
    const input = { inputTokens: 20, contextInputTokens: 100, cacheReadTokens: 80 };
    await writeRecords(directory, 'events-000001.jsonl', [
      record(1, 'context.gc.completed', {}, undefined),
      record(2, 'usage.updated', input, 'exec-1'),
      record(3, 'tool.started', { toolName: 'read', parentCallId: 'background-cell' }, 'exec-1'),
      record(
        4,
        'usage.updated',
        {
          inputTokens: 25,
          contextInputTokens: 125,
          cacheReadTokens: 100,
          outputTokens: 5
        },
        'exec-1'
      ),
      record(5, 'usage.updated', input, 'exec-1'),
      record(6, 'tool.started', { toolName: 'read' }, 'exec-1'),
      record(7, 'usage.updated', { ...input, outputTokens: 5 }, 'exec-1')
    ]);
    const report = await analyzeSessionDirectory(directory);
    expect(report.usage).toMatchObject({
      requestCount: 3,
      inputTokens: 65,
      contextInputTokens: 325
    });
    expect(report.executions[0].firstUsage).toMatchObject({
      requestCount: 1,
      inputTokens: 25,
      outputTokens: 5
    });
    expect(report.gc[0]).toMatchObject({
      followingUsageCount: 3,
      firstFollowingUsage: {
        sequence: 2,
        contextInputTokens: 125,
        cacheReadTokens: 100
      }
    });
    expect((await analyzeSessionDirectory(directory, { sinceSequence: 3 })).usage).toEqual(
      report.usage
    );
  });

  it('keeps concurrent executions and input-only tails independent', async () => {
    const directory = await createSessionDirectory();
    await writeRecords(directory, 'events-000001.jsonl', [
      record(1, 'usage.updated', { inputTokens: 10, contextInputTokens: 10 }, 'exec-1'),
      record(2, 'usage.updated', { inputTokens: 20, contextInputTokens: 20 }, 'exec-2'),
      record(
        3,
        'usage.updated',
        { inputTokens: 10, contextInputTokens: 10, outputTokens: 1 },
        'exec-1'
      ),
      record(4, 'execution.failed', {}, 'exec-2')
    ]);
    const report = await analyzeSessionDirectory(directory);
    expect(report.usage).toMatchObject({ requestCount: 2, inputTokens: 30, outputTokens: 1 });
    expect(report.executions.map((item) => item.requestCount)).toEqual([1, 1]);
    const filtered = await analyzeSessionDirectory(directory, {
      executionId: 'exec-2',
      sinceSequence: 3
    });
    expect(filtered.usage.requestCount).toBe(0);
  });

  it('streams segmented JSONL and reports stable usage, continuation, GC, and subagent metrics', async () => {
    const directory = await createSessionDirectory();
    await writeRecords(directory, 'events-000001.jsonl', [
      record(1, 'execution.started', {}, 'exec-1'),
      record(
        2,
        'model.attempt',
        {
          state: 'STARTED',
          continuation: false,
          credentialReason: 'REQUEST',
          protocol: 'OPENAI_RESPONSES',
          transport: 'WEBSOCKET'
        },
        'exec-1'
      ),
      record(
        3,
        'usage.updated',
        {
          inputTokens: 100,
          contextInputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 20,
          cacheWriteTokens: 0
        },
        'exec-1'
      ),
      record(
        4,
        'model.attempt',
        { state: 'SUCCEEDED', continuation: false, connectionReused: false },
        'exec-1'
      ),
      record(5, 'responses.continuation', { checkpoint: { inputPrefixLength: 12 } }, 'exec-1'),
      record(6, 'execution.completed', {}, 'exec-1')
    ]);
    await writeRecords(
      directory,
      'events-000002.jsonl',
      [
        record(7, 'execution.started', {}, 'exec-2'),
        record(
          8,
          'model.attempt',
          {
            state: 'STARTED',
            continuation: true,
            credentialReason: 'REQUEST',
            protocol: 'OPENAI_RESPONSES',
            transport: 'WEBSOCKET'
          },
          'exec-2'
        ),
        record(
          9,
          'usage.updated',
          {
            inputTokens: 200,
            contextInputTokens: 200,
            outputTokens: 20,
            cacheReadTokens: 180,
            cacheWriteTokens: 0
          },
          'exec-2'
        ),
        record(
          10,
          'model.attempt',
          { state: 'SUCCEEDED', continuation: true, connectionReused: true },
          'exec-2'
        ),
        record(
          11,
          'context.gc.completed',
          {
            base: { type: 'COMPACT' },
            generation: 2,
            replacements: [{ kind: 'EXEC_OUTPUT' }],
            trigger: { contextInputTokens: 200 },
            metrics: {
              stage: 'STAGE_A_AND_EXEC',
              beforeTokens: 200,
              afterTokens: 150,
              reclaimedTokens: 50,
              grossReductionRate: 0.25,
              projectedRolloutsUntilCompactAfterGc: 8
            }
          },
          undefined
        ),
        record(
          12,
          'compact.completed',
          { automatic: true, boundarySequence: 10, summary: 'Dense handoff' },
          'exec-2'
        ),
        record(13, 'subagent.started', { agentId: 'agent-1' }, 'exec-2'),
        record(
          14,
          'tool.started',
          { toolName: 'agent_wait', callId: 'call-1', input: { waitMs: 300_000 } },
          'exec-2'
        ),
        record(
          15,
          'tool.completed',
          {
            toolName: 'agent_wait',
            callId: 'call-1',
            data: { status: 'running', waitOutcome: 'timeout' }
          },
          'exec-2'
        ),
        record(16, 'subagent.completed', { agentId: 'agent-1', status: 'completed' }, 'exec-2'),
        record(
          17,
          'message.completed',
          { phase: 'final_answer', text: 'PRIVATE_MARKER_MUST_NOT_APPEAR' },
          'exec-2'
        ),
        record(18, 'execution.completed', {}, 'exec-2')
      ],
      '{not-json}\n'
    );

    const report = await analyzeSessionDirectory(directory);

    expect(report.range).toMatchObject({
      recordCount: 18,
      firstSequence: 1,
      lastSequence: 18
    });
    expect(report.usage).toMatchObject({
      requestCount: 2,
      inputTokens: 300,
      outputTokens: 30,
      totalTokens: 330,
      cacheReadTokens: 200,
      uncachedInputTokens: 100,
      cacheHitRate: 2 / 3
    });
    expect(report.executions).toHaveLength(2);
    expect(report.executions[1]).toMatchObject({
      executionId: 'exec-2',
      requestCount: 1,
      firstContinuation: true,
      lastConnectionReused: true,
      terminal: 'execution.completed'
    });
    expect(report.continuationTransitions).toEqual([
      expect.objectContaining({
        previousExecutionId: 'exec-1',
        executionId: 'exec-2',
        previousCheckpointCount: 1,
        firstContinuation: true,
        firstCacheHitRate: 0.9
      })
    ]);
    expect(report.gc).toEqual([
      expect.objectContaining({
        stage: 'STAGE_A_AND_EXEC',
        reclaimedTokens: 50,
        replacementCount: 1,
        followingUsageCount: 0,
        nextStructuralEvent: {
          sequence: 12,
          type: 'compact.completed'
        }
      })
    ]);
    expect(report.compacts).toEqual([
      expect.objectContaining({ automatic: true, boundarySequence: 10 })
    ]);
    expect(report.subagents).toMatchObject({
      started: 1,
      completed: 1,
      waits: 1,
      waitCompletions: 1,
      waitTimeouts: 1
    });
    expect(report.diagnostics.malformedLines).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_MARKER_MUST_NOT_APPEAR');
    expect(formatSessionAnalysis(report)).toContain('66.67% hit');
  });

  it('supports bounded JSON CLI output without exposing message bodies', async () => {
    const directory = await createSessionDirectory();
    await writeRecords(directory, 'events-000001.jsonl', [
      record(1, 'execution.started', {}, 'exec-1'),
      record(
        2,
        'usage.updated',
        {
          inputTokens: 10,
          contextInputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 8,
          cacheWriteTokens: 0
        },
        'exec-1'
      ),
      record(3, 'message.completed', { text: 'PRIVATE_MARKER_MUST_NOT_APPEAR' }, 'exec-1')
    ]);

    const tool = resolve(import.meta.dirname, '../tools/session-analyzer.mjs');
    const { stdout } = await execFileAsync(process.execPath, [
      tool,
      '--session-dir',
      directory,
      '--json'
    ]);
    const output = JSON.parse(stdout);

    expect(output.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      cacheHitRate: 0.8
    });
    expect(stdout).not.toContain('PRIVATE_MARKER_MUST_NOT_APPEAR');
  });

  it('correlates structural replacements with the next Execution and cache rebuild', async () => {
    const directory = await createSessionDirectory();
    await writeRecords(directory, 'events-000001.jsonl', [
      record(1, 'execution.started', {}, 'exec-1'),
      record(2, 'responses.continuation', { checkpoint: { inputPrefixLength: 10 } }, 'exec-1'),
      record(3, 'execution.completed', {}, 'exec-1'),
      record(
        4,
        'context.gc.completed',
        {
          replacements: [],
          trigger: { contextInputTokens: 100 },
          metrics: {
            stage: 'STAGE_A',
            reclaimedTokens: 20,
            grossReductionRate: 0.2
          }
        },
        undefined
      ),
      record(5, 'execution.started', {}, 'exec-2'),
      record(6, 'model.attempt', { state: 'STARTED', continuation: false }, 'exec-2'),
      record(
        7,
        'usage.updated',
        {
          inputTokens: 80,
          contextInputTokens: 80,
          outputTokens: 5,
          cacheReadTokens: 8,
          cacheWriteTokens: 0
        },
        'exec-2'
      )
    ]);

    const report = await analyzeSessionDirectory(directory);

    expect(report.continuationTransitions[0]).toMatchObject({
      previousExecutionId: 'exec-1',
      executionId: 'exec-2',
      previousCheckpointCount: 1,
      firstContinuation: false,
      firstCacheHitRate: 0.1,
      mutations: [{ sequence: 4, type: 'context.gc.completed' }]
    });
    expect(report.gc[0]).toMatchObject({
      followingUsageCount: 1,
      firstFollowingUsage: {
        sequence: 7,
        contextInputTokens: 80,
        cacheReadTokens: 8,
        cacheHitRate: 0.1
      }
    });
  });
});

async function createSessionDirectory() {
  const root = await mkdtemp(join(tmpdir(), 'mar-session-analyzer-'));
  temporaryDirectories.push(root);
  const directory = join(root, 'session');
  await mkdir(directory);
  return directory;
}

async function writeRecords(directory: string, fileName: string, records: object[], suffix = '') {
  await writeFile(
    join(directory, fileName),
    `${records.map((item) => JSON.stringify(item)).join('\n')}\n${suffix}`
  );
}

function record(
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
  executionId?: string
) {
  return {
    schemaVersion: 1,
    recordId: `record-${sequence}`,
    sequence,
    timestamp: `2026-09-17T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    sessionId: 'session-1',
    executionId,
    type,
    payload: { type, ...payload }
  };
}
