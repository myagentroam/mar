import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretValue, LocalAgentHost } from '@myagentroam/agent';
import { createMarAgentWithAdapter as createMarAgent } from '../../../mar-agent/dist/agent-core/sdk/agent.js';
import type {
  ModelRequest,
  ModelEvent
} from '../../../mar-agent/dist/agent-core/model/contracts.js';
import {
  executeCodexImageGen,
  type ImageGenerationConfiguration
} from '../../src/runner/mar-agent/image-generation.js';
import { createImageGenerationExtensions } from '../../src/runner/mar-agent/image-generation-extensions.js';
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
afterEach(() => vi.restoreAllMocks());
function configuration(): ImageGenerationConfiguration {
  return {
    provider: 'BYTED_ARK',
    config: { modelId: 'doubao-seedream-5.0-lite' },
    generateEndpoint: 'https://ark.cn-beijing.volces.com/api/plan/v3/images/generations',
    editEndpoint: 'https://ark.cn-beijing.volces.com/api/plan/v3/images/generations',
    imageModelId: 'doubao-seedream-5.0-lite',
    httpVersion: '1.1' as const,
    credentialProvider: {
      acquire: vi.fn(async () => ({
        bearer: new SecretValue('ark-test-key'),
        revision: 0,
        expiresAt: Number.MAX_SAFE_INTEGER,
        headers: {}
      })),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    }
  };
}
describe('BYTED_ARK image generation', () => {
  it.each([false, true])(
    'uses single PNG output and optional reference pixels (edit=%s)',
    async (edit) => {
      const directory = await mkdtemp(join(tmpdir(), 'ark-images-'));
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: PNG }] })));
      try {
        const imageGeneration = configuration();
        const output = await executeCodexImageGen(
          { prompt: 'A square', ...(edit ? { referenced_image_paths: ['/reference.png'] } : {}) },
          {
            configuration: { imageGeneration },
            sessionDirectory: directory,
            callId: 'ark',
            signal: new AbortController().signal,
            readImage: async () => ({ mimeType: 'image/png', data: Buffer.from(PNG, 'base64') }),
            recentImages: []
          }
        );
        const [url, init] = fetch.mock.calls[0]!;
        expect(url).toBe(imageGeneration.generateEndpoint);
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ark-test-key');
        expect(new Headers(init?.headers).has('chatgpt-account-id')).toBe(false);
        expect(JSON.parse(String(init?.body))).toEqual({
          model: 'doubao-seedream-5.0-lite',
          prompt: 'A square',
          size: '2K',
          output_format: 'png',
          response_format: 'b64_json',
          watermark: false,
          stream: false,
          sequential_image_generation: 'disabled',
          ...(edit ? { image: `data:image/png;base64,${PNG}` } : {})
        });
        expect(output.artifacts).toHaveLength(1);
        expect(
          await readFile(join(directory, 'generated_images', output.artifacts![0]!.fileName!))
        ).toEqual(Buffer.from(PNG, 'base64'));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
  it('does not retry a 401 or return multiple outputs as a single image', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 401 }));
    const input = {
      configuration: { imageGeneration: configuration() },
      sessionDirectory: tmpdir(),
      callId: 'unused',
      signal: new AbortController().signal,
      readImage: vi.fn(),
      recentImages: []
    };
    await expect(executeCodexImageGen({ prompt: 'A square' }, input)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: PNG }, { b64_json: PNG }] }))
    );
    await expect(executeCodexImageGen({ prompt: 'A square' }, input)).rejects.toThrow();
  });
  it.each(['CODEX', 'BYTED_ARK'])(
    'only exposes selected %s tool and skill to a text-only model',
    async (provider) => {
      const home = await mkdtemp(join(tmpdir(), 'image-skills-'));
      try {
        const image = { ...configuration(), provider };
        let system = '';
        let toolNames: string[] = [];
        const model = {
          id: 'coding',
          name: 'Coding',
          protocol: 'ANTHROPIC_MESSAGES' as const,
          baseUrl: 'https://example.test',
          modelId: 'coding',
          apiKey: new SecretValue('text-key'),
          contextWindowTokens: 200000,
          maxOutputTokens: 4096,
          inputCapabilities: ['TEXT'] as ('TEXT' | 'IMAGE')[],
          outputCapabilities: ['TEXT'] as ['TEXT'],
          reasoningEfforts: [],
          titleGeneration: false,
          codeMode: false,
          hostedWebSearch: false,
          enabled: true
        };
        const host = new LocalAgentHost({ homeDirectory: home, workspace: home });
        host.bindExecutionExtensions(
          createImageGenerationExtensions({
            configuration: image,
            homeDirectory: home,
            host: () => host
          })
        );
        const agent = await createMarAgent({
          mode: 'normal',
          host,
          models: [model],
          adapterFactory: () => ({
            configuration: model,
            async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
              system = request.system;
              toolNames = request.tools.map((t) => t.name);
              yield { type: 'text.completed', itemId: 'answer', text: 'Ready' };
              yield { type: 'completed', reason: 'completed' };
            }
          })
        });
        try {
          const session = await agent.createSession({ workspace: home });
          await session.run({ prompt: 'List image tools' }).result();
          const selected = provider === 'CODEX' ? 'codex' : 'byted_ark';
          const other = provider === 'CODEX' ? 'byted_ark' : 'codex';
          expect(toolNames).toContain(`${selected}_image_gen`);
          expect(toolNames).not.toContain(`${other}_image_gen`);
          expect(system).toContain(`${selected}-imagegen`);
          expect(system).not.toContain(`${other}-imagegen`);
        } finally {
          await agent.dispose();
        }
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  );
});
