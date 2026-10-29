import { afterEach, expect, it, vi } from 'vitest';
import { SESSION_CONTEXT_PROVIDER } from '../../src/extensions.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { fixture, answer, call, cleanupCoreFixtures } from './support/core-extension-fixture.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupCoreFixtures();
});

it('observes future admitted Executions without observer interference', async () => {
  const { agent, session, home } = await fixture([], () => answer());
  const activeSeen: string[] = [];
  const failedExecutionObserver = agent.observeSessionExecutions(() => {
    throw new Error('observer failure');
  });
  const executionObserver = agent.observeSessionExecutions((live) => activeSeen.push(live.id));
  expect(executionObserver.sessions).toEqual([]);
  const child = await agent.createSession({ workspace: home, parentSessionId: session.id });
  const concurrentHandle = await agent.openSession(child.id);
  const events: string[] = [];
  const subscription = concurrentHandle.subscribe((event) => events.push(event.type));
  expect(await child.run({ prompt: 'child input' }).result()).toMatchObject({
    status: 'completed'
  });
  expect(events).toContain('execution.completed');
  expect(activeSeen).toEqual([child.id]);
  subscription.unsubscribe();
  failedExecutionObserver.unsubscribe();
  executionObserver.unsubscribe();
});

it('exposes current safe model usage qualifications to extensions', async () => {
  let list!: () => readonly unknown[];
  const { agent, session, adapter } = await fixture(
    [
      {
        id: 'model-catalog',
        apiVersion: '1.0',
        attachSession(context) {
          list = () => context.models!.list();
        }
      }
    ],
    () => answer()
  );
  await session.run({ prompt: 'prepare' }).result();
  expect(list()).toMatchObject([
    {
      id: 'test',
      conversationModel: true,
      subagentModel: false,
      defaultReasoningEffort: 'medium',
      isDefault: true
    }
  ]);
  expect(JSON.stringify(list())).not.toContain('apiKey');
  await agent.reconfigureModels({
    models: [
      { ...adapter.configuration, subagentModel: true },
      { ...adapter.configuration, id: 'disabled', enabled: false, subagentModel: true }
    ]
  });
  expect(list()).toMatchObject([{ id: 'test', conversationModel: true, subagentModel: true }]);
  expect(list()).toHaveLength(1);
});

it('records explicit Session provenance without permitting a conflicting parent', async () => {
  const { agent, session, home } = await fixture([], () => answer());
  const source = {
    type: 'subagent' as const,
    parentSessionId: session.id,
    rootSessionId: session.id,
    parentExecutionId: 'execution',
    role: 'explore' as const,
    description: 'inspect'
  };
  const child = await agent.createSession({ workspace: home, source });
  expect((await agent.getSession(child.id)).source).toEqual(source);
  await expect(
    agent.createSession({ workspace: home, parentSessionId: 'other', source })
  ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_SOURCE_INVALID' });
});

it('joins the actual execution through cleanup before admitting a successor', async () => {
  const { session } = await fixture([], (_request, index) =>
    index === 0 ? call('sleep', { durationMs: 300000 }) : answer()
  );
  const execution = session.run({ prompt: 'hold' });
  const started = Promise.withResolvers<void>();
  const reader = (async () => {
    for await (const event of execution)
      if (event.type === 'tool.started' && event.toolName === 'sleep') started.resolve();
  })();
  await started.promise;
  const joined = session.joinExecution(execution.executionId);
  expect(joined).toBeDefined();
  await session.cancel(execution.executionId);
  expect(await joined).toMatchObject({ status: 'cancelled' });
  await reader;
  expect(await session.run({ prompt: 'continue' }).result()).toMatchObject({ status: 'completed' });
  expect(session.joinExecution(execution.executionId)).toBeUndefined();
});

it('commits session-scoped extension context once before acknowledging it', async () => {
  let unread = true;
  const acknowledge = vi.fn(() => {
    unread = false;
  });
  const { session, adapter } = await fixture(
    [
      {
        id: 'context-provider',
        apiVersion: '1.0',
        attachSession(context) {
          context.services.provide(SESSION_CONTEXT_PROVIDER, {
            collect: () => (unread ? [{ content: 'A bounded observation', acknowledge }] : [])
          });
        }
      }
    ],
    () => answer()
  );
  expect(await session.run({ prompt: 'first' }).result()).toMatchObject({ status: 'completed' });
  expect(
    adapter.requests[0]!.messages.filter((message) => message.content === 'A bounded observation')
  ).toHaveLength(1);
  expect(acknowledge).toHaveBeenCalledOnce();
  expect(await session.run({ prompt: 'second' }).result()).toMatchObject({ status: 'completed' });
  expect(acknowledge).toHaveBeenCalledOnce();
});

it('retains extension resource summaries on compact without consuming later observations', async () => {
  let resource = 'child one';
  let unread = true;
  const acknowledge = vi.fn(() => {
    unread = false;
  });
  const { session, adapter } = await fixture(
    [
      {
        id: 'resources',
        apiVersion: '1.0',
        attachSession(context) {
          context.services.provide(SESSION_CONTEXT_PROVIDER, {
            collect: () => (unread ? [{ content: 'one observation', acknowledge }] : []),
            resources: () => [resource]
          });
        }
      }
    ],
    () => answer()
  );
  expect(await session.run({ prompt: 'first' }).result()).toMatchObject({ status: 'completed' });
  expect(await session.compact().result()).toMatchObject({ status: 'completed' });
  resource = 'child two';
  expect(await session.run({ prompt: 'second' }).result()).toMatchObject({ status: 'completed' });
  expect(JSON.stringify(adapter.requests.at(-1)!.messages)).toContain('child one');
  expect(JSON.stringify(adapter.requests.at(-1)!.messages)).not.toContain('child two');
  expect(acknowledge).toHaveBeenCalledOnce();
});

it('wakes sleep for unread provider context and commits it before the next model request', async () => {
  let unread = false;
  const listeners = new Set<() => void>();
  const sleeping = Promise.withResolvers<void>();
  const acknowledge = vi.fn(() => {
    unread = false;
  });
  let requests = 0;
  const { session } = await fixture(
    [
      {
        id: 'context-provider',
        apiVersion: '1.0',
        attachSession(context) {
          context.services.provide(SESSION_CONTEXT_PROVIDER, {
            collect: () => (unread ? [{ content: 'fresh context', acknowledge }] : []),
            wake: {
              pending: () => unread,
              subscribe(listener) {
                listeners.add(listener);
                return () => {
                  listeners.delete(listener);
                };
              }
            }
          });
        }
      }
    ],
    (request) => {
      requests++;
      if (requests === 1) return call('sleep', { durationMs: 300000 });
      expect(
        request.messages.filter((message) => message.content === 'fresh context')
      ).toHaveLength(1);
      const result = request.messages.findLast(
        (message) => message.role === 'tool' && message.name === 'sleep'
      );
      expect(JSON.parse(result!.content).wakeReason).toBe('subagent_message');
      return answer();
    }
  );
  const execution = session.run({ prompt: 'wait', permissionMode: 'full-access' });
  const events = (async () => {
    for await (const event of execution)
      if (event.type === 'tool.started' && event.toolName === 'sleep') sleeping.resolve();
  })();
  await sleeping.promise;
  unread = true;
  for (const listener of listeners) listener();
  expect(await execution.result()).toMatchObject({ status: 'completed' });
  await events;
  expect(acknowledge).toHaveBeenCalledOnce();
  expect(listeners.size).toBe(0);
});

it('acknowledges only committed items and retries the remaining batch after a store failure', async () => {
  const unread = new Set(['first observation', 'second observation']);
  const acknowledge = vi.fn((content: string) => unread.delete(content));
  const { session, adapter } = await fixture(
    [
      {
        id: 'context-provider',
        apiVersion: '1.0',
        attachSession(context) {
          context.services.provide(SESSION_CONTEXT_PROVIDER, {
            collect: () =>
              [...unread].map((content) => ({ content, acknowledge: () => acknowledge(content) }))
          });
        }
      }
    ],
    () => answer()
  );
  const original = JsonlSessionStore.prototype.append;
  const spy = vi
    .spyOn(JsonlSessionStore.prototype, 'append')
    .mockImplementation(async function (id, record, options) {
      if (
        record.type === 'model.context' &&
        (record.payload as { content?: unknown }).content === 'second observation'
      )
        throw new Error('Store failed');
      return original.call(this, id, record, options);
    });
  expect(await session.run({ prompt: 'first' }).result()).toMatchObject({ status: 'failed' });
  expect(acknowledge).toHaveBeenCalledTimes(1);
  expect(unread).toEqual(new Set(['second observation']));
  spy.mockRestore();
  expect(await session.run({ prompt: 'retry' }).result()).toMatchObject({ status: 'completed' });
  expect(acknowledge).toHaveBeenCalledTimes(2);
  expect(unread.size).toBe(0);
  const messages = adapter.requests.at(-1)!.messages;
  expect(messages.filter((message) => message.content === 'first observation')).toHaveLength(1);
  expect(messages.filter((message) => message.content === 'second observation')).toHaveLength(1);
});

it('limits each round to eight items without acknowledging excluded observations', async () => {
  const acknowledged = new Set<number>();
  const { session } = await fixture(
    [
      {
        id: 'context-provider',
        apiVersion: '1.0',
        attachSession(context) {
          context.services.provide(SESSION_CONTEXT_PROVIDER, {
            collect: () =>
              Array.from({ length: 9 }, (_, index) => index)
                .filter((index) => !acknowledged.has(index))
                .map((index) => ({
                  content: `observation ${index}`,
                  acknowledge: () => {
                    acknowledged.add(index);
                  }
                }))
          });
        }
      }
    ],
    () => answer()
  );
  expect(await session.run({ prompt: 'first' }).result()).toMatchObject({ status: 'completed' });
  expect([...acknowledged]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(await session.run({ prompt: 'second' }).result()).toMatchObject({ status: 'completed' });
  expect([...acknowledged]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

it('does not commit or acknowledge observations when preparation is cancelled', async () => {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acknowledge = vi.fn();
  const { session, adapter } = await fixture(
    [
      {
        id: 'context-provider',
        apiVersion: '1.0',
        attachSession(context) {
          context.services.provide(SESSION_CONTEXT_PROVIDER, {
            async collect() {
              enter();
              await pending;
              return [{ content: 'cancelled observation', acknowledge }];
            }
          });
        }
      }
    ],
    () => answer()
  );
  const handle = session.run({ prompt: 'first' });
  await entered;
  handle.cancel();
  release();
  expect(await handle.result()).toMatchObject({ status: 'cancelled' });
  expect(acknowledge).not.toHaveBeenCalled();
  expect(adapter.requests).toHaveLength(0);
});

it('keeps later items unread when cancellation follows the first committed item', async () => {
  const unread = new Set(['committed observation', 'pending observation']);
  let cancelCurrent = () => {};
  const acknowledged: string[] = [];
  const { session, adapter } = await fixture(
    [
      {
        id: 'context-provider',
        apiVersion: '1.0',
        attachSession(context) {
          context.services.provide(SESSION_CONTEXT_PROVIDER, {
            collect: () =>
              [...unread].map((content) => ({
                content,
                acknowledge: () => {
                  acknowledged.push(content);
                  unread.delete(content);
                  if (content === 'committed observation') cancelCurrent();
                }
              }))
          });
        }
      }
    ],
    () => answer()
  );
  const handle = session.run({ prompt: 'first' });
  cancelCurrent = () => handle.cancel();
  expect(await handle.result()).toMatchObject({ status: 'cancelled' });
  expect(acknowledged).toEqual(['committed observation']);
  expect([...unread]).toEqual(['pending observation']);
  expect(await session.run({ prompt: 'retry' }).result()).toMatchObject({ status: 'completed' });
  expect(acknowledged).toEqual(['committed observation', 'pending observation']);
  expect(
    adapter.requests.at(-1)!.messages.filter((item) => item.content === 'committed observation')
  ).toHaveLength(1);
  expect(
    adapter.requests.at(-1)!.messages.filter((item) => item.content === 'pending observation')
  ).toHaveLength(1);
});

it('acknowledges the captured version without consuming a later observation', async () => {
  let version = 1;
  let observed = 0;
  const { session, adapter } = await fixture(
    [
      {
        id: 'context-provider',
        apiVersion: '1.0',
        attachSession(context) {
          context.services.provide(SESSION_CONTEXT_PROVIDER, {
            collect() {
              if (version <= observed) return [];
              const captured = version;
              return [
                {
                  content: `observation version ${captured}`,
                  acknowledge: () => {
                    observed = Math.max(observed, captured);
                  }
                }
              ];
            }
          });
        }
      }
    ],
    () => answer()
  );
  const original = JsonlSessionStore.prototype.append;
  const spy = vi
    .spyOn(JsonlSessionStore.prototype, 'append')
    .mockImplementation(async function (id, record, options) {
      const stored = await original.call(this, id, record, options);
      if (
        record.type === 'model.context' &&
        (record.payload as { content?: unknown }).content === 'observation version 1'
      )
        version = 2;
      return stored;
    });
  expect(await session.run({ prompt: 'first' }).result()).toMatchObject({ status: 'completed' });
  expect(observed).toBe(1);
  expect(version).toBe(2);
  spy.mockRestore();
  expect(await session.run({ prompt: 'second' }).result()).toMatchObject({ status: 'completed' });
  expect(observed).toBe(2);
  expect(
    adapter.requests.at(-1)!.messages.filter((item) => item.content === 'observation version 2')
  ).toHaveLength(1);
});
