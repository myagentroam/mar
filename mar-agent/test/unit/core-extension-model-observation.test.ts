import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { ModelEvent } from '../../src/model/contracts.js';
import { AnthropicMessagesAdapter } from '../../src/model/anthropic-messages.js';
import { OpenAiResponsesAdapter } from '../../src/model/openai-responses.js';
import type {
  ExtensionModelEvent,
  ExtensionOperationContext,
  SessionExtensionContext
} from '../../src/extensions.js';
import { fixture, answer, call, cleanupCoreFixtures } from './support/core-extension-fixture.js';

afterEach(cleanupCoreFixtures);

describe('Core normalized model fact observation', () => {
  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const)(
    'projects the same captured Code observation for independent %s generation',
    async (protocol) => {
      let context!: SessionExtensionContext;
      const f = await fixture(
        [
          {
            id: 'snapshot-projection',
            apiVersion: '1.0',
            attachSession(value) {
              context = value;
            }
          }
        ],
        (_request, index) =>
          index === 0 ? call('code_exec', { code: "observe.text('captured output');" }) : answer(),
        true,
        false,
        {},
        protocol
      );
      expect((await f.session.run({ prompt: 'capture' }).result()).status).toBe('completed');
      const snapshot = (await context.session!.captureRequest())!;
      const before = structuredClone(snapshot.request);
      const sent = f.adapter.requests[1]!;
      const toolOutput = sent.messages.find((message) => message.role === 'tool')!;
      expect(toolOutput.contentParts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('captured output')
          })
        ])
      );
      expect(toolOutput).not.toHaveProperty('observations');
      expect(toolOutput).not.toHaveProperty('calls');
      await context.models!.generate({ requestSnapshot: snapshot, retainToolCatalog: true });
      const replay = f.adapter.requests[2]!;
      expect(replay.messages).toEqual(sent.messages);
      expect(replay.tools).toEqual(sent.tools);
      expect(snapshot.request).toEqual(before);

      const bodies: Array<{ input?: unknown; messages?: unknown }> = [];
      const server = createServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => {
          body += chunk;
        });
        request.on('end', () => {
          bodies.push(JSON.parse(body));
          const events =
            protocol === 'OPENAI_RESPONSES'
              ? [
                  {
                    type: 'response.completed',
                    response: { id: 'fixture', status: 'completed', output: [] }
                  }
                ]
              : [
                  {
                    type: 'message_start',
                    message: {
                      id: 'fixture',
                      role: 'assistant',
                      content: [],
                      usage: { input_tokens: 1, output_tokens: 0 }
                    }
                  },
                  {
                    type: 'message_delta',
                    delta: { stop_reason: 'end_turn' },
                    usage: { output_tokens: 0 }
                  },
                  { type: 'message_stop' }
                ];
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing fixture address');
        const config = { ...f.adapter.configuration, baseUrl: `http://127.0.0.1:${address.port}` };
        const adapter =
          protocol === 'OPENAI_RESPONSES'
            ? new OpenAiResponsesAdapter(config)
            : new AnthropicMessagesAdapter(config);
        for (const request of [sent, replay]) {
          for await (const event of adapter.start(request, new AbortController().signal)) {
            expect(event).toBeDefined();
          }
        }
        expect(bodies).toHaveLength(2);
        expect(protocol === 'OPENAI_RESPONSES' ? bodies[1]!.input : bodies[1]!.messages).toEqual(
          protocol === 'OPENAI_RESPONSES' ? bodies[0]!.input : bodies[0]!.messages
        );
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  );

  it('keeps metering callbacks on dispatch but out of request snapshots and generates a new fork identity', async () => {
    let context!: SessionExtensionContext;
    const sink = vi.fn();
    const f = await fixture(
      [
        {
          id: 'metering',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
          }
        }
      ],
      () => answer(),
      false,
      true,
      { modelUsage: sink }
    );
    expect((await f.session.run({ prompt: 'metered request' }).result()).status).toBe('completed');
    const request = f.adapter.requests[0]!;
    expect(request.onModelUsage).toBeTypeOf('function');
    const snapshot = await context.session.captureRequest();
    expect(snapshot).toBeDefined();
    expect(snapshot!.request).not.toHaveProperty('onModelUsage');
    await context.models!.generate({ requestSnapshot: snapshot!, prompt: 'fork' });
    expect(f.adapter.requests[1]!.onModelUsage).toBeTypeOf('function');
    expect(f.adapter.requests[1]!.usageRequestId).not.toBe(request.usageRequestId);
  });
  it.each([false, true])(
    'preserves observer backpressure and closes the upstream on cancellation=%s',
    async (cancel) => {
      let context!: SessionExtensionContext;
      let armed = false;
      let intercepted = 0;
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const f = await fixture(
        [
          {
            id: 'pull-observer',
            apiVersion: '1.0',
            attachSession(current) {
              context = current;
              current.hooks.observe('model.event', async (event, call) => {
                if (!armed || event.type !== 'text.completed') return;
                entered();
                let abort!: () => void;
                const aborted = new Promise<void>((resolve) => {
                  abort = resolve;
                });
                call.signal.addEventListener('abort', abort, { once: true });
                try {
                  await Promise.race([gate, aborted]);
                } finally {
                  call.signal.removeEventListener('abort', abort);
                }
              });
              current.hooks.intercept('model.event', (event, _call, next) => {
                if (armed) intercepted++;
                return next(event);
              });
            }
          }
        ],
        () => answer(),
        false,
        true
      );
      await f.session.run({ prompt: 'initialize' }).result();
      let pulls = 0;
      let closed = 0;
      const spy = vi
        .spyOn(f.adapter, 'start')
        .mockImplementation(async function* (): AsyncGenerator<ModelEvent> {
          try {
            pulls++;
            yield { type: 'text.completed', itemId: 'answer', text: 'observed' };
            pulls++;
            yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } };
            pulls++;
            yield { type: 'completed', reason: 'completed' };
          } finally {
            closed++;
          }
        });
      const controller = new AbortController();
      armed = true;
      const pending = context.models!.generate({ prompt: 'pull', signal: controller.signal });
      const settled = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
      try {
        await ready;
        expect(pulls).toBe(1);
        expect(intercepted).toBe(0);
        if (cancel) controller.abort(new Error('cancel observed source'));
        else release();
        const result = await settled;
        if (cancel) {
          expect(result).toHaveProperty('error');
          expect(pulls).toBe(1);
          expect(intercepted).toBe(0);
        } else {
          expect(result).toMatchObject({
            value: { text: 'observed', usage: { inputTokens: 4, outputTokens: 2 } }
          });
          expect(pulls).toBe(3);
          expect(intercepted).toBe(3);
        }
        expect(closed).toBe(1);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        release();
        await settled;
        spy.mockRestore();
      }
    }
  );

  it('observes actual events before rewrite or omission and isolates observer mutation and failure', async () => {
    let context!: SessionExtensionContext;
    const facts: ExtensionModelEvent[] = [];
    const f = await fixture(
      [
        {
          id: 'model-facts',
          apiVersion: '1.0',
          attachSession(current) {
            context = current;
            current.hooks.observe('model.event', (event) => {
              if (event.type === 'text.completed') event.text = 'mutated copy';
              throw new Error('observer failure');
            });
            current.hooks.observe('model.event', (event) => {
              facts.push(event);
            });
            current.hooks.intercept('model.event', (event, _call, next) =>
              event.type === 'text.completed'
                ? next({ ...event, text: 'rewritten answer' })
                : event.type === 'text.delta'
                  ? undefined
                  : next(event)
            );
          }
        }
      ],
      () => [
        { type: 'text.delta', itemId: 'answer', phase: 'final_answer', delta: 'source delta' },
        { type: 'text.completed', itemId: 'answer', text: 'source answer' },
        { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } },
        { type: 'completed', reason: 'completed' }
      ],
      false,
      true
    );
    expect(await f.session.run({ prompt: 'actual source' }).result()).toMatchObject({
      status: 'completed',
      finalAnswer: 'rewritten answer'
    });
    expect(facts).toEqual([
      { type: 'text.delta', itemId: 'answer', phase: 'final_answer', delta: 'source delta' },
      { type: 'text.completed', itemId: 'answer', text: 'source answer' },
      { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } },
      { type: 'completed', reason: 'completed' }
    ]);
    expect(f.agent.extensionDiagnostics()).toContainEqual(
      expect.objectContaining({ code: 'MAR_AGENT_EXTENSION_OBSERVER_FAILED' })
    );
    expect((await context.session!.messages({ view: 'conversation' })).messages).toContainEqual(
      expect.objectContaining({ content: 'rewritten answer' })
    );
    expect(f.adapter.requests).toHaveLength(1);
  });

  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const)(
    'keeps %s source payload opaque in actual fact delivery',
    async (protocol) => {
      const facts: ExtensionModelEvent[] = [];
      const f = await fixture(
        [
          {
            id: 'opaque-facts',
            apiVersion: '1.0',
            attachSession(context) {
              context.hooks.observe('model.event', (event) => {
                facts.push(event);
              });
            }
          }
        ],
        () => [
          {
            type: 'response.item',
            provider: protocol,
            ...(protocol === 'ANTHROPIC_MESSAGES' ? { contextKind: 'private' as const } : {}),
            item:
              protocol === 'OPENAI_RESPONSES'
                ? { type: 'reasoning', encrypted_content: 'private-source' }
                : { type: 'thinking', thinking: 'private-source', signature: 'signed' }
          },
          ...answer()
        ],
        false,
        true,
        {},
        protocol
      );
      expect((await f.session.run({ prompt: 'private' }).result()).status).toBe('completed');
      expect(facts[0]).toEqual({ type: 'opaque', sourceRef: expect.any(String) });
      expect(JSON.stringify(facts)).not.toContain('private-source');
    }
  );

  it('observes independent generate and Compact on the shared entry without inventing an Execution', async () => {
    let context!: SessionExtensionContext;
    const facts: Array<{ event: ExtensionModelEvent; call: ExtensionOperationContext }> = [];
    const f = await fixture(
      [
        {
          id: 'all-model-facts',
          apiVersion: '1.0',
          attachSession(current) {
            context = current;
            current.hooks.observe('model.event', (event, call) => {
              facts.push({ event, call });
            });
          }
        }
      ],
      () => answer(),
      false,
      true
    );
    await f.session.run({ prompt: 'initialize' }).result();
    facts.length = 0;
    expect(await context.models!.generate({ prompt: 'independent' })).toMatchObject({
      text: 'done'
    });
    expect(facts.map(({ event }) => event.type)).toEqual(['text.completed', 'completed']);
    expect(
      facts.every(
        ({ call }) =>
          call.executionId === undefined &&
          call.entry === 'native-api' &&
          call.actor === 'extension'
      )
    ).toBe(true);
    facts.length = 0;
    expect((await f.session.compact().result()).status).toBe('completed');
    expect(facts.some(({ event }) => event.type === 'completed')).toBe(true);
    expect(facts.every(({ call }) => typeof call.executionId === 'string')).toBe(true);
    expect(f.adapter.requests).toHaveLength(3);
  });

  it('lets an observer call nested generate while skipping only its own active registration', async () => {
    let context!: SessionExtensionContext;
    let armed = false;
    const self: string[] = [];
    const other: string[] = [];
    const f = await fixture(
      [
        {
          id: 'nested-model-facts',
          apiVersion: '1.0',
          attachSession(current) {
            context = current;
            current.hooks.observe('model.event', async (event) => {
              if (!armed || event.type !== 'text.completed') return;
              self.push(event.text);
              if (event.text === 'outer')
                expect(await current.models!.generate({ prompt: 'nested' })).toMatchObject({
                  text: 'nested'
                });
            });
            current.hooks.observe('model.event', (event) => {
              if (armed && event.type === 'text.completed') other.push(event.text);
            });
          }
        }
      ],
      (request) => [
        {
          type: 'text.completed',
          itemId: 'answer',
          text: request.messages.at(-1)?.content ?? 'done'
        },
        { type: 'completed', reason: 'completed' }
      ],
      false,
      true
    );
    await f.session.run({ prompt: 'initialize' }).result();
    armed = true;
    expect(await context.models!.generate({ prompt: 'outer' })).toMatchObject({ text: 'outer' });
    expect(self).toEqual(['outer']);
    expect(other).toEqual(['nested', 'outer']);
    expect(f.adapter.requests).toHaveLength(3);
  });
});
