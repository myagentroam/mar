import { describe, expect, it, vi } from 'vitest';
import type { TerminalManager } from '../../src/terminal.js';
import { TerminalDirectService } from '../../src/service/terminal-direct-service.js';
import type { RTCPeerConnection } from 'node-datachannel/polyfill';

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
    frames: [{ type: 'output', terminalId: 'terminal-a', sequence: 4, data: 'replayed' }]
  }));
  const acceptFrame = vi.fn(async () => undefined);
  const detach = vi.fn();
  const startCommand = vi.fn();
  const manager = {
    get,
    authorizeAttach,
    acceptFrame,
    detach,
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
  const channel = {
    readyState: 'open',
    bufferedAmount: 0,
    sent: [] as string[],
    onmessage: null as null | ((event: { data: string }) => void),
    onclose: null as null | (() => void),
    send(value: string) {
      this.sent.push(value);
    },
    close() {
      this.readyState = 'closed';
      this.onclose?.();
    }
  };
  const open = (grant = command.grant) =>
    service.open(
      'transport-1234',
      channel as unknown as RTCDataChannel,
      JSON.stringify({
        type: 'OPEN',
        directSessionId: command.directSessionId,
        grant
      })
    );
  return {
    service,
    peer,
    ready,
    get,
    authorizeAttach,
    acceptFrame,
    detach,
    channel,
    open,
    emitFrame: (frame: unknown) => listener(frame),
    advance: (ms: number) => (now += ms)
  };
}

describe('Node Terminal direct attachment', () => {
  it('waits for an authenticated OPEN before allocating a writer and replays output in order', async () => {
    const f = fixture();
    try {
      expect(f.service.handle(command, () => f.peer)).toBe(true);
      expect(f.ready).toHaveBeenCalledWith(command.directSessionId);
      expect(f.authorizeAttach).not.toHaveBeenCalled();
      f.open();
      expect(f.authorizeAttach).toHaveBeenCalledWith({
        terminalId: 'terminal-a',
        afterSequence: 3,
        readonly: false
      });
      expect(f.channel.sent.map((raw) => JSON.parse(raw).type)).toEqual(['ATTACHED', 'output']);
      await vi.waitFor(() =>
        expect(f.ready).toHaveBeenCalledWith(command.directSessionId, 'ATTACHED')
      );
      f.emitFrame({ type: 'output', terminalId: 'terminal-a', sequence: 5, data: 'live' });
      expect(JSON.parse(f.channel.sent.at(-1)!)).toMatchObject({ data: 'live', sequence: 5 });
      f.channel.onmessage?.({
        data: JSON.stringify({ type: 'input', terminalId: 'terminal-a', data: 'pwd\n' })
      });
      await vi.waitFor(() =>
        expect(f.acceptFrame).toHaveBeenCalledWith(
          'attachment-a',
          expect.objectContaining({ type: 'input', data: 'pwd\n' })
        )
      );
    } finally {
      f.service.dispose();
    }
    expect(f.detach).toHaveBeenCalledWith('attachment-a');
  });

  it('rejects another grant, a mismatched transport and a second OPEN', () => {
    const wrong = fixture();
    try {
      expect(wrong.service.handle(command, () => wrong.peer)).toBe(true);
      wrong.open('b'.repeat(32));
      expect(wrong.authorizeAttach).not.toHaveBeenCalled();
      expect(wrong.channel.readyState).toBe('closed');
    } finally {
      wrong.service.dispose();
    }
    const mismatched = fixture();
    try {
      mismatched.service.handle(command, () => mismatched.peer);
      mismatched.service.open(
        'transport-other',
        mismatched.channel as unknown as RTCDataChannel,
        JSON.stringify({
          type: 'OPEN',
          directSessionId: command.directSessionId,
          grant: command.grant
        })
      );
      expect(mismatched.authorizeAttach).not.toHaveBeenCalled();
    } finally {
      mismatched.service.dispose();
    }
  });

  it('stops the attachment on a revoked lease or forbidden input', async () => {
    const f = fixture();
    try {
      f.service.handle(command, () => f.peer);
      f.open();
      f.acceptFrame.mockRejectedValueOnce(new Error('TERMINAL_WRITE_DENIED'));
      f.channel.onmessage?.({
        data: JSON.stringify({ type: 'input', terminalId: 'terminal-a', data: 'oops' })
      });
      await vi.waitFor(() => expect(f.channel.readyState).toBe('closed'));
      expect(f.detach).toHaveBeenCalledWith('attachment-a');
    } finally {
      f.service.dispose();
    }
  });

  it('does not revive an expired writer with a late control heartbeat', () => {
    const f = fixture();
    try {
      f.service.handle({ ...command, expiresAt: 1_001_000 }, () => f.peer);
      f.open();
      f.advance(1_001);
      f.service.handle(
        {
          type: 'terminal.direct.heartbeat',
          directSessionId: command.directSessionId,
          expiresAt: 1_031_000
        },
        () => f.peer
      );
      expect(f.channel.readyState).toBe('closed');
      expect(f.detach).toHaveBeenCalledWith('attachment-a');
    } finally {
      f.service.dispose();
    }
  });

  it('detaches a failed DataChannel without interrupting Terminal output', () => {
    const f = fixture();
    try {
      f.service.handle(command, () => f.peer);
      f.open();
      f.channel.send = () => {
        throw new Error('channel closed during output');
      };
      expect(() =>
        f.emitFrame({
          type: 'output',
          terminalId: 'terminal-a',
          sequence: 5,
          data: 'live'
        })
      ).not.toThrow();
      expect(f.detach).toHaveBeenCalledWith('attachment-a');
    } finally {
      f.service.dispose();
    }
  });

  it('detaches on an invalid frame even if the error response cannot be sent', () => {
    const f = fixture();
    try {
      f.service.handle(command, () => f.peer);
      f.open();
      f.channel.send = () => {
        throw new Error('channel closed during error response');
      };
      expect(() =>
        f.channel.onmessage?.({ data: '{"type":"input","terminalId":"other"}' })
      ).not.toThrow();
      expect(f.channel.readyState).toBe('closed');
      expect(f.detach).toHaveBeenCalledWith('attachment-a');
    } finally {
      f.service.dispose();
    }
  });
});
