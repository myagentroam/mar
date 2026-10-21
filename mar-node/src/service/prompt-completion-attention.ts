import { isAbsolute, win32 } from 'node:path';
import type { PromptCompletionAttention } from '@myagentroam/protocol';

/** Browser observations are hints, not authority to read paths or execute instructions. */
export async function projectPredictionAttention(
  events: readonly PromptCompletionAttention[],
  read: (event: PromptCompletionAttention) => Promise<unknown>,
  signal: AbortSignal,
  now = Date.now()
): Promise<string> {
  const result: unknown[] = [];
  let remaining = 4096;
  for (const event of events.slice(-20).reverse()) {
    signal.throwIfAborted();
    if (
      event.observedAt > now ||
      now - event.observedAt >= 180_000 ||
      isAbsolute(event.path) ||
      win32.isAbsolute(event.path) ||
      event.path.split(/[\\/]/u).includes('..') ||
      event.path.includes('\0') ||
      event.path.startsWith('mar-attachment:')
    )
      continue;
    const metadata = {
      kind: event.kind,
      path: event.path,
      worktreePath: event.worktreePath,
      source: event.source,
      observedAt: event.observedAt
    };
    // Diff blocks without a verified content identity are metadata-only, never read in full.
    if (event.kind === 'DIFF' || !event.revision || event.startLine === undefined) {
      result.push(metadata);
      if (result.length >= 8) break;
      continue;
    }
    try {
      const value = (await read(event)) as {
        content?: string;
        revision?: string;
        encoding?: string;
        truncated?: boolean;
      };
      signal.throwIfAborted();
      if (
        value.revision !== event.revision ||
        value.encoding !== 'utf-8' ||
        typeof value.content !== 'string'
      )
        continue;
      const lines = value.content.split('\n');
      // A bounded prefix can end mid-line. Never present that tail as a verified full line.
      if (value.truncated) lines.pop();
      const endLine = Math.min(event.endLine!, event.startLine + 79, lines.length);
      if (event.startLine > endLine) continue;
      const text = lines
        .slice(event.startLine - 1, endLine)
        .join('\n')
        .slice(0, Math.min(2048, remaining));
      remaining -= text.length;
      result.push({
        ...metadata,
        revision: value.revision,
        startLine: event.startLine,
        endLine,
        text
      });
    } catch (error) {
      if (signal.aborted) throw error;
      // Missing, moved, changed, binary or inaccessible optional references are omitted.
    }
    if (result.length >= 8 || remaining <= 0) break;
  }
  return JSON.stringify(result);
}
