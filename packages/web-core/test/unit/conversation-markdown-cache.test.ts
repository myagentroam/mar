import { describe, expect, it, vi } from 'vitest';
import { createConversationMarkdownCache } from '../../src/util/conversation-markdown-cache.js';

describe('Timeline Markdown cache', () => {
  it('reuses only the same session, item, content, root and locale', () => {
    const cache = createConversationMarkdownCache();
    const render = vi.fn(() => '<p>safe</p>');
    const key = ['session-a', 'item-1', 'content', '/work', 'en-US'] as const;
    expect(cache.render(key, render)).toBe('<p>safe</p>');
    expect(cache.render(key, render)).toBe('<p>safe</p>');
    expect(render).toHaveBeenCalledTimes(1);
    for (let index = 0; index < key.length; index++) {
      const changed = [...key];
      changed[index] += '-other';
      cache.render(changed, render);
    }
    expect(render).toHaveBeenCalledTimes(6);
    createConversationMarkdownCache().render(key, render);
    expect(render).toHaveBeenCalledTimes(7);
  });

  it('evicts least recently used entries and does not retain oversized output', () => {
    const cache = createConversationMarkdownCache();
    const render = vi.fn(() => 'html');
    const key = (id: string) => ['session', id, 'content', '', 'en-US'];
    for (let index = 0; index < 64; index++) cache.render(key(String(index)), render);
    cache.render(key('0'), render);
    cache.render(key('64'), render);
    cache.render(key('0'), render);
    expect(render).toHaveBeenCalledTimes(65);
    cache.render(key('1'), render);
    expect(render).toHaveBeenCalledTimes(66);
    const huge = vi.fn(() => 'x'.repeat(2 * 1024 * 1024 + 1));
    cache.render(key('large'), huge);
    cache.render(key('large'), huge);
    expect(huge).toHaveBeenCalledTimes(2);
  });
});
