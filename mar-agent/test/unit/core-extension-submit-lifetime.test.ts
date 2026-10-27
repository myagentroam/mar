import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import type { SessionExtensionContext } from '../../src/extensions/contracts.js';
import type { ExtensionSessionReceipt } from '../../src/extensions/session-input.js';
import { fixture, answer, cleanupCoreFixtures } from './support/core-extension-fixture.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupCoreFixtures();
});

describe('Core accepted prompt lifetime', () => {
  it('settles an idle commit waiter cancelled before the input writer runs', async () => {
    let context!: SessionExtensionContext;
    let enabled = false;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = await fixture(
      [
        {
          id: 'idle-cancel',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
          }
        }
      ],
      () => answer()
    );
    await f.session.run({ prompt: 'initialize' }).result();
    const append = JsonlSessionStore.prototype.append;
    vi.spyOn(JsonlSessionStore.prototype, 'append').mockImplementation(async function (
      this: JsonlSessionStore,
      id,
      input,
      options
    ) {
      if (enabled && input.type === 'extension.input') {
        entered();
        const signal = options?.signal;
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return append.call(this, id, input, options);
    });
    enabled = true;
    const lifetime = new AbortController();
    const pending = context.session!.submit({
      text: 'never written',
      delivery: 'idle',
      waitFor: 'commit',
      queueSignal: lifetime.signal
    });
    await ready;
    lifetime.abort();
    const receipt = await pending;
    expect(receipt.status).toBe('cancelled');
    expect(receipt.recordId).toBeUndefined();
    expect(receipt.changed).not.toBe(true);
    expect(f.adapter.requests).toHaveLength(1);
  });

  it.each(['start', 'commit'] as const)(
    'distinguishes idle %s from the actual input commit',
    async (waitFor) => {
      let context!: SessionExtensionContext;
      let held = false;
      let entered!: () => void;
      let release!: () => void;
      let finished!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const done = new Promise<void>((resolve) => {
        finished = resolve;
      });
      const f = await fixture(
        [
          {
            id: 'idle-commit',
            apiVersion: '1.0',
            attachSession(value) {
              context = value;
            }
          }
        ],
        () => answer()
      );
      await f.session.run({ prompt: 'initialize' }).result();
      const append = JsonlSessionStore.prototype.append;
      vi.spyOn(JsonlSessionStore.prototype, 'append').mockImplementation(async function (
        this: JsonlSessionStore,
        id,
        input,
        options
      ) {
        if (held && input.type === 'extension.input') {
          entered();
          await gate;
        }
        const result = await append.call(this, id, input, options);
        if (held && input.type === 'extension.input') finished();
        return result;
      });
      held = true;
      let receipt: ExtensionSessionReceipt | undefined;
      const submitted = context
        .session!.submit({ text: 'held input', delivery: 'idle', waitFor })
        .then((value) => {
          receipt = value;
          return value;
        });
      await ready;
      if (waitFor === 'start') {
        await submitted;
        expect(receipt).toMatchObject({ status: 'in-progress', executionId: expect.any(String) });
        expect(receipt?.recordId).toBeUndefined();
        expect(receipt?.changed).not.toBe(true);
      } else {
        await Promise.resolve();
        expect(receipt).toBeUndefined();
      }
      release();
      await done;
      const result = await submitted;
      if (waitFor === 'commit')
        expect(result).toMatchObject({
          status: 'committed',
          changed: true,
          recordId: expect.any(String)
        });
      const actual = (await context.session!.inspect()).operations.at(-1)!;
      expect(actual).toMatchObject({ changed: true, recordId: expect.any(String) });
    }
  );

  it.each([false, true])(
    'keeps only physical idle input facts after failure (written=%s)',
    async (written) => {
      let context!: SessionExtensionContext;
      let enabled = false;
      const f = await fixture(
        [
          {
            id: 'idle-failure',
            apiVersion: '1.0',
            attachSession(value) {
              context = value;
              value.hooks.intercept('model.request', async (input, _call, next) => {
                if (enabled && written) throw new Error('model middleware failure after commit');
                return next(input);
              });
            }
          }
        ],
        () => answer()
      );
      await f.session.run({ prompt: 'initialize' }).result();
      const append = JsonlSessionStore.prototype.append;
      vi.spyOn(JsonlSessionStore.prototype, 'append').mockImplementation(async function (
        this: JsonlSessionStore,
        id,
        input,
        options
      ) {
        if (enabled && !written && input.type === 'extension.input')
          throw new Error('writer failure before commit');
        return append.call(this, id, input, options);
      });
      enabled = true;
      const receipt = await context.session!.submit({
        text: 'failed input',
        delivery: 'idle',
        waitFor: 'commit'
      });
      expect(receipt.recordId !== undefined).toBe(written);
      expect(receipt.changed === true).toBe(written);
      if (!written) expect(receipt.status).toBe('failed');
      await f.agent.dispose();
      expect(f.adapter.requests).toHaveLength(1);
    }
  );

  it.each([false, true])(
    'preserves explicit lifetime after a failed caller: %s',
    async (durable) => {
      let context!: SessionExtensionContext;
      let receipt!: ExtensionSessionReceipt;
      let first = true;
      const lifetime = new AbortController();
      const f = await fixture(
        [
          {
            id: 'submit-lifetime',
            apiVersion: '1.0',
            attachSession(value) {
              context = value;
              value.commands.register({
                name: 'enqueue',
                async handler() {
                  receipt = await value.session!.submit({
                    text: 'queued-prompt',
                    delivery: 'idle',
                    waitFor: 'start',
                    ...(durable ? { queueSignal: lifetime.signal } : {})
                  });
                  throw new Error('caller failed after admission');
                }
              });
              value.hooks.intercept('model.request', async (input, _call, next) => {
                if (first) {
                  first = false;
                  await expect(value.commands.run({ name: 'enqueue' })).rejects.toThrow(
                    'caller failed'
                  );
                  expect(receipt.status).toBe('accepted');
                }
                return next(input);
              });
            }
          }
        ],
        () => answer()
      );
      expect(await f.session.run({ prompt: 'initial' }).result()).toHaveProperty(
        'status',
        'completed'
      );
      await expect
        .poll(async () => (await context.session!.inspect()).operations[0]?.status)
        .toBe(durable ? 'completed' : 'cancelled');
      expect(f.adapter.requests).toHaveLength(durable ? 2 : 1);
      if (durable) {
        expect(
          f.adapter.requests[1]!.messages.some((message) => message.content === 'queued-prompt')
        ).toBe(true);
        expect((await context.session!.inspect()).operations[0]?.executionId).not.toBeUndefined();
      }
    }
  );

  it('cancels accepted work on the explicit lifetime without cancelling its caller', async () => {
    let context!: SessionExtensionContext;
    const lifetime = new AbortController();
    const f = await fixture(
      [
        {
          id: 'cancel-queued',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('model.request', async (input, call, next) => {
              const receipt = await value.session!.submit({
                text: 'never-sent',
                delivery: 'idle',
                waitFor: 'start',
                queueSignal: lifetime.signal
              });
              expect(receipt.status).toBe('accepted');
              lifetime.abort();
              expect(call.signal.aborted).toBe(false);
              return next(input);
            });
          }
        }
      ],
      () => answer()
    );
    expect(await f.session.run({ prompt: 'initial' }).result()).toHaveProperty(
      'status',
      'completed'
    );
    expect((await context.session!.inspect()).operations[0]).toHaveProperty('status', 'cancelled');
    expect(f.adapter.requests).toHaveLength(1);
  });

  it('returns an actual idle start receipt and retains owner cancellation', async () => {
    let context!: SessionExtensionContext;
    let held = false;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = await fixture(
      [
        {
          id: 'idle-start',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('model.request', async (input, call, next) => {
              if (!held) return next(input);
              entered();
              await new Promise<never>((_resolve, reject) => {
                if (call.signal.aborted) reject(call.signal.reason);
                else
                  call.signal.addEventListener('abort', () => reject(call.signal.reason), {
                    once: true
                  });
              });
              throw new Error('Held request must be cancelled.');
            });
          }
        }
      ],
      () => answer()
    );
    await f.session.run({ prompt: 'initial' }).result();
    held = true;
    const lifetime = new AbortController();
    const receipt = await context.session!.submit({
      text: 'held-prompt',
      delivery: 'idle',
      waitFor: 'start',
      queueSignal: lifetime.signal
    });
    expect(receipt).toMatchObject({
      status: 'in-progress',
      executionId: expect.any(String)
    });
    await started;
    await f.agent.dispose();
    expect(lifetime.signal.aborted).toBe(false);
    expect(f.adapter.requests).toHaveLength(1);
    await expect(
      context.session!.submit({ text: 'late', queueSignal: lifetime.signal })
    ).rejects.toThrow(/RETIRED/);
  });

  it('rejects invalid and pre-cancelled lifetimes without creating queue entries', async () => {
    let context!: SessionExtensionContext;
    const f = await fixture(
      [
        {
          id: 'invalid-lifetime',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
          }
        }
      ],
      () => answer()
    );
    await f.session.run({ prompt: 'initial' }).result();
    await expect(
      context.session!.submit({ text: 'invalid', queueSignal: {} as AbortSignal })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_INPUT_INVALID' });
    const reason = new Error('already cancelled');
    await expect(
      context.session!.submit({ text: 'cancelled', queueSignal: AbortSignal.abort(reason) })
    ).rejects.toBe(reason);
    expect((await context.session!.inspect()).operations).toEqual([]);
    expect(f.adapter.requests).toHaveLength(1);
  });
});
