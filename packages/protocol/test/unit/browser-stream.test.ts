import { expect, it } from 'vitest';
import { readBrowserRecords, writeBrowserRecord } from '../../src/browser-stream.js';
import { BROWSER_CONTROL_MAX_BYTES } from '../../src/browser-attachment.js';
import { BROWSER_FRAME_MESSAGE_BYTES } from '../../src/browser-frame.js';

async function collect(...chunks: Uint8Array[]) {
  async function* source() {
    yield* chunks;
  }
  const messages = [];
  for await (const message of readBrowserRecords(source())) messages.push(message);
  return messages;
}

it('preserves the Browser control and RFB records across arbitrary stream writes', async () => {
  const open = '{"title":"日本語"}';
  const picture = Uint8Array.of(0, 1, 0xff);
  const wire = Buffer.concat([
    writeBrowserRecord(open),
    writeBrowserRecord(picture),
    writeBrowserRecord('{"type":"ack"}')
  ]);
  await expect(
    collect(wire.subarray(0, 2), wire.subarray(2, 8), wire.subarray(8))
  ).resolves.toEqual([open, picture, '{"type":"ack"}']);
});

it('enforces each message bound and rejects truncated records, unknown types and invalid UTF-8', async () => {
  expect(() => writeBrowserRecord('a'.repeat(BROWSER_CONTROL_MAX_BYTES + 1))).toThrow(
    'BROWSER_RECORD_INVALID'
  );
  expect(() => writeBrowserRecord(new Uint8Array(BROWSER_FRAME_MESSAGE_BYTES + 1))).toThrow(
    'BROWSER_RECORD_INVALID'
  );
  await expect(collect(writeBrowserRecord('open').subarray(0, 6))).rejects.toThrow(
    'BROWSER_RECORD_TRUNCATED'
  );
  await expect(collect(Uint8Array.of(0, 0, 0, 2, 3, 0))).rejects.toThrow('BROWSER_RECORD_INVALID');
  await expect(collect(Uint8Array.of(0, 0, 0, 2, 1, 0xff))).rejects.toThrow(
    'BROWSER_RECORD_INVALID'
  );
});
