import {
  BROWSER_CONTROL_MAX_BYTES,
  browserAttachmentOpenSchema,
  type BrowserAttachmentOpen
} from './browser-attachment.js';
import { BROWSER_FRAME_MESSAGE_BYTES } from './browser-frame.js';
import type { NodeStream } from './node-stream.js';
import { readStreamRecords, writeStreamRecord } from './stream-record.js';

const CONTROL = 1;
const PICTURE = 2;
const MAX_RECORD_BYTES = 1 + Math.max(BROWSER_CONTROL_MAX_BYTES, BROWSER_FRAME_MESSAGE_BYTES);
const invalid = 'BROWSER_RECORD_INVALID';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function browserStreamGrant(open: BrowserAttachmentOpen): string {
  return `${open.attachmentId}.${open.ticket}`;
}

export function parseBrowserStreamGrant(grant: string): BrowserAttachmentOpen | undefined {
  const [attachmentId, ticket, extra] = grant.split('.');
  if (extra !== undefined) return undefined;
  const parsed = browserAttachmentOpenSchema.safeParse({
    type: 'OPEN',
    attachmentId,
    ticket,
    rfb: true
  });
  return parsed.success ? parsed.data : undefined;
}

/** Serializes Browser records without letting synchronous controls queue unbounded writes. */
export function browserRecordWriter(stream: NodeStream) {
  let pending = 0;
  let tail = Promise.resolve();
  return (message: string | Uint8Array, signal?: AbortSignal): Promise<void> => {
    const record = writeBrowserRecord(message);
    if (pending + record.byteLength > 4 * BROWSER_CONTROL_MAX_BYTES)
      throw new Error('BROWSER_LINK_UNAVAILABLE');
    pending += record.byteLength;
    const write = tail
      .then(() => {
        signal?.throwIfAborted();
        return stream.write(record);
      })
      .finally(() => {
        pending -= record.byteLength;
      });
    tail = write.catch(() => undefined);
    return write;
  };
}

/** Preserves the existing Browser text/binary message boundary over an ordered Node byte stream. */
export function writeBrowserRecord(message: string | Uint8Array): Uint8Array<ArrayBuffer> {
  const control = typeof message === 'string';
  const payload = control ? encoder.encode(message) : message;
  validateSize(control ? CONTROL : PICTURE, payload.length);
  const record = new Uint8Array(1 + payload.length);
  record[0] = control ? CONTROL : PICTURE;
  record.set(payload, 1);
  return writeStreamRecord(record, MAX_RECORD_BYTES, invalid);
}

export async function* readBrowserRecords(
  source: AsyncIterable<Uint8Array>
): AsyncGenerator<string | Uint8Array<ArrayBuffer>> {
  for await (const record of readStreamRecords(
    source,
    MAX_RECORD_BYTES,
    invalid,
    'BROWSER_RECORD_TRUNCATED'
  )) {
    const tag = record[0];
    const payload = record.subarray(1);
    validateSize(tag, payload.length);
    if (tag === CONTROL) {
      let text: string;
      try {
        text = decoder.decode(payload);
      } catch {
        throw new Error(invalid);
      }
      yield text;
    } else yield payload;
  }
}

function validateSize(tag: number | undefined, size: number): void {
  const limit =
    tag === CONTROL ? BROWSER_CONTROL_MAX_BYTES : tag === PICTURE ? BROWSER_FRAME_MESSAGE_BYTES : 0;
  if (size === 0 || size > limit) throw new Error(invalid);
}
