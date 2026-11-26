import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadConversationImagePreview,
  observeGifThumbnail
} from '../../src/service/conversation-image-preview-loader.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Conversation preview resource lifecycle', () => {
  const gif = Buffer.from(
    'R0lGODlhDAAKAIAAAExpcQAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQFCgAAACwAAAAADAAKAAACCYSPqcvtD6OcBQAh+QQFWgAAACwAAAAADAAKAIBMaXHrAAACCYyPqcvtD6OcBQA7',
    'base64'
  );
  const source = '/api/files/opaque-id/content';
  const limit = 5 * 1024 * 1024;

  it.each([false, true])(
    'loops GIF without changing its frame bytes (no loop block: %s)',
    async (missingLoop) => {
      const finite = Buffer.from(gif);
      finite.writeUInt16LE(1, 35);
      const body = missingLoop
        ? Buffer.concat([finite.subarray(0, 19), finite.subarray(38)])
        : finite;
      const fetch = vi.fn(async () => new Response(body));
      vi.stubGlobal('fetch', fetch);
      const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:playback');
      const revoke = vi.spyOn(URL, 'revokeObjectURL');
      const signal = new AbortController().signal;
      const preview = await loadConversationImagePreview(source, false, signal, true);
      expect(fetch).toHaveBeenCalledExactlyOnceWith(source, {
        credentials: 'same-origin',
        mode: 'same-origin',
        signal
      });
      const blob = create.mock.calls[0]![0];
      if (!(blob instanceof Blob)) throw new Error('Expected a GIF Blob');
      expect(blob.type).toBe('image/gif');
      expect(Buffer.from(await blob.arrayBuffer())).toEqual(gif);
      preview.release();
      expect(revoke).toHaveBeenCalledWith('blob:playback');
    }
  );

  it.each([undefined, String(limit + 1)])(
    'cancels an oversized GIF stream (length: %s)',
    async (length) => {
      const cancel = vi.fn();
      const stream = new ReadableStream({
        start: (controller) => controller.enqueue(new Uint8Array(limit + 1)),
        cancel
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(stream, {
              headers: length === undefined ? {} : { 'content-length': length }
            })
        )
      );
      const create = vi.spyOn(URL, 'createObjectURL');
      await expect(
        loadConversationImagePreview(source, false, new AbortController().signal, true)
      ).rejects.toThrow('IMAGE_PREVIEW_TOO_LARGE');
      expect(cancel).toHaveBeenCalledOnce();
      expect(create).not.toHaveBeenCalled();
    }
  );

  it('accepts GIF at the source byte limit and rejects other bytes in GIF mode', async () => {
    const bytes = Buffer.alloc(limit);
    gif.copy(bytes);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(bytes))
      .mockResolvedValueOnce(new Response('not a GIF'));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const preview = await loadConversationImagePreview(source, false, signal, true);
    preview.release();
    await expect(loadConversationImagePreview(source, false, signal, true)).rejects.toThrow(
      'IMAGE_PREVIEW_INVALID'
    );
  });

  it('defers a GIF thumbnail until visible and releases its URL on disposal', async () => {
    let intersect!: (visible: boolean) => void;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersect = (visible) =>
            callback(
              [{ isIntersecting: visible } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver
            );
        }
        observe() {}
        disconnect = disconnect;
      }
    );
    const fetch = vi.fn(async () => new Response(gif));
    vi.stubGlobal('fetch', fetch);
    const show = vi.fn();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const dispose = observeGifThumbnail({} as Element, source, show);
    intersect(false);
    expect(fetch).not.toHaveBeenCalled();
    intersect(true);
    await vi.waitFor(() => expect(show).toHaveBeenCalledWith(expect.stringMatching(/^blob:/u)));
    expect(fetch).toHaveBeenCalledOnce();
    dispose();
    expect(revoke).toHaveBeenCalledExactlyOnceWith(show.mock.calls[0]![0]);
  });

  it('does not publish a GIF thumbnail after its binding is disposed', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    let resolveResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => (resolveResponse = resolve));
    vi.stubGlobal(
      'fetch',
      vi.fn(() => response)
    );
    const show = vi.fn();
    const unavailable = vi.fn();
    const create = vi.spyOn(URL, 'createObjectURL');
    const cancelled = vi.fn();
    const dispose = observeGifThumbnail({} as Element, source, show, unavailable);
    dispose();
    resolveResponse(new Response(new ReadableStream({ cancel: cancelled })));
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    expect(create).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    expect(unavailable).not.toHaveBeenCalled();
  });

  it.each(['0', '1'])(
    'uses bounded previews and trusts only the resized header %s',
    async (resized) => {
      const fetch = vi.fn(
        async () => new Response('image', { headers: { 'x-mar-image-resized': resized } })
      );
      vi.stubGlobal('fetch', fetch);
      const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
      const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      const signal = new AbortController().signal;
      const source = '/api/workspaces/workspace/files/content?nodeId=node&path=long.png';
      const image = await loadConversationImagePreview(source, false, signal);
      expect(fetch).toHaveBeenCalledWith(`${source}&maxWidth=2560&maxHeight=2560`, {
        credentials: 'same-origin',
        signal
      });
      expect(image.resized).toBe(resized === '1');
      expect(image.url).toBe('blob:preview');
      expect(create).toHaveBeenCalledOnce();
      image.release();
      expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:preview');
    }
  );

  it('requests the unchanged original only after an explicit original selection', async () => {
    const fetch = vi.fn(async () => new Response('original'));
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:original');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const source = '/api/agent-runs/run/images/0?nodeId=node';
    const signal = new AbortController().signal;
    const image = await loadConversationImagePreview(source, true, signal);
    expect(fetch).toHaveBeenCalledWith(source, { credentials: 'same-origin', signal });
    expect(image.resized).toBe(false);
    image.release();
  });

  it.each(['blob:local', 'https://external.test/image.png'])(
    'preserves local or external source %s',
    async (source) => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const revoke = vi.spyOn(URL, 'revokeObjectURL');
      const image = await loadConversationImagePreview(source, false, new AbortController().signal);
      expect(image.url).toBe(source);
      expect(image.resized).toBe(false);
      image.release();
      expect(fetch).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
    }
  );

  it.each([503, 200])(
    'rejects HTTP failure or missing preview metadata without requesting the original (%s)',
    async (status) => {
      const fetch = vi.fn(async () => new Response('invalid', { status }));
      vi.stubGlobal('fetch', fetch);
      await expect(
        loadConversationImagePreview('/api/image', false, new AbortController().signal)
      ).rejects.toThrow('IMAGE_PREVIEW_');
      expect(fetch).toHaveBeenCalledOnce();
    }
  );

  it('does not allocate a temporary URL after its owner aborts during the body read', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({ 'x-mar-image-resized': '1' }),
        blob: async () => {
          controller.abort();
          return new Blob(['image']);
        }
      }))
    );
    const create = vi.spyOn(URL, 'createObjectURL');
    await expect(
      loadConversationImagePreview('/api/image', false, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(create).not.toHaveBeenCalled();
  });
});
