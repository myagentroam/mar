import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { activeSessionDirectory } from '../support/jsonl-session-path.js';
import { fixture, answer, cleanupCoreFixtures } from './support/core-extension-fixture.js';
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
  updatePromptWorldState
} from '../../src/runtime/context/world-state.js';
import { ExtensionRequestBridge } from '../../src/extensions/model-request.js';

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
  it('keeps dynamic private instruction overhead out of automatic Compact evidence', async () => {
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
      expect(compactions.length).toBeGreaterThan(0);
      expect(
        compactions.every(
          (request) =>
            !request.system.includes('HOST_POLICY') &&
            request.messages.every((message) => !message.content.includes('HOST_POLICY'))
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
    let order = ['extension:a', 'extension:b'];
    const f = await fixture(
      [
        {
          id: 'ordered',
          apiVersion: '1.0',
          attachSession(context) {
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
    order = ['extension:b', 'extension:a'];
    await f.session.run({ prompt: 'reorder' }).result();
    const blocks = f.adapter.requests[1]!.messages.filter(
      (message) => message.contextualBlock?.source === 'extension'
    );
    expect(blocks.map((message) => message.contextualBlock!.id)).toEqual([
      'extension:a',
      'extension:b',
      'extension:b',
      'extension:a'
    ]);
    order = ['extension:b'];
    await f.session.run({ prompt: 'remove' }).result();
    expect(
      f.adapter.requests[2]!.messages.filter(
        (message) => message.contextualBlock?.id === 'extension:a'
      ).at(-1)?.contextualBlock?.operation
    ).toBe('remove');
    expect(f.adapter.requests[0]!.system).toBe(f.adapter.requests[2]!.system);
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
