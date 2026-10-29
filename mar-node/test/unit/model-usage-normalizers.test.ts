vi.mock('ws', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ws')>();
  const { mockedWebSocket } = await import('./support/control-socket.js');
  return { ...actual, default: mockedWebSocket(actual.default) };
});
import { connectTestSocket } from './support/control-socket.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexUsageNormalizer } from '../../src/runner/codex/conversation-parser.js';
import { ClaudeUsageNormalizer } from '../../src/runner/claude/tool-normalizer.js';
import { OpenCodeUsageNormalizer } from '../../src/runner/opencode/conversation-parser.js';
import { normalizeMarAgentUsage } from '../../src/runner/mar-agent/conversation-normalizer.js';
import { NodeModelUsageService } from '../../src/service/model-usage-service.js';
import { ModelUsageOutbox } from '../../src/service/model-usage-outbox.js';
import { NodeDatabase } from '../../src/database.js';
import type { RunnerUsageFact } from '../../src/service/runner-usage-tracker.js';
import { createEnvelope, type ModelUsageGrant } from '@myagentroam/protocol';
import { SessionLifecycleService } from '../../src/session/session-lifecycle-service.js';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRunner } from '../../src/runner/codex-runner.js';
import type { CodexAppServerClient } from '../../src/runner/codex/codex-app-server.js';
import { CodexManagedRunController } from '../../src/runner/codex/managed-run-controller.js';
import { RunnerInteractionService } from '../../src/service/runner-interaction-service.js';
import { NodeConnector } from '../../src/connector.js';
import type { NodeRequestService } from '../../src/service/node-request-service.js';
import {
  capabilities,
  captureSocket,
  codexProfileClientFactory
} from './support/codex-connector.js';

function codexReceipt(responseId: string, turnId = 'turn', threadId = 'thread'): string {
  return (
    JSON.stringify({
      type: 'token_usage_record',
      payload: {
        thread_id: threadId,
        turn_id: turnId,
        response_id: responseId,
        usage: {
          input_tokens: 20,
          output_tokens: 7,
          cached_input_tokens: 10,
          cache_write_input_tokens: 2,
          reasoning_output_tokens: 3
        },
        thread_token_usage: { input_tokens: 9999, output_tokens: 9999 }
      }
    }) + '\n'
  );
}

afterEach(() => vi.useRealTimers());

describe('native request usage normalizers', () => {
  it('publishes the recovered native identity when a Codex execution replaces its thread', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-usage-identity-'));
    const path = join(directory, 'rollout.jsonl');
    const emit = vi.fn();
    const runner = new CodexRunner({} as CodexAppServerClient);
    const active = { sessionId: 'session', threadId: 'original', turnId: 'turn', cwd: directory };
    runner.execution.runs.set('run', active);
    const controller = new CodexManagedRunController(runner, {
      emit,
      session: () => undefined
    } as unknown as ConstructorParameters<typeof CodexManagedRunController>[1]);
    try {
      await writeFile(path, '');
      const attach = (
        controller as unknown as {
          attachUsageRollout(runId: string, result: unknown): Promise<void>;
        }
      ).attachUsageRollout.bind(controller);
      await attach('run', { thread: { id: 'original', path } });
      runner.execution.runs.set('run', { ...active, threadId: 'recovered' });
      await attach('run', { thread: { id: 'recovered', path } });
      controller.handleNotification({
        method: 'rawResponse/completed',
        params: {
          threadId: 'recovered',
          turnId: 'turn',
          responseId: 'response',
          usage: { inputTokens: 5 }
        }
      });
      expect(emit).toHaveBeenCalledWith(
        'run',
        'run.usage',
        expect.objectContaining({ sessionId: 'recovered' })
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('reanchors a recovered Codex thread without carrying partial lines from the failed rollout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-usage-recovered-'));
    const path = join(directory, 'rollout.jsonl');
    const facts: RunnerUsageFact[] = [];
    const normalizer = new CodexUsageNormalizer('run', (value) => facts.push(value));
    try {
      await writeFile(path, '');
      await normalizer.attachRollout(path, 'failed-thread');
      await appendFile(path, '{"type":"token_usage_record",');
      await normalizer.flushRollout('turn', false);
      await writeFile(path, codexReceipt('inherited'));
      await normalizer.attachRollout(path, 'thread');
      await appendFile(path, codexReceipt('recovered'));
      await normalizer.flushRollout('turn', false);
      expect(facts).toHaveLength(1);
      expect(facts[0]?.responseId).toBe('recovered');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('meters only newly appended matching Codex request receipts, deduplicating raw events and partial reads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-usage-'));
    const path = join(directory, 'rollout.jsonl');
    const facts: RunnerUsageFact[] = [];
    const normalizer = new CodexUsageNormalizer('run', (value) => facts.push(value), 'selected');
    try {
      await writeFile(path, codexReceipt('inherited'));
      await normalizer.attachRollout(path, 'thread');
      normalizer.observe(
        'rawResponse/completed',
        {
          responseId: 'raw',
          usage: {
            inputTokens: 20,
            outputTokens: 7,
            cachedInputTokens: 10,
            cacheWriteInputTokens: 2,
            reasoningOutputTokens: 3
          }
        },
        false
      );
      await appendFile(
        path,
        codexReceipt('raw') +
          codexReceipt('foreign', 'old-turn') +
          codexReceipt('child', 'turn', 'child-thread') +
          'malformed\n' +
          JSON.stringify({
            type: 'event_msg',
            payload: { type: 'token_count', info: { input_tokens: 9999 } }
          }) +
          '\n'
      );
      await normalizer.flushRollout('turn', false);
      expect(facts).toHaveLength(1);
      const receipt = codexReceipt('resumed');
      await appendFile(path, receipt.slice(0, 50));
      await normalizer.flushRollout('turn', false);
      expect(facts).toHaveLength(1);
      await appendFile(path, receipt.slice(50));
      await Promise.all([
        normalizer.flushRollout('turn', false),
        normalizer.flushRollout('turn', false)
      ]);
      expect(facts).toHaveLength(2);
      expect(facts[1]).toMatchObject({
        responseId: 'resumed',
        inputTokens: '20',
        outputTokens: '7',
        cacheReadTokens: '10',
        cacheWriteTokens: '2',
        reasoningTokens: '3',
        requestedModel: 'selected'
      });
      await appendFile(path, 'x'.repeat(256 * 1024) + '\n' + codexReceipt('compact'));
      await normalizer.flushRollout('turn', true);
      expect(facts).toHaveLength(3);
      expect(facts[2]).toMatchObject({ purpose: 'compact', inputTokens: '20' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['completed', 'interrupted', 'failed'] as const)(
    'settles appended Codex receipts before %s releases attribution',
    async (status) => {
      const directory = await mkdtemp(join(tmpdir(), 'codex-usage-terminal-'));
      const path = join(directory, 'rollout.jsonl');
      const emit = vi.fn();
      const runner = new CodexRunner({} as CodexAppServerClient);
      runner.execution.runs.set('run', {
        sessionId: 'session',
        threadId: 'thread',
        turnId: 'turn',
        cwd: directory
      });
      const controller = new CodexManagedRunController(runner, {
        emit,
        emitItem: vi.fn(),
        session: () => undefined,
        executionReleased: vi.fn()
      } as unknown as ConstructorParameters<typeof CodexManagedRunController>[1]);
      const attach = (
        controller as unknown as {
          attachUsageRollout(runId: string, result: unknown): Promise<void>;
        }
      ).attachUsageRollout.bind(controller);
      try {
        await writeFile(path, codexReceipt('old'));
        await attach('run', { thread: { id: 'thread', path } });
        await appendFile(path, codexReceipt('new'));
        const notification = {
          method: 'turn/completed',
          params: { threadId: 'thread', turn: { id: 'turn', status } }
        };
        controller.handleNotification(notification);
        controller.handleNotification(notification);
        await vi.waitFor(() => expect(runner.execution.runs.size).toBe(0));
        expect(emit.mock.calls.map(([, type]) => type)).toEqual([
          'run.usage',
          status === 'failed' ? 'run.failed' : 'run.completed'
        ]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
  it.each([false, true])(
    'drains Codex receipts before cancellation, including interrupt failure %s',
    async (failed) => {
      const directory = await mkdtemp(join(tmpdir(), 'codex-usage-cancel-'));
      const path = join(directory, 'rollout.jsonl');
      const events: string[] = [];
      const runner = new CodexRunner({
        interruptTurn: async () => {
          if (failed) throw new Error('interrupt failed');
        }
      } as unknown as CodexAppServerClient);
      runner.execution.runs.set('run', {
        sessionId: 'session',
        threadId: 'thread',
        turnId: 'turn',
        cwd: directory
      });
      const controller = new CodexManagedRunController(runner, {
        emit: (_run: string, type: string) => events.push(type),
        session: () => undefined
      } as unknown as ConstructorParameters<typeof CodexManagedRunController>[1]);
      const interactions = new RunnerInteractionService({
        codex: () => runner,
        settleCodexUsage: (runId: string, turnId: string) => controller.settleUsage(runId, turnId),
        runtime: { getRun: () => ({ status: 'CANCELLING' }), executionReleased: vi.fn() },
        emitRun: (_run: string, type: string) => events.push(type)
      } as unknown as ConstructorParameters<typeof RunnerInteractionService>[0]);
      try {
        await writeFile(path, '');
        await (
          controller as unknown as {
            attachUsageRollout(runId: string, result: unknown): Promise<void>;
          }
        ).attachUsageRollout('run', { thread: { id: 'thread', path } });
        await appendFile(path, codexReceipt('cancelled'));
        await interactions.cancelCodexTurn('run', 'thread', 'turn', directory, 'CANCELLED');
        expect(events).toEqual(['run.usage', failed ? 'run.failed' : 'run.completed']);
        expect(runner.execution.runs.size).toBe(0);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
  it('ignores Codex cumulative snapshots and deduplicates raw responses including missing usage', () => {
    const facts: RunnerUsageFact[] = [];
    const normalizer = new CodexUsageNormalizer('run', (value) => facts.push(value), 'selected');
    normalizer.observe(
      'thread/tokenUsage/updated',
      { tokenUsage: { last: { inputTokens: 99 }, total: { inputTokens: 999 } } },
      false
    );
    expect(facts).toEqual([]);
    const response = {
      responseId: 'r1',
      model: 'actual',
      usage: { inputTokens: 20, outputTokens: 7, cachedInputTokens: 10, reasoningOutputTokens: 3 }
    };
    normalizer.observe('rawResponse/completed', response, false);
    normalizer.observe('rawResponse/completed', response, false);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      inputTokens: '20',
      outputTokens: '7',
      cacheReadTokens: '10',
      reasoningTokens: '3',
      actualModel: 'actual',
      requestedModel: 'selected',
      coverage: 'partial'
    });
    normalizer.observe('rawResponse/completed', { responseId: 'compact' }, true);
    expect(facts[1]).toMatchObject({ purpose: 'compact' });
    expect(facts[1]?.inputTokens).toBeUndefined();
    expect(facts[1]?.recordId).not.toBe(facts[0]?.recordId);
  });

  it('coalesces Claude streaming frames and final assistant messages without counting the result aggregate', () => {
    const facts: RunnerUsageFact[] = [];
    const normalizer = new ClaudeUsageNormalizer('run', (value) => facts.push(value));
    const usage = {
      input_tokens: 10,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
      output_tokens: 0
    };
    normalizer.observe({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'm1', model: 'claude', usage } }
    });
    normalizer.observe({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { output_tokens: 4 } }
    });
    expect(facts).toHaveLength(1);
    normalizer.observe({
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 8 }
      }
    });
    normalizer.observe({
      type: 'assistant',
      message: {
        id: 'm1',
        model: 'claude',
        stop_reason: 'end_turn',
        usage: { ...usage, output_tokens: 8 }
      }
    });
    normalizer.observe({ type: 'result', usage: { input_tokens: 9999, output_tokens: 9999 } });
    normalizer.finish('succeeded');
    expect(facts).toHaveLength(2);
    expect(facts[1]).toMatchObject({
      recordId: facts[0]!.recordId,
      inputTokens: '35',
      outputTokens: '8',
      state: 'succeeded'
    });
    normalizer.observe({
      type: 'assistant',
      parent_tool_use_id: 'child',
      message: { id: 'm2', model: 'claude', usage: { input_tokens: 2 }, stop_reason: 'end_turn' }
    });
    expect(facts[2]).toMatchObject({ agentRole: 'subagent', inputTokens: '2' });
    expect(facts[2]?.outputTokens).toBeUndefined();
  });

  it('retains known Claude consumption on cancellation', () => {
    const facts: RunnerUsageFact[] = [];
    const normalizer = new ClaudeUsageNormalizer('run', (value) => facts.push(value));
    normalizer.observe({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'm', usage: { input_tokens: 3 } } }
    });
    normalizer.finish('cancelled');
    expect(facts.at(-1)).toMatchObject({ inputTokens: '3', state: 'cancelled' });
  });

  it('adds OpenCode disjoint cache and reasoning components once, excluding old messages', () => {
    const facts: RunnerUsageFact[] = [];
    const normalizer = new OpenCodeUsageNormalizer('run', (value) => facts.push(value));
    const message = (id: string, created: number) => ({
      type: 'message.updated',
      properties: {
        info: { id, role: 'assistant', modelID: 'model', providerID: 'provider', time: { created } }
      }
    });
    const step = (messageID: string) => ({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'step',
          messageID,
          type: 'step-finish',
          tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } }
        }
      }
    });
    normalizer.observe(message('old', 9), 10);
    normalizer.observe(step('old'), 10);
    expect(facts).toEqual([]);
    normalizer.observe(message('new', 11), 10);
    normalizer.observe(step('new'), 10);
    normalizer.observe(step('new'), 10);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      inputTokens: '13',
      outputTokens: '7',
      reasoningTokens: '4',
      actualModel: 'model',
      provider: 'provider',
      coverage: 'partial'
    });
  });
});

describe('execution-private attribution to durable outbox', () => {
  it('carries authenticated startup and separate users continued inputs through the Connector to SQLite without publishing grants', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'usage-connector-'));
    const database = new NodeDatabase(':memory:', 'usage-connector');
    const workspace = database.saveWorkspace({
      path: directory,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    let notify: (event: { method: string; params: unknown }) => void = () => undefined;
    let turns = 0;
    const connector = new NodeConnector({
      reconnect: false,
      config: {
        serverUrl: 'http://127.0.0.1',
        nodeId: 'node',
        allowedRoots: [directory],
        dataDirectory: directory
      },
      database,
      capabilities: capabilities(),
      codexProfileClientFactory,
      codexClient: {
        onNotification: (listener: typeof notify) => {
          notify = listener;
          return () => undefined;
        },
        configureEnvironment: () => undefined,
        start: async () => undefined,
        startThread: async () => ({ thread: { id: 'native-thread' } }),
        resumeThread: async () => ({ thread: { id: 'native-thread' } }),
        startTurn: async () => {
          const turnId = `turn-${++turns}`;
          notify({ method: 'turn/started', params: { threadId: 'native-thread', turnId } });
          notify({
            method: 'rawResponse/completed',
            params: {
              threadId: 'native-thread',
              turnId,
              responseId: `response-${turns}`,
              usage: { inputTokens: 3, outputTokens: 1 }
            }
          });
          return { turn: { id: turnId } };
        },
        stop: () => undefined
      } as unknown as CodexAppServerClient
    });
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    const internals = connector as unknown as {
      usageOutbox: ModelUsageOutbox;
      nodeRequests: NodeRequestService;
      executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
    };
    const diagnostics = vi.fn();
    internals.usageOutbox = new ModelUsageOutbox({
      database: () => database.raw,
      namespace: () => 'server:node',
      send: vi.fn(),
      diagnose: diagnostics
    });
    connectTestSocket(connector, captureSocket(sent, connector));
    const grant = (userId: number): ModelUsageGrant => {
      const scopeId = `00000000-0000-4000-8000-00000000000${userId}`;
      return {
        scopeId,
        token: `${Buffer.from(JSON.stringify({ audience: 'model-usage-v1', scopeId, nodeId: 'node', userId, mode: 'work', issuedAt: Date.now(), expiresAt: Date.now() + 60000 })).toString('base64url')}.signature`
      };
    };
    const first = grant(1),
      second = grant(2);
    const request = (
      operation: string,
      data: unknown,
      usageGrant: ModelUsageGrant,
      userId: number
    ) => {
      const envelope = createEnvelope('node.request', { operation, data });
      return internals.nodeRequests.handle({
        ...envelope,
        payload: {
          ...(envelope.payload as object),
          userAuthorization: {
            userId,
            sessionHash: 'a'.repeat(43),
            nodeId: 'node',
            operation,
            requestId: envelope.id,
            issuedAt: Date.now(),
            expiresAt: Date.now() + 15000,
            usageGrant
          }
        }
      });
    };
    const entries = () =>
      database.raw
        .prepare('SELECT payload FROM model_usage_outbox ORDER BY record_id')
        .all()
        .map((row) => JSON.parse(String(row.payload)));
    try {
      await internals.executeNodeOperation('runner.profiles.list', {});
      await request(
        'session.start',
        {
          workspaceId: workspace.id,
          runner: 'codex',
          cwd: directory,
          clientMessageId: 'first',
          content: 'probe'
        },
        first,
        1
      );
      expect(entries()).toHaveLength(1);
      expect(entries()[0].record).toMatchObject({
        runner: 'codex',
        sessionId: 'native-thread',
        scopeId: first.scopeId
      });
      await request(
        'session.message',
        {
          sessionId: 'native-thread',
          clientMessageId: 'queued',
          content: 'next',
          deliveryIntent: 'SEND'
        },
        second,
        2
      );
      expect(turns).toBe(1);
      expect(sent.at(-1)?.payload).toMatchObject({ error: 'RUN_OWNED_BY_ANOTHER_USER' });
      notify({
        method: 'turn/completed',
        params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } }
      });
      await request(
        'session.message',
        { sessionId: 'native-thread', clientMessageId: 'continued', content: 'next' },
        second,
        2
      );
      await vi.waitFor(() => expect(entries()).toHaveLength(2));
      expect(
        entries()
          .map((entry) => entry.record.scopeId)
          .sort()
      ).toEqual([first.scopeId, second.scopeId].sort());
      expect(entries().every((entry) => entry.record.sessionId === 'native-thread')).toBe(true);
      notify({
        method: 'turn/completed',
        params: { threadId: 'native-thread', turn: { id: 'turn-2', status: 'completed' } }
      });
      expect(JSON.stringify(sent)).not.toContain(first.token);
      expect(JSON.stringify(sent)).not.toContain(second.token);
      expect(diagnostics).not.toHaveBeenCalled();
    } finally {
      await connector.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each(['codex', 'claude-code', 'opencode', 'mar-agent'] as const)(
    'preserves authenticated attribution through %s session startup and deferred commands',
    async (runner) => {
      const grant: ModelUsageGrant = {
        scopeId: '00000000-0000-4000-8000-000000000001',
        token: 'private-startup-grant'
      };
      const execute = vi.fn(async (operation: string, _data: Record<string, unknown>) =>
        operation === 'session.create'
          ? { session: { id: 'bootstrap', runner } }
          : { run: { id: 'run' }, delivery: 'STARTED', idempotent: false }
      );
      const prepareExecutionContext = vi.fn(() => undefined);
      const options = {
        execute,
        identity: { wait: () => Promise.resolve('native') },
        runners: { require: () => ({ prepareExecutionContext }) },
        interceptedSessionId: () => undefined,
        runtime: {
          getAgentSession: () => ({ id: 'native', runner }),
          getRun: () => ({ id: 'run' }),
          conversationTurnForRun: () => ({ id: 'turn' })
        },
        present: (value: unknown) => value
      } as unknown as ConstructorParameters<typeof SessionLifecycleService>[0];
      const service = new SessionLifecycleService(options);
      const result = await service.operations()['session.start']!({
        runner,
        workspaceId: 'workspace',
        cwd: '/workspace',
        clientMessageId: 'input',
        content: 'probe',
        __requestUserId: 42,
        __usageGrant: grant,
        deferredCommands: [{ commandId: 'plan', input: '/plan' }]
      });
      for (const operation of ['session.message', 'session.command.execute']) {
        expect(execute).toHaveBeenCalledWith(
          operation,
          expect.objectContaining({ __requestUserId: 42, __usageGrant: grant })
        );
      }
      expect(prepareExecutionContext).toHaveBeenCalledWith(
        expect.objectContaining({ runner, __requestUserId: 42, __usageGrant: grant })
      );
      expect(JSON.stringify(result)).not.toContain(grant.token);
    }
  );
  it('binds concurrent inputs independently, preserves child session identity, and releases attribution', async () => {
    const database = new NodeDatabase(':memory:', 'usage-attribution');
    const diagnostics = vi.fn();
    const outbox = new ModelUsageOutbox({
      database: () => database.raw,
      namespace: () => 'server:node',
      send: vi.fn(),
      diagnose: diagnostics
    });
    const service = new NodeModelUsageService(
      () => outbox,
      () => 'node'
    );
    const grant = (scopeId: string, userId: number): ModelUsageGrant => ({
      scopeId,
      token: `${Buffer.from(JSON.stringify({ audience: 'model-usage-v1', scopeId, nodeId: 'node', userId, mode: 'work', issuedAt: 1, expiresAt: 9999999999999 })).toString('base64url')}.signature`
    });
    const first = grant('00000000-0000-0000-0000-000000000001', 1);
    const second = grant('00000000-0000-0000-0000-000000000002', 2);
    const fact = (recordId: string) =>
      normalizeMarAgentUsage({
        recordId,
        requestId: recordId,
        revision: 2,
        sessionId: 'child',
        executionId: 'sdk-run',
        purpose: 'compact',
        agentRole: 'subagent',
        modelConfigurationId: 'config',
        modelName: 'model',
        provider: 'OPENAI_RESPONSES',
        requestedModel: 'requested',
        startedAt: Date.now() - 100,
        endedAt: Date.now(),
        state: 'succeeded',
        inputTokens: '10'
      });
    try {
      await Promise.all(
        [first, second].map((value, index) =>
          service.withGrant(value, async () => {
            await Promise.resolve();
            service.bindInherited(`run-${index}`, 'root', 'mar-agent');
            service.record(`run-${index}`, fact(`record-${index}`));
          })
        )
      );
      const entries = database.raw
        .prepare('SELECT payload FROM model_usage_outbox ORDER BY record_id')
        .all()
        .map((row) => JSON.parse(String(row.payload)));
      expect(entries.map((entry) => entry.grant.scopeId)).toEqual([first.scopeId, second.scopeId]);
      expect(entries[0].record).toMatchObject({
        runId: 'run-0',
        sessionId: 'child',
        purpose: 'compact',
        agentRole: 'subagent'
      });
      expect(entries[0].record).not.toHaveProperty('executionId');
      expect(service.grantForRun('run-0', 'root', 1)).toEqual(first);
      expect(service.grantForRun('run-0', 'root', 2)).toBeUndefined();
      expect(service.grantForRun('run-0', 'other', 1)).toBeUndefined();
      service.release('run-0');
      expect(service.grantForRun('run-0', 'root', 1)).toBeUndefined();
      service.record('run-0', fact('ignored'));
      expect(
        database.raw.prepare('SELECT COUNT(*) AS total FROM model_usage_outbox').get()?.total
      ).toBe(2);
      service.withGrant(first, () =>
        service.withGrant(undefined, () => service.bindInherited('unattributed', 'root', 'codex'))
      );
      service.record('unattributed', fact('no-grant'));
      service.bind('promoted', first, 'bootstrap', 'codex');
      service.promoteSession('bootstrap', 'native');
      new CodexUsageNormalizer('promoted', (value) => service.record('promoted', value)).observe(
        'rawResponse/completed',
        { responseId: 'promoted-response', usage: { inputTokens: 3, outputTokens: 1 } },
        false
      );
      const promoted = database.raw
        .prepare('SELECT payload FROM model_usage_outbox')
        .all()
        .map((row) => JSON.parse(String(row.payload)));
      expect(promoted).toHaveLength(3);
      expect(promoted.find((entry) => entry.record.runId === 'promoted').record).toMatchObject({
        sessionId: 'native',
        scopeId: first.scopeId,
        runner: 'codex'
      });
      expect(promoted.find((entry) => entry.record.runId === 'run-1').record.sessionId).toBe(
        'child'
      );
      expect(diagnostics).not.toHaveBeenCalled();
    } finally {
      outbox.disconnected();
      database.close();
    }
  });
});
