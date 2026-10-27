import type { ModelRequest } from './contracts.js';

/** Preserve a freeform call when replaying it through a JSON-only tool protocol. */
export function jsonToolInput(
  message: ModelRequest['messages'][number],
  tool: ModelRequest['tools'][number] | undefined
): Record<string, unknown> {
  if (isObject(message.arguments)) return message.arguments;
  if (message.inputMode !== 'freeform') return {};
  const schema = tool?.inputSchema;
  const required =
    schema?.type === 'object' && Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === 'string')
      : [];
  const name = required.length === 1 && typeof required[0] === 'string' ? required[0] : undefined;
  const property = name && isObject(schema?.properties) ? schema.properties[name] : undefined;
  const key = name && isObject(property) && property.type === 'string' ? name : 'input';
  return { [key]: String(message.arguments ?? '') };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
