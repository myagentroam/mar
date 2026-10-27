import { AgentError } from '../error.js';

export type ExtensionJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ExtensionJsonValue[]
  | { readonly [key: string]: ExtensionJsonValue };
export interface ExtensionCheckpoint {
  readonly revision: number;
  readonly value?: ExtensionJsonValue;
}
export function cloneCoreJson(value: unknown): ExtensionJsonValue {
  try {
    const ancestors = new Set<object>();
    const copy = (value: unknown): ExtensionJsonValue => {
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value !== 'object' || !value || ancestors.has(value)) throw new Error();
      ancestors.add(value);
      try {
        if (Array.isArray(value)) return Array.from(value, copy);
        if (Object.prototype.toString.call(value) !== '[object Object]') throw new Error();
        // Define own JSON keys, including __proto__, without assigning to a prototype setter.
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
      } finally {
        ancestors.delete(value);
      }
    };
    return copy(value);
  } catch {
    throw new AgentError(
      'MAR_AGENT_EXTENSION_DATA_INVALID',
      'Extension data must be serializable JSON.'
    );
  }
}
