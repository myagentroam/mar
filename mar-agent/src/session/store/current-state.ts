import { AgentError } from '../../error.js';
import { cloneCoreJson, type ExtensionCheckpoint } from '../extension-checkpoint.js';
import { restoreCodeModeState, type CodeModeStateEntry } from '../code-state.js';

interface StateRecord {
  readonly type: string;
  readonly payload: unknown;
}
export type ExtensionCheckpointIndex = Map<string, Map<string, Record<string, unknown>>>;

/** Derived non-model state owned by one physical Session writer lease. */
export interface SessionCurrentState {
  codeState?: CodeModeStateEntry[];
  extensionCheckpoints?: ExtensionCheckpointIndex;
}

export function updateSessionCurrentState(
  cache: SessionCurrentState | undefined,
  type: string,
  serialized: string
): void {
  if (!cache) return;
  if (type === 'code.state.updated' && cache.codeState !== undefined) {
    try {
      cache.codeState = restoreCodeModeState([JSON.parse(serialized)], cache.codeState);
    } catch {
      // Cache maintenance must not fail an already durable append.
      delete cache.codeState;
    }
  } else if (type === 'extension.checkpoint.updated' && cache.extensionCheckpoints) {
    indexExtensionCheckpoint(cache.extensionCheckpoints, JSON.parse(serialized).payload);
  }
}

export function restoreExtensionCheckpoint(
  records: readonly StateRecord[],
  extensionId: string,
  key: string
): ExtensionCheckpoint {
  for (const record of records.toReversed()) {
    if (record.type !== 'extension.checkpoint.updated') continue;
    const payload = record.payload as {
      extensionId?: unknown;
      key?: unknown;
      revision?: unknown;
      value?: unknown;
      deleted?: unknown;
    } | null;
    if (!payload || payload.extensionId !== extensionId || payload.key !== key) continue;
    return extensionCheckpointFromPayload(payload);
  }
  return { revision: 0 };
}

export function indexExtensionCheckpoint(index: ExtensionCheckpointIndex, payload: unknown): void {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return;
  const value = payload as Record<string, unknown>;
  if (typeof value.extensionId !== 'string' || typeof value.key !== 'string') return;
  let namespace = index.get(value.extensionId);
  if (!namespace) index.set(value.extensionId, (namespace = new Map()));
  namespace.set(value.key, value);
}

export function extensionCheckpointFromPayload(
  payload: Record<string, unknown> | undefined
): ExtensionCheckpoint {
  if (!payload) return { revision: 0 };
  if (
    typeof payload.revision !== 'number' ||
    !Number.isSafeInteger(payload.revision) ||
    payload.revision < 1
  )
    throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Extension checkpoint revision is corrupt.');
  return {
    revision: payload.revision,
    ...(payload.deleted === true ? {} : { value: cloneCoreJson(payload.value) })
  };
}
