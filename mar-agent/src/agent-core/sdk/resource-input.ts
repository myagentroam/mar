import { isDeepStrictEqual } from 'node:util';
import { MarAgentError } from '../error.js';
import type { ModelMessage, ModelRequest } from '../model/contracts.js';
import { isModelImageUrl, type ModelImage } from '../model/image.js';
import type { SessionStore } from '../session/store/contracts.js';

type Source = string | ModelMessage;
const source = (message: ModelMessage): Source =>
  message.callId ?? message.metadata?.recordId ?? message;

/** One Execution owns delivery; resources and durable history remain unchanged. */
export class ResourceInputProjection {
  readonly #delivered: Set<Source>;
  readonly #candidates = new WeakMap<readonly ModelMessage[], readonly Source[]>();

  constructor(
    private readonly useResourceUrl: boolean,
    private readonly store: Pick<SessionStore, 'readResource'>,
    private readonly sessionId: string,
    history: readonly ModelMessage[]
  ) {
    this.#delivered = new Set(history.map(source));
  }

  hasPendingImages(messages: readonly ModelMessage[]): boolean {
    return messages.some(
      (message) => message.images?.length && !this.#delivered.has(source(message))
    );
  }

  async prepare(
    request: ModelRequest,
    mirroredImages: readonly ModelImage[] = []
  ): Promise<ModelRequest> {
    const selected: Source[] = [];
    const messages = await Promise.all(
      request.messages.map(async (message) => {
        if (!message.images?.length) return message;
        const key = source(message);
        const images =
          this.useResourceUrl || !this.#delivered.has(key)
            ? await Promise.all(message.images.map((image) => this.#project(image)))
            : [];
        if (images.length) selected.push(key);
        return { ...message, images };
      })
    );
    const { images: topImages, ...retained } = request;
    // SDK attachment mirrors already follow their source messages' delivery lifecycle.
    const images = await Promise.all(
      (topImages ?? [])
        .filter((image) => !mirroredImages.some((mirror) => isDeepStrictEqual(image, mirror)))
        .map((image) => this.#project(image))
    );
    const result = { ...retained, messages, ...(images.length ? { images } : {}) };
    this.#candidates.set(result.messages, selected);
    return result;
  }

  complete(request: ModelRequest): void {
    for (const key of this.#candidates.get(request.messages) ?? []) this.#delivered.add(key);
    this.#candidates.delete(request.messages);
  }

  async #project(image: ModelImage): Promise<ModelImage> {
    if (this.useResourceUrl) {
      if (!isModelImageUrl(image.url))
        throw new MarAgentError(
          'MAR_AGENT_RESOURCE_URL_UNAVAILABLE',
          'Resource URL is unavailable.'
        );
      const { dataBase64: _bytes, ...reference } = image;
      return reference;
    }
    const bytes =
      image.dataBase64 !== undefined
        ? image
        : image.resourceId === undefined
          ? undefined
          : await this.store.readResource(this.sessionId, image.resourceId);
    if (!bytes?.dataBase64)
      throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Resource bytes are unavailable.');
    const { url: _url, urlExpiresAt: _expires, ...reference } = image;
    return { ...reference, dataBase64: bytes.dataBase64 };
  }
}
