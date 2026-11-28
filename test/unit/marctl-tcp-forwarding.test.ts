import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { resolve } from 'node:path';
import type { Pool } from 'mysql2/promise';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '../../packages/protocol/src/index.js';
import { NodeDataChannel } from '../../mar-node/src/service/node-data-channel.js';
import { TcpForwardingService } from '../../mar-node/src/service/tcp-forwarding-service.js';
import { MarctlUserCredentials } from '../../packages/server-core/src/marctl-user-credentials.js';
import { registerRealtimeRoutes } from '../../ee/server/src/route/realtime-routes.js';
import { ServerDatabase } from '../../ee/server/src/database.js';
import { createTestNodeControl } from '../support/create-test-node-control.js';

const requireServer = createRequire(resolve('ee/server/package.json'));
const Fastify = requireServer(
  'fastify'
) as typeof import('../../ee/server/node_modules/fastify/fastify.js').default;
const WebSocket = requireServer(
  'ws'
) as typeof import('../../ee/server/node_modules/@types/ws/index.js');
const cli = resolve('marctl/bin/marctl.mjs');
const host = '127.0.0.1';
const teardown: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const release of teardown.splice(0).reverse()) await release();
});

async function reserve(accept?: (socket: Socket) => void, address = host) {
  const server = createServer({ allowHalfOpen: true }, accept);
  const port = await bind(server, 0, address);
  teardown.push(() => {
    server.close();
  });
  return { server, port };
}

async function bind(server: Server, port = 0, listenHost = host) {
  server.listen({ host: listenHost, port });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing IP endpoint');
  return address.port;
}

async function fixture({ expireSessionOnCarrierAdmission = false } = {}) {
  const database = new ServerDatabase(':memory:');
  const user = { userId: database.getAdmin().id, sessionHash: 'a'.repeat(43) };
  const { nodeId, credential } = database.registerNode(
    database.createNodeRegistrationToken(user.userId).token,
    { metadata: '{}' }
  )!;
  const control = createTestNodeControl(database, async () => true);
  const app = Fastify();
  let sessionActive = true;
  const pool = {
    execute: async () => [sessionActive ? [{ id: user.userId }] : []]
  } as unknown as Pool;
  const credentials = new MarctlUserCredentials(pool, Buffer.alloc(32, 9));
  let allowed = true;
  registerRealtimeRoutes({
    app,
    database,
    nodeControl: control,
    publicOrigin: undefined,
    relayAccess: {
      credentials,
      canUseNode: async (id, node) => {
        if (expireSessionOnCarrierAdmission) sessionActive = false;
        return allowed && id === user.userId && node === nodeId;
      },
      canAccessNodeContainer: async () => true
    }
  });
  app.get('/api/marctl/nodes', () => ({ nodes: [{ id: nodeId, connected: true }] }));
  teardown.push(async () => {
    await app.close();
    await control.close();
    database.close();
  });
  const serverUrl = await app.listen({ host, port: 0 });
  const socket = new WebSocket(`${serverUrl.replace(/^http/u, 'ws')}/api/node/connect`);
  teardown.push(() => socket.terminate());
  await once(socket, 'open');
  const authenticated = once(socket, 'message');
  socket.send(JSON.stringify(createEnvelope('authenticate', { nodeId, credential })));
  expect(JSON.parse(String((await authenticated)[0])).type).toBe('authenticated');
  const forwarded = once(socket, 'message');
  socket.send(
    JSON.stringify(
      createEnvelope('capabilities', {
        platform: 'linux',
        architecture: 'x64',
        nodeAppVersion: '0.15.24',
        nodeVersion: 'v24',
        codex: { available: false },
        claudeCode: { available: false }
      })
    )
  );
  const binding = JSON.parse(String((await forwarded)[0])).payload.dataControlBinding;
  expect(typeof binding).toBe('string');
  const forwarding = new TcpForwardingService();
  const data = new NodeDataChannel({
    config: () => ({ serverUrl, nodeId, credential, allowedRoots: [] }),
    controlConnected: () => true,
    reconnect: false,
    reconnectDelay: () => 0,
    accept: async (request) => forwarding.accept(request)
  });
  data.connect(binding);
  teardown.push(() => data.disconnect());
  return {
    invalidateLogin() {
      sessionActive = false;
      control.invalidateLoginSession(user.sessionHash);
    },
    async changeUserAccess(next = false) {
      allowed = next;
      await control.revalidateUserAuthorizations(user.userId);
    },
    deleteUser() {
      allowed = false;
      sessionActive = false;
      control.closeUserSessions(user.userId);
    },
    async changeOrganizationAccess() {
      allowed = false;
      await control.revalidateOrganizationAuthorizations([]);
    },
    revalidateNodeAccess() {
      return control.revalidateDataAuthorizations({ nodeId });
    },
    async revoke() {
      allowed = false;
      await control.revalidateDataAuthorizations({ nodeId });
    },
    run(
      direction: '-L' | '-R',
      listen: number,
      target: number,
      agent = false,
      backgroundBind?: string,
      targetHost = host
    ) {
      const token = agent
        ? credentials.issue(
            user,
            { nodeId, workspaceId: 'agent-workspace' },
            { type: 'execution', sessionId: 'agent-session', executionId: 'agent-execution' }
          )
        : credentials.issue(user);
      const spec = `${backgroundBind === undefined ? '' : `${backgroundBind}:`}${listen}:${targetHost}:${target}`;
      const flags =
        backgroundBind === undefined ? ['-N', direction, spec] : [`-fN${direction[1]}${spec}`];
      // The in-memory registry uses base64url IDs, which can begin with a hyphen.
      const child = spawn(process.execPath, [cli, 'ssh', ...flags, '--', nodeId], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          LANG: 'en_US.UTF-8',
          MAR_CTL_SERVER_URL: serverUrl,
          MAR_CTL_CONTEXT_REQUIRED: '1',
          MAR_CTL_USER_TOKEN: token
        }
      });
      const exited = once(child, 'close');
      teardown.push(async () => {
        child.kill('SIGTERM');
        await exited;
      });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (line) => {
        stderr += line;
      });
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', (line) => {
        stdout += line;
      });
      const ready = once(child.stdout, 'data').then(([bytes]) => String(bytes));
      return {
        ready: () =>
          Promise.race([
            ready,
            exited.then(([status]) => {
              throw new Error(`CLI exited ${status}: ${stderr}`);
            })
          ]),
        stop: () => child.kill('SIGINT'),
        result: async () => ({ status: (await exited)[0], stderr, stdout })
      };
    }
  };
}

describe('marctl TCP forwarding through the production Relay', () => {
  it.each(['-L', '-R'] as const)(
    'forwards %s past one credit window and preserves half-close',
    async (direction) => {
      const runtime = await fixture();
      const body = Buffer.alloc(600_000, 0x9c);
      const response = Buffer.alloc(650_000, 0x2e);
      const received = Promise.withResolvers<Buffer>();
      const target = await reserve((socket) => {
        const chunks: Buffer[] = [];
        socket.on('data', (bytes) => chunks.push(bytes));
        socket.on('error', () => {});
        socket.once('end', () => {
          received.resolve(Buffer.concat(chunks));
          socket.end(response);
        });
      });
      const listener = await reserve();
      await new Promise<void>((resolve) => listener.server.close(() => resolve()));
      const forward = runtime.run(
        direction,
        listener.port,
        target.port,
        direction === '-R',
        undefined,
        'localhost'
      );
      expect(await forward.ready()).toContain(String(listener.port));
      const socket = createConnection({ host, port: listener.port, allowHalfOpen: true });
      teardown.push(() => {
        socket.destroy();
      });
      const output = (async () => {
        const chunks: Buffer[] = [];
        for await (const data of socket) chunks.push(data);
        return Buffer.concat(chunks);
      })();
      socket.end(body);
      const input = await received.promise;
      expect(input.length).toBe(body.length);
      expect(input.equals(body)).toBe(true);
      const result = await output;
      expect(result.length).toBe(response.length);
      expect(result.equals(response)).toBe(true);
      forward.stop();
      expect((await forward.result()).status).toBe(130);
      await bind(listener.server, listener.port);
    }
  );

  it.each(['-L', '-R'] as const)(
    'forwards %s between IPv6 endpoints after the launching command exits',
    async (direction) => {
      const runtime = await fixture();
      const target = await reserve((socket) => {
        socket.on('error', () => {});
        socket.write('background');
      }, '::1');
      const listener = await reserve(undefined, '::1');
      await new Promise<void>((resolve) => listener.server.close(() => resolve()));
      const launched = await runtime
        .run(direction, listener.port, target.port, true, '[::1]', '[::1]')
        .result();
      expect(launched).toMatchObject({ status: 0, stderr: '' });
      expect(launched.stdout).toContain(`[::1]:${listener.port}`);
      const pid = Number(/\bPID (\d+)\b/u.exec(launched.stdout)?.[1]);
      expect(pid).toBeGreaterThan(0);

      const socket = createConnection({ host: '::1', port: listener.port });
      teardown.push(() => {
        socket.destroy();
      });
      expect(String((await once(socket, 'data'))[0])).toBe('background');
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.on('error', () => {});
      if (direction === '-L') process.kill(pid, 'SIGTERM');
      else await runtime.revoke();
      await closed;
      await vi.waitFor(() => bind(listener.server, listener.port, '::1'));
    }
  );

  it('blocks new relay data after sign-in invalidation without closing admitted data', async () => {
    const runtime = await fixture();
    const target = await reserve();
    const listener = await reserve();
    await new Promise<void>((resolve) => listener.server.close(() => resolve()));
    const forward = runtime.run('-L', listener.port, target.port);
    expect(await forward.ready()).toContain(`127.0.0.1:${listener.port}`);

    const accepted = once(target.server, 'connection');
    const probe = createConnection({ port: listener.port, host });
    const [[remote]] = await Promise.all([accepted, once(probe, 'connect')]);
    try {
      runtime.invalidateLogin();
      // A later ACL edit retaining Node access must not treat a retired login as resource loss.
      await runtime.revalidateNodeAccess();
      const data = once(probe, 'data', { signal: AbortSignal.timeout(2_000) });
      remote.write('still admitted');
      expect(String((await data)[0])).toBe('still admitted');

      const extra = createConnection({ port: listener.port, host });
      try {
        await once(extra, 'close', { signal: AbortSignal.timeout(2_000) });
      } finally {
        extra.destroy();
      }
    } finally {
      remote.destroy();
      probe.destroy();
    }

    await runtime.revoke();
    await vi.waitFor(() => bind(listener.server, listener.port));
    expect(await forward.result()).toMatchObject({ status: 1 });
  });

  it.each(['changeUserAccess', 'deleteUser', 'changeOrganizationAccess'] as const)(
    'ends the forwarding lease when %s removes effective Node access',
    async (change) => {
      const runtime = await fixture();
      const target = await reserve();
      const listener = await reserve();
      await new Promise<void>((resolve) => listener.server.close(() => resolve()));
      const forward = runtime.run('-R', listener.port, target.port);
      await forward.ready();

      // A role change that leaves effective access allows both the listener and new data OPENs.
      await runtime.changeUserAccess(true);
      const accepted = once(target.server, 'connection', { signal: AbortSignal.timeout(2_000) });
      const probe = createConnection({ host, port: listener.port });
      teardown.push(() => {
        probe.destroy();
      });
      probe.on('error', () => {});
      const [[remote]] = await Promise.all([accepted, once(probe, 'connect')]);
      teardown.push(() => {
        remote.destroy();
      });
      const data = once(probe, 'data');
      remote.write('retained');
      expect(String((await data)[0])).toBe('retained');

      const closed = once(probe, 'close', { signal: AbortSignal.timeout(2_000) });
      await runtime[change]();
      await closed;
      expect(await forward.result()).toMatchObject({
        status: 1,
        stderr: expect.stringContaining('RESOURCE_DENIED')
      });
      await bind(listener.server, listener.port);
    }
  );

  it('does not admit the carrier when a CLI session expires during Node authorization', async () => {
    const runtime = await fixture({ expireSessionOnCarrierAdmission: true });
    const target = await reserve();
    const listener = await reserve();
    await new Promise<void>((resolve) => listener.server.close(() => resolve()));

    expect(await runtime.run('-R', listener.port, target.port).result()).toMatchObject({
      status: 1,
      stdout: '',
      stderr: expect.stringContaining('NODE_RELAY_UNAVAILABLE')
    });
    await bind(listener.server, listener.port);
  });

  it('reports occupied local and remote listeners and rejects a CLI user without Node access', async () => {
    const runtime = await fixture();
    const occupied = await reserve((socket) => socket.destroy());
    expect(await runtime.run('-R', occupied.port, 8080).result()).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('TCP_FORWARD_LISTEN_FAILED')
    });
    expect(await runtime.run('-L', occupied.port, 8080).result()).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('TCP_FORWARD_LISTEN_FAILED')
    });
    for (const direction of ['-L', '-R'] as const) {
      expect(await runtime.run(direction, occupied.port, 8080, true, host).result()).toMatchObject({
        status: 1,
        stdout: '',
        stderr: expect.stringContaining('TCP_FORWARD_LISTEN_FAILED')
      });
    }
    await new Promise<void>((resolve) => occupied.server.close(() => resolve()));
    await runtime.revoke();
    expect(await runtime.run('-R', occupied.port, 8080, true).result()).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('NODE_RELAY_UNAVAILABLE')
    });
    await bind(occupied.server, occupied.port);
  });

  it.each(['-L', '-R'] as const)(
    '%s releases a refused target promptly and revokes the next connection',
    async (direction) => {
      const runtime = await fixture();
      const listener = await reserve();
      const target = await reserve();
      await Promise.all(
        [listener, target].map(
          ({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))
        )
      );
      const forward = runtime.run(direction, listener.port, target.port);
      await forward.ready();
      const first = createConnection({ host, port: listener.port });
      teardown.push(() => {
        first.destroy();
      });
      first.on('error', () => {});
      // The failed connection must close without waiting for the 10s attachment deadline.
      await once(first, 'close', { signal: AbortSignal.timeout(2_000) });
      target.server.on('connection', (socket) => {
        socket.on('error', () => {});
        socket.write('connected');
      });
      await bind(target.server, target.port);
      const second = createConnection({ host, port: listener.port });
      teardown.push(() => {
        second.destroy();
      });
      expect(String((await once(second, 'data'))[0])).toBe('connected');
      const closed = new Promise<void>((resolve) => second.once('close', () => resolve()));
      second.on('error', () => {});
      await runtime.revoke();
      await closed;
      expect(await forward.result()).toMatchObject({
        status: 1,
        stderr: expect.stringContaining('RESOURCE_DENIED')
      });
      await bind(listener.server, listener.port);
    }
  );
});
