import { conversationPreviewUrl } from '../util/conversation-image-url.js';
import { loopGif } from '../util/gif-loop.js';

export interface LoadedImagePreview {
  readonly url: string;
  readonly resized: boolean;
  readonly release: () => void;
}

/** The server bounds GIF previews; playback preparation happens only in the browser. */
export async function loadConversationImagePreview(
  source: string,
  original: boolean,
  signal: AbortSignal,
  direct = false
): Promise<LoadedImagePreview> {
  if (!source.startsWith('/api/')) return { url: source, resized: false, release: () => {} };
  if (direct) return loadGifPreview(source, signal);
  const url = original
    ? source
    : conversationPreviewUrl(source, { maxWidth: 2560, maxHeight: 2560 });
  const response = await fetch(url, { credentials: 'same-origin', signal });
  if (!response.ok) throw new Error('IMAGE_PREVIEW_FAILED');
  const resized = response.headers.get('x-mar-image-resized');
  if (!original && resized !== '0' && resized !== '1') throw new Error('IMAGE_PREVIEW_INVALID');
  const blob = await response.blob();
  signal.throwIfAborted();
  return objectPreview(blob, !original && resized === '1');
}

function objectPreview(blob: Blob, resized: boolean): LoadedImagePreview {
  const objectUrl = URL.createObjectURL(blob);
  return {
    url: objectUrl,
    resized,
    release: () => URL.revokeObjectURL(objectUrl)
  };
}

async function loadGifPreview(source: string, signal: AbortSignal): Promise<LoadedImagePreview> {
  const url = new URL(source, 'http://localhost');
  url.searchParams.set('originalGif', '1');
  const response = await fetch(`${url.pathname}${url.search}`, {
    credentials: 'same-origin',
    mode: 'same-origin',
    signal
  });
  if (!response.ok) throw new Error('IMAGE_PREVIEW_FAILED');
  const bytes = new Uint8Array(await response.arrayBuffer());
  signal.throwIfAborted();
  return objectPreview(new Blob([loopGif(bytes)], { type: 'image/gif' }), false);
}

/** Defer the bounded fetch until a GIF thumbnail is visible; its owner disposes this binding. */
export function observeGifThumbnail(
  target: Element,
  source: string,
  show: (url: string) => void,
  unavailable?: () => void
): () => void {
  const controller = new AbortController();
  let value: LoadedImagePreview | undefined;
  const start = () => {
    void loadGifPreview(source, controller.signal).then(
      (preview) => {
        if (controller.signal.aborted) preview.release();
        else {
          value = preview;
          show(preview.url);
        }
      },
      () => {
        if (!controller.signal.aborted) unavailable?.();
      }
    );
  };
  const observer =
    typeof IntersectionObserver === 'undefined'
      ? undefined
      : new IntersectionObserver((entries) => {
          if (controller.signal.aborted || !entries.some((entry) => entry.isIntersecting)) return;
          observer?.disconnect();
          start();
        });
  if (observer === undefined) start();
  else observer.observe(target);
  return () => {
    observer?.disconnect();
    controller.abort();
    value?.release();
  };
}
