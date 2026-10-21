import { createHash } from 'node:crypto';
import { composerVisibleText, type PromptCompletionContext } from '@myagentroam/protocol';
import type { NodeConversationTurn } from '../runtime-model.js';
import type { CompletionHistoryMessage, CompletionReference } from './prompt-completion-cache.js';

export interface CompletionContextProjection {
  readonly attention?: string;
  readonly identity: PromptCompletionContext;
  readonly history: readonly CompletionHistoryMessage[];
  readonly references: readonly CompletionReference[];
  readonly executionSnapshot: string;
}

/** Consumes normalized conversation facts; never parses vendor logs or raw tool payloads. */
export function projectCompletionContext(
  turns: readonly NodeConversationTurn[],
  historyGeneration: string
): CompletionContextProjection {
  const history: CompletionHistoryMessage[] = [];
  const references: CompletionReference[] = [];
  const seen = new Set<string>();
  const semantic: unknown[] = [];
  const tools: { category: string; status: string }[] = [];
  const waiting: { kind: string; status: string }[] = [];
  const partial: string[] = [];
  let progressRevision = 0;
  for (const turn of turns.slice(-12)) {
    semantic.push([turn.id, turn.runId, turn.status]);
    for (const item of turn.items.slice(-128)) {
      progressRevision += item.revision;
      const payload = record(item.payload);
      if (item.kind === 'user_message') {
        // Missing delivery is permitted only because the canonical history reader owns it.
        if (
          payload.source !== undefined ||
          (payload.delivery !== undefined &&
            payload.delivery !== 'ACCEPTED' &&
            payload.delivery !== 'STEERED')
        )
          continue;
        const text = typeof payload.text === 'string' ? composerVisibleText(payload.text) : '';
        const id = typeof payload.clientMessageId === 'string' ? payload.clientMessageId : item.id;
        if (!text.trim() || seen.has(id)) continue;
        seen.add(id);
        const bounded = clip(text, 4_096);
        history.push({ id, revision: item.revision, role: 'user', text: bounded });
        references.push({ sessionId: item.sessionId, id, revision: item.revision, text: bounded });
        semantic.push([id, item.revision, bounded]);
      } else if (item.kind === 'assistant_message' && typeof payload.text === 'string') {
        if (item.status === 'COMPLETED') {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          const text = clip(payload.text, 4_096);
          history.push({ id: item.id, revision: item.revision, role: 'assistant', text });
          semantic.push([item.id, item.revision, text]);
        } else if (item.status === 'IN_PROGRESS' && turn.id === turns.at(-1)?.id)
          partial.push(clip(payload.text, 1_024));
      } else if (['approval', 'user_input_request'].includes(item.kind)) {
        semantic.push([item.id, item.revision, item.status]);
        if (
          turn.id === turns.at(-1)?.id &&
          (item.status === 'PENDING' || item.status === 'IN_PROGRESS')
        )
          waiting.push({ kind: item.kind, status: item.status });
      } else if (['tool_call', 'command_execution', 'file_change'].includes(item.kind)) {
        // Tool names, arguments, titles, paths, output and error bodies are not copied.
        if (turn.id === turns.at(-1)?.id) tools.push({ category: item.kind, status: item.status });
      }
    }
  }
  const contextVersion = createHash('sha256')
    .update(JSON.stringify([historyGeneration, semantic]))
    .digest('hex');
  return {
    identity: { historyGeneration, contextVersion, progressRevision },
    history: history.slice(-64),
    references: references.slice(-20),
    executionSnapshot: JSON.stringify({
      status: turns.at(-1)?.status ?? 'IDLE',
      tools: tools.slice(-6),
      waiting: waiting.slice(-6),
      partialAssistant: partial.slice(-3)
    })
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 32) / 2);
  const head = text.slice(0, half).replace(/[\uD800-\uDBFF]$/u, '');
  const tail = text.slice(-half).replace(/^[\uDC00-\uDFFF]/u, '');
  return `${head}\n[excerpt omitted]\n${tail}`;
}
