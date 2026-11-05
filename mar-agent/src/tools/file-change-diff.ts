/** Bounded line comparison for immutable, per-operation file evidence. */
export interface FileDiff {
  text: string;
  additions: number;
  deletions: number;
}
type Edit = { kind: ' ' | '+' | '-'; text: string };
const MAX_WORK = 2_000_000;
export const MAX_FILE_DIFF_BYTES = 16 * 1024 * 1024;
export class FileDiffLimitError extends Error {}

export function createFileDiff(
  path: string,
  before?: Buffer,
  after?: Buffer
): FileDiff | undefined {
  let oldText: string;
  let newText: string;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    oldText = decoder.decode(before ?? Buffer.alloc(0));
    newText = decoder.decode(after ?? Buffer.alloc(0));
  } catch {
    return undefined;
  }
  if (oldText.includes('\0') || newText.includes('\0')) return undefined;
  const lines = (value: string) => value.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const a = lines(oldText);
  const b = lines(newText);
  if (a.length + b.length > 200_000) throw new FileDiffLimitError();
  const edits = compare(a, b);
  if (!edits) throw new FileDiffLimitError();
  const output = [
    `--- ${before === undefined ? '/dev/null' : JSON.stringify(`a/${path}`)}`,
    `+++ ${after === undefined ? '/dev/null' : JSON.stringify(`b/${path}`)}`
  ];
  const positions: Array<{ old: number; next: number }> = [];
  const ranges: Array<{ start: number; end: number }> = [];
  let old = 1;
  let next = 1;
  let additions = 0;
  let deletions = 0;
  edits.forEach((edit, index) => {
    positions.push({ old, next });
    if (edit.kind !== '+') old++;
    if (edit.kind !== '-') next++;
    if (edit.kind === '+') additions++;
    if (edit.kind === '-') deletions++;
    if (edit.kind === ' ') return;
    const start = Math.max(0, index - 3);
    const end = Math.min(edits.length, index + 4);
    const last = ranges.at(-1);
    if (last && start <= last.end) last.end = end;
    else ranges.push({ start, end });
  });
  for (const range of ranges) {
    const block = edits.slice(range.start, range.end);
    const oldCount = block.filter((edit) => edit.kind !== '+').length;
    const newCount = block.filter((edit) => edit.kind !== '-').length;
    const position = positions[range.start]!;
    output.push(
      `@@ -${position.old - (oldCount === 0 ? 1 : 0)},${oldCount} +${position.next - (newCount === 0 ? 1 : 0)},${newCount} @@`
    );
    for (const edit of block) {
      output.push(`${edit.kind}${edit.text.endsWith('\n') ? edit.text.slice(0, -1) : edit.text}`);
      if (!edit.text.endsWith('\n')) output.push('\\ No newline at end of file');
    }
  }
  const text = `${output.join('\n')}\n`;
  if (Buffer.byteLength(text) > MAX_FILE_DIFF_BYTES) throw new FileDiffLimitError();
  return { text, additions, deletions };
}

function compare(a: string[], b: string[]): Edit[] | undefined {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - suffix - 1] === b[b.length - suffix - 1]
  )
    suffix++;
  const left = a.slice(prefix, a.length - suffix);
  const right = b.slice(prefix, b.length - suffix);
  if (!left.length || !right.length)
    return [
      ...a.slice(0, prefix).map((text): Edit => ({ kind: ' ', text })),
      ...left.map((text): Edit => ({ kind: '-', text })),
      ...right.map((text): Edit => ({ kind: '+', text })),
      ...a.slice(a.length - suffix).map((text): Edit => ({ kind: ' ', text }))
    ];
  const trace: Map<number, number>[] = [];
  const frontier = new Map<number, number>([[1, 0]]);
  let work = 0;
  for (let distance = 0; distance <= left.length + right.length; distance++) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (++work > MAX_WORK) return undefined;
      const down =
        diagonal === -distance ||
        (diagonal !== distance &&
          (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1));
      let x = down ? (frontier.get(diagonal + 1) ?? 0) : (frontier.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < left.length && y < right.length && left[x] === right[y]) {
        if (++work > MAX_WORK) return undefined;
        x++;
        y++;
      }
      frontier.set(diagonal, x);
      if (x < left.length || y < right.length) continue;
      const reversed: Edit[] = [];
      for (let d = distance; d >= 0; d--) {
        const previous = trace[d]!;
        const k = x - y;
        const previousK =
          k === -d || (k !== d && (previous.get(k - 1) ?? -1) < (previous.get(k + 1) ?? -1))
            ? k + 1
            : k - 1;
        const previousX = previous.get(previousK) ?? 0;
        const previousY = previousX - previousK;
        while (x > previousX && y > previousY) {
          reversed.push({ kind: ' ', text: left[--x]! });
          y--;
        }
        if (d === 0) break;
        if (x === previousX) reversed.push({ kind: '+', text: right[--y]! });
        else reversed.push({ kind: '-', text: left[--x]! });
      }
      return [
        ...a.slice(0, prefix).map((text): Edit => ({ kind: ' ', text })),
        ...reversed.reverse(),
        ...a.slice(a.length - suffix).map((text): Edit => ({ kind: ' ', text }))
      ];
    }
  }
  return undefined;
}
