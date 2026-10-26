import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConversationImagePreview } from '../../src/service/conversation-image-preview-loader.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Conversation preview resource lifecycle', () => {
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
