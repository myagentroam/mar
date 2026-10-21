import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreAgentsApi, CoreSessionExtensionContext } from '../../src/index.js';
import type { CoreRuntimeExtension } from '../../src/agent-core/extensions/contracts.js';
import { JsonlSessionStore } from '../../src/agent-core/session/store/index.js';
import { createMarAgentWithAdapter } from '../../src/agent-core/sdk/agent.js';
import { LocalAgentHost } from '../../src/index.js';
import {
  fixture,
  answer,
  call,
  agents,
  cleanupCoreFixtures
} from './support/core-extension-fixture.js';

const mailboxGates: Array<() => void> = [];
afterEach(async () => {
  for (const release of mailboxGates.splice(0)) release();
  await cleanupCoreFixtures();
});

async function nativeFixture(extra?: (context: CoreSessionExtensionContext) => void) {
  let api!: CoreAgentsApi;
  let context!: CoreSessionExtensionContext;
  const extension: CoreRuntimeExtension = {
    id: 'native-agents',
    apiVersion: '1.0',
    attachSession: (current) => {
      if (current.agents && !api) {
        api = current.agents;
        context = current;
        extra?.(current);
      }
    }
  };
  const f = await fixture([extension], () => answer(), false, true);
  expect((await f.session.run({ prompt: 'initialize' }).result()).status).toBe('completed');
  expect(api).toBeDefined();
  return { ...f, api, context, extension };
}

async function mailboxFixture() {
  let receiver!: CoreAgentsApi;
  let sender!: CoreAgentsApi;
  let child!: CoreSessionExtensionContext;
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  mailboxGates.push(release);
  const f = await fixture(
    [
      {
        id: 'receiver',
        apiVersion: '1.0',
        attachSession: (context) => {
          if (context.agents) receiver = context.agents;
          else {
            child = context;
            context.hooks.intercept('model.request', async (request, _call, next) => {
              entered();
              await gate;
              return next(request);
            });
          }
        }
      },
      {
        id: 'sender',
        apiVersion: '1.0',
        attachSession: (context) => {
          if (context.agents) sender = context.agents;
        }
      }
    ],
    () => answer(),
    false,
    true
  );
  await f.session.run({ prompt: 'initialize' }).result();
  return { ...f, receiver, sender, ready, release, child: () => child };
}

describe('native extension Agent API', () => {
  it('cancels an uncommitted native mailbox input without cancelling the receiving Turn', async () => {
    const f = await mailboxFixture();
    const target = await f.receiver.spawn({ prompt: 'receiver task' });
    if (!('agentId' in target)) throw new Error('Expected an actual child task.');
    await f.ready;
    const signal = new AbortController();
    await f.sender.message({
      agentId: target.agentId,
      message: 'cancelled mailbox',
      signal: signal.signal
    });
    signal.abort();
    await vi.waitFor(async () =>
      expect(await f.sender.inspect({ agentId: target.agentId })).toMatchObject({
        status: 'running',
        deliveryStatus: 'cancelled'
      })
    );
    expect((await f.child().session!.inspect()).operations).toContainEqual(
      expect.objectContaining({
        ownerInstanceId: expect.any(String),
        extensionId: 'sender',
        status: 'cancelled'
      })
    );
    f.release();
    expect(await f.receiver.wait({ agentId: target.agentId, waitMs: 1000 })).toHaveProperty(
      'status',
      'completed'
    );
    const store = await JsonlSessionStore.open(f.home);
    expect(
      (await store.read(target.agentId)).some(
        (record) => (record.payload as { prompt?: string }).prompt === 'cancelled mailbox'
      )
    ).toBe(false);
    expect(JSON.stringify(f.adapter.requests)).not.toContain('cancelled mailbox');
  });

  it('commits native mailbox provenance and preserves applied facts after source cancellation', async () => {
    const f = await mailboxFixture();
    const target = await f.receiver.spawn({ prompt: 'receiver task' });
    if (!('agentId' in target)) throw new Error('Expected an actual child task.');
    await f.ready;
    const signal = new AbortController();
    const receipt = await f.sender.message({
      agentId: target.agentId,
      message: 'committed mailbox',
      signal: signal.signal
    });
    expect(receipt.deliveryStatus).toBe('accepted');
    f.release();
    expect(await f.receiver.wait({ agentId: target.agentId, waitMs: 1000 })).toHaveProperty(
      'status',
      'completed'
    );
    signal.abort();
    expect(await f.sender.inspect({ agentId: target.agentId })).toHaveProperty(
      'deliveryStatus',
      'applied'
    );
    const store = await JsonlSessionStore.open(f.home);
    const input = (await store.read(target.agentId)).find(
      (record) =>
        record.type === 'extension.input' &&
        (record.payload as { prompt?: string }).prompt === 'committed mailbox'
    );
    expect(input?.payload).toMatchObject({
      messageId: receipt.messageId,
      source: {
        extensionId: 'sender',
        ownerInstanceId: expect.any(String),
        operationId: expect.any(String)
      }
    });
    await f.agent.dispose();
    let restoredApi!: CoreAgentsApi;
    const replay = await createMarAgentWithAdapter({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: f.home, workspace: f.home }),
      models: [f.adapter.configuration],
      adapterFactory: () => f.adapter,
      runtimeExtensions: [
        {
          id: 'restored-reader',
          apiVersion: '1.0',
          attachSession: (context) => {
            if (context.agents) restoredApi = context.agents;
          }
        }
      ]
    });
    agents.push(replay);
    const parent = await replay.openSession(f.session.id);
    await parent.run({ prompt: 'restore native receipt' }).result();
    expect(await restoredApi.inspect({ agentId: target.agentId })).toMatchObject({
      messageId: receipt.messageId,
      deliveryStatus: 'applied'
    });
  });

  it('cancels a native child through its accepted source signal and does not emit a late request', async () => {
    const f = await mailboxFixture();
    const signal = new AbortController();
    const target = await f.receiver.spawn({ prompt: 'cancel source', signal: signal.signal });
    if (!('agentId' in target)) throw new Error('Expected an actual child task.');
    await f.ready;
    signal.abort();
    f.release();
    expect(await f.receiver.wait({ agentId: target.agentId, waitMs: 1000 })).toHaveProperty(
      'status',
      'cancelled'
    );
    expect(f.adapter.requests).toHaveLength(1);
    expect(await f.session.run({ prompt: 'unrelated parent still works' }).result()).toHaveProperty(
      'status',
      'completed'
    );
  });

  it('projects child capabilities truthfully and isolates unmet Agent requirements', async () => {
    let root!: CoreSessionExtensionContext;
    let child!: CoreSessionExtensionContext;
    const requiredAttachments: string[] = [];
    const f = await fixture(
      [
        {
          id: 'probe',
          apiVersion: '1.0',
          attachSession(value) {
            if (value.agents) root = value;
            else child = value;
          }
        },
        {
          id: 'requires-agents',
          apiVersion: '1.0',
          requires: [{ id: 'agents' }],
          attachSession(value) {
            requiredAttachments.push(value.sessionId);
          }
        }
      ],
      answer,
      false,
      true
    );
    expect(await f.session.run({ prompt: 'initialize' }).result()).toHaveProperty(
      'status',
      'completed'
    );
    const spawned = await root.agents!.spawn({ prompt: 'child capabilities', background: false });
    if (!('agentId' in spawned)) throw new Error('Expected an actual child task.');
    expect(spawned.status).toBe('completed');
    expect(requiredAttachments).toEqual([f.session.id]);
    expect(child.agents).toBeUndefined();
    expect(child.capabilities.has('agents')).toBe(false);
    expect(child.capabilities.has('session')).toBe(true);
    expect(child.capabilities.has('models')).toBe(true);
    expect(child.session).toBeDefined();
    expect(child.models).toBeDefined();
    for (const name of ['agent_start', 'agent_wait', 'agent_message', 'agent_cancel']) {
      expect(child.tools.catalog().some((tool) => tool.definition.name === name)).toBe(false);
      expect((await child.tools.check({ name, arguments: {} })).available).toBe(false);
      await expect(child.tools.invoke({ name, arguments: {} })).rejects.toMatchObject({
        code: 'MAR_AGENT_TOOL_NOT_AVAILABLE'
      });
    }
    expect(f.agent.extensionDiagnostics()).toContainEqual(
      expect.objectContaining({
        extensionId: 'requires-agents',
        sessionId: spawned.agentId,
        code: 'MAR_AGENT_EXTENSION_DEPENDENCY_MISSING'
      })
    );
    expect(await root.agents!.inspect({ agentId: spawned.agentId })).toHaveProperty(
      'status',
      'completed'
    );
  });

  it('starts a real child through the SDK while idle and records only real provenance', async () => {
    const { api, home } = await nativeFixture();
    expect(api).not.toHaveProperty('register');
    expect(api).not.toHaveProperty('definitions');
    const spawned = await api.spawn({ prompt: 'inspect this task' });
    if (!('agentId' in spawned)) throw new Error('Expected an actual child task.');
    expect(spawned.status === 'queued' || spawned.status === 'running').toBe(true);
    const result = await api.wait({ agentId: spawned.agentId, waitMs: 1000 });
    expect(result).toMatchObject({
      agentId: spawned.agentId,
      status: 'completed',
      summary: 'done'
    });
    expect(await api.list()).toContainEqual(expect.objectContaining({ agentId: spawned.agentId }));
    const store = await JsonlSessionStore.open(home);
    expect((await store.getSession(spawned.agentId)).source).toMatchObject({
      type: 'subagent',
      extensionId: 'native-agents'
    });
    expect((await store.getSession(spawned.agentId)).source).not.toHaveProperty(
      'parentExecutionId'
    );
    expect((await store.getSession(spawned.agentId)).source).toHaveProperty('parentOperationId');
    await api.message({ agentId: spawned.agentId, message: 'native continuation' });
    await api.wait({ agentId: spawned.agentId, waitMs: 1000 });
    const records = await store.read(spawned.agentId);
    const inputs = records.filter((record) => record.type === 'extension.input');
    expect(inputs).toHaveLength(2);
    expect(inputs.map((record) => record.payload)).toEqual([
      expect.objectContaining({
        prompt: 'inspect this task',
        source: expect.objectContaining({
          extensionId: 'native-agents',
          operationId: expect.any(String),
          ownerInstanceId: expect.any(String)
        })
      }),
      expect.objectContaining({
        prompt: 'native continuation',
        source: expect.objectContaining({
          extensionId: 'native-agents',
          operationId: expect.any(String),
          ownerInstanceId: expect.any(String)
        })
      })
    ]);
    expect(records.filter((record) => record.type === 'turn.user')).toHaveLength(0);
  });

  it.each([false, true])(
    'keeps native child input provenance inside an active parent (Code Mode: %s)',
    async (codeMode) => {
      let api!: CoreAgentsApi;
      const extension: CoreRuntimeExtension = {
        id: 'active-native',
        apiVersion: '1.0',
        attachSession: (context) => {
          if (!context.agents) return;
          api = context.agents;
          context.tools.register({
            name: 'delegate_native',
            description: 'Delegate through the native API',
            inputSchema: { type: 'object', properties: {} },
            execute: async () => {
              const child = await api.spawn({ prompt: 'ACTIVE_NATIVE_INPUT', background: false });
              if (!('agentId' in child)) throw new Error('Expected an actual child task.');
              expect(child.status).toBe('completed');
              return { content: child.agentId };
            }
          });
        }
      };
      const f = await fixture(
        [extension],
        (_request, index) =>
          index === 0
            ? codeMode
              ? call('code_exec', { code: 'observe.text(await tools.delegate_native({}));' })
              : call('delegate_native', {})
            : answer(),
        codeMode,
        true
      );
      const parent = f.session.run({ prompt: 'delegate' });
      expect(await parent.result()).toHaveProperty('status', 'completed');
      const child = (await api.list())[0]!;
      const store = await JsonlSessionStore.open(f.home);
      expect((await store.getSession(child.agentId)).source).toMatchObject({
        parentExecutionId: parent.executionId,
        parentOperationId: expect.any(String),
        extensionId: 'active-native',
        ownerInstanceId: expect.any(String)
      });
      const records = await store.read(child.agentId);
      expect(records.filter((record) => record.type === 'extension.input')).toHaveLength(1);
      expect(records.find((record) => record.type === 'extension.input')?.payload).toMatchObject({
        prompt: 'ACTIVE_NATIVE_INPUT',
        source: { extensionId: 'active-native', operationId: expect.any(String) }
      });
      expect(records.some((record) => record.type === 'turn.user')).toBe(false);
    }
  );

  it('observes original spawn facts when an interceptor wraps the returned state', async () => {
    const facts: unknown[] = [];
    const { api } = await nativeFixture((context) => {
      context.hooks.observe('agent.completed', (fact) => {
        facts.push(fact);
      });
      context.hooks.intercept('agent.spawn', async (input, _call, next) => ({
        ...(await next(input)),
        description: 'wrapped'
      }));
    });
    const spawned = await api.spawn({ description: 'real', prompt: 'work' });
    if (!('agentId' in spawned)) throw new Error('Expected an actual child task.');
    expect(spawned.description).toBe('wrapped');
    expect(await api.inspect({ agentId: spawned.agentId })).toHaveProperty('description', 'real');
    expect(facts).toContainEqual(
      expect.objectContaining({ operation: 'spawn', agentId: spawned.agentId })
    );
    expect(facts.every((fact) => !('prompt' in (fact as Record<string, unknown>)))).toBe(true);
  });

  it('rejects malformed input and unsupported models without leaving failed children', async () => {
    const { api } = await nativeFixture();
    for (const input of [
      { prompt: '' },
      { prompt: 'x', description: '' },
      { prompt: 'x', modelId: '' },
      { prompt: 'x', role: 'unknown' }
    ])
      await expect(api.spawn(input as never)).rejects.toMatchObject({
        code: 'MAR_AGENT_EXTENSION_AGENT_INPUT_INVALID'
      });
    await expect(api.spawn({ prompt: 'x', modelId: 'missing' })).rejects.toMatchObject({
      code: 'MAR_AGENT_SUBAGENT_MODEL_UNAVAILABLE'
    });
    expect(await api.list()).toHaveLength(0);
    for (const invalid of [null, [], { agentId: '' }]) {
      await expect(api.inspect(invalid as never)).rejects.toMatchObject({
        code: 'MAR_AGENT_EXTENSION_AGENT_INPUT_INVALID'
      });
      await expect(api.cancel(invalid as never)).rejects.toMatchObject({
        code: 'MAR_AGENT_EXTENSION_AGENT_INPUT_INVALID'
      });
      await expect(api.message(invalid as never)).rejects.toMatchObject({
        code: 'MAR_AGENT_EXTENSION_AGENT_INPUT_INVALID'
      });
    }
  });

  it.each([false, true])(
    'carries actual model/Code Mode parent ancestry (codeMode=%s)',
    async (codeMode) => {
      let rootApi!: CoreAgentsApi;
      const facts: Array<{ executionId?: string | undefined; entry: string }> = [];
      const f = await fixture(
        [
          {
            id: 'model-native',
            apiVersion: '1.0',
            attachSession: (context) => {
              if (!context.agents) return;
              rootApi = context.agents;
              context.hooks.observe('agent.completed', (_fact, operation) => {
                facts.push({ executionId: operation.executionId, entry: operation.entry });
              });
              context.tools.register({
                name: 'delegate',
                description: 'Delegate',
                inputSchema: { type: 'object', properties: {} },
                execute: async () => {
                  const started = await rootApi.spawn({ prompt: 'child work' });
                  if (!('agentId' in started)) throw new Error('Expected an actual child task.');
                  const result = await rootApi.wait({ agentId: started.agentId, waitMs: 1000 });
                  return { data: result, content: result.summary ?? '' };
                }
              });
            }
          }
        ],
        (request) => {
          if (request.system.includes('non-recursive subagent')) return answer();
          const hasResult = request.messages.some((message) => message.role === 'tool');
          return hasResult
            ? answer()
            : codeMode
              ? call('code_exec', { code: 'observe.result(await tools.delegate({}));' })
              : call('delegate', {});
        },
        codeMode,
        true
      );
      const execution = f.session.run({ prompt: 'delegate child' });
      expect(await execution.result()).toHaveProperty('status', 'completed');
      expect(facts).toContainEqual({
        executionId: execution.executionId,
        entry: codeMode ? 'programmatic' : 'direct'
      });
      const children = await rootApi.list();
      const store = await JsonlSessionStore.open(f.home);
      expect((await store.getSession(children[0]!.agentId)).source).toHaveProperty(
        'parentExecutionId',
        execution.executionId
      );
    }
  );

  it('rejects the facade after Session clear without breaking the new Session', async () => {
    const { api, agent, session } = await nativeFixture();
    await agent.clearSession(session.id);
    await expect(api.spawn({ prompt: 'stale' })).rejects.toMatchObject({
      code: 'MAR_AGENT_EXTENSION_RETIRED'
    });
    expect(await session.run({ prompt: 'continue after clear' }).result()).toHaveProperty(
      'status',
      'completed'
    );
  });

  it('prevents pre-cancelled spawn admission and keeps an unrelated instance usable', async () => {
    const { api } = await nativeFixture();
    const reason = new Error('stop-native');
    await expect(
      api.spawn({ prompt: 'do not create', signal: AbortSignal.abort(reason) })
    ).rejects.toBe(reason);
    expect(await api.list()).toHaveLength(0);
    const spawned = await api.spawn({ prompt: 'still usable' });
    if (!('agentId' in spawned)) throw new Error('Expected an actual child task.');
    expect(await api.wait({ agentId: spawned.agentId, waitMs: 1000 })).toHaveProperty(
      'status',
      'completed'
    );
  });

  it.each(['native-api', 'direct', 'programmatic'] as const)(
    'preserves Agent interception facts and caller boundaries for the %s ingress',
    async (entry) => {
      let api!: CoreAgentsApi;
      const facts: Array<{ operation: string; agentId: string; status: string; entry: string }> =
        [];
      const f = await fixture(
        [
          {
            id: 'common-hook',
            apiVersion: '1.0',
            attachSession: (context) => {
              if (context.agents) api = context.agents;
              context.hooks.intercept('agent.spawn', async (input, call, next) => {
                expect(call.entry).toBe(entry);
                if (entry === 'direct') expect(input.background).toBe(true);
                const result = await next({
                  ...input,
                  prompt: 'REAL_REWRITTEN_INTENT',
                  description: 'real description'
                });
                return { ...result, description: 'wrapped description' };
              });
              context.hooks.observe('agent.completed', (event, call) => {
                facts.push({
                  operation: event.operation,
                  agentId: event.agentId,
                  status: event.status,
                  entry: call.entry
                });
              });
            }
          }
        ],
        (request) => {
          if (
            entry === 'native-api' ||
            request.system.includes('non-recursive subagent') ||
            request.messages.some((message) => message.role === 'tool')
          )
            return answer();
          const input = {
            prompt: 'original intent',
            description: 'original description',
            role: 'general-purpose'
          };
          return entry === 'programmatic'
            ? call('code_exec', {
                code: `observe.result(await tools.agent_start(${JSON.stringify(input)}));`
              })
            : call('agent_start', input);
        },
        entry === 'programmatic',
        true
      );
      expect(await f.session.run({ prompt: 'initialize' }).result()).toHaveProperty(
        'status',
        'completed'
      );
      if (entry === 'programmatic') {
        expect(facts).toEqual([]);
        expect(await api.list()).toEqual([]);
        expect(
          f.adapter.requests[0]!.tools.find((tool) => tool.name === 'agent_start')?.allowedCallers
        ).toEqual(['direct']);
        const result = f.adapter.requests[1]!.messages.find(
          (message) => message.role === 'tool' && message.callId === 'call'
        )!;
        expect(JSON.parse(result.content)).toMatchObject({ status: 'failed' });
        return;
      }
      if (entry === 'native-api') {
        expect(await api.spawn({ prompt: 'original intent', background: false })).toHaveProperty(
          'description',
          'wrapped description'
        );
      }
      expect(facts).toEqual([
        {
          operation: 'spawn',
          agentId: expect.any(String),
          status:
            entry === 'direct'
              ? expect.stringMatching(/^(queued|running|completed)$/u)
              : 'completed',
          entry
        }
      ]);
      const child = (await api.list())[0]!;
      expect(await api.wait({ agentId: child.agentId, waitMs: 1000 })).toHaveProperty(
        'status',
        'completed'
      );
      expect(child.description).toBe('real description');
      const store = await JsonlSessionStore.open(f.home);
      const records = await store.read(child.agentId);
      const inputType = entry === 'native-api' ? 'extension.input' : 'turn.user';
      expect(records.filter((record) => record.type === inputType)).toHaveLength(1);
      expect(records.find((record) => record.type === inputType)?.payload).toMatchObject({
        prompt: 'REAL_REWRITTEN_INTENT'
      });
    }
  );
});
