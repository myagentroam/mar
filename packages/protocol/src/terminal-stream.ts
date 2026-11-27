import { MAX_TERMINAL_FRAME_BYTES } from './byte-frame.js';
import { readStreamRecords, writeStreamRecord } from './stream-record.js';

/** Terminal owns its records; the shared stream does not preserve write boundaries. */
export function writeTerminalRecord(frame: Uint8Array): Uint8Array<ArrayBuffer> {
  return writeStreamRecord(frame, MAX_TERMINAL_FRAME_BYTES, 'TERMINAL_RECORD_INVALID');
}

export function readTerminalRecords(source: AsyncIterable<Uint8Array>) {
  return readStreamRecords(
    source,
    MAX_TERMINAL_FRAME_BYTES,
    'TERMINAL_RECORD_INVALID',
    'TERMINAL_RECORD_TRUNCATED'
  );
}
