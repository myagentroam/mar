import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createAgentWithAdapter } from '../../src/sdk/agent.js';
import { LocalAgentHost } from '../../src/host.js';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import type {
  ModelAdapter,
  ModelEvent,
  ModelMessage,
  ModelRequest
} from '../../src/model/contracts.js';
import { assertInlineMediaBudget } from '../../src/model/inline-media-budget.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import type { SessionStore } from '../../src/session/store/contracts.js';
import type { SessionRecord } from '../../src/session/store/types.js';

const homes: string[] = [];
const MiB = 1_048_576;
const modelBase: AgentModelConfiguration = {
  id: 'vision',
  name: 'Vision',
  protocol: 'OPENAI_RESPONSES',
  baseUrl: 'https://example.test',
  apiKey: new SecretValue('test'),
  modelId: 'vision',
  contextWindowTokens: 100_000,
  maxOutputTokens: 1_000,
  inputCapabilities: ['TEXT', 'IMAGE'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: ['low'],
  hostedWebSearch: false,
  defaultReasoningEffort: 'low',
  enabled: true,
  codeMode: false
};

interface ScriptedReply {
  events?: readonly ModelEvent[];
  reason?: 'completed' | 'tool_use';
  noUsage?: boolean;
}

interface RequestSnapshot {
  imageHashes: string[];
  messages: Array<Pick<ModelMessage, 'role' | 'content'>>;
}

class ScriptedAdapter implements ModelAdapter {
  readonly requests: RequestSnapshot[] = [];
  resetContinuationCalls = 0;

  constructor(
    readonly configuration: AgentModelConfiguration,
    private readonly replies: readonly ScriptedReply[]
  ) {}

  createTurnSession() {
    return {
      start: (request: ModelRequest) => this.start(request),
      resetContinuation: () => {
        this.resetContinuationCalls++;
      },
      close: async () => undefined
    };
  }

  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    assertInlineMediaBudget(request);
    const index = this.requests.length;
    this.requests.push({
      imageHashes: request.messages
        .flatMap((message) => message.images ?? [])
        .map((image) => {
          if (image.dataBase64 === undefined)
            throw new Error('The SDK did not resolve an inline image before adapter dispatch.');
          return createHash('sha256').update(Buffer.from(image.dataBase64, 'base64')).digest('hex');
        }),
      messages: request.messages.map(({ role, content }) => ({ role, content }))
    });

    const diagnostic = {
      protocol: this.configuration.protocol,
      transport: 'HTTP' as const,
      attempt: 1,
      maxAttempts: 1,
      continuation: false,
      credentialReason: 'REQUEST' as const
    };
    await request.onAttemptDiagnostic?.({ ...diagnostic, state: 'STARTED' });
    const reply = this.replies[index] ?? { events: [] };
    for (const event of reply.events ?? []) yield event;
    if (!reply.noUsage)
      yield {
        type: 'usage',
        usage: {
          inputTokens: 24,
          contextInputTokens: 24,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0
        }
      };
    yield { type: 'completed', reason: reply.reason ?? 'completed' };
    await request.onAttemptDiagnostic?.({
      ...diagnostic,
      state: 'SUCCEEDED',
      semanticEventObserved: true
    });
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mar-sdk-inline-media-'));
  homes.push(home);
  await writeFile(join(home, 'notes.txt'), 'ORDINARY_TOOL_EVIDENCE');
  const create = (adapter: ScriptedAdapter, codeMode = false, sessionStore?: SessionStore) => {
    const model: AgentModelConfiguration = { ...adapter.configuration, codeMode };
    return createAgentWithAdapter(
      {
        mode: 'normal',
        models: [model],
        host: new LocalAgentHost({ homeDirectory: home, workspace: home }),
        ...(sessionStore === undefined ? {} : { sessionStore })
      },
      () => adapter
    );
  };
  return { home, create };
}

async function imagePng(label: string): Promise<Buffer> {
  const targetBytes = 3 * MiB;
  const base = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 30, g: 80, b: 160, alpha: 1 }
    }
  })
    .png()
    .toBuffer();
  const iendOffset = base.byteLength - 12;
  const payloadBytes = targetBytes - base.byteLength - 12;
  if (iendOffset < 8 || payloadBytes < 16) throw new Error('PNG fixture is too small to pad.');

  const payload = Buffer.alloc(payloadBytes, 0x20);
  Buffer.from(`sdk-fixture-${label}\0`, 'ascii').copy(payload);
  const chunk = Buffer.alloc(payloadBytes + 12);
  chunk.writeUInt32BE(payloadBytes, 0);
  chunk.write('tEXt', 4, 'ascii');
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(pngCrc32(chunk.subarray(4, 8 + payloadBytes)), 8 + payloadBytes);
  const image = Buffer.concat([base.subarray(0, iendOffset), chunk, base.subarray(iendOffset)]);
  if (image.byteLength !== targetBytes) throw new Error('PNG fixture size is incorrect.');
  await sharp(image, { failOn: 'warning' }).raw().toBuffer();
  return image;
}

function pngCrc32(data: Buffer): number {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function imageInput(name: string, data: Buffer) {
  return { name, mimeType: 'image/png' as const, dataBase64: data.toString('base64') };
}

function imageHash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function toolCall(callId: string, name: string, arguments_: unknown): ModelEvent {
  return { type: 'client_tool.call', callId, name, arguments: arguments_ };
}

function readCall(callId: string): ModelEvent {
  return toolCall(callId, 'read', { reads: [{ path: 'notes.txt' }] });
}

function codeModeCall(callId: string, code: string): ModelEvent {
  return toolCall(callId, 'code_exec', { code });
}

async function readRecords(home: string, sessionId: string): Promise<SessionRecord[]> {
  const store = await JsonlSessionStore.open(home);
  try {
    return await store.read(sessionId);
  } finally {
    await store.close();
  }
}

function expectSingleInlineGcCheckpoint(
  records: readonly SessionRecord[],
  reason?: 'SOFT_LIMIT' | 'HARD_LIMIT' | 'TEXT_GC'
): void {
  const checkpoints = records.filter((record) => record.type === 'context.gc.completed');
  expect(checkpoints).toHaveLength(1);
  expect(JSON.stringify(checkpoints[0]!.payload)).toContain('"evictedThrough"');
  if (reason) {
    expect(
      (checkpoints[0]!.payload as { inlineMedia?: { reason?: string } }).inlineMedia?.reason
    ).toBe(reason);
  }
  let committedEvictedThrough: unknown;
  for (const record of records) {
    if (record.type === 'context.gc.completed') {
      const state = (record.payload as { inlineMedia?: { state?: { evictedThrough?: unknown } } })
        .inlineMedia?.state;
      if (state?.evictedThrough !== undefined) committedEvictedThrough = state.evictedThrough;
    } else if (record.type === 'resource.window') {
      expect((record.payload as { evictedThrough?: unknown }).evictedThrough).toEqual(
        committedEvictedThrough
      );
    }
  }
}

describe('SDK inline media lifecycle', () => {
  it.each([false, true])(
    'views Session resource IDs through the SDK dispatcher (Code Mode=%s)',
    async (codeMode) => {
      const { home, create } = await fixture();
      const store = await JsonlSessionStore.open(home);
      const replies: ScriptedReply[] = [];
      const adapter = new ScriptedAdapter({ ...modelBase, codeMode }, replies);
      const agent = await create(adapter, codeMode, store);
      try {
        const session = await agent.createSession({ workspace: home, title: 'Resource input' });
        const bytes = await imagePng('resource-input');
        const resource = await store.persistResource(session.id, imageInput('stored.png', bytes));
        const call = (callId: string) =>
          codeMode
            ? codeModeCall(
                callId,
                `observe.result(await tools.view_image({resourceId:${JSON.stringify(resource.resourceId)}}));`
              )
            : toolCall(callId, 'view_image', { resourceId: resource.resourceId });
        const completed: ScriptedReply = {
          events: [{ type: 'text.completed', itemId: 'done', text: 'done' }]
        };
        replies.push(completed);
        expect(
          await session
            .run({
              prompt: 'remember the image resource',
              images: [imageInput('stored.png', bytes)]
            })
            .result()
        ).toMatchObject({ status: 'completed' });
        replies.push({ events: [call('resource-view')], reason: 'tool_use' }, completed);
        expect(await session.run({ prompt: 'inspect the saved resource' }).result()).toMatchObject({
          status: 'completed'
        });
        expect(adapter.requests[2]?.imageHashes).toEqual([imageHash(bytes), imageHash(bytes)]);
        expect(
          adapter.requests[2]?.messages.some((message) => message.content.includes('1×1 px'))
        ).toBe(true);
        const other = await agent.createSession({ workspace: home, title: 'Foreign resource' });
        replies.push({ events: [call('other-session-view')], reason: 'tool_use' }, completed);
        expect(await other.run({ prompt: 'try a foreign resource' }).result()).toMatchObject({
          status: 'completed'
        });
        expect(adapter.requests[4]?.imageHashes).toEqual([]);
        expect(
          adapter.requests[4]?.messages.some((message) =>
            message.content.includes('not found in this Session')
          )
        ).toBe(true);
      } finally {
        await agent.dispose();
        await store.close();
      }
    }
  );

  it.each([false, true])(
    'keeps the valid local image tool path and later ordinary tool history through GC (Code Mode=%s)',
    async (codeMode) => {
      const { home, create } = await fixture();
      const promptImage = await imagePng('prompt');
      const toolImage = await imagePng('local-tool');
      await writeFile(join(home, 'large.png'), toolImage);
      const viewCall = codeMode
        ? codeModeCall('view-1', 'observe.result(await tools.view_image({path:"large.png"}));')
        : toolCall('view-1', 'view_image', { path: 'large.png' });
      const ordinaryCall = codeMode
        ? codeModeCall('read-1', 'observe.result(await tools.read({reads:[{path:"notes.txt"}]}));')
        : readCall('read-1');
      const adapter = new ScriptedAdapter({ ...modelBase, codeMode }, [
        { events: [viewCall], reason: 'tool_use' },
        { events: [ordinaryCall], reason: 'tool_use' },
        { events: [{ type: 'text.completed', itemId: 'answer', text: 'done' }] },
        { events: [{ type: 'text.completed', itemId: 'continued', text: 'continued' }] }
      ]);
      const agent = await create(adapter, codeMode);
      let sessionId = '';
      try {
        const session = await agent.createSession({ workspace: home, title: 'Inline lifecycle' });
        sessionId = session.id;
        expect(
          await session
            .run({ prompt: 'inspect', images: [imageInput('prompt.png', promptImage)] })
            .result()
        ).toMatchObject({ status: 'completed' });

        expect(adapter.requests[0]!.imageHashes).toEqual([imageHash(promptImage)]);
        expect(adapter.requests[1]!.imageHashes).toEqual(
          expect.arrayContaining([imageHash(promptImage), imageHash(toolImage)])
        );
        expect(adapter.requests[1]!.imageHashes).toHaveLength(2);
        expect(
          await session.run({ prompt: 'continue after the ordinary tool' }).result()
        ).toMatchObject({ status: 'completed' });

        const continued = adapter.requests.at(-1)!;
        expect(continued.imageHashes).toEqual([imageHash(toolImage)]);
        expect(
          continued.messages.some((message) => message.content.includes('ORDINARY_TOOL_EVIDENCE'))
        ).toBe(true);
        expect(adapter.resetContinuationCalls).toBe(1);
      } finally {
        await agent.dispose();
      }
      expectSingleInlineGcCheckpoint(await readRecords(home, sessionId));
    }
  );

  it.each([false, true])(
    'soft-GCs image history and preserves its cursor on reopen/fork (rollback=%s)',
    async (rollback) => {
      const { home, create } = await fixture();
      const firstImage = await imagePng('soft-first');
      const secondImage = await imagePng('soft-second');
      const adapter = new ScriptedAdapter(modelBase, [
        { events: [{ type: 'text.completed', itemId: 'first', text: 'first image turn' }] },
        { events: [{ type: 'text.completed', itemId: 'second', text: 'second image turn' }] }
      ]);
      let agent = await create(adapter);
      let sessionId = '';
      try {
        const session = await agent.createSession({ workspace: home, title: 'Soft inline GC' });
        sessionId = session.id;
        expect(
          await session
            .run({
              prompt: 'two image-only observations',
              images: [imageInput('first.png', firstImage), imageInput('second.png', secondImage)]
            })
            .result()
        ).toMatchObject({ status: 'completed' });
        expect(adapter.requests[0]!.imageHashes).toEqual([
          imageHash(firstImage),
          imageHash(secondImage)
        ]);
        expect(Buffer.byteLength(imageInput('size-check.png', firstImage).dataBase64)).toBe(
          4 * MiB
        );
        expect(adapter.resetContinuationCalls).toBe(0);

        expect(await session.run({ prompt: 'advance without new images' }).result()).toMatchObject({
          status: 'completed'
        });
        expect(adapter.requests[1]!.imageHashes).toHaveLength(2);
        expect(adapter.resetContinuationCalls).toBe(1);
        await agent.dispose();

        let beforeReopen = await readRecords(home, sessionId);
        expectSingleInlineGcCheckpoint(beforeReopen);
        const boundaryTurnId = beforeReopen.findLast(
          (record) => record.type === 'turn.user'
        )!.turnId!;
        const lifecycleStore = await JsonlSessionStore.open(home);
        const fork = await lifecycleStore.forkSession(sessionId, {
          boundaryTurnId,
          title: 'After image GC'
        });
        if (rollback) {
          await lifecycleStore.rollbackSession(sessionId, { boundaryTurnId });
          beforeReopen = await lifecycleStore.read(sessionId);
          expectSingleInlineGcCheckpoint(beforeReopen);
        }
        await lifecycleStore.close();
        const reopenedAdapter = new ScriptedAdapter(modelBase, [
          { events: [{ type: 'text.completed', itemId: 'reopened', text: 'reopened history' }] },
          { events: [{ type: 'text.completed', itemId: 'forked', text: 'forked history' }] }
        ]);
        agent = await create(reopenedAdapter);
        const reopened = await agent.openSession(sessionId);
        expect(await reopened.run({ prompt: 'cold reopen' }).result()).toMatchObject({
          status: 'completed'
        });
        expect(reopenedAdapter.requests[0]!.imageHashes).toEqual([imageHash(secondImage)]);
        expect(
          reopenedAdapter.requests[0]!.messages.some((message) =>
            message.content.includes('two image-only observations')
          )
        ).toBe(true);
        const forked = await agent.openSession(fork.id);
        expect(await forked.run({ prompt: 'continue the fork' }).result()).toMatchObject({
          status: 'completed'
        });
        expect(reopenedAdapter.requests[1]!.imageHashes).toEqual([imageHash(secondImage)]);
        await agent.dispose();
        const afterReopen = await readRecords(home, sessionId);
        expect(afterReopen.slice(0, beforeReopen.length)).toEqual(beforeReopen);
        expect(afterReopen.length).toBeGreaterThan(beforeReopen.length);
        expectSingleInlineGcCheckpoint(afterReopen);
      } finally {
        await agent.dispose();
      }
    }
  );

  it('does not adopt the image cursor when checkpoint persistence fails', async () => {
    const { home, create } = await fixture();
    const firstImage = await imagePng('failed-persist-first');
    const secondImage = await imagePng('failed-persist-second');
    const store = await JsonlSessionStore.open(home);
    const commit = vi
      .spyOn(store, 'commitContextGc')
      .mockRejectedValue(new Error('synthetic inline media checkpoint persistence failure'));
    const adapter = new ScriptedAdapter(modelBase, [
      { events: [readCall('read-1')], reason: 'tool_use' },
      { events: [readCall('read-2')], reason: 'tool_use' },
      { events: [{ type: 'text.completed', itemId: 'answer', text: 'still complete' }] }
    ]);
    let agent: Awaited<ReturnType<typeof createAgentWithAdapter>> | undefined;
    let sessionId = '';
    try {
      agent = await create(adapter, false, store);
      const session = await agent.createSession({
        workspace: home,
        title: 'Failed image GC write'
      });
      sessionId = session.id;
      expect(
        await session
          .run({
            prompt: 'images remain until durable checkpoint',
            images: [imageInput('first.png', firstImage), imageInput('second.png', secondImage)]
          })
          .result()
      ).toMatchObject({ status: 'completed' });

      expect(commit).toHaveBeenCalled();
      expect(adapter.requests[2]!.imageHashes).toEqual([
        imageHash(firstImage),
        imageHash(secondImage)
      ]);
      expect(adapter.resetContinuationCalls).toBe(0);
    } finally {
      commit.mockRestore();
      await agent?.dispose();
      await store.close();
    }
    expect(
      (await readRecords(home, sessionId)).filter(
        (record) => record.type === 'context.gc.completed'
      )
    ).toHaveLength(0);
  });

  it('rejects media over the hard budget without GC when the model disables it', async () => {
    const { home, create } = await fixture();
    const first = await imagePng('disabled-first');
    const second = await imagePng('disabled-second');
    const fresh = await imagePng('disabled-fresh');
    const adapter = new ScriptedAdapter({ ...modelBase, gcEnabled: false }, [
      { events: [{ type: 'text.completed', itemId: 'seed', text: 'history' }] }
    ]);
    const agent = await create(adapter);
    const session = await agent.createSession({ workspace: home });
    try {
      expect(
        await session
          .run({
            prompt: 'seed',
            images: [imageInput('first.png', first), imageInput('second.png', second)]
          })
          .result()
      ).toMatchObject({ status: 'completed' });
      expect(
        await session.run({ prompt: 'fresh', images: [imageInput('fresh.png', fresh)] }).result()
      ).toMatchObject({ status: 'failed' });
      expect(adapter.requests).toHaveLength(1);
    } finally {
      await agent.dispose();
    }
    expect(
      (await readRecords(home, session.id)).filter(
        (record) => record.type === 'context.gc.completed'
      )
    ).toHaveLength(0);
  });

  it.each(['usage', 'no-usage', 'model-switch', 'reopen-no-usage'])(
    'hard-GCs history before dispatch while preserving fresh media (%s)',
    async (mode) => {
      const emitUsage = mode !== 'no-usage';
      const { home, create } = await fixture();
      const firstImage = await imagePng('hard-first');
      const secondImage = await imagePng('hard-second');
      const freshImage = await imagePng('hard-fresh');
      let adapter = new ScriptedAdapter(modelBase, [
        {
          events: [{ type: 'text.completed', itemId: 'seed', text: 'protected history' }],
          noUsage: !emitUsage
        },
        {
          events: [{ type: 'text.completed', itemId: 'hard', text: 'fresh image retained' }],
          noUsage: !emitUsage
        }
      ]);
      let agent = await create(adapter);
      let sessionId = '';
      try {
        let session = await agent.createSession({ workspace: home, title: 'Hard inline GC' });
        sessionId = session.id;
        expect(
          await session
            .run({
              prompt: 'protected old history',
              images: [imageInput('first.png', firstImage), imageInput('second.png', secondImage)]
            })
            .result()
        ).toMatchObject({ status: 'completed' });
        expect(adapter.resetContinuationCalls).toBe(0);

        if (mode === 'reopen-no-usage') {
          vi.spyOn(adapter, 'start').mockImplementationOnce(async function* () {
            throw new Error('Simulated provider failure before usage.');
          });
          expect(await session.run({ prompt: 'Continue without usage.' }).result()).toMatchObject({
            status: 'failed'
          });
          await agent.dispose();
          adapter = new ScriptedAdapter(modelBase, [
            {
              events: [{ type: 'text.completed', itemId: 'reopened', text: 'fresh image retained' }]
            }
          ]);
          agent = await create(adapter);
          session = await agent.openSession(sessionId);
        }

        if (mode === 'model-switch') {
          await agent.dispose();
          adapter = new ScriptedAdapter({ ...modelBase, id: 'new-model', modelId: 'new-model' }, [
            { events: [{ type: 'text.completed', itemId: 'new', text: 'new model' }] }
          ]);
          agent = await create(adapter);
          session = await agent.openSession(sessionId);
        }

        expect(
          await session
            .run({
              prompt: 'new hard-limit image',
              modelId: adapter.configuration.id,
              images: [imageInput('fresh.png', freshImage)]
            })
            .result()
        ).toMatchObject({ status: 'completed' });
        const dispatched =
          adapter.requests[mode === 'model-switch' || mode === 'reopen-no-usage' ? 0 : 1]!;
        expect(dispatched.imageHashes).toEqual([imageHash(freshImage)]);
        expect(
          dispatched.messages.some((message) => message.content.includes('protected old history'))
        ).toBe(true);
        expect(adapter.resetContinuationCalls).toBe(1);
        await agent.dispose();
      } finally {
        await agent.dispose();
      }
      expectSingleInlineGcCheckpoint(await readRecords(home, sessionId), 'HARD_LIMIT');
      if (mode !== 'usage') {
        const checkpoint = (await readRecords(home, sessionId)).find(
          (record) => record.type === 'context.gc.completed'
        )!;
        expect(
          (checkpoint.payload as { trigger: { usageSequence: number | null } }).trigger
            .usageSequence
        ).toBeNull();
      }
    }
  );

  it('reclaims Subagent history at the inline hard limit without losing fresh media', async () => {
    const { home, create } = await fixture();
    const store = await JsonlSessionStore.open(home);
    const parent = await store.createSession({ workspace: home, title: 'Parent' });
    const child = await store.createSession({
      workspace: home,
      title: 'Child inline limit',
      source: {
        type: 'subagent',
        parentSessionId: parent.id,
        rootSessionId: parent.id,
        parentExecutionId: 'parent-execution',
        role: 'general-purpose',
        description: 'Inspect images'
      }
    });
    await store.close();
    const images = await Promise.all(
      ['child-1', 'child-2', 'child-fresh'].map((id) => imagePng(id))
    );
    const adapter = new ScriptedAdapter(modelBase, [
      { events: [{ type: 'text.completed', itemId: 'seed', text: 'protected child history' }] },
      { events: [{ type: 'text.completed', itemId: 'fresh', text: 'fresh image retained' }] }
    ]);
    const agent = await create(adapter);
    try {
      const session = await agent.openSession(child.id);
      expect(
        await session
          .run({
            prompt: 'inspect',
            images: images.slice(0, 2).map((image, i) => imageInput(`old-${i}.png`, image))
          })
          .result()
      ).toMatchObject({ status: 'completed' });
      expect(
        await session
          .run({
            prompt: 'fresh image',
            images: [imageInput('fresh.png', images[2]!)]
          })
          .result()
      ).toMatchObject({ status: 'completed' });
      expect(adapter.requests).toHaveLength(2);
      expect(adapter.requests[1]!.imageHashes).toEqual([imageHash(images[2]!)]);
      expect(adapter.resetContinuationCalls).toBe(1);
    } finally {
      await agent.dispose();
    }
    expectSingleInlineGcCheckpoint(await readRecords(home, child.id), 'HARD_LIMIT');
  });

  it('fails fresh media above the hard limit before dispatch when no history can be reclaimed', async () => {
    const { home, create } = await fixture();
    const images = await Promise.all([
      imagePng('fresh-only-1'),
      imagePng('fresh-only-2'),
      imagePng('fresh-only-3')
    ]);
    const adapter = new ScriptedAdapter(modelBase, []);
    const agent = await create(adapter);
    let sessionId = '';
    try {
      const session = await agent.createSession({
        workspace: home,
        title: 'Fresh media hard limit'
      });
      sessionId = session.id;
      const input = images.map((image, index) => imageInput(`fresh-${index}.png`, image));
      expect(input.map((image) => Buffer.byteLength(image.dataBase64))).toEqual([
        4 * MiB,
        4 * MiB,
        4 * MiB
      ]);
      expect(
        await session.run({ prompt: 'three fresh images', images: input }).result()
      ).toMatchObject({
        status: 'failed',
        errorCode: 'MAR_AGENT_INLINE_MEDIA_LIMIT'
      });
      expect(adapter.requests).toHaveLength(0);
      expect(adapter.resetContinuationCalls).toBe(0);
      await agent.dispose();
    } finally {
      await agent.dispose();
    }
    expect(
      (await readRecords(home, sessionId)).filter(
        (record) => record.type === 'context.gc.completed'
      )
    ).toHaveLength(0);
  });
});
