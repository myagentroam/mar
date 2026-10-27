import type { SessionModelMessage as ModelMessage } from '../session/model-request.js';
import { AgentError } from '../error.js';

import type { ExtensionModelMessage } from './model-request.js';
import { ExtensionRequestBridge } from './model-request.js';

export interface ExtensionSessionMessagesInput {
  readonly view?: 'model' | 'conversation' | 'request';
  readonly agentId?: string;
  readonly includeImages?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

/** Read-only persisted context, not additional writable model-request fields. */
export type ExtensionSessionMessage =
  | Extract<ExtensionModelMessage, { readonly role: 'opaque' }>
  | (Exclude<ExtensionModelMessage, { readonly role: 'opaque' }> & {
      readonly contextKind?: 'environment';
      readonly inputMode?: ModelMessage['inputMode'];
      readonly calls?: ModelMessage['calls'];
      readonly observations?: ModelMessage['observations'];
      readonly toolSearchTools?: ModelMessage['toolSearchTools'];
      readonly toolOutcome?: { readonly isError: boolean; readonly result?: unknown };
      readonly modelIsError?: boolean;
    });

export interface ExtensionSessionMessages {
  readonly messages: readonly ExtensionSessionMessage[];
  readonly nextCursor?: string;
}

export function normalizeSessionMessagesInput(input: ExtensionSessionMessagesInput) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    (input.view !== undefined &&
      input.view !== 'model' &&
      input.view !== 'conversation' &&
      input.view !== 'request') ||
    (input.agentId !== undefined && (typeof input.agentId !== 'string' || !input.agentId)) ||
    (input.includeImages !== undefined && typeof input.includeImages !== 'boolean') ||
    (input.limit !== undefined && typeof input.limit !== 'number') ||
    (input.cursor !== undefined && typeof input.cursor !== 'string')
  )
    throw invalidInput();
  const cursor = input.cursor === undefined ? 0 : Number(input.cursor);
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit <= 0)
    throw invalidInput();
  return Object.freeze({
    view: input.view ?? 'model',
    agentId: input.agentId,
    includeImages: input.includeImages ?? false,
    cursor,
    limit
  });
}

export function sessionMessagesPage(
  messages: readonly ModelMessage[],
  input: ReturnType<typeof normalizeSessionMessagesInput>,
  outcomes?: WeakMap<ModelMessage, { readonly isError: boolean; readonly result?: unknown }>
): ExtensionSessionMessages {
  const selected =
    input.view === 'conversation'
      ? messages.filter(
          (message) =>
            message.role !== 'provider' &&
            message.contextKind !== 'environment' &&
            message.contextKind !== 'private'
        )
      : messages;
  // A private non-Provider record receives the same opaque treatment as Provider context.
  const neutral = selected.map((message): ModelMessage =>
    message.contextKind === 'private' ? { role: 'provider', content: '' } : message
  );
  const view = new ExtensionRequestBridge('', { system: '', messages: neutral, tools: [] }).view
    .messages;
  const enriched = view.map((message, index): ExtensionSessionMessage => {
    if (message.role === 'opaque') return message;
    const original = selected[index]!;
    const { images, ...text } = message;
    return {
      ...text,
      ...(input.includeImages && images !== undefined ? { images } : {}),
      ...(original.contextKind === 'environment' ? { contextKind: 'environment' as const } : {}),
      ...(original.inputMode !== undefined ? { inputMode: original.inputMode } : {}),
      ...(original.isError === undefined ? {} : { modelIsError: original.isError }),
      ...(outcomes?.has(original) ? { toolOutcome: structuredClone(outcomes.get(original)!) } : {}),
      ...(original.calls !== undefined ? { calls: structuredClone(original.calls) } : {}),
      ...(original.observations !== undefined
        ? { observations: structuredClone(original.observations) }
        : {}),
      ...(original.toolSearchTools !== undefined
        ? { toolSearchTools: structuredClone(original.toolSearchTools) }
        : {})
    };
  });
  return freeze({
    messages: enriched.slice(input.cursor, input.cursor + input.limit),
    ...(input.cursor + input.limit < enriched.length
      ? { nextCursor: String(input.cursor + input.limit) }
      : {})
  });
}

function invalidInput() {
  return new AgentError(
    'MAR_AGENT_SESSION_INPUT_INVALID',
    'Message view, target, media selection, cursor or limit is invalid.'
  );
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
