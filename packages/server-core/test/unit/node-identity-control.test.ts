import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { createEnvelope } from '@myagentroam/protocol';
import { describe, expect, it, vi } from 'vitest';
import { NodeIdentityControl } from '../../src/node-identity-control.js';
import { publicNode } from '../../src/node-projection.js';

class Socket extends EventEmitter {
  readyState = 1;
  OPEN = 1;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
    this.emit('close');
  });
  terminate = vi.fn(() => this.close());
  receive(type: string, payload: unknown) {
    this.emit('message', JSON.stringify(createEnvelope(type, payload)));
  }
}

function fixture() {
  const store = {
    registerNode: vi.fn(async () => undefined),
    authenticateNode: vi.fn(async () => ({
      id: 'node-1',
      ownerUserId: 1,
      displayName: null,
      registeredAddress: 'unknown',
      metadata: '{}',
      disabled: false,
      lastHeartbeatAt: null
    })),
    updateNodeHeartbeat: vi.fn(
      async (_nodeId: string, _capabilities?: { readonly metadata: string }) => undefined
    )
  };
  const control = new NodeIdentityControl(store);
  const attach = () => {
    const socket = new Socket();
    control.attach(socket as unknown as WebSocket);
    return socket;
  };
  return { store, control, attach };
}

describe('public Node identity connection lifecycle', () => {
  it('preserves the prompt completion capability through storage and public projection', async () => {
    const { control, store, attach } = fixture();
    try {
      const socket = attach();
      socket.receive('authenticate', { nodeId: 'node-1', credential: 'fixture' });
      await vi.waitFor(() => expect(control.isNodeConnected('node-1')).toBe(true));
      socket.receive('capabilities', {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: 'v24.15.0',
        nodeAppVersion: '0.10.21',
        codex: { available: false },
        claudeCode: { available: false },
        promptCompletion: { apiVersion: 1 }
      });
      await vi.waitFor(() => expect(store.updateNodeHeartbeat).toHaveBeenCalledTimes(2));
      const metadata = store.updateNodeHeartbeat.mock.calls[1]![1]!.metadata;
      const node = { ...(await store.authenticateNode()), metadata };
      expect(publicNode({ ...node, connected: true })).toMatchObject({
        capabilities: { promptCompletion: { apiVersion: 1 } }
      });
      socket.close();
      store.authenticateNode.mockResolvedValue(node);
      attach().receive('authenticate', { nodeId: 'node-1', credential: 'fixture' });
      await vi.waitFor(() =>
        expect(control.nodeCapabilities('node-1')?.promptCompletion).toEqual({ apiVersion: 1 })
      );
    } finally {
      control.close();
    }
  });

  it('persists and projects the local ChatGPT login capability across reconnection', async () => {
    const { control, store, attach } = fixture();
    const chatgptLogin = { apiVersion: 1, loopback: true };
    try {
      const socket = attach();
      socket.receive('authenticate', { nodeId: 'node-1', credential: 'fixture' });
      await vi.waitFor(() => expect(control.isNodeConnected('node-1')).toBe(true));
      socket.receive('capabilities', {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: 'v24.15.0',
        codex: { available: false },
        claudeCode: { available: false },
        chatgptLogin
      });
      await vi.waitFor(() => expect(store.updateNodeHeartbeat).toHaveBeenCalledTimes(2));
      const metadata = store.updateNodeHeartbeat.mock.calls[1]![1]!.metadata;
      expect(JSON.parse(metadata).chatgptLogin).toEqual(chatgptLogin);
      const node = { ...(await store.authenticateNode()), metadata };
      expect(publicNode({ ...node, connected: true })).toMatchObject({
        capabilities: { chatgptLogin }
      });
      socket.close();
      store.authenticateNode.mockResolvedValue(node);
      const next = attach();
      next.receive('authenticate', { nodeId: 'node-1', credential: 'fixture' });
      await vi.waitFor(() =>
        expect(control.nodeCapabilities('node-1')?.chatgptLogin).toEqual(chatgptLogin)
      );
      expect(
        publicNode({
          ...node,
          metadata: JSON.stringify({ ...JSON.parse(metadata), chatgptLogin: undefined }),
          connected: true
        })
      ).not.toHaveProperty('capabilities.chatgptLogin');
    } finally {
      control.close();
    }
  });

  it('atomically replaces the old connection and ignores all later messages from it', async () => {
    const { control, store, attach } = fixture();
    try {
      const old = attach();
      old.emit(
        'message',
        JSON.stringify({
          version: 2,
          id: 'older-node-auth',
          type: 'authenticate',
          payload: { nodeId: 'node-1', credential: 'fixture' }
        })
      );
      await vi.waitFor(() => expect(control.isNodeConnected('node-1')).toBe(true));
      expect(JSON.parse(old.send.mock.calls[0]![0])).toMatchObject({
        version: 2,
        type: 'authenticated',
        replyTo: 'older-node-auth'
      });
      const next = attach();
      next.receive('authenticate', { nodeId: 'node-1', credential: 'fixture' });
      await vi.waitFor(() =>
        expect(old.close).toHaveBeenCalledWith(4000, 'NODE_CONNECTION_REPLACED')
      );
      const writes = store.updateNodeHeartbeat.mock.calls.length;
      old.receive('heartbeat', {});
      await Promise.resolve();
      expect(store.updateNodeHeartbeat).toHaveBeenCalledTimes(writes);
      expect(control.isNodeConnected('node-1')).toBe(true);
      next.close();
      expect(control.isNodeConnected('node-1')).toBe(false);
    } finally {
      control.close();
    }
  });

  it('persists Computer Use capability updates in Node metadata', async () => {
    const { control, store, attach } = fixture();
    try {
      const socket = attach();
      socket.receive('authenticate', { nodeId: 'node-1', credential: 'fixture' });
      await vi.waitFor(() => expect(control.isNodeConnected('node-1')).toBe(true));
      socket.receive('capabilities', {
        platform: 'windows',
        architecture: 'x64',
        nodeAppVersion: '0.9.95',
        nodeVersion: 'v24.15.0',
        codex: { available: false },
        claudeCode: { available: false },
        computerUse: {
          apiVersion: 1,
          enabled: true,
          state: 'AVAILABLE',
          backend: 'PYAUTOGUI',
          supportsScreenshot: true,
          supportsInput: true,
          supportsUnicodePaste: true,
          supportsPrimaryDisplay: true,
          measuredAt: 1
        }
      });
      await vi.waitFor(() => expect(store.updateNodeHeartbeat).toHaveBeenCalledTimes(2));
      const capabilityCall = store.updateNodeHeartbeat.mock.calls[1];
      expect(capabilityCall).toBeDefined();
      const persisted = JSON.parse(capabilityCall![1]!.metadata);
      expect(persisted.computerUse).toEqual({
        apiVersion: 1,
        enabled: true,
        state: 'AVAILABLE',
        backend: 'PYAUTOGUI',
        supportsScreenshot: true,
        supportsInput: true,
        supportsUnicodePaste: true,
        supportsPrimaryDisplay: true,
        measuredAt: 1
      });
    } finally {
      control.close();
    }
  });

  it('never binds a socket that closed while authentication was awaiting storage', async () => {
    const { control, store, attach } = fixture();
    let finish!: (value: Awaited<ReturnType<typeof store.authenticateNode>>) => void;
    const original = await store.authenticateNode();
    store.authenticateNode.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    try {
      const socket = attach();
      socket.receive('authenticate', { nodeId: 'node-1', credential: 'fixture' });
      socket.close();
      finish(original);
      await Promise.resolve();
      await Promise.resolve();
      expect(control.isNodeConnected('node-1')).toBe(false);
    } finally {
      control.close();
    }
  });

  it('allows only one identity per socket and catches storage failures', async () => {
    const { control, store, attach } = fixture();
    try {
      const socket = attach();
      socket.receive('authenticate', { nodeId: 'node-1', credential: 'fixture' });
      await vi.waitFor(() => expect(control.isNodeConnected('node-1')).toBe(true));
      socket.receive('authenticate', { nodeId: 'other-node', credential: 'fixture' });
      await Promise.resolve();
      expect(store.authenticateNode).toHaveBeenCalledTimes(1);
      store.authenticateNode.mockRejectedValueOnce(new Error('DATABASE_UNAVAILABLE'));
      const failing = attach();
      failing.receive('authenticate', { nodeId: 'node-1', credential: 'fixture' });
      await vi.waitFor(() => expect(failing.send).toHaveBeenCalled());
      expect(JSON.parse(failing.send.mock.calls[0]![0]).type).toBe('error');
    } finally {
      control.close();
    }
  });

  it('cancels authentication already in flight when that Node is revoked', async () => {
    const { control, store, attach } = fixture();
    const identity = await store.authenticateNode();
    let finish!: (value: typeof identity) => void;
    store.authenticateNode.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    try {
      const socket = attach();
      socket.receive('authenticate', { nodeId: 'node-1', credential: 'fixture' });
      control.closeNode('node-1', 4003, 'NODE_DISABLED');
      finish(identity);
      await Promise.resolve();
      await Promise.resolve();
      expect(socket.close).toHaveBeenCalledWith(4003, 'NODE_DISABLED');
      expect(control.isNodeConnected('node-1')).toBe(false);
    } finally {
      control.close();
    }
  });

  it('refuses new attachments after shutdown and correlates storage failures', async () => {
    const { control, store, attach } = fixture();
    try {
      store.authenticateNode.mockRejectedValueOnce(new Error('DATABASE_UNAVAILABLE'));
      const socket = attach();
      const envelope = createEnvelope('authenticate', { nodeId: 'node-1', credential: 'fixture' });
      socket.emit('message', JSON.stringify(envelope));
      await vi.waitFor(() => expect(socket.send).toHaveBeenCalled());
      expect(JSON.parse(socket.send.mock.calls[0]![0]).replyTo).toBe(envelope.id);
      control.close();
      const late = attach();
      late.receive('authenticate', { nodeId: 'node-1', credential: 'fixture' });
      expect(store.authenticateNode).toHaveBeenCalledTimes(1);
      expect(late.close).toHaveBeenCalledWith(1001, 'SERVER_SHUTDOWN');
    } finally {
      control.close();
    }
  });
});
