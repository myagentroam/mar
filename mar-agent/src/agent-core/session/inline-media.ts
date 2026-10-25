import { MarAgentError } from '../error.js';
import type { ModelMessage, ModelRequest } from '../model/contracts.js';
import type { ModelImage } from '../model/image.js';
import type { SessionRecord } from './store/types.js';
import { appliedInputRecord } from './deferred-input.js';

const MiB = 1_048_576;
export const INLINE_MEDIA_POLICY = Object.freeze({
  historicalInlineMediaTrigger: 7 * MiB,
  historicalInlineMediaTarget: 5 * MiB,
  requestInlineMediaHardLimit: 12 * MiB
});

export interface InlineMediaCursor {
  sourceId: string;
  imageIndex: number;
}

/** Processing progress, not evidence that the provider inspected an image. */
export interface InlineMediaState {
  version: 1;
  consideredThrough?: InlineMediaCursor;
  evictedThrough?: InlineMediaCursor;
}

export interface InlineMediaGcCheckpoint {
  readonly reason: 'SOFT_LIMIT' | 'HARD_LIMIT' | 'TEXT_GC';
  readonly state: InlineMediaState;
  readonly beforeBytes: number;
  readonly afterBytes: number;
}

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

export function inlineMediaBytes(image: ModelImage): number {
  const bytes =
    image.dataBase64 !== undefined
      ? image.dataBase64.length
      : image.byteSize !== undefined
        ? 4 * Math.ceil(image.byteSize / 3)
        : undefined;
  if (bytes === undefined)
    throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Resource size is unavailable.');
  return bytes + Buffer.byteLength(`data:${image.mimeType};base64,`);
}

export function inlineMediaLimit(): never {
  throw new MarAgentError(
    'MAR_AGENT_INLINE_MEDIA_LIMIT',
    'Inline images exceed the 12 MiB request limit. Reduce this image batch or use view_image with resize or region before retrying.'
  );
}

/** Final encoding guard; URL-only images do not consume the inline budget. */
export function assertInlineMediaBudget(request: Pick<ModelRequest, 'messages' | 'images'>): void {
  let total = 0;
  for (const message of request.messages)
    for (const image of message.images ?? [])
      if (image.dataBase64 !== undefined) total += inlineMediaBytes(image);
  for (const image of request.images ?? [])
    if (image.dataBase64 !== undefined) total += inlineMediaBytes(image);
  if (total > INLINE_MEDIA_POLICY.requestInlineMediaHardLimit) inlineMediaLimit();
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
  let rollouts = 0;
  let state: InlineMediaState | undefined;
  const add = (sourceId: string | undefined, images: unknown) => {
    if (!sourceId || !Array.isArray(images)) return;
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
      state = parseInlineMediaState(payload.inlineMediaState);
      for (const item of (payload.retainedModelContext ?? []) as ModelMessage[]) {
        const applied = appliedInputRecord({ ...record, type: 'model.context', payload: item });
        if (applied) {
          add(`input:${applied.recordId}`, (applied.payload as Record<string, unknown>).images);
          continue;
        }
        const key = inlineMediaSource(item);
        add(typeof key === 'string' ? key : undefined, item.images);
      }
    } else if (record.type === 'resource.window') {
      state = parseInlineMediaState(payload);
    } else if (record.type === 'context.gc.completed' && payload.inlineMedia !== undefined) {
      const media = parseInlineMediaGc(payload.inlineMedia);
      if (!media)
        throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Inline media GC state is invalid.');
      state = media.state;
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
