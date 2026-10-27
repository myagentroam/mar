import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalAgentHost, type HostSessionResourceSnapshot } from '../../src/host.js';
import { SecretValue, createAgent, type AgentModelConfiguration } from '../../src/index.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';

const homes: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
      )
  );
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function startResponsesServer(answer: string) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>);
      const responseId = `response-${requests.length}`;
      const item = {
        type: 'message',
        id: `${responseId}-message`,
        role: 'assistant',
        phase: 'final_answer',
        status: 'completed',
        content: [{ type: 'output_text', text: answer }]
      };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        [
          { type: 'response.created', response: { id: responseId } },
          { type: 'response.output_item.done', item },
          {
            type: 'response.completed',
            response: {
              id: responseId,
              usage: {
                input_tokens: 10,
                output_tokens: 2,
                input_tokens_details: {}
              }
            }
          }
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join('')
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server unavailable');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests
  };
}

async function startAnthropicServer(answer: string) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        [
          { type: 'message_start', message: { id: `message-${requests.length}`, usage: {} } },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', id: `text-${requests.length}`, text: '' }
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: answer }
          },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
          { type: 'message_stop' }
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join('')
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server unavailable');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests
  };
}

function responsesModel(id: string, name: string, baseUrl: string): AgentModelConfiguration {
  return {
    id,
    name,
    protocol: 'OPENAI_RESPONSES',
    baseUrl,
    apiKey: new SecretValue('test-key'),
    modelId: id,
    contextWindowTokens: 272_000,
    maxOutputTokens: 16_384,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['high'],
    hostedWebSearch: false,
    responsesPreviousResponseId: false,
    enabled: true
  };
}

function anthropicModel(id: string, name: string, baseUrl: string): AgentModelConfiguration {
  return {
    id,
    name,
    protocol: 'ANTHROPIC_MESSAGES',
    baseUrl,
    apiKey: new SecretValue('test-key'),
    modelId: id,
    contextWindowTokens: 256_000,
    maxOutputTokens: 16_384,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['high'],
    hostedWebSearch: false,
    responsesPreviousResponseId: false,
    enabled: true
  };
}

function inputItems(request: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(request.input)
    ? request.input.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object' && !Array.isArray(item)
      )
    : [];
}

class ContextualWorldStateHost extends LocalAgentHost {
  #resourceReads = 0;

  override async listSessionResources(): Promise<HostSessionResourceSnapshot> {
    const read = this.#resourceReads++;
    if (read === 0)
      return {
        idleTtlMs: 60_000,
        processes: []
      };
    if (read < 3)
      return {
        idleTtlMs: 60_000,
        processes: [
          {
            processId: 'retained-process',
            status: 'running',
            command: 'long-running-command',
            cwd: '/workspace'
          }
        ]
      };
    return {
      idleTtlMs: 60_000,
      processes: []
    };
  }
}

describe('model switch history recovery', () => {
  it('replays append-only world-state patches through full Responses HTTP history', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-context-continuation-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const server = await startResponsesServer('Responses answer');
    const configuration = responsesModel(
      'responses-continuation',
      'Responses Continuation',
      server.baseUrl
    );
    const agent = await createAgent({
      mode: 'normal',
      host: new ContextualWorldStateHost({ homeDirectory: home, workspace }),
      models: [configuration]
    });
    const session = await agent.createSession({ workspace, title: 'World-state continuation' });
    await session.run({ prompt: 'first request' }).result();
    await session.run({ prompt: 'second request' }).result();
    await session.run({ prompt: 'third request' }).result();
    await session.run({ prompt: 'fourth request' }).result();
    await agent.dispose();

    expect(server.requests).toHaveLength(4);
    expect(server.requests.every((request) => !('previous_response_id' in request))).toBe(true);
    expect(JSON.stringify(server.requests[1]?.input)).not.toContain('processId: retained-process');
    expect(JSON.stringify(server.requests[1]?.input)).toContain('second request');
    expect(JSON.stringify(server.requests[2]?.input)).toContain('third request');
    expect(JSON.stringify(server.requests[3]?.input)).not.toContain(
      'previously provided retained Session resources no longer apply'
    );
    expect(JSON.stringify(server.requests[3]?.input)).toContain('fourth request');
  });

  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const)(
    'keeps the contextual world-state prefix stable across %s executions',
    async (protocol) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-context-prefix-'));
      homes.push(home);
      const workspace = join(home, 'workspace');
      await mkdir(workspace);
      await writeFile(join(workspace, 'AGENTS.md'), 'STABLE_CONTEXT_RULE');
      const server =
        protocol === 'OPENAI_RESPONSES'
          ? await startResponsesServer('Responses answer')
          : await startAnthropicServer('Anthropic answer');
      const configuration =
        protocol === 'OPENAI_RESPONSES'
          ? responsesModel('responses-prefix', 'Responses Prefix', server.baseUrl)
          : anthropicModel('anthropic-prefix', 'Anthropic Prefix', server.baseUrl);
      const host = new ContextualWorldStateHost({ homeDirectory: home, workspace });
      const create = () =>
        createAgent({
          mode: 'normal',
          host,
          models: [configuration]
        });
      let agent = await create();
      const session = await agent.createSession({ workspace, title: 'Stable prefix' });
      await session.run({ prompt: 'first request' }).result();
      await session.run({ prompt: 'second request' }).result();
      await agent.dispose();
      agent = await create();
      const restored = await agent.openSession(session.id);
      await restored.run({ prompt: 'third request' }).result();
      await restored.run({ prompt: 'fourth request' }).result();
      await agent.dispose();

      expect(server.requests).toHaveLength(4);
      const histories = server.requests.map((request) =>
        protocol === 'OPENAI_RESPONSES' ? inputItems(request) : (request.messages as unknown[])
      );
      const [first, second, third, fourth] = histories;
      expect(JSON.stringify(first)).toContain('STABLE_CONTEXT_RULE');
      expect(JSON.stringify(second)).not.toContain('processId: retained-process');
      expect(JSON.stringify(third)).not.toContain('processId: retained-process');
      expect(JSON.stringify(fourth)).not.toContain(
        'The previously provided retained Session resources no longer apply.'
      );
      const systems = server.requests.map((request) =>
        protocol === 'OPENAI_RESPONSES' ? (request.input as unknown[])[0] : request.system
      );
      expect(systems.slice(1)).toEqual([systems[0], systems[0], systems[0]]);
      expect(JSON.stringify(systems)).not.toContain('Retained Session resources');
      const semantic = (value: unknown): unknown => {
        if (!Array.isArray(value)) return value;
        return value.map((item) => {
          if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
          const message = item as Record<string, unknown>;
          const content = Array.isArray(message.content)
            ? message.content
                .map((block) =>
                  block !== null &&
                  typeof block === 'object' &&
                  !Array.isArray(block) &&
                  typeof (block as Record<string, unknown>).text === 'string'
                    ? (block as Record<string, unknown>).text
                    : JSON.stringify(block)
                )
                .join('')
            : message.content;
          return { role: message.role, content };
        });
      };
      expect(semantic(second!.slice(0, first!.length))).toEqual(semantic(first));
      expect(semantic(third!.slice(0, second!.length))).toEqual(semantic(second));
      expect(semantic(fourth!.slice(0, third!.length))).toEqual(semantic(third));
      const store = await JsonlSessionStore.open(home);
      expect(
        (await store.read(session.id)).some((record) => record.type === 'responses.continuation')
      ).toBe(false);
      await store.close();
    }
  );

  it('replays Responses freeform tool history as a paired Anthropic tool exchange', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-model-switch-freeform-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace, title: 'Freeform model switch' });
    const patch = '*** Begin Patch\n*** Add File: added.txt\n+added\n*** End Patch';
    await store.append(session.id, {
      type: 'execution.header',
      payload: { modelId: 'responses-source', mode: 'run' },
      executionId: 'responses-execution',
      turnId: 'responses-turn'
    });
    await store.append(session.id, {
      type: 'turn.user',
      payload: { prompt: 'Create the file.' },
      executionId: 'responses-execution',
      turnId: 'responses-turn'
    });
    await store.append(session.id, {
      type: 'model.context',
      payload: {
        role: 'tool_call',
        content: '',
        callId: 'patch-call',
        name: 'apply_patch',
        arguments: patch,
        inputMode: 'freeform'
      },
      executionId: 'responses-execution',
      turnId: 'responses-turn'
    });
    await store.append(session.id, {
      type: 'model.context',
      payload: {
        role: 'tool',
        content: 'Applied patch successfully.',
        callId: 'patch-call'
      },
      executionId: 'responses-execution',
      turnId: 'responses-turn'
    });
    await store.append(session.id, {
      type: 'message.completed',
      payload: { text: 'The file was created.' },
      executionId: 'responses-execution',
      turnId: 'responses-turn'
    });
    await store.close();

    const server = await startAnthropicServer('Anthropic resumed');
    const agent = await createAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [anthropicModel('anthropic-target', 'Anthropic Target', server.baseUrl)]
    });
    await expect(
      (await agent.openSession(session.id)).run({ prompt: 'Continue with Anthropic' }).result()
    ).resolves.toMatchObject({ status: 'completed', finalAnswer: 'Anthropic resumed' });
    await agent.dispose();

    expect(server.requests).toHaveLength(1);
    const messages = server.requests[0]?.messages;
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: expect.arrayContaining([
            {
              type: 'tool_use',
              id: 'patch-call',
              name: 'apply_patch',
              input: { patch }
            }
          ])
        }),
        expect.objectContaining({
          role: 'user',
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'tool_result',
              tool_use_id: 'patch-call',
              content: 'Applied patch successfully.'
            })
          ])
        })
      ])
    );
  });

  it('keeps post-compact Responses context owned by its originating model', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-model-switch-compact-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace, title: 'Model switch compact' });
    await store.append(session.id, {
      type: 'execution.header',
      payload: { modelId: 'gpt-5.6-luna', mode: 'run' },
      executionId: 'luna-execution',
      turnId: 'luna-turn'
    });
    const compact = await store.compact(session.id, {
      summary: 'Luna compact summary',
      automatic: true,
      modelId: 'gpt-5.6-luna',
      executionId: 'luna-execution',
      turnId: 'luna-turn'
    });
    await store.append(session.id, {
      type: 'model.context',
      payload: {
        role: 'provider',
        content: '',
        provider: 'OPENAI_RESPONSES',
        providerModelId: 'gpt-5.6-luna',
        item: {
          type: 'reasoning',
          id: 'luna-reasoning',
          encrypted_content: 'luna-encrypted',
          summary: []
        }
      },
      executionId: 'luna-execution',
      turnId: 'luna-turn'
    });
    await store.append(session.id, {
      type: 'message.completed',
      payload: { text: 'Luna answer after compact' },
      executionId: 'luna-execution',
      turnId: 'luna-turn'
    });
    await store.append(session.id, {
      type: 'usage.updated',
      payload: {
        type: 'usage.updated',
        inputTokens: 260_000,
        outputTokens: 100,
        contextInputTokens: 260_000
      },
      executionId: 'luna-execution',
      turnId: 'luna-turn'
    });
    await store.close();

    const terraServer = await startResponsesServer('Terra answer');
    const terra = responsesModel('gpt-5.6-terra', 'GPT-5.6-Terra', terraServer.baseUrl);
    const terraAgent = await createAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [terra]
    });
    await expect(
      (await terraAgent.openSession(session.id)).run({ prompt: 'Continue with Terra' }).result()
    ).resolves.toMatchObject({ status: 'completed', finalAnswer: 'Terra answer' });
    await terraAgent.dispose();

    expect(terraServer.requests).toHaveLength(1);
    expect(inputItems(terraServer.requests[0]!).map((item) => item.id)).not.toContain(
      'luna-reasoning'
    );

    const lunaServer = await startResponsesServer('Luna resumed');
    const luna = responsesModel('gpt-5.6-luna', 'GPT-5.6-Luna', lunaServer.baseUrl);
    const lunaAgent = await createAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [luna]
    });
    await expect(
      (await lunaAgent.openSession(session.id)).run({ prompt: 'Return to Luna' }).result()
    ).resolves.toMatchObject({ status: 'completed', finalAnswer: 'Luna resumed' });
    await lunaAgent.dispose();

    expect(inputItems(lunaServer.requests[0]!).map((item) => item.id)).toContain('luna-reasoning');
    expect(compact.payload).toMatchObject({ modelId: 'gpt-5.6-luna' });
  });

  it('uses the next execution header to recover ownership after a legacy compact record', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-model-switch-legacy-compact-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace, title: 'Legacy model switch compact' });
    await store.compact(session.id, { summary: 'Legacy compact summary' });
    await store.append(session.id, {
      type: 'execution.header',
      payload: { modelId: 'gpt-5.6-luna', mode: 'run' },
      executionId: 'legacy-luna-execution',
      turnId: 'legacy-luna-turn'
    });
    await store.append(session.id, {
      type: 'model.context',
      payload: {
        role: 'provider',
        content: '',
        provider: 'OPENAI_RESPONSES',
        item: {
          type: 'reasoning',
          id: 'legacy-luna-reasoning',
          encrypted_content: 'legacy-luna-encrypted',
          summary: []
        }
      },
      executionId: 'legacy-luna-execution',
      turnId: 'legacy-luna-turn'
    });
    await store.close();

    const terraServer = await startResponsesServer('Terra answer');
    const terraAgent = await createAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [responsesModel('gpt-5.6-terra', 'GPT-5.6-Terra', terraServer.baseUrl)]
    });
    await expect(
      (await terraAgent.openSession(session.id)).run({ prompt: 'Continue with Terra' }).result()
    ).resolves.toMatchObject({ status: 'completed', finalAnswer: 'Terra answer' });
    await terraAgent.dispose();
    expect(inputItems(terraServer.requests[0]!).map((item) => item.id)).not.toContain(
      'legacy-luna-reasoning'
    );

    const lunaServer = await startResponsesServer('Luna resumed');
    const lunaAgent = await createAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [responsesModel('gpt-5.6-luna', 'GPT-5.6-Luna', lunaServer.baseUrl)]
    });
    await expect(
      (await lunaAgent.openSession(session.id)).run({ prompt: 'Return to Luna' }).result()
    ).resolves.toMatchObject({ status: 'completed', finalAnswer: 'Luna resumed' });
    await lunaAgent.dispose();
    expect(inputItems(lunaServer.requests[0]!).map((item) => item.id)).toContain(
      'legacy-luna-reasoning'
    );
  });
});
