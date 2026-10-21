import { RelaySocket as Socket } from './support/relay-socket.js';
import type { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { WorkbenchRelayService } from '../../src/workbench-relay-service.js';

function fixture() {
  const database = {
    userOwnsNode: vi.fn(async () => true),
    userCanRequestNode: vi.fn(async () => true)
  };
  const relay = new WorkbenchRelayService({ database });
  const attach = (sessionHash = 'session-one', resume = {}) => {
    const socket = new Socket();
    relay.attach(socket as unknown as WebSocket, { userId: 1, sessionHash });
    socket.receive({ ...resume, type: 'resume' });
    return socket;
  };
  return { relay, database, attach };
}

describe('public page-level Workbench relay', () => {
  it('counts only ready open browser sockets for the specified user, not resumable records', () => {
    const { relay, attach } = fixture();
    const pending = new Socket();
    try {
      relay.attach(pending as unknown as WebSocket, { userId: 1, sessionHash: 'pending' });
      expect(relay.hasUserConnection(1)).toBe(false);
      const first = attach('first');
      const second = attach('second');
      expect(relay.hasUserConnection(1)).toBe(true);
      expect(relay.hasUserConnection(2)).toBe(false);
      first.close();
      expect(relay.hasUserConnection(1)).toBe(true);
      second.close();
      expect(relay.hasUserConnection(1)).toBe(false);
      expect(relay.ownsConnection('second', String(second.sent[0]?.workbenchConnectionId))).toBe(
        true
      );
      pending.receive({ type: 'resume' });
      expect(relay.hasUserConnection(1)).toBe(true);
      relay.closeSession('pending');
      expect(relay.hasUserConnection(1)).toBe(false);
    } finally {
      relay.close();
    }
  });

  it('does not suppress Push for a browser socket that is no longer OPEN before close arrives', () => {
    const { relay, attach } = fixture();
    try {
      const socket = attach();
      expect(relay.hasUserConnection(1)).toBe(true);
      socket.readyState = 2;
      expect(relay.hasUserConnection(1)).toBe(false);
    } finally {
      relay.close();
    }
  });

  it('accepts only strict direct control frames after resume and preserves logical identity', async () => {
    const { relay, attach } = fixture();
    const direct = vi.fn(async () => undefined);
    relay.setDirectTransferHandler({ message: direct });
    try {
      const socket = attach();
      const ready = socket.sent[0]!;
      socket.receive({
        type: 'direct.prepare',
        requestId: 'request-0001',
        nodeId: 'node-1',
        nodeGeneration: 'generation-1',
        purpose: 'TRANSPORT'
      });
      await vi.waitFor(() => expect(direct).toHaveBeenCalled());
      expect(direct).toHaveBeenCalledWith(
        {
          userId: 1,
          sessionHash: 'session-one',
          workbenchConnectionId: ready.workbenchConnectionId
        },
        expect.objectContaining({ type: 'direct.prepare', nodeId: 'node-1' })
      );
      socket.receive({
        type: 'direct.prepare',
        requestId: 'too-short',
        nodeId: 'node-1',
        nodeGeneration: 'bad space',
        purpose: 'TRANSPORT'
      });
      expect(socket.close).toHaveBeenCalledWith(4002, 'WORKBENCH_MESSAGE_INVALID');
    } finally {
      relay.close();
    }
  });

  it('revokes sockets awaiting their first resume before they can create a logical connection', () => {
    const { relay } = fixture();
    const socket = new Socket();
    try {
      relay.attach(socket as unknown as WebSocket, { userId: 1, sessionHash: 'pending-session' });
      relay.closeSession('pending-session');
      socket.receive({ type: 'resume' });
      expect(socket.sent).toEqual([]);
      expect(socket.close).toHaveBeenCalledWith(1000, 'USER_SESSION_CLOSED');
    } finally {
      relay.close();
    }
  });

  it('revocation during disconnected grace invalidates the old logical identity', () => {
    const { relay, attach } = fixture();
    try {
      const first = attach();
      const ready = first.sent[0]!;
      first.close();
      expect(relay.ownsConnection('session-one', String(ready.workbenchConnectionId))).toBe(true);
      relay.closeSession('session-one');
      expect(relay.ownsConnection('session-one', String(ready.workbenchConnectionId))).toBe(false);
      const next = attach('session-one', ready);
      expect(next.sent[0]?.resumed).toBe(false);
      expect(next.sent[0]?.workbenchConnectionId).not.toBe(ready.workbenchConnectionId);
    } finally {
      relay.close();
    }
  });

  it('Hosted Watch uses only its independent template authorization', async () => {
    const { relay, database, attach } = fixture();
    try {
      const socket = attach();
      const id = String(socket.sent[0]!.workbenchConnectionId);
      const authorize = vi.fn(async () => true);
      relay.setHostedConversationAuthorization(authorize);
      database.userCanRequestNode.mockResolvedValue(false);
      database.userOwnsNode.mockResolvedValue(false);
      const event = {
        type: 'watch.hosted-conversation.snapshot',
        nodeId: 'node-1',
        templateId: 'template-1',
        conversationId: 'conversation-1'
      };
      expect(await relay.sendConnection(id, { type: 'watch.event', event })).toBe('delivered');
      expect(authorize).toHaveBeenCalledWith(1, 'node-1', 'template-1');
      authorize.mockResolvedValue(false);
      expect(await relay.sendConnection(id, { type: 'watch.event', event })).toBe(
        'authorization-revoked'
      );
      expect(
        await relay.sendConnection(id, { type: 'watch.event', event: { ...event, templateId: '' } })
      ).toBe('authorization-revoked');
      expect(database.userCanRequestNode).not.toHaveBeenCalled();
      expect(database.userOwnsNode).not.toHaveBeenCalled();
    } finally {
      relay.close();
    }
  });

  it('resumes only the same session with its token and replaces the previous socket', () => {
    const { relay, attach } = fixture();
    try {
      const first = attach();
      const ready = first.sent[0]!;
      const impostor = attach('session-two', ready);
      expect(impostor.sent[0]?.workbenchConnectionId).not.toBe(ready.workbenchConnectionId);
      const resumed = attach('session-one', ready);
      expect(resumed.sent[0]).toMatchObject({ ...ready, resumed: true });
      expect(first.close).toHaveBeenCalledWith(4000, 'WORKBENCH_CONNECTION_REPLACED');
      relay.closeSession('session-one');
      expect(relay.ownsConnection('session-one', String(ready.workbenchConnectionId))).toBe(false);
      expect(resumed.close).toHaveBeenCalledWith(1000, 'USER_SESSION_CLOSED');
      expect(impostor.close).not.toHaveBeenCalled();
    } finally {
      relay.close();
    }
  });

  it('rechecks directed Workspace authorization and rejects missing Hosted authorization', async () => {
    const { relay, database, attach } = fixture();
    try {
      const socket = attach();
      const id = String(socket.sent[0]!.workbenchConnectionId);
      const message = {
        type: 'watch.event',
        nodeId: 'node-1',
        event: { type: 'watch.workspace.snapshot', workspaceId: 'workspace-1' }
      };
      expect(await relay.sendConnection(id, message)).toBe('delivered');
      database.userCanRequestNode.mockResolvedValue(false);
      expect(await relay.sendConnection(id, message)).toBe('authorization-revoked');
      expect(socket.sent).toHaveLength(2);
      database.userCanRequestNode.mockResolvedValue(true);
      expect(
        await relay.sendConnection(id, {
          type: 'watch.event',
          event: {
            type: 'watch.hosted-conversation.snapshot',
            nodeId: 'node-1',
            templateId: 'template-1'
          }
        })
      ).toBe('authorization-revoked');
      expect(database.userOwnsNode).not.toHaveBeenCalled();
    } finally {
      relay.close();
    }
  });

  it('does not broadcast unauthorized Node state and keeps ping request identity', async () => {
    const { relay, database, attach } = fixture();
    try {
      const socket = attach();
      socket.receive({ type: 'ping', id: 'ping-one' });
      expect(socket.sent[1]).toEqual({ type: 'pong', id: 'ping-one' });
      database.userCanRequestNode.mockResolvedValue(false);
      relay.broadcast({ type: 'node', nodeId: 'node-1', connected: true });
      await vi.waitFor(() => expect(database.userCanRequestNode).toHaveBeenCalled());
      expect(socket.sent).toHaveLength(2);
      socket.receive({ type: 'resume' });
      expect(socket.close).toHaveBeenCalledWith(4002, 'WORKBENCH_ALREADY_READY');
    } finally {
      relay.close();
    }
  });
});
