import { AgentError } from '../error.js';
import type { SessionModelMessage } from '../session/model-request.js';
import type { SessionRecord } from '../session/record-contract.js';
import type { SessionStore, SessionStoreCompactInput } from '../session/store/contracts.js';
import type { ResourceInputProjection } from './resource-input.js';

/** Commits one validated snapshot and records its fact before fallible live projection. */
export async function commitExecutionCompaction(input: {
  readonly store: Pick<SessionStore, 'compact'>;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly prefix: readonly SessionModelMessage[];
  readonly messages: readonly SessionModelMessage[];
  readonly generation: string | undefined;
  readonly messageSources: WeakMap<SessionModelMessage, SessionRecord>;
  draft(): Omit<SessionStoreCompactInput, 'retainedModelContext' | 'inlineMediaState'>;
  readonly checkpoint: ResourceInputProjection['checkpoint'];
  readonly withProjection: <T>(action: () => Promise<T>) => Promise<T>;
  readonly currentGeneration: () => string | undefined;
  readonly recordCommit: (recordId: string) => void;
  readonly replace: (retained: SessionModelMessage[]) => void;
}) {
  return input.withProjection(async () => {
    input.signal.throwIfAborted();
    if (
      input.currentGeneration() !== input.generation ||
      input.prefix.some((message, index) => input.messages[index] !== message)
    )
      throw new AgentError('MAR_AGENT_COMPACT_STALE', 'The compaction prefix has changed.');
    const retained = input.messages
      .slice(input.prefix.length)
      .filter((message) => message.contextKind !== 'private' || message.role === 'provider');
    const retainedModelContext = retained.map((message) => {
      const source = input.messageSources.get(message);
      const saved =
        source?.type === 'model.context' && (source.payload as Record<string, unknown>).inputRef
          ? source.payload
          : source?.type === 'compact.completed'
            ? (
                (source.payload as { retainedModelContext?: Record<string, unknown>[] })
                  .retainedModelContext ?? []
              ).find((item) => item.inputRef === message.metadata?.recordId)
            : undefined;
      return saved
        ? {
            ...(saved as { role: 'user'; content: string }),
            ...(message.metadata ? { metadata: message.metadata } : {})
          }
        : {
            ...message,
            ...(message.images?.length
              ? { images: message.images.map(({ dataBase64: _bytes, ...image }) => image) }
              : {})
          };
    });
    const record = await input.store.compact(
      input.sessionId,
      {
        ...input.draft(),
        inlineMediaState: input.checkpoint(retained),
        retainedModelContext
      },
      { signal: input.signal }
    );
    input.recordCommit(record.recordId);
    input.replace(retained);
    return { record, retained };
  });
}
