import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createEnvelope, type NodeCapabilities } from '@myagentroam/protocol';
import { describe, expect, it, vi } from 'vitest';
import { NodeControlChannel } from '../../src/service/node-control-channel.js';

describe('Node control authentication', () => {
  it('mutes inbound work during cleanup while retaining the outgoing control channel', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const capabilities: NodeCapabilities = {
      platform: 'linux',
      architecture: 'x64',
      nodeAppVersion: '1',
      nodeVersion: '1',
      codex: { available: false },
      claudeCode: { available: false }
    };
    const onMessage = vi.fn();
    const connection = once(server, 'connection');
    const channel = new NodeControlChannel({
      config: () => ({
        serverUrl: `http://127.0.0.1:${address.port}`,
        nodeId: 'node',
        credential: 'fixture',
        allowedRoots: []
      }),
      capabilities: () => capabilities,
      stopped: () => false,
      reconnect: false,
      reconnectDelay: () => 0,
      onConnecting: vi.fn(),
      onReconnectScheduled: vi.fn(),
      onMessage,
      onClose: vi.fn()
    });
    try {
      channel.connect();
      const [socket] = await connection;
      await once(socket, 'message'); // authenticate
      const capabilitiesMessage = once(socket, 'message');
      expect(channel.ready(capabilities)).toBe(true);
      await capabilitiesMessage;
      socket.send('before');
      await vi.waitFor(() => expect(onMessage).toHaveBeenCalledWith('before'));
      channel.muteInbound();
      socket.send('must-not-admit');
      const pong = once(socket, 'pong');
      socket.ping();
      await pong; // The prior frame was read on the same ordered connection.
      expect(onMessage).toHaveBeenCalledTimes(1);
      const closed = once(socket, 'message');
      channel.send('desktop.direct.closed', {
        attachmentId: 'test',
        code: 'DESKTOP_BACKEND_CLOSED'
      });
      const [raw] = await closed;
      expect(JSON.parse(raw.toString()).type).toBe('desktop.direct.closed');
    } finally {
      channel.stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('closes a connection that accumulates too many frames before authentication', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const connection = once(server, 'connection');
    const channel = new NodeControlChannel({
      config: () => ({
        serverUrl: `http://127.0.0.1:${address.port}`,
        nodeId: 'node',
        credential: 'fixture',
        allowedRoots: []
      }),
      capabilities: () => ({
        platform: 'linux',
        architecture: 'x64',
        nodeAppVersion: '0.11.38',
        nodeVersion: 'v24',
        codex: { available: false },
        claudeCode: { available: false }
      }),
      stopped: () => false,
      reconnect: false,
      reconnectDelay: () => 0,
      onConnecting: vi.fn(),
      onReconnectScheduled: vi.fn(),
      onMessage: vi.fn(),
      onClose: vi.fn()
    });
    try {
      channel.connect();
      const [socket] = await connection;
      await once(socket, 'message');
      const closed = once(socket, 'close');
      for (let i = 0; i < 1025; i++) channel.send('heartbeat', {});
      const [code] = await closed;
      expect(code).toBe(1013);
      expect(channel.connected()).toBe(false);
    } finally {
      channel.stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('holds heartbeat and business events until authentication and sends capabilities first', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const capabilities: NodeCapabilities = {
      platform: 'linux',
      architecture: 'x64',
      nodeAppVersion: '0.11.38',
      nodeVersion: 'v24',
      codex: { available: false },
      claudeCode: { available: false }
    };
    const received: string[] = [];
    const connection = once(server, 'connection');
    const channel = new NodeControlChannel({
      config: () => ({
        serverUrl: `http://127.0.0.1:${address.port}`,
        nodeId: 'node',
        credential: 'fixture',
        allowedRoots: []
      }),
      capabilities: () => capabilities,
      stopped: () => false,
      reconnect: false,
      reconnectDelay: () => 0,
      onConnecting: vi.fn(),
      onReconnectScheduled: vi.fn(),
      onMessage: (raw: string) => {
        if (JSON.parse(raw).type === 'authenticated') channel.ready(capabilities);
      },
      onClose: vi.fn()
    });
    try {
      channel.connect();
      const [socket] = await connection;
      socket.on('message', (raw: Buffer) => received.push(JSON.parse(raw.toString()).type));
      await vi.waitFor(() => expect(received).toEqual(['authenticate']));
      channel.send('heartbeat', {});
      channel.send('workbench.event', { type: 'fixture' });
      channel.send('capabilities', { ...capabilities, nodeAppVersion: '0.11.36' });
      expect(channel.connected()).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(received).toEqual(['authenticate']);
      socket.send(JSON.stringify(createEnvelope('authenticated', { nodeId: 'node' })));
      await vi.waitFor(() =>
        expect(received).toEqual(['authenticate', 'capabilities', 'heartbeat', 'workbench.event'])
      );
      expect(channel.connected()).toBe(true);
    } finally {
      channel.stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
