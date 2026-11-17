import { describe, expect, it, vi } from 'vitest';
import { runPerformanceSchema, type RunPerformance } from '@myagentroam/protocol';
import type { ModelUsageObservation } from '@myagentroam/agent';
import { NodeRunEventBridge } from '../../src/service/node-run-event-bridge.js';
import { RunEventService } from '../../src/service/run-event-service.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { CodexUsageNormalizer } from '../../src/runner/codex/conversation-parser.js';
import { ClaudeUsageNormalizer } from '../../src/runner/claude/tool-normalizer.js';
import { OpenCodeUsageNormalizer } from '../../src/runner/opencode/conversation-parser.js';
import { normalizeMarAgentUsage } from '../../src/runner/mar-agent/conversation-normalizer.js';

function fixture() {
  const metrics: RunPerformance[] = [];
  const ledger = vi.fn();
  const runtime = new NodeRuntimeState(
    () => 'node',
    (id) => ({
      id,
      path: '/workspace',
      kind: 'DIRECTORY',
      gitSummary: null
    })
  );
  const session = runtime.createAgentSession({
    workspaceId: 'workspace',
    runner: 'codex',
    cwd: '/workspace',
    title: 'performance'
  });
  const run = runtime.createMessageRun({
    sessionId: session.id,
    clientMessageId: 'message',
    content: 'test',
    initiatedByUserId: 7
  }).run;
  const execution = runtime.createExecution(run.id);
  runtime.executionAccepted(execution.id);
  const service = new RunEventService({
    runtime,
    emitWorkbench: (_category: string, payload: { performance: unknown }) =>
      metrics.push(runPerformanceSchema.parse(payload.performance))
  } as never);
  const bridge = new NodeRunEventBridge({
    events: service,
    queues: {} as never,
    modelUsage: ledger,
    send: vi.fn(),
    emitWorkbench: vi.fn()
  });
  return {
    metrics,
    ledger,
    runtime,
    service,
    run,
    execution,
    publish: (fact: unknown) => bridge.emitRun(execution.id, 'run.usage', fact)
  };
}

function marUsage(overrides: Partial<ModelUsageObservation> = {}): ModelUsageObservation {
  return {
    recordId: 'record',
    requestId: 'request',
    revision: 2,
    sessionId: 'session',
    executionId: 'execution',
    purpose: 'conversation',
    agentRole: 'root',
    modelConfigurationId: 'config',
    modelName: 'MAR model',
    provider: 'OPENAI_RESPONSES',
    requestedModel: 'configured',
    startedAt: 100,
    endedAt: 200,
    state: 'succeeded',
    inputTokens: '24000',
    outputTokens: '1280',
    cacheReadTokens: '19200',
    ...overrides
  };
}

describe('normalized request usage to transient performance', () => {
  it.each(['succeeded', 'failed', 'cancelled', 'interrupted'] as const)(
    'projects MAR SDK %s usage without ledger attribution or provider reinterpretation',
    (state) => {
      const f = fixture();
      const fact = normalizeMarAgentUsage(marUsage({ state }));
      f.publish(fact);
      expect(f.metrics).toEqual([
        {
          runId: f.run.id,
          usage: {
            inputTokens: '24000',
            outputTokens: '1280',
            cacheReadTokens: '19200'
          }
        }
      ]);
      expect(f.ledger).toHaveBeenCalledExactlyOnceWith(f.execution.id, fact);
      expect(f.metrics[0]).not.toHaveProperty('modelConfigurationId');
    }
  );

  it('retains MAR unknown fields rather than replacing them with ledger zeros', () => {
    const f = fixture();
    const outputOnly = normalizeMarAgentUsage(marUsage({ outputTokens: '0' }));
    delete outputOnly.inputTokens;
    delete outputOnly.cacheReadTokens;
    f.publish(outputOnly);
    expect(f.metrics).toEqual([{ runId: f.run.id, usage: { outputTokens: '0' } }]);
  });

  it.each([
    { purpose: 'compact' as const },
    { purpose: 'title' as const },
    { purpose: 'other' as const },
    { agentRole: 'subagent' as const },
    { state: 'running' as const, endedAt: undefined },
    { inputTokens: undefined, outputTokens: undefined, cacheReadTokens: undefined }
  ])('excludes non-display MAR facts without suppressing accounting: %j', (overrides) => {
    const f = fixture();
    const fact = { ...normalizeMarAgentUsage(marUsage()), ...overrides };
    f.publish(fact);
    expect(f.metrics).toEqual([]);
    expect(f.runtime.sessionPerformance(f.run.sessionId)).toBeUndefined();
    expect(f.ledger).toHaveBeenCalledExactlyOnceWith(f.execution.id, fact);
  });

  it('projects Codex request receipts, never the cumulative or last usage snapshot', () => {
    const f = fixture();
    const normalizer = new CodexUsageNormalizer('run', f.publish);
    normalizer.observe(
      'thread/tokenUsage/updated',
      { tokenUsage: { total: { inputTokens: 9999 }, last: { inputTokens: 999 } } },
      false
    );
    expect(f.metrics).toEqual([]);
    normalizer.observe(
      'rawResponse/completed',
      { responseId: 'r', usage: { inputTokens: 20, outputTokens: 7, cachedInputTokens: 10 } },
      false
    );
    expect(f.metrics).toEqual([
      { runId: f.run.id, usage: { inputTokens: '20', outputTokens: '7', cacheReadTokens: '10' } }
    ]);
    normalizer.observe(
      'rawResponse/completed',
      { responseId: 'compact', usage: { inputTokens: 9999 } },
      true
    );
    expect(f.metrics).toHaveLength(1);
  });

  it('keeps the newest observed request when an earlier receipt is revised in the same millisecond', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100);
    try {
      const f = fixture();
      const normalizer = new CodexUsageNormalizer('run', f.publish);
      const receipt = (responseId: string, inputTokens: number) =>
        normalizer.observe('rawResponse/completed', { responseId, usage: { inputTokens } }, false);
      receipt('first', 10);
      receipt('second', 20);
      receipt('first', 11);
      expect(f.metrics.at(-1)?.usage).toEqual({ inputTokens: '20' });
      expect(f.ledger).toHaveBeenCalledTimes(3);
      receipt('second', 21);
      expect(f.metrics.at(-1)?.usage).toEqual({ inputTokens: '21' });
    } finally {
      clock.mockRestore();
    }
  });

  it('ignores duplicate and older MAR revisions without losing first-observed request order', () => {
    const f = fixture();
    const fact = (requestId: string, revision: number, inputTokens: string) =>
      normalizeMarAgentUsage(
        marUsage({
          recordId: requestId,
          requestId,
          revision,
          inputTokens,
          outputTokens: '3',
          cacheReadTokens: '0'
        })
      );
    f.publish(fact('first', 3, '30'));
    f.publish(fact('first', 2, '20'));
    f.publish(fact('first', 3, '25'));
    expect(f.metrics).toHaveLength(1);
    f.publish({ ...fact('second', 1, '50'), state: 'running' });
    expect(f.metrics.at(-1)?.usage?.inputTokens).toBe('30');
    f.publish(fact('first', 4, '40'));
    expect(f.metrics.at(-1)?.usage?.inputTokens).toBe('40');
    f.publish(fact('third', 2, '60'));
    f.publish(fact('first', 5, '45'));
    f.publish(fact('second', 2, '50'));
    expect(f.metrics.at(-1)?.usage?.inputTokens).toBe('60');
    expect(f.ledger).toHaveBeenCalledTimes(8);
    expect(f.runtime.lastRunSequence(f.run.id)).toBe(0);
  });

  it('scopes request markers to the active execution without clearing retained metric groups', () => {
    const f = fixture();
    f.service.emit(f.execution.id, 'run.performance', { latencyMs: 100, tokensPerSecond: 42 });
    f.publish(normalizeMarAgentUsage(marUsage({ revision: 5 })));
    f.runtime.acceptExecutionTerminal({
      runId: f.execution.id,
      sequence: 1,
      eventType: 'run.completed',
      payload: {},
      status: 'SUCCEEDED',
      pauseQueue: false
    });
    f.runtime.createQueueItem({
      sessionId: f.run.sessionId,
      clientMessageId: 'next',
      content: 'next',
      initiatedByUserId: 7
    });
    f.runtime.claimNextQueueItem(f.run.sessionId);
    const next = f.runtime.createExecution(f.run.id);
    f.runtime.executionAccepted(next.id);
    f.publish(normalizeMarAgentUsage(marUsage({ revision: 6, inputTokens: '99999' })));
    expect(f.runtime.sessionPerformance(f.run.sessionId)?.usage?.inputTokens).toBe('24000');
    f.service.emit(
      next.id,
      'run.usage',
      normalizeMarAgentUsage(
        marUsage({
          revision: 1,
          inputTokens: '0',
          outputTokens: '0',
          cacheReadTokens: '0'
        })
      )
    );
    expect(f.runtime.sessionPerformance(f.run.sessionId)).toEqual({
      runId: f.run.id,
      latencyMs: 100,
      tokensPerSecond: 42,
      usage: { inputTokens: '0', outputTokens: '0', cacheReadTokens: '0' }
    });
    f.runtime.finishRun(f.run.id, 'SUCCEEDED');
    const count = f.metrics.length;
    f.service.emit(next.id, 'run.usage', normalizeMarAgentUsage(marUsage()));
    expect(f.metrics).toHaveLength(count);
    expect(f.runtime.sessionPerformance(f.run.sessionId)).toBeUndefined();
  });

  it('projects Claude total input including cache and ignores running updates and result totals', () => {
    const f = fixture();
    const normalizer = new ClaudeUsageNormalizer('run', f.publish);
    normalizer.observe({
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: 'm',
          usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 }
        }
      }
    });
    expect(f.metrics).toEqual([]);
    normalizer.observe({
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 8 }
      }
    });
    expect(f.metrics).toEqual([
      { runId: f.run.id, usage: { inputTokens: '35', outputTokens: '8', cacheReadTokens: '20' } }
    ]);
    normalizer.observe({ type: 'result', usage: { input_tokens: 9999, output_tokens: 9999 } });
    expect(f.metrics).toHaveLength(1);
  });

  it('keeps Claude manual compaction usage in accounting without replacing conversation metrics', () => {
    const f = fixture();
    const normalizer = new ClaudeUsageNormalizer('run', f.publish, true);
    normalizer.observe({
      type: 'assistant',
      message: {
        id: 'compact',
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 10 }
      }
    });
    expect(f.metrics).toEqual([]);
    expect(f.ledger).toHaveBeenCalledExactlyOnceWith(
      f.execution.id,
      expect.objectContaining({ purpose: 'compact', inputTokens: '100', outputTokens: '10' })
    );
  });

  it('projects OpenCode step totals with disjoint cache and reasoning included exactly once', () => {
    const f = fixture();
    const normalizer = new OpenCodeUsageNormalizer('run', f.publish);
    normalizer.observe(
      {
        type: 'message.updated',
        properties: { info: { id: 'm', role: 'assistant', time: { created: 11 } } }
      },
      10
    );
    normalizer.observe(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 's',
            messageID: 'm',
            type: 'step-finish',
            tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } }
          }
        }
      },
      10
    );
    expect(f.metrics).toEqual([
      { runId: f.run.id, usage: { inputTokens: '13', outputTokens: '7', cacheReadTokens: '5' } }
    ]);
  });

  it('keeps OpenCode compaction usage in accounting without replacing conversation metrics', () => {
    const f = fixture();
    const normalizer = new OpenCodeUsageNormalizer('run', f.publish);
    normalizer.observe(
      {
        type: 'message.updated',
        properties: {
          info: { id: 'compact', role: 'assistant', summary: true, time: { created: 11 } }
        }
      },
      10
    );
    normalizer.observe(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'step',
            messageID: 'compact',
            type: 'step-finish',
            tokens: { input: 100, output: 10 }
          }
        }
      },
      10
    );
    expect(f.metrics).toEqual([]);
    expect(f.ledger).toHaveBeenCalledExactlyOnceWith(
      f.execution.id,
      expect.objectContaining({ purpose: 'compact', inputTokens: '100', outputTokens: '10' })
    );
  });
});
