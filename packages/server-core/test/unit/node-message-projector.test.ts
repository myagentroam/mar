import { createEnvelope } from '@myagentroam/protocol';
import { describe, expect, it, vi } from 'vitest';
import { NodeMessageProjector } from '../../src/node-message-projector.js';

describe('Node message projection boundaries', () => {
  it('still acknowledges and relays ordinary Workbench Run state events', () => {
    const send = vi.fn();
    const sendInvalid = vi.fn();
    const publish = vi.fn();
    const projector = new NodeMessageProjector({ relay: { publish } as never, send, sendInvalid });
    const socket = {} as never;
    const event = {
      sequence: 1,
      category: 'run',
      payload: { run: { id: 'run-1', status: 'RUNNING' } }
    };
    const envelope = createEnvelope('workbench.event', event);
    expect(projector.handles(envelope.type)).toBe(true);
    projector.project('node-1', socket, envelope);
    expect(sendInvalid).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      socket,
      'ack',
      { type: 'workbench.event', sequence: 1 },
      envelope.id
    );
    expect(publish).toHaveBeenCalledExactlyOnceWith({ nodeId: 'node-1', ...event });
  });

  it.each(['runs.reconcile', 'lease.reconcile', 'unknown.control.message'])(
    'does not claim or acknowledge %s regardless of its old payload shape',
    (type) => {
      const send = vi.fn();
      const sendInvalid = vi.fn();
      const publish = vi.fn();
      const notification = vi.fn();
      const recentRuns = vi.fn();
      const projector = new NodeMessageProjector({
        relay: { publish } as never,
        send,
        sendInvalid,
        notification,
        recentRuns
      });
      expect(projector.handles(type)).toBe(false);
      for (const payload of [
        { runIds: ['active-run', 'unknown-run'] },
        { runId: 'active-run', known: false },
        {}
      ]) {
        projector.project('node-1', {} as never, createEnvelope(type, payload));
      }
      expect(send).not.toHaveBeenCalled();
      expect(sendInvalid).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(notification).not.toHaveBeenCalled();
      expect(recentRuns).not.toHaveBeenCalled();
    }
  );
});
