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
  it('sends only each newly delivered image across tool-result rounds and re-views', async () => {
    const store = createStore({
      attachment: 'YXR0YWNobWVudA==',
      sharedFile: 'c2hhcmVkLWZpbGU=',
      imageB: 'aW1hZ2UtYg==',
      mixedImage: 'bWl4ZWQtaW1hZ2U='
    });
    const projection = new ResourceInputProjection(false, store, 'session-1', []);
    const attachment = message({
      role: 'user',
      metadata: { source: 'user', recordId: 'attachment-1' },
      images: [
        {
          ...image('attachment'),
          url: 'http://assets.example.test/expired-attachment.png',
          urlExpiresAt: 1
        }
      ]
    });
    const first = await projection.prepare(
      request([attachment], { images: [image('attachment')] })
    );

    expect(first.messages[0]?.images).toEqual([
      { ...image('attachment'), dataBase64: 'YXR0YWNobWVudA==' }
    ]);
    expect(first).not.toHaveProperty('images');
    expect(attachment.images).toEqual([
      {
        ...image('attachment'),
        url: 'http://assets.example.test/expired-attachment.png',
        urlExpiresAt: 1
      }
    ]);
    projection.complete({ ...first, retryState: { attempts: 1 } });

    const ordinaryTool = message({ callId: 'ordinary-1', content: 'read completed' });
    const afterAttachment = await projection.prepare(request([attachment, ordinaryTool]));
    expect(afterAttachment.messages[0]?.images).toEqual([]);
    expect(afterAttachment.messages[1]).toEqual(ordinaryTool);
    expect(store.readResource).toHaveBeenCalledTimes(1);

    const imageA = imageMessage('sharedFile', { callId: 'view-image-a' });
    const afterImageA = await projection.prepare(request([attachment, ordinaryTool, imageA]));
    expect(afterImageA.messages.map((item) => item.images ?? [])).toEqual([
      [],
      [],
      [{ ...image('sharedFile'), dataBase64: 'c2hhcmVkLWZpbGU=' }]
    ]);
    projection.complete(afterImageA);

    const ordinaryAfterImage = message({ callId: 'ordinary-2', content: 'command completed' });
    const afterOrdinary = await projection.prepare(
      request([attachment, imageA, ordinaryAfterImage])
    );
    expect(afterOrdinary.messages.map((item) => item.images ?? [])).toEqual([[], [], []]);
    expect(store.readResource).toHaveBeenCalledTimes(2);

    const sameFileAgain = imageMessage('sharedFile', { callId: 'view-image-a-again' });
    const afterReView = await projection.prepare(
      request([attachment, imageA, ordinaryAfterImage, sameFileAgain])
    );
    expect(afterReView.messages[3]?.images).toEqual([
      { ...image('sharedFile'), dataBase64: 'c2hhcmVkLWZpbGU=' }
    ]);
    expect(store.readResource).toHaveBeenNthCalledWith(3, 'session-1', 'sharedFile');
    projection.complete(afterReView);

    const imageB = imageMessage('imageB', { callId: 'view-image-b' });
    const mixedResult = message({
      callId: 'mixed-image-result',
      content: 'two images were observed',
      images: [image('imageB'), image('mixedImage')]
    });
    const finalRound = await projection.prepare(
      request([attachment, imageA, sameFileAgain, ordinaryAfterImage, imageB, mixedResult])
    );
    expect(finalRound.messages.map((item) => item.images ?? [])).toEqual([
      [],
      [],
      [],
      [],
      [{ ...image('imageB'), dataBase64: 'aW1hZ2UtYg==' }],
      [
        { ...image('imageB'), dataBase64: 'aW1hZ2UtYg==' },
        { ...image('mixedImage'), dataBase64: 'bWl4ZWQtaW1hZ2U=' }
      ]
    ]);
    expect(finalRound.messages.map((item) => item.content)).toEqual([
      attachment.content,
      imageA.content,
      sameFileAgain.content,
      ordinaryAfterImage.content,
      imageB.content,
      mixedResult.content
    ]);
    expect(store.readResource).toHaveBeenCalledTimes(6);
  });

  it('uses callId or recordId as source identity instead of resourceId', async () => {
    const store = createStore({ shared: 'c2hhcmVk' });
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
      [],
      [],
      [{ ...image('shared'), dataBase64: 'c2hhcmVk' }],
      [{ ...image('shared'), dataBase64: 'c2hhcmVk' }]
    ]);
    expect(store.readResource).toHaveBeenCalledTimes(2);
    expect(store.readResource).toHaveBeenNthCalledWith(1, 'session-1', 'shared');
    expect(store.readResource).toHaveBeenNthCalledWith(2, 'session-1', 'shared');
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
    projection.complete(runtimeClone);
    expect(projection.hasPendingImages(initial.messages)).toBe(false);

    const next = await projection.prepare(request([source]));
    expect(next.messages[0]?.images).toEqual([]);
    expect(store.readResource).toHaveBeenCalledTimes(2);
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
