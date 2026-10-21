import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { RelaySocket } from './support/relay-socket.js';
import { WorkbenchRelayService } from '../../src/workbench-relay-service.js';

function fixture(expiresAt: number | null = null) {
  const relay = new WorkbenchRelayService({ database: { userOwnsNode: async () => true } });
  const validate = vi.fn(async () => true);
  const attach = (visitorId = 'visitor-one', shareId = 'share-one') => {
    const socket = new RelaySocket();
    relay.attach(
      socket as unknown as WebSocket,
      { userId: 1, sessionHash: shareId },
      {
        shareId,
        ownerUserId: 1,
        target: { nodeId: 'node-one', workspaceId: 'workspace-one', sessionId: 'session-one' },
        visitor: { visitorId },
        expiresAt,
        validate
      }
    );
    socket.receive({ type: 'resume' });
    const connectionId = String(socket.sent[0]!.workbenchConnectionId);
    return { socket, connectionId };
  };
  return { relay, validate, attach };
}

describe('Shared Session Workbench relay', () => {
  it('delivers only the bound Node lifecycle without owner metadata or unrelated broadcasts', async () => {
    const { relay, attach } = fixture();
    try {
      const { socket } = attach();
      relay.broadcast({ type: 'node', nodeId: 'other-node', connected: true });
      relay.broadcast({ type: 'node', nodeId: 'node-one', connected: 'invalid' });
      relay.broadcast({ type: 'notification', message: 'private' });
      relay.broadcast({
        type: 'node',
        nodeId: 'node-one',
        connected: false,
        privateMetadata: 'private'
      });
      relay.broadcast({
        type: 'node',
        nodeId: 'node-one',
        connected: true,
        reason: 'CONNECTION_REPLACED',
        privateMetadata: 'private'
      });
      await vi.waitFor(() =>
        expect(socket.sent.filter((message) => message.type === 'node')).toEqual([
          { type: 'node', nodeId: 'node-one', connected: false },
          { type: 'node', nodeId: 'node-one', connected: true, reason: 'CONNECTION_REPLACED' }
        ])
      );
      expect(JSON.stringify(socket.sent)).not.toContain('private');
    } finally {
      relay.close();
    }
  });

  it('does not release a Node lifecycle frame after revocation races its admission', async () => {
    const { relay, attach, validate } = fixture();
    try {
      const { socket } = attach();
      let finish!: (valid: boolean) => void;
      validate.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      relay.broadcast({ type: 'node', nodeId: 'node-one', connected: true });
      await vi.waitFor(() => expect(validate).toHaveBeenCalledOnce());
      relay.invalidateShare('share-one', 'SESSION_SHARE_NOT_FOUND');
      finish(true);
      await new Promise((resolve) => setImmediate(resolve));
      expect(socket.sent.filter((message) => message.type === 'node')).toEqual([]);
      expect(socket.sent.at(-1)).toMatchObject({
        type: 'session-share.invalidated',
        code: 'SESSION_SHARE_NOT_FOUND'
      });
    } finally {
      relay.close();
    }
  });

  it('isolates broadcasts and only delivers the bound Session Watch', async () => {
    const { relay, attach } = fixture();
    try {
      const { socket, connectionId } = attach();
      const count = socket.sent.length;
      relay.broadcast({ type: 'notification', message: 'private' });
      relay.sendUser(1, { type: 'notification', message: 'private' });
      expect(relay.hasUserConnection(1)).toBe(false);
      await new Promise((resolve) => setImmediate(resolve));
      expect(socket.sent).toHaveLength(count);
      const event = {
        type: 'watch.session.snapshot',
        nodeId: 'node-one',
        workspaceId: 'workspace-one',
        sessionId: 'session-one',
        workbenchConnectionId: connectionId
      };
      expect(await relay.sendConnection(connectionId, { type: 'watch.event', event })).toBe(
        'delivered'
      );
      expect(
        await relay.sendConnection(connectionId, {
          type: 'watch.event',
          event: { ...event, sessionId: 'other' }
        })
      ).toBe('authorization-revoked');
      expect(await relay.sendDirectConnection(connectionId, { type: 'direct.ready' })).toBe(
        'authorization-revoked'
      );
    } finally {
      relay.close();
    }
  });

  it('merges browser tabs by visitor across links for the same session', () => {
    const { relay, attach } = fixture();
    try {
      const first = attach();
      const second = attach();
      const third = attach('other-visitor');
      const otherLink = attach('visitor-one', 'share-two');
      const latest = () =>
        first.socket.sent.filter((message) => message.type === 'session-share.participants').at(-1);
      expect(latest()?.participants).toHaveLength(2);
      expect(otherLink.socket.sent.at(-1)?.participants).toHaveLength(2);
      second.socket.close();
      expect(latest()?.participants).toHaveLength(2);
      third.socket.close();
      expect(latest()?.participants).toHaveLength(1);
      expect(otherLink.socket.sent.at(-1)?.participants).toHaveLength(1);
    } finally {
      relay.close();
    }
  });

  it('prevents an already authorizing frame from escaping deletion and preserves other links', async () => {
    const { relay, attach, validate } = fixture();
    try {
      const first = attach();
      const other = attach('visitor-two', 'share-two');
      let finish!: (valid: boolean) => void;
      validate.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      const pending = relay.sendConnection(first.connectionId, {
        type: 'watch.event',
        event: {
          type: 'watch.session.snapshot',
          nodeId: 'node-one',
          workspaceId: 'workspace-one',
          sessionId: 'session-one',
          workbenchConnectionId: first.connectionId
        }
      });
      await vi.waitFor(() => expect(validate).toHaveBeenCalled());
      relay.invalidateShare('share-one', 'SESSION_SHARE_NOT_FOUND');
      finish(true);
      expect(await pending).not.toBe('delivered');
      expect(first.socket.sent.some((message) => message.type === 'watch.event')).toBe(false);
      expect(first.socket.sent.at(-1)).toMatchObject({
        type: 'session-share.invalidated',
        code: 'SESSION_SHARE_NOT_FOUND'
      });
      expect(other.socket.readyState).toBe(other.socket.OPEN);
    } finally {
      relay.close();
    }
  });

  it('invalidates an idle open share on expiration without polling or cancelling runs', async () => {
    vi.useFakeTimers();
    const { relay, attach } = fixture(Date.now() + 1000);
    try {
      const { socket } = attach();
      await vi.advanceTimersByTimeAsync(1001);
      expect(socket.close).toHaveBeenCalledWith(1000, 'SESSION_SHARE_EXPIRED');
      expect(socket.sent.at(-1)).toMatchObject({
        type: 'session-share.invalidated',
        code: 'SESSION_SHARE_EXPIRED'
      });
    } finally {
      relay.close();
      vi.useRealTimers();
    }
  });
});
