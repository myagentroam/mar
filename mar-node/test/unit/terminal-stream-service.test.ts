import { describe, expect, it } from 'vitest';
import { decodeTerminalMessage, encodeTerminalMessage } from '@myagentroam/protocol';
import { NodeStreamMux } from '@myagentroam/protocol/node-stream-mux';
import { readTerminalRecords, writeTerminalRecord } from '@myagentroam/protocol/terminal-stream';
import { TerminalManager } from '../../src/terminal.js';
import { TerminalService } from '../../src/service/terminal-service.js';

describe('Terminal stream attachments', () => {
  it.skipIf(process.platform !== 'linux')(
    'claims a grant once, transfers binary input and drains output before exit',
    async () => {
      const manager = new TerminalManager({
        platform: 'linux',
        profiles: [{ id: 'default', label: 'sh', shell: '/bin/sh', args: [], isDefault: true }]
      });
      const terminal = manager.openCommand({}, 'cat; exit 17');
      const terminalService = new TerminalService(() => {
        throw new Error('Unexpected database access');
      }, manager);
      const service = terminalService.streams;
      const client = new NodeStreamMux({
        maxStreams: 4,
        async send(bytes) {
          node.receive(bytes);
        }
      });
      const node = new NodeStreamMux({
        maxStreams: 4,
        accept: async ({ kind, grant }) =>
          kind === 'terminal' ? service.consume(grant) : undefined,
        async send(bytes) {
          client.receive(bytes);
        }
      });

      try {
        const prepared = await terminalService.operations()['terminal.attach.authorize']!({
          terminalId: terminal.id,
          afterSequence: 0,
          readonly: false,
          closeOnDisconnect: true
        });
        expect(prepared).toEqual({ grant: expect.any(String) });
        const { grant } = prepared as { grant: string };
        const request = { kind: 'terminal', grant };
        const stream = await client.openStream(request);
        if (!stream) throw new Error('Missing test stream');
        const records = readTerminalRecords(stream);
        const attached = await records.next();
        expect(decodeTerminalMessage(attached.value)).toEqual({
          type: 'attach',
          terminalId: terminal.id,
          afterSequence: 0
        });
        await expect(client.openStream(request)).rejects.toThrow('RESOURCE_DENIED');
        const data = Uint8Array.of(0, 255, 42, 13);
        for (const frame of [
          { type: 'input', terminalId: terminal.id, data },
          { type: 'eof', terminalId: terminal.id }
        ]) {
          await stream.write(writeTerminalRecord(encodeTerminalMessage(frame)));
        }
        await stream.endWrite();
        const frames = [];
        for await (const record of records) frames.push(decodeTerminalMessage(record));
        expect(frames.at(-1)).toEqual({ type: 'exit', terminalId: terminal.id, exitCode: 17 });
        expect(Buffer.concat(frames.slice(0, -1).map((frame) => frame.data as Uint8Array))).toEqual(
          Buffer.from(data)
        );
      } finally {
        client.disconnect();
        node.disconnect();
        service.clear();
        await manager.shutdown();
      }
    }
  );
});
