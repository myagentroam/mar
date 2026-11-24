import MarkdownIt from 'markdown-it';

const links = new MarkdownIt({ linkify: true }).linkify;

/** Linkifies only explicit HTTP(S) URLs without changing the surrounding plain text. */
export function conversationUrlSegments(text: string): { text: string; url?: string }[] {
  const segments: { text: string; url?: string }[] = [];
  let end = 0;
  for (const match of links.match(text) ?? []) {
    if (!/^https?:\/\//iu.test(match.raw)) continue;
    if (match.index > end) segments.push({ text: text.slice(end, match.index) });
    segments.push({ text: match.raw, url: match.raw });
    end = match.lastIndex;
  }
  if (end < text.length) segments.push({ text: text.slice(end) });
  return segments;
}
