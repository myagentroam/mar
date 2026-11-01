import { formatReadContextItem } from '../../src/prompts/read-context.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAgentHost } from '../../src/host.js';
import {
  SecretValue,
  openAgentSessionCatalog,
  type AgentModelConfiguration
} from '../../src/index.js';
import { createAgentWithAdapter as createMarAgent } from '../../src/sdk/agent.js';
import {
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest
} from '../../src/model/contracts.js';
import { ContextGcRuntime, tryCommitContextGc } from '../../src/runtime/context/gc-runtime.js';
import { buildContextProjection } from '../../src/runtime/context/projection.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { captureExecutionContext } from './support/checkpoint-context.js';
import { restoreMessages } from '../../src/runtime/context/restore.js';
import type { SessionExtensionContext } from '../../src/extensions/contracts.js';
import * as worldState from '../../src/runtime/context/world-state.js';
import { AgentError } from '../../src/error.js';
import { activeSessionDirectory } from '../support/jsonl-session-path.js';

const homes: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const model: AgentModelConfiguration = {
  id: 'gc-model',
  name: 'GC model',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl: 'https://example.test',
  apiKey: new SecretValue('secret'),
  modelId: 'gc-model',
  contextWindowTokens: 10_000,
  maxOutputTokens: 1_000,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: ['medium'],
  defaultReasoningEffort: 'medium',
  titleGeneration: false,
  codeMode: false,
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  enabled: true
};

class ContextGcAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  resetCount = 0;
  private call: number;
  constructor(
    readonly configuration = model,
    initialCall = 0,
    readonly filePath = 'large.txt'
  ) {
    this.call = initialCall;
  }
  createTurnSession() {
    return {
      start: (request: ModelRequest) => this.start(request),
      resetContinuation: () => {
        this.resetCount++;
      },
      close: async () => undefined
    };
  }
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const call = ++this.call;
    await request.onAttemptDiagnostic?.({
      protocol: 'ANTHROPIC_MESSAGES',
      transport: 'HTTP',
      state: 'STARTED',
      attempt: 1,
      maxAttempts: 5,
      continuation: false,
      credentialReason: 'REQUEST'
    });
    yield {
      type: 'response.item',
      provider: 'ANTHROPIC_MESSAGES',
      item: { type: 'thinking', thinking: 'private fixture', signature: `signature-${call}` }
    };
    if (call === 1)
      yield {
        type: 'client_tool.call',
        callId: 'read-1',
        name: 'read',
        arguments: { reads: [{ path: this.filePath }] }
      };
    else if (call === 2)
      yield {
        type: 'client_tool.call',
        callId: 'patch-1',
        name: 'apply_patch',
        inputMode: 'freeform',
        arguments: [
          '*** Begin Patch',
          `*** Update File: ${this.filePath}`,
          '@@',
          '-before',
          '+after',
          '*** End Patch'
        ].join('\n')
      };
    else if (call >= 3 && call <= 8)
      yield {
        type: 'client_tool.call',
        callId: `todo-${call}`,
        name: 'todo_read',
        arguments: {}
      };
    else yield { type: 'text.completed', itemId: `answer-${call}`, text: 'finished' };
    yield {
      type: 'usage',
      usage: {
        inputTokens: 6_000 + call * 100,
        contextInputTokens: 6_000 + call * 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 10
      }
    };
    yield { type: 'completed', reason: call < 9 ? 'tool_use' : 'completed' };
    await request.onAttemptDiagnostic?.({
      protocol: 'ANTHROPIC_MESSAGES',
      transport: 'HTTP',
      state: 'SUCCEEDED',
      attempt: 1,
      maxAttempts: 5,
      continuation: false,
      credentialReason: 'REQUEST',
      semanticEventObserved: true
    });
  }
}

describe('context GC runtime integration', () => {
  it.each(['included', 'late'] as const)(
    'adopts GC in the same live context and retains an %s immediate append exactly once',
    async (timing) => {
      const captured = captureExecutionContext();
      const home = await mkdtemp(join(tmpdir(), 'mar-gc-adoption-'));
      homes.push(home);
      await writeFile(join(home, 'large.txt'), `before\n${'old context '.repeat(2_000)}\n`);
      const adapter = new ContextGcAdapter();
      let sessionContext!: SessionExtensionContext;
      let paused = false,
        committed = false;
      let notifyPaused!: () => void, release!: () => void;
      const atPause = new Promise<void>((resolve) => {
        notifyPaused = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let latestWorld: worldState.ContextualWorldState | undefined;
      const persist = worldState.persistContextualWorldState;
      vi.spyOn(worldState, 'persistContextualWorldState').mockImplementation(async (...args) => {
        latestWorld = args[2];
        return persist(...args);
      });
      const runGc = ContextGcRuntime.prototype.run;
      vi.spyOn(ContextGcRuntime.prototype, 'run').mockImplementation(async function (
        this: ContextGcRuntime,
        input
      ) {
        if (!paused && timing === 'included' && adapter.requests.length === 8) {
          paused = true;
          notifyPaused();
          await released;
        }
        const result = await runGc.call(this, input);
        if (result) {
          committed = true;
          if (!paused && timing === 'late') {
            paused = true;
            notifyPaused();
            await released;
          }
        }
        return result;
      });
      const agent = await createMarAgent(
        {
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace: home }),
          models: [model],
          extensions: [
            {
              id: 'gc-append',
              apiVersion: '1.0',
              attachSession(context) {
                sessionContext = context;
              }
            }
          ]
        },
        () => adapter
      );
      const session = await agent.createSession({ workspace: home });
      const result = session.run({ prompt: 'Update the file.' }).result();
      try {
        await atPause;
        const messages = captured.messages();
        expect(
          await sessionContext.session.append({
            content: 'GC_ADOPTION_APPEND',
            delivery: 'immediate'
          })
        ).toMatchObject({ status: 'committed' });
        expect(messages.filter((message) => message.content === 'GC_ADOPTION_APPEND')).toHaveLength(
          1
        );
        release();
        expect(await result).toMatchObject({ status: 'completed' });
        expect(committed).toBe(true);
        expect(adapter.resetCount).toBe(1);
        expect(captured.messages()).toBe(messages);
        expect(captured.runtime(session.id).contextualWorldState).toBe(latestWorld);
        const next = adapter.requests[8]!.messages;
        expect(next.filter((message) => message.content === 'GC_ADOPTION_APPEND')).toHaveLength(1);
        expect(
          next.some((message) => message.content.includes('# Retained Session resources'))
        ).toBe(false);
      } finally {
        release();
        await result;
        await agent.dispose();
      }
      const store = await JsonlSessionStore.open(home);
      try {
        const state = await store.readExecutionState(session.id);
        const restored = await restoreMessages(store, session.id, state.contextRecords, {
          includeImages: false
        });
        expect(
          restored.messages.filter((message) => message.content === 'GC_ADOPTION_APPEND')
        ).toHaveLength(1);
      } finally {
        await store.close();
      }
    }
  );

  it('propagates a GC sidecar write failure without publishing warm state and cold-restores the durable checkpoint', async () => {
    const captured = captureExecutionContext();
    const home = await mkdtemp(join(tmpdir(), 'mar-gc-sidecar-failure-'));
    homes.push(home);
    await writeFile(join(home, 'large.txt'), `before\n${'old context '.repeat(2_000)}\n`);
    let committedGeneration: string | undefined;
    let worldBeforeFailure: worldState.ContextualWorldState | undefined;
    const runGc = ContextGcRuntime.prototype.run;
    vi.spyOn(ContextGcRuntime.prototype, 'run').mockImplementation(async function (
      this: ContextGcRuntime,
      input
    ) {
      const result = await runGc.call(this, input);
      if (result)
        committedGeneration = worldState.latestContextualWorldStateGeneration(result.records);
      return result;
    });
    const write = JsonlSessionStore.prototype.writeContextualWorldState;
    const sidecar = vi
      .spyOn(JsonlSessionStore.prototype, 'writeContextualWorldState')
      .mockImplementation(async function (this: JsonlSessionStore, ...args) {
        if (
          committedGeneration &&
          (args[1] as { generation?: string }).generation === committedGeneration
        ) {
          worldBeforeFailure = captured.runtime(args[0]).contextualWorldState;
          throw new AgentError('MAR_AGENT_HOST_IO_ERROR', 'Injected GC sidecar write failure.');
        }
        return write.apply(this, args);
      });
    const adapter = new ContextGcAdapter();
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace: home }),
        models: [model]
      },
      () => adapter
    );
    const session = await agent.createSession({ workspace: home });
    try {
      expect(await session.run({ prompt: 'Update the file.' }).result()).toMatchObject({
        status: 'failed',
        errorCode: 'MAR_AGENT_HOST_IO_ERROR'
      });
      expect(committedGeneration).toBeDefined();
      expect(worldBeforeFailure).toBeDefined();
      expect(captured.runtime(session.id).contextualWorldState).toBe(worldBeforeFailure);
      expect(worldBeforeFailure!.generation).not.toBe(committedGeneration);
      expect(adapter.requests).toHaveLength(8);
      expect(
        agent
          .extensionDiagnostics()
          .some((diagnostic) => diagnostic.code === 'MAR_AGENT_COMPACT_SIDECAR_PERSIST_FAILED')
      ).toBe(false);
    } finally {
      await agent.dispose();
      sidecar.mockRestore();
    }
    const store = await JsonlSessionStore.open(home);
    try {
      const records = await store.read(session.id);
      expect(records.filter((record) => record.type === 'context.gc.completed')).toHaveLength(1);
      expect(records.some((record) => record.type === 'compact.completed')).toBe(false);
    } finally {
      await store.close();
    }
    const resumedAdapter = new ContextGcAdapter(model, 8);
    const resumed = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace: home }),
        models: [model]
      },
      () => resumedAdapter
    );
    try {
      const restored = await resumed.openSession(session.id);
      expect(
        await restored.run({ prompt: 'Continue after the persisted GC.' }).result()
      ).toMatchObject({ status: 'completed' });
      const messages = resumedAdapter.requests[0]!.messages;
      expect(messages.some((message) => message.content.includes('kind="stale_read"'))).toBe(true);
      expect(JSON.stringify(messages)).not.toContain('old context old context');
      expect(
        messages.some((message) => message.content.includes('# Retained Session resources'))
      ).toBe(false);
    } finally {
      await resumed.dispose();
    }
  });

  it.each([0, 4_999, 8_500, 9_000, 10_000, NaN])(
    'does not read history or acquire resources outside the GC window: %s',
    async (contextInputTokens) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-context-gc-preflight-'));
      homes.push(home);
      const store = await JsonlSessionStore.open(home);
      const session = await store.createSession({ workspace: home });
      const readState = vi.spyOn(store, 'readExecutionState');
      const getActiveProcessIds = vi.fn(async () => new Set<string>());
      const input = {
        store,
        sessionId: session.id,
        system: 'System.',
        tools: [],
        modelId: model.id,
        contextWindowTokens: 10_000,
        usage: { inputTokens: 6_000, contextInputTokens },
        workspace: home,
        platform: 'linux' as const,
        getActiveProcessIds
      };
      await expect(tryCommitContextGc(input)).resolves.toBe(false);
      expect(readState).not.toHaveBeenCalled();
      expect(getActiveProcessIds).not.toHaveBeenCalled();
      await store.close();
    }
  );

  it('loads eligible history lazily and contains read failures', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-context-gc-lazy-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home });
    const readState = vi.spyOn(store, 'readExecutionState').mockRejectedValue(new Error('read'));
    await expect(
      tryCommitContextGc({
        store,
        sessionId: session.id,
        system: 'System.',
        tools: [],
        modelId: model.id,
        contextWindowTokens: 10_000,
        usage: { contextInputTokens: 6_000 },
        workspace: home,
        platform: 'linux' as const,
        activeProcessIds: new Set<string>()
      })
    ).resolves.toBe(false);
    expect(readState).toHaveBeenCalledOnce();
    await store.close();
  });

  it('backs off for 2, 4 and 8 rollouts without ordinary tools cancelling the interval', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-context-gc-backoff-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home });
    const readState = vi.spyOn(store, 'readExecutionState');
    const runtime = new ContextGcRuntime();
    const input = {
      store,
      sessionId: session.id,
      system: 'System.',
      tools: [],
      modelId: model.id,
      contextWindowTokens: 10_000,
      usage: { contextInputTokens: 6_000 },
      workspace: home,
      platform: 'linux' as const,
      activeProcessIds: new Set<string>()
    };
    for (let rollout = 1; rollout <= 23; rollout++) {
      await runtime.run(input);
      expect(readState).toHaveBeenCalledTimes(
        [1, 3, 7, 15, 23].filter((boundary) => boundary <= rollout).length
      );
    }
    await runtime.run({ ...input, usage: { contextInputTokens: 5_900 } });
    expect(readState).toHaveBeenCalledTimes(6);
    await runtime.run({ ...input, modelId: 'other-model' });
    expect(readState).toHaveBeenCalledTimes(7);
    await runtime.run({ ...input, modelId: 'other-model', contextWindowTokens: 11_000 });
    expect(readState).toHaveBeenCalledTimes(8);
    await runtime.run({ ...input, usage: { contextInputTokens: 4_000 } });
    expect(readState).toHaveBeenCalledTimes(8);
    await runtime.run(input);
    expect(readState).toHaveBeenCalledTimes(9);
    await runtime.run(input);
    expect(readState).toHaveBeenCalledTimes(9);
    await runtime.run({ ...input, usage: { contextInputTokens: 8_000 } });
    expect(readState).toHaveBeenCalledTimes(10);
    for (let index = 0; index < 6; index++)
      await runtime.run({ ...input, usage: { contextInputTokens: 8_100 } });
    expect(readState).toHaveBeenCalledTimes(13);
    runtime.reset();
    await runtime.run(input);
    expect(readState).toHaveBeenCalledTimes(14);
    await store.close();
  });

  it('does not enter GC history or resource loading in a below-threshold SDK execution', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-context-gc-sdk-gate-'));
    homes.push(home);
    const configured = { ...model, contextWindowTokens: 272_000 };
    const adapter = new ContextGcAdapter(configured, 8);
    const host = new LocalAgentHost({ homeDirectory: home, workspace: home });
    const resources = vi.spyOn(host, 'listSessionResources');
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host,
        models: [configured]
      },
      () => adapter
    );
    try {
      const session = await agent.createSession({ workspace: home, title: 'Below threshold' });
      const readState = vi.spyOn(JsonlSessionStore.prototype, 'readExecutionState');
      try {
        expect((await session.run({ prompt: 'Answer without tools.' }).result()).status).toBe(
          'completed'
        );
        // One ordinary initial restore; no extra read for a GC evaluation.
        expect(readState).toHaveBeenCalledTimes(1);
        // Ordinary execution does not enumerate dynamic resources for prompt injection.
        expect(resources).not.toHaveBeenCalled();
      } finally {
        readState.mockRestore();
      }
    } finally {
      await agent.dispose();
    }
  });

  it('applies ordinary Context GC to child Sessions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-context-gc-subagent-disabled-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    await writeFile(join(workspace, 'large.txt'), `before\n${'old context '.repeat(2_000)}\n`);
    const store = await JsonlSessionStore.open(home);
    const parent = await store.createSession({ workspace, title: 'Parent' });
    const child = await store.createSession({
      workspace,
      title: 'Child',
      source: {
        type: 'subagent',
        parentSessionId: parent.id,
        rootSessionId: parent.id,
        parentExecutionId: 'parent-execution',
        role: 'general-purpose',
        description: 'Verify ordinary GC'
      }
    });
    await store.close();
    const adapter = new ContextGcAdapter();
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model]
      },
      () => adapter
    );
    try {
      const session = await agent.openSession(child.id);
      expect(
        (await session.run({ prompt: 'Update the file and verify the session.' }).result()).status
      ).toBe('completed');
    } finally {
      await agent.dispose();
    }
    const reopenedStore = await JsonlSessionStore.open(home);
    try {
      const records = await reopenedStore.read(child.id);
      expect(records.some((record) => record.type === 'context.gc.completed')).toBe(true);
      expect(adapter.resetCount).toBe(1);
      expect(JSON.stringify(adapter.requests[8]?.messages)).not.toContain(
        'old context old context'
      );
    } finally {
      await reopenedStore.close();
    }
  });

  it('anchors Compact to the latest completed message restored by GC in the same execution', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-gc-compact-message-anchor-'));
    homes.push(home);
    await writeFile(join(home, 'large.txt'), `before\n${'old context '.repeat(2_000)}\n`);
    const host = new LocalAgentHost({ homeDirectory: home, workspace: home });
    const initial = new ContextGcAdapter();
    let context!: SessionExtensionContext;
    let normalCalls = 0;
    let gcCommitted = false;
    let compactRequested = false;
    const runGc = ContextGcRuntime.prototype.run;
    vi.spyOn(ContextGcRuntime.prototype, 'run').mockImplementation(async function (
      this: ContextGcRuntime,
      input
    ) {
      const result = await runGc.call(this, input);
      gcCommitted ||= Boolean(result);
      return result;
    });
    const adapter: ModelAdapter = {
      configuration: model,
      async *start(request) {
        const call = ++normalCalls;
        if (call < 8) {
          for await (const event of initial.start(request))
            yield event.type === 'usage'
              ? {
                  ...event,
                  usage: { ...event.usage, inputTokens: 4_000, contextInputTokens: 4_000 }
                }
              : event;
          return;
        }
        await request.onAttemptDiagnostic?.({
          protocol: 'ANTHROPIC_MESSAGES',
          transport: 'HTTP',
          state: 'STARTED',
          attempt: 1,
          maxAttempts: 5,
          continuation: false,
          credentialReason: 'REQUEST'
        });
        yield {
          type: 'response.item',
          provider: 'ANTHROPIC_MESSAGES',
          item: {
            type: 'thinking',
            thinking: 'private fixture',
            signature: `signature-anchor-${call}`
          }
        };
        yield {
          type: 'text.completed',
          itemId: call === 8 ? 'latest-message-before-gc' : 'finished-after-compact',
          text: call === 8 ? 'The file change is verified.' : 'Finished after Compact.'
        };
        if (call === 8)
          await context.session.append({ content: 'Continue after GC.', delivery: 'boundary' });
        yield {
          type: 'usage',
          usage: {
            inputTokens: call === 8 ? 6_400 : 100,
            contextInputTokens: call === 8 ? 6_400 : 100,
            outputTokens: 10
          }
        };
        yield { type: 'completed', reason: 'completed' };
        await request.onAttemptDiagnostic?.({
          protocol: 'ANTHROPIC_MESSAGES',
          transport: 'HTTP',
          state: 'SUCCEEDED',
          attempt: 1,
          maxAttempts: 5,
          continuation: false,
          credentialReason: 'REQUEST',
          semanticEventObserved: true
        });
      }
    };
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host,
        models: [model],
        extensions: [
          {
            id: 'gc-then-compact',
            apiVersion: '1.0',
            attachSession(value) {
              context = value;
              value.hooks.intercept('compact.generate', async () => ({
                summary: 'Continue from the verified change.'
              }));
              value.hooks.intercept('model.request', async (request, _call, next) => {
                if (gcCommitted && !compactRequested) {
                  compactRequested = true;
                  await value.session.compact({ async: false });
                }
                return next(request);
              });
            }
          }
        ]
      },
      () => adapter
    );
    let sessionId: string;
    try {
      const session = await agent.createSession({ workspace: home });
      sessionId = session.id;
      expect(await session.run({ prompt: 'Update the file and continue.' }).result()).toMatchObject(
        { status: 'completed' }
      );
      expect(gcCommitted).toBe(true);
      expect(compactRequested).toBe(true);
      expect(normalCalls).toBe(9);
    } finally {
      await agent.dispose();
    }
    const store = await JsonlSessionStore.open(home);
    try {
      const records = await store.read(sessionId!);
      const checkpoint = records.find((record) => record.type === 'context.gc.completed')!;
      const compact = records.find((record) => record.type === 'compact.completed')!;
      expect(checkpoint).toBeDefined();
      expect(compact.sequence).toBeGreaterThan(checkpoint.sequence);
      const latestMessage = records.findLast(
        (record) => record.type === 'message.completed' && record.sequence < checkpoint.sequence
      )!;
      expect(latestMessage.payload).toMatchObject({ itemId: 'latest-message-before-gc' });
      expect(compact.executionId).toBe(latestMessage.executionId);
      const compacting = host.events.filter(
        (event) => event.type === 'context.compacting' && event.stage === 'GENERATING'
      );
      expect(compacting).toHaveLength(1);
      for (const event of compacting)
        expect(event).toMatchObject({
          executionId: latestMessage.executionId,
          anchor: { kind: 'message', id: (latestMessage.payload as { itemId: string }).itemId }
        });
    } finally {
      await store.close();
    }
  });

  it('continues through GC and automatic Compact above the former execution budget', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-context-gc-auto-compact-'));
    homes.push(home);
    for (const path of ['first.txt', 'second.txt'])
      await writeFile(join(home, path), `before\n${'old context '.repeat(2_000)}\n`);
    const first = new ContextGcAdapter(model, 0, 'first.txt');
    const overflow = new ContextGcAdapter(model, 7);
    const second = new ContextGcAdapter(model, 0, 'second.txt');
    let normalCalls = 0;
    const adapter: ModelAdapter = {
      configuration: model,
      async *start(request) {
        if (request.toolChoice === 'none') {
          yield {
            type: 'text.completed',
            itemId: 'compact-summary',
            text: 'Continue with second.txt.'
          };
          yield {
            type: 'usage',
            usage: { inputTokens: 1_000, outputTokens: 20, rolloutBudgetUnits: 400_000 }
          };
          yield { type: 'completed', reason: 'completed' };
          return;
        }
        normalCalls++;
        const delegate = normalCalls < 9 ? first : normalCalls === 9 ? overflow : second;
        for await (const event of delegate.start(request))
          yield event.type === 'usage'
            ? {
                ...event,
                usage: {
                  ...event.usage,
                  rolloutBudgetUnits: 400_000,
                  ...(normalCalls === 9 ? { inputTokens: 9_500, contextInputTokens: 9_500 } : {})
                }
              }
            : event;
      }
    };
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace: home }),
        models: [model]
      },
      () => adapter
    );
    let sessionId: string;
    try {
      const session = await agent.createSession({ workspace: home, title: 'GC across Compact' });
      sessionId = session.id;
      expect((await session.run({ prompt: 'Update both files.' }).result()).status).toBe(
        'completed'
      );
      expect(
        second.requests[8]?.messages.some((message) =>
          message.content.includes('kind="stale_read"')
        )
      ).toBe(true);
    } finally {
      await agent.dispose();
    }
    const store = await JsonlSessionStore.open(home);
    try {
      const records = await store.read(sessionId!);
      const checkpoints = records.filter((record) => record.type === 'context.gc.completed');
      expect(checkpoints).toHaveLength(2);
      expect(checkpoints.map((record) => record.payload)).toMatchObject([
        { generation: 1, base: { type: 'SESSION_START' } },
        { generation: 1, base: { type: 'COMPACT' } }
      ]);
      expect(records.filter((record) => record.type === 'compact.completed')).toHaveLength(1);
      expect(await readFile(join(home, 'second.txt'), 'utf8')).toContain('after');
    } finally {
      await store.close();
    }
  });

  it.each([false, true])(
    'resumes from a committed checkpoint without archived integrity replay after Compact=%s',
    async (afterCompact) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-context-gc-runtime-'));
      homes.push(home);
      const workspace = join(home, 'workspace');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
      await writeFile(join(workspace, 'large.txt'), `before\n${'old context '.repeat(2_000)}\n`);
      const adapter = new ContextGcAdapter();
      const host = new LocalAgentHost({ homeDirectory: home, workspace });
      const enumerateResources = host.listSessionResources.bind(host);
      vi.spyOn(host, 'listSessionResources').mockImplementation(async (sessionId) => ({
        ...(await enumerateResources(sessionId)),
        codeCells: [
          { cellId: 'running-cell', status: 'running' as const, executionId: 'old-execution' },
          { cellId: 'completed-cell', status: 'completed' as const, executionId: 'old-execution' }
        ]
      }));
      const agent = await createMarAgent(
        {
          mode: 'normal',
          host,
          models: [model]
        },
        () => adapter
      );
      const session = await agent.createSession({ workspace, title: 'Context GC runtime' });
      if (afterCompact) {
        const seedStore = await JsonlSessionStore.open(home);
        await seedStore.compact(session.id, {
          summary: 'Continue implementing the source change.',
          modelId: model.id,
          contextWindowTokens: model.contextWindowTokens
        });
        await seedStore.close();
      }
      const handle = session.run({
        prompt: 'Update the file and verify the session.'
      });
      const events = [];
      for await (const event of handle) events.push(event);
      expect(await handle.result()).toMatchObject({ status: 'completed', finalAnswer: 'finished' });
      expect(events.some((event) => (event.type as string).includes('gc'))).toBe(false);
      expect(adapter.resetCount).toBe(1);
      const retainedContext = adapter.requests[8]!.messages.filter(
        (message) => message.role === 'user'
      )
        .map((message) => message.content)
        .join('\n');
      expect(retainedContext).not.toContain('cellId: running-cell');
      expect(retainedContext).not.toContain('cellId: completed-cell');
      expect(retainedContext).not.toContain('# Retained Session resources');
      expect(JSON.stringify(adapter.requests[0]!.messages).includes('cellId: running-cell')).toBe(
        afterCompact
      );
      expect(retainedContext).not.toContain('survived the previous Execution');
      expect(adapter.requests[8]!.tools).toEqual(adapter.requests[0]!.tools);
      expect(
        adapter.requests[8]?.messages.some((message) =>
          message.content.includes('kind="stale_read"')
        )
      ).toBe(true);
      expect(
        adapter.requests[8]?.messages.some(
          (message) =>
            message.role === 'tool_call' &&
            typeof message.arguments === 'string' &&
            message.arguments.includes('kind="successful_apply_patch_input"')
        )
      ).toBe(true);
      expect(JSON.stringify(adapter.requests[8]?.messages)).not.toContain(
        'old context old context'
      );
      expect(await readFile(join(workspace, 'large.txt'), 'utf8')).toContain('after');
      const projectedBeforeRestart = structuredClone(adapter.requests[8]?.messages ?? []).filter(
        (message) =>
          !message.content.startsWith('# AGENTS.md instructions') &&
          message.contextualBlock?.authority !== 'instruction'
      );
      await agent.dispose();

      const store = await JsonlSessionStore.open(home);
      const raw = await store.read(session.id);
      expect(raw.some((record) => record.type === 'context.gc.completed')).toBe(true);
      expect(JSON.stringify(raw)).toContain('old context old context');
      const readState = vi.spyOn(store, 'readExecutionState');
      const getActiveProcessIds = vi.fn(async () => new Set<string>());
      const runtime = new ContextGcRuntime();
      const runtimeInput = {
        store,
        sessionId: session.id,
        system: 'System.',
        tools: [],
        modelId: model.id,
        contextWindowTokens: model.contextWindowTokens,
        usage: { contextInputTokens: 6_500 },
        workspace,
        platform: 'linux' as const,
        getActiveProcessIds
      };
      for (let index = 0; index < 5; index++)
        await expect(runtime.run(runtimeInput)).resolves.toBe(false);
      // Learn the durable checkpoint once, then reject before history and resource I/O.
      expect(readState).toHaveBeenCalledTimes(1);
      expect(getActiveProcessIds).not.toHaveBeenCalled();
      // Below the async Compact boundary the 2,000-token growth gate still applies.
      await runtime.run({ ...runtimeInput, usage: { contextInputTokens: 8_400 } });
      expect(readState).toHaveBeenCalledTimes(1);
      // Rollouts still accumulate until the independent six-rollout interval expires.
      for (let i = 0; i < 5; i++)
        await runtime.run({ ...runtimeInput, usage: { contextInputTokens: 8_400 } });
      expect(readState).toHaveBeenCalledTimes(2);
      runtime.reset();
      await runtime.run(runtimeInput);
      expect(readState).toHaveBeenCalledTimes(3);
      await store.close();
      const catalog = await openAgentSessionCatalog({ homeDirectory: home });
      const history = await catalog.history(session.id, { limit: 1_000 });
      expect(
        history.entries.some(
          (entry) => entry.kind === 'event' && String(entry.event.type).includes('gc')
        )
      ).toBe(false);
      await catalog.close();

      // Recovery trusts the committed replacement instead of revalidating archived input.
      const activeDirectory = await activeSessionDirectory(home, session.id);
      const segment = join(activeDirectory, 'events-000001.jsonl');
      const archived = await readFile(segment, 'utf8');
      const drifted =
        archived
          .trimEnd()
          .split('\n')
          .map((line) => {
            const record = JSON.parse(line);
            if (
              record.type === 'model.context' &&
              record.payload.role === 'tool_call' &&
              record.payload.callId === 'patch-1'
            )
              record.payload.arguments = 'Archived source no longer matches its checkpoint hash.';
            return JSON.stringify(record);
          })
          .join('\n') + '\n';
      expect(drifted).not.toBe(archived);
      await writeFile(segment, drifted);

      // Losing the GC sidecar must not replay an older Compact's resource recovery.
      await rm(join(activeDirectory, 'context-world-state.json'), {
        force: true
      });
      const reopenedAdapter = new ContextGcAdapter(model, 8);
      const resumedHost = new LocalAgentHost({ homeDirectory: home, workspace });
      const resumedResources = vi.spyOn(resumedHost, 'listSessionResources').mockResolvedValue({
        processes: [],
        codeCells: [{ cellId: 'resumed-cell', status: 'running', executionId: 'current' }]
      });
      const reopened = await createMarAgent(
        {
          mode: 'normal',
          host: resumedHost,
          models: [model]
        },
        () => reopenedAdapter
      );
      const restored = await reopened.openSession(session.id);
      expect(
        (await restored.run({ prompt: 'Continue from the completed change.' }).result()).status
      ).toBe('completed');
      const restoredMessages = (reopenedAdapter.requests[0]?.messages ?? []).filter(
        (message) =>
          !message.content.startsWith('# AGENTS.md instructions') &&
          message.contextualBlock?.authority !== 'instruction'
      );
      expect(restoredMessages.slice(0, projectedBeforeRestart.length)).toEqual(
        projectedBeforeRestart
      );
      expect(restoredMessages[projectedBeforeRestart.length]).toMatchObject({
        role: 'provider',
        provider: 'ANTHROPIC_MESSAGES',
        item: { type: 'thinking', signature: expect.any(String) }
      });
      expect(restoredMessages[projectedBeforeRestart.length + 1]).toMatchObject({
        role: 'assistant',
        content: 'finished'
      });
      expect(
        restoredMessages.some((message) => message.content.includes('kind="stale_read"'))
      ).toBe(true);
      expect(JSON.stringify(restoredMessages)).not.toContain('old context old context');
      expect(JSON.stringify(restoredMessages)).not.toContain('resumed-cell');
      expect(JSON.stringify(restoredMessages)).not.toContain('# Retained Session resources');
      expect(resumedResources).not.toHaveBeenCalled();
      await reopened.dispose();
    }
  );

  it.each([
    { afterCompact: false, ambiguous: false },
    { afterCompact: false, ambiguous: true },
    { afterCompact: true, ambiguous: false },
    { afterCompact: true, ambiguous: true }
  ])(
    'confirms durable commits without redundant history reads: $afterCompact/$ambiguous',
    async ({ afterCompact, ambiguous }) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-context-gc-post-append-'));
      homes.push(home);
      const workspace = join(home, 'workspace');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
      const store = await JsonlSessionStore.open(home);
      const session = await store.createSession({ workspace, title: 'Post append' });
      if (afterCompact)
        await store.compact(session.id, {
          summary: 'Continue the local source change.',
          modelId: model.id,
          contextWindowTokens: 10_000
        });
      await store.append(session.id, {
        type: 'execution.header',
        payload: { modelId: model.id, contextWindowTokens: 10_000, mode: 'run' }
      });
      await store.append(session.id, {
        type: 'model.context',
        payload: {
          role: 'tool_call',
          content: '',
          callId: 'read-1',
          name: 'read',
          arguments: { reads: [{ path: 'large.txt' }] }
        }
      });
      await store.append(session.id, {
        type: 'model.context',
        payload: {
          role: 'tool',
          callId: 'read-1',
          content: formatReadContextItem(
            0,
            {
              path: 'large.txt',
              encoding: 'utf-8',
              newline: 'lf',
              startLine: 1,
              endLine: 2,
              eof: true,
              truncated: false
            },
            `1\tbefore\n2\t${'old context '.repeat(2_000)}`
          )
        }
      });
      const patch = [
        '*** Begin Patch',
        '*** Update File: large.txt',
        '@@',
        '-before',
        '+after',
        '*** End Patch'
      ].join('\n');
      await store.append(session.id, {
        type: 'model.context',
        payload: {
          role: 'tool_call',
          content: '',
          callId: 'patch-1',
          name: 'apply_patch',
          arguments: patch,
          inputMode: 'freeform'
        }
      });
      const patchData = {
        files: [
          {
            path: 'large.txt',
            operation: 'modified',
            addedLines: 1,
            deletedLines: 1
          }
        ],
        totals: { files: 1, addedLines: 1, deletedLines: 1 }
      };
      await store.append(session.id, {
        type: 'tool.completed',
        payload: {
          type: 'tool.completed',
          toolName: 'apply_patch',
          callId: 'patch-1',
          summary: 'applied',
          data: patchData
        }
      });
      await store.append(session.id, {
        type: 'model.context',
        payload: { role: 'tool', callId: 'patch-1', content: JSON.stringify(patchData) }
      });
      for (let index = 0; index < 6; index++) {
        await store.append(session.id, {
          type: 'model.attempt',
          executionId: 'gc-test',
          payload: { purpose: 'EXECUTION', state: 'STARTED' }
        });
        await store.append(session.id, {
          type: 'model.context',
          executionId: 'gc-test',
          payload: {
            role: 'provider',
            content: '',
            provider: 'OPENAI_RESPONSES',
            providerModelId: model.id,
            item: {
              type: 'reasoning',
              id: `item-${index}`,
              encrypted_content: 'opaque',
              summary: []
            }
          }
        });
        await store.append(session.id, {
          type: 'model.attempt',
          executionId: 'gc-test',
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
        await store.append(session.id, {
          type: 'usage.updated',
          payload: {
            type: 'usage.updated',
            inputTokens: 6_100,
            contextInputTokens: 6_100,
            cacheReadTokens: 0,
            cacheWriteTokens: 0
          }
        });
      }
      const state = await store.readExecutionState(session.id);
      const fullRead = vi.spyOn(store, 'read');
      const input = {
        store,
        sessionId: session.id,
        records: state.contextRecords,
        system: 'System.',
        tools: [],
        modelId: model.id,
        contextWindowTokens: 10_000,
        usage: {
          inputTokens: 6_100,
          contextInputTokens: 6_100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0
        },
        workspace,
        platform: 'linux' as const,
        activeProcessIds: new Set<string>()
      } as const;
      const originalCommit = store.commitContextGc.bind(store);
      store.commitContextGc = async () => {
        throw new Error('simulated unknown append failure');
      };
      await expect(tryCommitContextGc(input)).resolves.toBe(false);
      store.commitContextGc = async () => state.contextRecords[0]!;
      await expect(tryCommitContextGc(input)).resolves.toBe(false);
      store.commitContextGc = async (...arguments_) => {
        const record = await originalCommit(...arguments_);
        if (ambiguous) throw new Error('simulated post-append failure');
        Object.defineProperty(arguments_[1], 'metrics', {
          get() {
            throw new Error('A successful commit must use its durable result, not the draft.');
          }
        });
        return record;
      };
      const readState = vi.spyOn(store, 'readExecutionState');
      const readPage = vi.spyOn(store, 'readPage');
      const result = await tryCommitContextGc(input);
      expect(readState).not.toHaveBeenCalled();
      expect(fullRead).not.toHaveBeenCalled();
      expect(readPage).toHaveBeenCalledTimes(ambiguous ? 1 : 0);
      if (ambiguous)
        expect(readPage).toHaveBeenCalledWith(session.id, {
          limit: 1,
          beforeSequence: state.contextRecords.at(-1)!.sequence + 2
        });
      expect(result).toMatchObject({
        projection: { checkpoint: { generation: 1 } }
      });
      expect(result && buildContextProjection(result.records)).toEqual(result && result.projection);
      const refreshed = await store.readExecutionState(session.id);
      expect(buildContextProjection(refreshed.contextRecords).checkpoint).toMatchObject({
        generation: 1
      });
      await store.close();
    }
  );
});
