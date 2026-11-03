import type { SessionModelMessage as ModelMessage } from './model-request.js';
import { AgentError } from '../error.js';

import { REQUEST_INLINE_MEDIA_HARD_LIMIT } from '../model/inline-media-budget.js';
import type { SessionRecord } from './record-contract.js';
import { appliedInputRecord } from './deferred-input.js';

const MiB = 1_048_576;
export const INLINE_MEDIA_POLICY = Object.freeze({
  historicalInlineMediaTrigger: 7 * MiB,
  historicalInlineMediaTarget: 5 * MiB,
  requestInlineMediaHardLimit: REQUEST_INLINE_MEDIA_HARD_LIMIT
});

import type {
  InlineMediaCursor,
  InlineMediaState,
  InlineMediaGcCheckpoint
} from './inline-media-contract.js';
export type {
  InlineMediaCursor,
  InlineMediaState,
  InlineMediaGcCheckpoint
} from './inline-media-contract.js';

export interface InlineMediaGcCandidate extends InlineMediaGcCheckpoint {
  /** Apply the proposed eviction to the current visual-window projection. */
  readonly project: (messages: readonly ModelMessage[]) => ModelMessage[];
}

export function parseInlineMediaGc(value: unknown): InlineMediaGcCheckpoint | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as InlineMediaGcCheckpoint;
  const state = parseInlineMediaState(item.state);
  return state?.evictedThrough &&
    state.consideredThrough &&
    Number.isSafeInteger(item.beforeBytes) &&
    item.beforeBytes > 0 &&
    Number.isSafeInteger(item.afterBytes) &&
    item.afterBytes >= 0 &&
    item.afterBytes <= INLINE_MEDIA_POLICY.historicalInlineMediaTarget &&
    item.afterBytes < item.beforeBytes &&
    (item.reason === 'SOFT_LIMIT' || item.reason === 'HARD_LIMIT' || item.reason === 'TEXT_GC') &&
    (item.reason !== 'SOFT_LIMIT' ||
      item.beforeBytes > INLINE_MEDIA_POLICY.historicalInlineMediaTrigger) &&
    (item.reason !== 'TEXT_GC' ||
      item.beforeBytes > INLINE_MEDIA_POLICY.historicalInlineMediaTarget)
    ? { reason: item.reason, state, beforeBytes: item.beforeBytes, afterBytes: item.afterBytes }
    : undefined;
}

export function inlineMediaSource(message: ModelMessage): string | ModelMessage {
  return message.callId !== undefined
    ? `tool:${message.callId}`
    : message.metadata?.recordId !== undefined
      ? `input:${message.metadata.recordId}`
      : message;
}

/** GC may advance only a durable, already-considered source prefix. */
export function inlineMediaGcAnchored(
  records: readonly SessionRecord[],
  media: InlineMediaGcCheckpoint
): boolean {
  const history = inlineMediaHistory(records);
  const positions = new Map<string, { index: number; rollout: number }>();
  const key = (cursor: InlineMediaCursor | undefined) =>
    JSON.stringify([cursor?.sourceId, cursor?.imageIndex]);
  for (const cursor of history.cursors) {
    const identity = key({ sourceId: cursor.sourceId, imageIndex: cursor.imageIndex });
    if (!positions.has(identity))
      positions.set(identity, { index: positions.size, rollout: cursor.rollout });
  }
  const evicted = positions.get(key(media.state.evictedThrough));
  const considered = positions.get(key(media.state.consideredThrough));
  const previous = positions.get(key(history.state?.evictedThrough));
  return (
    evicted !== undefined &&
    considered !== undefined &&
    key(media.state.consideredThrough) === key(history.state?.consideredThrough) &&
    evicted.index <= considered.index &&
    evicted.index > (previous?.index ?? -1) &&
    (media.reason === 'HARD_LIMIT' || history.rollouts - evicted.rollout >= 2)
  );
}

export function parseInlineMediaState(value: unknown): InlineMediaState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const state = value as InlineMediaState;
  const cursor = (value: unknown): value is InlineMediaCursor => {
    if (!value || typeof value !== 'object') return false;
    const item = value as InlineMediaCursor;
    return (
      typeof item.sourceId === 'string' &&
      item.sourceId.length > 0 &&
      item.sourceId.length <= 256 &&
      Number.isSafeInteger(item.imageIndex) &&
      item.imageIndex >= 0
    );
  };
  if (
    state.version !== 1 ||
    (state.consideredThrough !== undefined && !cursor(state.consideredThrough)) ||
    (state.evictedThrough !== undefined && !cursor(state.evictedThrough))
  )
    return undefined;
  return structuredClone(state);
}

/** Recover ordering once at the lifecycle boundary, including GC-omitted sources. */
export function inlineMediaHistory(records: readonly SessionRecord[]): {
  cursors: (InlineMediaCursor & { rollout: number })[];
  rollouts: number;
  state?: InlineMediaState;
} {
  const cursors: (InlineMediaCursor & { rollout: number })[] = [];
  const imageCounts = new Map<string, number>();
  let rollouts = 0;
  let state: InlineMediaState | undefined;
  const present = (cursor: InlineMediaCursor | undefined) =>
    !cursor || cursor.imageIndex < (imageCounts.get(cursor.sourceId) ?? 0);
  const restoreState = (next: InlineMediaState | undefined) => {
    if (!next || (present(next.consideredThrough) && present(next.evictedThrough))) {
      state = next;
      return;
    }
    // Reuse only a proven eviction; record order cannot prove an image was processed.
    const evictedThrough = present(next.evictedThrough)
      ? next.evictedThrough
      : state?.evictedThrough;
    const consideredThrough =
      next.consideredThrough && present(next.consideredThrough)
        ? next.consideredThrough
        : evictedThrough;
    state = {
      version: 1,
      ...(consideredThrough ? { consideredThrough } : {}),
      ...(evictedThrough ? { evictedThrough } : {})
    };
  };
  const add = (sourceId: string | undefined, images: unknown) => {
    if (!sourceId || !Array.isArray(images)) return;
    if (images.length > (imageCounts.get(sourceId) ?? 0)) imageCounts.set(sourceId, images.length);
    for (let imageIndex = 0; imageIndex < images.length; imageIndex++)
      cursors.push({ sourceId, imageIndex, rollout: rollouts });
  };
  for (const record of records) {
    const payload = record.payload as Record<string, unknown>;
    if (!payload || typeof payload !== 'object') continue;
    if (
      record.type === 'model.attempt' &&
      payload.purpose === 'EXECUTION' &&
      payload.state === 'SUCCEEDED'
    )
      rollouts++;
    if (record.type === 'compact.completed') {
      cursors.splice(0);
      imageCounts.clear();
      state = undefined;
      for (const item of (payload.retainedModelContext ?? []) as ModelMessage[]) {
        const applied = appliedInputRecord({ ...record, type: 'model.context', payload: item });
        if (applied) {
          add(`input:${applied.recordId}`, (applied.payload as Record<string, unknown>).images);
          continue;
        }
        const key = inlineMediaSource(item);
        add(typeof key === 'string' ? key : undefined, item.images);
      }
      restoreState(parseInlineMediaState(payload.inlineMediaState));
    } else if (record.type === 'resource.window') {
      restoreState(parseInlineMediaState(payload));
    } else if (record.type === 'context.gc.completed' && payload.inlineMedia !== undefined) {
      const media = parseInlineMediaGc(payload.inlineMedia);
      if (!media)
        throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Inline media GC state is invalid.');
      restoreState(media.state);
    } else if (
      (record.type === 'turn.user' || record.type === 'extension.input') &&
      payload.deferred !== true
    ) {
      add(`input:${record.recordId}`, payload.images);
    } else if (record.type === 'model.context') {
      const applied = appliedInputRecord(record);
      if (applied) {
        add(`input:${applied.recordId}`, (applied.payload as Record<string, unknown>).images);
        continue;
      }
      const key =
        typeof payload.inputRef === 'string'
          ? `input:${payload.inputRef}`
          : typeof payload.callId === 'string'
            ? `tool:${payload.callId}`
            : undefined;
      add(key, payload.images);
    }
  }
  return { cursors, rollouts, ...(state ? { state } : {}) };
}
