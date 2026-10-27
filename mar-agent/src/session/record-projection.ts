import type { ModelInputMetadata } from '../model/contracts.js';
import type { CompactHistoryMessage, SessionRecord } from './record-contract.js';

export function compactSummaryFromCheckpoint(
  record: SessionRecord | undefined
): string | undefined {
  if (record?.type !== 'compact.completed') return undefined;
  const payload = record.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const summary = (payload as { summary?: unknown }).summary;
  return typeof summary === 'string' && summary.trim().length > 0 ? summary : undefined;
}

export function replacementHistoryFromCheckpoint(
  record: SessionRecord
): CompactHistoryMessage[] | undefined {
  if (compactSummaryFromCheckpoint(record) === undefined) return undefined;
  const history = (record.payload as { replacementHistory?: unknown }).replacementHistory;
  if (!Array.isArray(history)) return undefined;
  const result: CompactHistoryMessage[] = [];
  let summaries = 0;
  for (const message of history) {
    if (
      message === null ||
      typeof message !== 'object' ||
      message.role !== 'user' ||
      typeof message.content !== 'string' ||
      (message.kind !== 'user_input' &&
        message.kind !== 'extension_input' &&
        !(message.kind === 'summary' && message.content.trim().length > 0))
    )
      return undefined;
    const metadata = parseModelInputMetadata(message.metadata);
    if (
      message.metadata !== undefined &&
      (!metadata ||
        (message.kind === 'extension_input'
          ? metadata.source !== 'extension'
          : message.kind !== 'user_input' || metadata.source === 'extension'))
    )
      return undefined;
    if (message.kind === 'summary') summaries++;
    result.push({
      role: 'user',
      content: message.content,
      kind: message.kind,
      ...(metadata === undefined ? {} : { metadata })
    });
  }
  return summaries === 1 ? result : undefined;
}

export function parseModelInputMetadata(value: unknown): ModelInputMetadata | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const metadata = value as Record<string, unknown>;
  if (
    metadata.source !== 'user' &&
    metadata.source !== 'parent_agent' &&
    metadata.source !== 'extension'
  )
    return undefined;
  return {
    source: metadata.source,
    ...(typeof metadata.recordId === 'string' && metadata.recordId.length <= 128
      ? { recordId: metadata.recordId }
      : {}),
    ...(typeof metadata.extensionId === 'string' && metadata.extensionId.length <= 128
      ? { extensionId: metadata.extensionId }
      : {}),
    ...(metadata.truncated === true ? { truncated: true } : {}),
    ...(metadata.smartCompaction === true ? { smartCompaction: true as const } : {})
  };
}

export function inputMetadataFromRecord(record: SessionRecord): ModelInputMetadata {
  const payload = record.payload as Record<string, unknown>;
  const source = payload.source as Record<string, unknown> | undefined;
  return {
    source:
      record.type === 'extension.input' || payload.inputSource === 'extension'
        ? 'extension'
        : payload.inputSource === 'parent_agent'
          ? 'parent_agent'
          : 'user',
    recordId: record.recordId,
    ...(payload.smartCompaction === true ? { smartCompaction: true as const } : {}),
    ...(typeof source?.extensionId === 'string' && source.extensionId.length <= 128
      ? { extensionId: source.extensionId }
      : {})
  };
}
