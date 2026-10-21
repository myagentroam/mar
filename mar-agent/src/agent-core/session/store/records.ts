import { open, readFile } from 'node:fs/promises';
import { MarAgentError } from '../../error.js';
import type { SessionRecord } from './types.js';

export interface HistoryPagePositions {
  readonly signature: string;
  readonly offsets: Map<number, number>;
}

export const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;

const REVERSE_READ_CHUNK_BYTES = 64 * 1024;

const MAX_HISTORY_PAGE_FILES = 32;

const MAX_HISTORY_PAGE_OFFSETS = 128;

/** Read only the prefix needed by discovery; never load the entire transcript. */
export async function* readRecordsFromHead(path: string): AsyncGenerator<SessionRecord> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    let position = 0;
    let pending: Buffer[] = [];
    while (position < size) {
      const chunk = Buffer.allocUnsafe(Math.min(REVERSE_READ_CHUNK_BYTES, size - position));
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, size - position),
        position
      );
      if (bytesRead === 0) break;
      position += bytesRead;
      const data = chunk.subarray(0, bytesRead);
      let start = 0;
      for (;;) {
        const end = data.indexOf(0x0a, start);
        if (end < 0) break;
        const part = data.subarray(start, end);
        const line = (pending.length === 0 ? part : Buffer.concat([...pending, part])).toString(
          'utf8'
        );
        pending = [];
        start = end + 1;
        if (!line) continue;
        let record: SessionRecord;
        try {
          record = JSON.parse(line) as SessionRecord;
        } catch (cause) {
          throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session history is corrupt.', {
            cause
          });
        }
        yield record;
      }
      if (start < data.length) pending.push(data.subarray(start));
    }
    if (pending.length > 0) {
      let record: SessionRecord;
      try {
        record = JSON.parse(Buffer.concat(pending).toString('utf8')) as SessionRecord;
      } catch {
        return; // Readers ignore only an interrupted final line.
      }
      yield record;
    }
  } finally {
    await handle.close();
  }
}

export async function readRecords(path: string): Promise<SessionRecord[]> {
  const value = await readFile(path, 'utf8');
  const lines = value.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const records: SessionRecord[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line) as SessionRecord);
    } catch (cause) {
      if (index === lines.length - 1 && !value.endsWith('\n')) break;
      throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session history is corrupt.', {
        cause
      });
    }
  }
  return records;
}

/** Repair only the final record under the Session writer lock; never skip middle damage. */
export async function repairSegmentTail(path: string): Promise<void> {
  const data = await readFile(path);
  if (data.length === 0 || data.at(-1) === 10) return;
  const boundary = data.lastIndexOf(10);
  let complete = false;
  try {
    const record = JSON.parse(data.subarray(boundary + 1).toString('utf8')) as SessionRecord;
    complete =
      record?.schemaVersion === 1 &&
      Number.isSafeInteger(record.sequence) &&
      typeof record.sessionId === 'string' &&
      typeof record.type === 'string';
  } catch {
    // An interrupted final line is discarded before another record can be appended.
  }
  const handle = await open(path, 'r+');
  try {
    if (complete) {
      const { bytesWritten } = await handle.write(Buffer.from('\n'), 0, 1, data.length);
      if (bytesWritten !== 1)
        throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session tail repair is incomplete.');
    } else await handle.truncate(boundary + 1);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readRecordPageFromTail(
  path: string,
  beforeSequence: number,
  limit: number,
  positions: Map<string, HistoryPagePositions>
): Promise<{ records: SessionRecord[]; hasEarlier: boolean }> {
  const newestFirst: SessionRecord[] = [];
  for await (const record of readRecordsFromTail(path, { beforeSequence, limit, positions })) {
    if (!(record.sequence < beforeSequence)) continue;
    newestFirst.push(record);
    if (newestFirst.length > limit) break;
  }
  return {
    records: newestFirst.slice(0, limit).reverse(),
    hasEarlier: newestFirst.length > limit
  };
}

/** Decode complete records newest-first, releasing the file as soon as a reader stops. */
export async function* readRecordsFromTail(
  path: string,
  page?: {
    readonly beforeSequence: number;
    readonly limit: number;
    readonly positions: Map<string, HistoryPagePositions>;
  }
): AsyncGenerator<SessionRecord> {
  const handle = await open(path, 'r');
  try {
    const metadata = await handle.stat({ bigint: true });
    const size = Number(metadata.size);
    let position = size;
    let cached: HistoryPagePositions | undefined;
    if (page !== undefined) {
      const signature = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
      const previous = page.positions.get(path);
      cached = previous?.signature === signature ? previous : { signature, offsets: new Map() };
      page.positions.delete(path);
      page.positions.set(path, cached);
      if (page.positions.size > MAX_HISTORY_PAGE_FILES)
        page.positions.delete(page.positions.keys().next().value!);
      let nearestSequence = Number.POSITIVE_INFINITY;
      for (const [sequence, offset] of cached.offsets) {
        if (sequence >= page.beforeSequence && sequence < nearestSequence) {
          nearestSequence = sequence;
          position = offset;
        }
      }
    }
    let accepted = 0;
    const remember = (record: SessionRecord, offset: number) => {
      if (page === undefined || cached === undefined || record.sequence >= page.beforeSequence)
        return;
      if (++accepted !== page.limit) return;
      cached.offsets.set(record.sequence, offset);
      if (cached.offsets.size > MAX_HISTORY_PAGE_OFFSETS)
        cached.offsets.delete(cached.offsets.keys().next().value!);
    };
    let pendingLineParts: Buffer[] = [];
    let invalidFinalLineMayBeIgnored = false;
    let inspectedFileEnd = position !== size;
    const decode = (line: Buffer, allowInvalidFinalLine: boolean): SessionRecord | undefined => {
      if (line.length === 0) return undefined;
      try {
        return JSON.parse(line.toString('utf8')) as SessionRecord;
      } catch (cause) {
        if (allowInvalidFinalLine) return undefined;
        throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session history is corrupt.', {
          cause
        });
      }
    };

    while (position > 0) {
      const start = Math.max(0, position - REVERSE_READ_CHUNK_BYTES);
      const chunk = Buffer.allocUnsafe(position - start);
      let bytesRead = 0;
      while (bytesRead < chunk.length) {
        const result = await handle.read(
          chunk,
          bytesRead,
          chunk.length - bytesRead,
          start + bytesRead
        );
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      const value = chunk.subarray(0, bytesRead);
      if (!inspectedFileEnd) {
        inspectedFileEnd = true;
        invalidFinalLineMayBeIgnored = value.at(-1) !== 0x0a;
      }
      let lineEnd = value.length;
      for (let index = value.length - 1; index >= 0; index--) {
        if (value[index] !== 0x0a) continue;
        const currentPart = value.subarray(index + 1, lineEnd);
        const line =
          pendingLineParts.length === 0
            ? currentPart
            : Buffer.concat([currentPart, ...pendingLineParts.reverse()]);
        const record = decode(line, invalidFinalLineMayBeIgnored);
        invalidFinalLineMayBeIgnored = false;
        pendingLineParts = [];
        lineEnd = index;
        if (record !== undefined) {
          remember(record, start + index + 1);
          yield record;
        }
      }
      if (lineEnd > 0) pendingLineParts.push(value.subarray(0, lineEnd));
      position = start;
    }
    if (pendingLineParts.length > 0) {
      const record = decode(
        Buffer.concat(pendingLineParts.reverse()),
        invalidFinalLineMayBeIgnored
      );
      if (record !== undefined) {
        remember(record, 0);
        yield record;
      }
    }
  } finally {
    await handle.close();
  }
}

export function segmentNumberFromPath(path: string): number | undefined {
  const match = /events-(\d{6})\.jsonl$/.exec(path);
  return match === null ? undefined : Number(match[1]);
}

export async function appendRecordBytes(path: string, serialized: string): Promise<void> {
  const handle = await open(path, 'a', 0o600);
  try {
    const bytes = Buffer.from(serialized);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
      if (bytesWritten === 0)
        throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session append is incomplete.');
      offset += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}
