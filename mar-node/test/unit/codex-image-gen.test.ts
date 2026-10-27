import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAgentHost } from '@myagentroam/agent/host';
import { SecretValue, type AgentModelConfiguration } from '@myagentroam/agent';
import { createAgentWithAdapter as createMarAgent } from '../../../mar-agent/dist/sdk/agent.js';
import type {
  ModelAdapter,
  ModelEvent,
  ModelRequest
} from '../../../mar-agent/dist/model/contracts.js';
import {
  codexImageGenToolDefinition,
  executeCodexImageGen,
  type ImageGenerationConfiguration
} from '../../src/runner/mar-agent/image-generation.js';
import { createImageGenerationExtensions } from '../../src/runner/mar-agent/image-generation-extensions.js';
import { startSocks5Proxy, type CloseableServer } from '../support/image-generation-servers.js';
import { skillCatalog } from '../support/skill-catalog.js';
import { activeSessionDirectory } from '../../../mar-agent/test/support/jsonl-session-path.js';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const homes: string[] = [];
const servers: CloseableServer[] = [];

function credentialProvider(socks5Url?: string) {
  return {
    acquire: vi.fn(async () => ({
      revision: 1,
      expiresAt: Date.now() + 60_000,
      bearer: new SecretValue('edit-token'),
      headers: {
        'ChatGPT-Account-ID': new SecretValue('account-1'),
        originator: 'myagentroam'
      },
      ...(socks5Url === undefined ? {} : { socks5Url: new SecretValue(socks5Url) })
    })),
    invalidate: vi.fn(),
    close: vi.fn(async () => undefined)
  };
}

type ImageModelConfiguration = AgentModelConfiguration & {
  readonly imageGeneration: ImageGenerationConfiguration;
};

function imageModelConfiguration(
  port: number,
  provider: ReturnType<typeof credentialProvider>
): ImageModelConfiguration {
  return {
    id: 'codex',
    name: 'Codex',
    protocol: 'OPENAI_RESPONSES',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    credentialProvider: provider,
    modelId: 'gpt-codex',
    contextWindowTokens: 200_000,
    maxOutputTokens: 4096,
    inputCapabilities: ['TEXT', 'IMAGE'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['high'],
    titleGeneration: false,
    codeMode: false,
    hostedWebSearch: false,
    responsesTransport: { transport: 'WEBSOCKET' },
    responsesPreviousResponseId: true,
    imageGeneration: {
      provider: 'CODEX',
      config: { credentialId: 'credential-1', modelId: 'gpt-image-2' },
      generateEndpoint: `http://127.0.0.1:${port}/images/generations`,
      editEndpoint: `http://127.0.0.1:${port}/images/edits`,
      imageModelId: 'gpt-image-2',
      httpVersion: '1.1',
      credentialProvider: provider
    },
    enabled: true
  };
}

function bindImageGeneration(
  host: LocalAgentHost,
  configuration: ImageGenerationConfiguration,
  homeDirectory: string,
  displayDirectory?: string
): void {
  host.bindExecutionExtensions(
    createImageGenerationExtensions({
      configuration,
      homeDirectory,
      ...(displayDirectory === undefined ? {} : { displayDirectory }),
      host: () => host
    })
  );
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error)))
          )
      )
  );
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('codex_image_gen', () => {
  it.each([
    { provider: 'CODEX', partial: false, status: 200 },
    { provider: 'CODEX', partial: true, status: 200 },
    { provider: 'BYTED_ARK', partial: false, status: 200 },
    { provider: 'BYTED_ARK', partial: true, status: 200 },
    { provider: 'CODEX', partial: true, status: 503 }
  ])(
    'times out an idle $provider response body (partial=$partial, status=$status)',
    async ({ provider, partial, status }) => {
      vi.useFakeTimers();
      const directory = await mkdtemp(join(tmpdir(), 'imagegen-read-timeout-'));
      homes.push(directory);
      const cancel = vi.fn();
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          if (partial) controller.enqueue(new TextEncoder().encode('{"data":['));
        },
        cancel
      });
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(stream, { status }));
      const controller = new AbortController();
      let settled = false;
      const pending = executeCodexImageGen(
        {
          prompt: 'Generate a stalled image.',
          ...(partial ? { num_last_images_to_include: 1 } : {})
        },
        {
          configuration: {
            imageGeneration: {
              ...imageModelConfiguration(1, credentialProvider()).imageGeneration,
              provider
            }
          },
          sessionDirectory: directory,
          callId: 'stalled-image',
          signal: controller.signal,
          readImage: vi.fn(),
          recentImages: [{ mimeType: 'image/png', data: Buffer.from(PNG_BASE64, 'base64') }]
        }
      );
      const outcome = pending.then(
        (value) => {
          settled = true;
          return { status: 'resolved', value };
        },
        (error: unknown) => {
          settled = true;
          return { status: 'rejected', error };
        }
      );
      try {
        await vi.advanceTimersByTimeAsync(240_000);
        // Empty chunks must not keep a stalled response alive.
        streamController.enqueue(new Uint8Array());
        await vi.advanceTimersByTimeAsync(59_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(true);
        expect(await outcome).toMatchObject({
          status: 'rejected',
          error: {
            code: 'MAR_AGENT_IMAGE_GENERATION_READ_TIMEOUT',
            details: { reason: 'IMAGE_RESPONSE_READ_TIMEOUT', idleTimeoutMs: 300_000 }
          }
        });
        expect(cancel).toHaveBeenCalledWith(
          expect.objectContaining({ code: 'MAR_AGENT_IMAGE_GENERATION_READ_TIMEOUT' })
        );
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(await readdir(directory)).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        controller.abort(new Error('test cleanup'));
        await outcome;
      }
    }
  );

  it('resets the read idle timeout on data without imposing a total image deadline', async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), 'imagegen-slow-body-'));
    homes.push(directory);
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream));
    const controller = new AbortController();
    const pending = executeCodexImageGen(
      { prompt: 'Generate a steadily transferred image.' },
      {
        configuration: {
          imageGeneration: imageModelConfiguration(1, credentialProvider()).imageGeneration
        },
        sessionDirectory: directory,
        callId: 'slow-body',
        signal: controller.signal,
        readImage: vi.fn(),
        recentImages: []
      }
    );
    let settled = false;
    const outcome = pending.finally(() => {
      settled = true;
    });
    void outcome.catch(() => undefined);
    try {
      for (const chunk of ['{"data":[{"b64_json":"', PNG_BASE64, '"}]}']) {
        await vi.advanceTimersByTimeAsync(240_000);
        expect(settled).toBe(false);
        streamController.enqueue(new TextEncoder().encode(chunk));
        await vi.advanceTimersByTimeAsync(0);
      }
      streamController.close();
      const result = await outcome;
      expect(result.artifacts).toHaveLength(1);
      expect(
        await readFile(join(directory, 'generated_images', result.artifacts![0]!.fileName!))
      ).toEqual(Buffer.from(PNG_BASE64, 'base64'));
      expect(cancel).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.abort(new Error('test cleanup'));
      await outcome.catch(() => undefined);
    }
  });

  it.each(['cancel', 'stream-error', 'invalid-json'])(
    'cleans up the read timer after %s',
    async (failure) => {
      vi.useFakeTimers();
      const directory = await mkdtemp(join(tmpdir(), 'imagegen-read-failure-'));
      homes.push(directory);
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
        cancel
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream));
      const controller = new AbortController();
      const error = new Error('test response failure');
      const pending = executeCodexImageGen(
        { prompt: 'Generate an interrupted image.' },
        {
          configuration: {
            imageGeneration: imageModelConfiguration(1, credentialProvider()).imageGeneration
          },
          sessionDirectory: directory,
          callId: 'failed-body',
          signal: controller.signal,
          readImage: vi.fn(),
          recentImages: []
        }
      );
      const outcome = pending.catch((error: unknown) => error);
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(1);
        if (failure === 'cancel') controller.abort(error);
        else if (failure === 'stream-error') streamController.error(error);
        else {
          streamController.enqueue(new TextEncoder().encode('{'));
          streamController.close();
        }
        const result = await outcome;
        if (failure === 'invalid-json')
          expect(result).toMatchObject({ code: 'MAR_AGENT_IMAGE_GENERATION_RESPONSE_INVALID' });
        else expect(result).toBe(error);
        if (failure === 'cancel') expect(cancel).toHaveBeenCalledWith(error);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        controller.abort(new Error('test cleanup'));
        await outcome;
      }
    }
  );

  it('allows one image request five minutes to receive response headers', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_request, init) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined;
          requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), {
            once: true
          });
        })
    );
    const controller = new AbortController();
    const provider = credentialProvider();
    const configuration = imageModelConfiguration(1, provider);
    const pending = executeCodexImageGen(
      { prompt: 'Generate a slow image.' },
      {
        configuration: { imageGeneration: configuration.imageGeneration },
        sessionDirectory: join(tmpdir(), 'unused-imagegen-timeout'),
        callId: 'slow-image',
        signal: controller.signal,
        readImage: vi.fn(),
        recentImages: []
      }
    );
    const outcome = pending.then(
      (value) => ({ status: 'resolved' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error })
    );

    try {
      await vi.advanceTimersByTimeAsync(30_001);
      expect(requestSignal).toBeDefined();
      expect(requestSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(269_998);
      expect(requestSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(requestSignal?.aborted).toBe(true);
      expect(await outcome).toMatchObject({
        status: 'rejected',
        error: {
          code: 'MAR_AGENT_MODEL_TIMEOUT',
          details: { reason: 'MODEL_CONNECTION_TIMEOUT' }
        }
      });
    } finally {
      controller.abort(new Error('test cleanup'));
      await outcome;
    }
  });

  it('routes image generation through authenticated SOCKS5 with proxy-side DNS', async () => {
    const target = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
      });
    });
    servers.push(target);
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const address = target.address();
    if (address === null || typeof address === 'string') throw new Error('server unavailable');
    const proxy = await startSocks5Proxy({
      targetPort: address.port,
      username: 'image-proxy-user',
      password: 'image-proxy-pass'
    });
    servers.push(proxy.server);
    const provider = credentialProvider(proxy.url);
    const base = imageModelConfiguration(address.port, provider);
    const configuration: ImageModelConfiguration = {
      ...base,
      imageGeneration: {
        ...base.imageGeneration!,
        generateEndpoint: `http://images.internal:${address.port}/images/generations`,
        editEndpoint: `http://images.internal:${address.port}/images/edits`
      }
    };
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-image-proxy-'));
    homes.push(home);

    await expect(
      executeCodexImageGen(
        { prompt: 'Generate through the configured proxy.' },
        {
          configuration: { imageGeneration: configuration.imageGeneration },
          sessionDirectory: home,
          callId: 'proxy-image',
          signal: new AbortController().signal,
          readImage: vi.fn(),
          recentImages: []
        }
      )
    ).resolves.toMatchObject({
      artifacts: [{ kind: 'image', mimeType: 'image/png' }]
    });
    expect(proxy.destinations).toEqual([{ host: 'images.internal', port: address.port }]);
    expect(proxy.authentications).toEqual([
      { username: 'image-proxy-user', password: 'image-proxy-pass' }
    ]);
  });

  it('does not repeat a non-idempotent image request after a retryable HTTP status', async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      request.resume();
      request.on('end', () => {
        response.writeHead(503, {
          'content-type': 'application/json',
          'retry-after': '0'
        });
        response.end(
          JSON.stringify({ error: { code: 'service_unavailable', message: 'Try again later.' } })
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server unavailable');
    const provider = credentialProvider();

    await expect(
      executeCodexImageGen(
        { prompt: 'Generate once.' },
        {
          configuration: {
            imageGeneration: imageModelConfiguration(address.port, provider).imageGeneration
          },
          sessionDirectory: join(tmpdir(), 'unused-imagegen-no-retry'),
          callId: 'single-image-request',
          signal: new AbortController().signal,
          readImage: vi.fn(),
          recentImages: []
        }
      )
    ).rejects.toMatchObject({
      code: 'service_unavailable',
      details: { status: 503 }
    });
    expect(requests).toBe(1);
    expect(provider.acquire).toHaveBeenCalledTimes(1);
  });

  it('refreshes a dynamic credential once, saves PNG output, returns only its path, and supports view_image', async () => {
    const requests: Array<{
      readonly headers: Record<string, string | string[] | undefined>;
      readonly body: unknown;
    }> = [];
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        requests.push({
          headers: request.headers,
          body: JSON.parse(body)
        });
        if (requests.length === 1) {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { code: 'unauthorized', message: 'expired' } }));
          return;
        }
        response.writeHead(200, {
          'content-type': 'application/json',
          'x-codex-imagegen-request-id': 'image-request-1'
        });
        response.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server unavailable');

    const acquire = vi
      .fn()
      .mockResolvedValueOnce({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('first-token'),
        headers: {
          'ChatGPT-Account-ID': new SecretValue('account-1'),
          originator: 'myagentroam'
        }
      })
      .mockResolvedValueOnce({
        revision: 2,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('second-token'),
        headers: {
          'ChatGPT-Account-ID': new SecretValue('account-1'),
          originator: 'myagentroam'
        }
      });
    const invalidate = vi.fn();
    const provider = {
      acquire,
      invalidate,
      close: vi.fn(async () => undefined)
    };
    const configuration: ImageModelConfiguration = {
      id: 'codex',
      name: 'Codex',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      credentialProvider: provider,
      modelId: 'gpt-codex',
      contextWindowTokens: 200_000,
      maxOutputTokens: 4096,
      inputCapabilities: ['TEXT', 'IMAGE'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: ['high'],
      titleGeneration: false,
      codeMode: false,
      hostedWebSearch: false,
      responsesTransport: { transport: 'WEBSOCKET' },
      responsesPreviousResponseId: true,
      imageGeneration: {
        provider: 'CODEX',
        config: { credentialId: 'credential-1', modelId: 'gpt-image-2' },
        generateEndpoint: `http://127.0.0.1:${address.port}/images/generations`,
        editEndpoint: `http://127.0.0.1:${address.port}/images/edits`,
        imageModelId: 'gpt-image-2',
        httpVersion: '1.1',
        credentialProvider: provider
      },
      enabled: true
    };
    const { imageGeneration, ...modelConfiguration } = configuration;
    let generatedPath: string | undefined;
    class ImageGenerationAdapter implements ModelAdapter {
      readonly configuration = modelConfiguration;
      readonly requests: ModelRequest[] = [];
      private skillRequests = 0;
      async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
        if (
          !request.messages.some(
            (message) =>
              message.role === 'tool' &&
              message.content.includes('<mar_skill name="codex-imagegen" source="Host-provided">')
          )
        ) {
          expect(this.skillRequests++).toBe(0);
          expect(request.system).not.toContain('codex-imagegen');
          expect(skillCatalog(request)).toContain('codex-imagegen');
          yield {
            type: 'client_tool.call',
            callId: 'load-imagegen',
            name: 'skill',
            arguments: { name: 'codex-imagegen' }
          };
          yield { type: 'completed', reason: 'tool_use' };
          return;
        }
        this.requests.push(request);
        if (this.requests.length === 1) {
          const tool = request.tools.find((candidate) => candidate.name === 'codex_image_gen');
          expect(tool).toBeDefined();
          expect(Object.keys(tool!.inputSchema.properties ?? {}).sort()).toEqual([
            'num_last_images_to_include',
            'prompt',
            'referenced_image_paths'
          ]);
          yield {
            type: 'client_tool.call',
            callId: 'image/call:1',
            name: 'codex_image_gen',
            arguments: {
              prompt: 'A blue geometric landing-page background.',
              referenced_image_paths: null,
              num_last_images_to_include: null
            }
          };
          yield { type: 'completed', reason: 'tool_use' };
          return;
        }
        if (this.requests.length === 2) {
          const result = request.messages.at(-1);
          expect(result).toMatchObject({ role: 'tool', callId: 'image/call:1' });
          expect(result).not.toHaveProperty('images');
          const content = result?.content ?? '';
          expect(content).not.toContain(PNG_BASE64);
          generatedPath = /Generated image saved to (.+)\.\n/u.exec(content)?.[1];
          expect(generatedPath).toContain(
            `${join('.mar', 'agent', 'sessions')}${process.platform === 'win32' ? '\\' : '/'}`
          );
          yield {
            type: 'client_tool.call',
            callId: 'view-generated',
            name: 'view_image',
            arguments: { path: generatedPath }
          };
          yield { type: 'completed', reason: 'tool_use' };
          return;
        }
        expect(request.messages.at(-1)).toMatchObject({
          role: 'tool',
          callId: 'view-generated',
          images: [{ mimeType: 'image/png', dataBase64: PNG_BASE64 }]
        });
        yield { type: 'text.completed', itemId: 'answer', text: 'ready' };
        yield { type: 'completed', reason: 'completed' };
      }
    }

    const home = await mkdtemp(join(tmpdir(), 'mar-agent-image-gen-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    const host = new LocalAgentHost({ homeDirectory: home, workspace });
    bindImageGeneration(host, imageGeneration, home);
    const adapter = new ImageGenerationAdapter();
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host,
        models: [modelConfiguration]
      },
      () => adapter
    );
    const session = await agent.createSession({ workspace, title: 'Image generation' });

    const result = await session.run({ prompt: 'Generate and inspect a background.' }).result();
    expect(result.errorMessage).toBeUndefined();
    expect(result).toMatchObject({ status: 'completed', finalAnswer: 'ready' });

    expect(acquire.mock.calls.map(([reason]) => reason)).toEqual(['REQUEST', 'UNAUTHORIZED']);
    expect(invalidate).toHaveBeenCalledWith(1);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers).toMatchObject({
      authorization: 'Bearer first-token',
      'chatgpt-account-id': 'account-1',
      originator: 'myagentroam'
    });
    expect(requests[1]?.headers).toMatchObject({ authorization: 'Bearer second-token' });
    expect(requests[1]?.headers['x-codex-image-turn-id']).toEqual(expect.any(String));
    expect(requests[1]?.body).toEqual({
      prompt: 'A blue geometric landing-page background.',
      background: 'auto',
      model: 'gpt-image-2',
      n: 1,
      quality: 'auto',
      size: 'auto'
    });
    expect(generatedPath).toBeDefined();
    await expect(readFile(generatedPath!)).resolves.toEqual(Buffer.from(PNG_BASE64, 'base64'));

    const imageEvent = host.events.find(
      (event) => event.type === 'tool.completed' && event.toolName === 'codex_image_gen'
    );
    expect(imageEvent).toMatchObject({
      type: 'tool.completed',
      artifacts: [
        {
          kind: 'image',
          name: 'image_call_1.png',
          mimeType: 'image/png',
          byteSize: 68,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          fileName: 'image_call_1.png'
        }
      ]
    });
    const persisted = await readFile(
      join(await activeSessionDirectory(home, session.id), 'events-000001.jsonl'),
      'utf8'
    );
    expect(persisted).toContain('"toolName":"codex_image_gen"');
    expect(persisted).toContain('"fileName":"image_call_1.png"');
    expect(persisted).not.toContain(PNG_BASE64);
    expect(persisted).not.toContain('first-token');
    expect(persisted).not.toContain('second-token');

    await agent.dispose();
  });

  it('returns a Host logical path while keeping the generated PNG in the Session directory', async () => {
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server unavailable');
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-image-display-path-'));
    homes.push(home);
    const sessionDirectory = join(home, 'session');

    const result = await executeCodexImageGen(
      { prompt: 'Generate a safe hosted preview path.' },
      {
        configuration: {
          imageGeneration: imageModelConfiguration(address.port, credentialProvider())
            .imageGeneration
        },
        sessionDirectory,
        displayDirectory: '/generated-images',
        callId: 'logical',
        signal: new AbortController().signal,
        readImage: vi.fn(),
        recentImages: []
      }
    );

    expect(result.content).toBe('Generated image saved to /generated-images/image_logical.png.\n');
    expect(result.content).not.toContain(sessionDirectory);
    await expect(
      readFile(join(sessionDirectory, 'generated_images', 'image_logical.png'))
    ).resolves.toEqual(Buffer.from(PNG_BASE64, 'base64'));
  });

  it('edits an absolute referenced image through the Host image boundary and persists no pixels', async () => {
    const requests: Array<{ readonly url: string; readonly body: unknown }> = [];
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        requests.push({ url: request.url ?? '', body: JSON.parse(body) });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server unavailable');

    const provider = credentialProvider();
    const configuration = imageModelConfiguration(address.port, provider);
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-image-edit-path-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace, { recursive: true });
    const referencePath = join(workspace, 'reference.png');
    await writeFile(referencePath, Buffer.from(PNG_BASE64, 'base64'));
    const host = new LocalAgentHost({
      homeDirectory: home,
      workspace,
      restrictPaths: true,
      pathMounts: [{ logicalPath: '/workspace', physicalPath: workspace, writable: true }]
    });
    const { imageGeneration, ...modelConfiguration } = configuration;
    bindImageGeneration(host, imageGeneration, home);
    class ReferencedEditAdapter implements ModelAdapter {
      readonly configuration = modelConfiguration;
      readonly requests: ModelRequest[] = [];
      async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
        this.requests.push(request);
        if (this.requests.length === 1) {
          yield {
            type: 'client_tool.call',
            callId: 'edit/path',
            name: 'codex_image_gen',
            arguments: {
              prompt: 'Add a red border.',
              referenced_image_paths: ['/workspace/reference.png'],
              num_last_images_to_include: null
            }
          };
          yield { type: 'completed', reason: 'tool_use' };
          return;
        }
        const result = request.messages.at(-1);
        expect(result).toMatchObject({ role: 'tool', callId: 'edit/path' });
        expect(result).not.toHaveProperty('images');
        expect(result?.content).not.toContain(PNG_BASE64);
        yield { type: 'text.completed', itemId: 'answer', text: 'edited' };
        yield { type: 'completed', reason: 'completed' };
      }
    }
    const adapter = new ReferencedEditAdapter();
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host,
        models: [modelConfiguration]
      },
      () => adapter
    );
    const session = await agent.createSession({ workspace, title: 'Referenced image edit' });

    await expect(
      session.run({ prompt: 'Edit the reference image.' }).result()
    ).resolves.toMatchObject({ status: 'completed', finalAnswer: 'edited' });

    expect(requests).toEqual([
      {
        url: '/images/edits',
        body: {
          images: [{ image_url: `data:image/png;base64,${PNG_BASE64}` }],
          prompt: 'Add a red border.',
          background: 'auto',
          model: 'gpt-image-2',
          n: 1,
          quality: 'auto',
          size: 'auto'
        }
      }
    ]);
    expect(provider.acquire).toHaveBeenCalledWith('REQUEST');
    const persisted = await readFile(
      join(await activeSessionDirectory(home, session.id), 'events-000001.jsonl'),
      'utf8'
    );
    expect(persisted).toContain('"toolName":"codex_image_gen"');
    expect(persisted).not.toContain(PNG_BASE64);
    await agent.dispose();
  });

  it('edits the requested number of recent Execution images without persisting their pixels', async () => {
    const requests: Array<{ readonly url: string; readonly body: unknown }> = [];
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        requests.push({ url: request.url ?? '', body: JSON.parse(body) });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server unavailable');

    const provider = credentialProvider();
    const configuration = imageModelConfiguration(address.port, provider);
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-image-edit-recent-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    const host = new LocalAgentHost({ homeDirectory: home, workspace });
    const { imageGeneration, ...modelConfiguration } = configuration;
    bindImageGeneration(host, imageGeneration, home);
    class RecentEditAdapter implements ModelAdapter {
      readonly configuration = modelConfiguration;
      readonly requests: ModelRequest[] = [];
      async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
        this.requests.push(request);
        if (this.requests.length === 1) {
          yield {
            type: 'client_tool.call',
            callId: 'edit/recent',
            name: 'codex_image_gen',
            arguments: {
              prompt: 'Make the latest image warmer.',
              num_last_images_to_include: 1
            }
          };
          yield { type: 'completed', reason: 'tool_use' };
          return;
        }
        expect(request.messages.at(-1)).toMatchObject({
          role: 'tool',
          callId: 'edit/recent'
        });
        yield { type: 'text.completed', itemId: 'answer', text: 'recent edited' };
        yield { type: 'completed', reason: 'completed' };
      }
    }
    const adapter = new RecentEditAdapter();
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host,
        models: [modelConfiguration]
      },
      () => adapter
    );
    const session = await agent.createSession({ workspace, title: 'Recent image edit' });

    await expect(
      session
        .run({
          prompt: 'Edit my attached image.',
          images: [{ name: 'input.png', mimeType: 'image/png', dataBase64: PNG_BASE64 }]
        })
        .result()
    ).resolves.toMatchObject({ status: 'completed', finalAnswer: 'recent edited' });

    expect(requests).toEqual([
      {
        url: '/images/edits',
        body: {
          images: [{ image_url: `data:image/png;base64,${PNG_BASE64}` }],
          prompt: 'Make the latest image warmer.',
          background: 'auto',
          model: 'gpt-image-2',
          n: 1,
          quality: 'auto',
          size: 'auto'
        }
      }
    ]);
    const persisted = await readFile(
      join(await activeSessionDirectory(home, session.id), 'events-000001.jsonl'),
      'utf8'
    );
    expect(persisted).toContain('"name":"input.png"');
    expect(persisted).not.toContain(PNG_BASE64);
    await agent.dispose();
  });

  it('rejects conflicting selectors, bounds, relative paths, and unavailable recent images', async () => {
    expect(Object.keys(codexImageGenToolDefinition.inputSchema.properties ?? {})).toEqual([
      'prompt',
      'referenced_image_paths',
      'num_last_images_to_include'
    ]);
    const provider = credentialProvider();
    const configuration = imageModelConfiguration(1, provider);
    const readImage = vi.fn(async () => ({
      mimeType: 'image/png' as const,
      data: Buffer.from(PNG_BASE64, 'base64')
    }));
    const execute = (
      arguments_: unknown,
      recentImages: readonly { readonly mimeType: string; readonly data: Buffer }[] = []
    ) =>
      executeCodexImageGen(arguments_, {
        configuration: { imageGeneration: configuration.imageGeneration },
        sessionDirectory: join(tmpdir(), 'unused-imagegen-session'),
        callId: 'invalid',
        signal: new AbortController().signal,
        readImage,
        recentImages
      });

    await expect(
      execute({
        prompt: 'edit',
        referenced_image_paths: [join(tmpdir(), 'image.png')],
        num_last_images_to_include: 1
      })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
    await expect(
      execute({
        prompt: 'edit',
        referenced_image_paths: Array.from({ length: 6 }, (_, index) =>
          join(tmpdir(), `image-${index}.png`)
        )
      })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
    await expect(
      execute({ prompt: 'edit', referenced_image_paths: ['relative.png'] })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
    await expect(execute({ prompt: 'edit', num_last_images_to_include: 0 })).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID'
    });
    await expect(
      execute({ prompt: 'edit', num_last_images_to_include: 2 }, [
        { mimeType: 'image/png', data: Buffer.from(PNG_BASE64, 'base64') }
      ])
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
    expect(readImage).not.toHaveBeenCalled();
  });

  it('does not expose sensitive upstream error text', async () => {
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              code: 'invalid_request_error',
              message: 'Authorization: Bearer upstream-secret-token'
            }
          })
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server unavailable');
    const provider = credentialProvider();
    const configuration = imageModelConfiguration(address.port, provider);

    await expect(
      executeCodexImageGen(
        { prompt: 'generate' },
        {
          configuration: { imageGeneration: configuration.imageGeneration },
          sessionDirectory: join(tmpdir(), 'unused-imagegen-session'),
          callId: 'error',
          signal: new AbortController().signal,
          readImage: vi.fn(),
          recentImages: []
        }
      )
    ).rejects.toMatchObject({
      code: 'invalid_request_error',
      message: 'invalid_request_error: Image generation failed with HTTP 400.'
    });
  });

  it('allows independent image credentials for static text-only models and rejects missing image credentials', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-image-gen-config-'));
    homes.push(home);
    const host = new LocalAgentHost({ homeDirectory: home, workspace: join(home, 'workspace') });
    const imageCredentialProvider = credentialProvider();
    const imageGeneration: ImageGenerationConfiguration = {
      provider: 'CODEX',
      config: { credentialId: 'credential-1', modelId: 'gpt-image-2' },
      generateEndpoint: 'https://chatgpt.com/backend-api/codex/images/generations',
      editEndpoint: 'https://chatgpt.com/backend-api/codex/images/edits',
      imageModelId: 'gpt-image-2',
      httpVersion: '1.1' as const,
      credentialProvider: imageCredentialProvider
    };
    const base = {
      id: 'invalid',
      name: 'Invalid',
      protocol: 'OPENAI_RESPONSES' as const,
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      modelId: 'gpt-codex',
      contextWindowTokens: 200_000,
      maxOutputTokens: 4096,
      outputCapabilities: ['TEXT'] as ['TEXT'],
      reasoningEfforts: [],
      titleGeneration: false,
      codeMode: false,
      hostedWebSearch: false,
      responsesPreviousResponseId: false,
      enabled: true
    };

    const model: AgentModelConfiguration = {
      ...base,
      apiKey: new SecretValue('static-key'),
      inputCapabilities: ['TEXT']
    };
    host.bindExecutionExtensions(
      createImageGenerationExtensions({
        configuration: imageGeneration,
        homeDirectory: home,
        host: () => host
      })
    );
    const agent = await createMarAgent({
      mode: 'normal',
      host,
      models: [model]
    });
    await agent.dispose();
    await expect(
      Promise.resolve().then(() =>
        createImageGenerationExtensions({
          configuration: {
            ...imageGeneration,
            credentialProvider: undefined
          } as unknown as ImageGenerationConfiguration,
          homeDirectory: home,
          host: () => host
        })
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_MODEL_CONFIG_INVALID' });
    await host.dispose();
  });
});
