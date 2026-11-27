import { describe, expect, it } from 'vitest';
import { decodeTerminalMessage, encodeTerminalMessage } from '../../src/byte-frame.js';
import { readTerminalRecords, writeTerminalRecord } from '../../src/terminal-stream.js';

describe('Terminal byte-stream records', () => {
  it('reads a split header and body followed by a coalesced exit record', async () => {
    const output = encodeTerminalMessage({
      type: 'output',
      terminalId: 'terminal',
      sequence: 1,
      data: Uint8Array.of(0, 255)
    });
    const exit = encodeTerminalMessage({ type: 'exit', terminalId: 'terminal', exitCode: 0 });
    const first = writeTerminalRecord(output);
    const second = writeTerminalRecord(exit);
    const records = await collect([
      first.subarray(0, 2),
      first.subarray(2, 7),
      Buffer.concat([first.subarray(7), second])
    ]);
    expect(records).toEqual([
      { type: 'output', terminalId: 'terminal', sequence: 1, data: Uint8Array.of(0, 255) },
      { type: 'exit', terminalId: 'terminal', exitCode: 0 }
    ]);
  });

  it('rejects invalid lengths and a truncated final record', async () => {
    await expect(collect([Uint8Array.of(255, 0, 0, 0)])).rejects.toThrow('TERMINAL_RECORD_INVALID');
    await expect(collect([Uint8Array.of(0, 0, 0, 2, 42)])).rejects.toThrow(
      'TERMINAL_RECORD_TRUNCATED'
    );
  });
});

async function collect(values: Uint8Array[]): Promise<Record<string, unknown>[]> {
  const records = [];
  for await (const record of readTerminalRecords(chunks(values)))
    records.push(decodeTerminalMessage(record));
  return records;
}

async function* chunks(values: Uint8Array[]): AsyncGenerator<Uint8Array> {
  yield* values;
}
