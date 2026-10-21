import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CompactionOperation,
  type CompactionProgress
} from '../../src/agent-core/runtime/compaction/operation.js';
import type { ModelAdapter, ModelRequest } from '../../src/agent-core/model/contracts.js';
import { MarAgentError } from '../../src/agent-core/error.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentHost, SecretValue } from '../../src/index.js';
import { createMarAgentWithAdapter as createMarAgent } from '../../src/agent-core/sdk/agent.js';
import { JsonlSessionStore } from '../../src/agent-core/session/store/index.js';

const request: ModelRequest = {
  system: 'Summarize.',
  messages: [{ role: 'user', content: 'Important task state.' }],
  tools: []
};
const collect = async (events: AsyncIterable<unknown>) => {
  for await (const event of events) {
    void event;
    /* Consume without exposing content. */
  }
};
afterEach(() => vi.useRealTimers());

describe('compaction operation boundary', () => {
  it.each(['max_output', 'missing'] as const)(
    'rejects a %s terminal instead of committing partial output',
    async (reason) => {
      const operation = new CompactionOperation(new AbortController().signal, () => {});
      const adapter = {
        async *start() {
          yield { type: 'text.completed' as const, itemId: 'partial', text: 'Partial summary' };
          if (reason === 'max_output')
            yield { type: 'completed' as const, reason: 'max_output' as const };
        }
      };
      try {
        await expect(collect(operation.start(adapter, request))).rejects.toMatchObject({
          code: 'MAR_AGENT_COMPACT_FAILED'
        });
      } finally {
        await operation.dispose();
      }
    }
  );
  it.each(['manual', 'automatic'] as const)(
    'fails %s compaction at its deadline, retains history and permits a later successful compact',
    async (mode) => {
      vi.useFakeTimers({
        toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
      });
      const home = await mkdtemp(join(tmpdir(), 'mar-compact-deadline-'));
      const workspace = join(home, 'workspace');
      await mkdir(workspace);
      let calls = 0;
      let hang = true;
      let notifyStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      const adapter: ModelAdapter = {
        configuration: {
          id: 'test',
          name: 'Test',
          modelId: 'local-test',
          protocol: 'OPENAI_RESPONSES',
          baseUrl: 'http://localhost:1',
          apiKey: new SecretValue('fixture'),
          contextWindowTokens: 200_000,
          maxOutputTokens: 4096,
          inputCapabilities: ['TEXT'],
          outputCapabilities: ['TEXT'],
          reasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
          hostedWebSearch: false,
          enabled: true
        },
        async *start(request, signal) {
          calls++;
          if (request.toolChoice === 'none' && hang) {
            expect(request.messages.length).toBeGreaterThanOrEqual(2);
            expect(request.messages.at(-1)?.content).toContain('Output only the handoff.');
            notifyStarted();
            yield {
              type: 'response.item',
              provider: 'OPENAI_RESPONSES',
              item: {
                type: 'message',
                id: 'partial-native',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'DO_NOT_COMMIT_PARTIAL' }]
              }
            };
            yield { type: 'text.completed', itemId: 'partial', text: 'DO_NOT_COMMIT_PARTIAL' };
            // Keep generating so this fixture exercises the total Compact deadline,
            // independently of the shorter no-progress timeout.
            for (;;) {
              await new Promise<void>((resolve, reject) => {
                const abort = () => {
                  clearTimeout(timer);
                  reject(signal.reason);
                };
                const timer = setTimeout(() => {
                  signal.removeEventListener('abort', abort);
                  resolve();
                }, 100_000);
                if (signal.aborted) abort();
                else signal.addEventListener('abort', abort, { once: true });
              });
              yield { type: 'output.delta' };
            }
          }
          yield {
            type: 'text.completed',
            itemId: 'answer',
            text: calls === 1 ? 'Task state' : 'Verified task state'
          };
          yield {
            type: 'usage',
            usage: { inputTokens: 100, outputTokens: 10 }
          };
          yield { type: 'completed', reason: 'completed' };
        }
      };
      const host = new LocalAgentHost({ homeDirectory: home, workspace });
      const agent = await createMarAgent({
        mode: 'normal',
        host,
        models: [adapter.configuration],
        adapterFactory: () => adapter
      });
      try {
        const session = await agent.createSession({ workspace, title: 'Deadline test' });
        expect((await session.run({ prompt: 'Keep the task state.' }).result()).status).toBe(
          'completed'
        );
        // Seed the hard watermark without making the seed Execution itself wait for Compact.
        const seedStore = await JsonlSessionStore.open(home);
        await seedStore.append(session.id, {
          type: 'usage.updated',
          payload: { type: 'usage.updated', inputTokens: 190_000, outputTokens: 10 }
        });
        await seedStore.close();
        const result = (
          mode === 'manual' ? session.compact() : session.run({ prompt: 'Continue.' })
        ).result();
        await started;
        await vi.advanceTimersByTimeAsync(600_001);
        expect(await result).toMatchObject({
          status: 'failed',
          errorCode: 'MAR_AGENT_MODEL_TIMEOUT'
        });
        expect(calls).toBe(2);
        expect(host.events.some((event) => event.type === 'context.compacted')).toBe(false);
        const store = await JsonlSessionStore.open(home);
        try {
          const records = await store.read(session.id);
          expect(records.some((record) => record.type === 'compact.completed')).toBe(false);
          expect(JSON.stringify(records)).not.toContain('DO_NOT_COMMIT_PARTIAL');
          expect(records.some((record) => record.type === 'turn.user')).toBe(true);
          expect(
            records.filter((record) => record.type === 'compact.progress').at(-1)?.payload
          ).toMatchObject({ state: 'FINISHED', timedOut: true });
          expect(
            JSON.stringify(records.filter((record) => record.type === 'compact.progress'))
          ).not.toContain('DO_NOT_COMMIT_PARTIAL');
        } finally {
          await store.close();
        }
        hang = false;
        expect((await session.compact().result()).status).toBe('completed');
        expect(host.events.filter((event) => event.type === 'context.compacted')).toHaveLength(1);
      } finally {
        await agent.dispose();
        vi.useRealTimers();
        await rm(home, { recursive: true, force: true });
      }
    }
  );
  it('bounds continuously generated output and records content-free progress', async () => {
    vi.useFakeTimers();
    const records: CompactionProgress[] = [];
    const operation = new CompactionOperation(new AbortController().signal, (record) => {
      records.push(record);
    });
    const adapter = {
      async *start(_request: ModelRequest, signal: AbortSignal) {
        while (!signal.aborted) {
          yield {
            type: 'text.delta' as const,
            itemId: 'text',
            phase: 'final_answer' as const,
            delta: 'PRIVATE_TEXT'
          };
          await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
        }
        throw signal.reason;
      }
    };
    const result = collect(operation.start(adapter, request));
    const failure = expect(result).rejects.toMatchObject({
      code: 'MAR_AGENT_MODEL_TIMEOUT',
      retryable: false
    });
    await vi.advanceTimersByTimeAsync(600_001);
    await failure;
    await operation.dispose();
    expect(records.length).toBeLessThanOrEqual(23);
    expect(records.at(-1)).toMatchObject({ timedOut: true, modelRequests: 1 });
    expect(records.at(-1)!.textDeltaCharacters).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain('PRIVATE_TEXT');
    expect(JSON.stringify(records)).not.toContain('Important task state.');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares the deadline across retries and aborts retry waits', async () => {
    vi.useFakeTimers();
    const operation = new CompactionOperation(new AbortController().signal, () => {});
    const adapter = {
      async *start() {
        yield { type: 'text.completed' as const, itemId: 'text', text: 'Partial' };
        throw new MarAgentError('server_is_overloaded', 'Overload.', { retryable: true });
      }
    };
    await expect(collect(operation.start(adapter, request))).rejects.toMatchObject({
      code: 'server_is_overloaded'
    });
    await vi.advanceTimersByTimeAsync(400_000);
    await expect(collect(operation.start(adapter, request))).rejects.toMatchObject({
      code: 'server_is_overloaded'
    });
    await vi.advanceTimersByTimeAsync(200_001);
    expect(operation.signal.aborted).toBe(true);
    await expect(collect(operation.start(adapter, request))).rejects.toMatchObject({
      code: 'MAR_AGENT_MODEL_TIMEOUT'
    });
    await operation.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves cancellation and disposes successful operation timers', async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const operation = new CompactionOperation(parent.signal, () => {
      throw new Error('Diagnostic unavailable');
    });
    const adapter = {
      async *start() {
        yield { type: 'completed' as const, reason: 'completed' as const };
      }
    };
    await collect(operation.start(adapter, request));
    await operation.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(parent.signal.aborted).toBe(false);
    const cancelled = new CompactionOperation(parent.signal, () => {});
    parent.abort(new MarAgentError('MAR_AGENT_CANCELLED', 'Cancelled.'));
    await expect(collect(cancelled.start(adapter, request))).rejects.toMatchObject({
      code: 'MAR_AGENT_CANCELLED'
    });
    await cancelled.dispose();
  });
});
