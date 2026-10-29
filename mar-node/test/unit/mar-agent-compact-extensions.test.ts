import { executionActivity } from './support/execution-activity.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { generateModelText } = vi.hoisted(() => ({ generateModelText: vi.fn() }));
vi.mock('@myagentroam/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@myagentroam/agent')>();
  return {
    ...actual,
    generateModelText: (...args: unknown[]) => generateModelText(...args)
  };
});

import {
  AgentError,
  SecretValue,
  buildCompactEvidence,
  countModelTokens,
  type AgentModelConfiguration,
  type AgentReasoningEffort
} from '@myagentroam/agent';
import type { ExtensionCompactContext, ExtensionSource } from '@myagentroam/agent/extensions';
import type { MarAgentRuntimeModelConfiguration } from '@myagentroam/protocol';
import { highDensityCompactionPrompt } from '../../src/runner/mar-agent/compact-prompt.js';
import { MarAgentManagedRunController } from '../../src/runner/mar-agent/managed-run-controller.js';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';
import { MarAgentRuntimeModelFactory } from '../../src/runner/mar-agent/runtime-model-factory.js';
import {
  compactRuntimeConfigurations,
  generateMarAgentCompact,
  marAgentCompactExtensionSource,
  updateMarAgentCompactState,
  type MarAgentCompactState
} from '../../src/runner/mar-agent/compact-extensions.js';

function model(overrides: Partial<AgentModelConfiguration> = {}): AgentModelConfiguration {
  return {
    id: 'compact-model',
    name: 'Compact',
    protocol: 'ANTHROPIC_MESSAGES',
    baseUrl: 'https://compact.invalid',
    apiKey: new SecretValue('fixture'),
    modelId: 'compact-model',
    contextWindowTokens: 200_000,
    maxOutputTokens: 4_096,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    conversationModel: false,
    titleGeneration: false,
    codeMode: false,
    hostedWebSearch: false,
    responsesPreviousResponseId: false,
    enabled: true,
    ...overrides
  };
}
function compactContext(overrides: Partial<ExtensionCompactContext> = {}): ExtensionCompactContext {
  return {
    operationId: 'operation',
    reason: 'manual',
    summaryTokenBudget: 1_000,
    getPrompt: () => 'Core continuation contract: preserve evidence and output only the handoff.',
    messages: [
      { role: 'user', content: 'objective with durable goal CONTRACT_MARKER' },
      { role: 'assistant', content: 'implemented the parser change' },
      {
        role: 'tool_call',
        content: '',
        callId: 'read-1',
        name: 'read',
        arguments: { reads: [{ path: 'evidence.txt' }] }
      },
      { role: 'tool', content: 'TOOL_EVIDENCE_MARKER verified', callId: 'read-1', name: 'read' }
    ],
    ...overrides
  };
}
const selected = (overrides: Partial<AgentModelConfiguration> = {}) => ({
  model: model(overrides),
  reasoningEffort: 'high' as AgentReasoningEffort
});
type CompactAttachContext = {
  hooks: {
    intercept: (
      key: string,
      handler: (input: ExtensionCompactContext, call: { signal: AbortSignal }) => unknown
    ) => { dispose: () => Promise<void> };
  };
};

describe('MAR Agent compact extension', () => {
  it('retains a failed attempt without attributing its error to a later successful attempt', async () => {
    const reportDiagnostic = vi.fn();
    generateModelText.mockImplementationOnce(async (input) => {
      await input.onAttemptDiagnostic({ state: 'STARTED' });
      await input.onAttemptDiagnostic({
        state: 'FAILED',
        errorCode: 'UNAUTHORIZED',
        transport: 'HTTP'
      });
      await input.onAttemptDiagnostic({ state: 'STARTED' });
      return { text: 'recovered summary' };
    });
    await generateMarAgentCompact(
      compactContext({ reportDiagnostic }),
      selected(),
      new AbortController().signal
    );
    expect(
      reportDiagnostic.mock.calls.some(
        ([value]) => value.state === 'FAILED' && value.errorCode === 'UNAUTHORIZED'
      )
    ).toBe(true);
    expect(reportDiagnostic.mock.calls.at(-1)![0]).toMatchObject({
      state: 'SUCCEEDED',
      modelRequests: 2
    });
    expect(reportDiagnostic.mock.calls.at(-1)![0]).not.toHaveProperty('errorCode');
  });

  it.each(['manual', 'automatic'] as const)(
    'preserves actionable failure facts without copying raw errors for %s compact',
    async (reason) => {
      const reportDiagnostic = vi.fn();
      generateModelText.mockImplementationOnce(async (input) => {
        await input.onAttemptDiagnostic({ state: 'STARTED' });
        await input.onAttemptDiagnostic({
          state: 'FAILED',
          errorCode: 'MAR_AGENT_MODEL_REQUEST_FAILED',
          errorMessage: 'SECRET_PROVIDER_ERROR',
          causeCode: 'ECONNRESET',
          reason: 'MODEL_TRANSPORT_FAILURE',
          retryable: true,
          transport: 'HTTP'
        });
        throw new AgentError('MAR_AGENT_MODEL_REQUEST_FAILED', 'SECRET_PROVIDER_ERROR', {
          retryable: true,
          details: { status: 503, authorization: 'SECRET_AUTH' }
        });
      });
      await generateMarAgentCompact(
        compactContext({ reason, reportDiagnostic }),
        selected(),
        new AbortController().signal
      );
      expect(reportDiagnostic.mock.calls.at(-1)![0]).toMatchObject({
        state: 'FAILED',
        trigger: reason,
        errorCode: 'MAR_AGENT_MODEL_REQUEST_FAILED',
        causeCode: 'ECONNRESET',
        errorReason: 'MODEL_TRANSPORT_FAILURE',
        retryable: true,
        transport: 'HTTP',
        httpStatus: 503,
        modelRequests: 1
      });
      expect(JSON.stringify(reportDiagnostic.mock.calls)).not.toContain('SECRET_');
    }
  );

  it('reports actual attempts, selected model and input trimming without copying provider errors', async () => {
    const reportDiagnostic = vi.fn();
    generateModelText.mockImplementationOnce(async (input) => {
      await input.onAttemptDiagnostic({ state: 'STARTED' });
      return { text: 'summary' };
    });
    const context = compactContext({
      reportDiagnostic,
      messages: [{ role: 'user', content: 'large evidence '.repeat(5_000) }]
    });
    expect(
      await generateMarAgentCompact(
        context,
        selected({ contextWindowTokens: 10_000 }),
        new AbortController().signal
      )
    ).toMatchObject({ summary: 'summary' });
    const success = reportDiagnostic.mock.calls.at(-1)![0];
    expect(success).toMatchObject({
      modelId: 'compact-model',
      providerModelId: 'compact-model',
      reasoningEffort: 'high',
      state: 'SUCCEEDED',
      modelRequests: 1
    });
    expect(success.inputTokensEstimateBefore).toBeGreaterThan(10_000);
    expect(success.inputTokensEstimateAfter).toBeLessThanOrEqual(9_000);
    generateModelText.mockRejectedValueOnce(new Error('SECRET_PROVIDER_ERROR'));
    await generateMarAgentCompact(
      compactContext({ reportDiagnostic }),
      selected(),
      new AbortController().signal
    );
    expect(reportDiagnostic.mock.calls.at(-1)![0]).toMatchObject({
      state: 'FAILED',
      reason: 'MODEL_FAILED',
      errorCode: 'MAR_AGENT_COMPACT_MODEL_FAILED',
      modelRequests: 0
    });
    expect(JSON.stringify(reportDiagnostic.mock.calls)).not.toContain('SECRET_PROVIDER_ERROR');
  });

  it('reports fixed-overhead decline without a request and ignores diagnostic failures', async () => {
    const reportDiagnostic = vi.fn();
    await generateMarAgentCompact(
      compactContext({ reportDiagnostic }),
      selected({ contextWindowTokens: 100 }),
      new AbortController().signal
    );
    expect(reportDiagnostic).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'DECLINED',
        reason: 'INPUT_BUDGET_EXHAUSTED',
        modelRequests: 0
      })
    );
    expect(generateModelText).not.toHaveBeenCalled();
    generateModelText.mockResolvedValueOnce({ text: 'summary' });
    reportDiagnostic.mockRejectedValue(new Error('log unavailable'));
    expect(
      await generateMarAgentCompact(
        compactContext({ reportDiagnostic }),
        selected(),
        new AbortController().signal
      )
    ).toMatchObject({ summary: 'summary' });
    expect(generateModelText).toHaveBeenCalledTimes(1);
  });

  it.each(['RUNTIME_TICKET', 'INLINE_API_KEY'] as const)(
    'keeps the static main catalog warm and binds a hidden %s compactor to the right Execution',
    async (credentialType) => {
      const root = await mkdtemp(join(tmpdir(), 'mar-hidden-compact-rebind-'));
      const reconfigureModels = vi.fn(
        async (_input: { models: readonly AgentModelConfiguration[]; defaultModelId: string }) =>
          undefined
      );
      const handle = () => ({
        executionId: 'execution',
        async *[Symbol.asyncIterator]() {},
        result: async () => ({
          executionId: 'execution',
          status: 'completed' as const,
          finalAnswer: 'done'
        }),
        cancel: vi.fn()
      });
      const session = { id: 'native', run: handle, plan: handle, compact: handle, cancel: vi.fn() };
      let compactSource!: ExtensionSource;
      const createAgent = vi.fn(async (options: { extensions: ExtensionSource }) => {
        compactSource = options.extensions;
        return {
          createSession: async () => session,
          openSession: async () => session,
          getSession: async () => ({
            id: 'native',
            title: 'New session',
            workspace: root,
            automaticTitlePending: false
          }),
          setSystemInstruction: vi.fn(),
          reconfigureModels,
          extensionDiagnostics: () => [],
          dispose: vi.fn()
        };
      });
      const factory = new MarAgentRuntimeModelFactory({ resolve: vi.fn() });
      const createModels = vi.spyOn(factory, 'create');
      const controller = new MarAgentManagedRunController(
        new MarAgentRunner(root),
        {
          ...executionActivity(),
          adopt: vi.fn(),
          promote: vi.fn(),
          syncTitle: vi.fn(),
          emit: vi.fn(),
          emitItem: vi.fn(),
          run: vi.fn(),
          commandState: vi.fn(),
          setCommandState: vi.fn(),
          clearCommandState: vi.fn(),
          commandStates: () => [],
          webSearch: vi.fn()
        },
        { createAgent: createAgent as never, modelFactory: factory }
      );
      const main = runtimeModel(model({ id: 'main', conversationModel: true }));
      const compact = runtimeModel(model({ subagentModel: false }));
      if (credentialType === 'RUNTIME_TICKET') {
        delete compact.apiKey;
        compact.credential = {
          type: 'RUNTIME_TICKET',
          credentialId: 'compact-credential',
          ticket: {
            userId: 1,
            credentialId: 'compact-credential',
            nodeId: 'node',
            workspaceId: 'workspace',
            sessionId: 'native',
            runtimeScopeId: 'scope',
            allowedModelIds: [compact.id],
            issuedAt: 1_000,
            expiresAt: 3_601_000,
            nonce: 'ticket',
            signature: 'a'.repeat(64)
          }
        };
      } else {
        delete compact.apiKey;
        compact.credential = { type: 'INLINE_API_KEY', value: 'fixture-only' };
      }
      const input = {
        sessionId: 'projection',
        externalSessionId: 'native',
        cwd: root,
        input: 'continue',
        model: main,
        models: [main],
        compact: { model: compact, reasoningEffort: 'high' },
        runtimeScopeId: 'scope',
        effort: 'high',
        mode: 'run',
        mcpServers: [],
        images: []
      };
      const run = (controller as unknown as { run(input: unknown): Promise<void> }).run.bind(
        controller
      );
      const reconfigureStarted = Promise.withResolvers<void>();
      const reconfigureCompleted = Promise.withResolvers<void>();
      try {
        await run({ ...input, runId: 'first' });
        const sourceRevision = async () =>
          (await compactSource.resolve({ signal: new AbortController().signal })).revision;
        const firstRevision = await sourceRevision();
        if (credentialType === 'RUNTIME_TICKET') {
          reconfigureModels.mockImplementationOnce(async () => {
            reconfigureStarted.resolve();
            await reconfigureCompleted.promise;
          });
          const secondRun = run({ ...input, runId: 'second' });
          try {
            await reconfigureStarted.promise;
            expect(await sourceRevision()).toBe(firstRevision);
          } finally {
            reconfigureCompleted.resolve();
            await secondRun;
          }
        } else {
          await run({ ...input, runId: 'second' });
        }
        expect(await sourceRevision()).not.toBe(firstRevision);
        expect(createAgent).toHaveBeenCalledTimes(1);
        expect(createModels).toHaveBeenCalledTimes(credentialType === 'RUNTIME_TICKET' ? 2 : 1);
        expect(reconfigureModels).toHaveBeenCalledTimes(
          credentialType === 'RUNTIME_TICKET' ? 1 : 0
        );
        if (credentialType === 'RUNTIME_TICKET') {
          expect(createModels).toHaveBeenLastCalledWith(
            [main, { ...compact, useResourceUrl: false }],
            {
              runtimeScopeId: 'scope',
              executionId: 'second'
            }
          );
          expect(reconfigureModels.mock.calls[0]![0]).toMatchObject({
            models: [{ id: main.id }],
            defaultModelId: main.id
          });
          expect(
            (createModels.mock.results[0]!.value as ReturnType<typeof factory.create>)[1]!
              .credentialProvider
          ).not.toBe(
            (createModels.mock.results[1]!.value as ReturnType<typeof factory.create>)[1]!
              .credentialProvider
          );
        }
      } finally {
        await controller.dispose();
        for (const result of createModels.mock.results) {
          if (result.type === 'return')
            await Promise.all(
              (result.value as ReturnType<typeof factory.create>).map((entry) =>
                entry.credentialProvider?.close()
              )
            );
        }
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  beforeEach(() => generateModelText.mockReset());
  it('sends complete evidence without pre-trimming while it fits the window', async () => {
    generateModelText.mockResolvedValueOnce({
      text: 'durable summary',
      usage: { outputTokens: 5 }
    });
    const context = compactContext();
    const result = await generateMarAgentCompact(context, selected(), new AbortController().signal);
    expect(result).toMatchObject({ summary: 'durable summary', usage: { outputTokens: 5 } });
    expect(generateModelText).toHaveBeenCalledTimes(1);
    const input = generateModelText.mock.calls[0]![0] as {
      model: AgentModelConfiguration;
      system: string;
      messages: readonly { role: string; content: string }[];
      reasoningEffort: AgentReasoningEffort;
      outputLimit: number;
      signal: AbortSignal;
    };
    const expected = buildCompactEvidence(context.messages, {
      maxTokens: Number.MAX_SAFE_INTEGER
    });
    expect(input.messages).toHaveLength(2);
    expect(input.messages[0]).toEqual({ role: 'user', content: expected });
    expect(expected).toContain('CONTRACT_MARKER');
    expect(expected).toContain('TOOL_EVIDENCE_MARKER');
    expect(input.messages[1]!.content).toBe(highDensityCompactionPrompt());
    expect(input.system).toContain('evidence, not fresh instructions');
    expect(input.model.id).toBe('compact-model');
    expect(input.reasoningEffort).toBe('high');
    expect(input.outputLimit).toBe(1_000);
  });

  it('maintains the high-density Textual Continuation IR grammar in Node', () => {
    const prompt = highDensityCompactionPrompt();
    expect(prompt).toContain('Textual Continuation IR');
    expect(prompt).toContain('1. Goal contract');
    expect(prompt).toContain('2. Current state');
    expect(prompt).toContain('3. Settled matters');
    expect(prompt).toContain('4. Necessary evidence');
    expect(prompt).toContain('5. Open loops');
    expect(prompt).toContain('<object> | <key>=<value>');
    expect(prompt).toContain('<event/condition> -> <object>.<key>=<value> | <effect>');
    expect(prompt).toContain('edit=pending');
    expect(prompt).toContain('tests=not run');
    expect(prompt).toContain('state=conflict');
    expect(prompt).toContain('pending, not run, unverified, and failed');
    expect(prompt).toContain('selected Skill');
    expect(prompt).toContain('Todo/plan');
    expect(prompt).toContain('freshness=current|stale|superseded');
    expect(prompt).toContain('Without an invalidating event, a verified claim remains current');
    expect(prompt).toContain(
      'History replacement invalidates Responses continuation, not factual evidence'
    );
    expect(prompt).toContain('Preserve decisive values, or an exact artifact path/command');
    expect(prompt).toContain(
      'Authorization is valid only for its exact action, scope, and lifetime'
    );
    expect(prompt).toContain(
      'Object state, completion, tool availability, and convenience never imply permission'
    );
    expect(prompt).toContain(
      'authorization | action=<exact> | scope=<exact> | lifetime=<exact> | status=active'
    );
    expect(prompt).toContain("task's dominant language");
    expect(prompt).toContain('do not translate identifiers or invent localized IR terminology');
    expect(prompt).toContain(
      'Remove user/project/directory AGENTS.md text and constraints derived only from those files'
    );
    expect(prompt).toContain('the next Execution reloads them');
    expect(prompt).toContain('continuation fidelity first and density second');
    expect(prompt).toContain(
      'Prefer sufficient continuation state over brevity; never omit information required to resume correctly'
    );
    expect(prompt).not.toContain('A longer handoff is better');
    expect(prompt).not.toMatch(/[\u4e00-\u9fff]/u);
    expect(prompt).not.toContain('Continue from the compacted state below');
  });

  it.each(['manual', 'automatic'] as const)(
    'uses the Node prompt without reading the Core getter for %s compact',
    async (reason) => {
      generateModelText.mockResolvedValueOnce({ text: 'Node contract summary' });
      const getPrompt = vi.fn(() => {
        throw new Error('Core getter must not be called');
      });
      await generateMarAgentCompact(
        compactContext({ reason, getPrompt }),
        selected(),
        new AbortController().signal
      );
      expect(getPrompt).not.toHaveBeenCalled();
      expect(
        (generateModelText.mock.calls[0]![0] as { messages: { content: string }[] }).messages[1]
      ).toEqual({ role: 'user', content: highDensityCompactionPrompt() });
    }
  );

  it('counts the Node prompt in the fixed instruction overhead', async () => {
    const getPrompt = vi.fn(() => 'short Core prompt');
    await expect(
      generateMarAgentCompact(
        compactContext({ getPrompt }),
        selected({ contextWindowTokens: countModelTokens(highDensityCompactionPrompt()) }),
        new AbortController().signal
      )
    ).resolves.toBeUndefined();
    expect(getPrompt).not.toHaveBeenCalled();
    expect(generateModelText).not.toHaveBeenCalled();
  });

  it('trims evidence to the ninety-percent budget only when the full render overflows', async () => {
    generateModelText.mockResolvedValueOnce({ text: 'trimmed summary' });
    const context = compactContext({
      messages: compactContext().messages.map((message, index) => ({
        ...message,
        content: message.content || `evidence-${index} `.repeat(4_000)
      }))
    });
    const small = selected({ contextWindowTokens: 4_000, maxOutputTokens: 500 });
    const result = await generateMarAgentCompact(context, small, new AbortController().signal);
    expect(result).toMatchObject({ summary: 'trimmed summary' });
    const evidence = (generateModelText.mock.calls[0]![0] as { messages: { content: string }[] })
      .messages[0]!.content;
    expect(countModelTokens(evidence)).toBeLessThanOrEqual(Math.floor(4_000 * 0.9));
    expect(countModelTokens(evidence)).toBeGreaterThan(0);
    expect((generateModelText.mock.calls[0]![0] as { outputLimit: number }).outputLimit).toBe(500);
  });

  it('keeps the focus instruction for both full and trimmed evidence', async () => {
    generateModelText.mockResolvedValue({ text: 'focused summary' });
    const context = compactContext({ focus: 'preserve parser state' });
    await generateMarAgentCompact(context, selected(), new AbortController().signal);
    expect(
      (generateModelText.mock.calls[0]![0] as { messages: { content: string }[] }).messages[0]!
        .content
    ).toContain('preserve parser state');
    const overflow = compactContext({
      focus: 'preserve parser state',
      messages: compactContext().messages.map((message) => ({
        ...message,
        content: `${message.content} ${'bulk '.repeat(5_000)}`
      }))
    });
    await generateMarAgentCompact(
      overflow,
      selected({ contextWindowTokens: 4_000, maxOutputTokens: 1_000 }),
      new AbortController().signal
    );
    expect(
      (generateModelText.mock.calls[1]![0] as { messages: { content: string }[] }).messages[0]!
        .content
    ).toContain('preserve parser state');
  });

  it.each([
    ['no usable text', () => undefined],
    ['an external failure', () => Promise.reject(new Error('provider unreachable'))]
  ])(
    'declines with exactly one generation attempt when the SDK returns %s',
    async (_name, outcome) => {
      generateModelText.mockImplementationOnce(outcome);
      await expect(
        generateMarAgentCompact(compactContext(), selected(), new AbortController().signal)
      ).resolves.toBeUndefined();
      expect(generateModelText).toHaveBeenCalledTimes(1);
    }
  );

  it('declines before any request when the window cannot hold the instruction overhead', async () => {
    await expect(
      generateMarAgentCompact(
        compactContext(),
        selected({ contextWindowTokens: 100, maxOutputTokens: 50 }),
        new AbortController().signal
      )
    ).resolves.toBeUndefined();
    expect(generateModelText).not.toHaveBeenCalled();
  });

  it('propagates cancellation and forwards the shared signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateMarAgentCompact(compactContext(), selected(), controller.signal)
    ).rejects.toThrow();
    const signal = new AbortController().signal;
    generateModelText.mockResolvedValueOnce({ text: 'summary' });
    await generateMarAgentCompact(compactContext(), selected(), signal);
    expect((generateModelText.mock.calls.at(-1)![0] as { signal: AbortSignal }).signal).toBe(
      signal
    );
  });

  it('clears stale selections and accepts only managed enabled models with a supported effort', () => {
    const managed = model();
    const state: MarAgentCompactState = { revision: 3 };
    updateMarAgentCompactState(state, { model: runtimeModel(managed), reasoningEffort: 'high' }, [
      managed
    ]);
    expect(state).toMatchObject({
      revision: 4,
      current: { model: managed, reasoningEffort: 'high' }
    });
    updateMarAgentCompactState(
      state,
      { model: runtimeModel({ ...managed, id: 'removed' }), reasoningEffort: 'high' },
      [managed]
    );
    expect(state.revision).toBe(5);
    expect(state.current).toBeUndefined();
    updateMarAgentCompactState(state, { model: runtimeModel(managed), reasoningEffort: 'high' }, [
      { ...managed, enabled: false }
    ]);
    expect(state.current).toBeUndefined();
    updateMarAgentCompactState(
      state,
      {
        model: runtimeModel(model({ reasoningEfforts: ['low', 'high'] })),
        reasoningEffort: 'medium'
      },
      [model({ reasoningEfforts: ['low', 'high'] })]
    );
    expect(state.current).toBeUndefined();
    updateMarAgentCompactState(state, { model: 'not-an-object' }, [managed]);
    expect(state.revision).toBe(8);
    expect(state.current).toBeUndefined();
    const fixedEffort = model({ reasoningEfforts: [], defaultReasoningEffort: 'medium' });
    updateMarAgentCompactState(
      state,
      { model: runtimeModel(fixedEffort), reasoningEffort: 'medium' },
      [fixedEffort]
    );
    expect(state.current).toMatchObject({
      model: fixedEffort,
      reasoningEffort: 'medium'
    });
  });

  it('keeps the SDK catalog boundary when joining the dedicated model into a factory batch', () => {
    const dedicated = runtimeModel(model({ id: 'dedicated-compact' }));
    const existing = runtimeModel(model({ id: 'main-model', conversationModel: true }));
    expect(
      compactRuntimeConfigurations([existing], { model: dedicated, reasoningEffort: 'high' })
    ).toMatchObject([{ id: 'main-model' }, { id: 'dedicated-compact' }]);
    expect(
      compactRuntimeConfigurations([existing, dedicated], {
        model: dedicated,
        reasoningEffort: 'high'
      })
    ).toMatchObject([{ id: 'main-model' }, { id: 'dedicated-compact' }]);
    expect(compactRuntimeConfigurations([existing], { model: dedicated })).toHaveLength(1);
  });

  it('projects one compact extension that generates with the captured provider snapshot', async () => {
    const empty = marAgentCompactExtensionSource({ revision: 2 });
    expect(await empty.resolve({ signal: new AbortController().signal })).toMatchObject({
      revision: 'node-compact-2',
      extensions: []
    });
    const managed = model();
    const state: MarAgentCompactState = {
      revision: 7,
      current: { model: managed, reasoningEffort: 'low' }
    };
    const snapshot = await marAgentCompactExtensionSource(state).resolve({
      signal: new AbortController().signal
    });
    expect(snapshot.revision).toBe('node-compact-7');
    expect(snapshot.extensions).toHaveLength(1);
    const extension = snapshot.extensions[0]!;
    expect(extension).toMatchObject({ id: 'mar.node.compact', apiVersion: '1.0' });
    let handler:
      ((input: ExtensionCompactContext, call: { signal: AbortSignal }) => unknown) | undefined;
    const attach = extension.attachSession as ((context: CompactAttachContext) => void) | undefined;
    attach?.({
      hooks: {
        intercept: (key, value) => {
          if (key === 'compact.generate') handler = value as typeof handler;
          return { dispose: async () => undefined };
        }
      }
    });
    expect(handler).toBeTypeOf('function');
    generateModelText.mockResolvedValueOnce({ text: 'extension summary' });
    const signal = new AbortController().signal;
    const result = (await handler?.(compactContext(), { signal })) as { summary: string };
    expect(result).toEqual({ summary: 'extension summary' });
    expect((generateModelText.mock.calls.at(-1)![0] as { signal: AbortSignal }).signal).toBe(
      signal
    );
    expect((generateModelText.mock.calls.at(-1)![0] as { model: { id: string } }).model.id).toBe(
      'compact-model'
    );
  });

  it('keeps the legacy three-argument update without credential ownership', () => {
    const managed = model();
    const state: MarAgentCompactState = { revision: 0 };
    updateMarAgentCompactState(state, { model: runtimeModel(managed), reasoningEffort: 'high' }, [
      managed
    ]);
    expect(state.current).toBeDefined();
    expect('ownsCredentialProvider' in state.current!).toBe(false);
  });

  it('marks only catalog-hidden compaction models as owning their credential provider', () => {
    const managed = model();
    const state: MarAgentCompactState = { revision: 0 };
    updateMarAgentCompactState(
      state,
      { model: runtimeModel(managed), reasoningEffort: 'high' },
      [managed],
      ['main-model']
    );
    expect(state.current).toMatchObject({ ownsCredentialProvider: true });
    updateMarAgentCompactState(
      state,
      { model: runtimeModel(managed), reasoningEffort: 'high' },
      [managed],
      ['main-model', 'compact-model']
    );
    expect('ownsCredentialProvider' in state.current!).toBe(false);
  });

  it('closes only owned credential providers when the extension generation retires', async () => {
    const ownedClose = vi.fn();
    const owned = model({
      credentialProvider: { close: ownedClose } as never
    });
    const state: MarAgentCompactState = {
      revision: 4,
      current: { model: owned, reasoningEffort: 'high', ownsCredentialProvider: true }
    };
    const snapshot = await marAgentCompactExtensionSource(state).resolve({
      signal: new AbortController().signal
    });
    const disposer = await snapshot.extensions[0]!.setup?.({} as never);
    expect(typeof disposer).toBe('function');
    expect(ownedClose).not.toHaveBeenCalled();
    await (disposer as () => Promise<void> | void)();
    expect(ownedClose).toHaveBeenCalledTimes(1);

    const catalogClose = vi.fn();
    const catalog = model({
      id: 'catalog-compact',
      credentialProvider: { close: catalogClose } as never
    });
    const catalogState: MarAgentCompactState = {
      revision: 5,
      current: { model: catalog, reasoningEffort: 'high' }
    };
    const catalogSnapshot = await marAgentCompactExtensionSource(catalogState).resolve({
      signal: new AbortController().signal
    });
    expect(await catalogSnapshot.extensions[0]!.setup?.({} as never)).toBeUndefined();
    expect(catalogClose).not.toHaveBeenCalled();
  });
});

function runtimeModel(configuration: AgentModelConfiguration): MarAgentRuntimeModelConfiguration {
  const { apiKey, ...rest } = configuration;
  return {
    ...rest,
    baseUrl: 'https://compact.invalid',
    credential: {
      type: 'INLINE_API_KEY',
      value: apiKey instanceof SecretValue ? 'fixture-only' : apiKey!
    }
  };
}
