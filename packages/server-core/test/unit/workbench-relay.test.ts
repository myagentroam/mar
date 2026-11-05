import { RelaySocket as Socket } from './support/relay-socket.js';
import type { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { WorkbenchRelayService } from '../../src/workbench-relay-service.js';

function fixture(
  authorizeHostedConversation?: (
    userId: number,
    nodeId: string,
    templateId: string
  ) => Promise<boolean>
) {
  const database = {
    userOwnsNode: vi.fn(async () => true),
    userCanRequestNode: vi.fn(async () => true)
  };
  const relay = new WorkbenchRelayService({
    authorizeNodeRequest: database.userCanRequestNode,
    ...(authorizeHostedConversation === undefined ? {} : { authorizeHostedConversation })
  });
  const attach = (sessionHash = 'session-one', resume = {}) => {
    const socket = new Socket();
    relay.attach(socket as unknown as WebSocket, { userId: 1, sessionHash });
    socket.receive({ ...resume, type: 'resume' });
    return socket;
  };
  return { relay, database, attach };
}

describe('public page-level Workbench relay', () => {
  it('delivers a large Session snapshot and following control frames without reconnecting', async () => {
    const { relay, attach } = fixture();
    const socket = attach();
    try {
      const message = {
        type: 'watch.event',
        nodeId: 'node-1',
        event: {
          type: 'watch.session.snapshot',
          workspaceId: 'workspace-1',
          sessionId: 'session-1',
          content: 'x'.repeat(1_800_000)
        }
      };
      const id = String(socket.sent[0]!.workbenchConnectionId);
      expect(await relay.sendConnection(id, message)).toBe('delivered');
      socket.bufferedAmount = Buffer.byteLength(JSON.stringify(message));
      socket.receive({ type: 'ping', id: 'after-snapshot' });
      expect(socket.sent.slice(1)).toEqual([message, { type: 'pong', id: 'after-snapshot' }]);
      expect(socket.close).not.toHaveBeenCalled();
    } finally {
      relay.close();
    }
  });

  it('disconnects a browser above the buffer limit without interrupting another page', () => {
    const { relay, attach } = fixture();
    const socket = attach('slow-session');
    const healthy = attach('healthy-session');
    try {
      socket.bufferedAmount = 16 * 1024 * 1024;
      socket.receive({ type: 'ping', id: 'at-limit' });
      expect(socket.sent.at(-1)).toEqual({ type: 'pong', id: 'at-limit' });
      expect(socket.close).not.toHaveBeenCalled();
      socket.bufferedAmount++;
      relay.sendUser(1, { type: 'delta', content: 'still-live' });
      expect(socket.close).toHaveBeenCalledWith(4009, 'WORKBENCH_BACKPRESSURE');
      expect(socket.sent.at(-1)).toEqual({ type: 'pong', id: 'at-limit' });
      expect(healthy.close).not.toHaveBeenCalled();
      expect(healthy.sent.at(-1)).toEqual({ type: 'delta', content: 'still-live' });
    } finally {
      relay.close();
    }
  });

  it('authorizes upgrade progress separately and never sends it when denied', async () => {
    const { relay, database, attach } = fixture();
    const socket = attach();
    try {
      database.userCanRequestNode.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      relay.broadcast({ type: 'node.upgrade', nodeId: 'node-1', snapshot: null });
      relay.broadcast({ type: 'node.upgrade', nodeId: 'node-1', snapshot: { state: 'FAILED' } });
      await vi.waitFor(() => expect(database.userCanRequestNode).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(socket.sent.filter((message) => message.type === 'node.upgrade')).toHaveLength(1)
      );
      expect(database.userCanRequestNode).toHaveBeenCalledWith(
        1,
        'node-1',
        'workbench.node.upgrade.receive',
        expect.anything(),
        undefined
      );
      expect(socket.sent.find((message) => message.type === 'node.upgrade')?.snapshot).toEqual({
        state: 'FAILED'
      });
    } finally {
      relay.close();
    }
  });
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

  it.each([
    {
      type: 'direct.prepare',
      requestId: 'request-0001',
      nodeId: 'node-1',
      nodeGeneration: 'generation-1',
      purpose: 'TRANSPORT'
    },
    {
      type: 'terminal.direct.prepare',
      requestId: 'request-0001',
      nodeId: 'node-1',
      nodeGeneration: 'generation-1',
      transportSessionId: 'transport-1',
      terminalId: 'terminal-1',
      afterSequence: 0,
      readonly: false
    }
  ] as const)(
    'contains $type rejection at the registered message listener without affecting another page',
    async (frame) => {
      const { relay, attach } = fixture();
      const failure = Promise.withResolvers<void>();
      const handler = vi
        .fn(async (): Promise<void> => undefined)
        .mockImplementationOnce(() => failure.promise);
      const disconnected = vi.fn();
      const unhandled = vi.fn();
      relay.setDirectTransferHandler({ message: handler, disconnected });
      relay.setTerminalDirectHandler({ message: handler });
      process.on('unhandledRejection', unhandled);
      try {
        const failed = attach();
        const healthy = attach();
        const failedId = String(failed.sent[0]!.workbenchConnectionId);
        const healthyId = String(healthy.sent[0]!.workbenchConnectionId);
        failed.receive(frame);
        expect(handler).toHaveBeenCalledWith(
          { userId: 1, sessionHash: 'session-one', workbenchConnectionId: failedId },
          frame
        );
        healthy.receive({ type: 'ping', id: 'before-rejection' });
        failure.reject(new Error('DB_WRITE_FAILED: private request and credential details'));
        // Cross an event-loop turn so an escaped rejection is observable, not just pending.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandled).not.toHaveBeenCalled();
        expect(failed.close).toHaveBeenCalledExactlyOnceWith(1011, 'WORKBENCH_MESSAGE_FAILED');
        expect(failed.sent).toHaveLength(1);
        expect(disconnected).toHaveBeenCalledExactlyOnceWith(failedId);
        expect(relay.ownsConnection('session-one', failedId)).toBe(true);
        expect(await relay.sendDirectConnection(failedId, { type: 'test' })).toBe('unavailable');

        healthy.receive({ type: 'ping', id: 'after-rejection' });
        healthy.receive({ ...frame, requestId: 'request-0002' });
        expect(handler).toHaveBeenCalledTimes(2);
        expect(handler).toHaveBeenLastCalledWith(
          { userId: 1, sessionHash: 'session-one', workbenchConnectionId: healthyId },
          { ...frame, requestId: 'request-0002' }
        );
        expect(healthy.sent.slice(1)).toEqual([
          { type: 'pong', id: 'before-rejection' },
          { type: 'pong', id: 'after-rejection' }
        ]);
        expect(healthy.close).not.toHaveBeenCalled();
        expect(await relay.sendDirectConnection(healthyId, { type: 'test' })).toBe('delivered');
        expect(healthy.sent.at(-1)).toEqual({ type: 'test' });
      } finally {
        process.off('unhandledRejection', unhandled);
        relay.close();
      }
    }
  );

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
    const authorize = vi.fn(async () => true);
    const { relay, database, attach } = fixture(authorize);
    try {
      const socket = attach();
      const id = String(socket.sent[0]!.workbenchConnectionId);
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
