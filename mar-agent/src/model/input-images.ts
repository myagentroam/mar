import { modelImageKey } from './image.js';
import type { ModelRequest } from './contracts.js';

export function isRealUserMessage(message: ModelRequest['messages'][number]): boolean {
  return (
    message.role === 'user' &&
    message.contextKind === undefined &&
    message.contextualBlock === undefined
  );
}

export function uniqueModelImages(
  ...groups: Array<ModelRequest['images'] | undefined>
): Array<NonNullable<ModelRequest['images']>[number]> {
  const seen = new Set<string>();
  return groups.flatMap((group) =>
    (group ?? []).flatMap((image) => {
      const key = modelImageKey(image);
      if (seen.has(key)) return [];
      seen.add(key);
      return [image];
    })
  );
}
