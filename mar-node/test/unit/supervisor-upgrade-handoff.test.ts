import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupervisorUpgradeHandoff } from '../../src/service/supervisor-upgrade-handoff.js';

afterEach(() => vi.useRealTimers());

describe('Supervisor upgrade handoff', () => {
  it('requires a real parent handshake and an explicit acknowledgement', async () => {
    const parent = new EventEmitter() as EventEmitter & {
      connected: boolean;
      send: ReturnType<
        typeof vi.fn<(message: unknown, callback: (error: Error | null) => void) => boolean>
      >;
    };
    parent.connected = true;
    parent.send = vi.fn(() => true);
    const handoff = new SupervisorUpgradeHandoff(parent);
    try {
      const ready = handoff.handshake();
      const hello = parent.send.mock.calls[0]![0] as { channelId: string };
      parent.emit('message', { type: 'node-upgrade-ready', channelId: hello.channelId });
      expect(await ready).toBe(true);
      const accepted = handoff.handoff({
        attemptId: 'attempt',
        targetVersion: '1.2.3',
        credential: 'secret'
      });
      const sent = parent.send.mock.calls[1]![0] as { id: string };
      parent.emit('message', {
        type: 'node-upgrade-ack',
        channelId: hello.channelId,
        id: sent.id,
        accepted: true
      });
      await expect(accepted).resolves.toBeUndefined();
    } finally {
      handoff.close();
    }
  });

  it('treats a missing handoff acknowledgement as uncertain and does not resend', async () => {
    vi.useFakeTimers();
    const parent = new EventEmitter() as EventEmitter & {
      connected: boolean;
      send: ReturnType<
        typeof vi.fn<(message: unknown, callback: (error: Error | null) => void) => boolean>
      >;
    };
    parent.connected = true;
    parent.send = vi.fn(() => true);
    const handoff = new SupervisorUpgradeHandoff(parent);
    try {
      const ready = handoff.handshake();
      const hello = parent.send.mock.calls[0]![0] as { channelId: string };
      parent.emit('message', { type: 'node-upgrade-ready', channelId: hello.channelId });
      await ready;
      const result = handoff.handoff({
        attemptId: 'attempt',
        targetVersion: '1.2.3',
        credential: 'secret'
      });
      const rejected = expect(result).rejects.toThrow('NODE_UPGRADE_HANDOFF_UNCERTAIN');
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(parent.send).toHaveBeenCalledTimes(2);
    } finally {
      handoff.close();
    }
  });
});
