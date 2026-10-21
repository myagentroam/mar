import type { ClientToolDefinition } from './contracts.js';

/** Stable model declarations, not a serializer for historical messages or tool results. */
export function stableToolSchema<T>(schema: T): T {
  return stableSchemaValue(schema) as T;
}

function stableSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSchemaValue);
  if (value === null || typeof value !== 'object') return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const fields = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(fields)
      .sort()
      .map((key) => [key, stableSchemaValue(fields[key])])
  );
}

export function stableToolDefinition(definition: ClientToolDefinition): ClientToolDefinition {
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
