import { afterEach, describe, expect, it } from 'vitest';
import type { CoreSessionExtensionContext } from '../../src/agent-core/extensions/contracts.js';
import { fixture, answer, cleanupCoreFixtures } from './support/core-extension-fixture.js';

afterEach(cleanupCoreFixtures);

describe('Core prompt admission before the actual writer', () => {
  it('uses modelContext for input delivered at an active model boundary and after restoration', async () => {
    let queued = false;
    const f = await fixture(
      [
        {
          id: 'boundary-context',
          apiVersion: '1.0',
          attachSession(context) {
            context.hooks.intercept('model.request', async (input, _call, next) => {
              if (!queued) {
                queued = true;
                await context.session!.submit({
                  text: 'boundary',
                  context: ['raw boundary'],
                  modelContext: ['projected boundary']
                });
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
    expect(
      f.adapter.requests.some((request) =>
        request.messages.some((message) => message.content === 'projected boundary')
      )
    ).toBe(true);
    expect(await f.session.run({ prompt: 'restore' }).result()).toHaveProperty(
      'status',
      'completed'
    );
    expect(
      f.adapter.requests
        .at(-1)!
        .messages.some((message) => message.content === 'projected boundary')
    ).toBe(true);
    expect(
      f.adapter.requests.some((request) =>
        request.messages.some((message) => message.content === 'raw boundary')
      )
    ).toBe(false);
  });

  it('keeps full admitted context while native, queued and restored requests use modelContext', async () => {
    let context!: CoreSessionExtensionContext;
    const f = await fixture(
      [
        {
          id: 'context-projection',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('prompt.submit', async (input, call, next) => {
              const result = await next({
                ...input,
                context: [`original-${input.text}`],
                modelContext: [`projected-${input.text}`]
              });
              return result;
            });
          }
        }
      ],
      () => answer()
    );
    expect(await f.session.run({ prompt: 'native' }).result()).toHaveProperty(
      'status',
      'completed'
    );
    await context.session!.submit({ text: 'queued', delivery: 'idle', waitFor: 'start' });
    await expect
      .poll(async () => (await context.session!.inspect()).operations[0]?.status)
      .toBe('completed');
    expect(await f.session.run({ prompt: 'restore' }).result()).toHaveProperty(
      'status',
      'completed'
    );
    for (const request of f.adapter.requests) {
      expect(request.messages.some((message) => message.content.startsWith('original-'))).toBe(
        false
      );
      expect(request.messages.some((message) => message.content === 'projected-native')).toBe(true);
    }
    expect(
      f.adapter.requests[2]!.messages.some((message) => message.content === 'projected-queued')
    ).toBe(true);
    await expect(
      context.session!.submit({ text: 'invalid', modelContext: new Array(1) })
    ).rejects.toHaveProperty('code', 'MAR_AGENT_SESSION_INPUT_INVALID');
  });

  it('cancels a waiting admission without a late input write and allows the next run', async () => {
    let context!: CoreSessionExtensionContext;
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(
      [
        {
          id: 'cancel-admission',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('prompt.submit', async (input, _call, next) => {
              if (input.text === 'cancel') {
                entered();
                await gate;
              }
              return next(input);
            });
          }
        }
      ],
      () => answer()
    );
    const handle = f.session.run({ prompt: 'cancel' });
    await waiting;
    handle.cancel();
    release();
    expect(await handle.result()).toHaveProperty('status', 'cancelled');
    expect(f.adapter.requests).toHaveLength(0);
    expect((await context.session!.describe()).userTurns).toBe(0);
    expect(await f.session.run({ prompt: 'recover' }).result()).toHaveProperty(
      'status',
      'completed'
    );
    expect(f.adapter.requests).toHaveLength(1);
  });

  it('defers compaction queued by admission until the real compact callback is ready', async () => {
    let context!: CoreSessionExtensionContext;
    let queued = false;
    const f = await fixture(
      [
        {
          id: 'admission-compact',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('prompt.submit', async (input, _call, next) => {
              if (input.text === 'second') {
                const receipt = await value.session!.compact({ focus: 'retain input' });
                queued = receipt.status === 'queued';
              }
              return next(input);
            });
          }
        }
      ],
      () => answer()
    );
    await f.session.run({ prompt: 'first' }).result();
    expect(await f.session.run({ prompt: 'second' }).result()).toHaveProperty(
      'status',
      'completed'
    );
    expect(queued).toBe(true);
    const compact = (await context.session!.inspect()).operations.find(
      (entry) => entry.kind === 'compact'
    );
    expect(compact?.status).toBe('completed');
  });

  it('rejects malformed rewritten content before any native input write', async () => {
    let context!: CoreSessionExtensionContext;
    const f = await fixture(
      [
        {
          id: 'invalid-content',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('prompt.submit', (input, _call, next) =>
              next({ ...input, context: new Array(1) })
            );
          }
        }
      ],
      () => answer()
    );
    expect(await f.session.run({ prompt: 'never' }).result()).toMatchObject({
      status: 'failed',
      errorCode: 'MAR_AGENT_SESSION_INPUT_INVALID'
    });
    expect(f.adapter.requests).toHaveLength(0);
    expect((await context.session!.describe()).userTurns).toBe(0);
  });

  it('loads real tools, rewrites native input before storage, and preserves context on restore', async () => {
    let context!: CoreSessionExtensionContext;
    let calls = 0;
    const f = await fixture(
      [
        {
          id: 'input',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('prompt.submit', async (input, call, next) => {
              calls++;
              expect(call.actor).toBe('sdk');
              expect(value.tools.catalog().some((ref) => ref.definition.name === 'read')).toBe(
                true
              );
              const read = value.tools.catalog().find((ref) => ref.definition.name === 'read')!;
              expect(
                await value.tools.check({
                  name: 'read',
                  ref: read,
                  arguments: { reads: [{ path: 'input.txt' }] }
                })
              ).toMatchObject({ available: true });
              const result = await value.tools.invoke({
                name: 'read',
                ref: read,
                arguments: { reads: [{ path: 'input.txt' }] }
              });
              expect(JSON.stringify(result)).toContain('extension-data');
              expect(
                (await value.session!.messages()).messages.some(
                  (message) => message.role !== 'opaque' && message.content === input.text
                )
              ).toBe(false);
              return next({
                text: `recorded-${input.text}`,
                modelText: `model-${input.text}`,
                context: ['hidden']
              });
            });
          }
        }
      ],
      () => answer()
    );
    expect(await f.session.run({ prompt: 'one' }).result()).toHaveProperty('status', 'completed');
    expect(calls).toBe(1);
    const messages = (await context.session!.messages()).messages;
    const index = messages.findIndex(
      (message) => message.role !== 'opaque' && message.content === 'model-one'
    );
    expect(index).toBeGreaterThan(-1);
    expect(messages[index + 1]).toMatchObject({ content: 'hidden' });
    expect((await context.session!.describe()).userTurns).toBe(1);
    expect(await f.session.run({ prompt: 'two' }).result()).toHaveProperty('status', 'completed');
    const nextMessages = f.adapter.requests[1]!.messages;
    expect(nextMessages.some((message) => message.content === 'model-one')).toBe(true);
    expect(nextMessages.some((message) => message.content === 'model-two')).toBe(true);
    expect(calls).toBe(2);
  });

  it('does not write or request a model when native input is handled without next', async () => {
    let context!: CoreSessionExtensionContext;
    const f = await fixture(
      [
        {
          id: 'drop',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('prompt.submit', () => ({ value: { drop: 'handled' } }));
          }
        }
      ],
      () => answer()
    );
    expect(await f.session.run({ prompt: 'never' }).result()).toMatchObject({
      status: 'completed',
      inputHandled: true,
      finalAnswer: ''
    });
    expect(f.adapter.requests).toHaveLength(0);
    expect((await context.session!.describe()).userTurns).toBe(0);
    expect((await context.session!.messages()).messages).toEqual([]);
  });

  it('records a handled extension operation without admitting a queue item or model Turn', async () => {
    let context!: CoreSessionExtensionContext;
    const f = await fixture(
      [
        {
          id: 'handled-api',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('prompt.submit', (input, call, next) =>
              call.actor === 'sdk' ? next(input) : { value: { drop: 'handled' } }
            );
          }
        }
      ],
      () => answer()
    );
    await f.session.run({ prompt: 'initialize' }).result();
    const receipt = await context.session!.submit({
      text: 'never',
      delivery: 'idle',
      waitFor: 'start'
    });
    expect(receipt).toMatchObject({
      kind: 'submit',
      status: 'handled',
      changed: false,
      handledValue: { drop: 'handled' }
    });
    expect(receipt.executionId).toBeUndefined();
    expect((await context.session!.inspect()).operations).toEqual([receipt]);
    expect(f.adapter.requests).toHaveLength(1);
    expect(
      (await context.session!.messages()).messages.some(
        (message) => message.role !== 'opaque' && message.content === 'never'
      )
    ).toBe(false);
  });

  it('admits extension rewrites once and does not dispatch again when the queued Turn starts', async () => {
    let context!: CoreSessionExtensionContext;
    const seen: string[] = [];
    const f = await fixture(
      [
        {
          id: 'queued',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('prompt.submit', (input, _call, next) => {
              seen.push(input.text);
              return next({ ...input, text: `rewritten-${input.text}` });
            });
          }
        }
      ],
      () => answer()
    );
    await f.session.run({ prompt: 'initialize' }).result();
    await context.session!.submit({ text: 'automatic', delivery: 'idle', waitFor: 'start' });
    await expect
      .poll(async () => (await context.session!.inspect()).operations[0]?.status)
      .toBe('completed');
    expect(seen).toEqual(['initialize', 'automatic']);
    expect(f.adapter.requests).toHaveLength(2);
    expect(
      f.adapter.requests[1]!.messages.some((message) => message.content === 'rewritten-automatic')
    ).toBe(true);
  });

  it('serializes native multiple next calls into one immediate and one queued Turn without redispatch', async () => {
    let context!: CoreSessionExtensionContext;
    let calls = 0;
    const f = await fixture(
      [
        {
          id: 'multiple',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('prompt.submit', async (_input, _call, next) => {
              calls++;
              await Promise.all([next({ text: 'first' }), next({ text: 'second' })]);
              return { value: 'answer-not-a-write' };
            });
          }
        }
      ],
      () => answer()
    );
    expect(await f.session.run({ prompt: 'original' }).result()).toHaveProperty(
      'status',
      'completed'
    );
    await expect
      .poll(async () => (await context.session!.inspect()).operations[0]?.status)
      .toBe('completed');
    expect(calls).toBe(1);
    expect(f.adapter.requests).toHaveLength(2);
    expect((await context.session!.describe()).userTurns).toBe(2);
    expect(f.adapter.requests[0]!.messages.some((message) => message.content === 'first')).toBe(
      true
    );
    expect(f.adapter.requests[0]!.messages.some((message) => message.content === 'second')).toBe(
      false
    );
    expect(f.adapter.requests[1]!.messages.some((message) => message.content === 'second')).toBe(
      true
    );
  });

  it('can remove real image bytes before model capability checks or image persistence', async () => {
    let sawImage = false;
    const f = await fixture(
      [
        {
          id: 'images',
          apiVersion: '1.0',
          attachSession(value) {
            value.hooks.intercept('prompt.submit', (input, _call, next) => {
              sawImage = input.images?.[0]?.dataBase64 === 'aGVsbG8=';
              return next({ text: input.text });
            });
          }
        }
      ],
      () => answer()
    );
    expect(
      await f.session
        .run({
          prompt: 'image',
          images: [{ name: 'x.png', mimeType: 'image/png', dataBase64: 'aGVsbG8=' }]
        })
        .result()
    ).toHaveProperty('status', 'completed');
    expect(sawImage).toBe(true);
    expect(f.adapter.requests[0]!.images).toBeUndefined();
  });

  it('keeps an actual native write if its hook fails after next and recovers on the next run', async () => {
    let context!: CoreSessionExtensionContext;
    let fail = true;
    const f = await fixture(
      [
        {
          id: 'failure',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('prompt.submit', async (input, _call, next) => {
              const result = await next(input);
              if (fail) throw new Error('after write');
              return result;
            });
          }
        }
      ],
      () => answer()
    );
    expect(await f.session.run({ prompt: 'committed' }).result()).toHaveProperty(
      'status',
      'failed'
    );
    expect(f.adapter.requests).toHaveLength(0);
    expect(
      (await context.session!.messages()).messages.some(
        (message) => message.role !== 'opaque' && message.content === 'committed'
      )
    ).toBe(true);
    fail = false;
    expect(await f.session.run({ prompt: 'recover' }).result()).toHaveProperty(
      'status',
      'completed'
    );
    expect(f.adapter.requests).toHaveLength(1);
  });
});
