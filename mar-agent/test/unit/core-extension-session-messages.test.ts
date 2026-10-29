import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionExtensionContext } from '../../src/extensions.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import type { ExtensionResourceScope } from '../../src/extensions/resources.js';
import {
  normalizeSessionMessagesInput,
  sessionMessagesPage
} from '../../src/extensions/session-messages.js';
import { restoreMessages } from '../../src/runtime/context/restore.js';
import { ContextGcRuntime } from '../../src/runtime/context/gc-runtime.js';
import { buildContextProjection } from '../../src/runtime/context/projection.js';
import { activeSessionDirectory } from '../support/jsonl-session-path.js';
import { createSessionExtensionMessages } from '../../src/sdk/session-extension-messages.js';
import type { ResolvedModelConfiguration } from '../../src/sdk/model-runtime.js';
import { fixture, answer, call, cleanupCoreFixtures } from './support/core-extension-fixture.js';

afterEach(cleanupCoreFixtures);

async function messagesFixture(codeMode = false) {
  let context!: SessionExtensionContext;
  const contexts = new Map<string, SessionExtensionContext>();
  const f = await fixture(
    [
      {
        id: 'session-reader',
        apiVersion: '1.0',
        attachSession(current) {
          contexts.set(current.sessionId, current);
          if (!context) context = current;
        }
      }
    ],
    (_request, index) =>
      codeMode && index === 0
        ? call(
            'code_exec',
            'const result = await tools.read({reads:[{path:"input.txt"}]}); observe.result(result);'
          ).map((event) =>
            event.type === 'client_tool.call' ? { ...event, inputMode: 'freeform' as const } : event
          )
        : answer(),
    codeMode,
    true
  );
  expect((await f.session.run({ prompt: 'initialize messages' }).result()).status).toBe(
    'completed'
  );
  const store = await JsonlSessionStore.open(f.home);
  if (!context.session) throw new Error('Session API is unavailable.');
  return { ...f, context, contexts, api: context.session, store };
}

describe('Core Session active message views', () => {
  it.each([true, false])(
    'projects a cold completed child using its own image and Code Mode configuration (%s)',
    async (childCapabilities) => {
      const f = await messagesFixture();
      try {
        const child = await f.store.createSession({
          workspace: f.home,
          source: { type: 'user', parentSessionId: f.session.id }
        });
        await f.store.append(child.id, {
          type: 'execution.header',
          executionId: 'child-execution',
          turnId: 'child-turn',
          payload: { modelId: 'child-model' }
        });
        const images = await f.store.persistInputImages(child.id, [
          {
            name: 'image.png',
            mimeType: 'image/png',
            dataBase64: Buffer.from('pixels').toString('base64')
          }
        ]);
        await f.store.append(child.id, {
          type: 'turn.user',
          turnId: 'child-turn',
          payload: { prompt: 'child image', images }
        });
        await f.store.append(child.id, {
          type: 'model.context',
          payload: {
            role: 'tool_call',
            callId: 'search',
            name: 'tool_search',
            arguments: { query: 'echo' }
          }
        });
        await f.store.append(child.id, {
          type: 'model.context',
          payload: {
            role: 'tool',
            callId: 'search',
            content: 'original search',
            toolSearchTools: [
              { name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }
            ]
          }
        });
        await f.store.append(child.id, {
          type: 'execution.completed',
          executionId: 'child-execution',
          turnId: 'child-turn',
          payload: {}
        });
        const parentModel = {
          ...f.adapter.configuration,
          id: 'parent-model',
          inputCapabilities: childCapabilities ? ['TEXT'] : ['TEXT', 'IMAGE'],
          codeMode: !childCapabilities
        } as ResolvedModelConfiguration;
        const childModel = {
          ...f.adapter.configuration,
          id: 'child-model',
          inputCapabilities: childCapabilities ? ['TEXT', 'IMAGE'] : ['TEXT'],
          codeMode: childCapabilities
        } as ResolvedModelConfiguration;
        const read = createSessionExtensionMessages({
          sessionId: f.session.id,
          store: f.store,
          runtime: () => undefined,
          models: () => ({
            defaultModelId: 'parent-model',
            models: new Map([
              ['parent-model', parentModel],
              ['child-model', childModel]
            ])
          })
        });
        const page = await read(
          { agentId: child.id, view: 'request', includeImages: true },
          {
            operationId: 'read',
            sessionId: f.session.id,
            sessionEpoch: 0,
            actor: 'extension',
            entry: 'native-api',
            signal: new AbortController().signal
          }
        );
        const user = page.messages.find((message) => message.role === 'user');
        expect(user?.role === 'user' && !!user.images?.length).toBe(childCapabilities);
        const search = page.messages.find(
          (message) => message.role === 'tool' && message.callId === 'search'
        );
        expect(search?.role === 'tool' && search.content !== 'original search').toBe(
          childCapabilities
        );
      } finally {
        await f.store.close();
      }
    }
  );

  it('orders an append admitted during checkpoint commit after the checkpoint without losing it', async () => {
    const f = await messagesFixture();
    const commit = JsonlSessionStore.prototype.compact;
    let late: ReturnType<typeof f.api.append> | undefined;
    const spy = vi
      .spyOn(JsonlSessionStore.prototype, 'compact')
      .mockImplementationOnce(async function (this: JsonlSessionStore, sessionId, input) {
        // Admit concurrently, but do not wait on a write from inside the writer itself.
        late = f.api.append({ content: 'after checkpoint admission', delivery: 'immediate' });
        return commit.call(this, sessionId, input);
      });
    try {
      expect((await f.session.compact().result()).status).toBe('completed');
      expect(await late).toMatchObject({ status: 'committed', recordId: expect.any(String) });
      const records = await f.store.read(f.session.id);
      const checkpoint = records.find((record) => record.type === 'compact.completed')!;
      const note = records.find(
        (record) =>
          record.type === 'model.context' &&
          (record.payload as { content?: string }).content === 'after checkpoint admission'
      )!;
      expect(note.sequence).toBeGreaterThan(checkpoint.sequence);
      expect((await f.session.run({ prompt: 'resume' }).result()).status).toBe('completed');
      expect(
        f.adapter.requests
          .at(-1)!
          .messages.filter((message) => message.content === 'after checkpoint admission')
      ).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it.each(['model.request', 'prompt.compose'] as const)(
    'retains immediate notes across automatic compact replacement and resume (%s)',
    async (hook) => {
      let compacting = false;
      const f = await fixture(
        [
          {
            id: 'automatic-note',
            apiVersion: '1.0',
            attachSession(value) {
              value.hooks.intercept('session.compact', async (input, _call, next) => {
                compacting = true;
                try {
                  return await next(input);
                } finally {
                  compacting = false;
                }
              });
              value.hooks.intercept(hook, async (input, _call, next) => {
                if (compacting)
                  expect(
                    (
                      await value.session!.append({
                        content: 'automatic late note',
                        delivery: 'immediate'
                      })
                    ).status
                  ).toBe('committed');
                return next(input);
              });
            }
          }
        ],
        (_request, index) =>
          index === 0
            ? [
                ...answer().slice(0, 1),
                {
                  type: 'usage',
                  usage: { inputTokens: 190_000, contextInputTokens: 190_000, outputTokens: 1 }
                },
                { type: 'completed', reason: 'completed' }
              ]
            : answer(),
        false,
        true
      );
      expect((await f.session.run({ prompt: 'initialize' }).result()).status).toBe('completed');
      expect((await f.session.run({ prompt: 'trigger compact' }).result()).status).toBe(
        'completed'
      );
      expect(f.adapter.requests).toHaveLength(3);
      expect(
        f.adapter.requests[2]!.messages.filter(
          (message) => message.content === 'automatic late note'
        )
      ).toHaveLength(1);
      expect((await f.session.run({ prompt: 'resume' }).result()).status).toBe('completed');
      expect(
        f.adapter.requests[3]!.messages.filter(
          (message) => message.content === 'automatic late note'
        )
      ).toHaveLength(1);
    }
  );

  it.each([false, true])(
    'merges immediate notes around a GC read without duplication (included=%s)',
    async (included) => {
      let context!: SessionExtensionContext;
      const f = await fixture(
        [
          {
            id: 'gc-note',
            apiVersion: '1.0',
            attachSession(value) {
              context = value;
            }
          }
        ],
        (_request, index) =>
          index === 0
            ? [
                ...call('read', { reads: [{ path: 'input.txt' }] }).slice(0, 1),
                {
                  type: 'usage',
                  usage: { inputTokens: 100, contextInputTokens: 100, outputTokens: 1 }
                },
                { type: 'completed', reason: 'tool_use' }
              ]
            : answer(),
        false,
        true
      );
      const run = vi
        .spyOn(ContextGcRuntime.prototype, 'run')
        .mockImplementationOnce(async (input) => {
          const append = async () =>
            expect(
              (await context.session!.append({ content: 'GC late note', delivery: 'immediate' }))
                .status
            ).toBe('committed');
          if (included) await append();
          const { contextRecords: records } = await input.store.readExecutionState(input.sessionId);
          if (!included) await append();
          return { records, projection: buildContextProjection(records) };
        });
      try {
        expect((await f.session.run({ prompt: 'read input' }).result()).status).toBe('completed');
        expect(run).toHaveBeenCalled();
        expect(
          f.adapter.requests[1]!.messages.filter((message) => message.content === 'GC late note')
        ).toHaveLength(1);
        expect((await f.session.run({ prompt: 'resume' }).result()).status).toBe('completed');
        expect(
          f.adapter.requests[2]!.messages.filter((message) => message.content === 'GC late note')
        ).toHaveLength(1);
      } finally {
        run.mockRestore();
      }
    }
  );

  it('keeps a committed immediate note when the compact model fails', async () => {
    let compacting = false;
    const f = await fixture(
      [
        {
          id: 'failed-compact-note',
          apiVersion: '1.0',
          attachSession(value) {
            value.hooks.intercept('model.request', async (input, _call, next) => {
              if (compacting)
                expect(
                  (
                    await value.session!.append({
                      content: 'survives failed compact',
                      delivery: 'immediate'
                    })
                  ).status
                ).toBe('committed');
              return next(input);
            });
          }
        }
      ],
      () => (compacting ? [{ type: 'completed', reason: 'completed' }] : answer()),
      false,
      true
    );
    await f.session.run({ prompt: 'initialize' }).result();
    compacting = true;
    expect((await f.session.compact().result()).status).toBe('failed');
    compacting = false;
    expect((await f.session.run({ prompt: 'resume' }).result()).status).toBe('completed');
    expect(
      f.adapter.requests
        .at(-1)!
        .messages.filter((message) => message.content === 'survives failed compact')
    ).toHaveLength(1);
  });

  it('preserves immediate notes committed after the manual compact snapshot on resume', async () => {
    let compacting = false;
    let recordId: string | undefined;
    const f = await fixture(
      [
        {
          id: 'compact-note',
          apiVersion: '1.0',
          attachSession(value) {
            value.hooks.intercept('model.request', async (input, _call, next) => {
              if (compacting) {
                const receipt = await value.session!.append({
                  content: 'late compact note',
                  textBlocks: [{ text: 'late ' }, { text: 'compact note' }],
                  delivery: 'immediate'
                });
                expect(receipt.status).toBe('committed');
                recordId = receipt.recordId;
              }
              return next(input);
            });
          }
        }
      ],
      () => answer(),
      false,
      true
    );
    expect((await f.session.run({ prompt: 'before compact' }).result()).status).toBe('completed');
    compacting = true;
    expect((await f.session.compact().result()).status).toBe('completed');
    compacting = false;
    expect(recordId).toEqual(expect.any(String));
    expect((await f.session.run({ prompt: 'after compact' }).result()).status).toBe('completed');
    const notes = f.adapter.requests
      .at(-1)!
      .messages.filter((message) => message.content === 'late compact note');
    expect(notes).toEqual([
      {
        role: 'user',
        content: 'late compact note',
        contextKind: 'contextual',
        textBlocks: [{ text: 'late ' }, { text: 'compact note' }]
      }
    ]);
    const store = await JsonlSessionStore.open(f.home);
    expect(
      (await store.read(f.session.id)).filter((record) => record.recordId === recordId)
    ).toHaveLength(1);
  });

  it('commits immediate model notes inside a request hook without waking another round', async () => {
    let context!: SessionExtensionContext;
    let written = false;
    const f = await fixture(
      [
        {
          id: 'immediate',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('model.request', async (input, _call, next) => {
              if (!written) {
                written = true;
                const receipt = await value.session!.append({
                  content: 'immediate note',
                  delivery: 'immediate'
                });
                expect(receipt).toMatchObject({
                  status: 'committed',
                  recordId: expect.any(String)
                });
                expect(
                  JSON.stringify(
                    (await value.session!.messages({ view: 'request', limit: 1000 })).messages
                  )
                ).toContain('immediate note');
              }
              return next(input);
            });
          }
        }
      ],
      () => answer(),
      false,
      true
    );
    expect((await f.session.run({ prompt: 'first' }).result()).status).toBe('completed');
    expect(f.adapter.requests).toHaveLength(1);
    expect(JSON.stringify(f.adapter.requests[0]!.messages)).not.toContain('immediate note');
    expect((await f.session.run({ prompt: 'second' }).result()).status).toBe('completed');
    expect(JSON.stringify(f.adapter.requests[1]!.messages)).toContain('immediate note');
    expect((await context.session!.inspect()).operations[0]?.status).toBe('committed');
  });

  it('commits during a tool hook and projects the note after the complete tool pair', async () => {
    const f = await fixture(
      [
        {
          id: 'immediate-tool',
          apiVersion: '1.0',
          attachSession(value) {
            value.hooks.intercept('tool.invoke', async (input, _call, next) => {
              const receipt = await value.session!.append({
                content: 'during tool',
                delivery: 'immediate'
              });
              expect(receipt.status).toBe('committed');
              return next(input);
            });
          }
        }
      ],
      (_request, index) =>
        index === 0 ? call('read', { reads: [{ path: 'input.txt' }] }) : answer()
    );
    expect((await f.session.run({ prompt: 'read input' }).result()).status).toBe('completed');
    expect(f.adapter.requests).toHaveLength(2);
    const messages = f.adapter.requests[1]!.messages;
    expect(messages.findIndex((message) => message.content === 'during tool')).toBeGreaterThan(
      messages.findIndex((message) => message.role === 'tool' && message.callId === 'call')
    );
  });

  it('commits an immediate transcript notice inside a hook without adding model context', async () => {
    const f = await fixture(
      [
        {
          id: 'immediate-notice',
          apiVersion: '1.0',
          attachSession(value) {
            value.hooks.intercept('model.request', async (input, _call, next) => {
              const receipt = await value.session!.append({
                content: 'immediate notice',
                visibility: 'transcript',
                delivery: 'immediate'
              });
              expect(receipt).toMatchObject({ status: 'committed', recordId: expect.any(String) });
              expect(
                JSON.stringify(
                  (await value.session!.messages({ view: 'request', limit: 1000 })).messages
                )
              ).not.toContain('immediate notice');
              return next(input);
            });
          }
        }
      ],
      () => answer()
    );
    expect((await f.session.run({ prompt: 'first' }).result()).status).toBe('completed');
    expect(f.adapter.requests).toHaveLength(1);
  });

  it('returns actual append record identities and keeps notices out of model history', async () => {
    const f = await messagesFixture();
    try {
      const note = await f.api.append({
        content: 'firstsecond',
        textBlocks: [{ text: 'first' }, { text: 'second' }]
      });
      const notice = await f.api.append({ content: 'private notice', visibility: 'transcript' });
      const records = (await f.store.readExecutionState(f.session.id)).contextRecords;
      expect(records.find((record) => record.recordId === note.recordId)).toMatchObject({
        type: 'model.context',
        payload: { textBlocks: [{ text: 'first' }, { text: 'second' }] }
      });
      expect(records.find((record) => record.recordId === notice.recordId)).toMatchObject({
        type: 'session.notice',
        payload: { content: 'private notice' }
      });
      expect(notice).toMatchObject({ status: 'committed', changed: true });
      expect(note.recordId).not.toBe(notice.recordId);
      const messages = (await f.api.messages({ view: 'request', limit: 1000 })).messages;
      expect(messages.at(-1)).toMatchObject({
        content: 'firstsecond',
        textBlocks: [{ text: 'first' }, { text: 'second' }]
      });
      expect(JSON.stringify(messages)).not.toContain('private notice');
      expect(f.adapter.requests).toHaveLength(1);
      await expect(
        f.api.append({ content: 'mismatch', textBlocks: [{ text: 'other' }] })
      ).rejects.toHaveProperty('code', 'MAR_AGENT_SESSION_INPUT_INVALID');
      await expect(f.api.append({ content: '', textBlocks: new Array(1) })).rejects.toHaveProperty(
        'code',
        'MAR_AGENT_SESSION_INPUT_INVALID'
      );
    } finally {
      await f.store.close();
    }
  });

  it('commits a queued notice without starting an extra model round', async () => {
    let context!: SessionExtensionContext;
    const f = await fixture(
      [
        {
          id: 'notice',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            let first = true;
            value.hooks.intercept('model.request', async (input, _call, next) => {
              if (first) {
                first = false;
                const receipt = await value.session!.append({
                  content: 'notice during generation',
                  visibility: 'transcript'
                });
                expect(receipt.status).toBe('queued');
                expect(receipt.recordId).toBeUndefined();
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
    expect(f.adapter.requests).toHaveLength(1);
    expect((await context.session!.inspect()).operations[0]).toMatchObject({
      status: 'committed',
      changed: true,
      recordId: expect.any(String)
    });
    expect(
      JSON.stringify((await context.session!.messages({ view: 'request', limit: 1000 })).messages)
    ).not.toContain('notice during generation');
  });

  it('reads the current normalized request source during execution and releases it afterward', async () => {
    let context!: SessionExtensionContext;
    let comparisons = 0;
    const f = await fixture(
      [
        {
          id: 'live-request-view',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('model.request', async (input, _call, next) => {
              const view = await value.session!.messages({ view: 'request', limit: 10000 });
              const shape = (messages: typeof input.messages) =>
                messages.map((message) =>
                  message.role === 'opaque'
                    ? { role: 'opaque' }
                    : {
                        role: message.role,
                        content: message.content,
                        callId: message.callId,
                        name: message.name
                      }
                );
              expect(shape(view.messages)).toEqual(shape(input.messages));
              comparisons++;
              return next(input);
            });
          }
        }
      ],
      (_request, index) =>
        index === 0 ? call('read', { reads: [{ path: 'input.txt' }] }) : answer()
    );
    expect(await f.session.run({ prompt: 'current request' }).result()).toHaveProperty(
      'status',
      'completed'
    );
    expect(comparisons).toBe(2);
    await context.session!.append({ content: 'after execution' });
    const view = await context.session!.messages({ view: 'request', limit: 10000 });
    expect(view.messages.at(-1)).toMatchObject({ role: 'user', content: 'after execution' });
    expect(
      view.messages.some((message) => message.role === 'assistant' && message.content === 'done')
    ).toBe(true);
    expect(f.adapter.requests).toHaveLength(2);
  });

  it('correlates stored tool outcomes by Execution and never guesses a missing outcome', async () => {
    const f = await messagesFixture();
    try {
      for (const executionId of ['success', 'failure', 'unknown']) {
        await f.store.append(f.session.id, {
          type: 'model.context',
          executionId,
          payload: { role: 'tool_call', callId: 'same', name: 'sample', arguments: {} }
        });
        if (executionId !== 'unknown')
          await f.store.append(f.session.id, {
            executionId,
            type: executionId === 'failure' ? 'tool.failed' : 'tool.completed',
            payload: {
              callId: 'same',
              ...(executionId === 'failure'
                ? { message: 'actual failure' }
                : { data: { value: 'error-looking success' } })
            }
          });
        await f.store.append(f.session.id, {
          type: 'model.context',
          executionId,
          payload: { role: 'tool', callId: 'same', content: 'model-visible text' }
        });
      }
      const page = await f.api.messages({ view: 'conversation' });
      const tools = page.messages.filter((message) => message.role === 'tool');
      expect(
        tools.map((message) => (message.role === 'opaque' ? undefined : message.toolOutcome))
      ).toEqual([
        { isError: false, result: { value: 'error-looking success' } },
        { isError: true, result: 'actual failure' },
        undefined
      ]);
    } finally {
      await f.store.close();
    }
  });

  it('validates input containers and keeps private non-Provider context opaque', () => {
    expect(() => normalizeSessionMessagesInput([] as never)).toThrow(/SESSION_INPUT_INVALID/);
    expect(() => normalizeSessionMessagesInput({ limit: null } as never)).toThrow(
      /SESSION_INPUT_INVALID/
    );
    const messages = [
      { role: 'user' as const, content: 'private payload', contextKind: 'private' as const }
    ];
    expect(sessionMessagesPage(messages, normalizeSessionMessagesInput({})).messages).toEqual([
      { role: 'opaque', sourceRef: expect.any(String) }
    ]);
    expect(
      sessionMessagesPage(messages, normalizeSessionMessagesInput({ view: 'conversation' }))
        .messages
    ).toEqual([]);
    expect(messages[0]?.content).toBe('private payload');
  });
  it('separates model and conversation context without exposing Provider payloads', async () => {
    const f = await messagesFixture();
    try {
      await f.store.append(f.session.id, {
        type: 'model.context',
        payload: {
          role: 'provider',
          provider: 'OPENAI_RESPONSES',
          item: { type: 'reasoning', encrypted_content: 'private-sentinel' }
        }
      });
      await f.api.append({ content: 'native note', attribution: 'test' });
      const model = await f.api.messages();
      const conversation = await f.api.messages({ view: 'conversation' });
      expect(model.messages.some((message) => message.role === 'opaque')).toBe(true);
      expect(
        model.messages.some(
          (message) => message.role !== 'opaque' && message.contextKind === 'environment'
        )
      ).toBe(true);
      expect(conversation.messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'user'
      ]);
      expect(conversation.messages.at(-1)).toMatchObject({ content: 'native note' });
      expect(JSON.stringify(model)).not.toContain('private-sentinel');
      expect(f.adapter.requests).toHaveLength(1);
      expect(Object.isFrozen(conversation.messages)).toBe(true);
      expect(conversation.messages.every(Object.isFrozen)).toBe(true);
      expect((await f.api.messages({ view: 'conversation', limit: 1 })).nextCursor).toBe('1');
      expect(
        (await f.api.messages({ view: 'conversation', cursor: '1', limit: 1 })).messages
      ).toEqual([expect.objectContaining({ role: 'assistant', content: 'done' })]);
    } finally {
      await f.store.close();
    }
  });

  it('retains actual Code Mode calls and observations without parsing model text', async () => {
    const f = await messagesFixture(true);
    try {
      const page = await f.api.messages({ view: 'conversation' });
      const invocation = page.messages.find((message) => message.role === 'tool_call');
      const output = page.messages.find((message) => message.role === 'tool');
      expect(invocation).toMatchObject({ name: 'code_exec', inputMode: 'freeform' });
      expect(output).toMatchObject({
        calls: [expect.objectContaining({ toolName: 'read', status: 'completed' })],
        observations: [
          expect.objectContaining({
            type: 'tool_result',
            source: expect.objectContaining({ toolName: 'read' })
          })
        ]
      });
      if (!output || output.role !== 'tool') throw new Error('Missing tool output.');
      expect(Object.isFrozen(output.calls)).toBe(true);
      expect(f.adapter.requests).toHaveLength(2);
      await f.store.append(f.session.id, {
        type: 'model.context',
        payload: {
          role: 'tool_call',
          callId: 'orphan',
          name: 'read',
          arguments: {}
        }
      });
      expect(
        (await f.api.messages()).messages.some(
          (message) => message.role !== 'opaque' && message.callId === 'orphan'
        )
      ).toBe(false);
    } finally {
      await f.store.close();
    }
  });

  it('preserves Tool Search definitions and copied structured results', async () => {
    const f = await messagesFixture();
    try {
      await f.store.append(f.session.id, {
        type: 'model.context',
        payload: {
          role: 'tool_call',
          callId: 'search',
          name: 'tool_search',
          arguments: { query: 'echo' },
          inputMode: 'json'
        }
      });
      await f.store.append(f.session.id, {
        type: 'model.context',
        payload: {
          role: 'tool',
          callId: 'search',
          content: 'bounded output',
          toolSearchTools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
          calls: [
            {
              callId: 'nested',
              toolName: 'echo',
              input: {},
              status: 'completed',
              result: { content: 'original', data: { n: 7 } }
            }
          ]
        }
      });
      const result = (await f.api.messages()).messages.find(
        (message) => message.role === 'tool' && message.callId === 'search'
      );
      expect(result).toMatchObject({
        toolSearchTools: [{ name: 'echo' }],
        calls: [{ result: { data: { n: 7 } } }]
      });
      const copy = structuredClone(result);
      if (copy?.role === 'tool' && copy.calls?.[0]?.result)
        copy.calls[0].result.content = 'changed';
      expect((await f.api.messages()).messages).toContainEqual(
        expect.objectContaining({
          calls: [expect.objectContaining({ result: { content: 'original', data: { n: 7 } } })]
        })
      );
    } finally {
      await f.store.close();
    }
  });

  it('reads actual children without starting executions and rejects foreign targets', async () => {
    const f = await messagesFixture();
    try {
      const child = await f.agent.createSession({
        workspace: f.home,
        parentSessionId: f.session.id
      });
      expect((await child.run({ prompt: 'child message' }).result()).status).toBe('completed');
      const count = f.adapter.requests.length;
      const page = await f.api.messages({ agentId: child.id, view: 'conversation' });
      expect(page.messages).toEqual([
        expect.objectContaining({ role: 'user', content: 'child message' }),
        expect.objectContaining({ role: 'assistant', content: 'done' })
      ]);
      const other = await f.agent.createSession({ workspace: f.home, title: 'Other parent' });
      await expect(f.api.messages({ agentId: other.id })).rejects.toMatchObject({
        code: 'MAR_AGENT_SUBAGENT_NOT_FOUND'
      });
      await expect(f.api.messages({ agentId: 'missing' })).rejects.toMatchObject({
        code: 'MAR_AGENT_SUBAGENT_NOT_FOUND'
      });
      expect(f.adapter.requests).toHaveLength(count);
      const foreign = await f.agent.createSession({ workspace: f.home, parentSessionId: other.id });
      await expect(f.api.messages({ agentId: foreign.id })).rejects.toMatchObject({
        code: 'MAR_AGENT_SUBAGENT_NOT_FOUND'
      });
    } finally {
      await f.store.close();
    }
  });

  it('lets a child inspect direct descendants without exposing its parent', async () => {
    let childContext!: SessionExtensionContext;
    let childId = '';
    const f = await fixture(
      [
        {
          id: 'child-reader',
          apiVersion: '1.0',
          attachSession(current) {
            if (current.sessionId === childId) childContext = current;
          }
        }
      ],
      () => answer(),
      false,
      true
    );
    const child = await f.agent.createSession({ workspace: f.home, parentSessionId: f.session.id });
    childId = child.id;
    await child.run({ prompt: 'child' }).result();
    expect((await childContext.session!.messages({ view: 'conversation' })).messages).toHaveLength(
      2
    );
    await expect(childContext.session!.messages({ agentId: f.session.id })).rejects.toMatchObject({
      code: 'MAR_AGENT_SUBAGENT_NOT_FOUND'
    });
    const grandchild = await f.agent.createSession({
      workspace: f.home,
      parentSessionId: child.id
    });
    await grandchild.run({ prompt: 'grandchild' }).result();
    expect(
      (await childContext.session!.messages({ agentId: grandchild.id, view: 'conversation' }))
        .messages
    ).toEqual(expect.arrayContaining([expect.objectContaining({ content: 'grandchild' })]));
  });

  it.each([
    ['OPENAI_RESPONSES', false],
    ['OPENAI_RESPONSES', true],
    ['ANTHROPIC_MESSAGES', false],
    ['ANTHROPIC_MESSAGES', true]
  ] as const)(
    'keeps a single actual tool pair in the %s conversation view with Code Mode %s',
    async (protocol, codeMode) => {
      let context!: SessionExtensionContext;
      const f = await fixture(
        [
          {
            id: 'protocol-view',
            apiVersion: '1.0',
            attachSession(current) {
              context = current;
            }
          }
        ],
        (_request, index) =>
          index === 0
            ? [
                {
                  type: 'response.item',
                  provider: protocol,
                  ...(protocol === 'ANTHROPIC_MESSAGES' ? { contextKind: 'private' as const } : {}),
                  item:
                    protocol === 'OPENAI_RESPONSES'
                      ? { type: 'reasoning', encrypted_content: 'hidden-provider-state' }
                      : {
                          type: 'thinking',
                          thinking: 'hidden-provider-state',
                          signature: 'signed-state'
                        }
                },
                ...call(
                  codeMode ? 'code_exec' : 'read',
                  codeMode
                    ? 'observe.result(await tools.read({reads:[{path:"input.txt"}]}));'
                    : { reads: [{ path: 'input.txt' }] }
                )
              ]
            : answer(),
        codeMode,
        true,
        {},
        protocol
      );
      expect((await f.session.run({ prompt: 'run actual tool' }).result()).status).toBe(
        'completed'
      );
      const page = await context.session!.messages({ view: 'conversation' });
      expect(page.messages.filter((message) => message.role === 'tool_call')).toHaveLength(1);
      expect(page.messages.filter((message) => message.role === 'tool')).toHaveLength(1);
      expect(page.messages.some((message) => message.role === 'opaque')).toBe(false);
      expect(
        (await context.session!.messages()).messages.some((message) => message.role === 'opaque')
      ).toBe(true);
      expect(JSON.stringify(page)).not.toContain('hidden-provider-state');
      expect(f.adapter.requests).toHaveLength(2);
    }
  );

  it('reads explicit resource pixels from the active request without mutating its source', async () => {
    const dataBase64 = Buffer.from('pixels').toString('base64');
    let observed: unknown;
    const f = await fixture(
      [
        {
          id: 'live-resource-reader',
          apiVersion: '1.0',
          attachSession(context) {
            context.hooks.intercept('model.request', async (input, _call, next) => {
              const original = JSON.stringify(input.messages);
              observed = await context.session!.messages({ view: 'request', includeImages: true });
              expect(JSON.stringify(input.messages)).toBe(original);
              return next(input);
            });
          }
        }
      ],
      () => answer(),
      false,
      false,
      {},
      'OPENAI_RESPONSES',
      ['TEXT', 'IMAGE']
    );
    expect(
      await f.session
        .run({
          prompt: 'with image',
          images: [{ name: 'image.png', mimeType: 'image/png', dataBase64 }]
        })
        .result()
    ).toMatchObject({ status: 'completed' });
    expect(await f.session.run({ prompt: 'continue without a new image' }).result()).toMatchObject({
      status: 'completed'
    });
    expect(observed).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ images: [expect.objectContaining({ dataBase64 })] })
      ])
    });
    expect(
      f.adapter.requests.map(
        (request) => request.messages.flatMap((message) => message.images ?? []).length
      )
    ).toEqual([1, 1]);
  });

  it.each(['missing', 'corrupt', 'legacy'] as const)(
    'handles %s media without weakening current resource integrity',
    async (mode) => {
      const f = await messagesFixture();
      try {
        const images = await f.store.persistInputImages(f.session.id, [
          {
            name: 'image.png',
            mimeType: 'image/png',
            dataBase64: Buffer.from('pixels').toString('base64')
          }
        ]);
        await f.store.append(f.session.id, {
          type: 'turn.user',
          payload: {
            prompt: 'with image',
            images:
              mode === 'legacy'
                ? [{ name: 'legacy.png', mimeType: 'image/png', byteSize: 6 }]
                : images
          }
        });
        const path = join(
          await activeSessionDirectory(f.home, f.session.id),
          'resources',
          `${images[0]!.resourceId}.bin`
        );
        if (mode === 'missing') await rm(path);
        if (mode === 'corrupt') await writeFile(path, 'bad');
        expect((await f.api.messages()).messages.at(-1)).toMatchObject({ content: 'with image' });
        if (mode === 'legacy')
          expect(
            (await f.api.messages({ includeImages: true })).messages.at(-1)
          ).not.toHaveProperty('images');
        else if (mode === 'missing')
          await expect(f.api.messages({ includeImages: true })).rejects.toMatchObject({
            code: 'MAR_AGENT_IMAGE_UNAVAILABLE'
          });
        else
          expect((await f.api.messages({ includeImages: true })).messages.at(-1)).toMatchObject({
            images: [expect.objectContaining({ dataBase64: Buffer.from('bad').toString('base64') })]
          });
        const requestView = await f.api.messages({
          view: 'request',
          includeImages: true,
          limit: 1000
        });
        expect(requestView.messages.at(-1)).toMatchObject({ content: 'with image' });
        expect(requestView.messages.at(-1)).not.toHaveProperty('images');
        const state = await f.store.readExecutionState(f.session.id);
        await expect(
          restoreMessages(f.store, f.session.id, state.contextRecords, { includeImages: true })
        ).resolves.toBeDefined();
      } finally {
        await f.store.close();
      }
    }
  );

  it('continues with the remaining image and tool result when one resource is missing', async () => {
    const missing = Buffer.from('missing image').toString('base64');
    const healthy = Buffer.from('healthy image').toString('base64');
    const f = await fixture(
      [],
      (_request, index) =>
        index === 0 ? call('read', { reads: [{ path: 'input.txt' }] }) : answer(),
      false,
      true,
      {},
      'OPENAI_RESPONSES',
      ['TEXT', 'IMAGE']
    );
    expect(
      await f.session
        .run({
          prompt: 'Inspect both images and the file',
          images: [
            { name: 'missing.png', mimeType: 'image/png', dataBase64: missing },
            { name: 'healthy.png', mimeType: 'image/png', dataBase64: healthy }
          ]
        })
        .result()
    ).toMatchObject({ status: 'completed' });
    const store = await JsonlSessionStore.open(f.home);
    try {
      const user = (await store.read(f.session.id)).find((record) => record.type === 'turn.user');
      const images = (user?.payload as { images: Array<{ resourceId: string }> }).images;
      await rm(
        join(
          await activeSessionDirectory(f.home, f.session.id),
          'resources',
          `${images[0]!.resourceId}.bin`
        )
      );
      expect(await f.session.run({ prompt: 'Continue' }).result()).toMatchObject({
        status: 'completed'
      });
      const messages = f.adapter.requests.at(-1)!.messages;
      const imageMessage = messages.find((message) =>
        message.content.includes('Inspect both images and the file')
      );
      expect(imageMessage?.content).toContain('Image unavailable');
      expect(imageMessage?.images).toMatchObject([{ dataBase64: healthy }]);
      expect(imageMessage?.images).toHaveLength(1);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'tool',
            content: expect.stringContaining('extension-data')
          }),
          expect.objectContaining({ role: 'user', content: 'Continue' })
        ])
      );
    } finally {
      await store.close();
    }
  });

  it('loads explicit media and follows the same Compact replacement boundary', async () => {
    const f = await messagesFixture();
    try {
      const dataBase64 = Buffer.from('pixels').toString('base64');
      const images = await f.store.persistInputImages(f.session.id, [
        { name: 'image.png', mimeType: 'image/png', dataBase64 }
      ]);
      await f.store.append(f.session.id, {
        type: 'turn.user',
        payload: { prompt: 'with image', images }
      });
      expect(
        (await f.api.messages({ includeImages: true, view: 'conversation' })).messages.at(-1)
      ).toMatchObject({ images: [{ mimeType: 'image/png', dataBase64 }] });
      expect((await f.api.messages()).messages.at(-1)).not.toHaveProperty('images');
      await f.store.append(f.session.id, {
        type: 'compact.completed',
        payload: { summary: 'replacement summary' }
      });
      await rm(join(await activeSessionDirectory(f.home, f.session.id), 'resources'), {
        recursive: true
      });
      const page = await f.api.messages({ view: 'conversation', includeImages: true });
      expect(page.messages).toHaveLength(1);
      expect(JSON.stringify(page)).toContain('replacement summary');
      expect(JSON.stringify(page)).not.toContain('with image');
      expect(f.adapter.requests).toHaveLength(1);
    } finally {
      await f.store.close();
    }
  });

  it.each([
    null,
    { view: 'raw' },
    { includeImages: 'true' },
    { agentId: '' },
    { cursor: 0 },
    { limit: 0 }
  ])('rejects malformed message input %j', async (input) => {
    const f = await messagesFixture();
    try {
      await expect(f.api.messages(input as never)).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_INPUT_INVALID'
      });
    } finally {
      await f.store.close();
    }
  });

  it('does not publish an in-flight read after the owning Session is cleared', async () => {
    const f = await messagesFixture();
    const original = JsonlSessionStore.prototype.readExecutionState;
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi
      .spyOn(JsonlSessionStore.prototype, 'readExecutionState')
      .mockImplementation(async function (this: JsonlSessionStore, id) {
        const result = await original.call(this, id);
        entered();
        await gate;
        return result;
      });
    try {
      const pending = f.api.messages();
      const rejected = expect(pending).rejects.toBeDefined();
      await ready;
      const clear = f.agent.clearSession(f.session.id);
      await vi.waitFor(() =>
        expect((f.context.resources as ExtensionResourceScope).signal.aborted).toBe(true)
      );
      release();
      await rejected;
      await clear;
      spy.mockRestore();
      await f.session.run({ prompt: 'new epoch' }).result();
      const fresh = await f.store.readExecutionState(f.session.id);
      expect(JSON.stringify(fresh.contextRecords)).not.toContain('initialize messages');
    } finally {
      release?.();
      spy.mockRestore();
      await f.store.close();
    }
  });
});
