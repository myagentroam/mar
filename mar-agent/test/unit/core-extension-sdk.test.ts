import { ExtensionResourceScope } from '../../src/extensions/resources.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionRequestBridge } from '../../src/extensions/model-request.js';
import { effectiveInstructions } from './support/model-context.js';
import type { AgentExtension, SessionExtensionContext } from '../../src/extensions/contracts.js';
import {
  fixture,
  answer,
  call,
  agents,
  homes,
  cleanupCoreFixtures
} from './support/core-extension-fixture.js';

afterEach(cleanupCoreFixtures);

describe('Core Extension SDK composition', () => {
  it.each([false, true])(
    'only lowers public request views when intercepted (%s)',
    async (intercept) => {
      const lower = vi.spyOn(ExtensionRequestBridge.prototype, 'lower');
      try {
        const { session, adapter } = await fixture(
          intercept
            ? [
                {
                  id: 'identity-request',
                  apiVersion: '1.0',
                  attachSession(context) {
                    context.hooks.intercept('model.request', (request, _call, next) =>
                      next(request)
                    );
                  }
                }
              ]
            : [],
          () => answer()
        );
        expect(await session.run({ prompt: 'stable input' }).result()).toMatchObject({
          status: 'completed'
        });
        expect(lower).toHaveBeenCalledTimes(intercept ? 1 : 0);
        expect(adapter.requests[0]!.promptCacheKey).toBe(session.id);
        expect(adapter.requests[0]!.systemBlocks).toBeUndefined();
        expect(adapter.requests[0]!.tools.some((tool) => tool.name === 'agent_start')).toBe(false);
        expect(
          adapter.requests[0]!.messages.every((message) => message.textBlocks === undefined)
        ).toBe(true);
      } finally {
        lower.mockRestore();
      }
    }
  );

  it('supports scoped clock sleep during attach and independent child cancellation', async () => {
    let context!: SessionExtensionContext;
    const { session } = await fixture(
      [
        {
          id: 'clock-sleep',
          apiVersion: '1.0',
          async attachSession(value) {
            context = value;
            await value.clock.sleep({ durationMs: 1 });
          }
        }
      ],
      () => answer()
    );
    expect(await session.run({ prompt: 'initialize' }).result()).toMatchObject({
      status: 'completed'
    });
    const controller = new AbortController();
    const reason = new Error('explicit sleep cancellation');
    const waiting = context.clock.sleep({ durationMs: 10_000, signal: controller.signal });
    const rejected = waiting.catch((error) => error);
    controller.abort(reason);
    expect(await rejected).toBe(reason);
    expect((context.resources as ExtensionResourceScope).signal.aborted).toBe(false);
    await context.clock.sleep({ durationMs: 0 });
  });

  it('cancels independent generation with an explicit child signal without retiring its extension', async () => {
    let context!: SessionExtensionContext;
    const controller = new AbortController();
    const reason = new Error('explicit generation cancellation');
    let cancel = false;
    let terminalEvents = 0;
    const { session, adapter } = await fixture(
      [
        {
          id: 'generate-signal',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('model.event', async (event, _call, next) => {
              if (event.type === 'completed') terminalEvents++;
              if (cancel && event.type === 'text.delta') {
                controller.abort(reason);
                await value.data.state.write('late', true).catch(() => undefined);
              }
              return next(event);
            });
          }
        }
      ],
      (_request, index) =>
        index === 0
          ? answer()
          : [
              { type: 'text.delta', itemId: 'answer', phase: 'final_answer', delta: 'partial' },
              { type: 'text.completed', itemId: 'answer', text: 'finished' },
              { type: 'completed', reason: 'completed' }
            ]
    );
    await session.run({ prompt: 'initialize' }).result();
    cancel = true;
    await expect(
      context.models!.generate({ prompt: 'cancel', signal: controller.signal })
    ).rejects.toBe(reason);
    expect(terminalEvents).toBe(1);
    expect((context.resources as ExtensionResourceScope).signal.aborted).toBe(false);
    expect(await context.data.state.read('late')).toBeUndefined();
    const dispatched = adapter.requests.length;
    await expect(
      context.models!.generate({ prompt: 'already aborted', signal: controller.signal })
    ).rejects.toBe(reason);
    expect(adapter.requests).toHaveLength(dispatched);
    cancel = false;
    await expect(context.models!.generate({ prompt: 'still active' })).resolves.toMatchObject({
      outcome: 'text',
      text: 'finished'
    });
  });

  it.each([
    {},
    [null],
    [{ kind: 'image', mimeType: 'text/plain' }],
    [
      {
        kind: 'image',
        mimeType: 'image/png',
        name: 'image',
        fileName: '../image.png',
        byteSize: 1,
        sha256: 'a'.repeat(64)
      }
    ]
  ])(
    'rejects malformed tool artifacts (%j) across native and Code Mode callers',
    async (artifacts) => {
      let context!: SessionExtensionContext;
      const { session } = await fixture(
        [
          {
            id: 'bad-artifact',
            apiVersion: '1.0',
            attachSession(value) {
              context = value;
              value.tools.register({
                name: 'artifact_probe',
                description: 'Return malformed metadata.',
                inputSchema: { type: 'object' },
                execute: async () => ({ content: 'bad', artifacts: artifacts as never })
              });
            }
          }
        ],
        (_request, index) =>
          index === 0
            ? answer()
            : index === 1
              ? call('code_exec', { code: 'observe.result(await tools.artifact_probe({}));' })
              : answer(),
        true
      );
      await session.run({ prompt: 'initialize' }).result();
      await expect(context.tools.invoke({ name: 'artifact_probe', arguments: {} })).rejects.toThrow(
        /TOOL_OUTPUT_INVALID/
      );
      const handle = session.run({ prompt: 'nested' });
      const events = [];
      for await (const event of handle) events.push(event);
      expect(await handle.result()).toMatchObject({ status: 'completed' });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool.failed',
          toolName: 'artifact_probe',
          code: 'MAR_AGENT_TOOL_OUTPUT_INVALID'
        })
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: 'tool.completed', toolName: 'artifact_probe' })
      );
    }
  );

  it('refreshes standalone compact sources while reusing the same revision and internal composition', async () => {
    let resolved = 0;
    let attached = 0;
    let compacted = 0;
    let context: SessionExtensionContext | undefined;
    const { session } = await fixture(
      {
        resolve: async () => {
          resolved++;
          return {
            revision: '1',
            extensions: [
              {
                id: 'first-compact',
                apiVersion: '1.0',
                attachSession(value) {
                  context = value;
                  attached++;
                  value.hooks.intercept('session.compact', (input, _call, next) => {
                    compacted++;
                    return next(input);
                  });
                }
              }
            ]
          };
        }
      },
      () => answer()
    );
    expect(await session.compact().result()).toMatchObject({ status: 'completed' });
    expect({ resolved, attached, compacted }).toEqual({ resolved: 1, attached: 1, compacted: 1 });
    await session.compact().result();
    expect({ resolved, attached, compacted }).toEqual({ resolved: 2, attached: 1, compacted: 2 });
    await context!.session!.compact({ focus: 'internal compact' });
    expect({ resolved, attached, compacted }).toEqual({ resolved: 2, attached: 1, compacted: 3 });
  });

  it.each([null, {}, [null], undefined])(
    'rejects malformed model request tools (%j) with a stable code',
    async (tools) => {
      const { session } = await fixture(
        [
          {
            id: 'malformed-request',
            apiVersion: '1.0',
            attachSession(value) {
              value.hooks.intercept('model.request', (request, _call, next) =>
                next({ ...request, tools: tools as never })
              );
            }
          }
        ],
        () => answer()
      );
      expect(await session.run({ prompt: 'initialize' }).result()).toMatchObject({
        status: 'failed',
        errorCode: 'MAR_AGENT_EXTENSION_MODEL_REQUEST_INVALID'
      });
    }
  );

  it('rejects tool lowering metadata changes but allows descriptions to be rewritten', async () => {
    let mutate = false;
    const { session } = await fixture(
      [
        {
          id: 'tool-metadata',
          apiVersion: '1.0',
          attachSession(value) {
            value.hooks.intercept('model.request', (request, _call, next) =>
              next({
                ...request,
                tools: request.tools.map((tool) => ({
                  ...tool,
                  description: 'Custom description',
                  ...(mutate ? { nativeType: 'tool_search' as const } : {})
                }))
              })
            );
          }
        }
      ],
      () => answer()
    );
    expect(await session.run({ prompt: 'description' }).result()).toMatchObject({
      status: 'completed'
    });
    mutate = true;
    expect(await session.run({ prompt: 'lowering' }).result()).toMatchObject({
      status: 'failed',
      errorCode: 'MAR_AGENT_EXTENSION_MODEL_REQUEST_INVALID'
    });
  });

  it.each(['delete', 'dispose'] as const)(
    'stops extension scopes before %s waits on model adapter cleanup',
    async (action) => {
      let context!: SessionExtensionContext;
      const { agent, session, adapter } = await fixture(
        [
          {
            id: 'early-retire',
            apiVersion: '1.0',
            attachSession(value) {
              context = value;
              value.clock.every(1, () => {});
            }
          }
        ],
        () => answer(),
        false,
        true
      );
      await session.run({ prompt: 'initialize' }).result();
      let entered!: () => void;
      let release!: () => void;
      const closing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      Object.assign(adapter, {
        close: async () => {
          entered();
          await gate;
        }
      });
      const outcome = action === 'delete' ? agent.deleteSession(session.id) : agent.dispose();
      try {
        await closing;
        expect((context.resources as ExtensionResourceScope).signal.aborted).toBe(true);
      } finally {
        release();
        await outcome;
        Reflect.deleteProperty(adapter, 'close');
      }
    }
  );

  it.each(['clear', 'delete'] as const)(
    'reclaims independent Host resources after %s extension cleanup fails',
    async (action) => {
      const { agent, session, host } = await fixture(
        [
          {
            id: 'cleanup-failure',
            apiVersion: '1.0',
            attachSession() {
              return () => {
                throw new Error('disposer');
              };
            }
          }
        ],
        () => answer()
      );
      await session.run({ prompt: 'initialize' }).result();
      let hostCleanup = 0;
      const original = host.disposeSessionResources.bind(host);
      host.disposeSessionResources = async (id) => {
        hostCleanup++;
        await original(id);
      };
      try {
        const cleanup =
          action === 'clear' ? agent.clearSession(session.id) : agent.deleteSession(session.id);
        await expect(cleanup).rejects.toThrow(/CLEANUP_FAILED/);
        expect(hostCleanup).toBe(1);
      } finally {
        await expect(agent.dispose()).rejects.toThrow(/CLEANUP_FAILED/);
        agents.splice(agents.indexOf(agent), 1);
      }
    }
  );

  it('notifies state observers with the actual committed JSON snapshot', async () => {
    let context!: SessionExtensionContext;
    const { session } = await fixture(
      [
        {
          id: 'state-snapshot',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
          }
        }
      ],
      () => answer()
    );
    await session.run({ prompt: 'initialize' }).result();
    const changes: unknown[] = [];
    context.data.state.watch((change) => {
      changes.push(change.value);
    });
    let reads = 0;
    await context.data.state.write('key', {
      get value() {
        return ++reads;
      }
    });
    expect(changes).toEqual([await context.data.state.read('key')]);
    expect(reads).toBe(1);
  });

  it('preserves the primary model hook failure when adapter cleanup also fails', async () => {
    let context!: SessionExtensionContext;
    let fail = false;
    const primary = new Error('primary model hook failure');
    const { agent, session, adapter } = await fixture(
      [
        {
          id: 'model-cleanup',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('model.event', (event, _call, next) => {
              if (fail) throw primary;
              return next(event);
            });
          }
        }
      ],
      () => answer()
    );
    await session.run({ prompt: 'initialize' }).result();
    fail = true;
    const disposable = Object.assign(adapter, {
      close: async () => {
        throw new Error('adapter cleanup failure');
      }
    });
    try {
      await expect(context.models!.generate({ prompt: 'generate' })).rejects.toBe(primary);
      expect(agent.extensionDiagnostics()).toContainEqual(
        expect.objectContaining({
          code: 'MAR_AGENT_MODEL_ADAPTER_CLEANUP_FAILED',
          sessionId: session.id,
          extensionId: 'model-cleanup'
        })
      );
    } finally {
      Reflect.deleteProperty(disposable, 'close');
    }
  });

  it('returns final-answer text without mixing commentary into independent generation', async () => {
    let context!: SessionExtensionContext;
    const { session } = await fixture(
      [
        {
          id: 'final-only',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
          }
        }
      ],
      (_request, index) =>
        index === 0
          ? answer()
          : [
              { type: 'text.delta', itemId: 'progress', phase: 'commentary', delta: 'working' },
              { type: 'text.completed', itemId: 'progress', phase: 'commentary', text: 'working' },
              { type: 'text.delta', itemId: 'answer', phase: 'final_answer', delta: 'final-only' },
              {
                type: 'text.completed',
                itemId: 'answer',
                phase: 'final_answer',
                text: 'final-only'
              },
              { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } },
              { type: 'completed', reason: 'completed' }
            ]
    );
    await session.run({ prompt: 'initialize' }).result();
    expect(await context.models!.generate({ prompt: 'generate' })).toMatchObject({
      text: 'final-only',
      usage: { inputTokens: 7, outputTokens: 3 }
    });
  });

  it('accepts explicit messages derived from an owned request snapshot without inheriting omitted messages', async () => {
    let context!: SessionExtensionContext;
    const { session, adapter } = await fixture(
      [
        {
          id: 'snapshot-edit',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
          }
        }
      ],
      () => answer()
    );
    await session.run({ prompt: 'original snapshot message' }).result();
    const snapshot = (await context.session!.captureRequest())!;
    const user = snapshot.request.messages.find(
      (message) => message.role === 'user' && message.content === 'original snapshot message'
    )!;
    expect(
      await context.models!.generate({
        requestSnapshot: snapshot,
        messages: [{ ...user, role: 'user', content: 'edited snapshot message' }]
      })
    ).toMatchObject({ outcome: 'text' });
    expect(adapter.requests[1]!.messages).toEqual([
      {
        role: 'user',
        content: 'edited snapshot message',
        metadata: adapter.requests[0]!.messages.find(
          (message) => message.content === 'original snapshot message'
        )!.metadata
      }
    ]);
    expect(
      snapshot.request.messages.some(
        (message) => message.role !== 'opaque' && message.content === 'original snapshot message'
      )
    ).toBe(true);
  });

  it('uses raw file ports in idle and model operations without creating extra model history', async () => {
    let context!: SessionExtensionContext;
    const identities: { entry: string; executionId?: string }[] = [];
    const { agent, session, adapter, home } = await fixture(
      [
        {
          id: 'native-files',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.observe('files.completed', (_fact, call) => {
              identities.push({
                entry: call.entry,
                ...(call.executionId ? { executionId: call.executionId } : {})
              });
            });
            value.tools.register({
              name: 'file_probe',
              description: 'Read raw bytes through the native file port.',
              inputSchema: { type: 'object', properties: {} },
              async execute() {
                expect(
                  Buffer.from(await value.files!.read({ path: 'probe.bin' })).toString('hex')
                ).toBe('00fffe');
                return { content: 'raw-file-ok' };
              }
            });
          }
        }
      ],
      (_request, index) => (index === 1 ? call('file_probe', {}) : answer())
    );
    await session.run({ prompt: 'initialize' }).result();
    expect(agent.extensionDiagnostics()).toEqual([]);
    expect(context.capabilities.has('files')).toBe(true);
    const history = (await context.session!.messages()).messages.map(
      ({ sourceRef: _sourceRef, ...message }) => message
    );
    await context.files!.write({ path: 'probe.bin', bytes: new Uint8Array([0, 255, 254]) });
    expect(Buffer.from(await readFile(join(home, 'probe.bin'))).toString('hex')).toBe('00fffe');
    expect(
      (await context.session!.messages()).messages.map(
        ({ sourceRef: _sourceRef, ...message }) => message
      )
    ).toEqual(history);
    expect(adapter.requests).toHaveLength(1);
    expect(identities[0]).toEqual({ entry: 'native-api' });
    const outcome = await session.run({ prompt: 'invoke file probe' }).result();
    expect(outcome.status).toBe('completed');
    expect(identities[1]).toEqual({ entry: 'direct', executionId: outcome.executionId });
    expect(
      adapter.requests.at(-1)!.messages.filter((message) => message.role === 'tool')
    ).toHaveLength(1);
  });

  it('shares installation data between Agent setup and Sessions and retains it through clear/reload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-sdk-installed-store-'));
    homes.push(directory);
    let revision = '1';
    let agentStore!: import('../../src/index.js').ExtensionStoreApi;
    const contexts = new Map<string, SessionExtensionContext>();
    const extension: AgentExtension = {
      id: 'installation-data',
      apiVersion: '1.0',
      dataDirectory: directory,
      async setup(context) {
        agentStore = context.data!.store!;
        if ((await agentStore.get({ key: 'installed' })).revision === 0)
          await agentStore.set({ key: 'installed', value: 'persistent-private-data' });
      },
      attachSession(context) {
        contexts.set(context.sessionId, context);
      }
    };
    const { agent, session, home } = await fixture(
      { resolve: async () => ({ revision, extensions: [extension] }) },
      (request) => {
        expect(JSON.stringify(request)).not.toContain('persistent-private-data');
        return answer();
      }
    );
    await session.run({ prompt: 'initialize' }).result();
    expect(await contexts.get(session.id)!.data.store!.get({ key: 'installed' })).toEqual({
      revision: 1,
      value: 'persistent-private-data'
    });
    const second = await agent.createSession({ workspace: home, title: 'Second store session' });
    await second.run({ prompt: 'separate' }).result();
    await contexts
      .get(second.id)!
      .data.store!.set({ key: 'shared', value: true, expectedRevision: 1 });
    expect(await agentStore.get({ key: 'shared' })).toEqual({ revision: 2, value: true });
    const old = contexts.get(session.id)!;
    await agent.clearSession(session.id);
    await expect(old.data.store!.set({ key: 'late', value: true })).rejects.toThrow(/RETIRED/);
    await session.run({ prompt: 'after clear' }).result();
    expect(await contexts.get(session.id)!.data.store!.get({ key: 'installed' })).toEqual({
      revision: 2,
      value: 'persistent-private-data'
    });
    revision = '2';
    const priorAgentStore = agentStore;
    await session.run({ prompt: 'reload' }).result();
    await expect(priorAgentStore.get({ key: 'shared' })).rejects.toThrow(/RETIRED/);
    expect(await agentStore.get({ key: 'shared' })).toEqual({ revision: 2, value: true });
  });

  it('transforms model events through the same boundary for main, compact, and independent generation', async () => {
    let context!: SessionExtensionContext;
    let texts = 0;
    const { session } = await fixture(
      [
        {
          id: 'event-transform',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('model.event', (event, _call, next) => {
              if (event.type === 'text.completed') {
                texts++;
                return next({ ...event, text: 'transformed' });
              }
              return next(event);
            });
          }
        }
      ],
      () => answer()
    );
    expect(await session.run({ prompt: 'main' }).result()).toMatchObject({
      status: 'completed',
      finalAnswer: 'transformed'
    });
    expect(await context.models!.generate({ prompt: 'independent' })).toMatchObject({
      text: 'transformed',
      outcome: 'text'
    });
    expect(await session.compact().result()).toMatchObject({ status: 'completed' });
    expect(texts).toBe(3);
    expect(JSON.stringify(await context.session!.messages())).toContain('transformed');
  });

  it('fails incomplete independent streams when a hook removes the real terminal event', async () => {
    let context!: SessionExtensionContext;
    let omit = false;
    const { session } = await fixture(
      [
        {
          id: 'missing-terminal',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('model.event', (event, _call, next) =>
              omit && event.type === 'completed' ? undefined : next(event)
            );
          }
        }
      ],
      () => answer()
    );
    await session.run({ prompt: 'initialize' }).result();
    omit = true;
    await expect(context.models!.generate({ prompt: 'incomplete' })).rejects.toThrow(
      /STREAM_INCOMPLETE/
    );
  });

  it('captures only actual main requests and forks their frozen context without changing main history', async () => {
    const contexts = new Map<string, SessionExtensionContext>();
    let first = true;
    const { agent, session, adapter, home } = await fixture(
      [
        {
          id: 'snapshots',
          apiVersion: '1.0',
          attachSession(value) {
            contexts.set(value.sessionId, value);
            value.hooks.intercept('model.request', async (request, _call, next) => {
              if (first) {
                first = false;
                expect(await value.session!.captureRequest()).toBeUndefined();
              }
              return next({ ...request, system: `${request.system}\nSnapshot hook.` });
            });
          }
        }
      ],
      () => answer()
    );
    expect(await session.run({ prompt: 'snapshot-base' }).result()).toMatchObject({
      status: 'completed'
    });
    const context = contexts.get(session.id)!;
    const snapshot = (await context.session!.captureRequest())!;
    expect(snapshot.request.system).toContain('Snapshot hook.');
    expect(
      snapshot.request.messages.some(
        (message) => message.role !== 'opaque' && message.content === 'snapshot-base'
      )
    ).toBe(true);
    expect(Object.isFrozen(snapshot.request.messages)).toBe(true);
    expect('onAttemptDiagnostic' in snapshot.request).toBe(false);
    await context.session!.append({ content: 'not-in-snapshot' });
    expect(
      await context.models!.generate({
        requestSnapshot: snapshot,
        prompt: 'fork-only',
        outputLimit: 19
      })
    ).toMatchObject({ outcome: 'text', text: 'done' });
    const fork = adapter.requests[1]!;
    expect(fork.system).toContain(snapshot.request.system);
    expect(fork.outputLimit).toBe(19);
    expect(fork.tools).toEqual([]);
    expect(fork.messages.some((message) => message.content === 'snapshot-base')).toBe(true);
    expect(fork.messages.some((message) => message.content === 'fork-only')).toBe(true);
    expect(fork.messages.some((message) => message.content === 'not-in-snapshot')).toBe(false);
    expect(
      (await context.session!.messages()).messages.some(
        (message) => message.role !== 'opaque' && message.content === 'fork-only'
      )
    ).toBe(false);
    expect(await context.session!.captureRequest()).toBe(snapshot);
    await session.compact().result();
    expect(await context.session!.captureRequest()).toBe(snapshot);
    await expect(context.models!.generate({ requestSnapshot: { ...snapshot } })).rejects.toThrow(
      /SNAPSHOT_INVALID/
    );
    const other = await agent.createSession({ workspace: home, title: 'Other snapshot' });
    await other.run({ prompt: 'other' }).result();
    await expect(
      contexts.get(other.id)!.models!.generate({ requestSnapshot: snapshot })
    ).rejects.toThrow(/SNAPSHOT_INVALID/);
    await agent.clearSession(session.id);
    const old = snapshot;
    await session.run({ prompt: 'fresh' }).result();
    const current = contexts.get(session.id)!;
    await expect(current.models!.generate({ requestSnapshot: old })).rejects.toThrow(
      /SNAPSHOT_INVALID/
    );
    expect(await current.session!.captureRequest()).not.toBe(old);
  });

  it('cancels accepted work on explicit execution cancellation without later writes', async () => {
    let context!: SessionExtensionContext;
    let accepted!: () => void;
    const ready = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { session } = await fixture(
      [
        {
          id: 'cancel-input',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('model.request', async (request, _call, next) => {
              await value.session!.append({ content: 'cancelled-note' });
              accepted();
              await gate;
              return next(request);
            });
          }
        }
      ],
      () => answer()
    );
    const handle = session.run({ prompt: 'cancel queued input' });
    await ready;
    handle.cancel();
    release();
    expect(await handle.result()).toMatchObject({ status: 'cancelled' });
    expect((await context.session!.inspect()).operations).toContainEqual(
      expect.objectContaining({ kind: 'append', status: 'cancelled' })
    );
    expect(
      (await context.session!.messages()).messages.some(
        (message) => message.role !== 'opaque' && message.content === 'cancelled-note'
      )
    ).toBe(false);
  });

  it('reports failed queued hooks, retains a successful write, and never silently replays it', async () => {
    let context!: SessionExtensionContext;
    const { agent, session } = await fixture(
      [
        {
          id: 'failed-append',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('session.append', async (input, _call, next) => {
              await next(input);
              throw new Error('after write');
            });
            value.tools.register({
              name: 'failed_append',
              description: 'Append once',
              inputSchema: { type: 'object' },
              async execute() {
                await value.session!.append({ content: 'write-once' });
                return { content: 'queued' };
              }
            });
          }
        }
      ],
      (_request, index) => (index === 0 ? call('failed_append', {}) : answer())
    );
    expect(await session.run({ prompt: 'write once' }).result()).toMatchObject({
      status: 'completed'
    });
    expect((await context.session!.inspect()).operations).toContainEqual(
      expect.objectContaining({ kind: 'append', status: 'failed', changed: true })
    );
    expect(
      (await context.session!.messages()).messages.filter(
        (message) => message.role !== 'opaque' && message.content === 'write-once'
      )
    ).toHaveLength(1);
    expect(agent.extensionDiagnostics()).toContainEqual(
      expect.objectContaining({ code: 'MAR_AGENT_SESSION_INPUT_FAILED' })
    );
  });

  it('uses one compact hook for SDK, idle native, and automatic compaction, including actual request transforms', async () => {
    let context!: SessionExtensionContext;
    let compacts = 0;
    const { session, adapter } = await fixture(
      [
        {
          id: 'all-compact',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('session.compact', async (input, _call, next) => {
              compacts++;
              await expect(value.session!.compact()).rejects.toMatchObject({
                code: 'MAR_AGENT_COMPACT_REENTRANT'
              });
              return next({ focus: `${input.focus ?? 'automatic'}-hook-focus` });
            });
            value.hooks.intercept('model.request', (request, _call, next) =>
              next({ ...request, system: `${request.system}\nEvery request transformed.` })
            );
          }
        }
      ],
      (request, index) => {
        expect(request.system).toContain('Every request transformed.');
        return index === 0
          ? [
              ...answer().slice(0, 1),
              {
                type: 'usage',
                usage: { inputTokens: 190_000, contextInputTokens: 190_000, outputTokens: 1 }
              },
              { type: 'completed', reason: 'completed' }
            ]
          : answer();
      }
    );
    await session.run({ prompt: 'initialize' }).result();
    const automatic = await session.run({ prompt: 'trigger automatic' }).result();
    expect(automatic, JSON.stringify(automatic)).toMatchObject({ status: 'completed' });
    expect(compacts).toBe(1);
    expect(
      adapter.requests.some((request) =>
        JSON.stringify(request.messages).includes('automatic-hook-focus')
      )
    ).toBe(true);
    expect(await session.compact({ prompt: 'manual' }).result()).toMatchObject({
      status: 'completed'
    });
    expect(compacts).toBe(2);
    expect(await context.session!.compact({ focus: 'idle' })).toMatchObject({
      status: 'completed'
    });
    expect(compacts).toBe(3);
    expect(
      adapter.requests.some((request) =>
        JSON.stringify(request.messages).includes('manual-hook-focus')
      )
    ).toBe(true);
    expect(
      adapter.requests.some((request) =>
        JSON.stringify(request.messages).includes('idle-hook-focus')
      )
    ).toBe(true);
  });

  it('drains input accepted by the final request hook even when the model has no further tool step', async () => {
    let context!: SessionExtensionContext;
    let accepted = false;
    const { session } = await fixture(
      [
        {
          id: 'final-input',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('model.request', async (request, _call, next) => {
              if (!accepted) {
                accepted = true;
                expect((await value.session!.append({ content: 'final-note' })).status).toBe(
                  'queued'
                );
              }
              return next(request);
            });
          }
        }
      ],
      () => answer()
    );
    expect(await session.run({ prompt: 'no tools' }).result()).toMatchObject({
      status: 'completed'
    });
    expect((await context.session!.inspect()).operations).toContainEqual(
      expect.objectContaining({ kind: 'append', status: 'committed' })
    );
    expect(
      (await context.session!.messages()).messages.some(
        (message) => message.role !== 'opaque' && message.content === 'final-note'
      )
    ).toBe(true);
  });

  it('writes checkpoint from an active tool using its existing Session writer', async () => {
    let context!: SessionExtensionContext;
    const { session } = await fixture(
      [
        {
          id: 'active-checkpoint',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.tools.register({
              name: 'save_checkpoint',
              description: 'Save checkpoint',
              inputSchema: { type: 'object' },
              async execute() {
                await value.data.checkpoint!.set({
                  key: 'active',
                  value: true,
                  expectedRevision: 0
                });
                return { content: 'saved' };
              }
            });
          }
        }
      ],
      (_request, index) => (index === 0 ? call('save_checkpoint', {}) : answer())
    );
    expect(await session.run({ prompt: 'save' }).result()).toMatchObject({ status: 'completed' });
    expect(await context.data.checkpoint!.get({ key: 'active' })).toEqual({
      revision: 1,
      value: true
    });
  });

  it('commits queued append after the complete tool pair and resumes submit in the same execution', async () => {
    let context!: SessionExtensionContext;
    let appendStatus = '';
    let submitStatus = '';
    let appended = 0;
    const { session, adapter } = await fixture(
      [
        {
          id: 'session-input',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('session.append', async (input, _call, next) => {
              appended++;
              return next({ ...input, content: `${input.content}-hook` });
            });
            value.tools.register({
              name: 'enqueue',
              description: 'Queue session input',
              inputSchema: { type: 'object' },
              async execute() {
                appendStatus = (await value.session!.append({ content: 'queued-note' })).status;
                submitStatus = (
                  await value.session!.submit({ text: 'extension-follow-up', provenance: 'test' })
                ).status;
                expect(appended).toBe(0);
                return { content: 'tool-done' };
              }
            });
          }
        }
      ],
      (request, index) => {
        if (index === 0) return call('enqueue', {});
        const note = request.messages.findIndex(
          (message) => message.content === 'queued-note-hook'
        );
        const result = request.messages.findIndex((message) => message.role === 'tool');
        expect(result).toBeGreaterThan(-1);
        expect(note).toBeGreaterThan(result);
        expect(request.messages.some((message) => message.content === 'extension-follow-up')).toBe(
          true
        );
        return answer();
      }
    );
    const handle = session.run({ prompt: 'queue input' });
    const outcome = await handle.result();
    expect(
      outcome,
      JSON.stringify({
        outcome,
        operations: await context.session!.inspect(),
        requests: adapter.requests.map((request) => request.messages)
      })
    ).toMatchObject({ status: 'completed' });
    expect(appendStatus).toBe('queued');
    expect(submitStatus).toBe('accepted');
    expect(appended).toBe(1);
    expect(adapter.requests).toHaveLength(2);
    const operations = (await context.session!.inspect()).operations;
    expect(operations).toEqual([
      expect.objectContaining({
        kind: 'append',
        status: 'committed',
        executionId: handle.executionId,
        extensionId: 'session-input'
      }),
      expect.objectContaining({
        kind: 'submit',
        status: 'completed',
        executionId: handle.executionId
      })
    ]);
    const first = await context.session!.messages({ limit: 1 });
    expect(first.messages).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    const second = await context.session!.messages({ cursor: first.nextCursor!, limit: 100 });
    expect(
      second.messages.some(
        (message) => message.role !== 'opaque' && message.content === 'extension-follow-up'
      )
    ).toBe(true);
    await expect(context.session!.messages({ cursor: '-1' })).rejects.toThrow(/INVALID/);
  });

  it('commits idle append without inventing an execution and launches idle submit through the existing SDK', async () => {
    let context!: SessionExtensionContext;
    const { agent, session, adapter } = await fixture(
      [
        {
          id: 'idle-input',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
          }
        }
      ],
      () => answer()
    );
    await session.run({ prompt: 'initialize' }).result();
    const receipt = await context.session!.append({ content: 'idle-note', attribution: 'test' });
    expect(receipt).toMatchObject({ kind: 'append', status: 'committed', changed: true });
    expect(receipt.executionId).toBeUndefined();
    expect(adapter.requests).toHaveLength(1);
    const idleMessages = await context.session!.messages();
    expect(
      idleMessages.messages.some(
        (message) => message.role !== 'opaque' && message.content === 'idle-note'
      ),
      JSON.stringify(idleMessages)
    ).toBe(true);
    const submitted = await context.session!.submit({ text: 'automatic-turn', provenance: 'test' });
    expect(submitted.status).toBe('accepted');
    await expect
      .poll(
        async () =>
          (await context.session!.inspect()).operations.find(
            (entry) => entry.operationId === submitted.operationId
          )?.status
      )
      .toBe('completed');
    expect(adapter.requests).toHaveLength(2);
    expect(
      adapter.requests[1]!.messages.some((message) => message.content === 'automatic-turn')
    ).toBe(true);
    await agent.clearSession(session.id);
    await expect(context.session!.append({ content: 'late' })).rejects.toThrow(/RETIRED/);
    expect(await session.run({ prompt: 'after-clear' }).result()).toMatchObject({
      status: 'completed'
    });
    expect(
      (await context.session!.messages()).messages.some(
        (message) => message.role !== 'opaque' && message.content === 'idle-note'
      )
    ).toBe(false);
  });

  it('executes compact-append-compact independently with each focus and no compact hook self-wait', async () => {
    let context!: SessionExtensionContext;
    let compacts = 0;
    const receipts: string[] = [];
    const { session, adapter } = await fixture(
      [
        {
          id: 'compact-input',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('session.compact', async (input, _call, next) => {
              compacts++;
              await expect(value.session!.compact({ focus: 'nested' })).rejects.toMatchObject({
                code: 'MAR_AGENT_COMPACT_REENTRANT'
              });
              return next(input);
            });
            value.tools.register({
              name: 'queue_compacts',
              description: 'Queue compaction',
              inputSchema: { type: 'object' },
              async execute() {
                receipts.push((await value.session!.compact({ focus: 'first-focus' })).status);
                receipts.push(
                  (await value.session!.append({ content: 'between-compacts' })).status
                );
                receipts.push((await value.session!.compact({ focus: 'second-focus' })).status);
                return { content: 'queued' };
              }
            });
          }
        }
      ],
      (request, index) => (index === 1 ? call('queue_compacts', {}) : answer())
    );
    await session.run({ prompt: 'initialize' }).result();
    expect(await session.run({ prompt: 'compact sequence' }).result()).toMatchObject({
      status: 'completed'
    });
    expect(receipts).toEqual(['queued', 'queued', 'queued']);
    expect(compacts).toBe(2);
    expect(
      adapter.requests.some((request) => JSON.stringify(request.messages).includes('first-focus'))
    ).toBe(true);
    expect(
      adapter.requests.some((request) => JSON.stringify(request.messages).includes('second-focus'))
    ).toBe(true);
    const compactOperations = (await context.session!.inspect()).operations;
    expect(
      compactOperations.map((entry) => entry.status),
      JSON.stringify(compactOperations)
    ).toEqual(['completed', 'committed', 'completed']);
  });

  it('disables a failed extension, continues unrelated work, and exposes real bounded diagnostics', async () => {
    const { agent, session } = await fixture(
      [
        {
          id: 'broken',
          apiVersion: '1.0',
          setup: () => {
            throw new Error('private initialization value');
          }
        },
        {
          id: 'working',
          apiVersion: '1.0',
          attachSession: (context) => {
            context.prompts.register({ id: 'working', text: 'surviving extension' });
          }
        }
      ],
      (request) => {
        expect(effectiveInstructions(request)).toContain('surviving extension');
        return answer();
      }
    );
    const outcome = await session.run({ prompt: 'continue' }).result();
    expect(
      outcome.status,
      JSON.stringify({ outcome, diagnostics: agent.extensionDiagnostics() })
    ).toBe('completed');
    expect(agent.extensionDiagnostics()).toContainEqual(
      expect.objectContaining({
        extensionId: 'broken',
        code: 'MAR_AGENT_EXTENSION_INITIALIZATION_FAILED'
      })
    );
    expect(JSON.stringify(agent.extensionDiagnostics())).not.toContain(
      'private initialization value'
    );
  });

  it('persists namespaced checkpoints atomically across reload, isolates state, and invalidates cleared owners', async () => {
    let revision = '1';
    const contexts = new Map<string, SessionExtensionContext>();
    const restored: number[] = [];
    const extension: AgentExtension = {
      id: 'data',
      apiVersion: '1.0',
      async attachSession(context) {
        contexts.set(context.sessionId, context);
        restored.push((await context.data.checkpoint!.get({ key: 'count' })).revision);
      }
    };
    const { agent, session, home } = await fixture(
      { resolve: async () => ({ revision, extensions: [extension] }) },
      (request) => {
        expect(JSON.stringify(request.messages)).not.toContain('checkpoint-private');
        return answer();
      }
    );
    await expect(session.run({ prompt: 'initialize' }).result()).resolves.toMatchObject({
      status: 'completed'
    });
    const first = contexts.get(session.id)!;
    const changed: number[] = [];
    first.data.state.watch((change) => {
      changed.push(change.revision);
    });
    await first.data.state.write('local', { count: 1 });
    expect(await first.data.state.read('local')).toEqual({ count: 1 });
    expect(changed).toEqual([1]);
    const results = await Promise.allSettled([
      first.data.checkpoint!.set({
        key: 'count',
        value: { marker: 'checkpoint-private' },
        expectedRevision: 0
      }),
      first.data.checkpoint!.set({ key: 'count', value: 2, expectedRevision: 0 })
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await first.data.checkpoint!.get({ key: 'count' })).toEqual({
      revision: 1,
      value: { marker: 'checkpoint-private' }
    });
    await expect(first.data.checkpoint!.set({ key: 'count', value: Number.NaN })).rejects.toThrow(
      /DATA_INVALID/
    );
    expect((await first.data.checkpoint!.get({ key: 'count' })).revision).toBe(1);
    const second = await agent.createSession({ workspace: home, title: 'Separate data' });
    await second.run({ prompt: 'separate' }).result();
    expect(await contexts.get(second.id)!.data.state.read('local')).toBeUndefined();
    expect(await contexts.get(second.id)!.data.checkpoint!.get({ key: 'count' })).toEqual({
      revision: 0
    });
    revision = '2';
    await expect(session.run({ prompt: 'reload' }).result()).resolves.toMatchObject({
      status: 'completed'
    });
    expect(restored).toEqual([0, 0, 1]);
    expect(await contexts.get(session.id)!.data.state.read('local')).toBeUndefined();
    await expect(first.data.checkpoint!.get({ key: 'count' })).rejects.toThrow(/RETIRED/);
    const current = contexts.get(session.id)!;
    expect(await current.data.checkpoint!.delete({ key: 'count', expectedRevision: 1 })).toEqual({
      revision: 2
    });
    await agent.clearSession(session.id);
    await expect(current.data.checkpoint!.set({ key: 'late', value: true })).rejects.toThrow(
      /RETIRED/
    );
    const afterClear = await session.run({ prompt: 'after clear' }).result();
    expect(afterClear.status, JSON.stringify(afterClear)).toBe('completed');
    expect(await contexts.get(session.id)!.data.checkpoint!.get({ key: 'count' })).toEqual({
      revision: 0
    });
  });

  it('runs independent generation while idle with real usage and an output cap, without creating history', async () => {
    let context!: SessionExtensionContext;
    const { session, adapter } = await fixture(
      [
        {
          id: 'generation',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('model.request', async (request, _call, next) => {
              expect('onAttemptDiagnostic' in request).toBe(false);
              return next({ ...request, system: `${request.system}\nNeutral request hook.` });
            });
            value.commands.register({
              name: 'generate',
              handler: () => value.models!.generate({ prompt: 'independent-only', outputLimit: 17 })
            });
          }
        }
      ],
      (request, index) => {
        expect(request.system).toContain('Neutral request hook.');
        if (index === 1) {
          expect(request.outputLimit).toBe(17);
          expect(request.tools).toEqual([]);
          expect(request.allowTools).toBe(false);
          return [
            { type: 'text.delta', itemId: 'gen', phase: 'final_answer', delta: 'partial' },
            { type: 'text.completed', itemId: 'gen', text: 'generated' },
            { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } },
            { type: 'completed', reason: 'completed' }
          ];
        }
        expect(request.messages.some((message) => message.content === 'independent-only')).toBe(
          false
        );
        return answer();
      }
    );
    await session.run({ prompt: 'initialize' }).result();
    expect(JSON.stringify(context.models!.list())).not.toContain('example.test');
    expect(await context.commands.run({ name: 'generate' })).toEqual({
      outcome: 'text',
      text: 'generated',
      stopReason: 'completed',
      usage: { inputTokens: 12, outputTokens: 3 }
    });
    await session.run({ prompt: 'continue' }).result();
    expect(adapter.requests).toHaveLength(3);
  });

  it('distinguishes empty independent output and rejects invalid limits without calling the model', async () => {
    let context!: SessionExtensionContext;
    const { session, adapter } = await fixture(
      [
        {
          id: 'empty',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
          }
        }
      ],
      (_request, index) => (index ? [{ type: 'completed', reason: 'completed' }] : answer())
    );
    await session.run({ prompt: 'initialize' }).result();
    await expect(context.models!.generate({ prompt: 'empty', outputLimit: 1 })).resolves.toEqual({
      outcome: 'empty',
      text: '',
      stopReason: 'completed'
    });
    await expect(context.models!.generate({ prompt: 'invalid', outputLimit: 0 })).rejects.toThrow(
      /MODEL_REQUEST_INVALID/
    );
    await expect(
      context.models!.generate({ prompt: 'missing', modelId: 'missing' })
    ).rejects.toThrow(/MODEL_DISABLED/);
    expect(adapter.requests).toHaveLength(2);
  });

  it('projects prompts and tools, invokes captured Host tools, and publishes one outer history result', async () => {
    const facts: string[] = [];
    const entries: string[] = [];
    const extension: AgentExtension = {
      id: 'workflow',
      apiVersion: '1.0',
      attachSession(context) {
        context.prompts.register({ id: 'policy', text: 'Extension policy marker.' });
        context.hooks.intercept('prompt.compose', async (input, _call, next) =>
          next(`${input}\nHook marker.`)
        );
        context.hooks.observe('tool.completed', (fact) => {
          facts.push(fact.name);
        });
        context.tools.register({
          name: 'workflow',
          description: 'Inspect a file',
          inputSchema: { type: 'object' },
          async execute(_input, operation) {
            entries.push(operation.entry);
            const output = await context.tools.invoke({
              name: 'read',
              arguments: { reads: [{ path: 'input.txt' }] }
            });
            context.tools.register({
              name: 'next_step',
              description: 'Next step',
              inputSchema: { type: 'object' },
              execute: () => ({ content: 'next' })
            });
            return { content: output.content, data: { nested: true } };
          }
        });
      }
    };
    const { session, adapter } = await fixture([extension], (request, index) => {
      expect(request.system).toContain('Extension policy marker.');
      expect(request.system).toContain('Hook marker.');
      if (!index) {
        expect(request.tools.some((tool) => tool.name === 'workflow')).toBe(true);
        expect(request.tools.some((tool) => tool.name === 'next_step')).toBe(false);
        return call('workflow', {});
      }
      expect(request.tools.some((tool) => tool.name === 'next_step')).toBe(true);
      expect(request.messages.filter((message) => message.role === 'tool')).toHaveLength(1);
      expect(request.messages.at(-1)?.content).toContain('extension-data');
      return answer();
    });
    await expect(session.run({ prompt: 'Run workflow' }).result()).resolves.toMatchObject({
      status: 'completed',
      finalAnswer: 'done'
    });
    expect(adapter.requests).toHaveLength(2);
    expect(facts).toEqual(['read', 'workflow']);
    expect(entries).toEqual(['direct']);
  });

  it('reuses instances and changes the whole generation only at the next user admission', async () => {
    let revision = '1';
    const attached: string[] = [];
    const released: string[] = [];
    const contexts: SessionExtensionContext[] = [];
    const { agent, session, home } = await fixture(
      {
        resolve: async () => ({
          revision,
          extensions: [
            {
              id: 'version',
              apiVersion: '1.0',
              attachSession(context) {
                const version = revision;
                contexts.push(context);
                attached.push(`${version}:${context.sessionId}`);
                context.prompts.register({ id: 'version', text: `Version ${version}` });
                return () => {
                  released.push(version);
                };
              }
            }
          ]
        })
      },
      () => answer()
    );
    await session.run({ prompt: 'one' }).result();
    await session.run({ prompt: 'two' }).result();
    expect(attached).toHaveLength(1);
    const second = await agent.createSession({ workspace: home, title: 'Second' });
    await second.run({ prompt: 'separate' }).result();
    expect(attached).toHaveLength(2);
    expect(contexts[0]).not.toBe(contexts[1]);
    revision = '2';
    await session.run({ prompt: 'new generation' }).result();
    expect(attached).toHaveLength(3);
    expect(released).toEqual(['1', '1']);
    await expect(contexts[0]!.prompts.compose('old')).rejects.toThrow(/RETIRED/);
  });

  it('does not send a model request when a strict extension cannot initialize', async () => {
    const { session, adapter } = await fixture(
      [
        {
          id: 'strict',
          apiVersion: '1.0',
          failurePolicy: 'fail-composition',
          attachSession() {
            throw new Error('private failure');
          }
        }
      ],
      () => answer()
    );
    for (let index = 0; index < 2; index++)
      await expect(session.run({ prompt: 'fail' }).result()).resolves.toMatchObject({
        status: 'failed'
      });
    expect(adapter.requests).toHaveLength(0);
  });

  it('routes Code Mode through the same tool binding with the programmatic entry', async () => {
    const entries: string[] = [];
    const { session } = await fixture(
      [
        {
          id: 'code',
          apiVersion: '1.0',
          attachSession(context) {
            context.tools.register({
              name: 'native_echo',
              description: 'Echo',
              inputSchema: { type: 'object' },
              allowedCallers: ['programmatic'],
              execute(_input, operation) {
                entries.push(operation.entry);
                return { content: 'code-echo', data: { echo: true } };
              }
            });
          }
        }
      ],
      (_request, index) =>
        !index
          ? call('code_exec', { code: 'observe.result(await tools.native_echo({}));' })
          : answer(),
      true
    );
    await expect(session.run({ prompt: 'use code' }).result()).resolves.toMatchObject({
      status: 'completed'
    });
    expect(entries).toEqual(['programmatic']);
  });
});
