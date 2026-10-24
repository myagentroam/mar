export interface ReasoningPreview {
  readonly id: string;
  readonly text: string;
  readonly representation: 'summary' | 'visible_thinking' | 'unspecified';
}

/** Normalize public display text only; never rewrite the underlying reasoning record. */
export function reasoningPreview(text: string, representation: unknown = 'unspecified'): string {
  if (representation === 'summary') {
    const heading = [...text.matchAll(/(?:^|\n)[^\S\r\n]*\*\*([^\r\n*]+)\*\*/gu)]
      .at(-1)?.[1]
      ?.trim();
    const paragraph =
      text
        .trim()
        .split(/\n\s*\n/u)
        .at(-1) ?? '';
    const firstLine = paragraph.split(/\r?\n/u).find((line) => line.trim()) ?? '';
    return (heading || firstLine).replace(/\s+/gu, ' ').trim();
  }

  const firstLine = text.split(/\r?\n/u).find((line) => line.trim()) ?? '';
  const line = firstLine
    .trim()
    .replace(/^#{1,6}\s+/u, '')
    .replace(/^\*\*([^*]+)\*\*/u, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
  // Skip inline code and URLs, leaving trailing prose punctuation outside the URL.
  // Dots only split at prose boundaries, not inside relative paths or version numbers.
  for (const match of line.matchAll(
    /(`+).*?\1|(https?:\/\/[^\s<>()，。；：！？、…]*[^\s<>().,;:!?，。；：！？、…])|[，,。；;：！？!?、…]|\.{2,}(?=\s|$)|[.:](?=\s|$)/gu
  )) {
    if (match[1] !== undefined || match[2] !== undefined) continue;
    return line.slice(0, match.index).trim() || line;
  }
  // Containers own visual truncation; keep the full selected line/clause.
  return line;
}

export function normalizeReasoningPreview(
  id: string,
  text: string,
  representation: unknown
): ReasoningPreview | undefined {
  const preview = reasoningPreview(text, representation);
  return preview
    ? {
        id,
        text: preview,
        representation:
          representation === 'summary' || representation === 'visible_thinking'
            ? representation
            : 'unspecified'
      }
    : undefined;
}

/** Inputs follow authoritative record order: latest summary wins, then latest thinking. */
export function selectReasoningPreview(
  previous: ReasoningPreview | undefined,
  next: ReasoningPreview | undefined
): ReasoningPreview | undefined {
  if (next === undefined) return previous;
  return previous?.representation === 'summary' && next.representation !== 'summary'
    ? previous
    : next;
}
