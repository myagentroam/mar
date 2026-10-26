import { describe, expect, it, vi } from 'vitest';
import type { ModelMessage, ModelRequest } from '../../src/agent-core/model/contracts.js';
import { ResourceInputProjection } from '../../src/agent-core/sdk/resource-input.js';
import { MarAgentError } from '../../src/agent-core/error.js';

function message(overrides: Partial<ModelMessage> = {}): ModelMessage {
  return { role: 'tool', content: 'fixture', ...overrides };
}

function request(
  messages: readonly ModelMessage[],
  overrides: Partial<ModelRequest> = {}
): ModelRequest {
  return { system: 'fixture', messages, tools: [], ...overrides };
}

function image(resourceId: string) {
  return { mimeType: 'image/png', resourceId };
}

function imageMessage(
  resourceId: string,
  source: { callId?: string; recordId?: string } = {}
): ModelMessage {
  return message({
    ...(source.callId === undefined ? {} : { callId: source.callId }),
    ...(source.recordId === undefined
      ? {}
      : { metadata: { source: 'user' as const, recordId: source.recordId } }),
    images: [image(resourceId)]
  });
}

function createStore(resources: Record<string, string> = {}) {
  return {
    readResource: vi.fn(async (_sessionId: string, resourceId: string) => {
      const dataBase64 = resources[resourceId];
      return dataBase64 === undefined ? undefined : { mimeType: 'image/png', dataBase64 };
    })
  };
}

describe('ResourceInputProjection', () => {
  it.each([false, true])(
    'projects hook images without replaying cloned attachment mirrors (URL=%s)',
    async (useResourceUrl) => {
      const store = createStore({ attachment: 'YXR0YWNobWVudA==' });
      const projection = new ResourceInputProjection(useResourceUrl, store, 'session-1', []);
      const mirrors = [
        { ...image('attachment'), url: 'https://assets.example.test/attachment.png' }
      ];
      const attachment = message({ role: 'user', images: mirrors });
      const injected = {
        mimeType: 'image/png',
        dataBase64: 'aG9vay1pbWFnZQ==',
        url: 'https://assets.example.test/hook.png'
      };
      const first = await projection.prepare(
        request([attachment], { images: [...structuredClone(mirrors), injected] }),
        mirrors
      );
      expect(first.images).toEqual([
        useResourceUrl
          ? { mimeType: 'image/png', url: injected.url }
          : { mimeType: 'image/png', dataBase64: injected.dataBase64 }
      ]);
      await projection.complete(first);
      const next = await projection.prepare(
        request([attachment], { images: structuredClone(mirrors) }),
        mirrors
      );
      expect(next).not.toHaveProperty('images');
      expect(next.messages[0]?.images).toEqual(
        useResourceUrl
          ? mirrors
          : [{ ...mirrors[0], url: undefined, dataBase64: 'YXR0YWNobWVudA==' }].map(
              ({ url: _url, ...image }) => image
            )
      );
      expect(injected).toHaveProperty('dataBase64');
      expect(injected).toHaveProperty('url');
    }
  );

  it('keeps recent images across ordinary rounds and independent re-views', async () => {
    const store = createStore({ shared: 'c2hhcmVk' });
    const projection = new ResourceInputProjection(false, store, 'session-1', []);
    const first = imageMessage('shared', { callId: 'first-view' });
    await projection.complete(await projection.prepare(request([first])));
    const ordinary = message({ callId: 'read', content: 'ordinary result' });
    const secondView = imageMessage('shared', { callId: 'second-view' });
    const next = await projection.prepare(request([first, ordinary, secondView]));
    expect(next.messages.map((item) => item.images?.length ?? 0)).toEqual([1, 0, 1]);
    expect(next.messages[1]).toBe(ordinary);
    expect(first.images).toEqual([image('shared')]);
    await projection.complete(next);
    expect(projection.hasPendingImages([first, secondView])).toBe(false);
    expect(
      (await projection.prepare(request([first, secondView]))).messages.map((m) => m.images?.length)
    ).toEqual([1, 1]);
  });

  it('uses callId or recordId as source identity instead of resourceId', async () => {
    const store = createStore({ shared: 'c2hhcmVk', 'different-resource': 'ZGlmZmVyZW50' });
    const history = [
      imageMessage('shared', { callId: 'historical-call' }),
      imageMessage('shared', { recordId: 'historical-record' })
    ];
    const projection = new ResourceInputProjection(false, store, 'session-1', history);
    const prepared = await projection.prepare(
      request([
        imageMessage('different-resource', { callId: 'historical-call' }),
        imageMessage('different-resource', { recordId: 'historical-record' }),
        imageMessage('shared', { callId: 'new-call' }),
        imageMessage('shared', { recordId: 'new-record' })
      ])
    );

    expect(prepared.messages.map((item) => item.images ?? [])).toEqual([
      [{ ...image('different-resource'), dataBase64: 'ZGlmZmVyZW50' }],
      [{ ...image('different-resource'), dataBase64: 'ZGlmZmVyZW50' }],
      [{ ...image('shared'), dataBase64: 'c2hhcmVk' }],
      [{ ...image('shared'), dataBase64: 'c2hhcmVk' }]
    ]);
    expect(store.readResource).toHaveBeenCalledTimes(2);
    expect(store.readResource).toHaveBeenCalledWith('session-1', 'shared');
    expect(store.readResource).toHaveBeenCalledWith('session-1', 'different-resource');
  });

  it('shares pending reads and successful bytes across model requests in one Execution', async () => {
    const store = createStore({ shared: 'c2hhcmVk' });
    const projection = new ResourceInputProjection(false, store, 'session-1', []);
    const input = request([imageMessage('shared', { callId: 'view' })]);
    const [first, concurrent] = await Promise.all([
      projection.prepare(input),
      projection.prepare(input)
    ]);
    await projection.complete(first);
    const next = await projection.prepare(input);
    for (const prepared of [first, concurrent, next])
      expect(prepared.messages[0]?.images).toEqual([
        { ...image('shared'), dataBase64: 'c2hhcmVk' }
      ]);
    expect(store.readResource).toHaveBeenCalledTimes(1);
  });

  it.each(['release', 'replace', 'gc'] as const)(
    'releases encoded bytes at the %s boundary',
    async (boundary) => {
      const store = createStore({ a: 'YQ==', b: 'Yg==' });
      const projection = new ResourceInputProjection(false, store, 'session-1', []);
      const sources = [imageMessage('a', { callId: 'a' }), imageMessage('b', { callId: 'b' })];
      await projection.complete(await projection.prepare(request(sources)));
      if (boundary === 'release') projection.releaseBytes();
      else if (boundary === 'replace') projection.replace(sources);
      else
        projection.adoptGc({ version: 1, evictedThrough: { sourceId: 'tool:a', imageIndex: 0 } });

      const next = await projection.prepare(request([sources[1]!]));
      expect(next.messages[0]?.images).toEqual([{ ...image('b'), dataBase64: 'Yg==' }]);
      expect(store.readResource.mock.calls.filter(([, id]) => id === 'b')).toHaveLength(2);
    }
  );

  it('does not repopulate a released cache when an earlier read finishes', async () => {
    const store = createStore({ a: 'YQ==' });
    let finishRead!: (value: { mimeType: string; dataBase64: string }) => void;
    store.readResource.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        })
    );
    const projection = new ResourceInputProjection(false, store, 'session-1', []);
    const input = request([imageMessage('a', { callId: 'view' })]);
    const pending = projection.prepare(input);
    projection.releaseBytes();
    finishRead({ mimeType: 'image/png', dataBase64: 'YQ==' });
    await pending;
    expect((await projection.prepare(input)).messages[0]?.images).toEqual([
      { ...image('a'), dataBase64: 'YQ==' }
    ]);
    expect(store.readResource).toHaveBeenCalledTimes(2);
  });

  it('bounds retained Base64 without rejecting subsequent individually legal requests', async () => {
    const payload = 'Y'.repeat(7 * 1024 * 1024);
    const store = createStore({ a: payload, b: payload });
    const projection = new ResourceInputProjection(false, store, 'session-1', []);
    const first = request([], { images: [image('a')] });
    const next = request([], { images: [image('b')] });
    for (const input of [first, next, next, first])
      expect((await projection.prepare(input)).images?.[0]?.dataBase64).toBe(payload);
    expect(store.readResource.mock.calls.map(([, id]) => id)).toEqual(['a', 'b', 'b']);
    projection.releaseBytes();
    await projection.prepare(next);
    await projection.prepare(next);
    expect(store.readResource.mock.calls.map(([, id]) => id)).toEqual(['a', 'b', 'b', 'b']);
  });

  it('keeps images available across uncompleted retries and completes cloned requests', async () => {
    const store = createStore({ retryImage: 'cmV0cnk=' });
    const projection = new ResourceInputProjection(false, store, 'session-1', []);
    const source = imageMessage('retryImage', { callId: 'retry-source' });
    const initial = request([source]);
    expect(projection.hasPendingImages(initial.messages)).toBe(true);
    const firstAttempt = await projection.prepare(initial);
    const retryAttempt = await projection.prepare({
      ...initial,
      retryState: { attempts: 1 }
    });

    expect(firstAttempt.messages[0]?.images).toEqual([
      { ...image('retryImage'), dataBase64: 'cmV0cnk=' }
    ]);
    expect(retryAttempt.messages[0]?.images).toEqual([
      { ...image('retryImage'), dataBase64: 'cmV0cnk=' }
    ]);

    const runtimeClone = { ...retryAttempt, retryState: { attempts: 2 } };
    expect(runtimeClone.messages).toBe(retryAttempt.messages);
    await projection.complete(runtimeClone);
    expect(projection.hasPendingImages(initial.messages)).toBe(false);

    const next = await projection.prepare(request([source]));
    expect(next.messages[0]?.images).toEqual([{ ...image('retryImage'), dataBase64: 'cmV0cnk=' }]);
  });

  it('preserves fixed expired HTTP URLs without reading or refreshing resource bytes', async () => {
    const fixedUrl = 'http://assets.example.test/image.png?signature=original';
    const fixedImage = {
      mimeType: 'image/png',
      resourceId: 'published-image',
      url: fixedUrl,
      urlExpiresAt: 1,
      dataBase64: 'stale-inline-bytes'
    };
    const historical = message({ callId: 'historical-url', images: [fixedImage] });
    const current = message({ callId: 'current-url', images: [fixedImage] });
    const store = createStore();
    const projection = new ResourceInputProjection(true, store, 'session-1', [historical]);
    const prepared = await projection.prepare(request([historical, current]));

    const projectedImage = {
      mimeType: 'image/png',
      resourceId: 'published-image',
      url: fixedUrl,
      urlExpiresAt: 1
    };
    expect(prepared.messages.map((item) => item.images)).toEqual([
      [projectedImage],
      [projectedImage]
    ]);
    expect(prepared.messages[0]?.images?.[0]?.url).toBe(fixedUrl);
    expect(prepared.messages[0]?.images?.[0]?.urlExpiresAt).toBe(1);
    expect(store.readResource).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unreadable'])(
    'omits an unavailable image, preserves text and healthy images, and continues (%s)',
    async (failure) => {
      const store = createStore({ healthy: 'aGVhbHRoeQ==' });
      if (failure === 'unreadable') {
        const read = store.readResource.getMockImplementation()!;
        store.readResource.mockImplementation(async (sessionId, resourceId) => {
          if (resourceId === 'missing-image')
            throw new MarAgentError(
              'MAR_AGENT_IMAGE_UNAVAILABLE',
              'Session input image is unavailable.'
            );
          return read(sessionId, resourceId);
        });
      }
      const projection = new ResourceInputProjection(false, store, 'session-1', []);
      const source = message({
        callId: 'missing-source',
        content: 'Keep this text.',
        images: [image('missing-image'), image('healthy')]
      });
      const input = request([source]);
      for (let turn = 0; turn < 2; turn++) {
        const prepared = await projection.prepare(input);
        expect(prepared.messages[0]?.content).toContain('Keep this text.');
        expect(prepared.messages[0]?.content).toContain('Image unavailable');
        expect(prepared.messages[0]?.images).toEqual([
          { ...image('healthy'), dataBase64: 'aGVhbHRoeQ==' }
        ]);
        await projection.complete(prepared);
      }
      expect(store.readResource.mock.calls.filter(([, id]) => id === 'missing-image')).toHaveLength(
        1
      );
      expect(source.images).toEqual([image('missing-image'), image('healthy')]);
      const reopened = new ResourceInputProjection(false, store, 'session-1', [source]);
      expect((await reopened.prepare(input)).messages[0]?.images).toHaveLength(1);
    }
  );

  it.each([false, true])(
    'does not hide storage or history failures as image recovery (structured=%s)',
    async (structured) => {
      const store = createStore();
      const failure = structured
        ? new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session history is corrupt.')
        : new Error('storage unavailable');
      store.readResource.mockRejectedValue(failure);
      const projection = new ResourceInputProjection(false, store, 'session-1', []);
      await expect(
        projection.prepare(request([imageMessage('image', { callId: 'source' })]))
      ).rejects.toBe(failure);
    }
  );

  it('allows a new source to deliver a repaired image without retrying the old source', async () => {
    const store = createStore();
    const projection = new ResourceInputProjection(false, store, 'session-1', []);
    const old = {
      ...imageMessage('repaired', { callId: 'old-view' }),
      images: [{ ...image('repaired'), byteSize: 1 }]
    };
    expect((await projection.prepare(request([old]))).messages[0]?.images).toEqual([]);
    store.readResource.mockResolvedValue({ mimeType: 'image/png', dataBase64: 'Yg==' });
    const next = {
      ...imageMessage('repaired', { callId: 'new-view' }),
      images: [{ ...image('repaired'), byteSize: 1 }]
    };
    const input = request([old, next]);
    projection.observe(input.messages);
    await projection.gcCandidate(input);
    const prepared = await projection.prepare(input);
    expect(prepared.messages[0]?.images).toEqual([]);
    expect(prepared.messages[1]?.images).toMatchObject([{ dataBase64: 'Yg==' }]);
    expect(store.readResource).toHaveBeenCalledTimes(2);
  });

  it('does not cache an empty resource before a new source repairs it', async () => {
    const store = createStore({ repaired: '' });
    const projection = new ResourceInputProjection(false, store, 'session-1', []);
    const old = imageMessage('repaired', { callId: 'old-view' });
    expect((await projection.prepare(request([old]))).messages[0]?.images).toEqual([]);
    store.readResource.mockResolvedValue({ mimeType: 'image/png', dataBase64: 'Yg==' });
    const next = imageMessage('repaired', { callId: 'new-view' });
    const input = request([old, next]);
    projection.observe(input.messages);
    const prepared = await projection.prepare(input);
    expect(prepared.messages[0]?.images).toEqual([]);
    expect(prepared.messages[1]?.images).toMatchObject([{ dataBase64: 'Yg==' }]);
    expect(store.readResource).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    'omits unavailable images before enforcing the encoded budget (GC first=%s)',
    async (gcFirst) => {
      const store = createStore();
      const projection = new ResourceInputProjection(false, store, 'session-1', []);
      const input = request(
        ['a', 'b', 'c'].map((id) => ({
          ...imageMessage(id, { callId: id }),
          images: [{ ...image(id), byteSize: 5 * 1024 * 1024 }]
        }))
      );
      projection.observe(input.messages);
      if (gcFirst) await expect(projection.gcCandidate(input)).resolves.toBeUndefined();
      const prepared = await projection.prepare(input);
      expect(prepared.messages.every((message) => message.images?.length === 0)).toBe(true);
      expect(
        prepared.messages.every((message) => message.content.includes('Image unavailable'))
      ).toBe(true);
      expect(store.readResource).toHaveBeenCalledTimes(3);
    }
  );

  it('excludes unavailable fresh images before permanently collecting healthy history', async () => {
    const store = createStore({ healthy: Buffer.alloc(2 * 1024 * 1024).toString('base64') });
    const healthy = {
      ...imageMessage('healthy', { callId: 'history' }),
      images: [{ ...image('healthy'), byteSize: 2 * 1024 * 1024 }]
    };
    const projection = new ResourceInputProjection(false, store, 'session-1', [healthy]);
    const sources = [
      healthy,
      ...['missing-a', 'missing-b'].map((id) => ({
        ...imageMessage(id, { callId: id }),
        images: [{ ...image(id), byteSize: 4 * 1024 * 1024 }]
      }))
    ];
    projection.observe(sources);
    await expect(projection.gcCandidate(request(sources))).resolves.toBeUndefined();
    expect(projection.checkpoint().evictedThrough).toBeUndefined();
    const prepared = await projection.prepare(request(sources));
    expect(prepared.messages.map((item) => item.images?.length)).toEqual([1, 0, 0]);
    expect(prepared.messages[0]?.content).toBe(healthy.content);
  });

  it('excludes unavailable history before permanently collecting healthy history', async () => {
    const store = createStore({ healthy: Buffer.alloc(3 * 1024 * 1024).toString('base64') });
    const healthy = {
      ...imageMessage('healthy', { callId: 'healthy-history' }),
      images: [{ ...image('healthy'), byteSize: 3 * 1024 * 1024 }]
    };
    const missing = {
      ...imageMessage('missing', { callId: 'missing-history' }),
      images: [{ ...image('missing'), byteSize: 7 * 1024 * 1024 }]
    };
    const sources = [healthy, missing];
    const projection = new ResourceInputProjection(false, store, 'session-1', sources);
    await expect(projection.gcCandidate(request(sources))).resolves.toBeUndefined();
    expect(projection.checkpoint().evictedThrough).toBeUndefined();
    const prepared = await projection.prepare(request(sources));
    expect(prepared.messages.map((item) => item.images?.length)).toEqual([1, 0]);
    expect(prepared.messages[0]?.content).toBe(healthy.content);
  });

  it('plans hard-limit GC from actual bytes when stored image sizes are stale', async () => {
    const MiB = 1024 * 1024;
    const store = createStore({ historical: 'a'.repeat(8 * MiB), fresh: 'b'.repeat(5 * MiB) });
    const historical = {
      ...imageMessage('historical', { callId: 'historical' }),
      images: [{ ...image('historical'), byteSize: 1 }]
    };
    const projection = new ResourceInputProjection(false, store, 'session-1', [historical]);
    const candidate = await projection.gcCandidate(
      request([historical], { images: [image('fresh')] })
    );
    expect(candidate).toMatchObject({
      reason: 'HARD_LIMIT',
      state: { evictedThrough: { sourceId: 'tool:historical', imageIndex: 0 } }
    });
    projection.adoptGc(candidate?.state);
    const prepared = await projection.prepare(request([historical], { images: [image('fresh')] }));
    expect(prepared.messages[0]?.images).toEqual([]);
    expect(prepared.images).toMatchObject([{ resourceId: 'fresh' }]);
  });

  it('removes only unavailable Code Mode images and remaps their observation positions', async () => {
    const store = createStore({ available: 'Yg==' });
    const projection = new ResourceInputProjection(false, store, 'session-1', []);
    const original = message({
      callId: 'view-many',
      content: 'viewed two files',
      images: [image('missing'), image('available')],
      observations: [
        { type: 'value', id: 'first', value: 'first file', format: 'image', imageIndices: [0] },
        { type: 'value', id: 'second', value: 'second file', format: 'image', imageIndices: [1] }
      ]
    });
    const projected = (await projection.prepare(request([original]))).messages[0]!;
    expect(projected.images).toMatchObject([{ resourceId: 'available', dataBase64: 'Yg==' }]);
    expect(projected.observations).toMatchObject([
      { id: 'first', value: expect.stringContaining('Image unavailable') },
      { id: 'second', imageIndices: [0], value: 'second file' }
    ]);
    expect(projected.observations?.[0]).toMatchObject({ imageIndices: [] });
    expect(original.images).toHaveLength(2);
    expect(original.observations?.[1]).toMatchObject({ imageIndices: [1] });
  });

  it('does not mutate historical messages or restore messages omitted by a hook', async () => {
    const removedByHook = Object.freeze(
      message({
        callId: 'hook-removed-image',
        images: Object.freeze([Object.freeze(image('hook-removed-resource'))])
      })
    );
    const history = Object.freeze([removedByHook]);
    const keptByHook = message({ callId: 'hook-kept-text', content: 'kept by hook' });
    const store = createStore({ 'hook-removed-resource': 'cGl4ZWxz' });
    const projection = new ResourceInputProjection(false, store, 'session-1', history);
    const candidate = request([keptByHook]);
    const prepared = await projection.prepare(candidate);

    expect(prepared.messages).toEqual([keptByHook]);
    expect(prepared.messages).not.toContain(removedByHook);
    expect(history).toEqual([removedByHook]);
    expect(removedByHook.images).toEqual([image('hook-removed-resource')]);
    expect(store.readResource).not.toHaveBeenCalled();
  });
});
