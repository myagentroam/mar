import { EventEmitter } from 'node:events';
import {
  decodeNodeRelayHandshake,
  decodeNodeStreamFrame,
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
    canWaitForNode: () => true,
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

it.each(['startup', 'data reconnect'])(
  'waits before READY during Node %s, then admits OPEN once',
  async (phase) => {
    const channel = relayChannel();
    try {
      if (phase === 'data reconnect') {
        const first = await attachNode(channel);
        first.terminate();
      }
      const client = new Carrier();
      const authorize = vi.fn(async () => ({ grant: 'node-grant' }));
      channel.attachClient(client.socket, 'node', authorize);
      expect(client.readyState).toBe(client.OPEN);
      expect(client.send).not.toHaveBeenCalled();
      expect(authorize).not.toHaveBeenCalled();

      const node = await attachNode(channel);
      expect(decodeNodeRelayHandshake(client.send.mock.calls[0]![0])).toEqual({
        type: 'RELAY_READY'
      });
      client.receive(openFrame());
      await vi.waitFor(() => expect(node.send).toHaveBeenCalledTimes(2));
      expect(decodeNodeStreamFrame(node.send.mock.calls[1]![0])).toMatchObject({
        type: 'OPEN',
        grant: 'node-grant'
      });
      expect(authorize).toHaveBeenCalledOnce();
    } finally {
      channel.close();
    }
  }
);

it('fails offline immediately and removes waiting admissions on deadline, disconnect or early OPEN', async () => {
  vi.useFakeTimers();
  let online = false;
  const channel = relayChannel(() => online);
  const authorize = vi.fn(async () => ({ grant: 'node-grant' }));
  try {
    const connect = () => {
      const client = new Carrier();
      channel.attachClient(client.socket, 'node', authorize);
      return client;
    };
    const offline = connect();
    expect(offline.close).toHaveBeenCalledWith(4004, 'NODE_OFFLINE');
    online = true;
    const early = connect();
    early.receive(openFrame());
    expect(early.close).toHaveBeenCalledWith(4002, 'NODE_RELAY_FRAME_INVALID');
    const disconnected = connect();
    channel.disconnectNode('node');
    expect(disconnected.close).toHaveBeenCalledWith(4004, 'NODE_OFFLINE');
    const cancelled = connect();
    cancelled.terminate();
    const expired = connect();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(expired.readyState).toBe(expired.OPEN);
    await vi.advanceTimersByTimeAsync(1);
    expect(expired.close).toHaveBeenCalledWith(4004, 'NODE_OFFLINE');

    await attachNode(channel);
    for (const client of [offline, early, disconnected, cancelled, expired])
      expect(client.send).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  } finally {
    channel.close();
    vi.useRealTimers();
  }
});

function relayChannel(canWaitForNode = () => true) {
  return new NodeRelayChannel({
    admitNode: async () => () => true,
    canWaitForNode,
    maxStreams: { perClient: 1, perNode: 1 },
    maxBufferedBytes: 1_024
  });
}

async function attachNode(channel: NodeRelayChannel) {
  const node = new Carrier();
  channel.attachNode(node.socket);
  node.receive(
    encodeNodeRelayHandshake({
      type: 'RELAY_AUTH',
      nodeId: 'node',
      credential: 'fixture',
      controlBinding: 'binding'
    })
  );
  await channel.drainAuthentications();
  return node;
}

function openFrame() {
  return encodeNodeStreamFrame({
    type: 'OPEN',
    streamId: 1,
    kind: 'terminal',
    grant: 'client-grant'
  });
}

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

  readonly close = vi.fn((_code?: number, _reason?: string) => this.terminate());

  terminate(): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit('close');
  }
}
