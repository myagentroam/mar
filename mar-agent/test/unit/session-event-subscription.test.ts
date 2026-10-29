import { afterEach, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../src/index.js';
import { answer, cleanupCoreFixtures, fixture } from './support/core-extension-fixture.js';

afterEach(cleanupCoreFixtures);

it('observes one Session owner without consuming its execution stream or letting observers mutate it', async () => {
  const { agent, session } = await fixture([], () => answer());
  const sameSession = await agent.openSession(session.id);
  const first: AgentEvent[] = [];
  const second: AgentEvent[] = [];
  const before = session.subscribe((event) => {
    first.push(event);
    if (event.type === 'message.completed') {
      (event as { text: string }).text = 'changed by observer';
      throw new Error('observer failed');
    }
  });
  expect(before.activeExecutionId).toBeUndefined();
  const run = session.run({ prompt: 'hello' });
  const during = sameSession.subscribe((event) => second.push(event));
  expect(during.activeExecutionId).toBe(run.executionId);
  const streamed: AgentEvent[] = [];
  const collecting = (async () => {
    for await (const event of run) streamed.push(event);
  })();
  expect(await run.result()).toMatchObject({ status: 'completed' });
  await collecting;
  expect(first.some((event) => event.type === 'execution.completed')).toBe(true);
  expect(second.some((event) => event.type === 'execution.completed')).toBe(true);
  expect(second.find((event) => event.type === 'message.completed')).toMatchObject({
    text: 'done'
  });
  expect(streamed.find((event) => event.type === 'message.completed')).toMatchObject({
    text: 'done'
  });
  const count = first.length;
  before.unsubscribe();
  during.unsubscribe();
  expect(await session.run({ prompt: 'again' }).result()).toMatchObject({ status: 'completed' });
  expect(first).toHaveLength(count);
  const after = session.subscribe(() => {});
  expect(after.activeExecutionId).toBeUndefined();
  after.unsubscribe();
});

it.each(['completed', 'failed', 'cancelled'] as const)(
  'reports %s terminal to observers registered during publication without releasing admission',
  async (status) => {
    const f = await fixture([], () => {
      if (status === 'failed') throw new Error('model failure');
      return answer();
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const emit = f.host.emit.bind(f.host);
    vi.spyOn(f.host, 'emit').mockImplementation(async (event) => {
      if (event.type === `execution.${status}`) {
        entered.resolve();
        await release.promise;
      }
      return emit(event);
    });
    let nested: ReturnType<typeof f.session.subscribe> | undefined;
    const laterEvents: AgentEvent[] = [];
    const first = f.session.subscribe((event) => {
      if (event.type === `execution.${status}`)
        nested = f.session.subscribe((next) => laterEvents.push(next));
    });
    const execution = f.session.run({ prompt: 'terminal snapshot', permissionMode: 'full-access' });
    if (status === 'cancelled') execution.cancel();
    try {
      await entered.promise;
      expect(nested?.activeExecutionId).toBe(execution.executionId);
      expect(nested?.terminalEvent).toMatchObject({
        type: `execution.${status}`,
        executionId: execution.executionId
      });
      expect(laterEvents).not.toContainEqual(
        expect.objectContaining({ type: `execution.${status}` })
      );
      const duringCleanup = f.session.subscribe(() => {});
      expect(duringCleanup.terminalEvent).toEqual(nested?.terminalEvent);
      duringCleanup.unsubscribe();
      expect(() => f.session.run({ prompt: 'too early' })).toThrow(/MAR_AGENT_EXECUTION_ACTIVE/);
    } finally {
      release.resolve();
    }
    expect((await execution.result()).status).toBe(status);
    nested?.unsubscribe();
    first.unsubscribe();
    const idle = f.session.subscribe(() => {});
    expect(idle.activeExecutionId).toBeUndefined();
    expect(idle.terminalEvent).toBeUndefined();
    idle.unsubscribe();
  }
);
