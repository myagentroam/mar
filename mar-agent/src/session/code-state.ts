import { AgentError } from '../error.js';

export interface CodeModeStateEntry {
  readonly key: string;
  readonly value: unknown;
}

export type CodeModeStateMutation =
  | { readonly operation: 'set'; readonly key: string; readonly value: unknown }
  | { readonly operation: 'delete'; readonly key: string };

export const CODE_STATE_LIMITS = Object.freeze({
  codeStateMaxEntries: 128,
  codeStateMaxMutations: 128,
  codeStateMaxKeyBytes: 256,
  codeStateMaxValueBytes: 65_536,
  codeStateMaxTotalBytes: 1_048_576
});
const limits = CODE_STATE_LIMITS;

type StateRecord = { readonly type: string; readonly payload: unknown };

export function parseCodeModeStateMutations(value: unknown): CodeModeStateMutation[] {
  if (!Array.isArray(value) || value.length > limits.codeStateMaxMutations) throw invalidState();
  return value.map((item) => {
    if (!isObject(item) || !validKey(item.key)) throw invalidState();
    if (
      item.operation === 'delete' &&
      Object.keys(item).every((key) => ['operation', 'key'].includes(key))
    )
      return { operation: 'delete', key: item.key };
    if (
      item.operation === 'set' &&
      Object.keys(item).every((key) => ['operation', 'key', 'value'].includes(key)) &&
      Object.prototype.hasOwnProperty.call(item, 'value')
    )
      return { operation: 'set', key: item.key, value: cloneStateValue(item.value) };
    throw invalidState();
  });
}

export function restoreCodeModeState(
  records: readonly StateRecord[],
  initialState: CodeModeStateEntry[] = []
): CodeModeStateEntry[] {
  let state = initialState;
  for (const record of records) {
    if (record.type !== 'code.state.updated') continue;
    if (
      !isObject(record.payload) ||
      !Object.keys(record.payload).every((key) => key === 'mutations')
    )
      throw corruptState();
    let mutations: CodeModeStateMutation[];
    try {
      mutations = parseCodeModeStateMutations(record.payload.mutations);
      state = applyCodeModeStateMutations(state, mutations);
    } catch (error) {
      if (error instanceof AgentError)
        throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Code Mode state is corrupt.', {
          cause: error
        });
      throw error;
    }
  }
  return state;
}

export function applyCodeModeStateMutations(
  entries: readonly CodeModeStateEntry[],
  mutations: readonly CodeModeStateMutation[]
): CodeModeStateEntry[] {
  const state = new Map(entries.map((entry) => [entry.key, cloneStateValue(entry.value)]));
  for (const mutation of mutations) {
    if (mutation.operation === 'delete') state.delete(mutation.key);
    else state.set(mutation.key, cloneStateValue(mutation.value));
  }
  if (state.size > limits.codeStateMaxEntries)
    throw new AgentError('MAR_AGENT_TOOL_OUTPUT_LIMIT', 'Code Mode state has too many entries.');
  const result = [...state].map(([key, value]) => ({ key, value }));
  if (Buffer.byteLength(JSON.stringify(result)) > limits.codeStateMaxTotalBytes)
    throw new AgentError('MAR_AGENT_TOOL_OUTPUT_LIMIT', 'Code Mode state is too large.');
  return result;
}

function validKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= limits.codeStateMaxKeyBytes
  );
}

function cloneStateValue(value: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw invalidState();
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > limits.codeStateMaxValueBytes)
    throw invalidState();
  return JSON.parse(serialized);
}

function invalidState() {
  return new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Code Mode state mutation is invalid.');
}

function corruptState() {
  return new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Code Mode state is corrupt.');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
