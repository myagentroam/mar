import type { InjectionKey } from 'vue';

export interface ConversationMarkdownCache {
  render(key: readonly string[], render: () => string): string;
}

export const CONVERSATION_MARKDOWN_CACHE_KEY: InjectionKey<ConversationMarkdownCache> = Symbol(
  'conversation-markdown-cache'
);

/** One bounded cache per Timeline; entries contain only already-sanitized HTML. */
export function createConversationMarkdownCache(): ConversationMarkdownCache {
  const entries = new Map<string, string>();
  let size = 0;
  const maxSize = 2 * 1024 * 1024;
  return {
    render(parts, render) {
      const key = JSON.stringify(parts);
      const cached = entries.get(key);
      if (cached !== undefined) {
        entries.delete(key);
        entries.set(key, cached);
        return cached;
      }
      const html = render();
      const entrySize = key.length + html.length;
      if (entrySize > maxSize) return html;
      while (entries.size >= 64 || size + entrySize > maxSize) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        size -= oldest.length + entries.get(oldest)!.length;
        entries.delete(oldest);
      }
      entries.set(key, html);
      size += entrySize;
      return html;
    }
  };
}
