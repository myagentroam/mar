import { latestUserText } from './support/model-context.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAgentHost } from '../../src/host.js';
import {
  AgentError,
  SecretValue,
  generateModelText,
  type AgentEvent,
  type AgentModelConfiguration
} from '../../src/index.js';
import { createAgentWithAdapter } from '../../src/sdk/agent.js';
import type { Agent } from '../../src/sdk/types.js';
import type {
  ExtensionSource,
  AgentExtension,
  SessionExtensionContext
} from '../../src/extensions/contracts.js';
import type { ExtensionOperationContext } from '../../src/extensions/operation.js';
import {
  compactExtensionResult,
  type ExtensionCompactContext,
  type ExtensionCompactResult
} from '../../src/extensions/compaction.js';
import type { ModelAdapter, ModelEvent, ModelRequest } from '../../src/model/contracts.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { DEFAULT_COMPACTION_FOCUS } from '../../src/runtime/compaction/history.js';
import { compactionPrompt } from '../../src/prompts/compact.js';
import { OpenAiResponsesAdapter } from '../../src/model/openai-responses.js';
import { AnthropicMessagesAdapter } from '../../src/model/anthropic-messages.js';

const baseModel: AgentModelConfiguration = {
  id: 'test',
  name: 'Test',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl: 'https://example.test',
  apiKey: new SecretValue('test'),
  modelId: 'test',
  contextWindowTokens: 200_000,
  maxOutputTokens: 4_096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  defaultReasoningEffort: 'medium',
  titleGeneration: false,
  codeMode: false,
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  enabled: true
};

type Script = (request: ModelRequest, index: number) => ModelEvent[];

class ScriptedAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  resetContinuationCalls = 0;
  constructor(
    readonly configuration: AgentModelConfiguration,
    readonly script: Script
  ) {}
  createTurnSession() {
    return {
      start: (request: ModelRequest) => this.start(request),
      close: async () => undefined,
      resetContinuation: () => {
        this.resetContinuationCalls += 1;
      }
    };
  }
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    const index = this.requests.length;
    this.requests.push(request);
    yield* this.script(request, index);
  }
}

const answer = (text: string): ModelEvent[] => [
  { type: 'text.completed', itemId: 'answer', text },
  { type: 'completed', reason: 'completed' }
];
const usageAnswer = (text: string, contextTokens: number): ModelEvent[] => [
  { type: 'text.completed', itemId: 'answer', text },
  {
    type: 'usage',
    usage: { inputTokens: contextTokens, contextInputTokens: contextTokens, outputTokens: 10 }
  },
  { type: 'completed', reason: 'completed' }
];
const modelSummary = (text: string): ModelEvent[] => [
  { type: 'text.completed', itemId: 'summary', text },
  { type: 'completed', reason: 'completed' }
];

type CompactHandler = (
  context: ExtensionCompactContext,
  call: ExtensionOperationContext,
  next: (context: ExtensionCompactContext) => Promise<ExtensionCompactResult | undefined>
) => ExtensionCompactResult | undefined | Promise<ExtensionCompactResult | undefined>;

function compactExtension(handler: CompactHandler) {
  const contexts: ExtensionCompactContext[] = [];
  const signals: AbortSignal[] = [];
  const extension: AgentExtension = {
    id: 'compact-generator',
    apiVersion: '1.0',
    attachSession(context: SessionExtensionContext) {
      context.hooks.intercept('compact.generate', async (input, call, next) => {
        contexts.push(input);
        signals.push(call.signal);
        return handler(input, call, next);
      });
    }
  };
  return { extension, contexts, signals };
}

const agents: Agent[] = [];
const homes: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(agents.splice(0).map((agent) => agent.dispose()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function compactFixture(input: {
  extensions: readonly AgentExtension[] | ExtensionSource;
  script: Script;
  model?: Partial<AgentModelConfiguration>;
}) {
  const home = await mkdtemp(join(tmpdir(), 'mar-core-compact-ext-'));
  homes.push(home);
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'AGENTS.md'), 'ENV_RULE_MARKER: private environment rule.\n');
  await writeFile(join(workspace, 'evidence.txt'), 'TOOL_EVIDENCE_MARKER verified reading.\n');
  const configuration: AgentModelConfiguration = { ...baseModel, ...input.model };
  const adapter = new ScriptedAdapter(configuration, input.script);
  const host = new LocalAgentHost({ homeDirectory: home, workspace });
  const agent = await createAgentWithAdapter(
    {
      mode: 'normal',
      host,
      models: [configuration],
      extensions: input.extensions
    },
    () => adapter
  );
  agents.push(agent);
  const session = await agent.createSession({ workspace, title: 'Compact extension test' });
  return { agent, session, adapter, host, home };
}

async function collect(handle: {
  [Symbol.asyncIterator](): AsyncIterator<AgentEvent>;
  result(): Promise<{ status: string; finalAnswer?: string; errorCode?: string }>;
}) {
  const events: AgentEvent[] = [];
  for await (const event of handle) events.push(event);
  return { events, result: await handle.result() };
}

async function readRecords(home: string, sessionId: string) {
  const store = await JsonlSessionStore.open(home);
  try {
    return await store.read(sessionId);
  } finally {
    await store.close();
  }
}

const imageBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('Core compact generation extension', () => {
  it.each([
    ['OPENAI_RESPONSES', 'manual'],
    ['OPENAI_RESPONSES', 'automatic'],
    ['ANTHROPIC_MESSAGES', 'manual'],
    ['ANTHROPIC_MESSAGES', 'automatic']
  ] as const)(
    'accepts standalone %s usage for %s compact without a native fallback',
    async (protocol, reason) => {
      const externalUsage = {
        inputTokens: protocol === 'OPENAI_RESPONSES' ? 100 : 40,
        totalInputTokens: 100,
        contextInputTokens: 100,
        outputTokens: 6,
        reasoningTokens: protocol === 'OPENAI_RESPONSES' ? 0 : undefined,
        cacheReadTokens: 60,
        cacheWriteTokens: protocol === 'ANTHROPIC_MESSAGES' ? 0 : undefined,
        rolloutBudgetUnits: undefined,
        hostedSearches: 0,
        hostedFetches: 0
      };
      const expectedUsage = Object.fromEntries(
        Object.entries(externalUsage).filter(([, amount]) => amount !== undefined)
      );
      const adapter =
        protocol === 'OPENAI_RESPONSES' ? OpenAiResponsesAdapter : AnthropicMessagesAdapter;
      const start = vi.spyOn(adapter.prototype, 'start').mockImplementation(async function* () {
        yield { type: 'text.completed', itemId: 'summary', text: 'GENERATED_COMPACT_HANDOFF' };
        yield { type: 'usage', usage: externalUsage };
        yield { type: 'completed', reason: 'completed' };
      });
      try {
        const compact = compactExtension(async (input, call) => {
          const generated = await generateModelText({
            model: { ...baseModel, protocol },
            system: 'Generate a compact handoff.',
            messages: input.messages,
            signal: call.signal
          });
          await input.reportDiagnostic!({
            modelId: 'external-compact',
            reasoningEffort: 'medium',
            state: 'SUCCEEDED',
            inputTokensEstimateBefore: 100,
            inputTokensEstimateAfter: 100,
            modelRequests: 1,
            elapsedMs: 1
          });
          return generated ? { summary: generated.text, usage: generated.usage } : undefined;
        });
        const f = await compactFixture({
          extensions: [compact.extension],
          model: {
            id: 'execution-model',
            modelId: 'upstream-model',
            contextWindowTokens: 10_000,
            maxOutputTokens: 1_000
          },
          script: (request) =>
            request.toolChoice === 'none'
              ? modelSummary('NATIVE_FALLBACK')
              : latestUserText(request) === 'seed'
                ? usageAnswer('seeded', reason === 'automatic' ? 9_200 : 100)
                : answer('continued')
        });
        expect((await f.session.run({ prompt: 'seed' }).result()).status).toBe('completed');
        const execution = await collect(
          reason === 'manual' ? f.session.compact() : f.session.run({ prompt: 'continue' })
        );
        expect(execution.result.status).toBe('completed');
        expect(compact.contexts).toHaveLength(1);
        expect(compact.contexts[0]!.reason).toBe(reason);
        expect(compact.contexts[0]!.modelId).toBe('execution-model');
        expect(start).toHaveBeenCalledTimes(1);
        expect(f.adapter.requests.some((request) => request.toolChoice === 'none')).toBe(false);
        const records = await readRecords(f.home, f.session.id);
        const checkpoints = records.filter((record) => record.type === 'compact.completed');
        expect(checkpoints).toHaveLength(1);
        expect(checkpoints[0]!.payload).toMatchObject({
          summary: 'GENERATED_COMPACT_HANDOFF',
          automatic: reason === 'automatic',
          usage: expectedUsage
        });
        expect(checkpoints[0]!.payload.usage).toEqual(expectedUsage);
        expect(
          records.filter((record) => record.type === 'compact.progress').at(-1)!.payload
        ).toMatchObject({ extensionOutcome: 'HANDLED', modelRequests: 1 });
        expect(
          records.filter(
            (record) =>
              record.type === 'usage.updated' &&
              record.payload.contextInputTokens === 100 &&
              record.payload.outputTokens === 6
          )
        ).toHaveLength(1);
      } finally {
        start.mockRestore();
      }
    }
  );

  it.each([
    { totalInputTokens: -1 },
    { reasoningTokens: NaN },
    { cacheReadTokens: Infinity },
    { outputTokens: '6' },
    { inputTokens: null },
    { unknownField: 1 },
    { unknownField: undefined },
    null,
    []
  ])('rejects invalid compact usage %j', (usage) => {
    expect(compactExtensionResult({ summary: 'usable summary', usage }, 100)).toBeUndefined();
  });

  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const)(
    'forwards actual %s adapter attempt facts for standalone generation',
    async (protocol) => {
      const adapter =
        protocol === 'OPENAI_RESPONSES' ? OpenAiResponsesAdapter : AnthropicMessagesAdapter;
      const started = {
        protocol,
        transport: 'HTTP' as const,
        state: 'STARTED' as const,
        attempt: 1,
        maxAttempts: 1,
        continuation: false,
        credentialReason: 'REQUEST' as const
      };
      const observer = vi.fn();
      const start = vi
        .spyOn(adapter.prototype, 'start')
        .mockImplementation(async function* (request) {
          await request.onAttemptDiagnostic?.(started);
          yield* answer('generated');
        });
      try {
        expect(
          await generateModelText({
            model: { ...baseModel, protocol },
            system: 'summary',
            messages: [{ role: 'user', content: 'evidence' }],
            signal: new AbortController().signal,
            onAttemptDiagnostic: observer
          })
        ).toMatchObject({ text: 'generated' });
        expect(observer).toHaveBeenCalledExactlyOnceWith(started);
      } finally {
        start.mockRestore();
      }
    }
  );

  it.each([false, true])(
    'keeps dedicated compact credentials usable with a retained cell=%s',
    async (retained) => {
      let revision = 1;
      const used: number[] = [];
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      let launch = retained;
      let joinCell = false;
      let cellId!: string;
      const cellExtension: AgentExtension = {
        id: 'compact-retained-cell',
        apiVersion: '1.0',
        attachSession(context) {
          context.tools.register({
            name: 'compact_gate',
            description: 'Wait for release.',
            inputSchema: { type: 'object' },
            parallelSafety: 'safe',
            async execute() {
              entered.resolve();
              await gate.promise;
              return { content: 'released' };
            }
          });
          context.hooks.intercept('model.request', async (input, _call, next) => {
            if (launch) {
              launch = false;
              const result = await context.tools.invoke({
                name: 'code_exec',
                arguments: {
                  code: '// @options: {"yieldMs":0}\nobserve.result(await tools.compact_gate({}));'
                }
              });
              cellId = (result.data as { cellId: string }).cellId;
              expect(result.data).toMatchObject({ status: 'running' });
            } else if (joinCell) {
              joinCell = false;
              const result = await context.tools.invoke({
                name: 'code_exec_wait',
                arguments: { cellId, yieldMs: 1000 }
              });
              expect(result.data).toMatchObject({ status: 'completed' });
            }
            return next(input);
          });
        }
      };
      const provider = () => ({
        closed: false,
        acquire: vi.fn(),
        invalidate: vi.fn(),
        async close() {
          this.closed = true;
        }
      });
      const first = provider(),
        second = provider(),
        third = provider();
      let current = first;
      const { apiKey: _apiKey, ...withoutKey } = baseModel;
      const dedicated = (credentialProvider: typeof first): AgentModelConfiguration => ({
        ...withoutKey,
        id: 'dedicated',
        credentialProvider,
        conversationModel: false
      });
      const source: ExtensionSource = {
        async resolve() {
          const captured = revision;
          const capturedProvider = current;
          return {
            revision: `compact-${captured}`,
            extensions: [
              compactExtension(() => {
                used.push(captured);
                if (capturedProvider.closed) return undefined;
                return { summary: `summary from generation ${captured}` };
              }).extension,
              ...(retained ? [cellExtension] : [])
            ]
          };
        }
      };
      const conversation = { ...baseModel, codeMode: retained };
      const f = await compactFixture({
        extensions: source,
        script: () => answer('seeded'),
        model: conversation
      });
      await f.agent.reconfigureModels({
        models: [conversation, dedicated(first)],
        defaultModelId: baseModel.id
      });
      await f.session.run({ prompt: 'seed' }).result();
      if (retained) await entered.promise;
      try {
        await f.agent.reconfigureModels({
          models: [conversation, dedicated(second)],
          defaultModelId: baseModel.id
        });
        revision = 2;
        current = second;
        expect(first.closed).toBe(!retained);
        const result = await f.session.compact().result();
        expect(result.status).toBe('completed');
        expect(used).toEqual([retained ? 1 : 2]);
        expect(f.adapter.requests).toHaveLength(1);
        expect(
          (await readRecords(f.home, f.session.id)).find(
            (record) => record.type === 'compact.completed'
          )
        ).toMatchObject({
          payload: { summary: `summary from generation ${retained ? 1 : 2}`, automatic: false }
        });
        if (retained) {
          await f.agent.reconfigureModels({
            models: [conversation, dedicated(third)],
            defaultModelId: baseModel.id
          });
          revision = 3;
          current = third;
          expect(first.closed).toBe(false);
          expect(second.closed).toBe(true);
          expect((await f.session.compact().result()).status).toBe('completed');
          expect(used).toEqual([1, 1]);
          expect(f.adapter.requests).toHaveLength(1);
          gate.resolve();
          joinCell = true;
          expect((await f.session.run({ prompt: 'join retained cell' }).result()).status).toBe(
            'completed'
          );
          await f.agent.reconfigureModels({
            models: [conversation, dedicated(third)],
            defaultModelId: baseModel.id
          });
          expect(first.closed).toBe(true);
          expect((await f.session.compact().result()).status).toBe('completed');
          expect(used).toEqual([1, 1, 3]);
          expect(f.adapter.requests).toHaveLength(2);
        }
        await f.agent.dispose();
        expect(first.closed).toBe(true);
        expect(second.closed).toBe(true);
        if (retained) expect(third.closed).toBe(true);
      } finally {
        gate.resolve();
      }
    }
  );

  it.each(['handled', 'declined', 'invalid', 'failed'] as const)(
    'persists bounded external model diagnostics and the %s outcome without publishing them',
    async (outcome) => {
      const compact = compactExtension(async (input) => {
        await input.reportDiagnostic!({
          modelId: 'dedicated',
          providerModelId: 'coding',
          reasoningEffort: 'high',
          state: outcome === 'handled' ? 'SUCCEEDED' : 'FAILED',
          inputTokensEstimateBefore: 50_000,
          inputTokensEstimateAfter: 9_000,
          modelRequests: 1,
          elapsedMs: 10,
          trigger: input.reason,
          errorCode: 'MAR_AGENT_RUNTIME_CREDENTIAL_PROVIDER_CLOSED',
          causeCode: 'ECONNRESET',
          errorReason: 'MODEL_TRANSPORT_FAILURE',
          retryable: false,
          transport: 'HTTP',
          httpStatus: 503,
          ...{ apiKey: 'SECRET_DIAGNOSTIC_MARKER', requestBody: 'PRIVATE_BODY' }
        });
        if (outcome === 'failed') throw new Error('PRIVATE_ERROR');
        return outcome === 'handled'
          ? { summary: 'external summary' }
          : outcome === 'invalid'
            ? { summary: '' }
            : undefined;
      });
      const f = await compactFixture({
        extensions: [compact.extension],
        script: (request) =>
          request.toolChoice === 'none' ? modelSummary('fallback summary') : answer('seeded')
      });
      await f.session.run({ prompt: 'seed' }).result();
      const execution = await collect(f.session.compact());
      expect(execution.result.status).toBe('completed');
      const records = await readRecords(f.home, f.session.id);
      const progress = records.filter((record) => record.type === 'compact.progress').at(-1)!;
      expect(progress.payload).toMatchObject({
        state: 'FINISHED',
        extensionOutcome: {
          handled: 'HANDLED',
          declined: 'DECLINED',
          invalid: 'INVALID_RESULT',
          failed: 'FAILED'
        }[outcome],
        modelRequests: outcome === 'handled' ? 1 : 2,
        extension: {
          modelId: 'dedicated',
          providerModelId: 'coding',
          reasoningEffort: 'high',
          modelRequests: 1,
          inputTokensEstimateBefore: 50_000,
          inputTokensEstimateAfter: 9_000,
          trigger: 'manual',
          errorCode: 'MAR_AGENT_RUNTIME_CREDENTIAL_PROVIDER_CLOSED',
          causeCode: 'ECONNRESET',
          errorReason: 'MODEL_TRANSPORT_FAILURE',
          retryable: false,
          transport: 'HTTP',
          httpStatus: 503
        }
      });
      expect(JSON.stringify(records)).not.toContain('SECRET_DIAGNOSTIC_MARKER');
      expect(JSON.stringify(records)).not.toContain('PRIVATE_BODY');
      expect(JSON.stringify(execution.events)).not.toContain('dedicated');
      const count = records.filter((record) => record.type === 'compact.progress').length;
      await compact.contexts[0]!.reportDiagnostic!({
        modelId: 'late',
        reasoningEffort: 'high',
        state: 'SUCCEEDED',
        inputTokensEstimateBefore: 1,
        inputTokensEstimateAfter: 1,
        modelRequests: 99,
        elapsedMs: 1
      });
      expect(
        (await readRecords(f.home, f.session.id)).filter(
          (record) => record.type === 'compact.progress'
        )
      ).toHaveLength(count);
    }
  );

  it('keeps the prior handoff available to a subsequent external compact', async () => {
    const compact = compactExtension(() => ({ summary: 'DURABLE_PRIOR_HANDOFF' }));
    const f = await compactFixture({
      extensions: [compact.extension],
      script: () => answer('seeded')
    });
    await f.session.run({ prompt: 'seed' }).result();
    expect((await f.session.compact().result()).status).toBe('completed');
    expect((await f.session.compact().result()).status).toBe('completed');
    expect(
      compact.contexts[1]!.messages.some((message) =>
        message.content.includes('DURABLE_PRIOR_HANDOFF')
      )
    ).toBe(true);
  });

  it.each(['manual', 'automatic'] as const)(
    'provides the ordinary default prompt getter for %s compact',
    async (reason) => {
      const compact = compactExtension(() => undefined);
      const f = await compactFixture({
        extensions: [compact.extension],
        model: {
          contextWindowTokens: 10_000,
          maxOutputTokens: 1_000
        },
        script: (request) =>
          request.toolChoice === 'none'
            ? modelSummary('DEFAULT_PROMPT_SUMMARY')
            : latestUserText(request) === 'seed'
              ? usageAnswer('seeded', reason === 'automatic' ? 9_200 : 100)
              : answer('continued')
      });
      await f.session.run({ prompt: 'seed' }).result();
      const result =
        reason === 'manual'
          ? await f.session.compact().result()
          : await f.session.run({ prompt: 'continue' }).result();
      expect(result.status).toBe('completed');
      expect(compact.contexts).toHaveLength(1);
      const input = compact.contexts[0]!;
      const expected = compactionPrompt();
      expect(input.reason).toBe(reason);
      expect(input.getPrompt()).toBe(expected);
      expect(input.getPrompt()).toBe(expected);
      expect(JSON.stringify(input)).not.toContain(expected);
      const fallback = f.adapter.requests.find((request) => request.toolChoice === 'none');
      expect(fallback?.messages.at(-1)?.content.endsWith(expected)).toBe(true);
    }
  );

  it('commits only the extension summary for manual compact without a model summary request', async () => {
    const compact = compactExtension(() => ({
      summary: 'EXTENSION_HANDOFF durable parser state',
      usage: { inputTokens: 40, outputTokens: 6 }
    }));
    const f = await compactFixture({
      extensions: [compact.extension],
      script: (_request, index) => answer(`seed-answer-${index}`)
    });
    expect((await f.session.run({ prompt: 'seed objective' }).result()).status).toBe('completed');
    const { events, result } = await collect(
      f.session.compact({ prompt: 'focus on parser state' })
    );
    expect(result).toMatchObject({ status: 'completed', finalAnswer: '' });
    expect(compact.contexts).toHaveLength(1);
    const context = compact.contexts[0]!;
    expect(context.reason).toBe('manual');
    expect(context.focus).toBe('focus on parser state');
    expect(typeof context.operationId).toBe('string');
    expect(context.operationId.length).toBeGreaterThan(0);
    expect(context.summaryTokenBudget).toBeGreaterThan(0);
    expect(
      context.messages.some(
        (message) => message.role === 'user' && message.content === 'seed objective'
      )
    ).toBe(true);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.messages)).toBe(true);
    expect(Object.isFrozen(context.messages[0])).toBe(true);
    expect(compact.signals[0]!.aborted).toBe(false);
    expect(f.adapter.requests.some((request) => request.toolChoice === 'none')).toBe(false);
    const compacting = events.find((event) => event.type === 'context.compacting');
    const compacted = events.find((event) => event.type === 'context.compacted');
    expect(compacted).toMatchObject({
      compactionId: (compacting as { compactionId: string } | undefined)?.compactionId
    });
    expect(JSON.stringify(events)).not.toContain('EXTENSION_HANDOFF');
    expect(JSON.stringify(f.host.events)).not.toContain('EXTENSION_HANDOFF');
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'usage.updated', inputTokens: 40, outputTokens: 6 })
      ])
    );
    const checkpoints = (await readRecords(f.home, f.session.id)).filter(
      (record) => record.type === 'compact.completed'
    );
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      payload: {
        summary: 'EXTENSION_HANDOFF durable parser state',
        automatic: false,
        usage: { inputTokens: 40, outputTokens: 6 }
      }
    });
    const resumed = await f.agent.openSession(f.session.id);
    expect((await resumed.run({ prompt: 'continue after compact' }).result()).status).toBe(
      'completed'
    );
    expect(f.adapter.requests.filter((request) => request.toolChoice === 'none')).toHaveLength(0);
    expect(JSON.stringify(f.adapter.requests.at(-1)!.messages)).toContain('EXTENSION_HANDOFF');
  });

  it('uses the extension for automatic compact, keeps sanitised context and lets the model continue', async () => {
    const compact = compactExtension(() => ({
      summary: 'AUTO_EXTENSION_SUMMARY parser work done'
    }));
    const script: Script = (request) => {
      if (request.toolChoice === 'none') return modelSummary('MODEL_DEFAULT_SUMMARY');
      const latest = latestUserText(request);
      if (latest === 'first')
        return [
          {
            type: 'response.item',
            provider: 'ANTHROPIC_MESSAGES',
            contextKind: 'private',
            item: { type: 'thinking', thinking: '', signature: 'PRIVATE_SIGNATURE' }
          },
          {
            type: 'client_tool.call',
            callId: 'evidence-read',
            name: 'read',
            arguments: { reads: [{ path: 'evidence.txt' }] }
          },
          {
            type: 'usage',
            usage: { inputTokens: 9_200, contextInputTokens: 9_200, outputTokens: 12 }
          },
          { type: 'completed', reason: 'tool_use' }
        ];
      return answer(
        latest === 'CONTINUE_MARKER_PROMPT' ? 'answer-after-extension-compact' : 'answer-1'
      );
    };
    const f = await compactFixture({
      extensions: [compact.extension],
      model: {
        contextWindowTokens: 10_000,
        maxOutputTokens: 1_000,
        inputCapabilities: ['TEXT', 'IMAGE']
      },
      script
    });
    const seeded = await collect(
      f.session.run({
        prompt: 'first',
        images: [{ name: 'historical.png', mimeType: 'image/png', dataBase64: imageBase64 }]
      })
    );
    expect(seeded.result.status, JSON.stringify(seeded.result)).toBe('completed');
    expect(
      (await readRecords(f.home, f.session.id))
        .filter((record) => record.type === 'model.context')
        .map((record) => record.payload)
    ).toContainEqual({
      role: 'provider',
      content: '',
      provider: 'ANTHROPIC_MESSAGES',
      providerModelId: baseModel.id,
      contextKind: 'private',
      item: { type: 'thinking', thinking: '', signature: 'PRIVATE_SIGNATURE' }
    });
    const { events, result } = await collect(f.session.run({ prompt: 'CONTINUE_MARKER_PROMPT' }));
    expect(result).toMatchObject({
      status: 'completed',
      finalAnswer: 'answer-after-extension-compact'
    });
    expect(compact.contexts).toHaveLength(1);
    const context = compact.contexts[0]!;
    expect(context.reason).toBe('automatic');
    expect('focus' in context).toBe(false);
    const serialized = JSON.stringify(context.messages);
    expect(serialized).not.toContain(imageBase64);
    expect(serialized).not.toContain('PRIVATE_SIGNATURE');
    expect(serialized).not.toContain('ENV_RULE_MARKER');
    expect(serialized).not.toContain('CONTINUE_MARKER_PROMPT');
    expect(serialized).toContain('TOOL_EVIDENCE_MARKER');
    expect(context.messages.every((message) => !('images' in message))).toBe(true);
    expect(context.messages.every((message) => message.role !== 'provider')).toBe(true);
    expect(new Set(context.messages.map((message) => message.role))).toEqual(
      new Set(['user', 'tool_call', 'tool'])
    );
    expect(context.messages.find((message) => message.role === 'tool_call')).toMatchObject({
      name: 'read',
      callId: 'evidence-read'
    });
    expect(f.adapter.requests.some((request) => request.toolChoice === 'none')).toBe(false);
    expect(f.adapter.requests).toHaveLength(3);
    // The compaction runs inside the first execution once provider usage crosses the threshold.
    expect(JSON.stringify(seeded.events)).not.toContain('AUTO_EXTENSION_SUMMARY');
    const compacting = seeded.events.find((event) => event.type === 'context.compacting');
    expect(seeded.events.find((event) => event.type === 'context.compacted')).toMatchObject({
      compactionId: (compacting as { compactionId: string } | undefined)?.compactionId
    });
    expect(JSON.stringify(events)).not.toContain('AUTO_EXTENSION_SUMMARY');
    const checkpoints = (await readRecords(f.home, f.session.id)).filter(
      (record) => record.type === 'compact.completed'
    );
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      payload: { summary: 'AUTO_EXTENSION_SUMMARY parser work done', automatic: true }
    });
    expect(checkpoints[0]!.payload).not.toHaveProperty('usage');
    expect(JSON.stringify(f.adapter.requests.at(-1)!.messages)).toContain('AUTO_EXTENSION_SUMMARY');
  });

  it.each([
    [
      'declines by passing through next',
      (
        context: ExtensionCompactContext,
        _call: ExtensionOperationContext,
        next: () => Promise<undefined>
      ) => next()
    ],
    [
      'throws an external-model error',
      () => {
        throw new Error('external model unavailable');
      }
    ],
    ['returns a blank summary', () => ({ summary: '   ' })],
    [
      'returns an over-budget summary',
      (context: ExtensionCompactContext) => ({
        summary: 'word '.repeat(context.summaryTokenBudget * 3)
      })
    ],
    [
      'returns an invalid usage payload',
      () => ({ summary: 'usable text', usage: { inputTokens: -5 } })
    ]
  ])(
    'falls back to the default model compact exactly once when the extension %s',
    async (_name, handler) => {
      const compact = compactExtension(handler);
      const f = await compactFixture({
        extensions: [compact.extension],
        model: { contextWindowTokens: 10_000, maxOutputTokens: 1_000 },
        script: (request) => {
          if (request.toolChoice === 'none') return modelSummary('MODEL_DEFAULT_SUMMARY');
          return latestUserText(request) === 'first'
            ? usageAnswer('answer-1', 9_200)
            : answer('continued-after-default');
        }
      });
      await f.session.run({ prompt: 'first' }).result();
      expect(await f.session.run({ prompt: 'continue' }).result()).toMatchObject({
        status: 'completed',
        finalAnswer: 'continued-after-default'
      });
      expect(compact.contexts).toHaveLength(1);
      expect(f.adapter.requests.filter((request) => request.toolChoice === 'none')).toHaveLength(1);
      const checkpoints = (await readRecords(f.home, f.session.id)).filter(
        (record) => record.type === 'compact.completed'
      );
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]).toMatchObject({
        payload: { summary: 'MODEL_DEFAULT_SUMMARY', automatic: true }
      });
    }
  );

  it('falls back to the default manual compact flow once when the extension result is invalid', async () => {
    const compact = compactExtension(() => ({ summary: '' }));
    const f = await compactFixture({
      extensions: [compact.extension],
      script: (request) =>
        request.toolChoice === 'none' ? modelSummary('MANUAL_DEFAULT_SUMMARY') : answer('seeded')
    });
    await f.session.run({ prompt: 'seed' }).result();
    const { result } = await collect(f.session.compact());
    expect(result).toMatchObject({ status: 'completed', finalAnswer: '' });
    expect(compact.contexts).toHaveLength(1);
    expect(compact.contexts[0]).toMatchObject({
      reason: 'manual',
      focus: DEFAULT_COMPACTION_FOCUS
    });
    expect(f.adapter.requests.filter((request) => request.toolChoice === 'none')).toHaveLength(1);
    const checkpoints = (await readRecords(f.home, f.session.id)).filter(
      (record) => record.type === 'compact.completed'
    );
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      payload: { summary: 'MANUAL_DEFAULT_SUMMARY', automatic: false }
    });
  });

  it('does not re-enter the extension when capacity retries switch the default compact', async () => {
    const compact = compactExtension(() => ({ summary: '   ' }));
    const f = await compactFixture({
      extensions: [compact.extension],
      model: { contextWindowTokens: 50_000, maxOutputTokens: 1_000 },
      script: (request) => {
        if (request.toolChoice === 'none') {
          if (
            request.messages.filter((message) => message.contextualBlock === undefined).length > 2
          )
            throw new AgentError(
              'context_length_exceeded',
              'Native compact exceeded the provider context window.'
            );
          return modelSummary('RECOVERED_DEFAULT_SUMMARY');
        }
        return latestUserText(request) === 'seed'
          ? usageAnswer('seeded', 43_000)
          : answer('continued-after-capacity-retry');
      }
    });
    await f.session.run({ prompt: 'seed' }).result();
    expect(await f.session.run({ prompt: 'continue' }).result()).toMatchObject({
      status: 'completed',
      finalAnswer: 'continued-after-capacity-retry'
    });
    expect(compact.contexts).toHaveLength(1);
    const compactRequests = f.adapter.requests.filter((request) => request.toolChoice === 'none');
    expect(compactRequests).toHaveLength(2);
    expect(compactRequests[0]!.messages.length).toBeGreaterThan(2);
    expect(
      compactRequests[1]!.messages.filter((message) => message.contextualBlock === undefined)
    ).toHaveLength(2);
    const checkpoints = (await readRecords(f.home, f.session.id)).filter(
      (record) => record.type === 'compact.completed'
    );
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      payload: { summary: 'RECOVERED_DEFAULT_SUMMARY', automatic: true }
    });
  });

  it('fails manual compaction at its deadline without committing an extension summary', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
    });
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const compact = compactExtension((_context, call) => {
      notifyStarted();
      return new Promise<ExtensionCompactResult | undefined>((_resolve, reject) => {
        call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true });
      });
    });
    const f = await compactFixture({
      extensions: [compact.extension],
      script: () => answer('seeded')
    });
    await f.session.run({ prompt: 'seed' }).result();
    const pending = f.session.compact().result();
    await started;
    await vi.advanceTimersByTimeAsync(600_001);
    const result = await pending;
    expect(result).toMatchObject({ status: 'failed', errorCode: 'MAR_AGENT_MODEL_TIMEOUT' });
    const records = await readRecords(f.home, f.session.id);
    expect(records.some((record) => record.type === 'compact.completed')).toBe(false);
    expect(JSON.stringify(records)).not.toContain('EXTENSION');
    expect(records.some((record) => record.type === 'turn.user')).toBe(true);
    expect(
      records.filter((record) => record.type === 'compact.progress').at(-1)?.payload
    ).toMatchObject({ state: 'FINISHED', timedOut: true });
    expect(f.host.events.some((event) => event.type === 'context.compacted')).toBe(false);
  });

  it('discards a late extension summary that resolves after the operation deadline', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
    });
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let release!: (value: ExtensionCompactResult) => void;
    const gate = new Promise<ExtensionCompactResult>((resolve) => {
      release = resolve;
    });
    const compact = compactExtension(
      (_context, call) =>
        new Promise<ExtensionCompactResult | undefined>((resolve) => {
          notifyStarted();
          call.signal.addEventListener(
            'abort',
            () => {
              void gate.then((value) => resolve(value));
            },
            { once: true }
          );
        })
    );
    const f = await compactFixture({
      extensions: [compact.extension],
      script: () => answer('seeded')
    });
    await f.session.run({ prompt: 'seed' }).result();
    const pending = f.session.compact().result();
    await started;
    await vi.advanceTimersByTimeAsync(600_001);
    const beforeLate = await readRecords(f.home, f.session.id);
    expect(beforeLate.some((record) => record.type === 'compact.completed')).toBe(false);
    release({ summary: 'LATE_EXTENSION_SUMMARY' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(await pending).toMatchObject({ status: 'failed', errorCode: 'MAR_AGENT_MODEL_TIMEOUT' });
    const records = await readRecords(f.home, f.session.id);
    expect(records.some((record) => record.type === 'compact.completed')).toBe(false);
    expect(JSON.stringify(records)).not.toContain('LATE_EXTENSION_SUMMARY');
    expect(f.host.events.some((event) => event.type === 'context.compacted')).toBe(false);
  });

  it('commits manual extension Compact despite high provider budget units', async () => {
    const compact = compactExtension(() => ({
      summary: 'BUDGETED_EXTENSION_SUMMARY',
      usage: { rolloutBudgetUnits: 11_000 }
    }));
    const f = await compactFixture({
      extensions: [compact.extension],
      script: (request) =>
        request.toolChoice === 'none' ? modelSummary('NEVER_USED_SUMMARY') : answer('seeded')
    });
    await f.session.run({ prompt: 'seed' }).result();
    const { events, result } = await collect(f.session.compact());
    expect(result).toMatchObject({
      status: 'completed'
    });
    expect(events.some((event) => event.type === 'context.compacted')).toBe(true);
    const records = await readRecords(f.home, f.session.id);
    expect(records.some((record) => record.type === 'compact.completed')).toBe(true);
    expect(f.adapter.requests.some((request) => request.toolChoice === 'none')).toBe(false);
  });

  it('records automatic extension usage as public usage and checkpoint evidence', async () => {
    const compact = compactExtension(() => ({
      summary: 'USAGE_EXTENSION_SUMMARY',
      usage: { inputTokens: 120, outputTokens: 30 }
    }));
    const f = await compactFixture({
      extensions: [compact.extension],
      model: { contextWindowTokens: 10_000, maxOutputTokens: 1_000 },
      script: (request) => {
        if (request.toolChoice === 'none') return modelSummary('MODEL_DEFAULT_SUMMARY');
        return latestUserText(request) === 'first'
          ? usageAnswer('answer-1', 9_200)
          : answer('continued-with-extension-usage');
      }
    });
    const seeded = await collect(f.session.run({ prompt: 'first' }));
    const { events, result } = await collect(f.session.run({ prompt: 'continue' }));
    expect(result).toMatchObject({ status: 'completed' });
    expect([...seeded.events, ...events]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'usage.updated', inputTokens: 120, outputTokens: 30 })
      ])
    );
    const checkpoints = (await readRecords(f.home, f.session.id)).filter(
      (record) => record.type === 'compact.completed'
    );
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      payload: { summary: 'USAGE_EXTENSION_SUMMARY', usage: { inputTokens: 120, outputTokens: 30 } }
    });
  });

  it('consults the extension before the default prompt window check in manual compact', async () => {
    const compact = compactExtension(() => ({ summary: 'SMALL_WINDOW_HANDOFF' }));
    const f = await compactFixture({
      extensions: [compact.extension],
      model: { contextWindowTokens: 1_500, maxOutputTokens: 500 },
      script: (request) =>
        request.toolChoice === 'none' ? modelSummary('MODEL_DEFAULT_SUMMARY') : answer('seeded')
    });
    await f.session.run({ prompt: 'seed' }).result();
    const { result } = await collect(f.session.compact());
    expect(result).toMatchObject({ status: 'completed', finalAnswer: '' });
    expect(compact.contexts).toHaveLength(1);
    expect(f.adapter.requests.some((request) => request.toolChoice === 'none')).toBe(false);
    const checkpoints = (await readRecords(f.home, f.session.id)).filter(
      (record) => record.type === 'compact.completed'
    );
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      payload: { summary: 'SMALL_WINDOW_HANDOFF', automatic: false }
    });
  });

  it('consults the extension for automatic compact even when the default prompt cannot fit the window', async () => {
    const compact = compactExtension(() => ({ summary: 'SMALL_WINDOW_AUTO_SUMMARY' }));
    const f = await compactFixture({
      extensions: [compact.extension],
      model: { contextWindowTokens: 1_500, maxOutputTokens: 500 },
      script: (request) => {
        if (request.toolChoice === 'none') return modelSummary('MODEL_DEFAULT_SUMMARY');
        return latestUserText(request) === 'seed'
          ? usageAnswer('seeded', 1_400)
          : answer('continued-small-window');
      }
    });
    await f.session.run({ prompt: 'seed' }).result();
    expect(await f.session.run({ prompt: 'continue' }).result()).toMatchObject({
      status: 'completed',
      finalAnswer: 'continued-small-window'
    });
    expect(compact.contexts).toHaveLength(1);
    expect(f.adapter.requests.some((request) => request.toolChoice === 'none')).toBe(false);
    const checkpoints = (await readRecords(f.home, f.session.id)).filter(
      (record) => record.type === 'compact.completed'
    );
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      payload: { summary: 'SMALL_WINDOW_AUTO_SUMMARY', automatic: true }
    });
  });

  describe('continuation reset regression', () => {
    it('retains a committed checkpoint receipt when continuation reset fails after persistence', async () => {
      let context!: SessionExtensionContext;
      const compact = compactExtension(() => ({ summary: 'COMMITTED_BEFORE_RESET_FAILURE' }));
      const f = await compactFixture({
        extensions: [
          compact.extension,
          {
            id: 'compact-receipt-observer',
            apiVersion: '1.0',
            attachSession(value) {
              context = value;
            }
          }
        ],
        script: () => answer('seeded')
      });
      await f.session.run({ prompt: 'seed' }).result();
      const createTurn = f.adapter.createTurnSession.bind(f.adapter);
      const reset = vi.spyOn(f.adapter, 'createTurnSession').mockImplementation(() => ({
        ...createTurn(),
        resetContinuation() {
          throw new Error('injected reset failure');
        }
      }));

      expect((await f.session.compact().result()).status).toBe('failed');
      const checkpoint = (await readRecords(f.home, f.session.id)).filter(
        (record) => record.type === 'compact.completed'
      );
      expect(checkpoint).toHaveLength(1);
      expect(checkpoint[0]).toMatchObject({
        payload: { summary: 'COMMITTED_BEFORE_RESET_FAILURE' }
      });
      const receipt = (await context.session!.inspect()).operations.find(
        (item) => item.kind === 'compact'
      );
      expect(receipt).toMatchObject({
        status: 'failed',
        changed: true,
        recordId: checkpoint[0]!.recordId
      });

      reset.mockRestore();
      expect((await f.session.run({ prompt: 'continue after compact' }).result()).status).toBe(
        'completed'
      );
      expect(
        f.adapter.requests
          .at(-1)!
          .messages.some((message) => message.content.includes('COMMITTED_BEFORE_RESET_FAILURE'))
      ).toBe(true);
    });

    it('resets the adapter continuation exactly once after a manual extension checkpoint commits', async () => {
      const compact = compactExtension(() => ({ summary: 'RESET_MANUAL_EXTENSION_SUMMARY' }));
      const f = await compactFixture({
        extensions: [compact.extension],
        script: (request) =>
          request.toolChoice === 'none' ? modelSummary('UNUSED_DEFAULT_SUMMARY') : answer('seeded')
      });
      await f.session.run({ prompt: 'seed' }).result();
      expect(f.adapter.resetContinuationCalls).toBe(0);
      const { result } = await collect(f.session.compact());
      expect(result).toMatchObject({ status: 'completed', finalAnswer: '' });
      expect(f.adapter.resetContinuationCalls).toBe(1);
      const checkpoints = (await readRecords(f.home, f.session.id)).filter(
        (record) => record.type === 'compact.completed'
      );
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]).toMatchObject({
        payload: { summary: 'RESET_MANUAL_EXTENSION_SUMMARY', automatic: false }
      });
    });

    it('resets continuation after a high-usage manual extension checkpoint commits', async () => {
      const compact = compactExtension(() => ({
        summary: 'BUDGET_FAILURE_SUMMARY',
        usage: { rolloutBudgetUnits: 11_000 }
      }));
      const f = await compactFixture({
        extensions: [compact.extension],
        script: (request) =>
          request.toolChoice === 'none' ? modelSummary('UNUSED_DEFAULT_SUMMARY') : answer('seeded')
      });
      await f.session.run({ prompt: 'seed' }).result();
      expect(f.adapter.resetContinuationCalls).toBe(0);
      const { result } = await collect(f.session.compact());
      expect(result).toMatchObject({
        status: 'completed'
      });
      expect(f.adapter.resetContinuationCalls).toBe(1);
      const records = await readRecords(f.home, f.session.id);
      expect(records.some((record) => record.type === 'compact.completed')).toBe(true);
    });

    it('resets the adapter continuation exactly once after an automatic extension checkpoint', async () => {
      const compact = compactExtension(() => ({ summary: 'RESET_AUTO_EXTENSION_SUMMARY' }));
      const f = await compactFixture({
        extensions: [compact.extension],
        model: { contextWindowTokens: 10_000, maxOutputTokens: 1_000 },
        script: (request) => {
          if (request.toolChoice === 'none') return modelSummary('UNUSED_DEFAULT_SUMMARY');
          return latestUserText(request) === 'first'
            ? usageAnswer('answer-1', 9_200)
            : answer('continued-after-auto-reset');
        }
      });
      await f.session.run({ prompt: 'first' }).result();
      expect(await f.session.run({ prompt: 'continue' }).result()).toMatchObject({
        status: 'completed',
        finalAnswer: 'continued-after-auto-reset'
      });
      expect(f.adapter.resetContinuationCalls).toBe(1);
      const checkpoints = (await readRecords(f.home, f.session.id)).filter(
        (record) => record.type === 'compact.completed'
      );
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]).toMatchObject({
        payload: { summary: 'RESET_AUTO_EXTENSION_SUMMARY', automatic: true }
      });
    });
  });
});
