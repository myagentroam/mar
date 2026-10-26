import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlSessionStore } from '../../src/agent-core/session/store/jsonl-store.js';
import { restoreMessages } from '../../src/agent-core/runtime/context/restore.js';
import { LocalAgentHost, SecretValue, type MarAgentModelConfiguration } from '../../src/index.js';
import { createMarAgentWithAdapter } from '../../src/agent-core/sdk/agent.js';
import type { ModelRequest } from '../../src/agent-core/model/contracts.js';

const imageIo = vi.hoisted(() => ({
  appendPath: '',
  windowsImagePath: '',
  pendingPath: '',
  pendingStats: 0,
  syncEntered: null as null | (() => void),
  syncGate: null as null | Promise<void>,
  syncFailure: null as null | Error,
  syncInjected: false
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      if (imageIo.pendingPath !== '' && args[0] === imageIo.pendingPath) imageIo.pendingStats++;
      const info = await fs.lstat(...args);
      return args[0] === imageIo.windowsImagePath ? Object.assign(info, { dev: 0 }) : info;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (args[0] !== imageIo.appendPath || args[1] !== 'a') return handle;
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        imageIo.syncEntered?.();
        const gate = imageIo.syncGate;
        if (gate !== null) await gate;
        const failure = imageIo.syncFailure;
        if (failure !== null && !imageIo.syncInjected) {
          imageIo.syncInjected = true;
          throw failure;
        }
        return sync();
      });
      return handle;
    }
  };
});

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  Object.assign(imageIo, {
    appendPath: '',
    windowsImagePath: '',
    pendingPath: '',
    pendingStats: 0,
    syncEntered: null,
    syncGate: null,
    syncFailure: null,
    syncInjected: false
  });
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const pixel =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const url = 'https://images.example.test/session/resource?expiresAt=1&signature=fixed';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mar-unified-images-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const store = await JsonlSessionStore.open(home);
  cleanups.push(() => store.close());
  const session = await store.createSession({ workspace: home });
  const directory = join(home, '.mar', 'agent', 'sessions', session.id, 'resources');
  return { home, store, session, directory };
}

describe('unified Session image resources', () => {
  it.each(['binary', 'metadata'] as const)(
    'repairs an unavailable resource when the same image bytes are attached again (%s)',
    async (missing) => {
      const { store, session, directory } = await fixture();
      const input = { mimeType: 'image/png', dataBase64: pixel };
      const image = await store.persistResource(session.id, input);
      await store.setResourceUrl(session.id, image.resourceId, { url, urlExpiresAt: 1 });
      await store.append(session.id, {
        type: 'model.context',
        payload: { role: 'tool', callId: 'view', content: 'seen', images: [image] }
      });
      if (missing === 'binary') await rm(join(directory, `${image.resourceId}.bin`));
      else await writeFile(join(directory, `${image.resourceId}.json`), '{');

      const restored = await store.persistResource(session.id, input);
      expect(restored.resourceId).toBe(image.resourceId);
      if (missing === 'binary') expect(restored).toMatchObject({ url, urlExpiresAt: 1 });
      await expect(store.readResource(session.id, image.resourceId)).resolves.toMatchObject({
        dataBase64: pixel
      });
    }
  );

  it('reads trusted image bytes when Windows path and handle device numbers differ', async () => {
    const { store, session, directory } = await fixture();
    const image = await store.persistResource(session.id, {
      mimeType: 'image/png',
      dataBase64: pixel
    });
    await store.append(session.id, {
      type: 'model.context',
      payload: { role: 'tool', callId: 'view', images: [image] }
    });
    imageIo.windowsImagePath = join(directory, `${image.resourceId}.bin`);
    await expect(store.readResource(session.id, image.resourceId)).resolves.toMatchObject({
      dataBase64: pixel
    });
  });

  it.each(['same size', 'different size'])(
    'reads trusted image files without comparing stored size or checksum (%s)',
    async (change) => {
      const { store, session, directory } = await fixture();
      const image = await store.persistResource(session.id, {
        mimeType: 'image/png',
        dataBase64: pixel
      });
      await store.append(session.id, {
        type: 'model.context',
        payload: { role: 'tool', callId: 'view', images: [image] }
      });
      const bytes = Buffer.from(pixel, 'base64');
      bytes[0] = bytes[0]! ^ 1;
      const stored = change === 'same size' ? bytes : Buffer.concat([bytes, Buffer.from('extra')]);
      await writeFile(join(directory, `${image.resourceId}.bin`), stored);
      await expect(store.readResource(session.id, image.resourceId)).resolves.toMatchObject({
        dataBase64: stored.toString('base64')
      });
    }
  );

  it.each(['bytes', 'mimeType'] as const)(
    'reads trusted resource metadata without recalculating its identity (%s)',
    async (change) => {
      const { store, session, directory } = await fixture();
      const image = await store.persistResource(session.id, {
        mimeType: 'image/png',
        dataBase64: pixel
      });
      await store.append(session.id, {
        type: 'model.context',
        payload: { role: 'tool', callId: 'view', content: 'seen', images: [image] }
      });
      await expect(store.readResource(session.id, image.resourceId)).resolves.toMatchObject({
        dataBase64: pixel
      });
      const metadataPath = join(directory, `${image.resourceId}.json`);
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
      if (change === 'bytes') {
        const bytes = Buffer.from(pixel, 'base64');
        bytes[0] = bytes[0]! ^ 1;
        metadata.sha256 = createHash('sha256').update(bytes).digest('hex');
        await writeFile(join(directory, `${image.resourceId}.bin`), bytes);
      } else metadata.mimeType = 'image/jpeg';
      await writeFile(metadataPath, JSON.stringify(metadata));
      await expect(store.readResource(session.id, image.resourceId)).resolves.toMatchObject({
        mimeType: metadata.mimeType,
        dataBase64: (await readFile(join(directory, `${image.resourceId}.bin`))).toString('base64')
      });
    }
  );

  it('reports unparseable resource metadata with a stable code', async () => {
    const { store, session, directory } = await fixture();
    const image = await store.persistResource(session.id, {
      mimeType: 'image/png',
      dataBase64: pixel
    });
    await store.append(session.id, {
      type: 'model.context',
      payload: { role: 'tool', callId: 'view', content: 'seen', images: [image] }
    });
    await writeFile(join(directory, `${image.resourceId}.json`), '{');
    await expect(store.readResource(session.id, image.resourceId)).rejects.toMatchObject({
      code: 'MAR_AGENT_IMAGE_UNAVAILABLE'
    });
  });

  it.each(['null', '{}'])(
    'reports structurally unusable resource metadata with a stable code (%s)',
    async (metadata) => {
      const { store, session, directory } = await fixture();
      const image = await store.persistResource(session.id, {
        mimeType: 'image/png',
        dataBase64: pixel
      });
      await store.append(session.id, {
        type: 'model.context',
        payload: { role: 'tool', callId: 'view', content: 'seen', images: [image] }
      });
      await writeFile(join(directory, `${image.resourceId}.json`), metadata);
      await expect(store.readResource(session.id, image.resourceId)).rejects.toMatchObject({
        code: 'MAR_AGENT_IMAGE_UNAVAILABLE'
      });
    }
  );

  it('repairs invalid published URL metadata when the same bytes are attached again', async () => {
    const { store, session, directory } = await fixture();
    const input = { mimeType: 'image/png', dataBase64: pixel };
    const image = await store.persistResource(session.id, input);
    await writeFile(
      join(directory, `${image.resourceId}.json`),
      JSON.stringify({ ...image, url: 'ftp://invalid.example.test/image.png', urlExpiresAt: 1 })
    );
    const repaired = await store.persistResource(session.id, input);
    expect(repaired).not.toHaveProperty('url');
    await expect(
      store.setResourceUrl(session.id, image.resourceId, { url, urlExpiresAt: 1 })
    ).resolves.toMatchObject({ url, urlExpiresAt: 1 });
  });

  it('does not expose uncommitted bytes and accepts a committed surviving pending marker', async () => {
    const { store, session, directory } = await fixture();
    const image = await store.persistResource(session.id, {
      mimeType: 'image/png',
      dataBase64: pixel
    });
    expect(await store.readResource(session.id, image.resourceId)).toBeUndefined();
    await store.append(session.id, {
      type: 'model.context',
      payload: { role: 'tool', callId: 'view', content: 'seen', images: [image] }
    });
    await writeFile(join(directory, `.${image.resourceId}.pending`), '');
    expect(await store.readResource(session.id, image.resourceId)).toMatchObject({
      dataBase64: pixel
    });
  });
  it('queues reads behind a pending image append until its sync completes', async () => {
    const { home, store, session, directory } = await fixture();
    const release = await store.acquireSessionLease(session.id);
    cleanups.push(release);
    const image = await store.persistResource(session.id, {
      mimeType: 'image/png',
      dataBase64: pixel
    });
    const segmentPath = join(home, '.mar', 'agent', 'sessions', session.id, 'events-000001.jsonl');
    let resolveSyncGate!: () => void;
    const syncGate = new Promise<void>((resolve) => (resolveSyncGate = resolve));
    let syncStarted = false;
    Object.assign(imageIo, {
      appendPath: segmentPath,
      pendingPath: join(directory, `.${image.resourceId}.pending`),
      syncEntered: () => (syncStarted = true),
      syncGate
    });
    try {
      const append = store.append(session.id, {
        type: 'model.context',
        payload: { role: 'tool', callId: 'pending-image', images: [image] }
      });
      await vi.waitFor(() => expect(syncStarted).toBe(true));
      const read = store.readResource(session.id, image.resourceId);
      expect(imageIo.pendingStats).toBe(0);
      let readSettled = false;
      void read.then(() => (readSettled = true));
      await Promise.resolve();
      expect(readSettled).toBe(false);

      resolveSyncGate();
      await expect(append).resolves.toMatchObject({ sequence: 2 });
      await expect(read).resolves.toMatchObject({ dataBase64: pixel });
      expect(imageIo.pendingStats).toBe(1);
    } finally {
      resolveSyncGate();
      await release();
    }
  });
  it('keeps a pending image private after sync failure until lease recovery', async () => {
    const { home, store, session, directory } = await fixture();
    const release = await store.acquireSessionLease(session.id);
    cleanups.push(release);
    const image = await store.persistResource(session.id, {
      mimeType: 'image/png',
      dataBase64: pixel
    });
    const segmentPath = join(home, '.mar', 'agent', 'sessions', session.id, 'events-000001.jsonl');
    const pendingPath = join(directory, `.${image.resourceId}.pending`);
    const failure = Object.assign(new Error('Injected Session sync failure.'), { code: 'EIO' });
    Object.assign(imageIo, {
      appendPath: segmentPath,
      pendingPath,
      syncFailure: failure
    });
    try {
      await expect(
        store.append(session.id, {
          type: 'model.context',
          payload: { role: 'tool', callId: 'failed-image', images: [image] }
        })
      ).rejects.toBe(failure);
      const records = (await readFile(segmentPath, 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records.at(-1)).toMatchObject({
        type: 'model.context',
        payload: { images: [expect.objectContaining({ resourceId: image.resourceId })] }
      });
      expect(await readdir(directory)).toContain(`.${image.resourceId}.pending`);
      await expect(store.readResource(session.id, image.resourceId)).resolves.toBeUndefined();
    } finally {
      await release();
    }

    const recovered = await store.acquireSessionLease(session.id);
    try {
      expect(await readdir(directory)).not.toContain(`.${image.resourceId}.pending`);
      await expect(store.readResource(session.id, image.resourceId)).resolves.toMatchObject({
        dataBase64: pixel
      });
    } finally {
      await recovered();
    }
  });
  it('copies retained user and tool images on fork, then removes only rolled-back resources', async () => {
    const { home, store, session, directory } = await fixture();
    const image = await store.persistResource(session.id, {
      mimeType: 'image/png',
      dataBase64: pixel
    });
    const first = await store.setResourceUrl(session.id, image.resourceId, {
      url,
      urlExpiresAt: 1
    });
    await store.append(session.id, {
      type: 'turn.user',
      turnId: 'first',
      payload: { prompt: 'inspect' }
    });
    await store.append(session.id, {
      type: 'model.context',
      turnId: 'first',
      payload: { role: 'tool', callId: 'image', content: 'viewed', images: [first] }
    });
    const second = await store.persistResource(session.id, {
      mimeType: 'image/png',
      dataBase64: 'AAAB'
    });
    await store.append(session.id, {
      type: 'turn.user',
      turnId: 'second',
      payload: {
        prompt: 'next',
        images: [{ ...second, name: 'second.png', fileName: `${second.resourceId}.bin` }]
      }
    });
    const fork = await store.forkSession(session.id, { boundaryTurnId: 'first', title: 'Fork' });
    const forkDirectory = join(home, '.mar', 'agent', 'sessions', fork.id, 'resources');
    expect((await readdir(forkDirectory)).sort()).toEqual([
      `${first.resourceId}.bin`,
      `${first.resourceId}.json`
    ]);
    await expect(store.readResource(fork.id, first.resourceId)).resolves.toEqual({
      mimeType: 'image/png',
      dataBase64: pixel
    });
    const records = await store.read(fork.id);
    const restored = await restoreMessages(store, fork.id, records, { includeImages: true });
    expect(restored.messages.find((message) => message.role === 'tool')!.images).toMatchObject([
      { url, urlExpiresAt: 1 }
    ]);
    await store.rollbackSession(session.id, { boundaryTurnId: 'first' });
    expect((await readdir(directory)).sort()).toEqual([
      `${first.resourceId}.bin`,
      `${first.resourceId}.json`
    ]);
    await store.clearSession(session.id);
    expect(await readdir(directory)).toEqual([]);
    expect(await store.readResource(fork.id, first.resourceId)).toMatchObject({
      dataBase64: pixel
    });
  });

  it('restores Compact tail URLs without requiring the original image file', async () => {
    const { store, session, directory } = await fixture();
    const resource = await store.persistResource(session.id, {
      mimeType: 'image/png',
      dataBase64: pixel
    });
    const image = await store.setResourceUrl(session.id, resource.resourceId, {
      url,
      urlExpiresAt: 1
    });
    await store.compact(session.id, {
      summary: 'retained',
      retainedModelContext: [
        {
          role: 'tool_call',
          callId: 'view',
          name: 'view_image',
          arguments: { path: 'pixel.png' },
          content: ''
        },
        { role: 'tool', callId: 'view', content: 'viewed', images: [image] }
      ]
    });
    await rm(join(directory, `${image.resourceId}.bin`));
    const restored = await restoreMessages(store, session.id, await store.read(session.id), {
      includeImages: true
    });
    expect(restored.messages.find((message) => message.role === 'tool')!.images).toMatchObject([
      { url, urlExpiresAt: 1 }
    ]);
    const textOnly = await restoreMessages(store, session.id, await store.read(session.id), {
      includeImages: false
    });
    expect(textOnly.messages.every((message) => message.images === undefined)).toBe(true);
  });

  it.each([
    { source: 'user', failure: 'missing bytes' },
    { source: 'tool', failure: 'missing bytes' },
    { source: 'user', failure: 'invalid metadata' },
    { source: 'tool', failure: 'invalid metadata' }
  ])(
    'continues and reopens a Session after an image becomes unavailable (%j)',
    async ({ source, failure }) => {
      const { home, store, session, directory } = await fixture();
      let resourceId: string;
      if (source === 'user') {
        const images = await store.persistInputImages(session.id, [
          { name: 'pixel.png', mimeType: 'image/png', dataBase64: pixel }
        ]);
        resourceId = images[0]!.resourceId!;
        await store.append(session.id, {
          type: 'turn.user',
          payload: { prompt: 'Keep the original text.', images }
        });
      } else {
        const resource = await store.persistResource(session.id, {
          mimeType: 'image/png',
          dataBase64: pixel
        });
        resourceId = resource.resourceId;
        await store.append(session.id, {
          type: 'model.context',
          payload: {
            role: 'tool_call',
            callId: 'view',
            name: 'view_image',
            arguments: {},
            content: ''
          }
        });
        await store.append(session.id, {
          type: 'model.context',
          payload: {
            role: 'tool',
            callId: 'view',
            content: 'Keep the original text.',
            images: [resource]
          }
        });
      }
      const model: MarAgentModelConfiguration = {
        id: 'vision',
        name: 'Vision',
        protocol: 'OPENAI_RESPONSES',
        modelId: 'vision',
        baseUrl: 'https://example.test',
        apiKey: new SecretValue('test'),
        contextWindowTokens: 100_000,
        maxOutputTokens: 1000,
        inputCapabilities: ['TEXT', 'IMAGE'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: [],
        enabled: true,
        titleGeneration: false,
        useResourceUrl: false
      };
      const requests: ModelRequest[] = [];
      const create = () =>
        createMarAgentWithAdapter({
          mode: 'normal',
          models: [model],
          host: new LocalAgentHost({ homeDirectory: home, workspace: home }),
          adapterFactory: () => ({
            configuration: model,
            async *start(request) {
              requests.push(request);
              yield { type: 'text.completed' as const, itemId: 'answer', text: 'continued' };
              yield { type: 'completed' as const, reason: 'completed' as const };
            }
          })
        });
      let agent = await create();
      cleanups.push(() => agent.dispose());
      let live = await agent.openSession(session.id);
      expect(await live.run({ prompt: 'Inspect.' }).result()).toMatchObject({
        status: 'completed'
      });
      expect(requests[0]!.messages.some((message) => message.images?.length)).toBe(true);
      if (failure === 'missing bytes') await rm(join(directory, `${resourceId}.bin`));
      else await writeFile(join(directory, `${resourceId}.json`), '{');
      for (let turn = 0; turn < 2; turn++)
        expect(await live.run({ prompt: 'Continue with the text.' }).result()).toMatchObject({
          status: 'completed'
        });
      await agent.dispose();
      agent = await create();
      live = await agent.openSession(session.id);
      expect(await live.run({ prompt: 'Continue after reopening.' }).result()).toMatchObject({
        status: 'completed'
      });
      for (const request of requests.slice(1)) {
        const original = request.messages.find((message) =>
          message.content.includes('Keep the original text.')
        )!;
        expect(original.images ?? []).toEqual([]);
        expect(original.content).toContain('Image unavailable');
      }
      expect(
        (await store.read(session.id)).some((record) => record.type === 'execution.failed')
      ).toBe(false);
    }
  );

  it.each([
    { codeMode: false, partial: false },
    { codeMode: true, partial: false },
    { codeMode: true, partial: true }
  ])(
    'preserves tool and attachment URLs across executions and restart (%j)',
    async ({ codeMode, partial }) => {
      const { home, store, session, directory } = await fixture();
      const path = join(home, 'pixel.png');
      await writeFile(path, Buffer.from(pixel, 'base64'));
      const model: MarAgentModelConfiguration = {
        id: 'vision',
        name: 'Vision',
        protocol: 'OPENAI_RESPONSES',
        modelId: 'vision',
        baseUrl: 'https://example.test',
        apiKey: new SecretValue('test'),
        contextWindowTokens: 100_000,
        maxOutputTokens: 1000,
        inputCapabilities: ['TEXT', 'IMAGE'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: ['low'],
        defaultReasoningEffort: 'low',
        enabled: true,
        useResourceUrl: true,
        codeMode
      };
      const requests: ModelRequest[] = [];
      let publications = 0;
      const create = () =>
        createMarAgentWithAdapter({
          mode: 'normal',
          models: [model],
          host: new LocalAgentHost({
            homeDirectory: home,
            workspace: home,
            publishModelResource: async () => {
              publications++;
              return { url, urlExpiresAt: 1 };
            }
          }),
          adapterFactory: () => ({
            configuration: model,
            async *start(request) {
              requests.push(JSON.parse(JSON.stringify(request)));
              if (requests.length === 1) {
                yield {
                  type: 'client_tool.call' as const,
                  callId: 'view',
                  name: codeMode ? 'code_exec' : 'view_image',
                  arguments: codeMode
                    ? {
                        code:
                          'observe.result(await tools.view_image({path:"pixel.png"}));' +
                          (partial ? 'throw new Error("after image");' : '')
                      }
                    : { path: 'pixel.png' }
                };
                yield { type: 'completed' as const, reason: 'tool_use' as const };
              } else {
                yield { type: 'text.completed' as const, itemId: 'answer', text: 'seen' };
                yield { type: 'completed' as const, reason: 'completed' as const };
              }
            }
          })
        });
      let agent = await create();
      try {
        let live = await agent.openSession(session.id);
        expect(
          await live
            .run({
              prompt: 'inspect',
              images: [{ name: 'pixel.png', mimeType: 'image/png', dataBase64: pixel }]
            })
            .result()
        ).toMatchObject({ status: 'completed' });
        const toolImage = requests[1]!.messages.find((message) => message.role === 'tool')!
          .images![0]!;
        expect(toolImage).toMatchObject({ url, urlExpiresAt: 1 });
        expect(toolImage).not.toHaveProperty('dataBase64');
        expect(publications).toBe(1);
        await writeFile(path, Buffer.from('overwritten original'));
        expect(await store.readResource(session.id, toolImage.resourceId!)).toMatchObject({
          dataBase64: pixel
        });
        expect(await live.run({ prompt: 'next' }).result()).toMatchObject({ status: 'completed' });
        expect(
          requests.at(-1)!.messages.find((message) => message.role === 'tool')!.images
        ).toEqual([toolImage]);
        await agent.dispose();
        await rm(join(directory, `${toolImage.resourceId}.bin`));
        agent = await create();
        live = await agent.openSession(session.id);
        expect(await live.run({ prompt: 'after restart' }).result()).toMatchObject({
          status: 'completed'
        });
        const restored = requests.at(-1)!.messages;
        expect(restored.find((message) => message.role === 'tool')!.images).toEqual([
          expect.objectContaining({ url, urlExpiresAt: 1 })
        ]);
        expect(
          restored.find((message) => message.role === 'user' && message.content === 'inspect')!
            .images
        ).toMatchObject([{ url, urlExpiresAt: 1 }]);
        expect(JSON.stringify(restored)).not.toContain('dataBase64');
        expect(publications).toBe(1);
        const persisted = await readFile(
          join(home, '.mar', 'agent', 'sessions', session.id, 'events-000001.jsonl'),
          'utf8'
        );
        expect(persisted).not.toContain(pixel);
        expect(persisted).not.toContain('dataBase64');
      } finally {
        await agent.dispose();
      }
    }
  );
});
