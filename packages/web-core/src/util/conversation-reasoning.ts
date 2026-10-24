export interface ReasoningPreview {
  readonly id: string;
  readonly text: string;
  readonly representation: 'summary' | 'visible_thinking' | 'unspecified';
}

/** Select the display line without scanning its prose boundaries. */
function reasoningPreviewLine(text: string, representation: unknown): string {
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
  return firstLine
    .trim()
    .replace(/^#{1,6}\s+/u, '')
    .replace(/^\*\*([^*]+)\*\*/u, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
}

function firstReasoningClause(line: string): string {
  // Index matching code delimiters once. Repeated searches for unmatched openers
  // would make punctuation-heavy or incomplete streamed text quadratic again.
  const ticks = [...line.matchAll(/`+/gu)];
  const closingTicks = new Map<number, number>();
  const nextByWidth = new Map<number, number>();
  for (let index = ticks.length - 1; index >= 0; index--) {
    const tick = ticks[index]!;
    const width = tick[0].length;
    const next = nextByWidth.get(width);
    if (next !== undefined) closingTicks.set(tick.index, next + width);
    nextByWidth.set(width, tick.index);
  }
  const url = /https?:\/\/[^\s<>()，。；：！？、…]*[^\s<>().,;:!?，。；：！？、…]/uy;
  for (let index = 0; index < line.length;) {
    const character = line[index]!;
    if (character === '`') {
      const close = closingTicks.get(index);
      if (close !== undefined) {
        index = close;
      } else {
        do index++;
        while (line[index] === '`');
      }
      continue;
    }
    if (character === 'h') {
      url.lastIndex = index;
      const match = url.exec(line);
      if (match) {
        index = url.lastIndex;
        continue;
      }
    }
    let end = index + 1;
    if (character === '.') {
      while (line[end] === '.') end++;
    }
    const boundary =
      '，,。；;：！？!?、…'.includes(character) ||
      ((character === '.' || character === ':') && (end === line.length || line[end] === ' '));
    if (boundary) return line.slice(0, index).trim() || line;
    index = end;
  }
  // Containers own visual truncation; keep the full selected line/clause.
  return line;
}

/** Normalize public display text only; never rewrite the underlying reasoning record. */
export function reasoningPreview(text: string, representation: unknown = 'unspecified'): string {
  const line = reasoningPreviewLine(text, representation);
  return representation === 'summary' ? line : firstReasoningClause(line);
}

export function normalizeReasoningPreview(
  id: string,
  text: string,
  representation: unknown
): ReasoningPreview | undefined {
  const line = reasoningPreviewLine(text, representation);
  let preview: string | undefined;
  return line
    ? {
        id,
        // Budgeting and preview selection only need identity and representation.
        // Parse the clause at most once, and only when a view consumes its text.
        get text() {
          return (preview ??= representation === 'summary' ? line : firstReasoningClause(line));
        },
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
