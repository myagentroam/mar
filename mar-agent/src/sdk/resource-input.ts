import { inlineMediaBytes, inlineMediaLimit } from '../model/inline-media-budget.js';
import type { SessionModelMessage as ModelMessage } from '../session/model-request.js';
import type { SessionModelRequest as ModelRequest } from '../session/model-request.js';
import { isDeepStrictEqual } from 'node:util';
import { AgentError } from '../error.js';

import { isModelImageUrl, type ModelImage } from '../model/image.js';
import type { SessionStore } from '../session/store/contracts.js';
import type { SessionRecord } from '../session/record-contract.js';
import {
  observationImages,
  renderObservationResult,
  selectObservationImages
} from '../session/code-observation-projection.js';
import {
  INLINE_MEDIA_POLICY as policy,
  inlineMediaHistory,
  inlineMediaSource,
  type InlineMediaCursor,
  type InlineMediaGcCandidate,
  type InlineMediaState
} from '../session/inline-media.js';

type Source = ReturnType<typeof inlineMediaSource>;
interface Entry {
  source: Source;
  imageIndex: number;
  image?: ModelImage;
  unavailable?: boolean;
  active: boolean;
  rollout: number;
}
interface Options {
  records?: readonly SessionRecord[];
  persist?: (state: InlineMediaState) => Promise<void>;
}

function releasedImageNotice(
  message: ModelMessage,
  indices: readonly number[],
  unavailable?: ReadonlySet<number>
): string {
  return indices
    .map((index) => {
      if (unavailable?.has(index)) return 'Image unavailable; omitted from context.';
      const resourceId = message.images?.[index]?.resourceId;
      const hint = resourceId
        ? ` Reopen with view_image(${JSON.stringify({ resourceId })}) if needed.`
        : '';
      return `<mar_context_gc kind="image">Image released.${hint}</mar_context_gc>`;
    })
    .join('\n');
}

function projectRetainedImages(
  message: ModelMessage,
  images: ModelImage[],
  removed: ReadonlySet<number>,
  unavailable?: ReadonlySet<number>
): ModelMessage {
  if (!removed.size) return { ...message, images };
  if (message.observations) {
    const observations = message.observations.map((observation) => {
      const removedIndices = observationImages(observation).filter((index) => removed.has(index));
      if (!removedIndices.length) return observation;
      const notice = releasedImageNotice(message, removedIndices, unavailable);
      return observation.type === 'tool_result'
        ? {
            ...observation,
            result: { ...observation.result, content: `${observation.result.content}\n${notice}` }
          }
        : { ...observation, value: `${observation.value}\n${notice}` };
    });
    const selected = selectObservationImages(observations, images);
    return {
      ...message,
      ...selected,
      content: renderObservationResult(selected.observations, message.content)
    };
  }
  const notice = releasedImageNotice(message, [...removed], unavailable);
  return {
    ...message,
    images: images.filter(Boolean),
    content: `${message.content}\n${notice}`,
    ...(message.textBlocks ? { textBlocks: [...message.textBlocks, { text: notice }] } : {})
  };
}

/** SDK-owned ordered visual window; durable image references are never rewritten. */
export class ResourceInputProjection {
  readonly #entries: Entry[] = [];
  readonly #sources = new Map<Source, number[]>();
  readonly #candidates = new WeakMap<readonly ModelMessage[], number>();
  readonly #resourceReads = new Map<string, ReturnType<SessionStore['readResource']>>();
  #cachedBytes = 0;
  #considered = -1;
  #rollout = 0;
  #evicted = -1;

  constructor(
    private readonly useResourceUrl: boolean,
    private readonly store: Pick<SessionStore, 'readResource'>,
    private readonly sessionId: string,
    history: readonly ModelMessage[],
    private readonly options: Options = {}
  ) {
    const restored = inlineMediaHistory(options.records ?? []);
    this.#rollout = restored.rollouts;
    for (const cursor of restored.cursors)
      this.#entries[this.#entry(cursor.sourceId, cursor.imageIndex)]!.rollout = cursor.rollout;
    this.observe(history);
    if (restored.state) {
      this.#considered = this.#position(restored.state.consideredThrough);
      this.#evicted = this.#position(restored.state.evictedThrough);
    } else if (options.records === undefined) this.#considered = this.#entries.length - 1;
  }

  #entry(source: Source, imageIndex: number): number {
    let positions = this.#sources.get(source);
    if (!positions) this.#sources.set(source, (positions = []));
    let position = positions[imageIndex];
    if (position === undefined) {
      position = this.#entries.length;
      positions[imageIndex] = position;
      this.#entries.push({ source, imageIndex, active: false, rollout: this.#rollout });
    }
    return position;
  }

  #position(cursor: InlineMediaCursor | undefined): number {
    if (!cursor) return -1;
    const position = this.#sources.get(cursor.sourceId)?.[cursor.imageIndex];
    if (position === undefined)
      throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Inline media boundary is missing.');
    return position;
  }

  observe(messages: readonly ModelMessage[]): void {
    for (const message of messages)
      for (const [index, image] of (message.images ?? []).entries()) {
        const entry = this.#entries[this.#entry(inlineMediaSource(message), index)]!;
        if (entry.image && !isDeepStrictEqual(entry.image, image)) delete entry.unavailable;
        entry.image = image;
        entry.active = true;
      }
  }

  /** Called only at an explicit context replacement, never as a history diff detector. */
  replace(messages: readonly ModelMessage[]): void {
    this.releaseBytes();
    for (const entry of this.#entries) {
      entry.active = false;
      delete entry.image;
    }
    this.observe(messages);
  }

  hasPendingImages(messages: readonly ModelMessage[]): boolean {
    return messages.some((message) =>
      (message.images ?? []).some((_, index) => {
        const position = this.#sources.get(inlineMediaSource(message))?.[index];
        return position === undefined || position > this.#considered;
      })
    );
  }

  /** Reference-only view shared by GC; no byte loading or new eviction decisions. */
  historyView(messages: readonly ModelMessage[]): ModelMessage[] {
    return this.#historyView(messages, this.#evicted);
  }

  #historyView(
    messages: readonly ModelMessage[],
    evicted: number,
    fromEvicted = -1
  ): ModelMessage[] {
    return messages.map((message) => {
      const positions = this.#sources
        .get(inlineMediaSource(message))
        ?.filter((position) => position > fromEvicted);
      const images =
        message.images ??
        positions?.flatMap((position) => {
          const entry = this.#entries[position]!;
          return entry.active && entry.image ? [entry.image] : [];
        });
      if (!images?.length) return message;
      const removed = new Set<number>();
      const unavailable = new Set<number>();
      const retained: ModelImage[] = [];
      images.forEach((image, index) => {
        const position = positions?.[index];
        const entry = position === undefined ? undefined : this.#entries[position];
        if (entry?.unavailable && isDeepStrictEqual(entry.image, image)) {
          removed.add(index);
          unavailable.add(index);
        } else if (
          !this.useResourceUrl &&
          positions?.[index] !== undefined &&
          positions[index]! <= evicted
        )
          removed.add(index);
        else retained[index] = image;
      });
      return projectRetainedImages({ ...message, images }, retained, removed, unavailable);
    });
  }

  checkpoint(messages?: readonly ModelMessage[]): InlineMediaState {
    const retained = messages && new Set(messages.map(inlineMediaSource));
    const cursor = (through: number): InlineMediaCursor | undefined => {
      for (let index = through; index >= 0; index--) {
        const entry = this.#entries[index]!;
        if (typeof entry.source === 'string' && (!retained || retained.has(entry.source)))
          return { sourceId: entry.source, imageIndex: entry.imageIndex };
      }
      return undefined;
    };
    const consideredThrough = cursor(this.#considered);
    const evictedThrough = cursor(this.#evicted);
    return {
      version: 1,
      ...(consideredThrough ? { consideredThrough } : {}),
      ...(evictedThrough ? { evictedThrough } : {})
    };
  }

  async prepare(
    request: ModelRequest,
    mirroredImages: readonly ModelImage[] = [],
    canonicalMessages: readonly ModelMessage[] = request.messages
  ): Promise<ModelRequest> {
    this.observe(canonicalMessages);
    const through = this.#entries.length - 1;
    const cached = new Map<Entry | ModelImage, Promise<ModelImage | undefined>>();
    const project = (image: ModelImage, entry?: Entry) => {
      const key = entry && isDeepStrictEqual(entry.image, image) ? entry : image;
      let value = cached.get(key);
      if (!value) cached.set(key, (value = this.#project(image, entry)));
      return value;
    };
    const top = (request.images ?? []).filter(
      (image) => !mirroredImages.some((mirror) => isDeepStrictEqual(image, mirror))
    );
    const evicted = this.#evicted;
    const messages = await Promise.all(
      request.messages.map(async (message) => {
        if (!message.images?.length) return message;
        const removed = new Set<number>();
        const unavailable = new Set<number>();
        const images: ModelImage[] = [];
        await Promise.all(
          message.images.map(async (image, index) => {
            const position = this.#sources.get(inlineMediaSource(message))?.[index];
            const entry = position === undefined ? undefined : this.#entries[position];
            const original = entry?.image;
            if (
              !this.useResourceUrl &&
              position !== undefined &&
              position <= evicted &&
              isDeepStrictEqual(original, image)
            )
              removed.add(index);
            else {
              const projected = await project(image, entry);
              if (projected) images[index] = projected;
              else {
                removed.add(index);
                unavailable.add(index);
              }
            }
          })
        );
        return projectRetainedImages(message, images, removed, unavailable);
      })
    );
    const { images: _topImages, ...retained } = request;
    const images = (await Promise.all(top.map((image) => project(image)))).filter(
      (image): image is ModelImage => image !== undefined
    );
    const result = { ...retained, messages, ...(images.length ? { images } : {}) };
    this.#candidates.set(result.messages, through);
    return result;
  }

  async complete(request: ModelRequest): Promise<void> {
    const candidate = this.#candidates.get(request.messages);
    if (candidate === undefined) return;
    this.#candidates.delete(request.messages);
    this.#rollout++;
    const considered = Math.max(this.#considered, candidate);
    if (considered === this.#considered) return;
    const before = this.#considered;
    this.#considered = considered;
    try {
      await this.options.persist?.(this.checkpoint());
    } catch (error) {
      this.#considered = before;
      this.#rollout--;
      throw error;
    }
  }

  /** Propose a cursor; only the unified GC checkpoint may adopt it. */
  async gcCandidate(
    request?: ModelRequest,
    mirroredImages: readonly ModelImage[] = []
  ): Promise<InlineMediaGcCandidate | undefined> {
    if (this.useResourceUrl) return undefined;
    const size = async (image: ModelImage, entry?: Entry) => {
      if (entry?.unavailable && isDeepStrictEqual(entry.image, image)) return 0;
      const sized =
        image.byteSize !== undefined || image.dataBase64 !== undefined
          ? image
          : await this.#project(image, entry);
      return sized ? inlineMediaBytes(sized) : 0;
    };
    const actualSize = async (image: ModelImage, entry?: Entry) => {
      const projected = await this.#project(image, entry);
      return projected ? inlineMediaBytes(projected) : 0;
    };
    const history = await Promise.all(
      this.#entries.map(async (entry, index) => ({
        index,
        bytes:
          entry.active && entry.image && index > this.#evicted && index <= this.#considered
            ? await size(entry.image, entry)
            : 0
      }))
    );
    let beforeBytes = history.reduce((sum, entry) => sum + entry.bytes, 0);
    let freshBytes = 0;
    let requestBytes = 0;
    const requestHistory = new Map<number, number>();
    if (request) {
      for (const message of request.messages)
        for (const [index, image] of (message.images ?? []).entries()) {
          const position = this.#sources.get(inlineMediaSource(message))?.[index];
          const entry = position === undefined ? undefined : this.#entries[position];
          const original = entry && isDeepStrictEqual(entry.image, image);
          if (original && position! <= this.#evicted) continue;
          const bytes = await actualSize(image, entry);
          requestBytes += bytes;
          if (original && position! <= this.#considered) {
            requestHistory.set(position!, (requestHistory.get(position!) ?? 0) + bytes);
            history[position!]!.bytes = bytes;
          } else freshBytes += bytes;
        }
      for (const image of request.images ?? []) {
        if (mirroredImages.some((mirror) => isDeepStrictEqual(image, mirror))) continue;
        const bytes = await actualSize(image);
        freshBytes += bytes;
        requestBytes += bytes;
      }
      beforeBytes = history.reduce((sum, item) => sum + item.bytes, 0);
      if (freshBytes > policy.requestInlineMediaHardLimit) inlineMediaLimit();
    }
    const hard = requestBytes > policy.requestInlineMediaHardLimit;
    if (!hard && beforeBytes <= policy.historicalInlineMediaTarget) return undefined;
    const target = hard
      ? Math.max(0, policy.historicalInlineMediaTarget - freshBytes)
      : policy.historicalInlineMediaTarget;
    let afterBytes = beforeBytes;
    let evicted = this.#evicted;
    for (const item of history) {
      if (afterBytes <= target && (!hard || requestBytes <= policy.requestInlineMediaHardLimit))
        break;
      if (!item.bytes) continue;
      if (!hard && this.#rollout - this.#entries[item.index]!.rollout < 2) break;
      afterBytes -= item.bytes;
      requestBytes -= requestHistory.get(item.index) ?? 0;
      evicted = item.index;
    }
    if (afterBytes > target || (hard && requestBytes > policy.requestInlineMediaHardLimit))
      return undefined;
    const entry = this.#entries[evicted];
    if (!entry || typeof entry.source !== 'string' || evicted <= this.#evicted) return undefined;
    return {
      reason: hard
        ? 'HARD_LIMIT'
        : beforeBytes > policy.historicalInlineMediaTrigger
          ? 'SOFT_LIMIT'
          : 'TEXT_GC',
      state: {
        ...this.checkpoint(),
        evictedThrough: { sourceId: entry.source, imageIndex: entry.imageIndex }
      },
      beforeBytes,
      afterBytes,
      project: (messages: readonly ModelMessage[]) =>
        this.#historyView(messages, evicted, this.#evicted)
    };
  }

  adoptGc(state: InlineMediaState | undefined): void {
    if (state) {
      this.#evicted = this.#position(state.evictedThrough);
      this.releaseBytes();
    }
  }

  releaseBytes(): void {
    this.#resourceReads.clear();
    this.#cachedBytes = 0;
  }

  #readBytes(resourceId: string): ReturnType<SessionStore['readResource']> {
    const cached = this.#resourceReads.get(resourceId);
    if (cached) return cached;
    const pending = this.store.readResource(this.sessionId, resourceId).then(
      (resource) => {
        if (this.#resourceReads.get(resourceId) === pending) {
          const bytes = resource?.dataBase64 ? inlineMediaBytes(resource) : 0;
          if (!bytes || this.#cachedBytes + bytes > policy.requestInlineMediaHardLimit)
            this.#resourceReads.delete(resourceId);
          else this.#cachedBytes += bytes;
        }
        return resource;
      },
      (error: unknown) => {
        if (this.#resourceReads.get(resourceId) === pending) this.#resourceReads.delete(resourceId);
        throw error;
      }
    );
    this.#resourceReads.set(resourceId, pending);
    return pending;
  }

  async #project(image: ModelImage, entry?: Entry): Promise<ModelImage | undefined> {
    const original = entry && isDeepStrictEqual(entry.image, image);
    if (original && entry.unavailable) return undefined;
    if (this.useResourceUrl) {
      if (!isModelImageUrl(image.url))
        throw new AgentError('MAR_AGENT_RESOURCE_URL_UNAVAILABLE', 'Resource URL is unavailable.');
      const { dataBase64: _bytes, ...reference } = image;
      return reference;
    }
    let bytes;
    try {
      bytes =
        image.dataBase64 !== undefined
          ? image
          : image.resourceId === undefined
            ? undefined
            : await this.#readBytes(image.resourceId);
    } catch (error) {
      if (!(error instanceof AgentError) || error.code !== 'MAR_AGENT_IMAGE_UNAVAILABLE')
        throw error;
    }
    if (!bytes?.dataBase64) {
      if (original) entry.unavailable = true;
      return undefined;
    }
    const { url: _url, urlExpiresAt: _expires, ...reference } = image;
    return { ...reference, dataBase64: bytes.dataBase64 };
  }
}
