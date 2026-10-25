import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentHost } from '../../src/agent-core/host/local-agent-host.js';
import { modelImageUrl } from '../../src/agent-core/model/image.js';
import { publishModelResources } from '../../src/agent-core/runtime/resource-publication.js';
import { JsonlSessionStore } from '../../src/agent-core/session/store/jsonl-store.js';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
const image = { mimeType: 'image/png', dataBase64: 'aW1hZ2U=' };
const published = { url: 'https://images.example.test/image.png', urlExpiresAt: 1000 };

async function fixture(
  publish?: ConstructorParameters<typeof LocalAgentHost>[0]['publishModelResource']
) {
  const home = await mkdtemp(join(tmpdir(), 'mar-image-publication-'));
  homes.push(home);
  const store = await JsonlSessionStore.open(home);
  const session = await store.createSession({ workspace: home });
  const host = new LocalAgentHost({
    homeDirectory: home,
    workspace: home,
    publishModelResource: publish
  });
  return {
    home,
    store,
    session,
    host,
    context: { sessionId: session.id, executionId: 'execution-1' }
  };
}

describe('model image publication', () => {
  it('preserves per-image names when concurrent local publications share a resource', async () => {
    const { store, host, context } = await fixture();
    const persist = store.persistResource.bind(store);
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const spy = vi.spyOn(store, 'persistResource').mockImplementation(async (...args) => {
      const resource = await persist(...args);
      if (++arrived === 2) release();
      await gate;
      return resource;
    });
    const images = [
      { ...image, name: 'first.png' },
      { ...image, name: 'second.png' }
    ];
    try {
      const result = (await publishModelResources(host, images, context, store))!;
      expect(result.map((value) => value.name)).toEqual(['first.png', 'second.png']);
      expect(result[0]!.resourceId).toBe(result[1]!.resourceId);
      expect(result.every((value) => value.dataBase64 === image.dataBase64)).toBe(true);
    } finally {
      release();
      spy.mockRestore();
      await store.close();
      await host.dispose();
    }
  });

  it('rejects a resource identity paired with different bytes before publication', async () => {
    const publish = vi.fn(async () => published);
    const { store, host, context } = await fixture(publish);
    try {
      await expect(
        publishModelResources(host, [{ ...image, resourceId: 'a'.repeat(64) }], context, store)
      ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_INPUT_INVALID' });
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await store.close();
      await host.dispose();
    }
  });

  it('rejects invalid publication instead of falling back to base64', async () => {
    for (const value of [
      undefined,
      { ...published, url: 'file:///tmp/image.png' },
      { ...published, urlExpiresAt: Number.NaN },
      { ...published, urlExpiresAt: -1 }
    ]) {
      const { store, host, context } = await fixture(async () => value);
      try {
        await expect(publishModelResources(host, [image], context, store)).rejects.toMatchObject({
          code: 'MAR_AGENT_IMAGE_PUBLICATION_FAILED'
        });
      } finally {
        await store.close();
        await host.dispose();
      }
    }
  });

  it('saves one binary resource and fixed URL metadata for concurrent attachments and tool images', async () => {
    const publish = vi.fn(async () => published);
    const { home, store, session, host, context } = await fixture(publish);
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => publishModelResources(host, [image], context, store))
      );
      const resource = results[0]![0]!;
      expect(publish).toHaveBeenCalledTimes(1);
      expect(resource).toMatchObject(published);
      expect(resource).not.toHaveProperty('dataBase64');
      expect(results.every((value) => value![0]!.url === published.url)).toBe(true);
      const directory = join(home, '.mar', 'agent', 'sessions', session.id, 'resources');
      expect((await readdir(directory)).filter((name) => name.endsWith('.bin'))).toHaveLength(1);
      expect(await readFile(join(directory, `${resource.resourceId}.bin`))).toEqual(
        Buffer.from('image')
      );
      expect(await readFile(join(directory, `${resource.resourceId}.json`), 'utf8')).not.toContain(
        'dataBase64'
      );
      await store.append(session.id, {
        type: 'model.context',
        payload: { role: 'tool', callId: 'view', content: 'viewed', images: [resource] }
      });
      expect(
        await readFile(
          join(home, '.mar', 'agent', 'sessions', session.id, 'events-000001.jsonl'),
          'utf8'
        )
      ).not.toContain(image.dataBase64);
    } finally {
      await store.close();
      await host.dispose();
    }
  });

  it('reuses the original URL after expiry and Store restart, without reading image bytes', async () => {
    const publish = vi.fn(async () => published);
    const { home, store, session, host, context } = await fixture(publish);
    const first = (await publishModelResources(host, [image], context, store))![0]!;
    await store.append(session.id, {
      type: 'model.context',
      payload: { role: 'tool', callId: 'view', content: 'viewed', images: [first] }
    });
    await store.close();
    const reopened = await JsonlSessionStore.open(home);
    const directory = join(home, '.mar', 'agent', 'sessions', session.id, 'resources');
    try {
      const again = (await publishModelResources(
        host,
        [image],
        { ...context, executionId: 'execution-2' },
        reopened
      ))![0]!;
      expect(again).toEqual(first);
      await rm(join(directory, `${first.resourceId}.bin`));
      await expect(publishModelResources(host, [first], context, reopened)).resolves.toEqual([
        first
      ]);
      expect(publish).toHaveBeenCalledTimes(1);
    } finally {
      await reopened.close();
      await host.dispose();
    }
  });

  it('keeps binary resources and local model input when no publication Host is installed', async () => {
    const { store, host, context } = await fixture();
    try {
      const result = (await publishModelResources(host, [image], context, store))![0]!;
      expect(result).toMatchObject(image);
      expect(result.resourceId).toMatch(/^[a-f0-9]{64}$/u);
      expect(modelImageUrl(result)).toBe(`data:image/png;base64,${image.dataBase64}`);
    } finally {
      await store.close();
      await host.dispose();
    }
  });

  it('accepts URL-only tool images and preserves the URL after its expiry', async () => {
    const { store, host, context } = await fixture(async () => {
      throw new Error('must not publish');
    });
    const input = { mimeType: 'image/png', ...published };
    try {
      await expect(publishModelResources(host, [input], context, store)).resolves.toEqual([input]);
      expect(modelImageUrl(input)).toBe(published.url);
    } finally {
      await store.close();
      await host.dispose();
    }
  });
});
