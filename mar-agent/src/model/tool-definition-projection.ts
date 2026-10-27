import type { ModelToolDefinition } from './contracts.js';

import { stableToolSchema } from './tool-schema.js';
export { stableToolSchema } from './tool-schema.js';

export function stableToolDefinition<T extends ModelToolDefinition>(definition: T): T {
  return {
    ...definition,
    inputSchema: stableToolSchema(definition.inputSchema)
  };
}

export function orderToolDefinitions<T extends { readonly name: string }>(
  definitions: readonly T[]
): T[] {
  return [...definitions].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  );
}
