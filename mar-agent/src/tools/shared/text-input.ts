import { AgentError } from '../../error.js';

/** Report missing or mistyped text input using only the expected field and actual value type. */
export function textToolInputError(field: string, value: unknown): AgentError {
  const object = value !== null && typeof value === 'object' && !Array.isArray(value);
  const item = object ? (value as Record<string, unknown>)[field] : value;
  const type = item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item;
  const message = object
    ? type === 'undefined'
      ? `Missing required string field "${field}".`
      : `Expected string field "${field}"; received ${type}.`
    : `Expected a string or an object with string field "${field}"; received ${type}.`;
  return new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', message);
}
