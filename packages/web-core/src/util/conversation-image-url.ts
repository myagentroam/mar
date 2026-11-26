import type { ImageResizeOptions } from '@myagentroam/protocol';

/** Only controlled API resources accept image preview bounds. */
export function conversationPreviewUrl(source: string, bounds: ImageResizeOptions): string {
  if (!source.startsWith('/api/')) return source;
  const url = new URL(source, 'http://localhost');
  url.searchParams.set('maxWidth', String(bounds.maxWidth));
  url.searchParams.set('maxHeight', String(bounds.maxHeight));
  return `${url.pathname}${url.search}${url.hash}`;
}

export function conversationThumbnailUrl(source: string, direct = false): string {
  return direct ? source : conversationPreviewUrl(source, { maxWidth: 320, maxHeight: 240 });
}
