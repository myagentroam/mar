import { EventEmitter } from 'node:events';
import {
  encodeNodeRelayHandshake,
  encodeNodeStreamFrame
} from '@myagentroam/protocol/node-stream-wire';
import { expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { NodeRelayChannel } from '../../src/node-relay-channel.js';

it('accounts for both relay legs and records backpressure without sending the rejected frame', async () => {
  const record = vi.fn();
  const backpressure = vi.fn();
  const channel = new NodeRelayChannel({
    admitNode: async () => () => true,
    maxStreams: { perClient: 1, perNode: 1 },
    maxBufferedBytes: 1_024,
    traffic: { record, backpressure }
  });
  const node = new Carrier();
  const client = new Carrier();
  try {
    channel.attachNode(node.socket);
    node.receive(
      encodeNodeRelayHandshake({
        type: 'RELAY_AUTH',
        nodeId: 'node',
        credential: 'fixture',
        controlBinding: 'binding'
      })
    );
    await vi.waitFor(() => expect(node.send).toHaveBeenCalledOnce());
    channel.attachClient(client.socket, 'node', async () => ({ grant: 'node-grant' }));
    const open = encodeNodeStreamFrame({
      type: 'OPEN',
      streamId: 1,
      kind: 'terminal',
      grant: 'client-grant'
    });
    client.receive(open);
    await vi.waitFor(() => expect(node.send).toHaveBeenCalledTimes(2));
    node.receive(encodeNodeStreamFrame({ type: 'OPENED', streamId: 1 }));
    record.mockClear();

    const toNode = encodeNodeStreamFrame({ type: 'DATA', streamId: 1, bytes: Uint8Array.of(1) });
    const toClient = encodeNodeStreamFrame({
      type: 'DATA',
      streamId: 1,
      bytes: Uint8Array.of(2, 3)
    });
    client.receive(toNode);
    node.receive(toClient);
    expect(record.mock.calls).toEqual([
      ['in', toNode.length],
      ['out', toNode.length],
      ['in', toClient.length],
      ['out', toClient.length]
    ]);

    client.bufferedAmount = 1_024;
    node.receive(toClient);
    expect(backpressure).toHaveBeenCalledExactlyOnceWith(1_024 + toClient.length);
    expect(client.readyState).toBe(3);
    expect(node.readyState).toBe(1);
    expect(client.send).toHaveBeenCalledTimes(3); // READY, OPENED, one DATA.
  } finally {
    channel.close();
  }
});

class Carrier extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  bufferedAmount = 0;
  readonly send = vi.fn();
  readonly ping = vi.fn();

  get socket(): WebSocket {
    return this as unknown as WebSocket;
  }

  receive(bytes: Uint8Array): void {
    this.emit('message', Buffer.from(bytes), true);
  }

  close(): void {
    this.terminate();
  }

  terminate(): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit('close');
  }
}
