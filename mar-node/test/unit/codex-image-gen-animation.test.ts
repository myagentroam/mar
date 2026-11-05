import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretValue } from '@myagentroam/agent';
import {
  bytedArkImageGenToolDefinition,
  codexImageGenToolDefinition,
  executeCodexImageGen,
  type ImageGenerationConfiguration
} from '../../src/runner/mar-agent/image-generation.js';

const MODEL_ID = 'gpt-image-2.6-flare';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const directories: string[] = [];
const servers: Server[] = [];

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly body: Record<string, unknown>;
}

interface TestApi {
  readonly port: number;
  readonly requests: CapturedRequest[];
}

function credentialProvider() {
  return {
    acquire: vi.fn(async () => ({
      revision: 1,
      expiresAt: Date.now() + 60_000,
      bearer: new SecretValue('animation-test-token'),
      headers: { originator: 'myagentroam' }
    })),
    invalidate: vi.fn(),
    close: vi.fn(async () => undefined)
  };
}

async function startApi(payload: unknown, status = 200): Promise<TestApi> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (body += chunk));
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        body: JSON.parse(body) as Record<string, unknown>
      });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake API unavailable');
  return { port: address.port, requests };
}

function imageConfiguration(port: number, provider = 'CODEX'): ImageGenerationConfiguration {
  const credentials = credentialProvider();
  return {
    provider,
    config: { credentialId: 'test-credential', modelId: MODEL_ID },
    generateEndpoint: `http://127.0.0.1:${port}/images/generations`,
    editEndpoint: `http://127.0.0.1:${port}/images/edits`,
    imageModelId: MODEL_ID,
    httpVersion: '1.1',
    credentialProvider: credentials
  };
}

async function sessionDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'codex-image-animation-'));
  directories.push(directory);
  return directory;
}

async function execute(
  api: TestApi,
  arguments_: unknown,
  options: {
    readonly provider?: string;
    readonly readImage?: (
      path: string
    ) => Promise<{ readonly mimeType: string; readonly data: Buffer }>;
    readonly recentImages?: readonly { readonly mimeType: string; readonly data: Buffer }[];
  } = {}
) {
  return executeCodexImageGen(arguments_, {
    configuration: {
      imageGeneration: imageConfiguration(api.port, options.provider),
      credentialProvider: credentialProvider()
    },
    sessionDirectory: await sessionDirectory(),
    callId: 'animation-test',
    signal: new AbortController().signal,
    readImage:
      options.readImage ??
      (async (path: string) => {
        throw new Error(`Unexpected image read: ${path}`);
      }),
    recentImages: options.recentImages ?? []
  });
}

async function executeAndRead(
  api: TestApi,
  arguments_: unknown,
  options: Parameters<typeof execute>[2] = {}
) {
  const directory = await sessionDirectory();
  const result = await executeCodexImageGen(arguments_, {
    configuration: {
      imageGeneration: imageConfiguration(api.port, options.provider),
      credentialProvider: credentialProvider()
    },
    sessionDirectory: directory,
    callId: 'animation-test',
    signal: new AbortController().signal,
    readImage:
      options.readImage ??
      (async (path: string) => {
        throw new Error(`Unexpected image read: ${path}`);
      }),
    recentImages: options.recentImages ?? []
  });
  const artifact = result.artifacts?.[0];
  if (artifact?.fileName === undefined) throw new Error('image artifact was not returned');
  const bytes = await readFile(join(directory, 'generated_images', artifact.fileName));
  return { result, artifact, bytes };
}

function imageResponse(data: Buffer): unknown {
  return { data: [{ b64_json: data.toString('base64') }] };
}

afterEach(async () => {
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
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('Codex image animation and transparent background', () => {
  it('keeps the strict Codex schema limited to selectors, transparency, and GIF options', () => {
    const schema = codexImageGenToolDefinition.inputSchema as {
      readonly additionalProperties?: boolean;
      readonly properties?: Record<
        string,
        {
          readonly additionalProperties?: boolean;
          readonly properties?: Record<string, unknown>;
        }
      >;
    };
    expect(Object.keys(schema.properties ?? {})).toEqual([
      'prompt',
      'referenced_image_paths',
      'num_last_images_to_include',
      'transparent_background',
      'gif'
    ]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties?.['gif']?.properties ?? {}).sort()).toEqual([
      'frame_count',
      'frame_duration_ms'
    ]);
    expect(schema.properties?.['gif']?.additionalProperties).toBe(false);
  });

  it('preserves the legacy PNG request shape and maps the default background to opaque', async () => {
    const api = await startApi(imageResponse(PNG));
    const { artifact, bytes } = await executeAndRead(api, {
      prompt: 'Generate a static PNG.'
    });

    expect(api.requests).toEqual([
      {
        method: 'POST',
        url: '/images/generations',
        body: {
          prompt: 'Generate a static PNG.',
          background: 'opaque',
          model: MODEL_ID,
          quality: 'auto',
          size: 'auto'
        }
      }
    ]);
    expect(artifact).toMatchObject({
      mimeType: 'image/png',
      fileName: expect.stringMatching(/\.png$/u)
    });
    expect(bytes).toEqual(PNG);
  });

  it('maps true transparent_background to the Codex transparent background request', async () => {
    const api = await startApi(imageResponse(PNG));
    await executeAndRead(api, {
      prompt: 'Generate with transparency.',
      transparent_background: true
    });

    expect(api.requests[0]?.body).toMatchObject({
      background: 'transparent',
      quality: 'auto',
      size: 'auto'
    });
    expect(api.requests[0]?.body).not.toHaveProperty('transparent_background');
    expect(api.requests[0]?.body).not.toHaveProperty('n');
    expect(api.requests[0]?.body).not.toHaveProperty('output_format');
  });

  it('maps explicit false transparency to an opaque request', async () => {
    const api = await startApi(imageResponse(PNG));
    await executeAndRead(api, {
      prompt: 'Generate an opaque image.',
      transparent_background: false
    });

    expect(api.requests[0]?.body).toHaveProperty('background', 'opaque');
  });

  it('treats null options as omitted and maps false transparency to opaque', async () => {
    const api = await startApi(imageResponse(PNG));
    await executeAndRead(api, {
      prompt: 'Keep legacy defaults.',
      referenced_image_paths: null,
      num_last_images_to_include: null,
      transparent_background: null,
      gif: null
    });

    expect(api.requests[0]?.body).toMatchObject({
      background: 'opaque',
      quality: 'auto',
      size: 'auto'
    });
    expect(api.requests[0]?.body).not.toHaveProperty('output_format');
    expect(api.requests[0]?.body).not.toHaveProperty('frame_count');
    expect(api.requests[0]?.body).not.toHaveProperty('frame_duration_ms');
  });

  it('uses the GIF API format while leaving empty-object frame defaults to the service', async () => {
    const api = await startApi(imageResponse(GIF));
    const { artifact, bytes } = await executeAndRead(api, {
      prompt: 'Animate the scene.',
      gif: {}
    });

    expect(api.requests[0]?.body).toMatchObject({
      prompt: 'Animate the scene.',
      background: 'opaque',
      model: MODEL_ID,
      output_format: 'gif',
      quality: 'auto',
      size: 'auto'
    });
    expect(api.requests[0]?.body).not.toHaveProperty('frame_count');
    expect(api.requests[0]?.body).not.toHaveProperty('frame_duration_ms');
    expect(artifact).toMatchObject({
      mimeType: 'image/gif',
      fileName: expect.stringMatching(/\.gif$/u)
    });
    expect(bytes).toEqual(GIF);
  });

  it('treats nullable GIF controls as omitted without leaving GIF mode', async () => {
    const api = await startApi(imageResponse(GIF));
    await executeAndRead(api, {
      prompt: 'Use the service animation defaults.',
      gif: { frame_count: null, frame_duration_ms: null }
    });

    expect(api.requests[0]?.body).toHaveProperty('output_format', 'gif');
    expect(api.requests[0]?.body).not.toHaveProperty('frame_count');
    expect(api.requests[0]?.body).not.toHaveProperty('frame_duration_ms');
  });

  it.each([
    { frame_count: 2, frame_duration_ms: 20 },
    { frame_count: 16, frame_duration_ms: 2000 }
  ])(
    'flattens valid GIF frame bounds to the API request ($frame_count, $frame_duration_ms)',
    async (gif) => {
      const api = await startApi(imageResponse(GIF));
      await executeAndRead(api, { prompt: 'Animate at a boundary.', gif });

      expect(api.requests[0]?.body).toMatchObject({
        output_format: 'gif',
        frame_count: gif.frame_count,
        frame_duration_ms: gif.frame_duration_ms
      });
    }
  );

  it('allows a referenced image to be edited into a GIF', async () => {
    const api = await startApi(imageResponse(GIF));
    const referencePath = join(tmpdir(), 'animation-reference.png');
    const { artifact, bytes } = await executeAndRead(
      api,
      {
        prompt: 'Animate the reference.',
        referenced_image_paths: [referencePath],
        gif: { frame_count: 3, frame_duration_ms: 250 }
      },
      {
        readImage: vi.fn(async () => ({ mimeType: 'image/png', data: PNG }))
      }
    );

    expect(api.requests[0]?.url).toBe('/images/edits');
    expect(api.requests[0]?.body).toMatchObject({
      images: [{ image_url: `data:image/png;base64,${PNG.toString('base64')}` }],
      output_format: 'gif',
      frame_count: 3,
      frame_duration_ms: 250
    });
    expect(artifact).toMatchObject({
      mimeType: 'image/gif',
      fileName: expect.stringMatching(/\.gif$/u)
    });
    expect(bytes).toEqual(GIF);
  });

  it('chooses saved MIME type and extension from PNG/GIF signatures and preserves bytes', async () => {
    for (const testCase of [
      { requestGif: false, data: PNG, mimeType: 'image/png', extension: '.png' },
      { requestGif: true, data: GIF, mimeType: 'image/gif', extension: '.gif' },
      { requestGif: true, data: PNG, mimeType: 'image/png', extension: '.png' }
    ]) {
      const api = await startApi(imageResponse(testCase.data));
      const { artifact, bytes } = await executeAndRead(api, {
        prompt: 'Return the image bytes.',
        ...(testCase.requestGif ? { gif: {} } : {})
      });

      expect(artifact.mimeType).toBe(testCase.mimeType);
      expect(artifact.fileName.endsWith(testCase.extension)).toBe(true);
      expect(bytes).toEqual(testCase.data);
    }
  });

  it.each([
    { name: 'unknown signature', data: Buffer.from('not an image') },
    { name: 'truncated GIF signature', data: Buffer.from('GIF8') },
    { name: 'non-ASCII GIF signature', data: Buffer.from([0xc7, 0xc9, 0xc6, 0xb8, 0xb9, 0xe1]) },
    { name: 'truncated PNG signature', data: PNG.subarray(0, 4) }
  ])('rejects a bad image response ($name)', async ({ data }) => {
    const api = await startApi(imageResponse(data));
    await expect(execute(api, { prompt: 'Reject malformed output.' })).rejects.toMatchObject({
      code: 'MAR_AGENT_IMAGE_GENERATION_RESPONSE_INVALID'
    });
  });

  it('rejects out-of-range GIF values, invalid option types, and unknown API keys before requesting', async () => {
    const api = await startApi(imageResponse(PNG));
    const invalidInputs: unknown[] = [
      { prompt: 'bad', transparent_background: 'true' },
      { prompt: 'bad', gif: true },
      { prompt: 'bad', gif: { frame_count: 1 } },
      { prompt: 'bad', gif: { frame_count: 17 } },
      { prompt: 'bad', gif: { frame_count: 2.5 } },
      { prompt: 'bad', gif: { frame_duration_ms: 19 } },
      { prompt: 'bad', gif: { frame_duration_ms: 2001 } },
      { prompt: 'bad', gif: { frame_duration_ms: 20.5 } },
      { prompt: 'bad', gif: { extra: true } },
      { prompt: 'bad', output_format: 'png' },
      { prompt: 'bad', output_compression: 80 },
      { prompt: 'bad', quality: 'high' },
      { prompt: 'bad', size: '1024x1024' },
      { prompt: 'bad', complexity: 'low' },
      { prompt: 'bad', frame_count: 2 },
      { prompt: 'bad', frame_duration_ms: 200 },
      { prompt: 'bad', markup_image_path: join(tmpdir(), 'markup.png') },
      { prompt: 'bad', background: 'transparent' },
      { prompt: 'bad', unexpected: true }
    ];

    for (const input of invalidInputs)
      await expect(execute(api, input)).rejects.toMatchObject({
        code: 'MAR_AGENT_TOOL_INPUT_INVALID'
      });
    expect(api.requests).toEqual([]);
  });

  it('keeps the Ark schema unchanged and rejects Codex-only animation arguments', async () => {
    expect(Object.keys(bytedArkImageGenToolDefinition.inputSchema.properties ?? {}).sort()).toEqual(
      ['num_last_images_to_include', 'prompt', 'referenced_image_paths']
    );
    const api = await startApi(imageResponse(PNG));
    for (const input of [
      { prompt: 'Ark rejects this.', transparent_background: true },
      { prompt: 'Ark rejects this.', gif: {} }
    ])
      await expect(execute(api, input, { provider: 'BYTED_ARK' })).rejects.toMatchObject({
        code: 'MAR_AGENT_TOOL_INPUT_INVALID'
      });
    expect(api.requests).toEqual([]);
  });

  it('does not expose sensitive upstream error text', async () => {
    const api = await startApi(
      {
        error: {
          code: 'invalid_request_error',
          message: 'Authorization: Bearer animation-upstream-secret'
        }
      },
      400
    );
    const error = await execute(api, { prompt: 'Generate an image.' }).catch(
      (reason: unknown) => reason
    );
    expect(error).toMatchObject({ code: 'invalid_request_error' });
    expect(JSON.stringify(error)).not.toContain('animation-upstream-secret');
  });
});
