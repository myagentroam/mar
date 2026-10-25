import { describe, expect, it, vi } from 'vitest';
import type { ModelMessage, ModelRequest } from '../../src/agent-core/model/contracts.js';
import { ResourceInputProjection } from '../../src/agent-core/sdk/resource-input.js';

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
    expect(store.readResource).toHaveBeenCalledTimes(4);
    expect(store.readResource).toHaveBeenNthCalledWith(3, 'session-1', 'shared');
    expect(store.readResource).toHaveBeenNthCalledWith(4, 'session-1', 'shared');
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

  it('returns the same stable error when resource bytes are unavailable', async () => {
    const store = createStore();
    const projection = new ResourceInputProjection(false, store, 'session-1', []);
    const input = request([imageMessage('missing-image', { callId: 'missing-source' })]);

    await expect(projection.prepare(input)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_CORRUPT',
      publicMessage: 'Resource bytes are unavailable.'
    });
    await expect(projection.prepare(input)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_CORRUPT',
      publicMessage: 'Resource bytes are unavailable.'
    });
    expect(store.readResource).toHaveBeenCalledTimes(2);
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
