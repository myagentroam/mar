import { MarAgentError } from '../../error.js';
import type { CodeModeStateEntry, CodeModeStateMutation } from '../contracts.js';
import { TOOL_EXECUTION_LIMITS as limits } from '../execution-limits.js';
export type { CodeModeStateEntry, CodeModeStateMutation } from '../contracts.js';

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
      if (error instanceof MarAgentError)
        throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Code Mode state is corrupt.', {
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
    throw new MarAgentError('MAR_AGENT_TOOL_OUTPUT_LIMIT', 'Code Mode state has too many entries.');
  const result = [...state].map(([key, value]) => ({ key, value }));
  if (Buffer.byteLength(JSON.stringify(result)) > limits.codeStateMaxTotalBytes)
    throw new MarAgentError('MAR_AGENT_TOOL_OUTPUT_LIMIT', 'Code Mode state is too large.');
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
  return new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Code Mode state mutation is invalid.');
}

function corruptState() {
  return new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Code Mode state is corrupt.');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
