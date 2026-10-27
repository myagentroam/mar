import type { SessionModelMessage as ModelMessage } from '../../session/model-request.js';

import {
  codeCallEvidence,
  codePartialPatchCallEvidence,
  codeObservationEvidence
} from '../../session/context-gc-observations.js';

import { type ContextGcTarget } from '../../session/context-gc-checkpoint.js';

import type { SessionRecord } from '../../session/record-contract.js';

import { providerToolCallId, providerToolName } from './projection.js';

import { type ToolGroup } from './gc-contracts.js';

export function buildToolGroups(
  records: readonly SessionRecord[],
  messages: readonly ModelMessage[],
  sources: readonly SessionRecord[]
): Map<string, ToolGroup> {
  const groups = new Map<string, ToolGroup>();
  const group = (callId: string, toolName = '') => {
    const current = groups.get(callId);
    if (current) {
      if (!current.toolName && toolName) current.toolName = toolName;
      return current;
    }
    const created: ToolGroup = { callId, toolName, aliases: [] };
    groups.set(callId, created);
    return created;
  };
  for (const [index, message] of messages.entries()) {
    const record = sources[index]!;
    if (message.role === 'tool_call' && message.callId && message.name)
      group(message.callId, message.name).call = { message, record };
    else if (message.role === 'tool' && message.callId)
      group(message.callId).result = { message, record };
    else if (message.role === 'provider') {
      const callId = providerToolCallId(message);
      if (callId) group(callId, providerToolName(message)).aliases.push({ message, record });
    }
  }
  for (const record of records) {
    if (!isRecord(record.payload)) continue;
    const type = record.payload.type;
    const callId = record.payload.callId;
    const toolName = record.payload.toolName;
    if (typeof callId !== 'string' || typeof toolName !== 'string') continue;
    const current = group(callId, toolName);
    if (type === 'tool.completed') current.completed = record;
    else if (type === 'tool.failed') current.failed = record;
  }
  for (const [index, message] of messages.entries()) {
    if (!message.observations || message.role !== 'tool') continue;
    const record = sources[index]!;
    for (const entry of message.calls ?? []) {
      if (
        ![
          'apply_patch',
          'exec',
          'exec_wait',
          'agent_start',
          'agent_wait',
          'agent_message',
          'agent_cancel'
        ].includes(entry.toolName) ||
        (entry.status === 'completed' &&
          message.observations.some(
            (value) => value.type === 'tool_result' && value.source.callId === entry.callId
          ))
      )
        continue;
      const evidence =
        codeCallEvidence(records, record, entry) ??
        codePartialPatchCallEvidence(records, record, entry);
      if (!evidence) continue;
      groups.set(`execution:${evidence.callId}`, {
        evidenceOnly: true,
        callId: evidence.callId,
        toolName: entry.toolName,
        aliases: [],
        ...('completed' in evidence
          ? { completed: evidence.completed }
          : { failed: evidence.failed }),
        call: {
          record: evidence.call,
          message: {
            role: 'tool_call',
            callId: evidence.callId,
            name: entry.toolName,
            content: '',
            arguments: entry.input
          }
        },
        result: {
          record,
          message: {
            role: 'tool',
            callId: message.callId!,
            content: (evidence.result.payload as { content: string }).content
          }
        }
      });
    }
    for (const observation of message.observations) {
      if (observation.type !== 'tool_result') continue;
      const evidence = codeObservationEvidence(records, record, observation);
      if (!evidence) continue;
      groups.set(`${evidence.callId}:${observation.id}`, {
        callId: evidence.callId,
        toolName: observation.source.toolName,
        aliases: [],
        completed: evidence.completed,
        call: {
          record: evidence.call,
          message: {
            role: 'tool_call',
            callId: evidence.callId,
            name: observation.source.toolName,
            content: '',
            arguments: observation.source.input
          }
        },
        result: {
          record,
          message: {
            role: 'tool',
            callId: message.callId!,
            content: observation.result.content,
            observationId: observation.id
          }
        }
      });
    }
  }
  return groups;
}

export function successfulRolloutsAfter(
  records: readonly SessionRecord[],
  evidenceSequence: number,
  modelId: string,
  contextWindowTokens: number
): number {
  return countSuccessfulNormalRollouts(
    records.filter((record) => record.sequence > evidenceSequence),
    modelId,
    contextWindowTokens,
    modelConfigurationAt(records, evidenceSequence, modelId, contextWindowTokens)
  );
}

export function countSuccessfulNormalRollouts(
  records: readonly SessionRecord[],
  modelId: string,
  contextWindowTokens: number,
  initial: { modelId: string; contextWindowTokens: number } = {
    modelId,
    contextWindowTokens
  }
): number {
  let activeModelId = initial.modelId;
  let activeContextWindowTokens = initial.contextWindowTokens;
  let count = 0;
  for (const record of records) {
    if (record.type === 'execution.header' && isRecord(record.payload)) {
      activeModelId =
        typeof record.payload.modelId === 'string' ? record.payload.modelId : activeModelId;
      activeContextWindowTokens =
        typeof record.payload.contextWindowTokens === 'number' &&
        Number.isSafeInteger(record.payload.contextWindowTokens) &&
        record.payload.contextWindowTokens > 0
          ? record.payload.contextWindowTokens
          : activeContextWindowTokens;
      continue;
    }
    if (
      activeModelId === modelId &&
      activeContextWindowTokens === contextWindowTokens &&
      record.type === 'model.attempt' &&
      isRecord(record.payload) &&
      record.payload.purpose === 'EXECUTION' &&
      record.payload.state === 'SUCCEEDED'
    )
      count++;
  }
  return count;
}

function modelConfigurationAt(
  records: readonly SessionRecord[],
  boundarySequence: number,
  fallbackModelId: string,
  fallbackContextWindowTokens: number
): { modelId: string; contextWindowTokens: number } {
  let modelId = fallbackModelId;
  let contextWindowTokens = fallbackContextWindowTokens;
  for (const record of records) {
    if (record.sequence > boundarySequence) break;
    if (record.type !== 'execution.header' || !isRecord(record.payload)) continue;
    if (typeof record.payload.modelId === 'string') modelId = record.payload.modelId;
    if (
      typeof record.payload.contextWindowTokens === 'number' &&
      Number.isSafeInteger(record.payload.contextWindowTokens) &&
      record.payload.contextWindowTokens > 0
    )
      contextWindowTokens = record.payload.contextWindowTokens;
  }
  return { modelId, contextWindowTokens };
}

export function targetFor(
  record: SessionRecord,
  message: ModelMessage
): ContextGcTarget | undefined {
  if (
    record.type !== 'model.context' ||
    (message.role !== 'tool_call' && message.role !== 'tool' && message.role !== 'provider')
  )
    return undefined;
  const callId = message.role === 'provider' ? providerToolCallId(message) : message.callId;
  const toolName = message.role === 'provider' ? providerToolName(message) : message.name;
  return {
    sequence: record.sequence,
    recordId: record.recordId,
    role: message.role,
    ...(callId === undefined ? {} : { callId }),
    ...(toolName === undefined ? {} : { toolName }),
    ...(message.observationId ? { observationId: message.observationId } : {})
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
