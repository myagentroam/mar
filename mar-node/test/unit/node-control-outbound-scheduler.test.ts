import { describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '../../../packages/protocol/src/index.js';
import { ControlOutboundScheduler } from '../../src/control-outbound-scheduler.js';

describe('Node control-channel outbound scheduling', () => {
  it('lets high-priority control responses bypass unsent Workbench events', async () => {
    const sent: Array<{ type: string; payload: unknown }> = [];
    let bufferedAmount = 300 * 1024;
    const socket = {
      OPEN: 1,
      readyState: 1,
      get bufferedAmount() {
        return bufferedAmount;
      },
      send(raw: string) {
        sent.push(JSON.parse(raw) as { type: string; payload: unknown });
      }
    };
    const scheduler = new ControlOutboundScheduler(() => socket);
    scheduler.enqueue(createEnvelope('workbench.event', { sequence: 1 }), 'normal');
    scheduler.enqueue(createEnvelope('node.response', { result: { ok: true } }), 'high');
    bufferedAmount = 0;

    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((entry) => entry.type)).toEqual(['node.response', 'workbench.event']);
  });

  it('reserves send-buffer space for later control responses while normal events are pending', async () => {
    const sent: string[] = [];
    let bufferedAmount = 300 * 1024;
    const socket = {
      readyState: 1,
      get bufferedAmount() {
        return bufferedAmount;
      },
      send(raw: string) {
        sent.push((JSON.parse(raw) as { type: string }).type);
      }
    };
    const scheduler = new ControlOutboundScheduler(() => socket);
    scheduler.enqueue(createEnvelope('workbench.event', { sequence: 1 }), 'normal');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sent).toEqual([]);

    scheduler.enqueue(createEnvelope('node.response', { result: { workspaces: [] } }), 'high');
    await vi.waitFor(() => expect(sent).toEqual(['node.response']));

    bufferedAmount = 0;
    await vi.waitFor(() => expect(sent).toEqual(['node.response', 'workbench.event']));
  });

  it('yields to the event loop between normal-event batches so later control responses outrank queued events', async () => {
    const sent: string[] = [];
    let bufferedAmount = 300 * 1024;
    const socket = {
      OPEN: 1,
      readyState: 1,
      get bufferedAmount() {
        return bufferedAmount;
      },
      send(raw: string) {
        const frame = JSON.parse(raw) as { type: string };
        sent.push(frame.type);
      }
    };
    const scheduler = new ControlOutboundScheduler(() => socket);
    for (let index = 0; index < 40; index += 1)
      scheduler.enqueue(createEnvelope('workbench.event', { sequence: index + 1 }), 'normal');
    setImmediate(() => {
      bufferedAmount = 0;
      scheduler.enqueue(createEnvelope('node.response', { result: {} }), 'high');
    });

    await vi.waitFor(() => expect(sent).toHaveLength(41));
    expect(sent.indexOf('node.response')).toBeLessThan(40);
  });

  it('reclaims a backlog and requests reconnection when the connection cannot send for too long', async () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const scheduler = new ControlOutboundScheduler(() => undefined, expired);
    scheduler.enqueue(createEnvelope('workbench.event', { sequence: 1 }), 'normal');

    await vi.advanceTimersByTimeAsync(30_000);

    expect(expired).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
