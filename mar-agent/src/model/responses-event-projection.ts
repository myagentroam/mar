import { AgentError } from '../error.js';
import type { ModelEvent } from './contracts.js';
import { record, text } from './sse.js';

/** Per-attempt text assembly; provider events may report final phase after text.done. */
export class ResponsesTextProjection {
  readonly #phases = new Map<string, 'commentary' | 'final_answer'>();
  readonly #pending = new Map<string, string>();
  readonly #emitted = new Set<string>();

  *finish(): Iterable<ModelEvent> {
    for (const [itemId, completedText] of this.#pending) {
      if (this.#emitted.has(itemId)) continue;
      this.#emitted.add(itemId);
      yield {
        type: 'text.completed',
        itemId,
        phase: this.#phases.get(itemId) ?? 'final_answer',
        text: completedText
      };
    }
    this.#pending.clear();
  }

  project(
    event: Record<string, unknown>,
    type: string
  ): {
    readonly handled: boolean;
    readonly event?: ModelEvent;
  } {
    if (
      (type === 'response.output_item.added' || type === 'response.output_item.done') &&
      text(record(event.item).type) === 'message'
    ) {
      const item = record(event.item);
      const itemId = text(item.id);
      if (type === 'response.output_item.added') {
        const phase = messagePhase(item.phase);
        if (itemId && phase) this.#phases.set(itemId, phase);
        return { handled: true };
      }
      const id = itemId ?? text(event.item_id) ?? 'text';
      const phase = messagePhase(item.phase) ?? this.#phases.get(id) ?? 'final_answer';
      this.#phases.set(id, phase);
      const completedText = this.#pending.get(id) ?? responseMessageText(item);
      if (completedText === undefined || this.#emitted.has(id)) return { handled: true };
      this.#emitted.add(id);
      this.#pending.delete(id);
      return {
        handled: true,
        event: { type: 'text.completed', itemId: id, phase, text: completedText }
      };
    }
    if (type === 'response.output_text.delta')
      return {
        handled: true,
        event: {
          type: 'text.delta',
          itemId: text(event.item_id) ?? 'text',
          phase:
            messagePhase(event.phase) ??
            this.#phases.get(text(event.item_id) ?? '') ??
            'commentary',
          delta: text(event.delta) ?? ''
        }
      };
    if (type === 'response.output_text.done') {
      const itemId = text(event.item_id) ?? 'text';
      const completedText = text(event.text) ?? '';
      const phase = messagePhase(event.phase) ?? this.#phases.get(itemId);
      if (this.#emitted.has(itemId)) return { handled: true };
      if (!phase) {
        this.#pending.set(itemId, completedText);
        return { handled: true };
      }
      this.#emitted.add(itemId);
      return {
        handled: true,
        event: { type: 'text.completed', itemId, phase, text: completedText }
      };
    }
    return { handled: false };
  }
}

function messagePhase(value: unknown): 'commentary' | 'final_answer' | undefined {
  return value === 'commentary' || value === 'final_answer' ? value : undefined;
}

function responseMessageText(item: Record<string, unknown>): string | undefined {
  const content = Array.isArray(item.content) ? item.content : [];
  const parts = content
    .map(record)
    .filter((part) => text(part.type) === 'output_text')
    .map((part) => text(part.text) ?? '');
  return parts.length ? parts.join('') : undefined;
}

const RESPONSE_ITEM_TYPES = new Set([
  'message',
  'reasoning',
  'function_call',
  'custom_tool_call',
  'tool_search_call',
  'tool_search_output',
  'web_search_call'
]);
// A freeform patch item can contain the complete 4 MiB patch plus its JSON envelope.
const MAX_RESPONSE_ITEM_BYTES = 5 * 1024 * 1024;

export function hostedWebActionInput(action: Record<string, unknown>): {
  input: Record<string, unknown>;
  truncated: boolean;
} {
  const input: Record<string, unknown> = {};
  let truncated = false;
  for (const [key, limit] of [
    ['type', 128],
    ['query', 10_000],
    ['url', 2_048],
    ['pattern', 10_000]
  ] as const) {
    const value = action[key];
    if (typeof value !== 'string') continue;
    input[key] = value.slice(0, limit);
    truncated ||= value.length > limit;
  }
  if (Array.isArray(action.queries)) {
    const queries = action.queries.filter((value): value is string => typeof value === 'string');
    input.queries = queries.slice(0, 10).map((value) => value.slice(0, 10_000));
    truncated ||=
      queries.length > 10 || queries.slice(0, 10).some((value) => value.length > 10_000);
  }
  return { input, truncated };
}

export function hostedWebActionSummary(
  action: Record<string, unknown>
): Extract<ModelEvent, { type: 'hosted_tool' }>['summary'] {
  const queries = Array.isArray(action.queries)
    ? action.queries
        .slice(0, 10)
        .filter((query): query is string => typeof query === 'string' && query.length > 0)
    : [];
  const query = text(action.query) || queries.join('\n');
  const url = text(action.url);
  const title = text(action.title);
  const sources = Array.isArray(action.sources)
    ? action.sources
        .slice(0, 20)
        .map((source) => {
          const value = record(source);
          const sourceUrl = text(value.url);
          if (!sourceUrl) return undefined;
          const sourceTitle = text(value.title);
          const snippet = text(value.snippet);
          return {
            url: sourceUrl.slice(0, 2048),
            ...(sourceTitle ? { title: sourceTitle.slice(0, 256) } : {}),
            ...(snippet ? { snippet: snippet.slice(0, 2000) } : {})
          };
        })
        .filter((source): source is NonNullable<typeof source> => source !== undefined)
    : [];
  return {
    ...(query ? { query: query.slice(0, 10_000) } : {}),
    ...(url ? { url: url.slice(0, 2048) } : {}),
    ...(title ? { title: title.slice(0, 256) } : {}),
    ...(Array.isArray(action.sources) ? { sources } : {}),
    ...(Array.isArray(action.sources) && action.sources.length > 20
      ? { sourcesTruncated: true }
      : {})
  };
}

export function responseItem(value: unknown): Record<string, unknown> | undefined {
  const item = record(value);
  const itemType = text(item.type);
  if (!itemType || !RESPONSE_ITEM_TYPES.has(itemType)) return undefined;
  const serialized = JSON.stringify(item);
  if (Buffer.byteLength(serialized) > MAX_RESPONSE_ITEM_BYTES)
    throw new AgentError(
      'MAR_AGENT_MODEL_PROTOCOL_ERROR',
      'Responses output item exceeds the context record limit.'
    );
  return JSON.parse(serialized) as Record<string, unknown>;
}

export function responseCitations(response: Record<string, unknown>) {
  const citations = new Map<string, { id: string; url: string; title?: string }>();
  for (const output of Array.isArray(response.output) ? response.output : []) {
    const item = record(output);
    for (const content of Array.isArray(item.content) ? item.content : []) {
      const part = record(content);
      for (const value of Array.isArray(part.annotations) ? part.annotations : []) {
        const annotation = record(value);
        const url = text(annotation.url);
        if (!url) continue;
        const id = text(annotation.id) ?? `${text(item.id) ?? 'text'}-${citations.size}`;
        const title = text(annotation.title);
        citations.set(`${id}:${url}`, {
          id,
          url,
          ...(title ? { title } : {})
        });
      }
    }
  }
  return [...citations.values()];
}

export function responseEventId(event: Record<string, unknown>): string | undefined {
  return text(record(event.response).id);
}
