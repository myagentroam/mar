import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAgentHost, SecretValue, type MarAgentModelConfiguration } from '../../src/index.js';
import { createMarAgentWithAdapter } from '../../src/agent-core/sdk/agent.js';
import type { MarAgent } from '../../src/agent-core/sdk/types.js';
import type { CoreRuntimeExtension } from '../../src/agent-core/extensions/contracts.js';
import type { ModelEvent, ModelRequest } from '../../src/agent-core/model/contracts.js';
import { JsonlSessionStore } from '../../src/agent-core/session/store/index.js';
import { restoreMessages } from '../../src/agent-core/runtime/context/restore.js';
import { CompactRequests } from '../../src/agent-core/runtime/compaction/requests.js';
import { compactSnapshotAnchor } from '../../src/agent-core/runtime/compaction/retained-context.js';
import { effectiveInstructions } from './support/model-context.js';

const configuration: MarAgentModelConfiguration = {
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
const agents: MarAgent[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.dispose()));
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
  attach?: (context: Parameters<NonNullable<CoreRuntimeExtension['attachSession']>>[0]) => void
) {
  const home = await mkdtemp(join(tmpdir(), 'mar-async-compact-'));
  homes.push(home);
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'evidence.txt'), 'TAIL_TOOL_EVIDENCE');
  const requests: ModelRequest[] = [];
  let generations = 0;
  let context!: Parameters<NonNullable<CoreRuntimeExtension['attachSession']>>[0];
  const extension: CoreRuntimeExtension = {
    id: 'compact-test',
    apiVersion: '1.0',
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
  const agent = await createMarAgentWithAdapter({
    mode: 'normal',
    host,
    models: [configuration],
    runtimeExtensions: [extension],
    adapterFactory: () => ({
      configuration,
      async *start(request) {
        const index = requests.push(request);
        yield* script(request, index);
      }
    })
  });
  agents.push(agent);
  const session = await agent.createSession({ workspace, title: 'Async compact' });
  return {
    home,
    host,
    agent,
    session,
    requests,
    generations: () => generations,
    context: () => context
  };
}

describe('asynchronous Compact', () => {
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

  it('preserves an automatic child update committed after the Compact snapshot exactly once', async () => {
    const generated = barrier();
    const release = barrier();
    let parentRounds = 0;
    let interceptedParentRounds = 0;
    let childId = '';
    const isChild = (request: ModelRequest) =>
      effectiveInstructions(request).includes('non-recursive subagent');
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
            const child = await context.agents!.spawn({
              description: 'Compact tail child',
              prompt: 'Report CHILD_COMPACT_TAIL.',
              role: 'explore',
              background: false
            });
            childId = child.agentId;
          }
          return next(request);
        });
      }
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
      expect(update[0]!.content).toContain('agentId="' + childId + '"');
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
    } finally {
      compactSpy.mockRestore();
      writeSpy.mockRestore();
    }
    await f.agent.dispose();
    const requests: ModelRequest[] = [];
    const restarted = await createMarAgentWithAdapter({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: f.home, workspace: join(f.home, 'workspace') }),
      models: [configuration],
      adapterFactory: () => ({
        configuration,
        async *start(request) {
          requests.push(request);
          yield* response('resumed', 100);
        }
      })
    });
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

  it.each(['sdk', 'core'] as const)(
    'honors a %s blocking join admitted by request middleware before sampling its rebuilt context',
    async (api) => {
      const release = barrier();
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
          if (api === 'sdk') blocking = f.session.compact({ async: false });
          else await f.context().session!.compact({ async: false });
          release.release();
        }
        return next(request);
      });
      try {
        expect((await f.session.run({ prompt: 'Read and finish' }).result()).status).toBe(
          'completed'
        );
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
      } finally {
        release.release();
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
