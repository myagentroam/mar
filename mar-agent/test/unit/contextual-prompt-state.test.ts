import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { activeSessionDirectory } from '../support/jsonl-session-path.js';
import { fixture, answer, cleanupCoreFixtures } from './support/core-extension-fixture.js';
import { effectiveInstructions } from './support/model-context.js';
import { LocalAgentHost } from '../../src/host.js';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import { createAgentWithAdapter } from '../../src/sdk/agent.js';
import type { ModelRequest } from '../../src/model/contracts.js';
import {
  contextualChanges,
  splitContextualPrompt,
  type ContextualPart
} from '../../src/runtime/context/contextual-blocks.js';
import {
  parsePersistedContextualWorldState,
  persistContextualWorldState,
  updateContextualWorldState,
  updatePromptWorldState
} from '../../src/runtime/context/world-state.js';
import { ExtensionRequestBridge } from '../../src/extensions/model-request.js';
import { AgentError } from '../../src/error.js';
import { createExecutionModelContext } from '../../src/sdk/execution-model-context.js';
import { SESSION_CONTEXT_PROVIDER } from '../../src/extensions/session-context.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupCoreFixtures();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const part = (id: string, content: string): ContextualPart => ({
  id,
  content,
  source: 'host',
  authority: 'instruction'
});
const model: AgentModelConfiguration = {
  id: 'contextual',
  name: 'Contextual',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl: 'https://example.test',
  apiKey: new SecretValue('fixture'),
  modelId: 'fixture',
  contextWindowTokens: 200_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  enabled: true
};

describe('Contextual prompt state', () => {
  it('rebuilds a rejected request context before sending anything to the model', async () => {
    const discarded = vi.fn();
    const delivered = vi.fn();
    const first = {
      items: [{ id: 'shared', content: 'STALE_CAPTURE' }],
      accept: () => false,
      acknowledge: discarded
    };
    const current = {
      items: [{ id: 'shared', content: 'CURRENT_CAPTURE' }],
      accept: vi.fn(() => true),
      acknowledge: delivered
    };
    const collect = vi.fn().mockReturnValueOnce(first).mockReturnValue(current);
    const f = await fixture(
      [
        {
          id: 'request-context-acceptance',
          apiVersion: '1.0',
          attachSession(context) {
            context.services.provide(SESSION_CONTEXT_PROVIDER, {
              collect: () => [],
              requestContext: collect
            });
          }
        }
      ],
      answer
    );
    expect((await f.session.run({ prompt: 'work' }).result()).status).toBe('completed');
    expect(collect).toHaveBeenCalledTimes(2);
    expect(f.adapter.requests).toHaveLength(1);
    expect(JSON.stringify(f.adapter.requests[0]!.messages)).toContain('CURRENT_CAPTURE');
    expect(JSON.stringify(f.adapter.requests[0]!.messages)).not.toContain('STALE_CAPTURE');
    expect(discarded).not.toHaveBeenCalled();
    expect(current.accept).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  it('does not accept context that depends on an input filtered from the final request', async () => {
    const trigger = 'Reconnect using this message';
    const accept = vi.fn(() => true);
    const acknowledge = vi.fn();
    let filter = true;
    const f = await fixture(
      [
        {
          id: 'context-input-filter',
          apiVersion: '1.0',
          attachSession(context) {
            context.services.provide(SESSION_CONTEXT_PROVIDER, {
              collect: () => [],
              requestContext: ({ clientMessageIds }) =>
                clientMessageIds.includes('reconnect')
                  ? {
                      items: [{ id: 'shared', content: 'PENDING_SHARED_VIEW' }],
                      accept: (hasClientMessage) => hasClientMessage('reconnect') && accept(),
                      acknowledge
                    }
                  : { items: [] }
            });
            context.hooks.intercept('model.request', (request, _call, next) =>
              next(
                filter
                  ? {
                      ...request,
                      messages: request.messages.filter(
                        (message) => message.role !== 'user' || message.content !== trigger
                      )
                    }
                  : request
              )
            );
          }
        }
      ],
      answer
    );
    expect(
      (await f.session.run({ prompt: trigger, clientMessageId: 'reconnect' }).result()).status
    ).toBe('completed');
    expect(f.adapter.requests).toHaveLength(1);
    expect(JSON.stringify(f.adapter.requests[0]!.messages)).not.toContain('PENDING_SHARED_VIEW');
    expect(accept).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();

    filter = false;
    expect((await f.session.run({ prompt: 'Continue.' }).result()).status).toBe('completed');
    expect(JSON.stringify(f.adapter.requests[1]!.messages)).toContain('PENDING_SHARED_VIEW');
    expect(accept).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it('does not recapture request context when a hook filters an unrelated input', async () => {
    const requestContext = vi.fn(() => ({
      items: [{ id: 'shared', content: 'INDEPENDENT_SHARED_VIEW' }],
      accept: () => true
    }));
    const f = await fixture(
      [
        {
          id: 'independent-request-context',
          apiVersion: '1.0',
          attachSession(context) {
            context.services.provide(SESSION_CONTEXT_PROVIDER, {
              collect: () => [],
              requestContext
            });
            context.hooks.intercept('model.request', (request, _call, next) =>
              next({
                ...request,
                messages: request.messages.filter(({ content }) => content !== 'Unrelated input')
              })
            );
          }
        }
      ],
      answer
    );
    const result = await f.session
      .run({ prompt: 'Unrelated input', clientMessageId: 'unrelated' })
      .result();
    expect(result.status).toBe('completed');
    expect(
      f.adapter.requests[0]?.messages.some(({ content }) => content === 'Unrelated input')
    ).toBe(false);
    expect(f.adapter.requests[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('INDEPENDENT_SHARED_VIEW') })
      ])
    );
    expect(requestContext).toHaveBeenCalledTimes(1);
  });

  it('does not append context after its source detaches during preparation', async () => {
    let attached = true;
    let detach = false;
    const body = 'SHARED_WHILE_ATTACHED';
    const accepted = vi.fn((captured: boolean) => captured === attached);
    const delivered = vi.fn();
    const f = await fixture(
      [
        {
          id: 'request-context-detach',
          apiVersion: '1.0',
          attachSession(context) {
            context.services.provide(SESSION_CONTEXT_PROVIDER, {
              collect: () => [],
              requestContext: () => {
                const captured = attached;
                return {
                  ...(captured && {
                    items: [{ id: 'shared', content: body }],
                    acknowledge: delivered
                  }),
                  accept: () => accepted(captured)
                };
              }
            });
            context.hooks.intercept('model.request', (request, _call, next) => {
              if (detach) {
                detach = false;
                attached = false;
              }
              return next(request);
            });
          }
        }
      ],
      answer
    );
    expect((await f.session.run({ prompt: 'work with the shared view' }).result()).status).toBe(
      'completed'
    );
    detach = true;
    expect((await f.session.run({ prompt: 'continue work' }).result()).status).toBe('completed');
    expect(f.adapter.requests).toHaveLength(2);
    const request = f.adapter.requests[1]!;
    const prefix = f.adapter.requests[0]!.messages;
    expect(request.messages.slice(0, prefix.length)).toEqual(prefix);
    expect(
      request.messages.filter(({ contextualBlock }) => contextualBlock?.id === 'request:shared')
    ).toEqual([expect.objectContaining({ content: expect.stringContaining(body) })]);
    expect(accepted.mock.calls).toEqual([[true], [true], [false]]);
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  it('can update one contextual block without removing an omitted block', async () => {
    let updated = false;
    const f = await fixture(
      [
        {
          id: 'request-context-partial',
          apiVersion: '1.0',
          attachSession(context) {
            context.services.provide(SESSION_CONTEXT_PROVIDER, {
              collect: () => [],
              requestContext: () => ({
                items: updated
                  ? [{ id: 'primary', content: 'updated primary' }]
                  : [
                      { id: 'primary', content: 'original primary' },
                      { id: 'secondary', content: 'original secondary' }
                    ]
              })
            });
          }
        }
      ],
      answer
    );
    expect((await f.session.run({ prompt: 'first' }).result()).status).toBe('completed');
    updated = true;
    expect((await f.session.run({ prompt: 'second' }).result()).status).toBe('completed');
    const first = f.adapter.requests[0]!.messages;
    const second = f.adapter.requests[1]!.messages;
    expect(second.slice(0, first.length)).toEqual(first);
    expect(
      second.slice(first.length).flatMap(({ contextualBlock }) => contextualBlock ?? [])
    ).toEqual([expect.objectContaining({ id: 'request:primary', operation: 'replace' })]);
  });

  it('anchors only the contextual blocks a request hook actually delivers', async () => {
    let omit = 'SECONDARY_DATA';
    let includeInstruction = false;
    const acknowledge = vi.fn();
    const f = await fixture(
      [
        {
          id: 'request-context-filter-one-block',
          apiVersion: '1.0',
          attachSession(context) {
            context.services.provide(SESSION_CONTEXT_PROVIDER, {
              collect: () => [],
              requestContext: () => ({
                items: [
                  { id: 'primary', content: 'PRIMARY_DATA' },
                  { id: 'secondary', content: 'SECONDARY_DATA' }
                ],
                acknowledge
              })
            });
            context.hooks.intercept('prompt.sections', (input, _call, next) =>
              next(
                includeInstruction
                  ? {
                      ...input,
                      sections: [
                        ...input.sections,
                        { id: 'request:primary', text: 'PROMPT_SECTION' }
                      ]
                    }
                  : input
              )
            );
            context.hooks.intercept('model.request', (request, _call, next) =>
              next(
                omit
                  ? {
                      ...request,
                      messages: request.messages.filter(
                        (message) => message.role === 'opaque' || !message.content.includes(omit)
                      )
                    }
                  : request
              )
            );
          }
        }
      ],
      answer
    );
    expect((await f.session.run({ prompt: 'first' }).result()).status).toBe('completed');
    expect(acknowledge).toHaveBeenLastCalledWith(new Set(['primary']));
    omit = '';
    expect((await f.session.run({ prompt: 'second' }).result()).status).toBe('completed');
    const [first, second] = f.adapter.requests;
    expect(second!.messages.slice(0, first!.messages.length)).toEqual(first!.messages);
    expect(
      second!.messages
        .slice(first!.messages.length)
        .flatMap(({ contextualBlock }) =>
          contextualBlock?.id.startsWith('request:') ? [contextualBlock.id] : []
        )
    ).toEqual(['request:secondary']);
    expect(acknowledge).toHaveBeenLastCalledWith(new Set(['primary', 'secondary']));

    includeInstruction = true;
    omit = 'PRIMARY_DATA';
    expect((await f.session.run({ prompt: 'third' }).result()).status).toBe('completed');
    expect(f.adapter.requests[2]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contextualBlock: expect.objectContaining({ id: 'request:primary', kind: 'instruction' })
        })
      ])
    );
    expect(acknowledge).toHaveBeenLastCalledWith(new Set(['secondary']));
  });

  it.each(['filtered', 'rewritten'] as const)(
    'does not acknowledge or anchor a request context update %s before dispatch',
    async (change) => {
      let body = 'PREVIOUS_SHARED_SNAPSHOT';
      let alterUpdate = false;
      const rewritten = 'HOOK_REWROTE_SHARED_CONTEXT';
      const acknowledge = vi.fn();
      const f = await fixture(
        [
          {
            id: 'filter-request-context-update',
            apiVersion: '1.0',
            attachSession(context) {
              context.services.provide(SESSION_CONTEXT_PROVIDER, {
                collect: () => [],
                requestContext: () => ({ items: [{ id: 'shared', content: body }], acknowledge })
              });
              context.hooks.intercept('model.request', (request, _call, next) =>
                next(
                  alterUpdate
                    ? {
                        ...request,
                        messages: request.messages.flatMap((message) => {
                          if (message.role === 'opaque' || !message.content.includes(body))
                            return [message];
                          return change === 'filtered' ? [] : [{ ...message, content: rewritten }];
                        })
                      }
                    : request
                )
              );
            }
          }
        ],
        answer
      );
      const run = (prompt: string) =>
        expect(f.session.run({ prompt }).result()).resolves.toMatchObject({ status: 'completed' });
      await run('initial context');
      expect(acknowledge).toHaveBeenCalledTimes(1);

      body = 'UPDATED_SHARED_SNAPSHOT';
      alterUpdate = true;
      f.agent.setSystemInstruction('UNRELATED_HOST_UPDATE');
      await run('filter this update');
      const filtered = f.adapter.requests[1]!;
      expect(JSON.stringify(filtered.messages)).not.toContain(body);
      expect(acknowledge).toHaveBeenCalledTimes(1);

      alterUpdate = false;
      await run('include the update now');
      const next = f.adapter.requests[2]!;
      const baseline = filtered.messages.filter(({ content }) => content !== rewritten);
      expect(next.messages.slice(0, baseline.length)).toEqual(baseline);
      expect(
        next.messages.filter(({ content }) => content.includes('UNRELATED_HOST_UPDATE'))
      ).toHaveLength(1);
      expect(next.messages.at(-1)).toMatchObject({
        contextualBlock: { id: 'request:shared', operation: 'replace' },
        content: expect.stringContaining(body)
      });
      expect(acknowledge).toHaveBeenCalledTimes(2);
    }
  );

  it('excludes live request context from Compact and reloads only the current view afterward', async () => {
    let body = 'REQUEST_DATA_BEFORE_COMPACT';
    const ids: (readonly string[])[] = [];
    const acknowledge = vi.fn();
    const f = await fixture(
      [
        {
          id: 'request-context-test',
          apiVersion: '1.0',
          attachSession(context) {
            context.services.provide(SESSION_CONTEXT_PROVIDER, {
              collect: () => [],
              requestContext: ({ clientMessageIds }) => {
                ids.push(clientMessageIds);
                return { items: [{ id: 'shared', content: body }], acknowledge };
              }
            });
          }
        }
      ],
      answer
    );
    const byId = (request: ModelRequest) =>
      request.messages.filter((m) => m.contextualBlock?.id === 'request:shared');
    expect(
      (
        await f.session
          .run({ prompt: 'seed history', clientMessageId: 'effective-message' })
          .result()
      ).status
    ).toBe('completed');
    expect(ids[0]).toContain('effective-message');
    expect(byId(f.adapter.requests.at(-1)!)[0]?.content).toContain(body);
    expect(acknowledge).toHaveBeenCalledTimes(1);

    expect((await f.session.compact().result()).status).toBe('completed');
    const compact = f.adapter.requests.at(-1)!;
    expect(compact.toolChoice).toBe('none');
    expect(byId(compact)).toEqual([]);
    expect(JSON.stringify(compact.messages)).not.toContain(body);
    expect(acknowledge).toHaveBeenCalledTimes(1);

    body = 'CURRENT_REQUEST_DATA';
    expect((await f.session.run({ prompt: 'after compact' }).result()).status).toBe('completed');
    expect(byId(f.adapter.requests.at(-1)!)).toEqual([
      expect.objectContaining({ content: expect.stringContaining(body) })
    ]);
  });

  it.each(
    ['core:long-running', 'core:tools'].flatMap((id) =>
      (['run', 'compact'] as const).map((mode) => ({ id, mode }))
    )
  )(
    'revokes the retired SDK instruction $id in the first $mode request after upgrade',
    async ({ id, mode }) => {
      const oldPolicy = `Retired policy for ${id}.`;
      const f = await fixture([], answer);
      if (mode === 'compact') {
        expect(await f.session.run({ prompt: 'seed history' }).result()).toMatchObject({
          status: 'completed'
        });
        await f.agent.dispose();
      }
      const host = part('core:caller-instructions', 'HOST_POLICY');
      const world = updatePromptWorldState(
        {
          generation: undefined,
          initialized: true,
          instructionSnapshot: undefined,
          resourceSnapshot: undefined,
          entries: []
        },
        // A normal Run appends contextual prompts after the environment and user input.
        mode === 'compact' ? 2 : 0,
        [host, { id, source: 'sdk', authority: 'instruction', content: oldPolicy }]
      );
      const store = await JsonlSessionStore.open(f.home);
      try {
        await persistContextualWorldState(store, f.session.id, world);
      } finally {
        await store.close();
      }

      if (mode === 'compact') {
        const reopened = await createAgentWithAdapter(
          {
            mode: 'normal',
            host: new LocalAgentHost({ homeDirectory: f.home, workspace: f.home }),
            models: [f.adapter.configuration],
            systemInstruction: host.content
          },
          () => f.adapter
        );
        try {
          const session = await reopened.openSession(f.session.id);
          expect(await session.compact().result()).toMatchObject({ status: 'completed' });
        } finally {
          await reopened.dispose();
        }
      } else {
        f.agent.setSystemInstruction(host.content);
        expect(await f.session.run({ prompt: 'continue' }).result()).toMatchObject({
          status: 'completed'
        });
      }
      const current = f.adapter.requests.at(-1)!;
      if (mode === 'compact') expect(current.toolChoice).toBe('none');
      expect(
        current.messages.find((message) => message.contextualBlock?.id === id)?.content
      ).toContain(oldPolicy);
      const removal = current.messages.findLast((message) => message.contextualBlock?.id === id);
      expect(removal?.contextualBlock).toMatchObject({
        id,
        source: 'sdk',
        authority: 'instruction',
        operation: 'remove'
      });
      expect(removal?.content).not.toContain(oldPolicy);
      expect(effectiveInstructions(current)).not.toContain(oldPolicy);
      expect(effectiveInstructions(current)).toContain('HOST_POLICY');
    }
  );

  it('revokes an old skill catalog as an SDK instruction without re-emitting its contents', () => {
    const initial = {
      generation: undefined,
      initialized: true,
      instructionSnapshot: undefined,
      resourceSnapshot: undefined,
      entries: []
    };
    const oldCatalog: ContextualPart = {
      id: 'core:skill-catalog',
      source: 'sdk',
      authority: 'instruction',
      content: 'OLD_CATALOG'
    };
    const host = part('host:policy', 'HOST_POLICY');
    const oldState = updatePromptWorldState(initial, 0, [host, oldCatalog]);
    const restored = parsePersistedContextualWorldState({
      version: 2,
      generation: null,
      instructionSnapshot: null,
      resourceSnapshot: null,
      promptSnapshot: oldState.promptSnapshot,
      entries: oldState.entries
    })!;
    const initialized = updateContextualWorldState(restored, 1, {
      instructionSnapshot: undefined,
      instructionContent: undefined
    });
    expect(initialized.promptSnapshot).toEqual([host, oldCatalog]);
    const migrated = updatePromptWorldState(initialized, 1, [host]);
    const removal = migrated.entries.at(-1)!;
    expect(removal.block).toMatchObject({
      id: 'core:skill-catalog',
      source: 'sdk',
      authority: 'instruction',
      operation: 'remove'
    });
    expect(removal.content).not.toContain('OLD_CATALOG');
    expect(migrated.entries.some((entry) => entry.content.includes('OLD_CATALOG'))).toBe(false);
    expect(migrated.promptSnapshot).toEqual([host]);
    expect(updatePromptWorldState(migrated, 2, [host])).toBe(migrated);
  });
  it('removes old catalog bodies even when the previous release already revoked the catalog', () => {
    const host = part('host:policy', 'HOST_POLICY');
    const oldCatalog: ContextualPart = {
      id: 'core:skill-catalog',
      source: 'sdk',
      authority: 'instruction',
      content: 'OLD_CATALOG'
    };
    const changes = [
      ...contextualChanges([], [host, oldCatalog]),
      ...contextualChanges([host, oldCatalog], [host])
    ];
    const restored = parsePersistedContextualWorldState({
      version: 2,
      generation: null,
      instructionSnapshot: null,
      resourceSnapshot: null,
      promptSnapshot: [host],
      entries: changes.map(({ block, content }) => ({ index: 0, kind: 'prompt', block, content }))
    })!;
    const migrated = updatePromptWorldState(restored, 1, [host]);
    expect(migrated.entries.some((entry) => entry.content.includes('OLD_CATALOG'))).toBe(false);
    expect(
      migrated.entries.filter((entry) => entry.block?.id === 'core:skill-catalog')
    ).toHaveLength(1);
    expect(migrated.entries.at(-1)?.block).toMatchObject({
      operation: 'remove',
      authority: 'instruction',
      source: 'sdk'
    });
    expect(migrated.entries.some((entry) => entry.content.includes('HOST_POLICY'))).toBe(true);
    expect(updatePromptWorldState(migrated, 2, [host])).toBe(migrated);
  });
  it.each(['core:skill-catalog', 'core:long-running'])(
    'revokes retired %s instructions during initialization before manual Compact',
    async (id) => {
      const host = part('host:policy', 'HOST_POLICY');
      const retired: ContextualPart = {
        id,
        source: 'sdk',
        authority: 'instruction',
        content: 'RETIRED_INSTRUCTION'
      };
      const initial = updatePromptWorldState(
        {
          generation: undefined,
          initialized: true,
          instructionSnapshot: undefined,
          resourceSnapshot: undefined,
          entries: []
        },
        0,
        [host, retired]
      );
      const write = vi.fn(async () => {});
      const context = createExecutionModelContext({
        restored: {
          messages: [{ role: 'user', content: 'task' }],
          userMessages: [],
          environmentState: undefined
        },
        initialContextualWorldState: initial,
        sessionId: 'session',
        executionId: 'execution',
        turnId: 'turn',
        mode: 'compact',
        contextRecords: [],
        contextualWorldStateGeneration: undefined,
        compactMayContainAgentInstructions: false,
        messageSources: new WeakMap(),
        persistWorldState: write,
        instructionSnapshot: () => undefined,
        renderInstructions: () => undefined
      } as unknown as Parameters<typeof createExecutionModelContext>[0]);
      await context.initializeWorldState();
      expect(write).toHaveBeenCalled();
      expect(
        context.worldState.entries.some((entry) => entry.content.includes(retired.content))
      ).toBe(id !== 'core:skill-catalog');
      expect(context.worldState.entries.at(-1)?.block).toMatchObject({
        id,
        operation: 'remove',
        source: 'sdk',
        authority: 'instruction'
      });
      expect(context.worldState.promptSnapshot).toEqual([host]);
    }
  );
  it('retains active instructions in native automatic Compact but excludes them from fallback evidence', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-contextual-budget-'));
    roots.push(home);
    const requests: ModelRequest[] = [];
    const agent = await createAgentWithAdapter(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace: home }),
        models: [{ ...model, contextWindowTokens: 50_000 }],
        systemInstruction: 'HOST_POLICY '.repeat(30_000)
      },
      () => ({
        async *start(request) {
          requests.push(request);
          // Exercise fallback explicitly instead of depending on the current Core prompt size.
          if (
            request.toolChoice === 'none' &&
            request.messages.some((message) => message.content.includes('HOST_POLICY'))
          )
            throw new AgentError(
              'context_length_exceeded',
              'Native compact exceeded the fixture context window.'
            );
          yield* answer();
          yield {
            type: 'usage' as const,
            usage: { inputTokens: 45_000, contextInputTokens: 45_000, outputTokens: 10 }
          };
        }
      })
    );
    try {
      const session = await agent.createSession({ workspace: home });
      expect((await session.run({ prompt: 'first' }).result()).status).toBe('completed');
      const result = await session.run({ prompt: 'overflow' }).result();
      expect(result).toMatchObject({ status: 'completed' });
      const compactions = requests.filter((request) => request.toolChoice === 'none');
      const fallbacks = compactions.filter((request) =>
        request.messages.some((message) =>
          message.content.includes('Conversation evidence (chronological):')
        )
      );
      const native = compactions.filter((request) => !fallbacks.includes(request));
      expect(native.length).toBeGreaterThan(0);
      expect(fallbacks).toHaveLength(native.length);
      const interactionId = 'core:interaction';
      const interaction = requests[0]!.messages.find(
        (message) => message.contextualBlock?.id === interactionId
      );
      expect(interaction?.contextualBlock).toMatchObject({
        source: 'sdk',
        authority: 'instruction',
        operation: 'replace'
      });
      expect(interaction?.content).toContain('not during context compaction');
      for (const request of native) {
        expect(
          request.messages.find((message) => message.contextualBlock?.id === interactionId)
        ).toEqual(interaction);
      }
      for (const request of fallbacks) {
        expect(
          request.messages.some((message) => message.contextualBlock?.id === interactionId)
        ).toBe(false);
        expect(
          request.messages.some((message) => message.content.includes('# Progress communication'))
        ).toBe(false);
      }
      expect(
        requests.every((request) => !request.system.includes('# Progress communication'))
      ).toBe(true);
      expect(
        native.every((request) =>
          request.messages.some((message) => message.content.includes('HOST_POLICY'))
        )
      ).toBe(true);
      expect(compactions.every((request) => !request.system.includes('HOST_POLICY'))).toBe(true);
      expect(
        fallbacks.every((request) =>
          request.messages.every((message) => !message.content.includes('HOST_POLICY'))
        )
      ).toBe(true);
      expect(
        fallbacks.every((request) =>
          request.messages.some((message) => message.content.includes('first'))
        )
      ).toBe(true);
      expect(requests.filter((request) => request.toolChoice !== 'none')).toHaveLength(2);
      expect(requests[0]!.messages.some((message) => message.content.includes('HOST_POLICY'))).toBe(
        true
      );
    } finally {
      await agent.dispose();
    }
  });

  it('appends only changes, removal and A-B-A while respecting reorder precedence', () => {
    const a = part('host:a', 'A');
    const b = part('host:b', 'B');
    expect(contextualChanges([a, b], [a, b])).toEqual([]);
    expect(contextualChanges([a], [part('host:a', 'B')])[0]?.block.operation).toBe('replace');
    expect(contextualChanges([part('host:a', 'B')], [a])).toHaveLength(1);
    expect(
      contextualChanges([a, b], [b]).map((entry) => [entry.block.id, entry.block.operation])
    ).toEqual([['host:a', 'remove']]);
    expect(contextualChanges([a, b], [b, a]).map((entry) => entry.block.id)).toEqual([
      'host:b',
      'host:a'
    ]);
    expect(
      contextualChanges([a, b], [part('host:c', 'C'), a, b]).map((entry) => entry.block.id)
    ).toEqual(['host:c', 'host:a', 'host:b']);
  });

  it('keeps fixed core separate and falls back losslessly for whole-string or cache-scoped rewrites', () => {
    const sections = [
      { id: 'core:identity', text: 'CORE' },
      { id: 'core:caller-instructions', text: 'HOST' }
    ];
    expect(splitContextualPrompt({ text: 'CORE\n\nHOST', sections })).toMatchObject({
      system: 'CORE',
      parts: [part('core:caller-instructions', 'HOST')]
    });
    expect(splitContextualPrompt({ text: 'WHOLE', sections })).toEqual({
      system: 'WHOLE',
      parts: []
    });
    expect(
      splitContextualPrompt({
        text: 'CORE\n\nEXTENSION',
        sections: [
          { id: 'core:identity', text: 'CORE' },
          { id: 'core:custom', text: 'EXTENSION' }
        ]
      }).parts[0]?.source
    ).toBe('extension');
    expect(
      splitContextualPrompt({
        text: 'CORE\n\nHOST',
        sections,
        blocks: [{ text: 'CORE', cache: true }]
      }).systemBlocks
    ).toEqual([{ text: 'CORE', cache: true }]);
  });

  it('round-trips block identity and prompt snapshots and rejects forged persisted authority', async () => {
    const initial = {
      generation: undefined,
      initialized: true,
      instructionSnapshot: undefined,
      resourceSnapshot: undefined,
      entries: []
    };
    const state = updatePromptWorldState(initial, 2, [part('host:a', 'A')]);
    let payload: unknown;
    await persistContextualWorldState(
      {
        writeContextualWorldState: async (_id: string, value: unknown) => {
          payload = value;
        }
      } as never,
      'test',
      state
    );
    expect(parsePersistedContextualWorldState(payload)).toEqual(state);
    const forged = structuredClone(payload) as { entries: Array<{ block: { source: string } }> };
    forged.entries[0]!.block.source = 'user';
    expect(parsePersistedContextualWorldState(forged)).toBeUndefined();
  });

  it('preserves cache-marked text and deterministic identity without duplicating headers', () => {
    const current = {
      ...part('host:a', 'AB'),
      textBlocks: [{ text: 'A', cache: true as const }, { text: 'B' }]
    };
    const change = contextualChanges([], [current])[0]!;
    expect(change.textBlocks!.map((block) => block.text).join('')).toBe(change.content);
    expect(change.textBlocks!.filter((block) => block.cache)).toEqual([{ text: 'A', cache: true }]);
    const reorderedKeys: ContextualPart = {
      textBlocks: current.textBlocks,
      content: 'AB',
      authority: 'instruction',
      source: 'host',
      id: 'host:a'
    };
    expect(contextualChanges([current], [reorderedKeys])).toEqual([]);
  });

  it('retains legacy sidecars and rejects duplicate ids and entry overflow', async () => {
    const legacy = {
      version: 1,
      generation: null,
      instructionSnapshot: null,
      resourceSnapshot: null,
      entries: [{ index: 0, kind: 'instructions', content: 'PROJECT' }]
    };
    const state = parsePersistedContextualWorldState(legacy)!;
    expect(state.entries).toEqual(legacy.entries);
    expect(() =>
      updatePromptWorldState(state, 0, [part('host:a', 'A'), part('host:a', 'B')])
    ).toThrow('Contextual block ids conflict.');
    const write = vi.fn();
    await expect(
      persistContextualWorldState({ writeContextualWorldState: write } as never, 'test', {
        ...state,
        entries: Array(1_025).fill(state.entries[0])
      })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_HOST_LIMIT_EXCEEDED' });
    expect(write).not.toHaveBeenCalled();
  });

  it('only preserves instruction provenance through a valid same-role source reference', () => {
    const state = updatePromptWorldState(
      {
        generation: undefined,
        initialized: true,
        instructionSnapshot: undefined,
        resourceSnapshot: undefined,
        entries: []
      },
      0,
      [part('host:a', 'A')]
    );
    const entry = state.entries[0]!;
    const original = {
      role: 'user' as const,
      content: entry.content,
      contextKind: 'contextual' as const,
      contextualBlock: entry.block!
    };
    const bridge = new ExtensionRequestBridge('test', {
      system: 'CORE',
      messages: [original],
      tools: []
    });
    const edited = { ...bridge.view.messages[0]!, content: 'Edited trusted instruction' };
    const preserved = bridge.lower({ ...bridge.view, messages: [edited] }).messages[0]!;
    expect(preserved.contextualBlock).toEqual(original.contextualBlock);
    const fresh = bridge.lower({
      ...bridge.view,
      messages: [{ role: 'user', content: entry.content }]
    }).messages[0]!;
    expect(fresh.contextualBlock).toBeUndefined();
    const assistant = bridge.lower({ ...bridge.view, messages: [{ ...edited, role: 'assistant' }] })
      .messages[0]!;
    expect(assistant.contextualBlock).toBeUndefined();
  });

  it('withdraws dynamic versions during whole-prompt fallback and restores them when structured composition returns', async () => {
    let whole = false;
    const f = await fixture(
      [
        {
          id: 'whole-fallback',
          apiVersion: '1.0',
          attachSession(context) {
            context.hooks.intercept('prompt.compose', (input, _call, next) =>
              next(whole ? `${input}\nWhole-prompt suffix` : input)
            );
          }
        }
      ],
      answer
    );
    f.agent.setSystemInstruction('HOST_FALLBACK');
    await f.session.run({ prompt: 'structured' }).result();
    whole = true;
    await f.session.run({ prompt: 'whole' }).result();
    expect(f.adapter.requests[1]!.system).toContain('HOST_FALLBACK');
    expect(
      f.adapter.requests[1]!.messages.filter(
        (message) => message.contextualBlock?.source === 'host'
      ).at(-1)?.contextualBlock?.operation
    ).toBe('remove');
    whole = false;
    await f.session.run({ prompt: 'structured again' }).result();
    expect(f.adapter.requests[2]!.system).not.toContain('HOST_FALLBACK');
    expect(
      f.adapter.requests[2]!.messages.filter(
        (message) => message.contextualBlock?.source === 'host'
      ).at(-1)?.contextualBlock?.operation
    ).toBe('replace');
  });

  it('keeps one core and stable Host history across updates, removal, restart and Compact', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-contextual-prompts-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const requests: ModelRequest[] = [];
    const create = (systemInstruction?: string) =>
      createAgentWithAdapter(
        {
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace }),
          models: [model],
          systemInstruction
        },
        () => ({
          async *start(request) {
            requests.push(request);
            yield {
              type: 'text.completed' as const,
              itemId: 'answer',
              text: request.toolChoice === 'none' ? 'Durable summary' : 'done'
            };
            yield { type: 'completed' as const, reason: 'completed' as const };
          }
        })
      );
    let agent = await create('HOST_A');
    let id = '';
    try {
      const session = await agent.createSession({ workspace });
      id = session.id;
      expect((await session.run({ prompt: 'first' }).result()).status).toBe('completed');
      expect((await session.run({ prompt: 'second' }).result()).status).toBe('completed');
      const hostItems = (request: ModelRequest) =>
        request.messages.filter((message) => message.contextualBlock?.source === 'host');
      expect(requests[0]!.system).not.toContain('HOST_A');
      expect(requests[0]!.system).toBe(requests[1]!.system);
      expect(hostItems(requests[0]!)).toHaveLength(1);
      expect(hostItems(requests[1]!)).toEqual(hostItems(requests[0]!));
      expect(
        requests[0]!.messages.findIndex((message) => message.content === 'first')
      ).toBeLessThan(
        requests[0]!.messages.findIndex((message) => message.contextualBlock?.source === 'host')
      );
      agent.setSystemInstruction('HOST_B');
      await session.run({ prompt: 'third' }).result();
      expect(hostItems(requests[2]!)).toHaveLength(2);
      agent.setSystemInstruction();
      await session.run({ prompt: 'fourth' }).result();
      expect(hostItems(requests[3]!).at(-1)?.contextualBlock?.operation).toBe('remove');
      const store = await JsonlSessionStore.open(home);
      try {
        expect(JSON.stringify(await store.read(id))).not.toContain('HOST_A');
      } finally {
        await store.close();
      }
      expect(
        await readFile(
          join(await activeSessionDirectory(home, id), 'context-world-state.json'),
          'utf8'
        )
      ).toContain('HOST_A');
    } finally {
      await agent.dispose();
    }
    agent = await create();
    try {
      const session = await agent.openSession(id);
      await session.run({ prompt: 'restart' }).result();
      expect(
        requests[4]!.messages.filter((message) => message.contextualBlock?.source === 'host')
      ).toHaveLength(3);
      await session.compact().result();
      await session.run({ prompt: 'after compact' }).result();
      expect(requests.at(-1)!.messages.some((message) => message.content.includes('HOST_A'))).toBe(
        false
      );
      expect(requests.at(-1)!.system).toBe(requests[0]!.system);
    } finally {
      await agent.dispose();
    }
  });

  it.each(['request-hook', 'sidecar-write'] as const)(
    'does not commit candidate blocks after a %s failure',
    async (failure) => {
      let reject = failure === 'request-hook';
      const f = await fixture(
        [
          {
            id: 'reject-once',
            apiVersion: '1.0',
            attachSession(context) {
              context.hooks.intercept('model.request', (request, _call, next) => {
                if (reject) throw new Error('Rejected candidate.');
                return next(request);
              });
            }
          }
        ],
        answer
      );
      f.agent.setSystemInstruction('HOST_ACCEPTED_ONCE');
      const original = JsonlSessionStore.prototype.writeContextualWorldState;
      const spy =
        failure === 'sidecar-write'
          ? vi
              .spyOn(JsonlSessionStore.prototype, 'writeContextualWorldState')
              .mockImplementation(async function (id, state) {
                if ((state as { promptSnapshot?: unknown }).promptSnapshot !== undefined)
                  throw new Error('Write rejected.');
                return original.call(this, id, state);
              })
          : undefined;
      expect((await f.session.run({ prompt: 'rejected' }).result()).status).toBe('failed');
      expect(f.adapter.requests).toHaveLength(0);
      reject = false;
      spy?.mockRestore();
      expect((await f.session.run({ prompt: 'accepted' }).result()).status).toBe('completed');
      const host = f.adapter.requests[0]!.messages.filter(
        (message) => message.contextualBlock?.source === 'host'
      );
      expect(host).toHaveLength(1);
      expect(host[0]!.content).toContain('HOST_ACCEPTED_ONCE');
    }
  );

  it('appends conditional removal and reorders only the dynamic instruction group', async () => {
    let order = ['extension:a'];
    const f = await fixture(
      [
        {
          id: 'ordered',
          apiVersion: '1.0',
          attachSession(context) {
            context.services.provide(SESSION_CONTEXT_PROVIDER, {
              collect: () => [],
              requestContext: () => ({ items: [{ id: 'shared', content: 'Unchanged data' }] })
            });
            context.hooks.intercept('prompt.sections', (input, _call, next) =>
              next({
                ...input,
                sections: [...input.sections, ...order.map((id) => ({ id, text: id }))]
              })
            );
          }
        }
      ],
      answer
    );
    await f.session.run({ prompt: 'first' }).result();
    order = ['extension:a', 'extension:b'];
    await f.session.run({ prompt: 'add' }).result();
    order = ['extension:b', 'extension:a'];
    await f.session.run({ prompt: 'reorder' }).result();
    const blocks = f.adapter.requests[2]!.messages.filter((message) =>
      message.contextualBlock?.id.startsWith('extension:')
    );
    expect(
      f.adapter.requests
        .slice(0, 3)
        .map(
          ({ messages }) =>
            messages.filter(({ contextualBlock }) => contextualBlock?.id === 'request:shared')
              .length
        )
    ).toEqual([1, 1, 1]);
    expect(blocks.map((message) => message.contextualBlock!.id)).toEqual([
      'extension:a',
      'extension:b',
      'extension:b',
      'extension:a'
    ]);
    order = ['extension:b'];
    await f.session.run({ prompt: 'remove' }).result();
    expect(
      f.adapter.requests[3]!.messages.filter(
        (message) => message.contextualBlock?.id === 'extension:a'
      ).at(-1)?.contextualBlock?.operation
    ).toBe('remove');
    expect(f.adapter.requests[0]!.system).toBe(f.adapter.requests[3]!.system);
  });

  it('clears private contextual history and rebuilds only the current Host snapshot', async () => {
    const f = await fixture([], answer);
    f.agent.setSystemInstruction('BEFORE_CLEAR');
    await f.session.run({ prompt: 'before' }).result();
    await f.agent.clearSession(f.session.id);
    f.agent.setSystemInstruction('AFTER_CLEAR');
    await f.session.run({ prompt: 'after' }).result();
    const host = f.adapter.requests
      .at(-1)!
      .messages.filter((message) => message.contextualBlock?.source === 'host');
    expect(host).toHaveLength(1);
    expect(host[0]!.content).toContain('AFTER_CLEAR');
    expect(host[0]!.content).not.toContain('BEFORE_CLEAR');
  });
});
