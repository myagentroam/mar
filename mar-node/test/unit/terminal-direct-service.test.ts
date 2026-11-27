import { decodeTerminalMessage, encodeTerminalMessage } from '@myagentroam/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalManager } from '../../src/terminal.js';
import { TerminalDirectService } from '../../src/service/terminal-direct-service.js';
import type { RTCPeerConnection } from 'node-datachannel/polyfill';
import { NodeStreamMux } from '@myagentroam/protocol/node-stream-mux';
import { readTerminalRecords, writeTerminalRecord } from '@myagentroam/protocol/terminal-stream';

const fingerprint = `sha-256 ${'AA:'.repeat(31)}AA`;
const command = {
  type: 'terminal.direct.prepare',
  directSessionId: 'session-12345678',
  transportSessionId: 'transport-1234',
  workbenchConnectionId: 'connection-1234',
  nodeGeneration: 'generation-1234',
  terminalId: 'terminal-a',
  afterSequence: 3,
  readonly: false,
  grant: 'a'.repeat(32),
  browserFingerprint: fingerprint,
  nodeFingerprint: fingerprint,
  openExpiresAt: 2_000_000,
  expiresAt: 2_000_000
} as const;

function fixture() {
  let now = 1_000_000;
  let listener: (frame: unknown) => void = () => undefined;
  const get = vi.fn(() => ({ state: 'RUNNING', workspaceId: null }));
  const authorizeAttach = vi.fn(() => ({
    attachmentId: 'attachment-a',
    frames: [
      {
        type: 'output',
        terminalId: 'terminal-a',
        sequence: 4,
        data: new TextEncoder().encode('replayed')
      }
    ]
  }));
  const acceptFrame = vi.fn(async () => undefined);
  const detach = vi.fn();
  const startCommand = vi.fn();
  const manager = {
    get,
    authorizeAttach,
    acceptFrame,
    releaseTransportAttachment: detach,
    setAttachmentBackpressure: () => undefined,
    startCommand,
    onFrame: (handler: (frame: unknown) => void) => {
      listener = handler;
      return () => (listener = () => undefined);
    }
  } as unknown as TerminalManager;
  const ready = vi.fn();
  const peer = {} as RTCPeerConnection;
  const service = new TerminalDirectService(
    manager,
    ready,
    () => true,
    () => now
  );
  return {
    service,
    peer,
    ready,
    get,
    authorizeAttach,
    acceptFrame,
    detach,
    startCommand,
    emitFrame: (frame: unknown) => listener(frame),
    advance: (ms: number) => (now += ms)
  };
}

describe('Node Terminal direct attachment', () => {
  it('consumes grants only on their bound ICE peer and revokes one stream without closing the carrier', async () => {
    const f = fixture();
    const client: NodeStreamMux = new NodeStreamMux({
      maxStreams: 4,
      send: async (frame): Promise<void> => node.receive(frame)
    });
    const node = new NodeStreamMux({
      maxStreams: 4,
      send: async (frame) => client.receive(frame),
      accept: async ({ grant }, signal) =>
        f.service.consume(command.transportSessionId, grant, signal)
    });
    try {
      expect(f.service.handle(command, () => f.peer)).toBe(true);
      expect(
        f.service.consume('other-transport', command.grant, new AbortController().signal)
      ).toBeUndefined();
      expect(f.authorizeAttach).not.toHaveBeenCalled();
      const stream = (await client.openStream({ kind: 'terminal', grant: command.grant }))!;
      const records = readTerminalRecords(stream);
      expect(decodeTerminalMessage((await records.next()).value)).toMatchObject({
        type: 'attach',
        terminalId: command.terminalId
      });
      expect(f.authorizeAttach).toHaveBeenCalledOnce();
      await expect(
        client.openStream({ kind: 'terminal', grant: command.grant })
      ).rejects.toMatchObject({ code: 'RESOURCE_DENIED' });
      await records.next(); // Replay after the application attachment record.
      f.service.handle(
        {
          type: 'terminal.direct.cancel',
          directSessionId: command.directSessionId,
          code: 'TERMINAL_NOT_AUTHORIZED'
        },
        () => f.peer
      );
      await expect(records.next()).rejects.toMatchObject({ code: 'RESOURCE_DENIED' });
      await vi.waitFor(() => expect(f.detach).toHaveBeenCalledOnce());
      expect(client.closed).toBe(false);
      const replacement = { ...command, grant: 'b'.repeat(32), directSessionId: 'other-session-1' };
      expect(f.service.handle(replacement, () => f.peer)).toBe(true);
      const next = await client.openStream({ kind: 'terminal', grant: replacement.grant });
      expect(next).toBeDefined();
      next?.close();
    } finally {
      client.disconnect();
      node.disconnect();
      f.service.dispose();
    }
  });

  it.each(['lease expiry', 'forbidden input', 'carrier loss'] as const)(
    'releases the writer after %s',
    async (failure) => {
      const f = fixture();
      const client: NodeStreamMux = new NodeStreamMux({
        maxStreams: 4,
        send: async (frame): Promise<void> => node.receive(frame)
      });
      const node = new NodeStreamMux({
        maxStreams: 4,
        send: async (frame) => client.receive(frame),
        accept: async ({ grant }, signal) =>
          f.service.consume(command.transportSessionId, grant, signal)
      });
      try {
        f.service.handle({ ...command, expiresAt: 1_001_000 }, () => f.peer);
        await expect(
          client.openStream({ kind: 'terminal', grant: 'b'.repeat(32) })
        ).rejects.toMatchObject({ code: 'RESOURCE_DENIED' });
        expect(f.authorizeAttach).not.toHaveBeenCalled();
        const stream = (await client.openStream({ kind: 'terminal', grant: command.grant }))!;
        const records = readTerminalRecords(stream);
        expect(decodeTerminalMessage((await records.next()).value)).toMatchObject({
          type: 'attach'
        });
        expect(decodeTerminalMessage((await records.next()).value)).toMatchObject({
          type: 'output',
          sequence: 4
        });
        expect(f.startCommand).toHaveBeenCalledOnce();
        expect(f.ready).toHaveBeenCalledWith(command.directSessionId, 'ATTACHED');
        if (failure === 'lease expiry') {
          f.advance(1_001);
          f.service.handle(
            {
              type: 'terminal.direct.heartbeat',
              directSessionId: command.directSessionId,
              expiresAt: 1_031_000
            },
            () => f.peer
          );
        } else if (failure === 'forbidden input') {
          await stream.write(
            writeTerminalRecord(
              encodeTerminalMessage({
                type: 'resize',
                terminalId: 'wrong-terminal',
                rows: 24,
                cols: 80
              })
            )
          );
          expect(f.acceptFrame).not.toHaveBeenCalled();
        } else {
          node.disconnect();
          client.disconnect();
        }
        await vi.waitFor(() => expect(f.detach).toHaveBeenCalledExactlyOnceWith('attachment-a'));
        expect(client.closed).toBe(failure === 'carrier loss');
      } finally {
        client.disconnect();
        node.disconnect();
        f.service.dispose();
      }
    }
  );
});
