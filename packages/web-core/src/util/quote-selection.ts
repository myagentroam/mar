/** Map a native range to rendered text offsets; callers read content from their own model. */
export function selectedTextOffsets(
  root: HTMLElement,
  elements: readonly HTMLElement[]
): readonly { index: number; from: number; to: number }[] {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return [];
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return [];
  return elements.flatMap((element, index) => {
    if (!range.intersectsNode(element)) return [];
    const local = root.ownerDocument.createRange();
    local.selectNodeContents(element);
    const length = local.toString().length;
    let from = 0;
    let to = length;
    if (element.contains(range.startContainer)) {
      local.setEnd(range.startContainer, range.startOffset);
      from = local.toString().length;
    }
    if (element.contains(range.endContainer)) {
      local.selectNodeContents(element);
      local.setEnd(range.endContainer, range.endOffset);
      to = local.toString().length;
    }
    return to > from || length === 0 ? [{ index, from, to }] : [];
  });
}

export interface UnifiedDiffLine {
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly hunk?: boolean;
}

/** Hunk headers are the authority for both sides, including deleted lines and later hunks. */
export function unifiedDiffLines(diff: string): readonly UnifiedDiffLine[] {
  let oldLine: number | undefined;
  let newLine: number | undefined;
  return diff.split('\n').map((text) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { text, hunk: true };
    }
    if (text.startsWith('diff ')) {
      oldLine = newLine = undefined;
    }
    if (oldLine === undefined || newLine === undefined) return { text };
    if (text.startsWith('-')) return { text, oldLine: oldLine++ };
    if (text.startsWith('+')) return { text, newLine: newLine++ };
    if (text.startsWith(' ')) return { text, oldLine: oldLine++, newLine: newLine++ };
    return { text };
  });
}
