import type { MarAgentHost } from '../host/contracts.js';
import type { ModelImage } from '../model/image.js';
import { isModelImageUrl } from '../model/image.js';
import { MarAgentError } from '../error.js';
import type { SessionStore } from '../session/store/contracts.js';

const pending = new WeakMap<SessionStore, Map<string, Promise<ModelImage>>>();

/** Persist immutable bytes first; publication never changes an existing resource URL. */
export async function publishModelImages<T extends ModelImage>(
  host: MarAgentHost,
  images: readonly T[] | undefined,
  context: { sessionId: string; executionId: string },
  store?: SessionStore
): Promise<readonly T[] | undefined> {
  if (!images?.length) return images;
  if (store === undefined) {
    if (host.publishModelImage === undefined) return images;
    throw new MarAgentError(
      'MAR_AGENT_IMAGE_PUBLICATION_FAILED',
      'Image publication requires a SessionStore.'
    );
  }
  let publications = pending.get(store);
  if (publications === undefined) pending.set(store, (publications = new Map()));
  return Promise.all(
    images.map(async (image) => {
      if (
        image.dataBase64 === undefined &&
        image.resourceId === undefined &&
        isModelImageUrl(image.url)
      )
        return image;
      let resource = await store.persistImageResource(context.sessionId, image);
      if (resource.url === undefined && image.url !== undefined && image.urlExpiresAt !== undefined)
        resource = await store.setImageResourceUrl(context.sessionId, resource.resourceId, {
          url: image.url,
          urlExpiresAt: image.urlExpiresAt
        });
      const key = `${context.sessionId}\0${resource.resourceId}`;
      let publication = publications!.get(key);
      if (publication === undefined) {
        publication = (async () => {
          if (resource.url === undefined && host.publishModelImage !== undefined) {
            const published = await host.publishModelImage(resource, {
              ...context,
              homeDirectory: (await host.describe()).homeDirectory
            });
            if (
              published === undefined ||
              !isModelImageUrl(published.url) ||
              !Number.isSafeInteger(published.urlExpiresAt) ||
              published.urlExpiresAt <= 0
            )
              throw new MarAgentError(
                'MAR_AGENT_IMAGE_PUBLICATION_FAILED',
                'Image publication did not return a valid fixed URL.'
              );
            resource = await store.setImageResourceUrl(
              context.sessionId,
              resource.resourceId,
              published
            );
          }
          const { sha256: _hash, ...reference } = resource;
          return resource.url === undefined && image.dataBase64 !== undefined
            ? { ...reference, dataBase64: image.dataBase64 }
            : reference;
        })();
        publications!.set(key, publication);
      }
      try {
        const published = await publication;
        const { dataBase64: _bytes, ...metadata } = image;
        return { ...metadata, ...published } as T;
      } finally {
        if (publications!.get(key) === publication) publications!.delete(key);
      }
    })
  );
}
