import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgentWithAdapter as createMarAgent } from '../../../mar-agent/dist/sdk/agent.js';
import { directLocalProcessExecutor } from '../../../mar-agent/dist/host/local-process-executor.js';
import type { ModelEvent } from '../../../mar-agent/dist/model/contracts.js';
import { marAgentRuntimeModelConfigurationSchema } from '@myagentroam/protocol';
import { MarAgentHostedConversationRuntime } from '../../src/runner/mar-agent/hosted-conversation-runtime.js';
import { executeCodexImageGen } from '../../src/runner/mar-agent/image-generation.js';
import { SecretValue } from '@myagentroam/agent';
import { MarAgentRuntimeModelFactory } from '../../src/runner/mar-agent/runtime-model-factory.js';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(
  (['CODEX', 'BYTED_ARK'] as const).flatMap((provider) => [
    { provider, codeMode: false, failSecond: false, observeResults: true, edit: false },
    { provider, codeMode: true, failSecond: false, observeResults: true, edit: false },
    { provider, codeMode: true, failSecond: true, observeResults: true, edit: false },
    { provider, codeMode: true, failSecond: false, observeResults: false, edit: false },
    { provider, codeMode: true, failSecond: false, observeResults: true, edit: true }
  ])
)(
  'delivers concurrent $provider hosted images (codeMode=$codeMode, failSecond=$failSecond, observe=$observeResults, edit=$edit)',
  async ({ provider, codeMode, failSecond, observeResults, edit }) => {
    const root = await mkdtemp(join(tmpdir(), 'mar-hosted-image-'));
    roots.push(root);
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    if (edit) await writeFile(join(workspace, 'reference.png'), Buffer.from(PNG, 'base64'));
    let releaseRequests!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      releaseRequests = resolve;
    });
    const prompts: string[] = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const { prompt } = JSON.parse(String(init?.body)) as { prompt: string };
      if (edit) {
        const body = JSON.parse(String(init?.body));
        if (provider === 'CODEX')
          expect(body.images).toEqual([{ image_url: `data:image/png;base64,${PNG}` }]);
        else expect(body.image).toBe(`data:image/png;base64,${PNG}`);
      }
      prompts.push(prompt);
      if (prompts.length === 2) releaseRequests();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          bothStarted,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Image requests did not overlap.')), 1000);
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
      return failSecond && prompt === 'A circle'
        ? new Response('{}', { status: 400 })
        : new Response(JSON.stringify({ data: [{ b64_json: PNG }] }));
    });
    const ticket = {
      userId: 1,
      credentialId: 'image-key',
      nodeId: 'node',
      workspaceId: 'workspace',
      sessionId: 'session',
      runtimeScopeId: 'scope',
      allowedModelIds: ['image-generation'],
      issuedAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      nonce: 'nonce',
      signature: 'a'.repeat(64),
      purpose: 'IMAGE_GENERATION' as const
    };
    const model = marAgentRuntimeModelConfigurationSchema.parse({
      id: 'text',
      name: 'Text',
      protocol: 'ANTHROPIC_MESSAGES',
      baseUrl: 'https://example.test',
      credential: { type: 'INLINE_API_KEY', value: 'text-key' },
      modelId: 'text',
      contextWindowTokens: 200_000,
      maxOutputTokens: 4096,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: [],
      hostedWebSearch: false,
      codeMode,
      titleGeneration: false,
      enabled: true,
      imageGeneration: {
        provider,
        config: {},
        imageModelId: 'image',
        generateEndpoint: 'https://example.test/images',
        editEndpoint: 'https://example.test/images',
        httpVersion: '1.1',
        credential:
          provider === 'CODEX'
            ? { type: 'RUNTIME_TICKET', credentialId: 'image-key', ticket }
            : { type: 'INLINE_API_KEY', value: 'image-key' }
      }
    });
    const events: import('@myagentroam/agent').AgentEvent[] = [];
    const resolveCredential = vi.fn(async () => ({
      nextTicket: ticket,
      credential: {
        bearer: 'image-key',
        headers: {},
        revision: 1,
        expiresAt: Date.now() + 3600_000
      }
    }));
    let round = 0;
    const register = vi.fn(
      (_runId: string, _roots: readonly string[], images: readonly { name: string }[]) =>
        images.map((image) => ({ id: image.name, name: image.name }))
    );
    const runtime = new MarAgentHostedConversationRuntime({
      generateTitle: async () => undefined,
      modelFactory: new MarAgentRuntimeModelFactory({
        resolve: resolveCredential
      }),
      registerNativeImages: register,
      onEvent: (_conversationId, event) => {
        events.push(event);
      },
      createAgent: (options) => {
        expect(options.models[0]).not.toHaveProperty('imageGeneration');
        expect(options).not.toHaveProperty('generatedImageDisplayDirectory');
        return createMarAgent(
          {
            ...options
          },
          (configuration) => ({
            configuration,
            async *start(request): AsyncIterable<ModelEvent> {
              const name = provider === 'CODEX' ? 'codex_image_gen' : 'byted_ark_image_gen';
              expect(request.tools.some((tool) => tool.name === 'view_image')).toBe(false);
              expect(request.system).toContain('Host-provided');
              expect(request.tools.some((tool) => tool.name === name)).toBe(!codeMode);
              if (codeMode) {
                expect(
                  request.tools.find((tool) => tool.name === 'code_exec')?.description
                ).toContain(name);
              }
              if (round++ === 0) {
                yield {
                  type: 'client_tool.call',
                  callId: 'image-skill',
                  name: 'skill',
                  arguments: {
                    name: provider === 'CODEX' ? 'codex-imagegen' : 'byted_ark-imagegen'
                  }
                };
                yield { type: 'completed', reason: 'tool_use' };
              } else if (round === 2) {
                if (codeMode) {
                  yield {
                    type: 'client_tool.call',
                    callId: 'image-code',
                    name: 'code_exec',
                    inputMode: 'freeform',
                    arguments: `const results = await Promise.allSettled([
                      tools.${name}(${JSON.stringify({ prompt: 'A square', ...(edit ? { referenced_image_paths: ['/workspace/reference.png'] } : {}) })}),
                      tools.${name}(${JSON.stringify({ prompt: 'A circle', ...(edit ? { referenced_image_paths: ['/workspace/reference.png'] } : {}) })})
                    ]);
                    ${observeResults ? 'for (const result of results) observe.result(result.status === "fulfilled" ? result.value : result.reason);' : ''}`
                  };
                } else {
                  for (const [index, prompt] of ['A square', 'A circle'].entries()) {
                    yield {
                      type: 'client_tool.call',
                      callId: `image-call-${index}`,
                      name,
                      arguments: { prompt }
                    };
                  }
                }
                yield { type: 'completed', reason: 'tool_use' };
              } else {
                if (!codeMode || observeResults) {
                  expect(request.messages.at(-1)?.content).toContain(
                    '/home/mar/.mar/agent/sessions/'
                  );
                } else {
                  expect(request.messages.at(-1)?.content).not.toContain(
                    '/home/mar/.mar/agent/sessions/'
                  );
                }
                expect(request.messages.at(-1)?.content).not.toContain(home);
                yield { type: 'text.completed', itemId: 'answer', text: 'Image ready.' };
                yield { type: 'completed', reason: 'completed' };
              }
            }
          })
        );
      }
    });
    const common = {
      conversationId: 'conversation',
      runtimeScopeId: 'scope',
      homeDirectory: home,
      workspaceDirectory: workspace,
      systemInstruction: 'Create requested images.',
      models: [model],
      processExecutor: directLocalProcessExecutor,
      pathMounts: [{ logicalPath: '/workspace', physicalPath: workspace, writable: false }]
    };
    try {
      const { sessionId } = await runtime.createSession({ ...common, defaultModelId: model.id });
      const run = await runtime.startRun({
        ...common,
        sessionId,
        modelId: model.id,
        clientMessageId: 'message',
        prompt: 'Generate two independent images.',
        userPrompt: 'Generate two independent images.',
        attachmentIds: [],
        access: 'full-access',
        temporaryDirectory: join(root, 'tmp'),
        mcpServers: [],
        webAccess: false
      });
      const completion = await run.completion;
      expect(
        completion.status,
        JSON.stringify(
          events.filter(
            (event) => event.type === 'execution.failed' || event.type === 'tool.failed'
          )
        )
      ).toBe('SUCCEEDED');
      const name = provider === 'CODEX' ? 'codex_image_gen' : 'byted_ark_image_gen';
      const completed = events.filter(
        (event) => event.type === 'tool.completed' && event.toolName === name
      );
      expect(completed).toHaveLength(failSecond ? 1 : 2);
      for (const event of completed) {
        expect(event.type === 'tool.completed' && event.artifacts).toHaveLength(1);
        if (codeMode) expect(event).toMatchObject({ parentCallId: 'image-code' });
      }
      expect(
        events.filter((event) => event.type === 'tool.failed' && event.toolName === name)
      ).toHaveLength(failSecond ? 1 : 0);
      expect(
        new Set(completed.map((event) => event.type === 'tool.completed' && event.callId)).size
      ).toBe(completed.length);
      const directory = join(home, '.mar', 'agent', 'sessions', sessionId, 'generated_images');
      const files = await readdir(directory);
      expect(files).toHaveLength(failSecond ? 1 : 2);
      for (const file of files)
        expect(await readFile(join(directory, file))).toEqual(Buffer.from(PNG, 'base64'));
      expect(prompts.sort()).toEqual(['A circle', 'A square']);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(resolveCredential).toHaveBeenCalledTimes(provider === 'CODEX' ? 1 : 0);
      if (provider === 'CODEX') {
        expect(
          new Set(
            fetch.mock.calls.map(([, init]) =>
              new Headers(init?.headers).get('x-codex-image-turn-id')
            )
          ).size
        ).toBe(2);
      }
      expect(register).toHaveBeenCalled();
      const history = await runtime.history({
        conversationId: 'conversation',
        sessionId,
        homeDirectory: home
      });
      expect(JSON.stringify(history)).toContain('IMAGE_GENERATION');
      expect(JSON.stringify(history)).not.toContain(PNG);
      expect(JSON.stringify(history)).not.toContain(home);
      for (const file of files) expect(JSON.stringify(history)).toContain(file);
    } finally {
      await runtime.dispose();
    }
  }
);

it.each(['credential', 'body'] as const)(
  'cancels while waiting for the image %s without replay or files',
  async (step) => {
    const root = await mkdtemp(join(tmpdir(), 'mar-image-cancel-'));
    roots.push(root);
    const signal = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cancel = vi.fn();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      entered();
      return new Response(new ReadableStream({ cancel }));
    });
    const pending = executeCodexImageGen(
      { prompt: 'A square' },
      {
        configuration: {
          imageGeneration: {
            provider: 'CODEX',
            config: {},
            imageModelId: 'image',
            generateEndpoint: 'https://example.test/images',
            editEndpoint: 'https://example.test/images',
            httpVersion: '1.1',
            credentialProvider: {
              acquire: async () => {
                if (step === 'credential') {
                  entered();
                  return new Promise<never>(() => undefined);
                }
                return {
                  bearer: new SecretValue('test'),
                  revision: 0,
                  expiresAt: Date.now() + 60000,
                  headers: {}
                };
              },
              invalidate: vi.fn(),
              close: vi.fn(async () => undefined)
            }
          }
        },
        sessionDirectory: root,
        callId: 'cancel',
        signal: signal.signal,
        recentImages: [],
        readImage: vi.fn()
      }
    );
    const assertion = expect(pending).rejects.toThrow('stopped');
    await ready;
    // Let the response body reader install its cancellation listener.
    await new Promise<void>((resolve) => setImmediate(resolve));
    signal.abort(new Error('stopped'));
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(step === 'body' ? 1 : 0);
    if (step === 'body') expect(cancel).toHaveBeenCalledOnce();
    expect(await readdir(root)).toEqual([]);
  }
);
