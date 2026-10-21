import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LocalAgentHost,
  SecretValue,
  openMarAgentSessionCatalog,
  type MarAgentModelConfiguration
} from '../../src/index.js';
import { createMarAgentWithAdapter } from '../../src/agent-core/sdk/agent.js';
import type {
  ModelAdapter,
  ModelEvent,
  ModelRequest
} from '../../src/agent-core/model/contracts.js';
import { JsonlSessionStore } from '../../src/agent-core/session/store/index.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(protocol: MarAgentModelConfiguration['protocol']) {
  const root = await mkdtemp(join(tmpdir(), 'mar-steer-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'),
    workspace = join(root, 'workspace');
  await mkdir(workspace);
  await mkdir(home);
  const configuration: MarAgentModelConfiguration = {
    id: 'test',
    name: 'Test',
    protocol,
    baseUrl: 'https://example.test',
    apiKey: new SecretValue('test'),
    modelId: 'test',
    contextWindowTokens: 10_000,
    maxOutputTokens: 1000,
    inputCapabilities: ['TEXT', 'IMAGE'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['low'],
    defaultReasoningEffort: 'low',
    hostedWebSearch: false,
    enabled: true
  };
  const started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const requests: ModelRequest[] = [];
  let aborted = 0;
  const create = () =>
    createMarAgentWithAdapter({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [configuration],
      adapterFactory: () =>
        ({
          configuration,
          async *start(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
            requests.push({ ...request, messages: structuredClone(request.messages) });
            if (requests.length === 1) {
              signal.addEventListener(
                'abort',
                () => {
                  aborted++;
                },
                { once: true }
              );
              started.resolve();
              await Promise.race([
                release.promise,
                new Promise<void>((_, reject) =>
                  signal.addEventListener('abort', () => reject(signal.reason), { once: true })
                )
              ]);
            }
            yield {
              type: 'text.completed',
              itemId: 'answer-' + requests.length,
              phase: 'final_answer',
              text: 'answer-' + requests.length
            };
            yield { type: 'completed', reason: 'completed' };
          },
          async close() {}
        }) satisfies ModelAdapter
    });
  const agent = await create();
  cleanups.push(() => agent.dispose());
  const session = await agent.createSession({ workspace });
  const catalog = await openMarAgentSessionCatalog({ homeDirectory: home });
  cleanups.push(() => catalog.close());
  return {
    agent,
    session,
    catalog,
    home,
    started: started.promise,
    release: () => release.resolve(),
    requests,
    create,
    aborted: () => aborted
  };
}

describe.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const)(
  'native steer %s',
  (protocol) => {
    it('forks a receive/apply difference without duplicating or losing its input', async () => {
      const f = await fixture(protocol);
      const handle = f.session.run({ prompt: 'initial' });
      await Promise.race([
        f.started,
        handle.result().then((r) => {
          throw new Error(JSON.stringify(r));
        })
      ]);
      const receipt = await f.session.steer({
        expectedExecutionId: handle.executionId,
        prompt: 'fork guidance',
        clientMessageId: 'fork'
      });
      if (receipt.status !== 'accepted') throw new Error('Missing receipt');
      handle.cancel();
      await handle.result();
      const pendingFork = await f.catalog.fork(f.session.id, {
        title: 'Pending fork',
        boundaryTurnId: receipt.entry.turnId
      });
      const pendingSession = await f.agent.openSession(pendingFork.id);
      expect(await pendingSession.run({ prompt: 'branch one' }).result()).toMatchObject({
        status: 'completed'
      });
      expect(f.requests.at(-1)!.messages.filter((m) => m.content === 'fork guidance')).toHaveLength(
        1
      );
      const branchHistory = await f.catalog.history(pendingFork.id, { limit: 100 });
      const lastUser = branchHistory.entries.findLast((e) => e.kind === 'user')!;
      const appliedFork = await f.catalog.fork(pendingFork.id, {
        title: 'Applied fork',
        boundaryTurnId: lastUser.turnId!
      });
      const appliedSession = await f.agent.openSession(appliedFork.id);
      expect(await appliedSession.run({ prompt: 'branch two' }).result()).toMatchObject({
        status: 'completed'
      });
      expect(f.requests.at(-1)!.messages.filter((m) => m.content === 'fork guidance')).toHaveLength(
        1
      );
    });
    it('keeps pending input and private image references through an independent Compact and restart', async () => {
      const f = await fixture(protocol);
      const handle = f.session.run({ prompt: 'initial' });
      await Promise.race([
        f.started,
        handle.result().then((r) => {
          throw new Error(JSON.stringify(r));
        })
      ]);
      const image = {
        name: 'pixel.png',
        mimeType: 'image/png',
        dataBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='
      };
      await f.session.steer({
        expectedExecutionId: handle.executionId,
        prompt: 'pending image',
        clientMessageId: 'image',
        images: [image]
      });
      handle.cancel();
      await handle.result();
      expect(await f.session.compact().result()).toMatchObject({ status: 'completed' });
      const store = await JsonlSessionStore.open(f.home);
      cleanups.push(() => store.close());
      const records = await store.read(f.session.id);
      const checkpoint = records.findLast((r) => r.type === 'compact.completed')!;
      expect((checkpoint.payload as Record<string, unknown>).pendingInputs).toHaveLength(1);
      expect(JSON.stringify(checkpoint.payload)).not.toContain(image.dataBase64);
      await f.agent.dispose();
      const agent = await f.create();
      cleanups.push(() => agent.dispose());
      const session = await agent.openSession(f.session.id);
      await session.run({ prompt: 'fresh' }).result();
      const users = f.requests.at(-1)!.messages.filter((m) => m.role === 'user' && !m.contextKind);
      expect(users.map((m) => m.content).slice(-2)).toEqual(['pending image', 'fresh']);
      expect(users.find((m) => m.content === 'pending image')!.images).toEqual([
        { mimeType: image.mimeType, dataBase64: image.dataBase64 }
      ]);
    });

    it('stops a failed application before another model request and retains the input for retry', async () => {
      const f = await fixture(protocol);
      const handle = f.session.run({ prompt: 'initial' });
      await Promise.race([
        f.started,
        handle.result().then((r) => {
          throw new Error(JSON.stringify(r));
        })
      ]);
      await f.session.steer({
        expectedExecutionId: handle.executionId,
        prompt: 'persist me',
        clientMessageId: 'failure'
      });
      const append = JsonlSessionStore.prototype.append;
      const fault = vi.spyOn(JsonlSessionStore.prototype, 'append').mockImplementation(function (
        this: JsonlSessionStore,
        ...args
      ) {
        if (
          args[1].type === 'model.context' &&
          (args[1].payload as Record<string, unknown>).inputRef
        )
          return Promise.reject(new Error('application write failed'));
        return append.apply(this, args);
      });
      try {
        f.release();
        expect(await handle.result()).toMatchObject({ status: 'failed' });
        expect(f.requests).toHaveLength(1);
      } finally {
        fault.mockRestore();
      }
      await f.session.run({ prompt: 'retry' }).result();
      expect(f.requests.at(-1)!.messages.filter((m) => m.content === 'persist me')).toHaveLength(1);
    });
    it('echoes one durable input immediately and only applies after the complete response', async () => {
      const f = await fixture(protocol);
      const handle = f.session.run({ prompt: 'initial', permissionMode: 'full-access' });
      await Promise.race([
        f.started,
        handle.result().then((r) => {
          throw new Error(JSON.stringify(r));
        })
      ]);
      const input = {
        expectedExecutionId: handle.executionId,
        prompt: 'visible guidance',
        modelText: 'model guidance',
        clientMessageId: 'steer-1'
      };
      const receipt = await f.session.steer(input);
      expect(receipt).toMatchObject({
        status: 'accepted',
        entry: { text: 'visible guidance', executionId: handle.executionId }
      });
      expect(await f.session.steer(input)).toEqual(receipt);
      const history = await f.catalog.history(f.session.id, { limit: 100 });
      expect(
        history.entries.filter((e) => e.kind === 'user').map((e) => e.kind === 'user' && e.text)
      ).toEqual(['initial', 'visible guidance']);
      expect(f.requests).toHaveLength(1);
      expect(f.aborted()).toBe(0);
      f.release();
      expect(await handle.result()).toMatchObject({ status: 'completed', finalAnswer: 'answer-2' });
      expect(
        f.requests[1]!.messages.filter((m) => m.role === 'user' && !m.contextKind).map(
          (m) => m.content
        )
      ).toEqual(['initial', 'model guidance']);
      const store = await JsonlSessionStore.open(f.home);
      cleanups.push(() => store.close());
      const records = await store.read(f.session.id);
      const received = records.filter(
        (r) => r.type === 'turn.user' && (r.payload as Record<string, unknown>).deferred === true
      );
      const applied = records.filter(
        (r) => r.type === 'model.context' && (r.payload as Record<string, unknown>).inputRef
      );
      expect(received).toHaveLength(1);
      expect(applied).toHaveLength(1);
      expect((applied[0]!.payload as Record<string, unknown>).inputRef).toBe(received[0]!.recordId);
      expect(records.some((r) => r.type === 'input.received')).toBe(false);
    });

    it('recovers received-only input before the next RunInput and never reapplies it on warm reopen', async () => {
      const f = await fixture(protocol);
      const handle = f.session.run({ prompt: 'initial' });
      await Promise.race([
        f.started,
        handle.result().then((r) => {
          throw new Error(JSON.stringify(r));
        })
      ]);
      await f.session.steer({
        expectedExecutionId: handle.executionId,
        prompt: 'pending',
        clientMessageId: 'pending-1'
      });
      handle.cancel();
      expect(await handle.result()).toMatchObject({ status: 'cancelled' });
      await f.agent.dispose();
      const reopened = await f.create();
      cleanups.push(() => reopened.dispose());
      const session = await reopened.openSession(f.session.id);
      expect(await session.run({ prompt: 'new request' }).result()).toMatchObject({
        status: 'completed'
      });
      expect(
        f.requests
          .at(-1)!
          .messages.filter((m) => m.role === 'user' && !m.contextKind)
          .map((m) => m.content)
      ).toEqual(['initial', 'pending', 'new request']);
      const warm = await reopened.openSession(f.session.id);
      await warm.run({ prompt: 'again' }).result();
      expect(f.requests.at(-1)!.messages.filter((m) => m.content === 'pending')).toHaveLength(1);
    });
  }
);
