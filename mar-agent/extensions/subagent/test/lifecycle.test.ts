import { expect, it, vi } from 'vitest';
import type { Agent, AgentSession } from '@myagentroam/agent';
import type {
  ExtensionSessionContextProvider,
  SessionExtensionContext
} from '@myagentroam/agent/extensions';
import { createSubagentExtension } from '../src/index.js';
import { nativeSubagentService, SUBAGENT_NATIVE_SERVICE } from '../src/native.js';
import { StartAdmission } from '../src/start.js';

async function fixture() {
  let observer!: (session: AgentSession) => void;
  let provider!: ExtensionSessionContextProvider;
  const lookup = Promise.withResolvers<{ id: string; workspace: string }>();
  const unsubscribe = vi.fn();
  const listSessions = vi.fn(async () => ({
    sessions: [{ id: 'child', title: 'Child', workspace: 'work' }]
  }));
  const sessionHistory = vi.fn();
  const getSession = vi
    .fn()
    .mockResolvedValueOnce({ id: 'parent', workspace: 'work' })
    .mockImplementation(() => lookup.promise);
  const agent = {
    observeSessionExecutions(listener: typeof observer) {
      observer = listener;
      return { sessions: [], unsubscribe };
    },
    getSession,
    listSessions,
    sessionHistory
  } as unknown as Agent;
  const context = {
    sessionId: 'parent',
    services: {
      provide(_key: unknown, value: typeof provider) {
        provider = value;
      }
    },
    tools: { register() {} },
    hooks: { intercept() {} }
  } as unknown as SessionExtensionContext;
  const dispose = (await createSubagentExtension({ agent: () => agent }).attachSession!(
    context
  )) as () => Promise<void>;
  return { dispose, observer, provider, lookup, listSessions, sessionHistory, unsubscribe };
}

it('does not discover or load child history while attaching the parent', async () => {
  const test = await fixture();
  expect(test.listSessions).not.toHaveBeenCalled();
  expect(test.sessionHistory).not.toHaveBeenCalled();
  await test.dispose();
});

it('ignores a late Session registration after the extension has been disposed', async () => {
  const test = await fixture();
  await test.dispose();
  const subscribe = vi.fn(() => ({ unsubscribe() {} }));
  test.observer({ id: 'parent', source: {}, subscribe } as unknown as AgentSession);
  test.observer({
    id: 'child',
    source: { parentSessionId: 'parent' },
    subscribe
  } as unknown as AgentSession);
  expect(test.unsubscribe).toHaveBeenCalledOnce();
  expect(subscribe).not.toHaveBeenCalled();
});

it('discards a delayed resource lookup after disposal without scanning children', async () => {
  const test = await fixture();
  const result = test.provider.resources!(new AbortController().signal);
  await test.dispose();
  test.lookup.resolve({ id: 'parent', workspace: 'work' });
  expect(await result).toEqual([]);
  expect(test.listSessions).not.toHaveBeenCalled();
});

it('does not subscribe a native client to a child from another workspace', async () => {
  let observer!: (session: AgentSession) => void;
  const agent = {
    observeSessionExecutions(listener: typeof observer) {
      observer = listener;
      return { sessions: [], unsubscribe() {} };
    }
  } as unknown as Agent;
  const context = { sessionId: 'parent' } as SessionExtensionContext;
  const provider = nativeSubagentService(context, agent, new StartAdmission(), new Map(), 'work');
  const bound = SUBAGENT_NATIVE_SERVICE.bindConsumer!(provider.service, {
    run: async () => {
      throw new Error('Unexpected operation');
    },
    onDispose() {}
  });
  const client = bound.open();
  const foreign = vi.fn(() => ({ unsubscribe() {} }));
  const local = vi.fn(() => ({ unsubscribe() {} }));
  observer({
    id: 'foreign',
    workspace: 'other',
    source: { parentSessionId: 'parent' },
    subscribe: foreign
  } as unknown as AgentSession);
  observer({
    id: 'local',
    workspace: 'work',
    source: { parentSessionId: 'parent' },
    subscribe: local
  } as unknown as AgentSession);
  expect(foreign).not.toHaveBeenCalled();
  expect(local).toHaveBeenCalledOnce();
  await client.close();
  await provider.close();
});
