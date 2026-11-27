import type { WebSocket } from 'ws';
import {
  decodeTerminalMux,
  encodeByteFrame,
  encodeTerminalMux,
  TERMINAL_MUX,
  type TerminalDataFrame
} from '@myagentroam/protocol';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { TerminalRelayService } from '../../src/terminal-relay-service.js';
import { TerminalRelaySocket as RelaySocket } from './support/relay-socket.js';

class SingleSocket extends RelaySocket {
  terminate() {
    this.close();
  }
}

describe('public Terminal relay', () => {
  it.each(['disconnect', 'expiry', 'unused preconnection'])(
    'cleans up only an authorized CLI writer on single-stream %s',
    async (reason) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const user = { userId: 1, sessionHash: 'active-login' };
      const nodeId = 'node-1';
      const authorization = Promise.withResolvers<unknown>();
      const requestNode = vi.fn(async (_nodeId: string, operation: string) =>
        operation === 'terminal.attach.authorize' ? authorization.promise : {}
      );
      const relay = new TerminalRelayService({
        database: { authenticateNode: async () => ({ id: nodeId, disabled: false }) },
        authorizeNodeRequest: async () => true,
        requestNode
      });
      const node = new RelaySocket();
      const socket = new SingleSocket();
      try {
        relay.attachNode(node as unknown as WebSocket);
        node.receive({ type: 'authenticate', nodeId, credential: 'fixture' });
        await vi.waitFor(() => expect(node.sent[0]?.type).toBe('authenticated'));
        const { ticket } = relay.createTicket({ nodeId, terminalId: 'job', user, cli: true });
        const deferred = reason === 'unused preconnection';
        relay.attachBrowser(
          socket as unknown as WebSocket,
          deferred ? { ticket, deferred } : ticket,
          user,
          {
            type: 'single',
            expiresAt: Date.now() + 60_000
          }
        );
        if (reason === 'expiry') await vi.advanceTimersByTimeAsync(60_000);
        else socket.close();
        authorization.resolve({ attachment: { attachmentId: 'writer', terminalId: 'job' } });
        if (deferred) expect(requestNode).not.toHaveBeenCalled();
        else
          await vi.waitFor(() =>
            expect(requestNode).toHaveBeenCalledWith(
              nodeId,
              'terminal.close',
              { terminalId: 'job' },
              user
            )
          );
        expect(node.sent.some((frame) => frame.type === 'attach')).toBe(false);
        expect(relay.countSession(user.sessionHash)).toBe(0);
      } finally {
        relay.close();
        vi.useRealTimers();
      }
    }
  );

  it.each(['disconnect', 'expiry', 'browser disconnect'])(
    'uses the owning ticket lifecycle on %s',
    async (reason) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const nodeId = 'node-1';
      const user = { userId: 1, sessionHash: 'login' };
      const relay = new TerminalRelayService({
        database: { authenticateNode: async () => ({ id: nodeId, disabled: false }) },
        authorizeNodeRequest: async () => true,
        requestNode: async () => ({ attachment: { attachmentId: 'attached', terminalId: 'job' } })
      });
      const node = new RelaySocket();
      const socket = new SingleSocket();
      const cli = reason !== 'browser disconnect';
      try {
        relay.attachNode(node as unknown as WebSocket);
        node.receive({ type: 'authenticate', nodeId, credential: 'fixture' });
        await vi.waitFor(() => expect(node.sent[0]?.type).toBe('authenticated'));
        const { ticket } = relay.createTicket({ nodeId, terminalId: 'job', user, cli });
        relay.attachBrowser(
          socket as unknown as WebSocket,
          ticket,
          user,
          cli ? { type: 'single', expiresAt: Date.now() + 60_000 } : undefined
        );
        await vi.waitFor(() =>
          expect(node.sent.some((frame) => frame.type === 'attach')).toBe(true)
        );
        if (reason === 'expiry') await vi.advanceTimersByTimeAsync(60_000);
        else socket.close();
        expect(node.sent).toContainEqual({ type: cli ? 'close' : 'detach', ticket });
        expect(relay.countSession(user.sessionHash)).toBe(0);
      } finally {
        relay.close();
        vi.useRealTimers();
      }
    }
  );

  it('isolates logical streams on a CLI relay and terminates the pooled connection on logout', async () => {
    const requestNode = vi.fn(async (_nodeId: string, _operation: string, data: unknown) => {
      const { terminalId } = data as { terminalId: string };
      return { attachment: { attachmentId: terminalId, terminalId } };
    });
    const user = { userId: 1, sessionHash: 'active-login' };
    const authorize = vi.fn(async () => user);
    const relay = new TerminalRelayService({
      database: { authenticateNode: async () => ({ id: 'node-1', disabled: false }) },
      authorizeNodeRequest: async () => true,
      requestNode
    });
    const node = new RelaySocket();
    const wire = new MuxSocket();
    const makeTicket = (terminalId: string, nodeId = 'node-1') =>
      relay.createTicket({ nodeId, terminalId, user, cli: true }).ticket;
    try {
      relay.attachNode(node as unknown as WebSocket);
      node.receive({ type: 'authenticate', nodeId: 'node-1', credential: 'fixture' });
      await vi.waitFor(() => expect(node.sent[0]?.type).toBe('authenticated'));
      const ssh = makeTicket('ssh');
      const computer = relay.createTicket({
        nodeId: 'node-1',
        terminalId: 'computer',
        user,
        computer: true,
        cli: true
      }).ticket;
      relay.attachCliMux(
        wire as unknown as WebSocket,
        'node-1',
        user,
        Date.now() + 60_000,
        authorize
      );
      wire.openStream(1, ssh);
      wire.openStream(2, makeTicket('wrong-node', 'node-2'));
      wire.openStream(3, computer);
      const browserTicket = relay.createTicket({
        nodeId: 'node-1',
        terminalId: 'browser',
        user,
        readonly: true
      }).ticket;
      wire.openStream(4, browserTicket);
      await vi.waitFor(() => expect(requestNode).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(node.sent.filter((frame) => frame.type === 'attach')).toHaveLength(2)
      );
      expect(relay.countSession(user.sessionHash)).toBe(2);
      expect(authorize).toHaveBeenCalledTimes(4);
      expect(requestNode.mock.calls.map(([, operation]) => operation)).toEqual([
        'terminal.attach.authorize',
        'computer.use.attach'
      ]);
      expect(wire.send.mock.results.map(({ value }) => [value.type, value.stream])).toEqual([
        [TERMINAL_MUX.ready, 0],
        [TERMINAL_MUX.close, 2],
        [TERMINAL_MUX.close, 4]
      ]);

      const cancelledAuthorization = Promise.withResolvers<typeof user>();
      authorize.mockImplementationOnce(() => cancelledAuthorization.promise);
      wire.openStream(5, makeTicket('cancelled'));
      wire.emit('message', Buffer.from(encodeTerminalMux(TERMINAL_MUX.close, 5)), true);
      cancelledAuthorization.reject(new Error('USER_AUTHORIZATION_UNAVAILABLE'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(wire.readyState).toBe(1);
      expect(relay.countSession(user.sessionHash)).toBe(2);

      wire.emit('message', Buffer.from(encodeTerminalMux(TERMINAL_MUX.close, 1)), true);
      expect(node.sent).toContainEqual({ type: 'close', ticket: ssh });
      expect(relay.countSession(user.sessionHash)).toBe(1);
      expect(wire.readyState).toBe(1);
      relay.closeSession(user.sessionHash);
      expect(node.sent).toContainEqual({ type: 'close', ticket: computer });
      expect(wire.readyState).toBe(3);
    } finally {
      relay.close();
    }
  });

  it('counts in-flight attachments and closes the remote terminal if a mux stream is cancelled during authorization', async () => {
    const user = { userId: 1, sessionHash: 'active-login' };
    const nodeId = 'node-1';
    const attachment = Promise.withResolvers<void>();
    const requestNode = vi.fn(async (_nodeId: string, operation: string, data: unknown) => {
      if (operation !== 'terminal.attach.authorize') return {};
      const { terminalId } = data as { terminalId: string };
      await attachment.promise;
      return { attachment: { attachmentId: terminalId, terminalId } };
    });
    const relay = new TerminalRelayService({
      database: { authenticateNode: async () => ({ id: nodeId, disabled: false }) },
      authorizeNodeRequest: async () => true,
      requestNode
    });
    const node = new RelaySocket();
    const first = new MuxSocket();
    const second = new MuxSocket();
    try {
      relay.attachNode(node as unknown as WebSocket);
      node.receive({ type: 'authenticate', nodeId, credential: 'fixture' });
      await vi.waitFor(() => expect(node.sent[0]?.type).toBe('authenticated'));
      for (const wire of [first, second])
        relay.attachCliMux(
          wire as unknown as WebSocket,
          nodeId,
          user,
          Date.now() + 60_000,
          async () => user
        );
      const makeTicket = (terminalId: string) =>
        relay.createTicket({ nodeId, terminalId, user, cli: true }).ticket;
      first.openStream(1, makeTicket('cancelled-shell'));
      for (let n = 1; n <= 10; n++) second.openStream(n, makeTicket(`shell-${n}`));
      await vi.waitFor(() =>
        expect(second.send.mock.results[1]?.value).toMatchObject({
          type: TERMINAL_MUX.close,
          stream: 10
        })
      );
      expect(requestNode).toHaveBeenCalledTimes(10);
      expect(relay.countSession(user.sessionHash)).toBe(10);
      first.emit('message', Buffer.from(encodeTerminalMux(TERMINAL_MUX.close, 1)), true);
      attachment.resolve();
      await vi.waitFor(() =>
        expect(requestNode).toHaveBeenCalledWith(
          nodeId,
          'terminal.close',
          { terminalId: 'cancelled-shell' },
          user
        )
      );
      expect(node.sent.filter((frame) => frame.type === 'attach')).toHaveLength(9);
      expect(relay.countSession(user.sessionHash)).toBe(9);
    } finally {
      attachment.resolve();
      relay.close();
    }
  });

  it('closes an attached desktop on credential expiry without waiting for the physical close handshake', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const user = { userId: 1, sessionHash: 'expiring-login' };
    const nodeId = 'node-1';
    const relay = new TerminalRelayService({
      database: { authenticateNode: async () => ({ id: nodeId, disabled: false }) },
      authorizeNodeRequest: async () => true,
      requestNode: async () => ({
        attachment: { attachmentId: 'desktop-attachment', terminalId: 'desktop' }
      })
    });
    const node = new RelaySocket();
    // A peer need not acknowledge a WebSocket close promptly.
    const wire = new (class extends MuxSocket {
      override close() {
        this.readyState = 2;
      }
    })();
    try {
      relay.attachNode(node as unknown as WebSocket);
      node.receive({ type: 'authenticate', nodeId, credential: 'fixture' });
      await vi.waitFor(() => expect(node.sent[0]?.type).toBe('authenticated'));
      const { ticket } = relay.createTicket({
        nodeId,
        terminalId: 'desktop',
        user,
        computer: true,
        cli: true
      });
      relay.attachCliMux(
        wire as unknown as WebSocket,
        nodeId,
        user,
        Date.now() + 60_000,
        async () => user
      );
      wire.openStream(1, ticket);
      await vi.waitFor(() => expect(node.sent.some((frame) => frame.type === 'attach')).toBe(true));

      await vi.advanceTimersByTimeAsync(60_000);

      expect(wire.readyState).toBe(2);
      expect([...node.sent]).toContainEqual({ type: 'close', ticket });
      expect(relay.countSession(user.sessionHash)).toBe(0);
    } finally {
      wire.emit('close');
      relay.close();
      vi.useRealTimers();
    }
  });

  it.each(['login', 'node access'])(
    'binds a computer ticket to its user and closes the desktop on %s revocation',
    async (revocation) => {
      const requestNode = vi.fn(async () => ({
        attachment: { attachmentId: 'desktop-attachment', terminalId: 'desktop' }
      }));
      const authorizeNodeRequest = vi.fn(async () => false);
      const relay = new TerminalRelayService({
        database: { authenticateNode: async () => ({ id: 'node-1', disabled: false }) },
        authorizeNodeRequest,
        requestNode
      });
      const node = new RelaySocket();
      const browser = new RelaySocket();
      const user = { userId: 1, sessionHash: 'login' };
      try {
        relay.attachNode(node as unknown as WebSocket);
        node.receive({ type: 'authenticate', nodeId: 'node-1', credential: 'fixture' });
        await vi.waitFor(() => expect(node.sent[0]?.type).toBe('authenticated'));
        const { ticket } = relay.createTicket({
          nodeId: 'node-1',
          terminalId: 'desktop',
          user,
          computer: true
        });
        for (const other of [
          { ...user, userId: 2 },
          { ...user, sessionHash: 'another-login' }
        ]) {
          const rejected = new RelaySocket();
          relay.attachBrowser(rejected as unknown as WebSocket, ticket, other);
          expect(rejected.close).toHaveBeenCalledWith(4008, 'TERMINAL_TICKET_INVALID');
        }
        const deferred = new RelaySocket();
        relay.attachBrowser(deferred as unknown as WebSocket, { ticket, deferred: true }, user);
        expect(deferred.close).toHaveBeenCalledWith(4008, 'TERMINAL_TICKET_INVALID');
        expect(requestNode).not.toHaveBeenCalled();
        relay.attachBrowser(browser as unknown as WebSocket, ticket, user);
        await vi.waitFor(() => expect(node.sent.at(-1)?.type).toBe('attach'));
        expect(requestNode).toHaveBeenCalledWith(
          'node-1',
          'computer.use.attach',
          {
            terminalId: 'desktop',
            afterSequence: 0,
            readonly: false
          },
          user
        );
        const reused = new RelaySocket();
        relay.attachBrowser(reused as unknown as WebSocket, ticket, user);
        expect(reused.close).toHaveBeenCalledWith(4008, 'TERMINAL_TICKET_INVALID');
        node.receive({ type: 'attached', ticket, terminalId: 'desktop' });
        if (revocation === 'login') relay.closeSession(user.sessionHash);
        else {
          await relay.revalidateAuthorizations();
          expect(authorizeNodeRequest).toHaveBeenCalledWith(
            1,
            'node-1',
            'computer.use.attach',
            {},
            undefined
          );
        }
        expect(node.sent).toContainEqual({ type: 'close', ticket });
        expect(browser.close).toHaveBeenCalled();
      } finally {
        relay.close();
      }
    }
  );

  it('closes a data socket on storage failure instead of leaking an unhandled rejection', async () => {
    const relay = new TerminalRelayService({
      database: {
        authenticateNode: async () => {
          throw new Error('STORAGE_UNAVAILABLE');
        }
      },
      authorizeNodeRequest: async () => false,
      requestNode: vi.fn()
    });
    const socket = new RelaySocket();
    try {
      relay.attachNode(socket as unknown as WebSocket);
      socket.receive({ type: 'authenticate', nodeId: 'node-1', credential: 'fixture' });
      await vi.waitFor(() =>
        expect(socket.close).toHaveBeenCalledWith(1011, 'TERMINAL_AUTHENTICATION_FAILED')
      );
    } finally {
      relay.close();
    }
  });

  it('does not resurrect a data socket when authentication completes after shutdown', async () => {
    let resolve!: (node: { id: string; disabled: boolean }) => void;
    const relay = new TerminalRelayService({
      database: {
        authenticateNode: () =>
          new Promise((done) => {
            resolve = done;
          })
      },
      authorizeNodeRequest: async () => true,
      requestNode: vi.fn()
    });
    const socket = new RelaySocket();
    relay.attachNode(socket as unknown as WebSocket);
    socket.receive({ type: 'authenticate', nodeId: 'node-1', credential: 'fixture' });
    relay.close();
    resolve({ id: 'node-1', disabled: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(socket.sent).toEqual([]);
    expect(socket.close).toHaveBeenCalledWith(1001, 'SERVER_SHUTDOWN');
  });

  it('waits for Node attachment confirmation before exposing a paired browser relay', async () => {
    const requestNode = vi.fn(async () => ({
      attachment: {
        attachmentId: 'attachment-1',
        terminalId: 'terminal-1',
        latestSequence: 1
      }
    }));
    const database = {
      authenticateNode: vi.fn(async () => ({ id: 'node-1', disabled: false })),
      userOwnsNode: vi.fn(async () => true)
    };
    const relay = new TerminalRelayService({
      database,
      authorizeNodeRequest: database.userOwnsNode,
      requestNode
    });
    const node = new RelaySocket();
    const browser = new RelaySocket();
    try {
      relay.attachNode(node as unknown as WebSocket);
      node.receive({ type: 'authenticate', nodeId: 'node-1', credential: 'test-credential' });
      await vi.waitFor(() =>
        expect(node.sent[0]).toEqual({ type: 'authenticated', nodeId: 'node-1' })
      );
      const user = { userId: 1, sessionHash: 'session-one' };
      const ticket = relay.createTicket({
        nodeId: 'node-1',
        terminalId: 'terminal-1',
        workspaceId: 'workspace-1',
        user
      });
      relay.attachBrowser(browser as unknown as WebSocket, ticket.ticket, user);
      await vi.waitFor(() =>
        expect(node.sent.at(-1)).toEqual({
          type: 'attach',
          ticket: ticket.ticket,
          terminalId: 'terminal-1',
          attachmentId: 'attachment-1',
          afterSequence: 0
        })
      );
      expect(browser.sent).toEqual([]);
      const frame = {
        type: 'input',
        terminalId: 'terminal-1',
        data: new TextEncoder().encode('echo fixture\r')
      };
      browser.receive(frame);
      expect(node.sent.at(-1)?.type).toBe('attach');
      node.receive({ type: 'attached', ticket: ticket.ticket, terminalId: 'terminal-1' });
      node.receive({
        type: 'frame',
        ticket: ticket.ticket,
        frame: {
          type: 'output',
          terminalId: 'terminal-1',
          sequence: 1,
          data: new TextEncoder().encode('before attach')
        }
      });
      await vi.waitFor(() => expect(browser.sent).toHaveLength(2));
      expect(browser.sent).toEqual([
        { type: 'attach', terminalId: 'terminal-1', afterSequence: 0 },
        {
          type: 'output',
          terminalId: 'terminal-1',
          sequence: 1,
          data: new TextEncoder().encode('before attach')
        }
      ]);
      expect(requestNode).toHaveBeenCalledWith(
        'node-1',
        'terminal.attach.authorize',
        { terminalId: 'terminal-1', afterSequence: 0, readonly: false },
        { ...user, workspaceId: 'workspace-1' }
      );
      browser.receive(frame);
      expect(node.sent.at(-1)).toEqual({ type: 'frame', ticket: ticket.ticket, frame });
      const replay = new RelaySocket();
      relay.attachBrowser(replay as unknown as WebSocket, ticket.ticket, user);
      expect(replay.close).toHaveBeenCalledWith(4008, 'TERMINAL_TICKET_INVALID');
      relay.closeSession(user.sessionHash);
      expect(browser.close).toHaveBeenCalled();
    } finally {
      relay.close();
    }
  });

  it('preserves a deterministic Node attach failure for the browser before closing the relay', async () => {
    const relay = new TerminalRelayService({
      database: {
        authenticateNode: async () => ({ id: 'node-1', disabled: false })
      },
      authorizeNodeRequest: async () => true,
      requestNode: async () => {
        throw new Error('TERMINAL_CLOSED');
      }
    });
    const node = new RelaySocket();
    const browser = new RelaySocket();
    try {
      relay.attachNode(node as unknown as WebSocket);
      node.receive({ type: 'authenticate', nodeId: 'node-1', credential: 'test-credential' });
      await vi.waitFor(() => expect(node.sent[0]?.type).toBe('authenticated'));
      const user = { userId: 1, sessionHash: 'session-one' };
      const ticket = relay.createTicket({ nodeId: 'node-1', terminalId: 'terminal-1', user });
      relay.attachBrowser(browser as unknown as WebSocket, ticket.ticket, user);
      await vi.waitFor(() =>
        expect(browser.sent).toContainEqual({
          type: 'error',
          terminalId: 'terminal-1',
          code: 'TERMINAL_CLOSED'
        })
      );
      expect(browser.close).toHaveBeenCalledWith(4008, 'TERMINAL_ATTACH_FAILED');
    } finally {
      relay.close();
    }
  });

  it('reserves a deferred ticket for its original attachment until activation', async () => {
    const requestNode = vi.fn(async () => ({
      attachment: {
        attachmentId: 'attachment-1',
        terminalId: 'terminal-1',
        latestSequence: 0,
        frames: []
      }
    }));
    const relay = new TerminalRelayService({
      database: {
        authenticateNode: async () => ({ id: 'node-1', disabled: false })
      },
      authorizeNodeRequest: async () => true,
      requestNode
    });
    const node = new RelaySocket();
    const browser = new RelaySocket();
    const user = { userId: 1, sessionHash: 'session-one' };
    try {
      relay.attachNode(node as unknown as WebSocket);
      node.receive({ type: 'authenticate', nodeId: 'node-1', credential: 'test-credential' });
      await vi.waitFor(() => expect(node.sent[0]?.type).toBe('authenticated'));
      const ticket = relay.createTicket({ nodeId: 'node-1', terminalId: 'terminal-1', user });

      relay.attachBrowser(
        browser as unknown as WebSocket,
        { ticket: ticket.ticket, deferred: true },
        user
      );
      expect(browser.sent).toEqual([{ type: 'ready', terminalId: 'terminal-1' }]);
      expect(requestNode).not.toHaveBeenCalled();

      const duplicate = new RelaySocket();
      relay.attachBrowser(duplicate as unknown as WebSocket, ticket.ticket, user);
      expect(duplicate.close).toHaveBeenCalledWith(4008, 'TERMINAL_TICKET_INVALID');
      expect(requestNode).not.toHaveBeenCalled();

      browser.receive({ type: 'activate', terminalId: 'terminal-1' });
      await vi.waitFor(() =>
        expect(requestNode).toHaveBeenCalledWith(
          'node-1',
          'terminal.attach.authorize',
          { terminalId: 'terminal-1', afterSequence: 0, readonly: false },
          user
        )
      );
      await vi.waitFor(() =>
        expect(node.sent.at(-1)).toMatchObject({
          type: 'attach',
          ticket: ticket.ticket,
          terminalId: 'terminal-1'
        })
      );
      expect(requestNode).toHaveBeenCalledTimes(1);
    } finally {
      relay.close();
    }
  });

  it('cleans a deferred ticket and activation listener when the preconnection closes', async () => {
    const relay = new TerminalRelayService({
      database: {
        authenticateNode: async () => ({ id: 'node-1', disabled: false })
      },
      authorizeNodeRequest: async () => true,
      requestNode: vi.fn()
    });
    const node = new RelaySocket();
    const browser = new RelaySocket();
    const user = { userId: 1, sessionHash: 'session-one' };
    try {
      relay.attachNode(node as unknown as WebSocket);
      node.receive({ type: 'authenticate', nodeId: 'node-1', credential: 'test-credential' });
      await vi.waitFor(() => expect(node.sent[0]?.type).toBe('authenticated'));
      const ticket = relay.createTicket({ nodeId: 'node-1', terminalId: 'terminal-1', user });
      relay.attachBrowser(
        browser as unknown as WebSocket,
        { ticket: ticket.ticket, deferred: true },
        user
      );
      browser.close();
      browser.receive({ type: 'activate' });
      expect(browser.close).toHaveBeenCalledTimes(1);
      const retry = new RelaySocket();
      relay.attachBrowser(retry as unknown as WebSocket, ticket.ticket, user);
      expect(retry.close).toHaveBeenCalledWith(4008, 'TERMINAL_TICKET_INVALID');
    } finally {
      relay.close();
    }
  });

  it('bounds deferred preconnections with the existing per-session relay limit', async () => {
    const relay = new TerminalRelayService({
      database: {
        authenticateNode: async () => ({ id: 'node-1', disabled: false })
      },
      authorizeNodeRequest: async () => true,
      requestNode: vi.fn()
    });
    const node = new RelaySocket();
    const user = { userId: 1, sessionHash: 'session-one' };
    const browsers = Array.from({ length: 11 }, () => new RelaySocket());
    try {
      relay.attachNode(node as unknown as WebSocket);
      node.receive({ type: 'authenticate', nodeId: 'node-1', credential: 'test-credential' });
      await vi.waitFor(() => expect(node.sent[0]?.type).toBe('authenticated'));
      for (const browser of browsers) {
        const ticket = relay.createTicket({ nodeId: 'node-1', terminalId: 'terminal-1', user });
        relay.attachBrowser(
          browser as unknown as WebSocket,
          { ticket: ticket.ticket, deferred: true },
          user
        );
      }
      expect(browsers.slice(0, 10).every((browser) => browser.sent.length === 1)).toBe(true);
      expect(browsers[10]!.close).toHaveBeenCalledWith(4008, 'TERMINAL_RELAY_LIMIT_REACHED');
    } finally {
      relay.close();
    }
  });

  it.each(['TERMINAL_BACKPRESSURE', 'TERMINAL_FRAME_REJECTED'])(
    'retires only the failed relay after forwarding %s and accepts its late frames',
    async (code) => {
      const relay = new TerminalRelayService({
        database: {
          authenticateNode: async () => ({ id: 'node-1', disabled: false })
        },
        authorizeNodeRequest: async () => true,
        requestNode: async (_id, _operation, data) => {
          const terminalId = (data as { terminalId: string }).terminalId;
          return {
            attachment: {
              terminalId,
              attachmentId: `attachment-${terminalId}`,
              latestSequence: 0,
              frames: []
            }
          };
        }
      });
      const node = new RelaySocket();
      const browsers = [new RelaySocket(), new RelaySocket()];
      const user = { userId: 1, sessionHash: 'failure-isolation' };
      try {
        relay.attachNode(node as unknown as WebSocket);
        node.receive({ type: 'authenticate', nodeId: 'node-1', credential: 'fixture' });
        await vi.waitFor(() => expect(node.sent[0]?.type).toBe('authenticated'));
        const tickets = browsers.map((_browser, index) =>
          relay.createTicket({
            nodeId: 'node-1',
            terminalId: `terminal-${index}`,
            user
          })
        );
        for (const [index, browser] of browsers.entries()) {
          relay.attachBrowser(browser as unknown as WebSocket, tickets[index]!.ticket, user);
        }
        await vi.waitFor(() =>
          expect(node.sent.filter((message) => message.type === 'attach')).toHaveLength(2)
        );
        for (const [index, ticket] of tickets.entries())
          node.receive({
            type: 'attached',
            ticket: ticket.ticket,
            terminalId: `terminal-${index}`
          });
        await vi.waitFor(() => expect(browsers[1]!.sent[0]?.type).toBe('attach'));
        const warning = { type: 'error', terminalId: 'terminal-1', code: 'TERMINAL_REPLAY_GAP' };
        node.receive({ type: 'frame', ticket: tickets[1]!.ticket, frame: warning });
        await vi.waitFor(() => expect(browsers[1]!.sent.at(-1)).toEqual(warning));
        expect(browsers[1]!.close).not.toHaveBeenCalled();
        const failure = { type: 'error', terminalId: 'terminal-0', code };
        node.receive({ type: 'frame', ticket: tickets[0]!.ticket, frame: failure });
        await vi.waitFor(() => expect(browsers[0]!.close).toHaveBeenCalled());
        expect(browsers[0]!.sent.at(-1)).toEqual(failure);
        expect(browsers[0]!.close).toHaveBeenCalledWith(1000, 'TERMINAL_RELAY_FAILED');
        expect(relay.countSession(user.sessionHash)).toBe(1);
        expect(node.sent).toContainEqual({ type: 'detach', ticket: tickets[0]!.ticket });
        node.receive({
          type: 'frame',
          ticket: tickets[0]!.ticket,
          frame: { type: 'exit', terminalId: 'terminal-0', exitCode: 1 }
        });
        const live = {
          type: 'output',
          terminalId: 'terminal-1',
          sequence: 1,
          data: new TextEncoder().encode('still responsive')
        };
        node.receive({ type: 'frame', ticket: tickets[1]!.ticket, frame: live });
        await vi.waitFor(() => expect(browsers[1]!.sent.at(-1)).toEqual(live));
        expect(node.close).not.toHaveBeenCalled();
        expect(browsers[1]!.close).not.toHaveBeenCalled();
      } finally {
        relay.close();
      }
    }
  );

  it.each(['replay', 'live'] as const)(
    'checks projected serialized %s bytes before exceeding browser watermarks',
    async (mode) => {
      const frames = [1, 2, 3].map((sequence) => ({
        type: 'output' as const,
        terminalId: 'terminal-1',
        sequence,
        data: new Uint8Array(65_536)
      }));
      const f = await frameFixture(mode === 'replay' ? frames : []);
      const send = f.browser.send.bind(f.browser);
      f.browser.bufferedAmount = 880 * 1024;
      f.browser.send = (raw, completed?: (error?: Error | null) => void) => {
        f.browser.bufferedAmount += Buffer.byteLength(raw);
        send(raw, completed);
      };
      try {
        f.confirm();
        if (mode === 'live')
          for (const frame of frames) {
            f.node.receive({ type: 'frame', ticket: f.ticket, frame });
            await vi.waitFor(() =>
              expect(f.browser.sent.filter((message) => message.type === 'output')).toHaveLength(
                Math.min(frame.sequence, 2)
              )
            );
          }
        await vi.waitFor(() => expect(f.browser.close).toHaveBeenCalled());
        expect(f.browser.bufferedAmount).toBeLessThanOrEqual(1024 * 1024);
        expect(f.browser.sent.filter((message) => message.type === 'output')).toHaveLength(2);
        expect(f.relay.countSession('frame-fixture')).toBe(0);
        expect(f.node.sent).toContainEqual({ type: 'detach', ticket: f.ticket });
        f.node.receive({ type: 'frame', ticket: f.ticket, frame: frames[2] });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(f.node.close).not.toHaveBeenCalled();
      } finally {
        f.relay.close();
      }
    }
  );

  it('yields during initial replay and preserves snapshot/live/exit ordering', async () => {
    const frames: TerminalDataFrame[] = Array.from({ length: 64 }, (_value, index) => ({
      type: 'output',
      terminalId: 'terminal-1',
      sequence: index + 1,
      data: new TextEncoder().encode('snapshot')
    }));
    const f = await frameFixture(frames);
    try {
      f.confirm();
      const observedAtYield = await new Promise<number>((resolve) => {
        setImmediate(() =>
          resolve(f.browser.sent.filter((frame) => frame.type === 'output').length)
        );
      });
      expect(observedAtYield).toBeGreaterThan(0);
      expect(observedAtYield).toBeLessThan(64);
      f.node.receive({
        type: 'frame',
        ticket: f.ticket,
        frame: {
          type: 'output',
          terminalId: 'terminal-1',
          sequence: 65,
          data: new TextEncoder().encode('live')
        }
      });
      f.node.receive({
        type: 'frame',
        ticket: f.ticket,
        frame: { type: 'exit', terminalId: 'terminal-1', exitCode: 0 }
      });
      await vi.waitFor(() => expect(f.browser.close).toHaveBeenCalled());
      expect(
        f.browser.sent.filter((frame) => frame.type === 'output').map((frame) => frame.sequence)
      ).toEqual(Array.from({ length: 65 }, (_value, index) => index + 1));
      expect(f.browser.sent.at(-1)).toEqual({
        type: 'exit',
        terminalId: 'terminal-1',
        exitCode: 0
      });
      expect(f.node.close).not.toHaveBeenCalled();
    } finally {
      f.relay.close();
    }
  });

  it.each([undefined, null])(
    'continues replay on successful write callback %s',
    async (success) => {
      const f = await frameFixture([
        {
          type: 'output',
          terminalId: 'terminal-1',
          sequence: 1,
          data: new TextEncoder().encode('first')
        },
        {
          type: 'output',
          terminalId: 'terminal-1',
          sequence: 2,
          data: new TextEncoder().encode('last')
        },
        { type: 'exit', terminalId: 'terminal-1', exitCode: 0 }
      ]);
      const send = f.browser.send.bind(f.browser);
      let completed: ((error?: Error | null) => void) | undefined;
      f.browser.send = (raw, callback) => {
        send(raw);
        if (callback) completed = callback;
      };
      try {
        f.confirm();
        expect(f.browser.sent.filter((frame) => frame.type === 'output')).toHaveLength(1);
        completed!(success);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(f.browser.sent.filter((frame) => frame.type === 'output')).toHaveLength(2);
        expect(f.browser.close).not.toHaveBeenCalled();
        completed!(success);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(f.browser.sent.at(-1)?.type).toBe('exit');
        expect(f.browser.close).not.toHaveBeenCalled();
        completed!(success);
        expect(f.browser.close).toHaveBeenCalledWith(1000, 'TERMINAL_RELAY_CLOSED');
        expect(f.relay.countSession('frame-fixture')).toBe(0);
        expect(f.node.close).not.toHaveBeenCalled();
      } finally {
        f.relay.close();
      }
    }
  );

  it('cancels a replay in flight and discards pending live frames when the browser disconnects', async () => {
    const f = await frameFixture(
      [1, 2, 3].map((sequence) => ({
        type: 'output',
        terminalId: 'terminal-1',
        sequence,
        data: new TextEncoder().encode('snapshot')
      }))
    );
    const send = f.browser.send.bind(f.browser);
    let completed: ((error?: Error | null) => void) | undefined;
    f.browser.send = (raw, callback) => {
      send(raw);
      if (callback) completed = callback;
    };
    try {
      f.confirm();
      f.node.receive({
        type: 'frame',
        ticket: f.ticket,
        frame: {
          type: 'output',
          terminalId: 'terminal-1',
          sequence: 4,
          data: new TextEncoder().encode('live')
        }
      });
      expect(f.browser.sent.filter((frame) => frame.type === 'output')).toHaveLength(1);
      f.browser.close();
      const sent = f.browser.sent.length;
      completed?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.browser.sent).toHaveLength(sent);
      expect(f.relay.countSession('frame-fixture')).toBe(0);
      expect(f.node.sent).toContainEqual({ type: 'detach', ticket: f.ticket });
      expect(f.node.close).not.toHaveBeenCalled();
    } finally {
      f.relay.close();
    }
  });

  it.each(['queue overflow', 'write failure'] as const)(
    'isolates a stalled replay on %s',
    async (failure) => {
      const f = await frameFixture([
        {
          type: 'output',
          terminalId: 'terminal-1',
          sequence: 1,
          data: new TextEncoder().encode('snapshot')
        }
      ]);
      const send = f.browser.send.bind(f.browser);
      let completed: ((error?: Error | null) => void) | undefined;
      f.browser.send = (raw, callback) => {
        send(raw);
        if (callback) completed = callback;
      };
      try {
        f.confirm();
        if (failure === 'queue overflow')
          for (let sequence = 2; sequence <= 18; sequence++) {
            f.node.receive({
              type: 'frame',
              ticket: f.ticket,
              frame: {
                type: 'output',
                terminalId: 'terminal-1',
                sequence,
                data: new Uint8Array(65_536)
              }
            });
          }
        else completed?.(new Error('simulated write failure'));
        await vi.waitFor(() => expect(f.browser.close).toHaveBeenCalled());
        expect(f.browser.sent.filter((frame) => frame.type === 'output')).toHaveLength(1);
        if (failure === 'queue overflow')
          expect(f.browser.sent.at(-1)).toEqual({
            type: 'error',
            terminalId: 'terminal-1',
            code: 'TERMINAL_BACKPRESSURE'
          });
        expect(f.relay.countSession('frame-fixture')).toBe(0);
        const sent = f.browser.sent.length;
        completed?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(f.browser.sent).toHaveLength(sent);
        expect(f.node.close).not.toHaveBeenCalled();
      } finally {
        f.relay.close();
      }
    }
  );

  it('rejects a ticket from another session before issuing a Node authorization request', () => {
    const requestNode = vi.fn();
    const relay = new TerminalRelayService({
      database: {
        authenticateNode: async () => undefined
      },
      authorizeNodeRequest: async () => false,
      requestNode
    });
    try {
      const ticket = relay.createTicket({
        nodeId: 'node-1',
        terminalId: 'terminal-1',
        user: { userId: 1, sessionHash: 'session-one' }
      });
      const browser = new RelaySocket();
      relay.attachBrowser(browser as unknown as WebSocket, ticket.ticket, {
        userId: 1,
        sessionHash: 'session-two'
      });
      expect(browser.close).toHaveBeenCalledWith(4008, 'TERMINAL_TICKET_INVALID');
      expect(requestNode).not.toHaveBeenCalled();
    } finally {
      relay.close();
    }
  });
});

class MuxSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  bufferedAmount = 0;
  send = vi.fn((data: Uint8Array) => decodeTerminalMux(data));

  close() {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit('close');
  }

  openStream(stream: number, ticket: string) {
    this.emit(
      'message',
      Buffer.from(
        encodeTerminalMux(TERMINAL_MUX.open, stream, encodeByteFrame({ ticket, deferred: false }))
      ),
      true
    );
  }
}

async function frameFixture(frames: readonly TerminalDataFrame[]) {
  const relay = new TerminalRelayService({
    database: {
      authenticateNode: async () => ({ id: 'node-1', disabled: false })
    },
    authorizeNodeRequest: async () => true,
    requestNode: async () => ({
      attachment: {
        terminalId: 'terminal-1',
        attachmentId: 'frame-attachment',
        latestSequence: frames.length
      }
    })
  });
  const node = new RelaySocket();
  relay.attachNode(node as unknown as WebSocket);
  node.receive({ type: 'authenticate', nodeId: 'node-1', credential: 'fixture' });
  await vi.waitFor(() => expect(node.sent[0]?.type).toBe('authenticated'));
  const user = { userId: 1, sessionHash: 'frame-fixture' };
  const { ticket } = relay.createTicket({ nodeId: 'node-1', terminalId: 'terminal-1', user });
  const browser = new RelaySocket();
  relay.attachBrowser(browser as unknown as WebSocket, ticket, user);
  await vi.waitFor(() =>
    expect(node.sent).toContainEqual({
      type: 'attach',
      ticket,
      terminalId: 'terminal-1',
      attachmentId: 'frame-attachment',
      afterSequence: 0
    })
  );
  return {
    relay,
    node,
    browser,
    ticket,
    confirm: () => {
      node.receive({ type: 'attached', ticket, terminalId: 'terminal-1' });
      for (const frame of frames) node.receive({ type: 'frame', ticket, frame });
    }
  };
}
