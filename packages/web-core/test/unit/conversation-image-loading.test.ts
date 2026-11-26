import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive, ref } from 'vue';
import DecodedPreviewImage from '../../src/view/conversation/DecodedPreviewImage.vue?unit-render';
import ConversationImageThumbnail from '../../src/view/conversation/ConversationImageThumbnail.vue?unit-render';
import { conversationThumbnailUrl } from '../../src/util/conversation-image-url.js';
import { createConversationImageService } from '../../src/service/conversation-image-service.js';
import type { ConversationTurn } from '../../src/model/workbench.js';
import { flushComponent, renderComponent, trigger } from './support/component-renderer.js';

describe('Conversation image loading', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    '/api/agent-runs/run/images/0?nodeId=node',
    '/api/workspaces/workspace/files/content?nodeId=node&path=picture.png',
    '/api/nodes/node/hosted-conversations/chat/runs/run/images/image',
    '/api/session-shares/share/runs/run/images/image'
  ])('loads only a bounded thumbnail of %s in the list', (source) => {
    const state = renderComponent(ConversationImageThumbnail, { source, name: 'Picture' });
    try {
      const url = new URL(String(state.findAll('img')[0]!.props.src), 'http://localhost');
      expect(url.searchParams.get('maxWidth')).toBe('320');
      expect(url.searchParams.get('maxHeight')).toBe('240');
      expect(url.pathname).toBe(new URL(source, url.origin).pathname);
    } finally {
      state.unmount();
    }
  });

  it('leaves local and external sources unchanged and never falls back to the full image', async () => {
    expect(conversationThumbnailUrl('blob:local-image')).toBe('blob:local-image');
    expect(conversationThumbnailUrl('https://external.test/image.png')).toBe(
      'https://external.test/image.png'
    );
    const onClick = vi.fn();
    const source = '/api/agent-runs/run/images/0?nodeId=node';
    const state = renderComponent(ConversationImageThumbnail, { source, name: 'Picture', onClick });
    try {
      await trigger(state.findAll('img')[0]!, 'onError');
      expect(state.findAll('img')).toHaveLength(0);
      await trigger(state.findAll('button')[0]!, 'onClick', {});
      expect(onClick).toHaveBeenCalledOnce();
      expect(state.findAll('img')[0]!.props.src).toContain('maxWidth=320&maxHeight=240');
    } finally {
      state.unmount();
    }
  });

  it('loads the same original GIF through Web playback in the list and dialog', async () => {
    const service = createConversationImageService(ref('node'));
    const attachment = service.attachments('run', {
      attachments: [{ name: 'Animation', mime: 'image/gif', imageIndex: 0 }]
    })[0]!;
    service.open(attachment);
    const preview = service.preview.value!;
    const bytes = Buffer.from(
      'R0lGODlhDAAKAIAAAExpcQAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQFCgAAACwAAAAADAAKAAACCYSPqcvtD6OcBQAh+QQFWgAAACwAAAAADAAKAIBMaXHrAAACCYyPqcvtD6OcBQA7',
      'base64'
    );
    const fetch = vi.fn(async (_url: string) => new Response(bytes));
    vi.stubGlobal('fetch', fetch);
    const thumbnail = renderComponent(ConversationImageThumbnail, {
      source: attachment.previewUrl,
      name: attachment.name,
      direct: attachment.direct
    });
    const onReady = vi.fn();
    const dialog = renderComponent(DecodedPreviewImage, {
      ...preview,
      source: preview.url,
      onReady
    });
    try {
      await vi.waitFor(async () => {
        await flushComponent();
        expect(thumbnail.findAll('img')[0]!.props.src).toMatch(/^blob:/u);
        expect(dialog.findAll('img')[0]!.props.src).toMatch(/^blob:/u);
      });
      const image = dialog.findAll('img')[0]!;
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        '/api/agent-runs/run/images/0?nodeId=node&originalGif=1',
        '/api/agent-runs/run/images/0?nodeId=node&originalGif=1'
      ]);
      Object.assign(image, { decode: async () => {}, naturalWidth: 32, naturalHeight: 32 });
      await trigger(image, 'onLoad', { currentTarget: image });
      expect(onReady).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      thumbnail.unmount();
      dialog.unmount();
      service.dispose();
    }
  });

  it.each(['ordinary', 'Hosted'])(
    'retains the original %s source after a thumbnail error until its Turn is evicted',
    async (kind) => {
      const service = createConversationImageService(
        ref('node /1'),
        kind === 'Hosted'
          ? {
              sourceUrl: ({ nodeId, runId, imageSelector }) =>
                `/api/nodes/${encodeURIComponent(nodeId)}/hosted-conversations/chat/runs/${encodeURIComponent(runId)}/images/${encodeURIComponent(imageSelector)}?revision=source%2F1&mode=inline`
            }
          : {}
      );
      const runId = kind === 'Hosted' ? 'native-history:hosted:chat' : 'run-1';
      const payload = {
        attachments: [
          {
            name: 'Picture',
            mime: 'image/png',
            ...(kind === 'Hosted' ? { imageRef: 'file:picture.png' } : { imageIndex: 0 })
          }
        ]
      };
      const turn: ConversationTurn = {
        id: 'turn-1',
        sessionId: 'session-1',
        runId,
        status: 'COMPLETED',
        items: [{ id: 'user-1', kind: 'user_message', status: 'COMPLETED', payload }]
      };
      const attachment = service.attachments(runId, payload)[0]!;
      const source = attachment.previewUrl!;
      const onUnavailable = vi.fn(service.markUnavailable);
      let state = renderComponent(ConversationImageThumbnail, {
        source,
        name: attachment.name,
        onUnavailable
      });
      try {
        const thumbnail = new URL(String(state.findAll('img')[0]!.props.src), 'http://localhost');
        for (const [key, value] of new URL(source, thumbnail.origin).searchParams) {
          expect(thumbnail.searchParams.get(key)).toBe(value);
        }
        expect(thumbnail.searchParams.get('maxWidth')).toBe('320');
        expect(thumbnail.searchParams.get('maxHeight')).toBe('240');

        await trigger(state.findAll('img')[0]!, 'onError');
        expect(state.findAll('img')).toHaveLength(0);
        expect(service.attachments(runId, payload)[0]!.previewUrl).toBeUndefined();
        expect(onUnavailable).toHaveBeenCalledExactlyOnceWith(source);

        service.retain([turn]);
        const retained = service.attachments(runId, payload)[0]!;
        expect(retained.previewUrl).toBeUndefined();
        state.unmount();
        state = renderComponent(ConversationImageThumbnail, {
          source: retained.previewUrl ?? '',
          name: retained.name,
          onUnavailable
        });
        expect(state.findAll('img')).toHaveLength(0);
        expect(onUnavailable).toHaveBeenCalledOnce();

        service.retain([]);
        expect(service.attachments(runId, payload)[0]!.previewUrl).toBe(source);
      } finally {
        state.unmount();
        service.dispose();
      }
    }
  );

  it('resets a failed thumbnail when its source changes and reports the replacement source', async () => {
    const onUnavailable = vi.fn();
    const onClick = vi.fn();
    const props = reactive({
      source: '/api/agent-runs/run/images/0?nodeId=node&revision=old',
      name: 'Picture',
      onUnavailable,
      onClick
    });
    const state = renderComponent(ConversationImageThumbnail, props);
    try {
      await trigger(state.findAll('img')[0]!, 'onError');
      expect(state.findAll('img')).toHaveLength(0);
      props.source = '/api/agent-runs/run/images/1?nodeId=node&revision=new%2F1';
      await flushComponent();
      expect(state.findAll('img')[0]!.props.src).toBe(conversationThumbnailUrl(props.source));
      const event = { ctrlKey: true };
      await trigger(state.findAll('button')[0]!, 'onClick', event);
      expect(onClick).toHaveBeenCalledExactlyOnceWith(event);
      await trigger(state.findAll('img')[0]!, 'onError');
      expect(onUnavailable).toHaveBeenLastCalledWith(props.source);
      expect(state.findAll('img')).toHaveLength(0);
    } finally {
      state.unmount();
    }
  });

  it('keeps the full image hidden until the actual image element has finished decoding', async () => {
    let finish!: () => void;
    const decoding = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const source = 'blob:original';
    const state = renderComponent(DecodedPreviewImage, { source, name: 'Picture' });
    await flushComponent();
    try {
      const image = state.findAll('img')[0]!;
      const decode = vi.fn(() => decoding);
      Object.assign(image, { naturalWidth: 1600, naturalHeight: 900, decode });
      expect(image.props.src).toBe(source);
      expect(image.style.display).toBe('none');
      await trigger(image, 'onLoad', { currentTarget: image });
      expect(decode).toHaveBeenCalledOnce();
      expect(image.style.display).toBe('none');
      finish();
      await flushComponent();
      expect(image.style.display).not.toBe('none');
      expect(state.findAll('div')[0]!.props['aria-busy']).toBe(false);
    } finally {
      state.unmount();
    }
  });

  it('ignores decode completion after changing the source or closing the preview', async () => {
    let finish!: () => void;
    const props = reactive({ source: 'blob:old', name: 'Picture' });
    const state = renderComponent(DecodedPreviewImage, props);
    await flushComponent();
    const previous = state.findAll('img')[0]!;
    Object.assign(previous, {
      decode: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    });
    await trigger(previous, 'onLoad', { currentTarget: previous });
    props.source = 'blob:new';
    await flushComponent();
    const current = state.findAll('img')[0]!;
    finish();
    await flushComponent();
    expect(current.props.src).toBe('blob:new');
    expect(current.style.display).toBe('none');
    Object.assign(current, {
      decode: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    });
    await trigger(current, 'onLoad', { currentTarget: current });
    state.unmount();
    finish();
    await flushComponent();
    expect(state.findAll('img')).toHaveLength(0);
  });

  it('shows an explicit retry after decoding fails and creates a fresh image element', async () => {
    const onError = vi.fn();
    const source = 'blob:original';
    const state = renderComponent(DecodedPreviewImage, { source, name: 'Picture', onError });
    await flushComponent();
    try {
      const image = state.findAll('img')[0]!;
      Object.assign(image, { decode: () => Promise.reject(new Error('Invalid image')) });
      await trigger(image, 'onLoad', { currentTarget: image });
      await flushComponent();
      expect(onError).toHaveBeenCalledExactlyOnceWith(source);
      expect(state.findAll('img')).toHaveLength(0);
      expect(state.findAll('div').some((node) => node.props.role === 'alert')).toBe(true);
      await trigger(state.findAll('MarButton')[0]!, 'onClick');
      expect(state.findAll('img')[0]).not.toBe(image);
      expect(state.findAll('img')[0]!.style.display).toBe('none');
    } finally {
      state.unmount();
    }
  });
});
