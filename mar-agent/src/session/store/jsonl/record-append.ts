import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  bindToolResultResources,
  completeToolResultResources
} from '../../tool-result-resources.js';
import { appendRecordBytes, MAX_SEGMENT_BYTES } from './records.js';
import { completeResources } from './resources.js';
import { normalizeJsonlRecord } from './jsonl-codec.js';
import type { SessionRecordInput } from '../contracts.js';
import type { SessionRecord } from '../types.js';

interface AppendRecordContext {
  readonly sequence: number;
  directory(): string;
  readRecordAtSequence(sequence: number): Promise<SessionRecord | undefined>;
  currentSegment(): Promise<number>;
  segmentPath(segment: number): string;
  setCurrentSegment(segment: number): void;
  markWriteFailure(error: unknown): void;
  invalidateAfterWriteFailure(): void;
  publish(record: SessionRecord, serialized: string, segment: number): void;
}

/** Bind resources and publish a single durable append under the caller's Session writer. */
export async function appendSessionRecord(
  sessionId: string,
  input: SessionRecordInput,
  context: AppendRecordContext
): Promise<SessionRecord> {
  const record: SessionRecord = normalizeJsonlRecord({
    recordId: randomUUID(),
    sequence: context.sequence,
    timestamp: input.timestamp ?? new Date().toISOString(),
    sessionId,
    ...(input.executionId ? { executionId: input.executionId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    type: input.type,
    payload: input.payload
  });
  JSON.stringify(record); // Reject malformed payloads before binding resources.
  await bindToolResultResources(context.directory(), record, context.readRecordAtSequence, true);
  const serialized = `${JSON.stringify(record)}\n`;
  let segment = await context.currentSegment();
  let path = context.segmentPath(segment);
  try {
    const current = await stat(path);
    if (current.size > 0 && current.size + Buffer.byteLength(serialized) > MAX_SEGMENT_BYTES) {
      segment += 1;
      context.setCurrentSegment(segment);
      path = context.segmentPath(segment);
    }
  } catch {
    // The first append creates the first segment.
  }
  try {
    await appendRecordBytes(path, serialized, context.markWriteFailure);
  } catch (error) {
    context.invalidateAfterWriteFailure();
    throw error;
  }
  // The callback synchronously publishes onto the metadata current after file I/O.
  context.publish(record, serialized, segment);
  await completeToolResultResources(context.directory(), record);
  // The record is already durable and published; pending markers are recoverable cleanup.
  await completeResources(join(context.directory(), 'resources'), record).catch(() => undefined);
  return record;
}
