import Fastify from 'fastify';
import type { Pool } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { MarctlUserCredentials } from '../../src/marctl-user-credentials.js';
import { registerMarctlRoutes } from '../../src/marctl-routes.js';
import { WorkbenchRelayService } from '../../src/workbench-relay-service.js';
import { RelaySocket } from './support/relay-socket.js';

function createUserContext() {
  const pool = {
    execute: async () => [[{ id: 1, username: 'admin' }]]
  } as unknown as Pool;
  const credentials = new MarctlUserCredentials(pool, Buffer.alloc(32, 7));
  const token = credentials.issue({ userId: 1, sessionHash: 'a'.repeat(43) });
  return { credentials, token };
}

describe('marctl execution-context authorization', () => {
  it('opens Computer Use with the same marctl credentials and Node permission as SSH', async () => {
    const { credentials, token } = createUserContext();
    const actor = { userId: 1, sessionHash: 'a'.repeat(43) };
    const source = {
      type: 'execution',
      sessionId: 'source-session',
      executionId: 'execution'
    } as const;
    const scope = { nodeId: 'source-node', workspaceId: 'source-workspace' };
    const execution = credentials.issue(actor, scope, source);
    const app = Fastify();
    const requestNode = vi.fn(async (_nodeId: string, operation: string) =>
      operation === 'computer.use.open' ? { terminal: { id: 'computer-terminal' } } : {}
    );
    const canUseNode = vi.fn(async () => false);
    const createTerminalTicket = vi.fn(() => ({ ticket: 'computer-ticket' }));
    registerMarctlRoutes({
      app,
      userCredentials: credentials,
      publicOrigin: 'http://localhost',
      listNodes: async () => [
        { id: 'desktop', connected: true, disabled: false, metadata: '{}', lastHeartbeatAt: null }
      ],
      canUseNode,
      secrets: { resolve: async () => ({}) },
      nodeControl: {
        requestNode,
        createTerminalTicket,
        attachCliTerminal: vi.fn(),
        attachWorkbench: vi.fn(),
        closeTerminal: vi.fn()
      }
    });
    const open = (key: string) =>
      app.inject({
        method: 'POST',
        url: '/api/marctl/computer',
        headers: { authorization: `Bearer ${key}` },
        payload: { nodeId: 'desktop' }
      });
    try {
      expect((await open('invalid')).statusCode).toBe(401);
      expect((await open(token)).statusCode).toBe(403);
      expect(requestNode).not.toHaveBeenCalled();
      canUseNode.mockResolvedValue(true);
      const keys = [
        token,
        execution,
        credentials.issue({ ...actor, scheduled: true }, scope, source)
      ];
      for (const key of keys) {
        const user = await credentials.authenticate(`Bearer ${key}`);
        const response = await open(key);
        expect(response.statusCode).toBe(201);
        expect(response.json()).toEqual({
          terminalId: 'computer-terminal',
          ticket: 'computer-ticket'
        });
        expect(requestNode).toHaveBeenLastCalledWith('desktop', 'computer.use.open', {}, user);
        expect(createTerminalTicket).toHaveBeenLastCalledWith({
          nodeId: 'desktop',
          terminalId: 'computer-terminal',
          user,
          computer: true,
          cli: true
        });
      }
      expect(requestNode).toHaveBeenCalledTimes(keys.length);
    } finally {
      await app.close();
    }
  });

  it.each(['attach', 'attachLive'] as const)(
    'rejects deployment keys on the %s WebSocket without attaching a relay',
    async (method) => {
      const { credentials, token } = createUserContext();
      const app = Fastify();
      const nodeControl = {
        requestNode: vi.fn(),
        createTerminalTicket: vi.fn(),
        attachCliTerminal: vi.fn(),
        attachWorkbench: vi.fn(),
        closeTerminal: vi.fn()
      };
      const routes = registerMarctlRoutes({
        app,
        userCredentials: credentials,
        publicOrigin: 'http://localhost',
        listNodes: async () => [],
        canUseNode: async () => true,
        secrets: { resolve: async () => ({}) },
        nodeControl
      });
      try {
        for (const header of [
          undefined,
          `Bearer marctl_${'x'.repeat(43)}`,
          `Bearer marmgr_${'x'.repeat(43)}`
        ]) {
          const socket = { close: vi.fn(), pause: vi.fn(), resume: vi.fn() };
          routes[method](
            socket as never,
            { headers: { authorization: header }, query: { ticket: 'ticket' } } as never
          );
          await vi.waitFor(() =>
            expect(socket.close).toHaveBeenCalledWith(1008, 'UNAUTHENTICATED')
          );
        }
        expect(nodeControl.attachWorkbench).not.toHaveBeenCalled();
        expect(nodeControl.attachCliTerminal).not.toHaveBeenCalled();
        const socket = { close: vi.fn(), pause: vi.fn(), resume: vi.fn() };
        routes[method](
          socket as never,
          { headers: { authorization: `Bearer ${token}` }, query: { ticket: 'ticket' } } as never
        );
        await vi.waitFor(() =>
          expect(
            method === 'attach' ? nodeControl.attachCliTerminal : nodeControl.attachWorkbench
          ).toHaveBeenCalledOnce()
        );
        expect(socket.close).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  );

  it('accepts a scoped user credential but never grants another user’s nodes', async () => {
    let enabled = true;
    const pool = {
      execute: async () => [enabled ? [{ id: 7, username: 'alice' }] : []]
    } as unknown as Pool;
    const credentials = new MarctlUserCredentials(pool, Buffer.alloc(32, 7));
    const token = credentials.issue({ userId: 7, sessionHash: 'a'.repeat(43) });
    const app = Fastify();
    const requestNode = vi.fn(async (..._args: unknown[]) => ({
      terminal: { id: 'nested-terminal' }
    }));
    registerMarctlRoutes({
      app,
      userCredentials: credentials,
      publicOrigin: 'http://localhost',
      listNodes: async () => [
        { id: 'mine', connected: true, disabled: false, metadata: '{}', lastHeartbeatAt: null },
        { id: 'other', connected: true, disabled: false, metadata: '{}', lastHeartbeatAt: null }
      ],
      canUseNode: async (userId, nodeId) => userId === 7 && nodeId === 'mine',
      secrets: { resolve: async () => ({}) },
      nodeControl: {
        requestNode,
        createTerminalTicket: vi.fn(),
        attachCliTerminal: vi.fn(),
        closeTerminal: vi.fn(),
        attachWorkbench: vi.fn()
      }
    });
    try {
      const headers = { authorization: `Bearer ${token}` };
      const listing = await app.inject({ url: '/api/marctl/nodes', headers });
      expect(listing.statusCode).toBe(200);
      expect(listing.json().nodes.map((node: { id: string }) => node.id)).toEqual(['mine']);
      const opened = await app.inject({
        method: 'POST',
        url: '/api/marctl/terminals',
        headers,
        payload: { nodeId: 'mine', rows: 24, cols: 80 }
      });
      expect(opened.statusCode).toBe(201);
      const nested = requestNode.mock.calls.at(-1)?.[2] as {
        secretEnvironment: Record<string, string>;
      };
      expect(nested.secretEnvironment.MAR_CTL_CONTEXT_REQUIRED).toBe('1');
      expect(nested.secretEnvironment.MAR_USERNAME).toBe('alice');
      expect(nested.secretEnvironment.MAR_CTL_SERVER_URL).toBe('http://localhost');
      expect(nested.secretEnvironment.MAR_CTL_USER_TOKEN).not.toBe(token);
      expect(
        await credentials.authenticate(`Bearer ${nested.secretEnvironment.MAR_CTL_USER_TOKEN}`)
      ).toMatchObject({ userId: 7, sessionHash: 'a'.repeat(43) });
      enabled = false;
      expect((await app.inject({ url: '/api/marctl/nodes', headers })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
  it('buffers an immediate resume until asynchronous user authentication attaches the relay', async () => {
    const { credentials, token } = createUserContext();
    const authenticate = credentials.authenticate.bind(credentials);
    let releaseAuthentication!: () => void;
    const authenticationReady = new Promise<void>((resolve) => {
      releaseAuthentication = resolve;
    });
    vi.spyOn(credentials, 'authenticate').mockImplementation(async (header) => {
      await authenticationReady;
      return authenticate(header);
    });
    class PausableSocket extends RelaySocket {
      private paused = false;
      private readonly pending: unknown[] = [];
      pause = vi.fn(() => {
        this.paused = true;
      });
      resume = vi.fn(() => {
        this.paused = false;
        for (const message of this.pending.splice(0)) super.receive(message);
      });
      override receive(message: unknown) {
        if (this.paused) this.pending.push(message);
        else super.receive(message);
      }
    }
    const app = Fastify();
    const relay = new WorkbenchRelayService({
      authorizeNodeRequest: async () => true
    });
    const marctl = registerMarctlRoutes({
      app,
      userCredentials: credentials,
      publicOrigin: 'http://localhost',
      listNodes: async () => [],
      canUseNode: async () => true,
      secrets: { resolve: async () => ({}) },
      nodeControl: {
        requestNode: vi.fn(),
        createTerminalTicket: vi.fn(() => ({ ticket: 'ticket' })),
        attachCliTerminal: vi.fn(),
        closeTerminal: vi.fn(),
        attachWorkbench: (socket, user) => relay.attach(socket, user)
      }
    });
    const socket = new PausableSocket();
    try {
      marctl.attachLive(
        socket as never,
        {
          headers: { authorization: `Bearer ${token}` }
        } as never
      );
      socket.receive({ type: 'resume' });
      expect(socket.sent).toEqual([]);
      releaseAuthentication();
      await vi.waitFor(() => expect(socket.sent[0]).toMatchObject({ type: 'workbench.ready' }));
      expect(socket.pause).toHaveBeenCalledOnce();
      expect(socket.resume).toHaveBeenCalledOnce();
    } finally {
      releaseAuthentication();
      relay.close();
      await app.close();
    }
  });

  it('requires user credentials for Node operations and removes deployment key endpoints', async () => {
    const { credentials, token } = createUserContext();
    const app = Fastify();
    const requestNode = vi.fn(async (_nodeId: string, operation: string) =>
      ['terminal.open', 'terminal.command.open', 'terminal.copy.open'].includes(operation)
        ? { terminal: { id: 'terminal-1' } }
        : operation === 'node.workbench.capabilities'
          ? {
              manifest: {
                nodeGeneration: 'generation-1',
                terminalDirect: { apiVersion: 1 }
              }
            }
          : { closed: true }
    );
    const createTerminalTicket = vi.fn(() => ({ ticket: 'ticket-1' }));
    const attachCliTerminal = vi.fn();
    const marctl = registerMarctlRoutes({
      app,
      userCredentials: credentials,
      publicOrigin: 'http://localhost',
      listNodes: async () => [
        {
          id: 'node-1',
          displayName: 'UAT',
          metadata: '{"platform":"linux"}',
          connected: true,
          disabled: false,
          lastHeartbeatAt: null
        },
        {
          id: 'private-node',
          metadata: '{}',
          connected: true,
          disabled: false,
          lastHeartbeatAt: null
        }
      ],
      canUseNode: async (_userId, nodeId) => nodeId === 'node-1',
      secrets: { resolve: async () => ({}) },
      nodeControl: {
        requestNode,
        createTerminalTicket,
        attachCliTerminal,
        closeTerminal: vi.fn(),
        attachWorkbench: vi.fn()
      }
    });
    const browser = { cookie: 'mar_user_session=browser-session', origin: 'http://localhost' };
    try {
      for (const method of ['GET', 'POST', 'DELETE'] as const) {
        expect(
          (
            await app.inject({
              method,
              url: '/api/system-settings/management-key',
              headers: browser
            })
          ).statusCode
        ).toBe(404);
      }
      for (const key of [
        `marctl_${'x'.repeat(43)}`,
        `marmgr_${'x'.repeat(43)}`,
        `marctl_user_${'x'.repeat(43)}`
      ]) {
        const response = await app.inject({
          url: '/api/marctl/nodes',
          headers: { authorization: `Bearer ${key}` }
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
      }
      const unauthorized = await app.inject({
        method: 'GET',
        url: '/api/marctl/nodes',
        headers: browser
      });
      expect(unauthorized.statusCode).toBe(401);
      const auth = { authorization: `Bearer ${token}` };
      const nodes = await app.inject({ method: 'GET', url: '/api/marctl/nodes', headers: auth });
      expect(nodes.json()).toEqual({
        nodes: [{ id: 'node-1', displayName: 'UAT', connected: true, platform: 'linux' }]
      });
      const manifest = await app.inject({
        method: 'GET',
        url: '/api/marctl/nodes/node-1/manifest',
        headers: auth
      });
      expect(manifest.json()).toEqual({
        deferredRelay: true,
        manifest: {
          nodeGeneration: 'generation-1',
          terminalDirect: { apiVersion: 1 }
        }
      });
      const denied = await app.inject({
        method: 'POST',
        url: '/api/marctl/terminals',
        headers: auth,
        payload: { nodeId: 'private-node', rows: 25, cols: 80 }
      });
      expect(denied.statusCode).toBe(403);
      const copy = { mode: 'read', path: "/tmp/report 'quoted' 文档.bin" };
      const openCopy = (payload: unknown, headers: Record<string, string> = auth) =>
        app.inject({
          method: 'POST',
          url: '/api/marctl/terminals/copy',
          headers,
          payload: JSON.stringify(payload)
        });
      const expected = requestNode.mock.calls.length;
      expect(
        (await openCopy({ nodeId: 'node-1', copy }, { 'content-type': 'application/json' }))
          .statusCode
      ).toBe(401);
      expect(
        (
          await openCopy(
            { nodeId: 'private-node', copy },
            { ...auth, 'content-type': 'application/json' }
          )
        ).statusCode
      ).toBe(403);
      for (const payload of [
        { nodeId: 'node-1', copy: { ...copy, executable: '/bin/sh' } },
        { nodeId: 'node-1', copy: { mode: 'write', path: copy.path } },
        { nodeId: 'node-1', copy, command: 'echo ok' }
      ])
        expect(
          (await openCopy(payload, { ...auth, 'content-type': 'application/json' })).statusCode
        ).toBe(400);
      expect(requestNode).toHaveBeenCalledTimes(expected);
      const copyOpened = await openCopy(
        { nodeId: 'node-1', copy },
        { ...auth, 'content-type': 'application/json' }
      );
      expect(copyOpened.statusCode).toBe(201);
      expect(copyOpened.json()).toEqual({ terminalId: 'terminal-1' });
      expect(requestNode).toHaveBeenLastCalledWith(
        'node-1',
        'terminal.copy.open',
        { copy },
        { userId: 1, sessionHash: expect.any(String) }
      );
      const opened = await app.inject({
        method: 'POST',
        url: '/api/marctl/terminals',
        headers: auth,
        payload: { nodeId: 'node-1', rows: 25, cols: 80 }
      });
      expect(opened.statusCode).toBe(201);
      expect(opened.json()).toEqual({ terminalId: 'terminal-1' });
      expect(requestNode).toHaveBeenCalledWith(
        'node-1',
        'terminal.open',
        {
          rows: 25,
          cols: 80,
          secretEnvironment: {
            MAR_CTL_CONTEXT_REQUIRED: '1',
            MAR_USERNAME: 'admin',
            MAR_CTL_SERVER_URL: 'http://localhost',
            MAR_CTL_USER_TOKEN: expect.stringMatching(/^marctl_user_/u)
          }
        },
        { userId: 1, sessionHash: expect.any(String) }
      );
      const command = await app.inject({
        method: 'POST',
        url: '/api/marctl/terminals',
        headers: auth,
        payload: { nodeId: 'node-1', rows: 25, cols: 80, command: 'echo ok' }
      });
      expect(command.statusCode).toBe(201);
      expect(requestNode).toHaveBeenCalledWith(
        'node-1',
        'terminal.command.open',
        {
          rows: 25,
          cols: 80,
          command: 'echo ok',
          secretEnvironment: {
            MAR_CTL_CONTEXT_REQUIRED: '1',
            MAR_USERNAME: 'admin',
            MAR_CTL_SERVER_URL: 'http://localhost',
            MAR_CTL_USER_TOKEN: expect.stringMatching(/^marctl_user_/u)
          }
        },
        { userId: 1, sessionHash: expect.any(String) }
      );
      const existingOpens = requestNode.mock.calls.filter(
        ([, operation]) => operation === 'terminal.command.open'
      ).length;
      for (const extra of [{ binary: true }, { unexpected: true }]) {
        const incompatible = await app.inject({
          method: 'POST',
          url: '/api/marctl/terminals',
          headers: auth,
          payload: { nodeId: 'node-1', rows: 25, cols: 80, command: 'copy', ...extra }
        });
        expect(incompatible.statusCode).toBe(400);
        expect(incompatible.json().error.code).toBe('TERMINAL_OPEN_INVALID');
      }
      expect(
        requestNode.mock.calls.filter(([, operation]) => operation === 'terminal.command.open')
      ).toHaveLength(existingOpens);
      const binary = await app.inject({
        method: 'POST',
        url: '/api/marctl/terminals',
        headers: auth,
        payload: { nodeId: 'node-1', rows: 25, cols: 80, command: 'node -e "test"' }
      });
      expect(binary.statusCode).toBe(201);
      expect(binary.json()).toEqual({ terminalId: 'terminal-1' });
      expect(requestNode).toHaveBeenCalledWith(
        'node-1',
        'terminal.command.open',
        {
          rows: 25,
          cols: 80,
          command: 'node -e "test"',
          secretEnvironment: {
            MAR_CTL_CONTEXT_REQUIRED: '1',
            MAR_USERNAME: 'admin',
            MAR_CTL_SERVER_URL: 'http://localhost',
            MAR_CTL_USER_TOKEN: expect.stringMatching(/^marctl_user_/u)
          }
        },
        { userId: 1, sessionHash: expect.any(String) }
      );
      const maximumCommand = 'a'.repeat(64 * 1024);
      const maximum = await app.inject({
        method: 'POST',
        url: '/api/marctl/terminals',
        headers: auth,
        payload: { nodeId: 'node-1', rows: 25, cols: 80, command: maximumCommand }
      });
      expect(maximum.statusCode).toBe(201);
      expect(requestNode).toHaveBeenCalledWith(
        'node-1',
        'terminal.command.open',
        {
          rows: 25,
          cols: 80,
          command: maximumCommand,
          secretEnvironment: {
            MAR_CTL_CONTEXT_REQUIRED: '1',
            MAR_USERNAME: 'admin',
            MAR_CTL_SERVER_URL: 'http://localhost',
            MAR_CTL_USER_TOKEN: expect.stringMatching(/^marctl_user_/u)
          }
        },
        { userId: 1, sessionHash: expect.any(String) }
      );
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/marctl/terminals',
            headers: auth,
            payload: { nodeId: 'node-1', rows: 25, cols: 80, command: `${maximumCommand}a` }
          })
        ).statusCode
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/marctl/terminals',
            headers: auth,
            payload: {
              nodeId: 'node-1',
              rows: 25,
              cols: 80,
              command: `${'é'.repeat(32 * 1024)}a`
            }
          })
        ).statusCode
      ).toBe(400);
      const ticket = await app.inject({
        method: 'POST',
        url: '/api/marctl/terminals/terminal-1/attach-ticket',
        headers: auth,
        payload: { nodeId: 'node-1' }
      });
      expect(ticket.json()).toEqual({ ticket: 'ticket-1' });
      expect(createTerminalTicket).toHaveBeenCalledWith(
        expect.objectContaining({ terminalId: 'terminal-1', nodeId: 'node-1' })
      );
      const socket = { close: vi.fn() };
      marctl.attach(socket as never, { headers: auth, query: { ticket: 'ticket-1' } } as never);
      await vi.waitFor(() =>
        expect(attachCliTerminal).toHaveBeenCalledWith(
          socket,
          'ticket-1',
          expect.objectContaining({ userId: 1 }),
          expect.any(Number)
        )
      );
      const deferredSocket = { close: vi.fn() };
      marctl.attach(
        deferredSocket as never,
        {
          headers: auth,
          query: { ticket: 'ticket-1', deferred: '1' }
        } as never
      );
      await vi.waitFor(() =>
        expect(attachCliTerminal).toHaveBeenCalledWith(
          deferredSocket,
          { ticket: 'ticket-1', deferred: true },
          expect.objectContaining({ userId: 1 }),
          expect.any(Number)
        )
      );
    } finally {
      await app.close();
    }
  });
});
