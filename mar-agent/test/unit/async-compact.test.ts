import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAgentHost } from '../../src/host.js';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import { createAgentWithAdapter } from '../../src/sdk/agent.js';
import type { ExecutionHandle, Agent } from '../../src/sdk/types.js';
import type { AgentExtension } from '../../src/extensions/contracts.js';
import {
  createSubagentExtension,
  SUBAGENT_NATIVE_SERVICE
} from '../../extensions/subagent/src/index.js';
import type { ModelAdapter, ModelEvent, ModelRequest } from '../../src/model/contracts.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { restoreMessages } from '../../src/runtime/context/restore.js';
import { CompactRequests } from '../../src/runtime/compaction/requests.js';
import { compactSnapshotAnchor } from '../../src/runtime/compaction/retained-context.js';
import { effectiveInstructions } from './support/model-context.js';
import { captureExecutionContext } from './support/checkpoint-context.js';
import * as worldState from '../../src/runtime/context/world-state.js';
import { ContextGcRuntime } from '../../src/runtime/context/gc-runtime.js';

const configuration: AgentModelConfiguration = {
  id: 'test',
  name: 'Test',
  modelId: 'test',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl: 'https://example.test',
  apiKey: new SecretValue('fixture'),
  contextWindowTokens: 10_000,
  maxOutputTokens: 1000,
  enabled: true,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: ['medium'],
  defaultReasoningEffort: 'medium',
  titleGeneration: false,
  hostedWebSearch: false,
  codeMode: false
};
const homes: string[] = [];
const agents: Agent[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.dispose()));
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
function barrier() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    release: () => resolve()
  };
}
function response(text: string, tokens: number): ModelEvent[] {
  return [
    { type: 'text.completed', itemId: text, text },
    { type: 'usage', usage: { inputTokens: tokens, contextInputTokens: tokens, outputTokens: 10 } },
    { type: 'completed', reason: 'completed' }
  ];
}
function readCall(id: string, tokens: number): ModelEvent[] {
  return [
    {
      type: 'client_tool.call',
      callId: id,
      name: 'read',
      arguments: { reads: [{ path: 'evidence.txt' }] }
    },
    { type: 'usage', usage: { inputTokens: tokens, contextInputTokens: tokens, outputTokens: 10 } },
    { type: 'completed', reason: 'tool_use' }
  ];
}
async function fixture(
  script: (
    request: ModelRequest,
    index: number
  ) => AsyncIterable<ModelEvent> | readonly ModelEvent[],
  generate: (signal: AbortSignal) => Promise<{ summary: string } | undefined>,
  attach?: (context: Parameters<NonNullable<AgentExtension['attachSession']>>[0]) => void,
  withSubagents = false
) {
  const home = await mkdtemp(join(tmpdir(), 'mar-async-compact-'));
  homes.push(home);
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'evidence.txt'), 'TAIL_TOOL_EVIDENCE');
  const requests: ModelRequest[] = [];
  let generations = 0;
  let context!: Parameters<NonNullable<AgentExtension['attachSession']>>[0];
  const extension: AgentExtension = {
    id: 'compact-test',
    apiVersion: '1.0',
    ...(withSubagents ? { serviceDependencies: [{ key: SUBAGENT_NATIVE_SERVICE }] } : {}),
    attachSession(value) {
      context = value;
      value.hooks.intercept('compact.generate', async (_input, call) => {
        generations++;
        return generate(call.signal);
      });
      attach?.(value);
    }
  };
  const host = new LocalAgentHost({ homeDirectory: home, workspace });
  const adapter: ModelAdapter = {
    configuration,
    async *start(request) {
      const index = requests.push(request);
      yield* script(request, index);
    }
  };
  let agent!: Agent;
  agent = await createAgentWithAdapter(
    {
      mode: 'normal',
      host,
      models: [withSubagents ? { ...configuration, subagentModel: true } : configuration],
      extensions: withSubagents
        ? [createSubagentExtension({ agent: () => agent }), extension]
        : [extension]
    },
    () => adapter
  );
  agents.push(agent);
  const session = await agent.createSession({ workspace, title: 'Async compact' });
  return {
    home,
    host,
    agent,
    session,
    adapter,
    requests,
    generations: () => generations,
    context: () => context
  };
}

describe('asynchronous Compact', () => {
  it.each(['generation', 'prefix'] as const)(
    'keeps generation candidate-only and rejects a stale %s before committing',
    async (cause) => {
      const captured = captureExecutionContext();
      const generated = barrier(),
        release = barrier();
      const f = await fixture(
        () => response('original answer', 8500),
        async () => {
          generated.release();
          await release.promise;
          return { summary: 'UNCOMMITTED_CANDIDATE' };
        }
      );
      const result = f.session.run({ prompt: 'Original input' }).result();
      try {
        await generated.promise;
        const messages = captured.messages();
        expect(messages.some((message) => message.content.includes('original answer'))).toBe(true);
        expect(messages.some((message) => message.content.includes('UNCOMMITTED_CANDIDATE'))).toBe(
          false
        );
        const store = await JsonlSessionStore.open(f.home);
        try {
          expect(
            (await store.read(f.session.id)).some((record) => record.type === 'compact.completed')
          ).toBe(false);
        } finally {
          await store.close();
        }
        if (cause === 'generation')
          Object.assign(captured.runtime(f.session.id).contextualWorldState!, {
            generation: 'superseded'
          });
        else {
          const index = messages.findIndex((message) => message.content === 'Original input');
          expect(index).toBeGreaterThanOrEqual(0);
          messages[index] = { ...messages[index]!, content: 'Superseded input' };
        }
        release.release();
        await result;
        expect(captured.messages()).toBe(messages);
        expect(f.host.events.filter((event) => event.type === 'context.compacted')).toHaveLength(0);
        expect(
          f.host.events.filter((event) => event.type === 'context.compact_failed')
        ).toMatchObject([{ code: 'MAR_AGENT_COMPACT_STALE' }]);
        const reopened = await JsonlSessionStore.open(f.home);
        try {
          expect(
            (await reopened.read(f.session.id)).some(
              (record) => record.type === 'compact.completed'
            )
          ).toBe(false);
        } finally {
          await reopened.close();
        }
      } finally {
        release.release();
        await result;
      }
    }
  );

  it('splices inside the Compact commit window and retains an append during sidecar refresh exactly once', async () => {
    const captured = captureExecutionContext();
    const sidecarStarted = barrier(),
      releaseSidecar = barrier();
    let compactId: string | undefined;
    let compactWorld: worldState.ContextualWorldState | undefined;
    let latestWorld: worldState.ContextualWorldState | undefined;
    const persist = worldState.persistContextualWorldState;
    vi.spyOn(worldState, 'persistContextualWorldState').mockImplementation(async (...args) => {
      latestWorld = args[2];
      if (compactId && args[2].generation === compactId) compactWorld = args[2];
      return persist(...args);
    });
    const compact = JsonlSessionStore.prototype.compact;
    vi.spyOn(JsonlSessionStore.prototype, 'compact').mockImplementation(async function (
      this: JsonlSessionStore,
      ...args
    ) {
      const record = await compact.apply(this, args);
      compactId = record.recordId;
      return record;
    });
    const write = JsonlSessionStore.prototype.writeContextualWorldState;
    vi.spyOn(JsonlSessionStore.prototype, 'writeContextualWorldState').mockImplementation(
      async function (this: JsonlSessionStore, ...args) {
        if (compactId && (args[1] as { generation?: string }).generation === compactId) {
          sidecarStarted.release();
          await releaseSidecar.promise;
        }
        return write.apply(this, args);
      }
    );
    const f = await fixture(
      (_request, index) =>
        index === 1 ? readCall('read-before-compact', 9500) : response('finished', 100),
      async () => ({ summary: 'ADOPTED_HANDOFF' })
    );
    const result = f.session.run({ prompt: 'Read and continue' }).result();
    try {
      await sidecarStarted.promise;
      const messages = captured.messages();
      expect(messages.some((message) => message.content.includes('ADOPTED_HANDOFF'))).toBe(true);
      expect(captured.runtime(f.session.id).contextualWorldState).toBe(compactWorld);
      compactWorld!.entries.push({
        index: 0,
        kind: 'instructions',
        content: 'SHARED_WORLD_REFERENCE'
      });
      expect(
        await f.context().session.append({ content: 'AFTER_COMPACT_APPEND', delivery: 'immediate' })
      ).toMatchObject({ status: 'committed' });
      expect(captured.messages()).toBe(messages);
      expect(messages.filter((message) => message.content === 'AFTER_COMPACT_APPEND')).toHaveLength(
        1
      );
      releaseSidecar.release();
      expect(await result).toMatchObject({ status: 'completed' });
      const continuation = f.requests.at(-1)!;
      expect(
        continuation.messages.filter((message) => message.content === 'AFTER_COMPACT_APPEND')
      ).toHaveLength(1);
      expect(
        continuation.messages.some((message) => message.content.includes('ADOPTED_HANDOFF'))
      ).toBe(true);
      expect(
        continuation.messages.filter((message) => message.content === 'SHARED_WORLD_REFERENCE')
      ).toHaveLength(1);
      expect(captured.messages()).toBe(messages);
      expect(captured.runtime(f.session.id).contextualWorldState).toBe(latestWorld);
      const store = await JsonlSessionStore.open(f.home);
      try {
        const state = await store.readExecutionState(f.session.id);
        const restored = await restoreMessages(store, f.session.id, state.contextRecords, {
          includeImages: false
        });
        expect(
          restored.messages.filter((message) => message.content === 'AFTER_COMPACT_APPEND')
        ).toHaveLength(1);
        expect(
          restored.messages.some((message) => message.content.includes('ADOPTED_HANDOFF'))
        ).toBe(true);
      } finally {
        await store.close();
      }
    } finally {
      releaseSidecar.release();
      await result;
    }
  });

  it.each(['success', 'failure', 'cancel'] as const)(
    'closes the SDK-owned compact turn exactly once after %s',
    async (outcome) => {
      const extensionStarted = barrier();
      const close = vi.fn(async () => undefined);
      const start = vi.fn(async function* () {
        yield await Promise.reject<ModelEvent>(new Error('Injected model failure.'));
      });
      const f = await fixture(
        () => {
          f.adapter.createTurnSession = () => ({ start, close });
          return response('finished', 8500);
        },
        async (signal) => {
          extensionStarted.release();
          if (outcome === 'success') return { summary: 'RESOURCE_HANDOFF' };
          if (outcome === 'failure') return undefined;
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          return undefined;
        }
      );
      const handle = f.session.run({ prompt: 'Finish' });
      await Promise.race([
        extensionStarted.promise,
        handle.result().then((result) => {
          throw new Error(`Execution ended before Compact started: ${result.status}`);
        })
      ]);
      if (outcome === 'cancel') await handle.cancel();
      await handle.result();
      expect(close).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledTimes(outcome === 'failure' ? 1 : 0);
      expect(f.host.events.filter((event) => event.type === 'context.compacted')).toHaveLength(
        outcome === 'success' ? 1 : 0
      );
      expect(f.generations()).toBe(1);
    }
  );

  it('retains an applied native user input across a background Compact cut and warm restoration exactly once', async () => {
    const generated = barrier(),
      releaseCompact = barrier(),
      requestStarted = barrier(),
      releaseRequest = barrier();
    let followupCopies: number | undefined;
    let receivedId: string | undefined;
    const f = await fixture(
      async function* (_request, index) {
        if (_request.messages.some((m) => m.content === 'Followup'))
          followupCopies = _request.messages.filter(
            (m) =>
              m.role === 'user' &&
              m.metadata?.recordId === receivedId &&
              m.content.startsWith('Retained guidance')
          ).length;
        if (index === 1) {
          yield* response('seed', 100);
          return;
        }
        if (index === 2) {
          yield* readCall('read-before-steer', 8500);
          return;
        }
        if (index === 3) {
          requestStarted.release();
          await releaseRequest.promise;
          yield* response('interim', 8500);
          return;
        }
        releaseCompact.release();
        yield* response('finished', 100);
      },
      async () => {
        generated.release();
        await releaseCompact.promise;
        return { summary: 'PREFIX_HANDOFF' };
      }
    );
    await f.session.run({ prompt: 'Seed' }).result();
    const handle = f.session.run({ prompt: 'Read and finish', permissionMode: 'full-access' });
    await Promise.race([
      Promise.all([generated.promise, requestStarted.promise]),
      handle.result().then((r) => {
        throw new Error(JSON.stringify(r));
      })
    ]);
    const receipt = await f.session.steer({
      expectedExecutionId: handle.executionId,
      prompt: 'Retained guidance',
      clientMessageId: 'async-cut'
    });
    expect(receipt.status).toBe('accepted');
    receivedId = receipt.status === 'accepted' ? receipt.entry.recordId : undefined;
    releaseRequest.release();
    expect(await handle.result()).toMatchObject({ status: 'completed' });
    const store = await JsonlSessionStore.open(f.home);
    try {
      const records = await store.read(f.session.id);
      const checkpoint = records.findLast((r) => r.type === 'compact.completed')!;
      const tail = (checkpoint.payload as { retainedModelContext: Record<string, unknown>[] })
        .retainedModelContext;
      expect(
        tail.filter(
          (m) => m.inputRef === (receipt.status === 'accepted' ? receipt.entry.recordId : '')
        )
      ).toHaveLength(1);
      expect((checkpoint.payload as { pendingInputs?: unknown[] }).pendingInputs ?? []).toEqual([]);
      const restored = await restoreMessages(
        store,
        f.session.id,
        (await store.readExecutionState(f.session.id)).contextRecords,
        { includeImages: true, strictImages: true }
      );
      expect(restored.messages.filter((m) => m.content === 'Retained guidance')).toHaveLength(1);
      expect(restored.messages.find((m) => m.content === 'Retained guidance')).toMatchObject({
        role: 'user',
        metadata: {
          source: 'user',
          recordId: receipt.status === 'accepted' ? receipt.entry.recordId : ''
        }
      });
    } finally {
      await store.close();
    }
    expect(await f.session.run({ prompt: 'Followup' }).result()).toMatchObject({
      status: 'completed'
    });
    expect(followupCopies).toBe(1);
  });
  it('keeps sidecar instructions out of native Compact evidence and its checkpoint', async () => {
    const marker = 'PRIVATE_COMPACT_EVIDENCE_MARKER';
    const f = await fixture(
      (request, index) => {
        if (request.toolChoice === 'none')
          return response(
            request.messages.some((message) => message.content.includes(marker))
              ? marker
              : 'SAFE_HANDOFF',
            100
          );
        return response('answer', index === 1 ? 100 : 8500);
      },
      async () => undefined
    );
    await writeFile(join(f.home, 'workspace', 'AGENTS.md'), marker);
    await f.session.run({ prompt: 'Seed' }).result();
    expect((await f.session.run({ prompt: 'Finish' }).result()).status).toBe('completed');
    expect(f.requests[0]!.messages.some((message) => message.content.includes(marker))).toBe(true);
    const compact = f.requests.find((request) => request.toolChoice === 'none');
    expect(compact).toBeDefined();
    expect(compact!.messages.some((message) => message.content.includes(marker))).toBe(false);
    const store = await JsonlSessionStore.open(f.home);
    try {
      expect(JSON.stringify(await store.read(f.session.id))).not.toContain(marker);
    } finally {
      await store.close();
    }
  });

  it('anchors a closed tool prefix by its public identity, never contextual text', () => {
    expect(
      compactSnapshotAnchor(
        [
          { role: 'tool', callId: 'completed-read', content: 'result' },
          { role: 'user', contextKind: 'private', content: 'private instructions' }
        ],
        new WeakMap()
      )
    ).toEqual({ kind: 'tool', id: 'completed-read' });
    expect(
      compactSnapshotAnchor(
        [{ role: 'user', contextKind: 'private', content: 'private instructions' }],
        new WeakMap()
      )
    ).toBeUndefined();
  });

  it.each([8499, 8500])(
    'starts automatically at the exact 85 percent boundary: %i',
    async (tokens) => {
      const f = await fixture(
        () => response('answer', tokens),
        async () => ({ summary: 'HANDOFF' })
      );
      expect((await f.session.run({ prompt: 'Task' }).result()).status).toBe('completed');
      expect(f.generations()).toBe(tokens < 8500 ? 0 : 1);
    }
  );

  it('stops after a committed background checkpoint cannot be projected and restores it next execution', async () => {
    const generated = barrier();
    const release = barrier();
    const third = barrier();
    const f = await fixture(
      (_request, index) => {
        if (index === 1) return response('seed', 100);
        if (index === 2) return readCall('first-read', 8500);
        if (index === 3) {
          third.release();
          return readCall('second-read', 9000);
        }
        return response('recovered', 100);
      },
      async () => {
        generated.release();
        await release.promise;
        return { summary: 'DURABLE_BACKGROUND_CHECKPOINT' };
      }
    );
    await f.session.run({ prompt: 'seed' }).result();
    let failReset = true;
    f.adapter.createTurnSession = () => ({
      start: (request) => f.adapter.start(request),
      close: async () => {},
      resetContinuation: () => {
        if (failReset) throw new Error('injected post-commit reset failure');
      }
    });
    const result = f.session.run({ prompt: 'read and continue' }).result();
    try {
      await generated.promise;
      await third.promise;
      await vi.waitFor(() =>
        expect(
          f.host.events.some(
            (event) => event.type === 'context.compacting' && event.stage === 'WAITING'
          )
        ).toBe(true)
      );
      release.release();
      expect(await result).toMatchObject({ status: 'failed' });
      expect(f.requests).toHaveLength(3);
      const store = await JsonlSessionStore.open(f.home);
      try {
        const checkpoints = (await store.read(f.session.id)).filter(
          (record) => record.type === 'compact.completed'
        );
        expect(checkpoints).toHaveLength(1);
        expect(checkpoints[0]).toMatchObject({
          payload: { summary: 'DURABLE_BACKGROUND_CHECKPOINT' }
        });
      } finally {
        await store.close();
      }
      failReset = false;
      expect(await f.session.run({ prompt: 'recover' }).result()).toMatchObject({
        status: 'completed',
        finalAnswer: 'recovered'
      });
      expect(f.requests).toHaveLength(4);
      expect(
        f.requests[3]!.messages.some((message) =>
          message.content.includes('DURABLE_BACKGROUND_CHECKPOINT')
        )
      ).toBe(true);
    } finally {
      release.release();
      await result;
    }
  });

  it('continues at 85, awaits the same generation at 90, and restores the complete tool suffix once', async () => {
    const generated = barrier();
    const release = barrier();
    const third = barrier();
    const f = await fixture(
      (_request, index) => {
        if (index === 1) return response('seed-answer', 100);
        if (index === 2)
          return [
            {
              type: 'response.item',
              provider: 'ANTHROPIC_MESSAGES',
              contextKind: 'private',
              item: {
                type: 'thinking',
                thinking: 'fixture-native-state',
                signature: 'fixture-signature'
              }
            },
            ...readCall('first-read', 8500)
          ];
        if (index === 3) {
          third.release();
          return readCall('second-read', 9000);
        }
        return response('finished', 100);
      },
      async () => {
        generated.release();
        await release.promise;
        return { summary: 'PREFIX_HANDOFF' };
      }
    );
    await writeFile(join(f.home, 'workspace', 'AGENTS.md'), 'PRIVATE_CONTEXT_MARKER');
    await f.session.run({ prompt: 'Seed objective' }).result();
    const gcRun = vi.spyOn(ContextGcRuntime.prototype, 'run');
    const seedAnswer = f.host.events.find(
      (event) => event.type === 'message.completed' && event.text === 'seed-answer'
    );
    if (seedAnswer?.type !== 'message.completed') throw new Error('Missing seed answer.');
    const handle = f.session.run({ prompt: 'Read twice and finish' });
    const result = handle.result();
    await generated.promise;
    await third.promise;
    await vi.waitFor(() =>
      expect(
        f.host.events.some(
          (event) => event.type === 'context.compacting' && event.stage === 'WAITING'
        )
      ).toBe(true)
    );
    expect(f.requests).toHaveLength(3);
    expect(f.generations()).toBe(1);
    expect(gcRun).not.toHaveBeenCalled();
    expect(
      f.host.events.find(
        (event) => event.type === 'context.compacting' && event.stage === 'GENERATING'
      )
    ).toMatchObject({
      anchor: { kind: 'message', id: seedAnswer.itemId }
    });
    release.release();
    expect(await result).toMatchObject({ status: 'completed', finalAnswer: 'finished' });
    expect(f.requests).toHaveLength(4);
    expect(
      f.requests[3]!.messages.filter(
        (message) => message.role === 'provider' && message.provider === 'ANTHROPIC_MESSAGES'
      )
    ).toHaveLength(1);
    expect(f.host.events.find((event) => event.type === 'context.compacted')).toMatchObject({
      anchor: { kind: 'message', id: seedAnswer.itemId }
    });
    for (const id of ['first-read', 'second-read']) {
      expect(
        f.requests[3]!.messages.filter(
          (message) => message.role === 'tool_call' && message.callId === id
        )
      ).toHaveLength(1);
      expect(
        f.requests[3]!.messages.filter(
          (message) => message.role === 'tool' && message.callId === id
        )
      ).toHaveLength(1);
    }
    const store = await JsonlSessionStore.open(f.home);
    try {
      const records = (await store.readExecutionState(f.session.id)).contextRecords;
      const restored = await restoreMessages(store, f.session.id, records, {
        includeImages: false
      });
      expect(
        restored.messages.filter(
          (message) => message.role === 'tool' && message.callId === 'first-read'
        )
      ).toHaveLength(1);
      expect(
        restored.messages.filter(
          (message) => message.role === 'provider' && message.provider === 'ANTHROPIC_MESSAGES'
        )
      ).toEqual([
        expect.objectContaining({
          item: {
            type: 'thinking',
            thinking: 'fixture-native-state',
            signature: 'fixture-signature'
          }
        })
      ]);
      expect(
        restored.messages.filter((message) => message.content === 'Read twice and finish')
      ).toHaveLength(1);
      expect(
        restored.userMessages.some((message) => message.content === 'Read twice and finish')
      ).toBe(true);
      expect(records.filter((record) => record.type === 'compact.completed')).toHaveLength(1);
      const checkpoint = records.find((record) => record.type === 'compact.completed')!;
      expect(checkpoint.payload).toHaveProperty('snapshotMessageCount');
      expect(checkpoint.payload).toHaveProperty('snapshotRecordId');
      expect(JSON.stringify(await store.read(f.session.id))).not.toContain(
        'PRIVATE_CONTEXT_MARKER'
      );
    } finally {
      await store.close();
    }
  });

  it('does not carry old thinking when the asynchronous suffix already contains four complete blocks', async () => {
    const release = barrier();
    const native = (group: string, count: number): ModelEvent[] =>
      Array.from({ length: count }, (_, index) => ({
        type: 'response.item',
        provider: 'ANTHROPIC_MESSAGES',
        contextKind: 'private',
        item: { type: 'thinking', thinking: '', signature: `${group}-${index}` }
      }));
    const f = await fixture(
      (_request, index) => {
        if (index === 1) return [...native('old', 4), ...response('seed', 100)];
        if (index === 2) return readCall('before-snapshot', 8500);
        if (index === 3) return [...native('new', 4), ...readCall('after-snapshot', 8500)];
        if (index === 4) {
          release.release();
          return readCall('after-release', 9000);
        }
        return response('finished', 100);
      },
      async () => {
        await release.promise;
        return { summary: 'HANDOFF' };
      }
    );
    await f.session.run({ prompt: 'Seed' }).result();
    expect(await f.session.run({ prompt: 'Read three times' }).result()).toMatchObject({
      status: 'completed'
    });
    expect(f.generations()).toBe(1);
    const latest = f.requests.at(-1)!.messages;
    const expected = native('new', 4).map((event) =>
      event.type === 'response.item' ? event.item : undefined
    );
    expect(
      latest.filter((message) => message.role === 'provider').map((message) => message.item)
    ).toEqual(expected);
    for (const callId of ['after-snapshot', 'after-release']) {
      expect(
        latest.filter((message) => message.role === 'tool_call' && message.callId === callId)
      ).toHaveLength(1);
      expect(
        latest.filter((message) => message.role === 'tool' && message.callId === callId)
      ).toHaveLength(1);
    }
    const store = await JsonlSessionStore.open(f.home);
    try {
      const state = await store.readExecutionState(f.session.id);
      const restored = await restoreMessages(store, f.session.id, state.contextRecords, {
        includeImages: false
      });
      expect(
        restored.messages
          .filter((message) => message.role === 'provider')
          .map((message) => message.item)
      ).toEqual(expected);
    } finally {
      await store.close();
    }
  });

  it('preserves an automatic child update committed after the Compact snapshot exactly once', async () => {
    const generated = barrier();
    const release = barrier();
    let parentRounds = 0;
    let interceptedParentRounds = 0;
    let childId = '';
    const isChild = (request: ModelRequest) =>
      request.messages.some(
        (message) =>
          message.role === 'user' && message.content.includes('Report CHILD_COMPACT_TAIL.')
      );
    const f = await fixture(
      (request) => {
        if (isChild(request)) return response('CHILD_COMPACT_TAIL', 100);
        switch (++parentRounds) {
          case 1:
            return response('seed', 100);
          case 2:
            return readCall('first-read', 8500);
          case 3:
            return readCall('second-read', 9000);
          default:
            return response('finished', 100);
        }
      },
      async () => {
        generated.release();
        await release.promise;
        return { summary: 'PREFIX_HANDOFF' };
      },
      (context) => {
        context.hooks.intercept('model.request', async (request, _call, next) => {
          if (!isChild(request) && ++interceptedParentRounds === 3) {
            await generated.promise;
            const client = context.services.consume(SUBAGENT_NATIVE_SERVICE)!.open();
            const child = await client.spawn({
              description: 'Compact tail child',
              prompt: 'Report CHILD_COMPACT_TAIL.',
              role: 'explore',
              background: false
            });
            childId = child.agentId;
          }
          return next(request);
        });
      },
      true
    );
    await f.session.run({ prompt: 'Seed objective' }).result();
    const result = f.session.run({ prompt: 'Read twice and finish' }).result();
    try {
      await vi.waitFor(() =>
        expect(
          f.host.events.some(
            (event) => event.type === 'context.compacting' && event.stage === 'WAITING'
          )
        ).toBe(true)
      );
      expect(childId).not.toBe('');
      release.release();
      expect(await result).toMatchObject({ status: 'completed', finalAnswer: 'finished' });
      expect(parentRounds).toBe(4);
      const finalRequest = f.requests.at(-1)!;
      const update = finalRequest.messages.filter((message) =>
        message.content.includes('<mar_subagent_update')
      );
      expect(update).toHaveLength(1);
      expect(update[0]).toMatchObject({ role: 'user', contextKind: 'contextual' });
      expect(update[0]!.content).toContain(childId);
      expect(update[0]!.content).toContain('CHILD_COMPACT_TAIL');
      const store = await JsonlSessionStore.open(f.home);
      try {
        const records = (await store.readExecutionState(f.session.id)).contextRecords;
        expect(records.filter((record) => record.type === 'compact.completed')).toHaveLength(1);
        const restored = await restoreMessages(store, f.session.id, records, {
          includeImages: false
        });
        expect(
          restored.messages.filter((message) => message.content.includes('<mar_subagent_update'))
        ).toEqual(update);
        expect(
          restored.userMessages.some((message) => message.content.includes('<mar_subagent_update'))
        ).toBe(false);
      } finally {
        await store.close();
      }
    } finally {
      release.release();
      await result;
    }
  });

  it('keeps a committed Compact successful if its recoverable sidecar refresh fails', async () => {
    const f = await fixture(
      () => response('answer', 8500),
      async () => ({ summary: 'COMMITTED_HANDOFF' })
    );
    const compact = JsonlSessionStore.prototype.compact;
    const write = JsonlSessionStore.prototype.writeContextualWorldState;
    let committed = false;
    const compactSpy = vi
      .spyOn(JsonlSessionStore.prototype, 'compact')
      .mockImplementation(async function (this: JsonlSessionStore, ...args) {
        const record = await compact.apply(this, args);
        committed = true;
        return record;
      });
    const writeSpy = vi
      .spyOn(JsonlSessionStore.prototype, 'writeContextualWorldState')
      .mockImplementation(async function (this: JsonlSessionStore, ...args) {
        if (committed) throw new Error('Injected sidecar failure.');
        return write.apply(this, args);
      });
    try {
      expect((await f.session.run({ prompt: 'Finish' }).result()).status).toBe('completed');
      expect(committed).toBe(true);
      expect(f.host.events.filter((event) => event.type === 'context.compacted')).toHaveLength(1);
      expect(f.host.events.filter((event) => event.type === 'context.compact_failed')).toHaveLength(
        0
      );
      expect(f.agent.extensionDiagnostics()).toContainEqual(
        expect.objectContaining({ code: 'MAR_AGENT_COMPACT_SIDECAR_PERSIST_FAILED' })
      );
    } finally {
      compactSpy.mockRestore();
      writeSpy.mockRestore();
    }
    await f.agent.dispose();
    const requests: ModelRequest[] = [];
    const restarted = await createAgentWithAdapter(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: f.home, workspace: join(f.home, 'workspace') }),
        models: [configuration]
      },
      () => ({
        configuration,
        async *start(request) {
          requests.push(request);
          yield* response('resumed', 100);
        }
      })
    );
    agents.push(restarted);
    const resumed = await restarted.openSession(f.session.id);
    expect((await resumed.run({ prompt: 'Continue' }).result()).status).toBe('completed');
    expect(
      requests[0]!.messages.some((message) => message.content.includes('COMMITTED_HANDOFF'))
    ).toBe(true);
  });

  it('waits for a running generation before the Execution result and terminal event', async () => {
    const generated = barrier();
    const release = barrier();
    const f = await fixture(
      () => response('final-answer', 8500),
      async () => {
        generated.release();
        await release.promise;
        return { summary: 'READY_HANDOFF' };
      }
    );
    let settled = false;
    const result = f.session
      .run({ prompt: 'Finish the task' })
      .result()
      .then((value) => {
        settled = true;
        return value;
      });
    await generated.promise;
    expect(settled).toBe(false);
    expect(f.host.events.some((event) => event.type === 'execution.completed')).toBe(false);
    release.release();
    expect((await result).status).toBe('completed');
    const compacted = f.host.events.findIndex((event) => event.type === 'context.compacted');
    expect(compacted).toBeGreaterThan(-1);
    expect(
      f.host.events.findIndex((event) => event.type === 'execution.completed')
    ).toBeGreaterThan(compacted);
  });

  it('routes external true/false requests into one operation without another main loop', async () => {
    const sampling = barrier();
    const resume = barrier();
    const generated = barrier();
    const release = barrier();
    const f = await fixture(
      async function* () {
        sampling.release();
        await resume.promise;
        yield* response('final-answer', 100);
      },
      async () => {
        generated.release();
        await release.promise;
        return { summary: 'EXTERNAL_HANDOFF' };
      }
    );
    const main = f.session.run({ prompt: 'Task' });
    const result = main.result();
    await sampling.promise;
    const background = f.session.compact({ async: true });
    const blocking = f.session.compact({ async: false });
    const cancelled = f.session.compact({ async: true });
    cancelled.cancel();
    expect((await cancelled.result()).status).toBe('cancelled');
    expect(background.executionId).toBe(main.executionId);
    resume.release();
    await generated.promise;
    expect(f.generations()).toBe(1);
    release.release();
    expect((await background.result()).status).toBe('completed');
    expect((await blocking.result()).status).toBe('completed');
    expect((await result).status).toBe('completed');
    expect(f.requests).toHaveLength(1);
  });

  it('joins active subagent Compact while model reconfiguration drains an idle parent Adapter', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-compact-reconfiguration-'));
    homes.push(home);
    await writeFile(join(home, 'evidence.txt'), 'CHILD_EVIDENCE');
    const resumeChild = barrier();
    const finishChild = barrier();
    const releaseCompact = barrier();
    const releaseReconfiguration = barrier();
    let childStarted = false;
    let closingParent = false;
    let generations = 0;
    let childRounds = 0;
    let parentContext!: Parameters<NonNullable<AgentExtension['attachSession']>>[0];
    const host = new LocalAgentHost({ homeDirectory: home, workspace: home });
    let agent!: Agent;
    agent = await createAgentWithAdapter(
      {
        mode: 'normal',
        host,
        models: [{ ...configuration, subagentModel: true }],
        extensions: [
          createSubagentExtension({ agent: () => agent }),
          {
            id: 'reconfiguration-compact',
            apiVersion: '1.0',
            serviceDependencies: [{ key: SUBAGENT_NATIVE_SERVICE }],
            attachSession(context) {
              parentContext = context;
              context.hooks.intercept('compact.generate', async () => {
                generations++;
                await releaseCompact.promise;
                return { summary: 'CHILD_HANDOFF' };
              });
            }
          }
        ]
      },
      (selected) => {
        const adapter: ModelAdapter = {
          configuration: selected,
          async *start(request) {
            if (
              request.messages.some(
                (message) =>
                  message.role === 'user' && message.content.includes('read evidence and finish')
              )
            ) {
              if (++childRounds === 1) {
                childStarted = true;
                await resumeChild.promise;
                yield* readCall('child-read', 100);
              } else {
                await finishChild.promise;
                yield* response('child done', 100);
              }
            } else yield* response('parent done', 100);
          },
          createTurnSession: () => ({ start: adapter.start.bind(adapter), close: async () => {} }),
          async close() {
            closingParent = true;
            await releaseReconfiguration.promise;
          }
        };
        return adapter;
      }
    );
    agents.push(agent);
    const parent = await agent.createSession({ workspace: home });
    const compacts: ExecutionHandle[] = [];
    let reconfiguration: Promise<void> | undefined;
    try {
      expect(await parent.run({ prompt: 'initialize parent' }).result()).toHaveProperty(
        'status',
        'completed'
      );
      const client = parentContext.services.consume(SUBAGENT_NATIVE_SERVICE)!.open();
      const task = await client.spawn({
        prompt: 'read evidence and finish',
        background: true
      });
      await vi.waitFor(() => expect(childStarted).toBe(true));
      expect(await agent.getSession(task.agentId)).toHaveProperty('source.type', 'subagent');
      const child = await agent.openSession(task.agentId);
      const background = child.compact({ async: true });
      compacts.push(background);
      resumeChild.release();
      await vi.waitFor(() => expect(generations).toBe(1));
      reconfiguration = agent.reconfigureModels({
        models: [{ ...configuration, name: 'Reconfigured' }]
      });
      void reconfiguration.catch(() => undefined);
      await vi.waitFor(() => expect(closingParent).toBe(true));
      expect(() => parent.run({ prompt: 'new execution during reconfiguration' })).toThrowError(
        expect.objectContaining({ code: 'MAR_AGENT_EXECUTION_ACTIVE' })
      );
      const joined = child.compact({ async: false });
      compacts.push(joined);
      expect(joined.executionId).toBe(background.executionId);
      expect(generations).toBe(1);
      releaseCompact.release();
      finishChild.release();
      expect(await background.result()).toMatchObject({ status: 'completed' });
      expect(await joined.result()).toMatchObject({ status: 'completed' });
      releaseReconfiguration.release();
      await reconfiguration;
      expect(await client.wait({ agentId: task.agentId, waitMs: 1000 })).toHaveProperty(
        'status',
        'completed'
      );
      const store = await JsonlSessionStore.open(home);
      try {
        expect(
          (await store.read(task.agentId)).filter((record) => record.type === 'compact.completed')
        ).toHaveLength(1);
      } finally {
        await store.close();
      }
      expect(generations).toBe(1);
    } finally {
      resumeChild.release();
      finishChild.release();
      releaseCompact.release();
      releaseReconfiguration.release();
      await reconfiguration;
      await Promise.all(compacts.map((handle) => handle.result()));
    }
  });

  it.each(['sdk', 'core'] as const)(
    'honors a %s blocking join admitted by request middleware before sampling its rebuilt context',
    async (api) => {
      const release = barrier();
      const hookEntered = barrier();
      const continueHook = barrier();
      const f = await fixture(
        (_request, index) => (index === 2 ? readCall('read', 8500) : response('answer', 100)),
        async () => {
          await release.promise;
          return { summary: 'LATE_BLOCKING_HANDOFF' };
        }
      );
      await f.session.run({ prompt: 'Seed' }).result();
      let blocking: ReturnType<typeof f.session.compact> | undefined;
      let requested = false;
      f.context().hooks.intercept('model.request', async (request, _call, next) => {
        if (f.generations() > 0 && !requested) {
          requested = true;
          hookEntered.release();
          await continueHook.promise;
          if (api === 'sdk') blocking = f.session.compact({ async: false });
          else await f.context().session!.compact({ async: false });
          release.release();
        }
        return next(request);
      });
      const handle = f.session.run({ prompt: 'Read and finish' });
      try {
        await Promise.race([
          hookEntered.promise,
          handle.result().then(() => {
            throw new Error('Execution ended before request Hook.');
          })
        ]);
        expect(f.requests).toHaveLength(2);
        const before = await f.context().session.captureRequest();
        expect(JSON.stringify(before!.request)).not.toContain('LATE_BLOCKING_HANDOFF');
        continueHook.release();
        expect((await handle.result()).status).toBe('completed');
        if (blocking) expect((await blocking.result()).status).toBe('completed');
        else
          expect(
            (await f.context().session!.inspect()).operations
              .filter((entry) => entry.kind === 'compact')
              .every((entry) => entry.status === 'completed')
          ).toBe(true);
        expect(f.requests).toHaveLength(3);
        expect(
          f.requests[2]!.messages.some((message) =>
            message.content.includes('LATE_BLOCKING_HANDOFF')
          )
        ).toBe(true);
        expect(f.generations()).toBe(1);
        const dispatched = await f.context().session.captureRequest();
        expect(dispatched).not.toEqual(before);
        expect(JSON.stringify(dispatched!.request)).toContain('LATE_BLOCKING_HANDOFF');
        const store = await JsonlSessionStore.open(f.home);
        try {
          const records = await store.read(f.session.id);
          expect(records.filter((record) => record.type === 'compact.completed')).toHaveLength(1);
          const restored = await restoreMessages(store, f.session.id, records, {
            includeImages: false
          });
          expect(
            restored.messages.filter((message) => message.content.includes('LATE_BLOCKING_HANDOFF'))
          ).toHaveLength(1);
        } finally {
          await store.close();
        }
      } finally {
        continueHook.release();
        release.release();
        await handle.result();
      }
    }
  );

  it('drains a request admitted after the final regular checkpoint before finishing', async () => {
    const f = await fixture(
      () => response('answer', 100),
      async () => ({ summary: 'FINAL_HANDOFF' })
    );
    let compact: ReturnType<typeof f.session.compact> | undefined;
    const drain = CompactRequests.prototype.drain;
    const spy = vi.spyOn(CompactRequests.prototype, 'drain').mockImplementation(function (
      this: CompactRequests,
      start
    ) {
      const blocking = drain.call(this, start);
      if (f.requests.length === 1 && !compact) compact = f.session.compact({ async: true });
      return blocking;
    });
    try {
      expect((await f.session.run({ prompt: 'Finish' }).result()).status).toBe('completed');
      expect((await compact!.result()).status).toBe('completed');
      expect(f.generations()).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not install manual Compact after its middleware fails and cancels the operation', async () => {
    const started = barrier();
    const release = barrier();
    const cancelled = barrier();
    const f = await fixture(
      () => response('seed', 100),
      async () => {
        started.release();
        await release.promise;
        return { summary: 'MUST_NOT_INSTALL' };
      }
    );
    await f.session.run({ prompt: 'Seed' }).result();
    f.context().hooks.intercept('session.compact', async (input, call, next) => {
      call.signal.addEventListener('abort', cancelled.release, { once: true });
      void next(input).catch(() => undefined);
      await started.promise;
      throw new Error('Compact middleware failed');
    });
    const handle = f.session.compact();
    const result = handle.result();
    try {
      await started.promise;
      await cancelled.promise;
      release.release();
      expect((await result).status).toBe('failed');
      const store = await JsonlSessionStore.open(f.home);
      try {
        expect(
          (await store.read(f.session.id)).some((record) => record.type === 'compact.completed')
        ).toBe(false);
      } finally {
        await store.close();
      }
    } finally {
      release.release();
      handle.cancel();
      await result;
    }
  });

  it('cancels and drains generation before publishing Execution cancellation', async () => {
    const generated = barrier();
    const f = await fixture(
      () => response('final-answer', 8500),
      async (signal) => {
        generated.release();
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return { summary: 'NOT_COMMITTED' };
      }
    );
    const handle = f.session.run({ prompt: 'Task' });
    const result = handle.result();
    await generated.promise;
    handle.cancel();
    expect((await result).status).toBe('cancelled');
    expect(f.host.events.some((event) => event.type === 'context.compacted')).toBe(false);
    const failed = f.host.events.findIndex((event) => event.type === 'context.compact_failed');
    expect(failed).toBeGreaterThan(-1);
    expect(
      f.host.events.findIndex((event) => event.type === 'execution.cancelled')
    ).toBeGreaterThan(failed);
  });

  it('keeps a Core async receipt in progress until safe installation', async () => {
    const sampling = barrier();
    const resume = barrier();
    const generated = barrier();
    const release = barrier();
    const f = await fixture(
      async function* () {
        sampling.release();
        await resume.promise;
        yield* response('finished', 100);
      },
      async () => {
        generated.release();
        await release.promise;
        return { summary: 'CORE_HANDOFF' };
      }
    );
    const result = f.session.run({ prompt: 'Task' }).result();
    await sampling.promise;
    const receipt = await f.context().session!.compact({ async: true });
    expect(receipt.status).toBe('queued');
    resume.release();
    await generated.promise;
    expect(receipt.operationId).toEqual(expect.any(String));
    expect(
      (await f.context().session!.inspect()).operations.find(
        (entry) => entry.operationId === receipt.operationId
      )?.status
    ).toBe('in-progress');
    release.release();
    expect((await result).status).toBe('completed');
    expect(
      (await f.context().session!.inspect()).operations.find(
        (entry) => entry.operationId === receipt.operationId
      )?.status
    ).toBe('completed');
    expect(f.generations()).toBe(1);
  });

  it('never releases the hard gate when speculative and foreground compaction both fail', async () => {
    const f = await fixture(
      (request, index) => {
        if (request.toolChoice === 'none') return [{ type: 'completed', reason: 'max_output' }];
        return index === 1 ? response('seed', 100) : readCall('blocked-read', 9000);
      },
      async () => {
        throw new Error('Generator unavailable');
      }
    );
    await f.session.run({ prompt: 'Seed' }).result();
    const result = await f.session.run({ prompt: 'Read and continue' }).result();
    expect(result.status).toBe('failed');
    expect(f.generations()).toBe(2);
    expect(f.requests.filter((request) => request.toolChoice !== 'none')).toHaveLength(2);
    expect(f.host.events.some((event) => event.type === 'context.compacted')).toBe(false);
  });
});
