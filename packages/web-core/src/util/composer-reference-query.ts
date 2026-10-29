export interface ComposerReferenceQuery {
  readonly start: number;
  readonly end: number;
  readonly query: string;
  readonly sessionOnly: boolean;
}

export function composerReferenceAtCursor(
  value: string,
  cursor = value.length,
  sessionEnabled = true
): ComposerReferenceQuery | undefined {
  const position = Math.max(0, Math.min(cursor, value.length));
  const before = value.slice(0, position);
  const explicit = /(?:^|\s)@session(?: ([^\s]*))?$/.exec(before);
  if (sessionEnabled && explicit) {
    const start = position - explicit[0].trimStart().length;
    const tail = /^\S*/.exec(value.slice(position))![0];
    if (explicit[1] !== undefined || tail.length === 0 || /^\s/.test(tail)) {
      return { start, end: position + tail.length, query: explicit[1] ?? '', sessionOnly: true };
    }
  }
  const ordinary = /(?:^|\s)@([^\s]*)$/.exec(before);
  if (!ordinary) return undefined;
  const query = ordinary[1] ?? '';
  const tail = /^\S*/.exec(value.slice(position))![0];
  return {
    start: position - query.length - 1,
    end: position + tail.length,
    query,
    sessionOnly: false
  };
}
