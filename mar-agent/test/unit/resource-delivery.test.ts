import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAgentHost } from '../../src/host.js';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import { createAgentWithAdapter } from '../../src/sdk/agent.js';
import { AnthropicMessagesAdapter } from '../../src/model/anthropic-messages.js';
import { OpenAiResponsesAdapter } from '../../src/model/openai-responses.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { ResourceInputProjection } from '../../src/sdk/resource-input.js';
import { startResponsesWebSocketServer } from './support/responses-transport-servers.js';

type Protocol = AgentModelConfiguration['protocol'];
type ToolAction =
  | {
      readonly type: 'tool';
      readonly name: 'view_image' | 'read';
      readonly arguments: Record<string, unknown>;
    }
  | { readonly type: 'code'; readonly source: string }
  | { readonly type: 'final'; readonly text?: string };
type Agent = Awaited<ReturnType<typeof createAgentWithAdapter>>;

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);
const alternatePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
  'base64'
);
const homes: string[] = [];
const servers: Server[] = [];
const agents: Agent[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(agents.splice(0).map((agent) => agent.dispose()));
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

function configuration(
  protocol: Protocol,
  baseUrl: string,
  responsesTransport: 'HTTP' | 'WEBSOCKET' = 'HTTP'
): AgentModelConfiguration {
  return {
    id: 'vision',
    name: 'Vision',
    protocol,
    baseUrl,
    apiKey: new SecretValue('test-key'),
    modelId: 'vision-test',
    contextWindowTokens: 100_000,
    maxOutputTokens: 1024,
    inputCapabilities: ['TEXT', 'IMAGE'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: [],
    titleGeneration: false,
    codeMode: false,
    useResourceUrl: false,
    hostedWebSearch: false,
    responsesPreviousResponseId:
      protocol === 'OPENAI_RESPONSES' && responsesTransport === 'WEBSOCKET',
    ...(protocol === 'OPENAI_RESPONSES'
      ? {
          responsesTransport:
            responsesTransport === 'WEBSOCKET'
              ? ({ transport: 'WEBSOCKET' } as const)
              : ({ transport: 'HTTP', httpVersion: '1.1' } as const)
        }
      : {}),
    enabled: true
  };
}

function toolEvents(protocol: Protocol, action: ToolAction, index: number): unknown[] {
  if (protocol === 'ANTHROPIC_MESSAGES') {
    if (action.type === 'final')
      return [
        { type: 'message_start', message: { id: `message-${index}`, usage: {} } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: action.text ?? 'done' }
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
        { type: 'message_stop' }
      ];
    if (action.type === 'code') throw new Error('Code Mode actions require Responses.');
    return [
      { type: 'message_start', message: { id: `message-${index}`, usage: {} } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: `tool-${index}`,
          name: action.name,
          input: action.arguments
        }
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} },
      { type: 'message_stop' }
    ];
  }

  if (action.type === 'final')
    return [
      { type: 'response.created', response: { id: `response-${index}` } },
      {
        type: 'response.output_item.done',
        item: {
          type: 'message',
          id: `message-${index}`,
          role: 'assistant',
          phase: 'final_answer',
          status: 'completed',
          content: [{ type: 'output_text', text: action.text ?? 'done' }]
        }
      },
      { type: 'response.completed', response: { id: `response-${index}`, usage: {} } }
    ];
  if (action.type === 'code')
    return [
      { type: 'response.created', response: { id: `response-${index}` } },
      {
        type: 'response.output_item.done',
        item: {
          type: 'custom_tool_call',
          id: `custom-${index}`,
          call_id: `tool-${index}`,
          name: 'code_exec',
          input: action.source
        }
      },
      { type: 'response.completed', response: { id: `response-${index}`, usage: {} } }
    ];
  return [
    { type: 'response.created', response: { id: `response-${index}` } },
    {
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        id: `function-${index}`,
        call_id: `tool-${index}`,
        name: action.name,
        arguments: JSON.stringify(action.arguments)
      }
    },
    { type: 'response.completed', response: { id: `response-${index}`, usage: {} } }
  ];
}

async function startProtocolServer(
  protocol: Protocol,
  actions: readonly (ToolAction | { readonly type: 'overflow' })[]
) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (body += chunk));
    request.on('end', () => {
      try {
        requests.push(JSON.parse(body) as Record<string, unknown>);
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      const index = requests.length - 1;
      const action = actions[index] ?? { type: 'final' as const };
      if (action.type === 'overflow') {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              type: 'invalid_request_error',
              code: 'context_length_exceeded',
              message: 'The request exceeds the context window.'
            }
          })
        );
        return;
      }
      const events = toolEvents(protocol, action, index);
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache'
      });
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('HTTP test server unavailable.');
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

function imagePayloads(value: unknown, protocol: Protocol): string[] {
  const payloads: string[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (candidate === null || typeof candidate !== 'object') return;
    const record = candidate as Record<string, unknown>;
    if (protocol === 'OPENAI_RESPONSES' && record.type === 'input_image') {
      if (typeof record.image_url === 'string') payloads.push(record.image_url);
    }
    if (protocol === 'ANTHROPIC_MESSAGES' && record.type === 'image') {
      const source = record.source as Record<string, unknown> | undefined;
      if (source?.type === 'base64' && typeof source.data === 'string') payloads.push(source.data);
      if (source?.type === 'url' && typeof source.url === 'string') payloads.push(source.url);
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
  return payloads;
}

function objectsOfType(value: unknown, type: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (candidate === null || typeof candidate !== 'object') return;
    const record = candidate as Record<string, unknown>;
    if (record.type === type) found.push(record);
    Object.values(record).forEach(visit);
  };
  visit(value);
  return found;
}

async function createAgent(
  home: string,
  workspace: string,
  model: AgentModelConfiguration,
  publishModelResource?: ConstructorParameters<typeof LocalAgentHost>[0]['publishModelResource'],
  extensions?: Parameters<typeof createAgentWithAdapter>[0]['extensions']
) {
  const agent = await createAgentWithAdapter({
    mode: 'normal',
    host: new LocalAgentHost({ homeDirectory: home, workspace, publishModelResource }),
    models: [model],
    ...(extensions === undefined ? {} : { extensions })
  });
  agents.push(agent);
  return agent;
}

async function disposeAgent(agent: Agent): Promise<void> {
  await agent.dispose();
  const index = agents.indexOf(agent);
  if (index !== -1) agents.splice(index, 1);
}

async function createImageWorkspace() {
  const home = await mkdtemp(join(tmpdir(), 'mar-resource-delivery-'));
  homes.push(home);
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  await Promise.all([
    writeFile(join(workspace, 'image-a.png'), png),
    writeFile(join(workspace, 'image-b.png'), alternatePng),
    writeFile(join(workspace, 'plain.txt'), 'plain tool result')
  ]);
  return {
    home,
    workspace,
    imageABase64: png.toString('base64'),
    imageBBase64: alternatePng.toString('base64')
  };
}

describe.each(['ANTHROPIC_MESSAGES', 'OPENAI_RESPONSES'] as const)(
  'SDK inline image delivery over %s HTTP',
  (protocol) => {
    it.each([
      [false, 'add'],
      [false, 'replace'],
      [true, 'add'],
      [true, 'replace']
    ] as const)(
      'delivers top-level hook images once while retaining attachment history without duplicate mirrors (URL=%s, %s)',
      async (useResourceUrl, operation) => {
        const { baseUrl, requests } = await startProtocolServer(protocol, [
          { type: 'tool', name: 'read', arguments: { reads: [{ path: 'plain.txt' }] } },
          { type: 'final' },
          { type: 'final' }
        ]);
        const { home, workspace, imageABase64 } = await createImageWorkspace();
        const attachmentUrl = 'https://assets.example.test/attachment.png';
        const hookUrl = 'https://assets.example.test/hook.png';
        const hookBase64 = alternatePng.toString('base64');
        let hooks = 0;
        const agent = await createAgent(
          home,
          workspace,
          { ...configuration(protocol, baseUrl), useResourceUrl },
          async () => ({ url: attachmentUrl, urlExpiresAt: 1 }),
          [
            {
              id: 'inject-request-image',
              apiVersion: '1.0',
              attachSession(context) {
                context.hooks.intercept('model.request', (request, _call, next) => {
                  hooks++;
                  if (hooks === 1)
                    expect(request.images?.length ?? 0).toBe(operation === 'replace' ? 1 : 0);
                  return next({
                    ...request,
                    system: `${request.system}\nRequest hook active.`,
                    ...(hooks === 1
                      ? {
                          images: [{ mimeType: 'image/png', dataBase64: hookBase64, url: hookUrl }]
                        }
                      : {})
                  });
                });
              }
            }
          ]
        );
        const session = await agent.createSession({ workspace });
        await expect(
          session
            .run({
              prompt: 'Inspect the image, then read plain.txt.',
              ...(operation === 'replace'
                ? {
                    images: [
                      { name: 'attachment.png', mimeType: 'image/png', dataBase64: imageABase64 }
                    ]
                  }
                : {})
            })
            .result()
        ).resolves.toMatchObject({ status: 'completed' });
        await expect(
          session.run({ prompt: 'Continue without a new image.' }).result()
        ).resolves.toMatchObject({ status: 'completed' });
        expect(hooks).toBe(3);
        const expectedHook = useResourceUrl
          ? hookUrl
          : protocol === 'OPENAI_RESPONSES'
            ? `data:image/png;base64,${hookBase64}`
            : hookBase64;
        const expectedAttachment = useResourceUrl
          ? attachmentUrl
          : protocol === 'OPENAI_RESPONSES'
            ? `data:image/png;base64,${imageABase64}`
            : imageABase64;
        const retained = operation === 'replace' ? [expectedAttachment] : [];
        expect(requests.map((body) => imagePayloads(body, protocol))).toEqual([
          [...(operation === 'replace' ? [expectedAttachment] : []), expectedHook],
          retained,
          retained
        ]);
      }
    );

    it('does not load local image bytes for URL requests or ordinary tools', async () => {
      const { baseUrl, requests } = await startProtocolServer(protocol, [
        { type: 'tool', name: 'read', arguments: { reads: [{ path: 'plain.txt' }] } },
        { type: 'final' }
      ]);
      const { home, workspace, imageABase64 } = await createImageWorkspace();
      const url = 'https://assets.example.test/fixed-image.png';
      const agent = await createAgent(
        home,
        workspace,
        { ...configuration(protocol, baseUrl), useResourceUrl: true },
        async () => ({ url, urlExpiresAt: 1 })
      );
      const readResource = vi.spyOn(JsonlSessionStore.prototype, 'readResource');
      const session = await agent.createSession({ workspace });
      await expect(
        session
          .run({
            prompt: 'Inspect this image, then read plain.txt.',
            images: [{ name: 'attachment.png', mimeType: 'image/png', dataBase64: imageABase64 }]
          })
          .result()
      ).resolves.toMatchObject({ status: 'completed' });
      expect(requests).toHaveLength(2);
      expect(requests.every((body) => JSON.stringify(body).includes(url))).toBe(true);
      expect(JSON.stringify(requests)).not.toContain(imageABase64);
      expect(readResource).not.toHaveBeenCalled();
    });

    it.each(['pending', 'attachment'] as const)(
      'retains an initial %s image through overflow compaction',
      async (source) => {
        const { baseUrl, requests } = await startProtocolServer(protocol, [
          { type: 'final' },
          { type: 'overflow' },
          { type: 'final' },
          { type: 'final' },
          { type: 'final' }
        ]);
        const { home, workspace, imageABase64 } = await createImageWorkspace();
        const model = configuration(protocol, baseUrl);
        const initialAgent = await createAgent(home, workspace, model);
        const initialSession = await initialAgent.createSession({ workspace });
        expect(await initialSession.run({ prompt: 'Seed history.' }).result()).toMatchObject({
          status: 'completed'
        });
        await disposeAgent(initialAgent);
        const image = { name: 'attachment.png', mimeType: 'image/png', dataBase64: imageABase64 };
        if (source === 'pending') {
          const store = await JsonlSessionStore.open(home);
          try {
            const images = await store.persistInputImages(initialSession.id, [image]);
            await store.append(initialSession.id, {
              type: 'turn.user',
              payload: { prompt: 'Pending image.', deferred: true, images }
            });
          } finally {
            await store.close();
          }
        }
        const agent = await createAgent(home, workspace, model);
        const session = await agent.openSession(initialSession.id);
        await expect(
          session
            .run({
              prompt: 'Inspect the image.',
              ...(source === 'attachment'
                ? { images: [image], context: ['Supplemental context after the attachment.'] }
                : {})
            })
            .result()
        ).resolves.toMatchObject({ status: 'completed' });
        await expect(
          session.run({ prompt: 'Continue without new images.' }).result()
        ).resolves.toMatchObject({
          status: 'completed'
        });

        expect(requests).toHaveLength(5);
        const wireImage =
          protocol === 'OPENAI_RESPONSES' ? `data:image/png;base64,${imageABase64}` : imageABase64;
        expect(requests.map((body) => imagePayloads(body, protocol))).toEqual([
          [],
          [wireImage],
          [],
          [wireImage],
          [wireImage]
        ]);
      }
    );

    it('retains unaccepted tool images through overflow compaction', async () => {
      const { baseUrl, requests } = await startProtocolServer(protocol, [
        { type: 'final' },
        { type: 'tool', name: 'view_image', arguments: { path: 'image-a.png' } },
        { type: 'overflow' },
        { type: 'final' },
        { type: 'final' },
        { type: 'final' }
      ]);
      const { home, workspace, imageABase64 } = await createImageWorkspace();
      const agent = await createAgent(home, workspace, configuration(protocol, baseUrl));
      const session = await agent.createSession({ workspace });
      for (const prompt of [
        'Seed history.',
        'Inspect image-a.png.',
        'Continue without new images.'
      ])
        await expect(session.run({ prompt }).result()).resolves.toMatchObject({
          status: 'completed'
        });

      expect(requests).toHaveLength(6);
      const wireImage =
        protocol === 'OPENAI_RESPONSES' ? `data:image/png;base64,${imageABase64}` : imageABase64;
      expect(requests.map((body) => imagePayloads(body, protocol))).toEqual([
        [],
        [],
        [wireImage],
        [],
        [wireImage],
        [wireImage]
      ]);
    });

    it('retains inline images across empty completed retries', async () => {
      const readResource = vi.spyOn(JsonlSessionStore.prototype, 'readResource');
      const releaseBytes = vi.spyOn(ResourceInputProjection.prototype, 'releaseBytes');
      const { baseUrl, requests } = await startProtocolServer(protocol, [
        { type: 'final', text: '' },
        { type: 'final' },
        { type: 'final' }
      ]);
      const { home, workspace, imageABase64 } = await createImageWorkspace();
      const agent = await createAgent(home, workspace, configuration(protocol, baseUrl));
      const session = await agent.createSession({ workspace });
      await expect(
        session
          .run({
            prompt: 'Describe this attachment.',
            images: [{ name: 'attachment.png', mimeType: 'image/png', dataBase64: imageABase64 }]
          })
          .result()
      ).resolves.toMatchObject({ status: 'completed' });
      expect(readResource).not.toHaveBeenCalled();
      expect(releaseBytes).toHaveBeenCalledTimes(1);
      await expect(
        session.run({ prompt: 'Continue without new images.' }).result()
      ).resolves.toMatchObject({ status: 'completed' });
      expect(readResource).toHaveBeenCalledTimes(1);
      expect(releaseBytes).toHaveBeenCalledTimes(2);

      expect(requests).toHaveLength(3);
      const wireImage =
        protocol === 'OPENAI_RESPONSES' ? `data:image/png;base64,${imageABase64}` : imageABase64;
      expect(requests.map((body) => imagePayloads(body, protocol))).toEqual([
        [wireImage],
        [wireImage],
        [wireImage]
      ]);
    });

    it('retains the bounded image window across model calls, executions, and SDK reopen', async () => {
      const actions: ToolAction[] = [
        { type: 'tool', name: 'view_image', arguments: { path: 'image-a.png' } },
        { type: 'tool', name: 'read', arguments: { reads: [{ path: 'plain.txt' }] } },
        { type: 'tool', name: 'view_image', arguments: { path: 'image-a.png' } },
        { type: 'tool', name: 'view_image', arguments: { path: 'image-b.png' } },
        { type: 'final' },
        { type: 'final' },
        { type: 'final' }
      ];
      const { baseUrl, requests } = await startProtocolServer(protocol, actions);
      const { home, workspace, imageABase64, imageBBase64 } = await createImageWorkspace();
      const anthropicStartSpy =
        protocol === 'ANTHROPIC_MESSAGES'
          ? vi.spyOn(AnthropicMessagesAdapter.prototype, 'start')
          : undefined;
      const responsesStartSpy =
        protocol === 'OPENAI_RESPONSES'
          ? vi.spyOn(OpenAiResponsesAdapter.prototype, 'startTurn')
          : undefined;

      const model = configuration(protocol, baseUrl);
      let agent = await createAgent(home, workspace, model);
      const session = await agent.createSession({ workspace, title: 'Image delivery' });
      await expect(
        session
          .run({
            prompt: 'Inspect this attachment, then inspect the requested files.',
            images: [{ name: 'attachment.png', mimeType: 'image/png', dataBase64: imageABase64 }]
          })
          .result()
      ).resolves.toMatchObject({ status: 'completed' });

      await expect(
        session.run({ prompt: 'Continue without new images.' }).result()
      ).resolves.toMatchObject({
        status: 'completed'
      });
      await disposeAgent(agent);

      const store = await JsonlSessionStore.open(home);
      try {
        const persisted = await store.read(session.id);
        const serializedHistory = JSON.stringify(persisted);
        expect(serializedHistory).not.toContain(imageABase64);
        expect(serializedHistory).not.toContain(imageBBase64);
        expect(serializedHistory).not.toContain('dataBase64');
      } finally {
        await store.close();
      }

      agent = await createAgent(home, workspace, model);
      const reopenedSession = await agent.openSession(session.id);
      await expect(
        reopenedSession.run({ prompt: 'Continue after SDK reopen.' }).result()
      ).resolves.toMatchObject({
        status: 'completed'
      });
      await disposeAgent(agent);

      expect(requests).toHaveLength(7);
      const adapterRequests =
        protocol === 'OPENAI_RESPONSES'
          ? responsesStartSpy?.mock.calls.map(([request]) => request)
          : anthropicStartSpy?.mock.calls.map(([request]) => request);
      expect(adapterRequests).toHaveLength(7);
      expect(adapterRequests?.map((request) => request.images)).toEqual(
        Array.from({ length: 7 }, () => undefined)
      );
      const wireImage =
        protocol === 'OPENAI_RESPONSES' ? `data:image/png;base64,${imageABase64}` : imageABase64;
      const wireImageB =
        protocol === 'OPENAI_RESPONSES' ? `data:image/png;base64,${imageBBase64}` : imageBBase64;
      expect(requests.map((body) => imagePayloads(body, protocol))).toEqual([
        [wireImage],
        [wireImage, wireImage],
        [wireImage, wireImage],
        [wireImage, wireImage, wireImage],
        [wireImage, wireImage, wireImage, wireImageB],
        [wireImage, wireImage, wireImage, wireImageB],
        [wireImage, wireImage, wireImage, wireImageB]
      ]);
      expect(requests[0]).not.toHaveProperty('images');
      expect(requests.every((body) => !Object.hasOwn(body, 'images'))).toBe(true);

      const toolResultType =
        protocol === 'OPENAI_RESPONSES' ? 'function_call_output' : 'tool_result';
      for (const [requestIndex, expectedImages] of [
        [1, [wireImage]],
        [2, [wireImage]],
        [3, [wireImage, wireImage]],
        [4, [wireImage, wireImage, wireImageB]],
        [5, [wireImage, wireImage, wireImageB]],
        [6, [wireImage, wireImage, wireImageB]]
      ] as const) {
        const imageToolResults = objectsOfType(requests[requestIndex], toolResultType).filter(
          (item) => imagePayloads(item, protocol).length > 0
        );
        expect(imageToolResults).toHaveLength(expectedImages.length);
        expect(imagePayloads(imageToolResults, protocol)).toEqual(expectedImages);
      }
      expect(imagePayloads(requests[2], protocol)).toEqual([wireImage, wireImage]);
      expect(imagePayloads(requests[5], protocol)).toEqual([
        wireImage,
        wireImage,
        wireImage,
        wireImageB
      ]);
      expect(imagePayloads(requests[6], protocol)).toEqual([
        wireImage,
        wireImage,
        wireImage,
        wireImageB
      ]);
    });
  }
);

describe('SDK Code Mode inline image delivery over Responses HTTP', () => {
  it('retains completed code cell images within the bounded visual window', async () => {
    const actions: ToolAction[] = [
      {
        type: 'code',
        source:
          'const result = await tools.view_image({ path: "image-a.png" }); observe.result(result);'
      },
      {
        type: 'code',
        source:
          'const result = await tools.read({ reads: [{ path: "plain.txt" }] }); observe.result(result);'
      },
      {
        type: 'code',
        source:
          'const result = await tools.view_image({ path: "image-b.png" }); observe.result(result);'
      },
      {
        type: 'code',
        source:
          'const result = await tools.view_image({ path: "image-a.png" }); observe.result(result);'
      },
      { type: 'final' },
      { type: 'final' }
    ];
    const { baseUrl, requests } = await startProtocolServer('OPENAI_RESPONSES', actions);
    const { home, workspace, imageABase64, imageBBase64 } = await createImageWorkspace();
    const model = { ...configuration('OPENAI_RESPONSES', baseUrl), codeMode: true };
    const agent = await createAgent(home, workspace, model);

    try {
      const session = await agent.createSession({ workspace, title: 'Code Mode image delivery' });
      await expect(
        session.run({ prompt: 'Inspect both images with separate Code Mode cells.' }).result()
      ).resolves.toMatchObject({ status: 'completed' });
      await expect(
        session.run({ prompt: 'Continue after the Code Mode cells.' }).result()
      ).resolves.toMatchObject({ status: 'completed' });
    } finally {
      await disposeAgent(agent);
    }

    const wireImageA = `data:image/png;base64,${imageABase64}`;
    const wireImageB = `data:image/png;base64,${imageBBase64}`;
    expect(requests).toHaveLength(6);
    expect(requests.map((body) => imagePayloads(body, 'OPENAI_RESPONSES'))).toEqual([
      [],
      [wireImageA],
      [wireImageA],
      [wireImageA, wireImageB],
      [wireImageA, wireImageB, wireImageA],
      [wireImageA, wireImageB, wireImageA]
    ]);
    expect(requests.every((body) => !Object.hasOwn(body, 'images'))).toBe(true);

    for (const [requestIndex, expectedImages] of [
      [1, [wireImageA]],
      [2, [wireImageA]],
      [3, [wireImageA, wireImageB]],
      [4, [wireImageA, wireImageB, wireImageA]],
      [5, [wireImageA, wireImageB, wireImageA]]
    ] as const) {
      const outputs = objectsOfType(requests[requestIndex], 'custom_tool_call_output');
      const imageOutputs = outputs.filter(
        (item) => imagePayloads(item, 'OPENAI_RESPONSES').length > 0
      );
      expect(imageOutputs).toHaveLength(expectedImages.length);
      expect(imagePayloads(imageOutputs, 'OPENAI_RESPONSES')).toEqual(expectedImages);
    }
  });
});

describe('SDK inline image delivery over Responses WebSocket', () => {
  it.each([false, true])(
    'delivers a top-level hook image added after a tool result (URL=%s)',
    async (useResourceUrl) => {
      const actions: ToolAction[] = [
        { type: 'tool', name: 'read', arguments: { reads: [{ path: 'plain.txt' }] } },
        { type: 'tool', name: 'read', arguments: { reads: [{ path: 'plain.txt' }] } },
        { type: 'final' }
      ];
      const server = await startResponsesWebSocketServer([], {
        responsesByRequest: actions.map((action, index) =>
          toolEvents('OPENAI_RESPONSES', action, index)
        )
      });
      servers.push(server.server);
      const { home, workspace, imageABase64 } = await createImageWorkspace();
      const hookUrl = 'https://assets.example.test/hook.png';
      let hooks = 0;
      const agent = await createAgent(
        home,
        workspace,
        { ...configuration('OPENAI_RESPONSES', server.baseUrl, 'WEBSOCKET'), useResourceUrl },
        undefined,
        [
          {
            id: 'inject-after-tool',
            apiVersion: '1.0',
            attachSession(context) {
              context.hooks.intercept('model.request', (request, _call, next) => {
                hooks++;
                return next(
                  hooks === 2
                    ? {
                        ...request,
                        images: [{ mimeType: 'image/png', dataBase64: imageABase64, url: hookUrl }]
                      }
                    : request
                );
              });
            }
          }
        ]
      );
      const session = await agent.createSession({ workspace });
      await expect(
        session.run({ prompt: 'Read plain.txt twice.' }).result()
      ).resolves.toMatchObject({ status: 'completed' });
      expect(hooks).toBe(3);
      expect(server.connections()).toBe(1);
      expect(server.requests.map((body) => imagePayloads(body, 'OPENAI_RESPONSES'))).toEqual([
        [],
        [useResourceUrl ? hookUrl : `data:image/png;base64,${imageABase64}`],
        []
      ]);
      expect(server.requests[1]).not.toHaveProperty('previous_response_id');
      expect(server.requests[2]).toHaveProperty('previous_response_id', 'response-1');
    }
  );

  it('continues incrementally on a healthy socket and replays the retained visual window after disconnect', async () => {
    const actions: ToolAction[] = [
      { type: 'tool', name: 'view_image', arguments: { path: 'image-a.png' } },
      { type: 'tool', name: 'read', arguments: { reads: [{ path: 'plain.txt' }] } },
      { type: 'tool', name: 'view_image', arguments: { path: 'image-a.png' } },
      { type: 'tool', name: 'view_image', arguments: { path: 'image-b.png' } },
      { type: 'final' }
    ];
    const events = actions.map((action, index) => toolEvents('OPENAI_RESPONSES', action, index));
    const server = await startResponsesWebSocketServer([], {
      responsesByConnection: [
        [events[0]!, events[1]!, events[2]!],
        [events[3]!, events[4]!]
      ],
      closeAfterRequestIndexes: [2]
    });
    servers.push(server.server);
    const { home, workspace, imageABase64, imageBBase64 } = await createImageWorkspace();
    const model = configuration('OPENAI_RESPONSES', server.baseUrl, 'WEBSOCKET');
    const agent = await createAgent(home, workspace, model);

    try {
      const session = await agent.createSession({ workspace, title: 'WebSocket image delivery' });
      await expect(
        session
          .run({
            prompt: 'Inspect this attachment and then the requested files.',
            images: [{ name: 'attachment.png', mimeType: 'image/png', dataBase64: imageABase64 }]
          })
          .result()
      ).resolves.toMatchObject({ status: 'completed' });
    } finally {
      await disposeAgent(agent);
    }

    const wireImage = `data:image/png;base64,${imageABase64}`;
    const wireImageB = `data:image/png;base64,${imageBBase64}`;
    expect(server.connections()).toBe(2);
    expect(server.requests).toHaveLength(5);
    expect(
      server.clientFrames.filter((frame) => frame.opcode === 1).map((frame) => frame.connection)
    ).toEqual([0, 0, 0, 1, 1]);
    expect(server.requests.map((body) => imagePayloads(body, 'OPENAI_RESPONSES'))).toEqual([
      [wireImage],
      [wireImage],
      [],
      [wireImage, wireImage, wireImage],
      [wireImageB]
    ]);
    expect(server.requests[1]).toHaveProperty('previous_response_id', 'response-0');
    expect(server.requests[2]).toHaveProperty('previous_response_id', 'response-1');
    expect(server.requests[3]).not.toHaveProperty('previous_response_id');
    expect(server.requests[4]).toHaveProperty('previous_response_id', 'response-3');
    expect(JSON.stringify(server.requests[3]?.input)).toContain(
      'Inspect this attachment and then the requested files.'
    );
    expect(server.requests.every((body) => !Object.hasOwn(body, 'images'))).toBe(true);

    for (const [requestIndex, expectedImages] of [
      [1, [wireImage]],
      [3, [wireImage, wireImage]],
      [4, [wireImageB]]
    ] as const) {
      const imageToolResults = objectsOfType(
        server.requests[requestIndex],
        'function_call_output'
      ).filter((item) => imagePayloads(item, 'OPENAI_RESPONSES').length > 0);
      expect(imageToolResults).toHaveLength(expectedImages.length);
      expect(imagePayloads(imageToolResults, 'OPENAI_RESPONSES')).toEqual(expectedImages);
    }
  });
});
