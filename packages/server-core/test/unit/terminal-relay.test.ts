import { describe, expect, it, vi } from 'vitest';
import { TerminalRelayService } from '../../src/terminal-relay-service.js';

describe('public Terminal relay', () => {
  it.each([undefined, 'workspace-1'])(
    'forwards the ticket scope %s to Node stream preparation',
    async (workspaceId) => {
      const nodeId = 'node-1';
      const user = { userId: 1, sessionHash: 'login' };
      const requestNode = vi.fn(async () => ({ grant: 'node-grant' }));
      const relay = new TerminalRelayService({
        authorizeNodeRequest: async () => true,
        requestNode
      });
      try {
        const workspace = workspaceId === undefined ? {} : { workspaceId };
        const { ticket } = relay.createTicket({ nodeId, terminalId: 'job', user, ...workspace });
        expect(
          await relay.authorizeStream(ticket, nodeId, user, false, new AbortController().signal)
        ).toEqual({
          grant: 'node-grant',
          revoked: expect.any(AbortSignal)
        });
        expect(requestNode).toHaveBeenCalledExactlyOnceWith(
          nodeId,
          'terminal.attach.authorize',
          {
            terminalId: 'job',
            afterSequence: 0,
            readonly: false,
            ...workspace
          },
          { ...user, ...workspace },
          undefined,
          expect.any(AbortSignal)
        );
      } finally {
        relay.close();
      }
    }
  );

  it('binds a one-time ticket to its Node, login, and client kind', async () => {
    const nodeId = 'node-1';
    const user = { userId: 1, sessionHash: 'login' };
    const requestNode = vi.fn(async () => ({ grant: 'computer-grant' }));
    const relay = new TerminalRelayService({ authorizeNodeRequest: async () => true, requestNode });
    const signal = new AbortController().signal;
    try {
      const { ticket } = relay.createTicket({
        nodeId,
        terminalId: 'desktop',
        user,
        cli: true,
        computer: true
      });
      expect(await relay.authorizeStream(ticket, 'other-node', user, true, signal)).toBeUndefined();
      expect(
        await relay.authorizeStream(
          ticket,
          nodeId,
          { ...user, sessionHash: 'other-login' },
          true,
          signal
        )
      ).toBeUndefined();
      expect(await relay.authorizeStream(ticket, nodeId, user, false, signal)).toBeUndefined();
      expect(requestNode).not.toHaveBeenCalled();
      const result = await relay.authorizeStream(ticket, nodeId, user, true, signal);
      expect(result).toMatchObject({ grant: 'computer-grant' });
      expect(requestNode).toHaveBeenCalledExactlyOnceWith(
        nodeId,
        'computer.use.attach',
        {
          terminalId: 'desktop',
          readonly: false,
          afterSequence: 0,
          closeOnDisconnect: true
        },
        user,
        undefined,
        expect.any(AbortSignal)
      );
      expect(await relay.authorizeStream(ticket, nodeId, user, true, signal)).toBeUndefined();
      const other = relay.createTicket({ nodeId: 'node-2', terminalId: 'shell', user });
      relay.disconnectNode(nodeId);
      expect(result && 'revoked' in result && result.revoked.aborted).toBe(true);
      expect(
        await relay.authorizeStream(other.ticket, 'node-2', user, false, signal)
      ).toMatchObject({ grant: 'computer-grant' });
    } finally {
      relay.close();
    }
  });

  it('expires unused tickets and preserves deterministic Node errors', async () => {
    vi.useFakeTimers();
    const nodeId = 'node-1';
    const user = { userId: 1, sessionHash: 'login' };
    const requestNode = vi.fn(async () => {
      throw new Error('TERMINAL_WORKSPACE_MISMATCH');
    });
    const relay = new TerminalRelayService({ authorizeNodeRequest: async () => true, requestNode });
    const signal = new AbortController().signal;
    const issue = () => relay.createTicket({ nodeId, terminalId: 'shell', user });
    try {
      const expired = issue();
      vi.advanceTimersByTime(30_000);
      expect(
        await relay.authorizeStream(expired.ticket, nodeId, user, false, signal)
      ).toBeUndefined();
      expect(requestNode).not.toHaveBeenCalled();
      expect(await relay.authorizeStream(issue().ticket, nodeId, user, false, signal)).toEqual({
        code: 'TERMINAL_WORKSPACE_MISMATCH'
      });
      expect(relay.countSession(user.sessionHash)).toBe(0);
    } finally {
      relay.close();
      vi.useRealTimers();
    }
  });

  it('uses the same session limit for in-flight Relay authorization and Direct attachments', async () => {
    const nodeId = 'node-1';
    const user = { userId: 1, sessionHash: 'login' };
    const pending = Promise.withResolvers<{ grant: string }>();
    const requestNode = vi.fn(() => pending.promise);
    const relay = new TerminalRelayService({ authorizeNodeRequest: async () => true, requestNode });
    relay.setDirectCoordination({
      directCount: (session) => (session === user.sessionHash ? 9 : 0)
    });
    const controller = new AbortController();
    const issue = () => relay.createTicket({ nodeId, terminalId: 'shell', user });
    try {
      const first = relay.authorizeStream(issue().ticket, nodeId, user, false, controller.signal);
      const second = issue();
      expect(
        await relay.authorizeStream(
          second.ticket,
          nodeId,
          user,
          false,
          new AbortController().signal
        )
      ).toEqual({ code: 'NODE_STREAM_LIMIT' });
      controller.abort();
      pending.resolve({ grant: 'node-grant' });
      expect(await first).toEqual({ code: 'NODE_STREAM_UNAVAILABLE' });
      expect(
        await relay.authorizeStream(
          second.ticket,
          nodeId,
          user,
          false,
          new AbortController().signal
        )
      ).toMatchObject({ grant: 'node-grant' });
    } finally {
      relay.close();
    }
  });
});
