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
  it('serializes an old v2 metadata write with replacement authentication and v3 capabilities', async () => {
    const { control, store, attach } = fixture();
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let metadata = '{}';
    store.updateNodeHeartbeat.mockImplementation(async (_id, capabilities) => {
      if (capabilities?.metadata.includes('0.11.37')) {
        started();
        await blocked;
      }
      if (capabilities) metadata = capabilities.metadata;
    });
    const old = attach();
    const replacement = attach();
    try {
      old.emit(
        'message',
        JSON.stringify({
          version: 2,
          id: 'old-auth',
          type: 'authenticate',
          payload: { nodeId: 'node-1', credential: 'fixture' }
        })
      );
      await vi.waitFor(() => expect(control.isNodeConnected('node-1')).toBe(true));
      old.emit(
        'message',
        JSON.stringify({
          version: 2,
          id: 'old-cap',
          type: 'capabilities',
          payload: {
            platform: 'linux',
            architecture: 'x64',
            nodeVersion: 'v24',
            nodeAppVersion: '0.11.37'
          }
        })
      );
      await entered;
      replacement.receive('authenticate', { nodeId: 'node-1', credential: 'fixture' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(replacement.send).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(replacement.send).toHaveBeenCalled());
      replacement.receive('capabilities', {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: 'v24',
        nodeAppVersion: '0.11.38',
        codex: { available: false },
        claudeCode: { available: false }
      });
      await vi.waitFor(() => expect(JSON.parse(metadata).nodeAppVersion).toBe('0.11.38'));
      expect(control.nodeCapabilities('node-1')?.nodeAppVersion).toBe('0.11.38');
    } finally {
      release();
      control.close();
    }
  });
  it('does not admit a reconnect from the previous connection’s persisted version', async () => {
    const { control, store, attach } = fixture();
    const capabilities = {
      platform: 'linux',
      architecture: 'x64',
      nodeVersion: 'v24.15.0',
      nodeAppVersion: '0.11.38',
      codex: { available: false },
      claudeCode: { available: false }
    };
    store.authenticateNode.mockResolvedValue({
      ...(await store.authenticateNode()),
      metadata: JSON.stringify(capabilities)
    });
    const socket = attach();
    try {
      socket.receive('authenticate', { nodeId: 'node-1', credential: 'fixture' });
      await vi.waitFor(() => expect(control.isNodeConnected('node-1')).toBe(true));
      expect(control.isNodeUpgradeOnly('node-1')).toBe(true);
      socket.receive('capabilities', { ...capabilities, nodeAppVersion: '0.11.36' });
      await vi.waitFor(() => expect(store.updateNodeHeartbeat).toHaveBeenCalledTimes(2));
      expect(control.isNodeUpgradeOnly('node-1')).toBe(true);
    } finally {
      control.close();
    }
  });
  it('terminates sockets that cannot close and retains failed terminations for retry', () => {
    const { control, attach } = fixture();
    const first = attach();
    const second = attach();
    const closeFailure = new Error('CLOSE_FAILED');
    const terminateFailure = new Error('TERMINATE_FAILED');
    first.close.mockImplementationOnce(() => {
      throw closeFailure;
    });
    first.terminate.mockImplementationOnce(() => {
      throw terminateFailure;
    });

    let failure: unknown;
    try {
      control.close();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([closeFailure, terminateFailure]);
    expect((failure as AggregateError).cause).toBe(closeFailure);
    expect(first.terminate).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    control.close();
    expect(first.close).toHaveBeenCalledTimes(2);
    expect(first.readyState).toBe(3);
  });

  it('closes every socket even when a Node disconnect callback fails', async () => {
    const { control, store, attach } = fixture();
    const first = attach();
    const second = attach();
    first.receive('authenticate', { nodeId: 'node-1', credential: 'fixture' });
    await vi.waitFor(() => expect(control.isNodeConnected('node-1')).toBe(true));
    const node = await store.authenticateNode();
    store.authenticateNode.mockResolvedValue({ ...node, id: 'node-2' });
    second.receive('authenticate', { nodeId: 'node-2', credential: 'fixture' });
    await vi.waitFor(() => expect(control.isNodeConnected('node-2')).toBe(true));
    const failure = new Error('DISCONNECT_FAILED');
    const disconnected = vi.spyOn(
      control as unknown as { onNodeDisconnected(nodeId: string): void },
      'onNodeDisconnected'
    );
    disconnected.mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => control.close()).toThrow(failure);
    expect(disconnected).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalledWith(1001, 'SERVER_SHUTDOWN');
    expect(second.close).toHaveBeenCalledWith(1001, 'SERVER_SHUTDOWN');
    expect(control.isNodeConnected('node-1')).toBe(false);
    expect(control.isNodeConnected('node-2')).toBe(false);
  });

  it('keeps an authenticated v2 socket on the upgrade control plane', async () => {
    const { control, store, attach } = fixture();
    try {
      const socket = attach();
      const sendV2 = (id: string, type: string, payload: unknown) =>
        socket.emit('message', JSON.stringify({ version: 2, id, type, payload }));
      sendV2('auth', 'authenticate', { nodeId: 'node-1', credential: 'fixture' });
      await vi.waitFor(() => expect(control.isNodeConnected('node-1')).toBe(true));
      expect(JSON.parse(socket.send.mock.calls[0]![0])).toMatchObject({
        version: 2,
        type: 'authenticated',
        replyTo: 'auth'
      });
      sendV2('caps', 'capabilities', {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: 'v24.15.0',
        nodeAppVersion: '0.11.37',
        metadata: { supervisedUpgrade: true },
        marAgentRuntimeCredentials: {
          apiVersion: 1,
          websocket: true,
          httpVersions: ['1.1'],
          fastMode: true
        },
        codex: { available: false },
        claudeCode: { available: false }
      });
      await vi.waitFor(() => expect(store.updateNodeHeartbeat).toHaveBeenCalledTimes(2));
      expect(JSON.parse(store.updateNodeHeartbeat.mock.calls[1]![1]!.metadata)).toMatchObject({
        nodeAppVersion: '0.11.37',
        supervisedUpgrade: true
      });
      expect(control.nodeCapabilities('node-1')).toBeUndefined();
      expect(control.sendAuthenticatedNode('node-1', 'workbench.request', {})).toBe(false);
      sendV2('beat', 'heartbeat', {});
      await vi.waitFor(() =>
        expect(socket.send.mock.calls.map(([value]) => JSON.parse(value))).toContainEqual(
          expect.objectContaining({ version: 2, type: 'ack', replyTo: 'beat' })
        )
      );
      const writes = store.updateNodeHeartbeat.mock.calls.length;
      sendV2('business', 'workbench.event', { arbitrary: true });
      await vi.waitFor(() =>
        expect(socket.send.mock.calls.map(([value]) => JSON.parse(value))).toContainEqual(
          expect.objectContaining({ version: 2, type: 'error' })
        )
      );
      expect(store.updateNodeHeartbeat).toHaveBeenCalledTimes(writes);
    } finally {
      control.close();
    }
  });

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
        nodeAppVersion: '0.11.38',
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
      const next = attach();
      next.receive('authenticate', { nodeId: 'node-1', credential: 'fixture' });
      await vi.waitFor(() => expect(control.isNodeConnected('node-1')).toBe(true));
      expect(control.nodeCapabilities('node-1')).toBeUndefined();
      next.receive('capabilities', JSON.parse(metadata));
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
        nodeAppVersion: '0.11.38',
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
      await vi.waitFor(() => expect(control.isNodeConnected('node-1')).toBe(true));
      expect(control.nodeCapabilities('node-1')).toBeUndefined();
      next.receive('capabilities', JSON.parse(metadata));
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
