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
