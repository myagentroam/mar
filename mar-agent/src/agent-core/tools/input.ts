/** Compatibility is not validation: required fields, types and values stay with the tool. */
export function normalizeToolInput(input: unknown, schema: unknown): unknown {
  const visit = (value: unknown, definition: unknown, depth: number): unknown => {
    if (depth > 64 || value === null || typeof value !== 'object') return value;
    const shape = record(definition) ? definition : {};
    if (Array.isArray(value)) return value.map((item) => visit(item, shape.items, depth + 1));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      return value;
    const properties = record(shape.properties) ? shape.properties : {};
    // Do not guess branch selection, resolve refs, or discard pattern-defined parameters.
    const closed =
      shape.additionalProperties === false &&
      !['$ref', 'anyOf', 'oneOf', 'allOf', 'if', 'patternProperties', 'dependentSchemas'].some(
        (key) => Object.hasOwn(shape, key)
      );
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      const declared = Object.hasOwn(properties, key);
      if (closed && !declared) continue;
      const child = declared ? properties[key] : shape.additionalProperties;
      Object.defineProperty(result, key, {
        value: visit(item, child, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true
      });
    }
    return result;
  };
  return visit(input, schema, 0);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
