import { describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import DecodedPreviewImage from '../../src/view/conversation/DecodedPreviewImage.vue?unit-render';
import ConversationImageThumbnail from '../../src/view/conversation/ConversationImageThumbnail.vue?unit-render';
import { conversationThumbnailUrl } from '../../src/util/conversation-image-url.js';
import { flushComponent, renderComponent, trigger } from './support/component-renderer.js';

describe('Conversation image loading', () => {
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
      Object.assign(image, { decode: vi.fn(() => decoding) });
      expect(image.props.src).toBe(source);
      expect(image.style.display).toBe('none');
      const loaded = (image.props.onLoad as (event: unknown) => Promise<void>)({ target: image });
      await flushComponent();
      expect(image.style.display).toBe('none');
      finish();
      await loaded;
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
    const loaded = (previous.props.onLoad as (event: unknown) => Promise<void>)({
      target: previous
    });
    props.source = 'blob:new';
    await flushComponent();
    const current = state.findAll('img')[0]!;
    finish();
    await loaded;
    await flushComponent();
    expect(current.props.src).toBe('blob:new');
    expect(current.style.display).toBe('none');
    Object.assign(current, {
      decode: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    });
    const closing = (current.props.onLoad as (event: unknown) => Promise<void>)({
      target: current
    });
    state.unmount();
    finish();
    await expect(closing).resolves.toBeUndefined();
  });

  it('shows an explicit retry after decoding fails and creates a fresh image element', async () => {
    const onError = vi.fn();
    const source = 'blob:original';
    const state = renderComponent(DecodedPreviewImage, { source, name: 'Picture', onError });
    await flushComponent();
    try {
      const image = state.findAll('img')[0]!;
      Object.assign(image, { decode: () => Promise.reject(new Error('Invalid image')) });
      await trigger(image, 'onLoad', { target: image });
      expect(onError).toHaveBeenCalledExactlyOnceWith(source);
      expect(state.findAll('img')).toHaveLength(0);
      expect(state.findAll('div').some((node) => node.props.role === 'alert')).toBe(true);
      await trigger(state.findAll('ElButton')[0]!, 'onClick');
      expect(state.findAll('img')[0]).not.toBe(image);
      expect(state.findAll('img')[0]!.style.display).toBe('none');
    } finally {
      state.unmount();
    }
  });
});
