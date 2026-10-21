import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { createEnvelope } from '@myagentroam/protocol';
import { NodeRequestChannel } from '../../src/node-request-channel.js';

const user = { userId: 1, sessionHash: 'session-hash' };
function fixture() {
  const socket = { readyState: 1, OPEN: 1, send: vi.fn() };
  const channel = new NodeRequestChannel(() => socket as unknown as WebSocket);
  const request = () => JSON.parse(socket.send.mock.calls[0]![0] as string);
  return { channel, socket, request };
}

describe('common authorized Node request channel', () => {
  it('diagnoses waiter timeout and disconnect without treating either as Node cancellation', async () => {
    vi.useFakeTimers();
    const socket = { readyState: 1, OPEN: 1, send: vi.fn() };
    const log = vi.fn();
    const channel = new NodeRequestChannel(() => socket as unknown as WebSocket, log);
    try {
      const pending = channel.request('node-1', 'workspace.mcps.install', {}, user, 300_000);
      const frame = JSON.parse(socket.send.mock.calls[0]![0] as string);
      expect(
        frame.payload.userAuthorization.expiresAt - frame.payload.userAuthorization.issuedAt
      ).toBe(15_000);
      const timeoutAssertion = expect(pending).rejects.toMatchObject({
        message: 'NODE_REQUEST_TIMEOUT',
        upstreamRequestId: frame.id
      });
      await vi.advanceTimersByTimeAsync(300_000);
      await timeoutAssertion;
      expect(log).toHaveBeenCalledWith(
        'node.relay.request.failed',
        expect.objectContaining({
          operation: 'workspace.mcps.install',
          requestId: frame.id,
          error: 'NODE_REQUEST_TIMEOUT'
        })
      );
      channel.resolve(
        'node-1',
        createEnvelope('node.response', { result: { installations: [] } }, { replyTo: frame.id })
      );
      expect(log).toHaveBeenCalledTimes(1);

      const disconnected = channel.request('node-1', 'workspace.mcps.install', {}, user, 300_000);
      const disconnectedFrame = JSON.parse(socket.send.mock.calls.at(-1)![0] as string);
      const disconnectAssertion = expect(disconnected).rejects.toMatchObject({
        message: 'NODE_OFFLINE',
        upstreamRequestId: disconnectedFrame.id
      });
      channel.rejectNode('node-1', new Error('NODE_OFFLINE'));
      await disconnectAssertion;
      expect(log).toHaveBeenLastCalledWith(
        'node.relay.request.failed',
        expect.objectContaining({
          operation: 'workspace.mcps.install',
          requestId: disconnectedFrame.id,
          error: 'NODE_OFFLINE'
        })
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      channel.close();
      vi.useRealTimers();
    }
  });

  it('sends supervised upgrades over the v2 Node control envelope', async () => {
    const { channel, request } = fixture();
    try {
      const result = channel.request(
        'node-1',
        'node.upgrade.request',
        { targetVersion: '0.9.122' },
        user
      );
      const frame = request();
      expect(frame).toMatchObject({
        version: 2,
        type: 'node.request',
        payload: {
          operation: 'node.upgrade.request',
          data: { targetVersion: '0.9.122' },
          userAuthorization: { ...user, nodeId: 'node-1', operation: 'node.upgrade.request' }
        }
      });
      channel.resolve(
        'node-1',
        createEnvelope('node.response', { result: { status: 'ACCEPTED' } }, { replyTo: frame.id })
      );
      await expect(result).resolves.toEqual({ status: 'ACCEPTED' });
    } finally {
      channel.close();
    }
  });

  it('binds a short-lived authorization and correlates only the expected Node response', async () => {
    const { channel, request } = fixture();
    try {
      const result = channel.request('node-1', 'node.metrics', {}, user);
      const frame = request();
      expect(frame.payload.userAuthorization).toMatchObject({
        ...user,
        nodeId: 'node-1',
        operation: 'node.metrics',
        requestId: frame.id
      });
      expect(
        frame.payload.userAuthorization.expiresAt - frame.payload.userAuthorization.issuedAt
      ).toBe(15_000);
      channel.resolve(
        'node-2',
        createEnvelope('node.response', { result: 'wrong' }, { replyTo: frame.id })
      );
      channel.resolve(
        'node-1',
        createEnvelope('node.response', { result: { cpu: 2 } }, { replyTo: frame.id })
      );
      await expect(result).resolves.toEqual({ cpu: 2 });
    } finally {
      channel.close();
    }
  });

  it('preserves Node error semantics and request correlation', async () => {
    const { channel, request } = fixture();
    try {
      const result = channel.request('node-1', 'node.metrics', {}, user);
      const assertion = expect(result).rejects.toMatchObject({
        message: 'NODE_ACCESS_DENIED',
        publicMessage: 'The metric source denied access.',
        publicDetails: 'CPU metrics are unavailable.',
        upstreamRequestId: request().id
      });
      channel.resolve(
        'node-1',
        createEnvelope(
          'node.response',
          {
            error: 'NODE_ACCESS_DENIED',
            message: 'The metric source denied access.',
            details: 'CPU metrics are unavailable.'
          },
          { replyTo: request().id }
        )
      );
      await assertion;
    } finally {
      channel.close();
    }
  });

  it('forwards Git stderr and exit code with the Node request ID', async () => {
    const { channel, request } = fixture();
    try {
      const result = channel.request('node-1', 'workspace.change.diff', {}, user);
      const assertion = expect(result).rejects.toMatchObject({
        message: 'GIT_COMMAND_FAILED',
        publicDetails: "fatal: bad revision 'HEAD'",
        publicParameters: { gitExitCode: 128 },
        upstreamRequestId: request().id
      });
      channel.resolve(
        'node-1',
        createEnvelope(
          'node.response',
          {
            error: 'GIT_COMMAND_FAILED',
            message: 'Git command failed.',
            details: "fatal: bad revision 'HEAD'",
            parameters: { gitExitCode: 128 }
          },
          { replyTo: request().id }
        )
      );
      await assertion;
    } finally {
      channel.close();
    }
  });

  it.each([null, [], { error: 42 }, { error: 'FILE_NOT_FOUND' }])(
    'rejects malformed response %j instead of resolving success',
    async (payload) => {
      const { channel, request } = fixture();
      try {
        const result = channel.request('node-1', 'node.metrics', {}, user);
        const assertion = expect(result).rejects.toMatchObject({
          message: 'MESSAGE_INVALID',
          upstreamRequestId: request().id
        });
        channel.resolve(
          'node-1',
          createEnvelope('node.response', payload, { replyTo: request().id })
        );
        await assertion;
      } finally {
        channel.close();
      }
    }
  );

  it('preserves legacy empty success payloads for operations returning void', async () => {
    const { channel, request } = fixture();
    try {
      const result = channel.request('node-1', 'workspace.remove', {}, user);
      channel.resolve('node-1', createEnvelope('node.response', {}, { replyTo: request().id }));
      await expect(result).resolves.toBeUndefined();
    } finally {
      channel.close();
    }
  });

  it('cleans up timeout and refuses requests after shutdown', async () => {
    vi.useFakeTimers();
    const { channel } = fixture();
    try {
      const result = channel.request('node-1', 'node.metrics', {}, user, 50);
      const assertion = expect(result).rejects.toThrow('NODE_REQUEST_TIMEOUT');
      await vi.advanceTimersByTimeAsync(51);
      await assertion;
      channel.close();
      await expect(channel.request('node-1', 'node.metrics', {}, user)).rejects.toThrow(
        'NODE_CONTROL_CLOSED'
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      channel.close();
      vi.useRealTimers();
    }
  });

  it('rejects invalid identity, offline Nodes, send failure and disconnect without pending timers', async () => {
    const { channel, socket } = fixture();
    try {
      await expect(
        channel.request('node-1', 'node.metrics', {}, { userId: 0, sessionHash: '' })
      ).rejects.toThrow('USER_AUTHORIZATION_REQUIRED');
      expect(socket.send).not.toHaveBeenCalled();
      socket.readyState = 3;
      await expect(channel.request('node-1', 'node.metrics', {}, user)).rejects.toThrow(
        'NODE_OFFLINE'
      );
      socket.readyState = 1;
      socket.send.mockImplementationOnce(() => {
        throw new Error('NODE_SEND_FAILED');
      });
      await expect(channel.request('node-1', 'node.metrics', {}, user)).rejects.toThrow(
        'NODE_SEND_FAILED'
      );
      const result = channel.request('node-1', 'node.metrics', {}, user);
      const sent = JSON.parse(socket.send.mock.calls.at(-1)![0] as string);
      const assertion = expect(result).rejects.toMatchObject({
        message: 'NODE_OFFLINE',
        upstreamRequestId: sent.id
      });
      channel.rejectNode('node-1', new Error('NODE_OFFLINE'));
      await assertion;
    } finally {
      channel.close();
    }
  });

  it('settles requests even when a lifecycle observer throws', async () => {
    const { channel, request } = fixture();
    try {
      const observe = vi.fn((phase: string) => {
        if (phase !== 'requested') throw new Error('AUDIT_FAILED');
      });
      const result = channel.request('node-1', 'node.metrics', {}, user, 15_000, observe);
      const assertion = expect(result).rejects.toThrow('INTERNAL_ERROR');
      channel.resolve(
        'node-1',
        createEnvelope('node.response', { result: {} }, { replyTo: request().id })
      );
      await assertion;
      const interrupted = channel.request('node-1', 'node.metrics', {}, user, 15_000, observe);
      const interruptedAssertion = expect(interrupted).rejects.toThrow('NODE_OFFLINE');
      expect(() => channel.rejectNode('node-1', new Error('NODE_OFFLINE'))).not.toThrow();
      await interruptedAssertion;
    } finally {
      channel.close();
    }
  });
});
