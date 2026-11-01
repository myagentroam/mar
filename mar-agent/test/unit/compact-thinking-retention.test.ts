import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { LocalAgentHost } from '../../src/host.js';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import type { AgentExtension } from '../../src/extensions/contracts.js';
import type { ModelEvent, ModelRequest } from '../../src/model/contracts.js';
import { createAgentWithAdapter } from '../../src/sdk/agent.js';
import type { Agent } from '../../src/sdk/types.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { restoreMessages } from '../../src/runtime/context/restore.js';

const homes: string[] = [];
const agents = new Set<Agent>();
afterEach(async () => {
  await Promise.all([...agents].map((agent) => agent.dispose()));
  agents.clear();
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function nativeItem(protocol: AgentModelConfiguration['protocol'], index: number) {
  return protocol === 'OPENAI_RESPONSES'
    ? {
        type: 'reasoning',
        id: `reason-${index}`,
        encrypted_content: `encrypted-${index}`,
        summary: []
      }
    : index % 2 === 0
      ? { type: 'thinking', thinking: '', signature: `signature-${index}` }
      : { type: 'redacted_thinking', data: `opaque-${index}` };
}

describe('Compact thinking tail through SDK and JSONL', () => {
  it.each(['tool', 'input'] as const)(
    'retains %s-image references without reading image bytes during manual Compact',
    async (source) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-thinking-media-retention-'));
      homes.push(home);
      const workspace = join(home, 'workspace');
      await mkdir(workspace);
      const pixels = await sharp({
        create: { width: 2, height: 2, channels: 3, background: '#268' }
      })
        .png()
        .toBuffer();
      await writeFile(join(workspace, 'fixture.png'), pixels);
      const configuration: AgentModelConfiguration = {
        id: 'test',
        name: 'Test',
        modelId: 'test',
        protocol: 'ANTHROPIC_MESSAGES',
        baseUrl: 'https://example.test',
        apiKey: new SecretValue('fixture'),
        contextWindowTokens: 50_000,
        maxOutputTokens: 1000,
        enabled: true,
        inputCapabilities: ['TEXT', 'IMAGE'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
        titleGeneration: false,
        hostedWebSearch: false,
        codeMode: false
      };
      const requests: ModelRequest[] = [];
      const create = async () => {
        const agent = await createAgentWithAdapter(
          {
            mode: 'normal',
            host: new LocalAgentHost({ homeDirectory: home, workspace }),
            models: [configuration],
            extensions: [
              {
                id: 'media-retention',
                apiVersion: '1.0',
                attachSession(context) {
                  context.hooks.intercept('compact.generate', (input) => {
                    expect(input.messages.every((message) => !message.images?.length)).toBe(true);
                    return { summary: 'HANDOFF' };
                  });
                }
              }
            ]
          },
          () => ({
            configuration,
            async *start(request): AsyncGenerator<ModelEvent> {
              const index = requests.push(request);
              if (index === 1) {
                for (let item = 0; item < 3; item++)
                  yield {
                    type: 'response.item',
                    provider: 'ANTHROPIC_MESSAGES',
                    contextKind: 'private',
                    item: nativeItem('ANTHROPIC_MESSAGES', item)
                  };
                if (source === 'tool') {
                  yield {
                    type: 'client_tool.call',
                    callId: 'image',
                    name: 'view_image',
                    arguments: { path: 'fixture.png' }
                  };
                  yield { type: 'completed', reason: 'tool_use' };
                  return;
                }
              }
              yield { type: 'text.completed', itemId: `answer-${index}`, text: 'done' };
              yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } };
              yield { type: 'completed', reason: 'completed' };
            }
          })
        );
        agents.add(agent);
        return agent;
      };
      let agent = await create();
      const session = await agent.createSession({ workspace, title: 'Retained media' });
      expect((await session.run({ prompt: 'View the image.' }).result()).status).toBe('completed');
      if (source === 'input')
        expect(
          (
            await session
              .run({
                prompt: 'Retained image input.',
                images: [
                  {
                    name: 'fixture.png',
                    mimeType: 'image/png',
                    dataBase64: pixels.toString('base64')
                  }
                ]
              })
              .result()
          ).status
        ).toBe('completed');
      expect(requests.at(-1)!.messages.flatMap((message) => message.images ?? [])).toHaveLength(1);
      const acceptedPixels = requests
        .at(-1)!
        .messages.flatMap((message) => message.images ?? [])[0]!.dataBase64;
      expect(acceptedPixels).toBeTypeOf('string');
      const resourceReads = vi.spyOn(JsonlSessionStore.prototype, 'readResource');
      expect((await session.compact().result()).status).toBe('completed');
      expect(resourceReads).not.toHaveBeenCalled();
      const store = await JsonlSessionStore.open(home);
      try {
        const state = await store.readExecutionState(session.id);
        const checkpoint = state.contextRecords.findLast(
          (record) => record.type === 'compact.completed'
        )!;
        const retained = (checkpoint.payload as { retainedModelContext: ModelRequest['messages'] })
          .retainedModelContext;
        const image = retained.find((message) =>
          source === 'tool'
            ? message.role === 'tool' && message.callId === 'image'
            : message.role === 'user' && message.content === 'Retained image input.'
        )!.images;
        expect(image).toHaveLength(1);
        expect(image![0]).toMatchObject({ resourceId: expect.any(String), mimeType: 'image/png' });
        expect(image![0]!.dataBase64).toBeUndefined();
      } finally {
        await store.close();
      }
      expect((await session.run({ prompt: 'Continue without restart.' }).result()).status).toBe(
        'completed'
      );
      expect(
        requests
          .at(-1)!
          .messages.flatMap((message) => message.images ?? [])
          .map((image) => image.dataBase64)
      ).toEqual([acceptedPixels]);
      await agent.dispose();
      agents.delete(agent);
      agent = await create();
      const reopened = await agent.openSession(session.id);
      expect((await reopened.run({ prompt: 'Continue.' }).result()).status).toBe('completed');
      expect(
        requests
          .at(-1)!
          .messages.flatMap((message) => message.images ?? [])
          .map((image) => image.dataBase64)
      ).toEqual([acceptedPixels]);
    }
  );

  for (const protocol of ['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const) {
    it.each(['manual', 'automatic', 'smart'] as const)(
      `retains three complete items with %s (${protocol})`,
      async (trigger) => {
        const home = await mkdtemp(join(tmpdir(), 'mar-thinking-retention-'));
        homes.push(home);
        const workspace = join(home, 'workspace');
        await mkdir(workspace);
        const configuration: AgentModelConfiguration = {
          id: 'test',
          name: 'Test',
          modelId: 'test',
          protocol,
          baseUrl: 'https://example.test',
          apiKey: new SecretValue('fixture'),
          contextWindowTokens: 10_000,
          maxOutputTokens: 1000,
          enabled: true,
          inputCapabilities: ['TEXT'],
          outputCapabilities: ['TEXT'],
          reasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
          titleGeneration: false,
          hostedWebSearch: false,
          codeMode: false
        };
        const requests: ModelRequest[] = [];
        const generatedInputs: string[][] = [];
        const extension: AgentExtension = {
          id: 'thinking-retention',
          apiVersion: '1.0',
          attachSession(context) {
            context.hooks.intercept('compact.generate', (input) => {
              generatedInputs.push(input.messages.map((message) => message.content));
              return { summary: `HANDOFF-${generatedInputs.length}` };
            });
          }
        };
        const create = async () => {
          const agent = await createAgentWithAdapter(
            {
              mode: 'normal',
              host: new LocalAgentHost({ homeDirectory: home, workspace }),
              models: [configuration],
              extensions: [extension]
            },
            () => ({
              configuration,
              async *start(request): AsyncGenerator<ModelEvent> {
                const index = requests.push({ ...request, messages: [...request.messages] });
                if (index <= 4) {
                  yield {
                    type: 'response.item',
                    provider: protocol,
                    item: nativeItem(protocol, index - 1),
                    ...(protocol === 'ANTHROPIC_MESSAGES'
                      ? { contextKind: 'private' as const }
                      : {})
                  };
                } else if (trigger === 'smart' && index === 5) {
                  yield {
                    type: 'client_tool.call',
                    callId: 'smart',
                    name: 'smart_compact',
                    arguments: {}
                  };
                  yield { type: 'completed', reason: 'tool_use' };
                  return;
                }
                yield {
                  type: 'text.completed',
                  itemId: `answer-${index}`,
                  text: `answer-${index}`
                };
                const tokens =
                  index === 4
                    ? trigger === 'automatic'
                      ? 9500
                      : trigger === 'smart'
                        ? 6000
                        : 100
                    : 100;
                yield {
                  type: 'usage',
                  usage: { inputTokens: tokens, contextInputTokens: tokens, outputTokens: 10 }
                };
                yield { type: 'completed', reason: 'completed' };
              }
            })
          );
          agents.add(agent);
          return agent;
        };
        let agent = await create();
        const session = await agent.createSession({ workspace, title: 'Thinking retention' });
        for (let index = 0; index < 4; index++)
          expect((await session.run({ prompt: `seed-${index}` }).result()).status).toBe(
            'completed'
          );
        const handle =
          trigger === 'manual' ? session.compact() : session.run({ prompt: 'Next phase' });
        expect((await handle.result()).status).toBe('completed');
        expect(generatedInputs).toHaveLength(1);
        expect(generatedInputs[0]).toEqual(expect.arrayContaining(['seed-0', 'seed-3']));

        // Recompaction must preserve distinct native items already sourced from a checkpoint.
        if (trigger === 'manual') {
          expect((await session.compact().result()).status).toBe('completed');
          expect(generatedInputs).toHaveLength(2);
        }
        const expected = [1, 2, 3].map((index) => nativeItem(protocol, index));
        const store = await JsonlSessionStore.open(home);
        try {
          const state = await store.readExecutionState(session.id);
          const checkpoint = state.contextRecords.findLast(
            (record) => record.type === 'compact.completed'
          )!;
          const payload = checkpoint.payload as { retainedModelContext: ModelRequest['messages'] };
          expect(
            payload.retainedModelContext
              .filter((message) => message.role === 'provider')
              .map((message) => message.item)
          ).toEqual(expected);
          const restored = await restoreMessages(store, session.id, state.contextRecords, {
            includeImages: false
          });
          expect(
            restored.messages
              .filter((message) => message.role === 'provider')
              .map((message) => message.item)
          ).toEqual(expected);
          for (const content of ['seed-2', 'seed-3'])
            expect(restored.messages.filter((message) => message.content === content)).toHaveLength(
              1
            );
        } finally {
          await store.close();
        }
        await agent.dispose();
        agents.delete(agent);
        agent = await create();
        const reopened = await agent.openSession(session.id);
        expect((await reopened.run({ prompt: 'Continue after restart' }).result()).status).toBe(
          'completed'
        );
        expect(
          requests
            .at(-1)!
            .messages.filter((message) => message.role === 'provider')
            .map((message) => message.item)
        ).toEqual(expected);
      }
    );
  }
});
