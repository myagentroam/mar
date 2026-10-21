import { afterEach, describe, expect, it, vi } from 'vitest';
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
      expect(await f.session.run({ prompt: 'during close' }).result()).toHaveProperty(
        'status',
        'failed'
      );
      expect(f.adapter.requests).toHaveLength(1);
    } finally {
      release();
      await clearing;
    }
  });

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
