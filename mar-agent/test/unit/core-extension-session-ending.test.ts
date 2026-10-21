import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupCoreFixtures, fixture, answer } from './support/core-extension-fixture.js';
import type { CoreDomainFacts } from '../../src/agent-core/extensions/contracts.js';

afterEach(cleanupCoreFixtures);

describe('Core explicit Session ending boundary', () => {
  it('emits clear once before retirement, preserves actual readable identity and admits a new generation', async () => {
    const facts: CoreDomainFacts['session.ending'][] = [];
    const order: string[] = [];
    const f = await fixture(
      [
        {
          id: 'ending',
          apiVersion: '1.0',
          attachSession(context) {
            context.hooks.observe('session.ending', async (fact, call) => {
              facts.push(fact);
              expect(call.signal.aborted).toBe(false);
              expect(await context.session!.describe()).toHaveProperty(
                'sessionId',
                context.sessionId
              );
              order.push('ending');
            });
            context.resources.effect(() => () => {
              order.push('retired');
            });
          }
        }
      ],
      () => answer()
    );
    await f.session.run({ prompt: 'open' }).result();
    await f.agent.clearSession(f.session.id);
    expect(facts).toEqual([{ sessionId: f.session.id, reason: 'clear', resumable: true }]);
    expect(order).toEqual(['ending', 'retired']);
    expect(await f.session.run({ prompt: 'new generation' }).result()).toHaveProperty(
      'status',
      'completed'
    );
  });

  it('rejects new execution admission while actual end observers are draining', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const f = await fixture(
      [
        {
          id: 'ending',
          apiVersion: '1.0',
          attachSession(context) {
            context.hooks.observe('session.ending', async () => {
              entered = true;
              await gate;
            });
          }
        }
      ],
      () => answer()
    );
    await f.session.run({ prompt: 'open' }).result();
    const clearing = f.agent.clearSession(f.session.id);
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      expect(() => f.session.run({ prompt: 'during close' })).toThrowError(
        expect.objectContaining({ code: 'MAR_AGENT_SESSION_CLOSING' })
      );
      expect(f.adapter.requests).toHaveLength(1);
    } finally {
      release();
      await clearing;
    }
  });

  it.each([false, true])(
    'blocks only the clearing Session through Host cleanup and restores its original handle (failure=%s)',
    async (failCleanup) => {
      const f = await fixture([], () => answer());
      await f.session.run({ prompt: 'old history' }).result();
      const other = await f.agent.createSession({ workspace: f.home });
      const entered = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const failure = new Error('Host cleanup failed');
      const disposeResources = f.host.disposeSessionResources.bind(f.host);
      f.host.disposeSessionResources = async (id) => {
        if (id === f.session.id) {
          entered.resolve();
          await gate.promise;
          if (failCleanup) throw failure;
        }
        await disposeResources(id);
      };
      const clearing = f.agent.clearSession(f.session.id);
      const settled = clearing.then(
        () => undefined,
        (error: unknown) => error
      );
      const transcript = join(
        f.home,
        '.mar',
        'agent',
        'sessions',
        f.session.id,
        'events-000001.jsonl'
      );
      try {
        await entered.promise;
        const before = await readFile(transcript, 'utf8');
        const reopened = await f.agent.openSession(f.session.id);
        for (const session of [f.session, reopened])
          for (const mode of ['run', 'plan', 'compact'] as const)
            expect(() => session[mode]({ prompt: 'rejected during clear' })).toThrowError(
              expect.objectContaining({ code: 'MAR_AGENT_SESSION_CLOSING' })
            );
        expect(f.adapter.requests).toHaveLength(1);
        expect(await readFile(transcript, 'utf8')).toBe(before);
        expect(await other.run({ prompt: 'parallel Session' }).result()).toHaveProperty(
          'status',
          'completed'
        );
        expect(f.adapter.requests).toHaveLength(2);
      } finally {
        gate.resolve();
        await settled;
      }
      expect(await settled).toBe(failCleanup ? failure : undefined);
      expect(await f.session.run({ prompt: 'new history' }).result()).toHaveProperty(
        'status',
        'completed'
      );
      const history = await readFile(transcript, 'utf8');
      expect(history).toContain('new history');
      expect(history).not.toContain('old history');
      expect(history).not.toContain('rejected during clear');
      expect(JSON.stringify(f.adapter.requests.at(-1)?.messages)).not.toContain('old history');
    }
  );

  it('closes admission synchronously, joins repeated clear and rejects a different maintenance operation', async () => {
    const f = await fixture([], () => answer());
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const dispose = vi.spyOn(f.host, 'disposeSessionResources').mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
    });
    const clearing = f.agent.clearSession(f.session.id);
    try {
      expect(() => f.session.run({ prompt: 'immediately after clear' })).toThrowError(
        expect.objectContaining({ code: 'MAR_AGENT_SESSION_CLOSING' })
      );
      expect(f.agent.clearSession(f.session.id)).toBe(clearing);
      await expect(f.agent.deleteSession(f.session.id)).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_CLOSING'
      });
      await entered.promise;
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve();
      await clearing;
    }
    expect(await f.session.run({ prompt: 'after clear' }).result()).toHaveProperty(
      'status',
      'completed'
    );
  });

  it('releases maintenance admission when clear rejects an active Execution', async () => {
    const f = await fixture([], () => answer());
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const start = f.adapter.start.bind(f.adapter);
    vi.spyOn(f.adapter, 'start').mockImplementation(async function* (request, signal) {
      entered.resolve();
      await gate.promise;
      yield* start(request, signal);
    });
    const running = f.session.run({ prompt: 'active' });
    try {
      await entered.promise;
      await expect(f.agent.clearSession(f.session.id)).rejects.toMatchObject({
        code: 'MAR_AGENT_EXECUTION_ACTIVE'
      });
    } finally {
      gate.resolve();
      await running.result();
    }
    await f.agent.clearSession(f.session.id);
    expect(await f.session.run({ prompt: 'after rejected clear' }).result()).toHaveProperty(
      'status',
      'completed'
    );
  });

  it.each(['clearSession', 'deleteSession'] as const)(
    'keeps %s admission closed and joins its Host cleanup before Agent disposal',
    async (operation) => {
      const f = await fixture([], () => answer());
      await f.session.run({ prompt: 'initialize' }).result();
      const entered = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      vi.spyOn(f.host, 'disposeSessionResources').mockImplementation(async () => {
        entered.resolve();
        await gate.promise;
      });
      const hostDisposal = vi.spyOn(f.host, 'dispose');
      const maintaining = f.agent[operation](f.session.id);
      let disposal: Promise<void> | undefined;
      try {
        await entered.promise;
        expect(f.agent[operation](f.session.id)).toBe(maintaining);
        expect(() => f.session.compact()).toThrowError(
          expect.objectContaining({ code: 'MAR_AGENT_SESSION_CLOSING' })
        );
        disposal = f.agent.dispose();
        expect(f.agent.dispose()).toBe(disposal);
        expect(() => f.session.run({ prompt: 'during dispose' })).toThrowError(
          expect.objectContaining({ code: 'MAR_AGENT_DISPOSED' })
        );
        await Promise.resolve();
        expect(hostDisposal).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
        await maintaining;
        await disposal;
      }
      expect(hostDisposal).toHaveBeenCalledTimes(1);
    }
  );

  it('does not let observer failures skip native cleanup and marks deletion non-resumable', async () => {
    const facts: CoreDomainFacts['session.ending'][] = [];
    let retired = 0;
    const f = await fixture(
      [
        {
          id: 'ending',
          apiVersion: '1.0',
          attachSession(context) {
            context.hooks.observe('session.ending', async (fact) => {
              facts.push(fact);
              throw new Error('observer failed');
            });
            context.resources.effect(() => () => {
              retired++;
            });
          }
        }
      ],
      () => answer()
    );
    await f.session.run({ prompt: 'open' }).result();
    await f.agent.deleteSession(f.session.id);
    expect(facts).toEqual([{ sessionId: f.session.id, reason: 'other', resumable: false }]);
    expect(retired).toBe(1);
  });

  it('joins concurrent explicit endings and does not impose an Adapter wall-clock budget', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal: AbortSignal | undefined;
    let count = 0;
    const f = await fixture(
      [
        {
          id: 'ending',
          apiVersion: '1.0',
          attachSession(context) {
            context.hooks.observe('session.ending', async (_fact, call) => {
              count++;
              signal = call.signal;
              await gate;
            });
          }
        }
      ],
      () => answer()
    );
    await f.session.run({ prompt: 'open' }).result();
    vi.useFakeTimers();
    const clear = f.agent.clearSession(f.session.id);
    const dispose = f.agent.dispose();
    let ended = false;
    void Promise.all([clear, dispose]).then(
      () => {
        ended = true;
      },
      () => undefined
    );
    try {
      await vi.advanceTimersByTimeAsync(1700);
      expect(count).toBe(1);
      expect(signal?.aborted).toBe(false);
      expect(ended).toBe(false);
    } finally {
      release();
      await Promise.all([clear, dispose]);
      vi.useRealTimers();
    }
  });
});
