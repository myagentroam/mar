import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeEnvelope } from '@myagentroam/protocol';
import type { CodexAppServerClient } from '../../src/codex-app-server.js';
import type { ClaudeQueryInput } from '../../src/claude-agent-sdk.js';
import type { OpenCodeServerClient } from '../../src/opencode-server.js';
import { CodexRunner } from '../../src/runner/codex-runner.js';
import { CodexManagedRunController } from '../../src/runner/codex/managed-run-controller.js';
import type { ClaudeCodeRunner } from '../../src/runner/claude-code-runner.js';
import { ClaudeManagedRunController } from '../../src/runner/claude/managed-run-controller.js';
import { OpenCodeRunner } from '../../src/runner/opencode-runner.js';
import { OpenCodeManagedRunController } from '../../src/runner/opencode/managed-run-controller.js';
import { ResponseLatencyTracker } from '../../src/service/response-latency-tracker.js';
import { GenerationTimingTracker } from '../../src/service/generation-timing-tracker.js';

afterEach(() => vi.restoreAllMocks());

describe('Native Runner observed response latency', () => {
  it.each(['raw', 'delayed-standard'] as const)(
    'Codex settles %s usage once at the native endpoint and ignores duplicate notifications',
    (usageSource) => {
      let now = 0;
      const emit = vi.fn();
      const runner = new CodexRunner({} as CodexAppServerClient);
      runner.execution.runs.set('run', {
        sessionId: 'session',
        threadId: 'thread',
        turnId: 'turn',
        cwd: '/workspace',
        responseLatency: new ResponseLatencyTracker(() => now),
        generationTiming: new GenerationTimingTracker(() => now)
      });
      const controller = new CodexManagedRunController(runner, {
        emit,
        emitItem: vi.fn(),
        appendImages: () => [],
        session: () => undefined,
        removeActive: vi.fn()
      } as unknown as ConstructorParameters<typeof CodexManagedRunController>[1]);
      const event = (method: string, params: Record<string, unknown> = {}) =>
        controller.handleNotification({
          method,
          params: { threadId: 'thread', turnId: 'turn', ...params }
        });

      event('turn/started');
      now = 100;
      event('item/started', { item: { id: 'reasoning', type: 'reasoning', summary: [] } });
      now = 200;
      event('item/reasoning/textDelta', { itemId: 'reasoning', delta: 'thinking' });
      now = 1_000;
      event('rawResponse/completed', {
        responseId: 'response-1',
        ...(usageSource === 'raw' ? { usage: { outputTokens: 90 } } : {})
      });
      now = 10_000;
      event('thread/tokenUsage/updated', {
        tokenUsage: { last: { outputTokens: 90 }, total: { outputTokens: 999 } }
      });
      now = 11_000;
      event('thread/tokenUsage/updated', {
        tokenUsage: { last: { outputTokens: 90 }, total: { outputTokens: 999 } }
      });
      event('rawResponse/completed', { responseId: 'response-1', usage: { outputTokens: 90 } });

      expect(
        emit.mock.calls.filter(([, type]) => type === 'run.performance').map(([, , value]) => value)
      ).toEqual([{ latencyMs: 100 }, { tokensPerSecond: 100 }]);
    }
  );

  it('Codex uses standard last output usage as a fallback and does not start on command execution', () => {
    let now = 0;
    const emit = vi.fn();
    const runner = new CodexRunner({} as CodexAppServerClient);
    runner.execution.runs.set('run', {
      sessionId: 'session',
      threadId: 'thread',
      turnId: 'turn',
      cwd: '/workspace',
      responseLatency: new ResponseLatencyTracker(() => now),
      generationTiming: new GenerationTimingTracker(() => now)
    });
    const controller = new CodexManagedRunController(runner, {
      emit,
      emitItem: vi.fn(),
      appendImages: () => [],
      session: () => undefined,
      removeActive: vi.fn()
    } as unknown as ConstructorParameters<typeof CodexManagedRunController>[1]);
    const event = (method: string, params: Record<string, unknown> = {}) =>
      controller.handleNotification({
        method,
        params: { threadId: 'thread', turnId: 'turn', ...params }
      });

    event('turn/started');
    now = 100;
    event('item/started', { item: { id: 'reasoning', type: 'reasoning', summary: [] } });
    now = 200;
    event('item/reasoning/textDelta', { itemId: 'reasoning', delta: 'thinking' });
    event('item/started', { item: { id: 'command', type: 'commandExecution', command: 'pwd' } });
    now = 10_000;
    event('item/completed', { item: { id: 'command', type: 'commandExecution', command: 'pwd' } });
    event('thread/tokenUsage/updated', {
      tokenUsage: { last: { outputTokens: 20 }, total: { outputTokens: 20 } }
    });
    expect(
      emit.mock.calls.filter(([, type]) => type === 'run.performance').map(([, , value]) => value)
    ).toEqual([{ latencyMs: 100 }, { tokensPerSecond: 200 }]);
  });

  it.each(['mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageGeneration'] as const)(
    'Codex pauses typed execution tool %s without ending the model request',
    (toolType) => {
      let now = 0;
      const emit = vi.fn();
      const runner = new CodexRunner({} as CodexAppServerClient);
      runner.execution.runs.set('run', {
        sessionId: 'session',
        threadId: 'thread',
        turnId: 'turn',
        cwd: '/workspace',
        responseLatency: new ResponseLatencyTracker(() => now),
        generationTiming: new GenerationTimingTracker(() => now)
      });
      const controller = new CodexManagedRunController(runner, {
        emit,
        emitItem: vi.fn(),
        appendImages: () => [],
        session: () => undefined,
        removeActive: vi.fn()
      } as unknown as ConstructorParameters<typeof CodexManagedRunController>[1]);
      const event = (method: string, params: Record<string, unknown> = {}) =>
        controller.handleNotification({
          method,
          params: { threadId: 'thread', turnId: 'turn', ...params }
        });
      const tool = (id: string) => ({
        id,
        type: toolType,
        arguments: { query: 'status' },
        query: 'status',
        revisedPrompt: 'status'
      });
      const tps = () =>
        emit.mock.calls
          .filter(
            ([, type, value]) => type === 'run.performance' && value?.tokensPerSecond !== undefined
          )
          .map(([, , value]) => value);

      event('turn/started');
      now = 50;
      event('item/started', { item: tool(`${toolType}-before`) });
      now = 100;
      event('item/completed', { item: { ...tool(`${toolType}-before`), status: 'completed' } });
      now = 200;
      event('item/started', { item: { id: 'reasoning', type: 'reasoning', summary: [] } });
      now = 300;
      event('item/reasoning/textDelta', { itemId: 'reasoning', delta: 'before tool' });
      now = 400;
      event('item/started', { item: tool(`${toolType}-during`) });
      now = 500;
      event('item/completed', { item: { ...tool(`${toolType}-during`), status: 'completed' } });
      now = 600;
      event('item/reasoning/textDelta', { itemId: 'reasoning', delta: 'after tool' });
      now = 700;
      event('rawResponse/completed', {
        responseId: `${toolType}-response`,
        usage: { outputTokens: 30 }
      });

      expect(tps()).toEqual([{ tokensPerSecond: 100 }]);
    }
  );

  it('Codex ignores a repeated standard usage snapshot from the prior request', () => {
    let now = 0;
    const emit = vi.fn();
    const runner = new CodexRunner({} as CodexAppServerClient);
    runner.execution.runs.set('run', {
      sessionId: 'session',
      threadId: 'thread',
      turnId: 'turn',
      cwd: '/workspace',
      responseLatency: new ResponseLatencyTracker(() => now),
      generationTiming: new GenerationTimingTracker(() => now)
    });
    const controller = new CodexManagedRunController(runner, {
      emit,
      emitItem: vi.fn(),
      appendImages: () => [],
      session: () => undefined,
      removeActive: vi.fn()
    } as unknown as ConstructorParameters<typeof CodexManagedRunController>[1]);
    const event = (method: string, params: Record<string, unknown> = {}) =>
      controller.handleNotification({
        method,
        params: { threadId: 'thread', turnId: 'turn', ...params }
      });
    const usage = (outputTokens: number, totalOutputTokens: number) =>
      event('thread/tokenUsage/updated', {
        tokenUsage: {
          last: { outputTokens },
          total: { outputTokens: totalOutputTokens }
        }
      });
    const tps = () =>
      emit.mock.calls
        .filter(
          ([, type, value]) => type === 'run.performance' && value?.tokensPerSecond !== undefined
        )
        .map(([, , value]) => value);

    event('turn/started');
    now = 100;
    event('item/started', { item: { id: 'reasoning-1', type: 'reasoning', summary: [] } });
    now = 200;
    event('item/reasoning/textDelta', { itemId: 'reasoning-1', delta: 'first' });
    now = 300;
    event('rawResponse/completed', { responseId: 'response-1', usage: { outputTokens: 10 } });
    now = 350;
    usage(10, 10);
    now = 400;
    event('item/started', { item: { id: 'reasoning-2', type: 'reasoning', summary: [] } });
    now = 500;
    event('item/reasoning/textDelta', { itemId: 'reasoning-2', delta: 'second' });
    now = 600;
    usage(10, 10);
    expect(tps()).toEqual([{ tokensPerSecond: 50 }]);
    now = 700;
    usage(20, 30);

    expect(tps()).toEqual([{ tokensPerSecond: 50 }, { tokensPerSecond: 66.67 }]);
  });

  it('Codex isolates compaction usage from a stale generation window', () => {
    let now = 0;
    const emit = vi.fn();
    const runner = new CodexRunner({} as CodexAppServerClient);
    runner.execution.runs.set('run', {
      sessionId: 'session',
      threadId: 'thread',
      turnId: 'turn',
      cwd: '/workspace',
      responseLatency: new ResponseLatencyTracker(() => now),
      generationTiming: new GenerationTimingTracker(() => now)
    });
    const controller = new CodexManagedRunController(runner, {
      emit,
      emitItem: vi.fn(),
      appendImages: () => [],
      session: () => undefined,
      removeActive: vi.fn()
    } as unknown as ConstructorParameters<typeof CodexManagedRunController>[1]);
    const event = (method: string, params: Record<string, unknown> = {}) =>
      controller.handleNotification({
        method,
        params: { threadId: 'thread', turnId: 'turn', ...params }
      });
    const tps = () =>
      emit.mock.calls
        .filter(
          ([, type, value]) => type === 'run.performance' && value?.tokensPerSecond !== undefined
        )
        .map(([, , value]) => value);

    event('turn/started');
    now = 100;
    event('item/started', { item: { id: 'stale-reasoning', type: 'reasoning', summary: [] } });
    now = 200;
    event('item/reasoning/textDelta', { itemId: 'stale-reasoning', delta: 'stale' });
    now = 250;
    event('item/started', { item: { id: 'compact', type: 'contextCompaction' } });
    now = 300;
    event('rawResponse/completed', {
      responseId: 'compact-response',
      usage: { outputTokens: 999 }
    });
    now = 350;
    event('thread/tokenUsage/updated', {
      tokenUsage: { last: { outputTokens: 999 }, total: { outputTokens: 999 } }
    });
    now = 400;
    event('item/completed', {
      item: { id: 'compact', type: 'contextCompaction', status: 'completed' }
    });
    expect(tps()).toEqual([]);

    now = 500;
    event('item/started', { item: { id: 'fresh-reasoning', type: 'reasoning', summary: [] } });
    now = 600;
    event('item/reasoning/textDelta', { itemId: 'fresh-reasoning', delta: 'fresh' });
    now = 700;
    event('rawResponse/completed', {
      responseId: 'fresh-response',
      usage: { outputTokens: 10 }
    });

    expect(tps()).toEqual([{ tokensPerSecond: 50 }]);
  });

  it('Codex counts text and reasoning, excludes tool output, and resumes after parallel tools', () => {
    let now = 0;
    const emit = vi.fn();
    const runner = new CodexRunner({} as CodexAppServerClient);
    runner.execution.runs.set('run', {
      sessionId: 'session',
      threadId: 'thread',
      turnId: 'turn',
      cwd: '/workspace',
      responseLatency: new ResponseLatencyTracker(() => now)
    });
    const controller = new CodexManagedRunController(runner, {
      emit,
      emitItem: vi.fn(),
      appendImages: () => [],
      session: () => undefined,
      removeActive: vi.fn()
    } as unknown as ConstructorParameters<typeof CodexManagedRunController>[1]);
    const event = (method: string, params: Record<string, unknown> = {}) =>
      controller.handleNotification({
        method,
        params: { threadId: 'thread', turnId: 'turn', ...params }
      });
    event('turn/started');
    event('item/agentMessage/delta', { delta: '' });
    expect(emit.mock.calls.filter(([, type]) => type === 'run.performance')).toHaveLength(0);
    now = 100;
    event('item/reasoning/textDelta', { delta: 'thinking', itemId: 'reasoning' });
    expect(emit.mock.calls.filter(([, type]) => type === 'run.performance')).toHaveLength(1);
    event('item/reasoning/summaryTextDelta', { delta: 'summary', itemId: 'reasoning' });
    for (const id of ['a', 'b'])
      event('item/started', { item: { id, type: 'commandExecution', command: 'pwd' } });
    now = 8_000;
    event('item/commandExecution/outputDelta', { itemId: 'a', delta: 'tool output' });
    event('item/completed', { item: { id: 'a', type: 'commandExecution', command: 'pwd' } });
    now = 10_000;
    event('item/completed', { item: { id: 'b', type: 'commandExecution', command: 'pwd' } });
    now = 10_150;
    event('item/completed', { item: { id: 'b', type: 'commandExecution', command: 'pwd' } });
    event('item/completed', { item: { id: 'reasoning', type: 'reasoning', summary: ['old'] } });
    expect(emit.mock.calls.filter(([, type]) => type === 'run.performance')).toHaveLength(1);
    event('item/reasoning/textDelta', { delta: 'Continued thinking', itemId: 'reasoning' });
    event('item/agentMessage/delta', { itemId: 'answer', delta: 'Done' });
    event('turn/completed', { turn: { id: 'turn', status: 'completed' } });
    event('item/agentMessage/delta', { itemId: 'late', delta: 'Late output' });
    expect(
      emit.mock.calls.filter(([, type]) => type === 'run.performance').map(([, , value]) => value)
    ).toEqual([{ latencyMs: 100 }, { latencyMs: 150 }]);
    expect(runner.execution.runs.size).toBe(0);
  });

  it('OpenCode counts only current assistant semantic updates and real text deltas', () => {
    let now = 0;
    const emit = vi.fn();
    const runner = new OpenCodeRunner({} as OpenCodeServerClient);
    runner.execution.set('run', {
      runId: 'run',
      sessionId: 'session',
      nativeSessionId: 'native',
      cwd: '/workspace',
      client: {} as OpenCodeServerClient,
      abort: new AbortController(),
      access: 'default',
      agent: 'build',
      responseLatency: new ResponseLatencyTracker(() => now),
      generationTiming: new GenerationTimingTracker(() => now),
      responsePartKinds: new Map(),
      responseStartedAt: 1_000,
      responseMessages: new Set()
    });
    const controller = new OpenCodeManagedRunController(runner, {
      emit,
      emitItem: vi.fn()
    } as unknown as ConstructorParameters<typeof OpenCodeManagedRunController>[1]);
    const internals = controller as unknown as {
      event(runId: string, sessionId: string, event: unknown): void;
    };
    const event = (type: string, properties: unknown) =>
      internals.event('run', 'native', { type, properties });
    const info = (id: string, role: string, parentID = 'user', created = 1_000) =>
      event('message.updated', {
        info: { id, role, parentID, time: { created }, sessionID: 'native' }
      });
    const part = (id: string, type: string, more: Record<string, unknown> = {}) =>
      event('message.part.updated', {
        part: { id, type, messageID: 'assistant', sessionID: 'native', ...more }
      });
    info('user', 'user');
    event('message.part.updated', {
      part: { id: 'user-text', type: 'text', messageID: 'user', sessionID: 'native', text: 'Input' }
    });
    info('assistant', 'assistant');
    part('placeholder-tool', 'tool', { tool: 'bash', state: {} });
    info('old-assistant', 'assistant', 'old-user', 900);
    part('old-text', 'text', { messageID: 'old-assistant', text: 'Historical output' });
    expect(emit.mock.calls.filter(([, type]) => type === 'run.performance')).toHaveLength(0);
    part('text', 'text', { text: '' });
    now = 120;
    event('message.part.delta', {
      sessionID: 'native',
      messageID: 'assistant',
      partID: 'text',
      field: 'text',
      delta: 'Output'
    });
    part('tool', 'tool', { tool: 'bash', state: { status: 'running', input: { command: 'pwd' } } });
    now = 12_000;
    part('tool', 'tool', {
      tool: 'bash',
      state: { status: 'completed', output: 'Result', input: {} }
    });
    now = 12_200;
    part('text', 'text', { text: 'Output' });
    expect(emit.mock.calls.filter(([, type]) => type === 'run.performance')).toHaveLength(1);
    part('tool', 'tool', {
      tool: 'bash',
      state: { status: 'completed', output: 'Result', input: {} }
    });
    part('reasoning', 'reasoning', { text: 'Continue' });
    part('question', 'tool', { tool: 'question', state: { status: 'running', input: {} } });
    now = 30_000;
    part('question', 'tool', {
      tool: 'question',
      state: { status: 'completed', input: {}, output: 'Answer' }
    });
    now = 30_040;
    part('answer', 'text', { text: 'Done' });
    expect(
      emit.mock.calls.filter(([, type]) => type === 'run.performance').map(([, , value]) => value)
    ).toEqual([{ latencyMs: 120 }, { latencyMs: 200 }, { latencyMs: 40 }]);
    runner.execution.delete('run');
    part('late', 'text', { text: 'Late output' });
    expect(emit.mock.calls.filter(([, type]) => type === 'run.performance')).toHaveLength(3);
  });

  it('Claude observes partial thinking without exposing it and excludes tool time', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    let input: ClaudeQueryInput | undefined;
    const emit = vi.fn();
    const emitItem = vi.fn();
    const runner = {
      execution: { runs: new Map(), managedNativeIds: new Set() },
      mcpConfiguration: () => ({}),
      startChannel: (value: ClaudeQueryInput) => {
        input = value;
        return { cancel: vi.fn(), completed: new Promise<void>(() => undefined) };
      }
    } as unknown as ClaudeCodeRunner;
    const controller = new ClaudeManagedRunController(runner, {
      active: new Set(),
      intercepted: () => false,
      parseAttachments: () => [],
      adopt: vi.fn(),
      run: () => undefined,
      completeCancelled: () => false,
      emit,
      emitItem,
      setChannelToken: vi.fn(),
      send: vi.fn(),
      session: () => undefined,
      promote: vi.fn(),
      syncTitle: async () => undefined
    } as unknown as ConstructorParameters<typeof ClaudeManagedRunController>[1]);
    controller.start({
      type: 'run.start',
      payload: {
        runner: 'claude-code',
        runId: 'run',
        sessionId: 'session',
        input: 'Hello',
        cwd: '/workspace'
      }
    } as NodeEnvelope);
    const message = (record: unknown) => input?.onMessage(record as never);
    message({ type: 'stream_event', event: { type: 'message_start', message: { id: 'first' } } });
    now = 100;
    message({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'Never expose this raw thinking' }
      }
    });
    message({
      type: 'assistant',
      message: {
        id: 'first',
        content: [
          { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'pwd' } },
          { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'pwd' } }
        ]
      }
    });
    const result = (id: string) =>
      message({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Result' }] }
      });
    now = 10_000;
    result('a');
    now = 20_000;
    result('b');
    now = 20_070;
    message({
      type: 'assistant',
      message: {
        id: 'first',
        content: [
          { type: 'text', text: 'Previous response' },
          { type: 'tool_use', id: 'a', name: 'Bash', input: {} },
          { type: 'tool_use', id: 'b', name: 'Bash', input: {} }
        ]
      }
    });
    expect(emit.mock.calls.filter(([, type]) => type === 'run.performance')).toHaveLength(1);
    message({ type: 'stream_event', event: { type: 'message_start', message: { id: 'second' } } });
    message({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done' } }
    });
    message({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: {
          type: 'tool_use',
          id: 'c',
          name: 'Bash',
          input: {}
        }
      }
    });
    now = 30_000;
    result('c');
    now = 30_030;
    message({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: {
          type: 'tool_use',
          id: 'd',
          name: 'Bash',
          input: {}
        }
      }
    });
    message({ type: 'result', subtype: 'success', ttft_ms: 90_000 });
    message({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Late' } }
    });
    expect(
      emit.mock.calls.filter(([, type]) => type === 'run.performance').map(([, , value]) => value)
    ).toEqual([{ latencyMs: 100 }, { latencyMs: 70 }, { latencyMs: 30 }]);
    expect(JSON.stringify(emitItem.mock.calls)).not.toContain('Never expose this raw thinking');
    expect(JSON.stringify(emit.mock.calls)).not.toContain('Never expose this raw thinking');
    expect(runner.execution.runs.size).toBe(0);
  });

  it('Claude settles one primary message from final message usage and keeps tool arguments in generation time', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    let input: ClaudeQueryInput | undefined;
    const emit = vi.fn();
    const runner = {
      execution: { runs: new Map(), managedNativeIds: new Set() },
      mcpConfiguration: () => ({}),
      startChannel: (value: ClaudeQueryInput) => {
        input = value;
        return { cancel: vi.fn(), completed: new Promise<void>(() => undefined) };
      }
    } as unknown as ClaudeCodeRunner;
    const controller = new ClaudeManagedRunController(runner, {
      active: new Set(),
      intercepted: () => false,
      parseAttachments: () => [],
      adopt: vi.fn(),
      run: () => undefined,
      completeCancelled: () => false,
      emit,
      emitItem: vi.fn(),
      setChannelToken: vi.fn(),
      send: vi.fn(),
      requestApproval: vi.fn(),
      session: () => undefined,
      promote: vi.fn(),
      syncTitle: async () => undefined
    } as unknown as ConstructorParameters<typeof ClaudeManagedRunController>[1]);
    controller.start({
      type: 'run.start',
      payload: {
        runner: 'claude-code',
        runId: 'run',
        sessionId: 'session',
        input: 'Hello',
        cwd: '/workspace'
      }
    } as NodeEnvelope);
    const message = (record: unknown) => input?.onMessage(record as never);

    message({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'message_start', message: { id: 'message-1' } }
    });
    now = 100;
    message({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_start', content_block: { type: 'text', text: '' } }
    });
    now = 200;
    message({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } }
    });
    now = 250;
    message({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'message_delta',
        delta: {},
        usage: { output_tokens: 5 }
      }
    });
    now = 260;
    message({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'message_delta',
        delta: { stop_reason: null },
        usage: { output_tokens: 6 }
      }
    });
    now = 275;
    message({
      type: 'assistant',
      parent_tool_use_id: 'child-parent',
      message: {
        id: 'child-message',
        usage: { output_tokens: 999 },
        content: [{ type: 'text', text: 'child-visible' }]
      }
    });
    now = 280;
    void input?.onPermission('Bash', { command: 'pwd' }, {
      toolUseID: 'child-tool',
      agentID: 'child-agent'
    } as never);
    now = 300;
    message({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_start',
        content_block: { type: 'redacted_thinking', data: 'REDACTED_RAW' }
      }
    });
    now = 350;
    message({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }
      }
    });
    now = 400;
    message({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' }
      }
    });
    now = 500;
    void input?.onPermission('Bash', { command: 'pwd' }, { toolUseID: 'tool-1' } as never);
    now = 5_000;
    message({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 30 }
      }
    });
    message({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } });

    expect(
      emit.mock.calls.filter(([, type]) => type === 'run.performance').map(([, , value]) => value)
    ).toEqual([{ latencyMs: 200 }, { tokensPerSecond: 75 }]);
    expect(
      emit.mock.calls.some(
        ([, type, value]) => type === 'text.delta' && value?.text === 'child-visible'
      )
    ).toBe(true);
    expect(JSON.stringify(emit.mock.calls)).not.toContain('REDACTED_RAW');
  });

  it.each([false, true])(
    'OpenCode settles each step in one message (native starts: %s) without tool time',
    (nativeStarts) => {
      let now = 100;
      const emit = vi.fn();
      const runner = new OpenCodeRunner({} as OpenCodeServerClient);
      runner.execution.set('run', {
        runId: 'run',
        sessionId: 'session',
        nativeSessionId: 'native',
        cwd: '/workspace',
        client: {} as OpenCodeServerClient,
        abort: new AbortController(),
        access: 'default',
        agent: 'build',
        responseLatency: new ResponseLatencyTracker(() => now),
        generationTiming: new GenerationTimingTracker(() => now),
        responsePartKinds: new Map(),
        responseStartedAt: 1_000,
        responseMessages: new Set()
      });
      const controller = new OpenCodeManagedRunController(runner, {
        emit,
        emitItem: vi.fn()
      } as unknown as ConstructorParameters<typeof OpenCodeManagedRunController>[1]);
      const internals = controller as unknown as {
        event(runId: string, sessionId: string, event: unknown): void;
      };
      const event = (type: string, properties: unknown) =>
        internals.event('run', 'native', { type, properties });
      const info = (id: string, role: string, parentID = 'user', created = 1_000) =>
        event('message.updated', {
          info: { id, role, parentID, time: { created }, sessionID: 'native' }
        });
      const part = (id: string, type: string, more: Record<string, unknown> = {}) =>
        event('message.part.updated', {
          part: { id, type, messageID: 'assistant', sessionID: 'native', ...more }
        });

      now = 100;
      info('assistant', 'assistant');
      if (nativeStarts) part('start', 'step-start');
      part('text', 'text', { text: '', time: { start: 100 } });
      now = 200;
      event('message.part.delta', {
        sessionID: 'native',
        messageID: 'assistant',
        partID: 'text',
        field: 'text',
        delta: 'answer'
      });
      part('tool', 'tool', {
        tool: 'bash',
        state: { status: 'pending', input: { command: 'pwd' } }
      });
      now = 400;
      part('tool', 'tool', {
        tool: 'bash',
        state: { status: 'running', input: { command: 'pwd' } }
      });
      now = 10_000;
      part('tool', 'tool', {
        tool: 'bash',
        state: { status: 'completed', input: {}, output: 'ok' }
      });
      event('message.part.updated', {
        part: {
          id: 'finish',
          type: 'step-finish',
          messageID: 'assistant',
          sessionID: 'native',
          reason: 'tool-calls',
          tokens: { input: 10, output: 20, reasoning: 10, cache: { read: 0, write: 0 } }
        }
      });

      expect(
        emit.mock.calls.filter(([, type]) => type === 'run.performance').map(([, , value]) => value)
      ).toEqual([{ latencyMs: 100 }, { tokensPerSecond: 100 }]);
      const finish = (id: string, output: number, reasoning: number) =>
        part(id, 'step-finish', {
          tokens: { input: 10, output, reasoning, cache: { read: 0, write: 0 } }
        });
      now = 10_100;
      if (nativeStarts) part('start-next-step', 'step-start');
      part('text-next-step', 'text', { text: 'next step', time: { start: 10_100 } });
      if (nativeStarts) part('start-next-step', 'step-start');
      now = 10_125;
      finish('finish', 20, 10);
      now = 10_150;
      part('text', 'text', { text: 'old snapshot', time: { start: 100, end: 400 } });
      now = 10_200;
      finish('finish-next-step', 20, 0);
      now = 10_300;
      finish('finish-next-step', 20, 0);
      expect(
        emit.mock.calls
          .filter(
            ([, type, value]) => type === 'run.performance' && value?.tokensPerSecond !== undefined
          )
          .map(([, , value]) => value)
      ).toEqual([{ tokensPerSecond: 100 }, { tokensPerSecond: 200 }]);
      now = 10_400;
      if (nativeStarts) part('start-third-step', 'step-start');
      part('text-third-step', 'text', { text: 'third step', time: { start: 10_400 } });
      now = 10_500;
      part('finish-third-step', 'step-finish');
      now = 10_600;
      if (nativeStarts) part('start-fourth-step', 'step-start');
      part('text-fourth-step', 'text', { text: 'fourth step', time: { start: 10_600 } });
      now = 10_700;
      finish('finish-third-step', 30, 0);
      now = 10_800;
      finish('finish-fourth-step', 40, 0);
      expect(
        emit.mock.calls
          .filter(
            ([, type, value]) => type === 'run.performance' && value?.tokensPerSecond !== undefined
          )
          .map(([, , value]) => value.tokensPerSecond)
      ).toEqual([100, 200, 300, 200]);
    }
  );
});
