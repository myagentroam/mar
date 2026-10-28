export function quickPromptAtCursor(value: string, cursor = value.length): string | undefined {
  const beforeCursor = value.slice(0, Math.max(0, Math.min(cursor, value.length)));
  const match = /(?:^|\s)#([^\s]*)$/.exec(beforeCursor);
  return match === null ? undefined : match[1]!.toLocaleLowerCase();
}

export function quickPromptRangeAtCursor(
  value: string,
  cursor = value.length
): { start: number; end: number } | undefined {
  const bounded = Math.max(0, Math.min(cursor, value.length));
  const match = /(^|\s)#[^\s]*$/.exec(value.slice(0, bounded));
  if (match === null) return undefined;
  const suffix = /^\S*/.exec(value.slice(bounded))![0];
  return { start: match.index + match[1]!.length, end: bounded + suffix.length };
}

export function replaceQuickPromptAtCursor(
  value: string,
  replacement: string,
  cursor = value.length
): { readonly value: string; readonly cursor: number } | undefined {
  const range = quickPromptRangeAtCursor(value, cursor);
  if (range === undefined) return undefined;
  return {
    value: `${value.slice(0, range.start)}${replacement}${value.slice(range.end)}`,
    cursor: range.start + replacement.length
  };
}
