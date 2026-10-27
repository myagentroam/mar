import type { ModelRequest } from '../../../mar-agent/dist/model/contracts.js';

/** Read the current SDK-owned Skill catalog, not earlier replaced or removed versions. */
export function skillCatalog(request: ModelRequest): string | undefined {
  const message = request.messages.findLast(
    (item) =>
      item.contextualBlock?.id === 'core:skill-catalog' &&
      item.contextualBlock.authority === 'instruction'
  );
  return message?.contextualBlock?.operation === 'replace' ? message.content : undefined;
}
