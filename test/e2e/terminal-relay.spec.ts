import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createSocket } from 'node:dgram';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
// @ts-expect-error The production Server owns this runtime-only WebSocket client dependency.
import WsClient from '../../ee/server/node_modules/ws/wrapper.mjs';
import { createEnvelope, type NodeEnvelope } from '../../packages/protocol/src/index.js';
import { createServerApp } from '../../ee/server/src/app.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';
import { randomUUID } from 'node:crypto';
import { NodeConnector } from '../../mar-node/src/connector.js';
import { unavailableCapabilities } from '../../mar-node/src/capabilities.js';
import { TerminalManager } from '../../mar-node/src/terminal.js';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from './support/playwright-test-database.js';

test('A real Terminal process survives Server restart and reattaches without replaying input', async () => {
  test.skip(process.platform !== 'linux', 'This regression exercises the Linux PTY lifecycle.');
  test.setTimeout(60_000);
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  const target = resolvePlaywrightTestDatabase(`${runId}-terminal-restart-${randomUUID()}`);
  await createPlaywrightTestDatabase(target);
  const directory = await mkdtemp(join(tmpdir(), 'mar-terminal-server-restart-'));
  const statusPath = join(directory, 'status.json');
  const startsPath = join(directory, 'starts.txt');
  let app: ReturnType<typeof createServerApp> | undefined;
  let connector: NodeConnector | undefined;
  const sockets: TestSocket[] = [];
  const manager = new TerminalManager({
    platform: 'linux',
    cwd: directory,
    profiles: [{ id: 'default', label: 'sh', shell: '/bin/sh', args: [], isDefault: true }]
  });
  const status = async (): Promise<{ pid: number; tick: number }> =>
    JSON.parse(await readFile(statusPath, 'utf8'));
  try {
    const udp = createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      udp.once('error', reject);
      udp.bind(0, '127.0.0.1', resolve);
    });
    const udpPort = udp.address().port;
    await new Promise<void>((resolve) => udp.close(() => resolve()));
    const serverOptions = {
      databaseUrl: target.databaseUrl,
      dataDirectory: join(directory, 'server'),
      secureCookies: false
    };
    app = createServerApp(serverOptions);
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const admin = await adminHeaders(app);
    const registration = await app.inject({
      method: 'POST',
      url: '/api/node-registration-tokens',
      headers: admin,
      payload: { displayName: 'Terminal restart Node' }
    });
    expect(registration.statusCode, registration.body).toBe(200);
    connector = new NodeConnector({
      configPath: join(directory, 'node.json'),
      config: {
        serverUrl: baseUrl,
        dataDirectory: join(directory, 'node'),
        directTransfer: { udpPortRangeBegin: udpPort, udpPortRangeEnd: udpPort },
        allowedRoots: [directory],
        registrationToken: registration.json<{ token: string }>().token
      },
      terminalManager: manager,
      capabilities: unavailableCapabilities()
    });
    await connector.start();
    const nodes = async () => {
      const response = await app!.inject({ method: 'GET', url: '/api/nodes', headers: admin });
      expect(response.statusCode).toBe(200);
      return response.json<{ nodes: { id: string; connected: boolean }[] }>().nodes;
    };
    await expect.poll(nodes).toEqual([expect.objectContaining({ connected: true })]);
    const nodeId = (await nodes())[0]!.id;
    const openedTerminal = await app.inject({
      method: 'POST',
      url: '/api/terminals',
      headers: admin,
      payload: { nodeId }
    });
    expect(openedTerminal.statusCode, openedTerminal.body).toBe(201);
    const terminalId = openedTerminal.json<{ terminal: { id: string } }>().terminal.id;
    const attach = async (afterSequence: number) => {
      const response = await app!.inject({
        method: 'POST',
        url: `/api/terminals/${terminalId}/attach-ticket`,
        headers: admin,
        payload: { nodeId, afterSequence }
      });
      expect(response.statusCode).toBe(201);
      const ticket = response.json<{ ticket: string }>().ticket;
      const socket = new WsClient(
        `${baseUrl.replace('http', 'ws')}/api/terminals/${terminalId}/connect?ticket=${encodeURIComponent(ticket)}`,
        { headers: { cookie: admin.cookie, origin: baseUrl } }
      );
      sockets.push(socket);
      const frames: { type: string; sequence?: number; data?: string }[] = [];
      socket.on('message', (raw: { toString(): string }) =>
        frames.push(JSON.parse(raw.toString()))
      );
      await opened(socket as unknown as TestSocket);
      await expect.poll(() => frames.some((frame) => frame.type === 'attach')).toBe(true);
      return { socket, frames };
    };
    const first = await attach(0);
    const command = `const fs=require("node:fs");let tick=0;fs.appendFileSync(${JSON.stringify(startsPath)},"start\\n");setInterval(()=>{fs.writeFileSync(${JSON.stringify(statusPath + '.tmp')},JSON.stringify({pid:process.pid,tick:++tick}));fs.renameSync(${JSON.stringify(statusPath + '.tmp')},${JSON.stringify(statusPath)});console.log("MAR_TICK "+process.pid+" "+tick)},100)`;
    // This is the only input frame: reconnect must never rerun the command.
    // Replace the shell so PID assertions track the PTY process itself.
    first.socket.send(
      JSON.stringify({
        type: 'input',
        terminalId,
        data: `exec ${JSON.stringify(process.execPath)} -e '${command}'\n`
      })
    );
    await expect
      .poll(() =>
        first.frames
          .filter((frame) => frame.type === 'output')
          .map((frame) => frame.data)
          .join('')
      )
      .toMatch(/MAR_TICK \d+ \d+/u);
    const before = await status();
    await expect
      .poll(() =>
        first.frames
          .filter((frame) => frame.type === 'output')
          .map((frame) => frame.data)
          .join('')
      )
      .toContain(`MAR_TICK ${before.pid} `);
    const afterSequence = Math.max(...first.frames.map((frame) => frame.sequence ?? 0));
    const disconnected = closed(first.socket as unknown as TestSocket);
    await app.shutdown();
    app = undefined;
    await disconnected;
    await expect.poll(async () => (await status()).tick).toBeGreaterThan(before.tick);
    expect((await status()).pid).toBe(before.pid);
    expect(manager.get(terminalId).state).toBe('RUNNING');

    app = createServerApp(serverOptions);
    await app.listen({ host: '127.0.0.1', port: Number(new URL(baseUrl).port) });
    await expect
      .poll(nodes, { timeout: 15_000 })
      .toEqual([expect.objectContaining({ id: nodeId, connected: true })]);
    const listed = await app.inject({
      method: 'GET',
      url: `/api/terminals?nodeId=${nodeId}`,
      headers: admin
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ terminals: [{ id: terminalId, state: 'RUNNING' }] });
    const resumed = await attach(afterSequence);
    const resumedAt = (await status()).tick;
    await expect
      .poll(() => {
        const output = resumed.frames
          .filter((frame) => frame.type === 'output')
          .map((frame) => frame.data)
          .join('');
        return [...output.matchAll(/(?:^|[\r\n])MAR_TICK (\d+) (\d+)/gu)].some(
          (match) => Number(match[1]) === before.pid && Number(match[2]) > resumedAt
        );
      })
      .toBe(true);
    expect(await readFile(startsPath, 'utf8')).toBe('start\n');
    const closedTerminal = await app.inject({
      method: 'DELETE',
      url: `/api/terminals/${terminalId}`,
      headers: admin,
      payload: { nodeId }
    });
    expect(closedTerminal.statusCode).toBe(200);
    expect(manager.get(terminalId).state).toBe('CLOSED');
    await expect
      .poll(() => {
        try {
          process.kill(before.pid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          return true;
        }
      })
      .toBe(true);
    await test.info().attach('terminal-restart-evidence', {
      body: JSON.stringify({
        runId,
        database: target.databaseName,
        baseUrl,
        udpPort,
        directory,
        nodeId,
        terminalId,
        pid: before.pid,
        beforeTick: before.tick,
        afterReconnectTick: resumedAt,
        afterSequence,
        inputFrames: 1,
        starts: 1,
        processReleased: true
      }),
      contentType: 'application/json'
    });
  } finally {
    for (const socket of sockets) socket.close();
    try {
      try {
        await connector?.stop();
      } finally {
        await manager.shutdown();
      }
    } finally {
      try {
        await app?.shutdown();
      } finally {
        try {
          await dropPlaywrightTestDatabase(target);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
  }
});

test('Admin Terminal uses one-use tickets and a dual-WebSocket relay with replay and closure restrictions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-roam-terminal-relay-'));
  const app = createServerApp({
    databasePath: join(directory, 'server.sqlite'),
    secureCookies: false
  });
  let controlSocket: TestSocket | undefined;
  let terminalSocket: TestSocket | undefined;
  let browserSocket: TestSocket | undefined;
  let readerSocket: TestSocket | undefined;
  try {
    const admin = await adminHeaders(app);
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const registration = await app.inject({
      method: 'POST',
      url: '/api/node-registration-tokens',
      headers: admin
    });
    const control = new WsClient(`${baseUrl.replace('http', 'ws')}/api/node/connect`) as TestSocket;
    controlSocket = control;
    await opened(control);
    control.send(
      JSON.stringify(
        createEnvelope('register', {
          registrationToken: registration.json<{ token: string }>().token,
          capabilities: {
            platform: 'linux',
            architecture: 'x64',
            nodeVersion: process.version,
            codex: { available: false },
            claudeCode: { available: false }
          }
        })
      )
    );
    const registered = await jsonMessage(control);
    const registeredPayload = registered.payload as { nodeId: string; credential: string };
    const nodeId = registeredPayload.nodeId;

    const terminal = new WsClient(
      `${baseUrl.replace('http', 'ws')}/api/node/terminal-connect`
    ) as TestSocket;
    terminalSocket = terminal;
    await opened(terminal);
    terminal.send(
      JSON.stringify({
        type: 'authenticate',
        nodeId,
        credential: registeredPayload.credential
      })
    );
    await expect(jsonMessage(terminal)).resolves.toEqual({ type: 'authenticated', nodeId });

    const ticketResponse = await app.inject({
      method: 'POST',
      url: '/api/terminals/terminal-a/attach-ticket',
      headers: admin,
      payload: { nodeId, afterSequence: 0 }
    });
    expect(ticketResponse.statusCode).toBe(201);
    const ticket = ticketResponse.json<{ ticket: string }>().ticket;
    const browserUrl = `${baseUrl.replace('http', 'ws')}/api/terminals/terminal-a/connect?ticket=${encodeURIComponent(ticket)}`;
    const browser = new WsClient(browserUrl, [], {
      headers: { cookie: admin.cookie, origin: baseUrl }
    }) as TestSocket;
    browserSocket = browser;
    await opened(browser);
    const authorize = await jsonMessage(control);
    expect(authorize).toMatchObject({
      type: 'node.request',
      payload: { operation: 'terminal.attach.authorize', data: { terminalId: 'terminal-a' } }
    });
    respond(control, authorize as NodeEnvelope, {
      attachment: {
        attachmentId: 'attachment-a',
        terminalId: 'terminal-a',
        latestSequence: 0,
        frames: []
      }
    });
    await expect(jsonMessage(terminal)).resolves.toEqual({
      type: 'attach',
      ticket,
      terminalId: 'terminal-a',
      attachmentId: 'attachment-a',
      latestSequence: 0
    });
    terminal.send(JSON.stringify({ type: 'attached', ticket, terminalId: 'terminal-a' }));
    await expect(jsonMessage(browser)).resolves.toEqual({
      type: 'attach',
      terminalId: 'terminal-a',
      afterSequence: 0
    });

    const readerTicketResponse = await app.inject({
      method: 'POST',
      url: '/api/terminals/terminal-a/attach-ticket',
      headers: admin,
      payload: { nodeId, afterSequence: 1, readonly: true }
    });
    const readerTicket = readerTicketResponse.json<{ ticket: string }>().ticket;
    const reader = new WsClient(
      `${baseUrl.replace('http', 'ws')}/api/terminals/terminal-a/connect?ticket=${encodeURIComponent(readerTicket)}`,
      [],
      { headers: { cookie: admin.cookie, origin: baseUrl } }
    ) as TestSocket;
    readerSocket = reader;
    await opened(reader);
    const readerAuthorize = await jsonMessage(control);
    expect(readerAuthorize).toMatchObject({
      type: 'node.request',
      payload: { operation: 'terminal.attach.authorize', data: { readonly: true } }
    });
    respond(control, readerAuthorize as NodeEnvelope, {
      attachment: {
        attachmentId: 'attachment-reader',
        terminalId: 'terminal-a',
        latestSequence: 1,
        frames: []
      }
    });
    await expect(jsonMessage(terminal)).resolves.toEqual({
      type: 'attach',
      ticket: readerTicket,
      terminalId: 'terminal-a',
      attachmentId: 'attachment-reader',
      latestSequence: 1
    });
    terminal.send(
      JSON.stringify({ type: 'attached', ticket: readerTicket, terminalId: 'terminal-a' })
    );
    await expect(jsonMessage(reader)).resolves.toEqual({
      type: 'attach',
      terminalId: 'terminal-a',
      afterSequence: 1
    });

    browser.send(JSON.stringify({ type: 'input', terminalId: 'terminal-a', data: 'echo ok\n' }));
    await expect(jsonMessage(terminal)).resolves.toMatchObject({
      type: 'frame',
      ticket,
      frame: { type: 'input', terminalId: 'terminal-a', data: 'echo ok\n' }
    });
    terminal.send(
      JSON.stringify({
        type: 'frame',
        ticket,
        frame: { type: 'output', terminalId: 'terminal-a', sequence: 1, data: 'ok\n' }
      })
    );
    await expect(jsonMessage(browser)).resolves.toEqual({
      type: 'output',
      terminalId: 'terminal-a',
      sequence: 1,
      data: 'ok\n'
    });

    const rejectedTakeover = await app.inject({
      method: 'POST',
      url: '/api/terminals/terminal-a/attach-ticket',
      headers: admin,
      payload: { nodeId, afterSequence: 1, takeover: true }
    });
    expect(rejectedTakeover.statusCode).toBe(400);
    const conflictTicketResponse = await app.inject({
      method: 'POST',
      url: '/api/terminals/terminal-a/attach-ticket',
      headers: admin,
      payload: { nodeId, afterSequence: 1 }
    });
    const conflictTicket = conflictTicketResponse.json<{ ticket: string }>().ticket;
    const competing = new WsClient(
      `${baseUrl.replace('http', 'ws')}/api/terminals/terminal-a/connect?ticket=${encodeURIComponent(conflictTicket)}`,
      [],
      { headers: { cookie: admin.cookie, origin: baseUrl } }
    ) as TestSocket;
    await opened(competing);
    const competingAuthorize = await jsonMessage(control);
    expect(competingAuthorize).toMatchObject({
      type: 'node.request',
      payload: { operation: 'terminal.attach.authorize', data: { readonly: false } }
    });
    const competingClosed = closed(competing);
    control.send(
      JSON.stringify(
        createEnvelope(
          'node.response',
          {
            error: 'TERMINAL_ATTACH_CONFLICT',
            message: 'Terminal is already attached.'
          },
          { replyTo: (competingAuthorize as NodeEnvelope).id }
        )
      )
    );
    await expect(jsonMessage(competing)).resolves.toMatchObject({
      type: 'error',
      terminalId: 'terminal-a',
      code: 'TERMINAL_ATTACH_CONFLICT'
    });
    await expect(competingClosed).resolves.toMatchObject({ code: 4008 });
    browser.send(
      JSON.stringify({ type: 'input', terminalId: 'terminal-a', data: 'still connected\n' })
    );
    await expect(jsonMessage(terminal)).resolves.toMatchObject({
      type: 'frame',
      ticket,
      frame: { type: 'input', terminalId: 'terminal-a', data: 'still connected\n' }
    });
    terminal.send(
      JSON.stringify({
        type: 'frame',
        ticket: readerTicket,
        frame: { type: 'output', terminalId: 'terminal-a', sequence: 2, data: 'reader stays\n' }
      })
    );
    await expect(jsonMessage(reader)).resolves.toEqual({
      type: 'output',
      terminalId: 'terminal-a',
      sequence: 2,
      data: 'reader stays\n'
    });

    const replay = new WsClient(browserUrl, [], {
      headers: { cookie: admin.cookie, origin: baseUrl }
    });
    await expect(closed(replay)).resolves.toMatchObject({ code: 4008 });

    const unauthenticated = new WsClient(browserUrl, [], {
      headers: { cookie: 'invalid-session=token', origin: baseUrl }
    });
    await expect(closed(unauthenticated)).resolves.toMatchObject({ code: 4001 });

    browser.send(JSON.stringify({ type: 'close', terminalId: 'terminal-a' }));
    await expect(jsonMessage(terminal)).resolves.toMatchObject({
      type: 'frame',
      ticket,
      frame: { type: 'close', terminalId: 'terminal-a' }
    });
    terminal.send(
      JSON.stringify({
        type: 'frame',
        ticket,
        frame: { type: 'exit', terminalId: 'terminal-a', exitCode: 0 }
      })
    );
    await expect(jsonMessage(browser)).resolves.toEqual({
      type: 'exit',
      terminalId: 'terminal-a',
      exitCode: 0
    });
    await expect(closed(browser)).resolves.toMatchObject({ code: 1000 });
    browserSocket = undefined;

    const reconnectedTerminal = new WsClient(
      `${baseUrl.replace('http', 'ws')}/api/node/terminal-connect`
    ) as TestSocket;
    await opened(reconnectedTerminal);
    const previousTerminalClosed = closed(terminal);
    const readerRelayClosed = closed(reader);
    reconnectedTerminal.send(
      JSON.stringify({
        type: 'authenticate',
        nodeId,
        credential: registeredPayload.credential
      })
    );
    await expect(jsonMessage(reconnectedTerminal)).resolves.toEqual({
      type: 'authenticated',
      nodeId
    });
    await expect(previousTerminalClosed).resolves.toEqual({
      code: 4000,
      reason: 'TERMINAL_SOCKET_REPLACED'
    });
    await expect(readerRelayClosed).resolves.toEqual({
      code: 1000,
      reason: 'TERMINAL_RELAY_CLOSED'
    });
    terminalSocket = reconnectedTerminal;
    readerSocket = undefined;
  } finally {
    browserSocket?.close();
    readerSocket?.close();
    terminalSocket?.close();
    controlSocket?.close();
    await app.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

async function adminHeaders(app: ReturnType<typeof createServerApp>): Promise<{
  readonly cookie: string;
  readonly 'x-csrf-token': string;
}> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
  });
  const changed = await app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: {
      cookie: cookieFrom(login.headers['set-cookie']),
      'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken
    },
    payload: { currentPassword: INITIAL_ADMIN_PASSWORD, password: 'terminal-relay-password-123' }
  });
  return {
    cookie: cookieFrom(changed.headers['set-cookie']),
    'x-csrf-token': changed.json<{ csrfToken: string }>().csrfToken
  };
}

interface TestSocket {
  send(raw: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'error',
    listener: () => void,
    options?: { once?: boolean }
  ): void;
  addEventListener(
    type: 'close',
    listener: (event: { readonly code: number; readonly reason: string }) => void,
    options?: { once?: boolean }
  ): void;
  addEventListener(
    type: 'message',
    listener: (event: { readonly data: unknown }) => void,
    options?: { once?: boolean }
  ): void;
}

function respond(socket: TestSocket, command: NodeEnvelope, result: unknown): void {
  socket.send(JSON.stringify(createEnvelope('node.response', { result }, { replyTo: command.id })));
}

function opened(socket: TestSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('SOCKET_ERROR')), { once: true });
  });
}

function closed(socket: TestSocket): Promise<{ readonly code: number; readonly reason: string }> {
  return new Promise((resolve, reject) => {
    socket.addEventListener(
      'close',
      (event) => resolve({ code: event.code, reason: event.reason }),
      { once: true }
    );
    socket.addEventListener('error', () => reject(new Error('SOCKET_ERROR')), { once: true });
  });
}

function jsonMessage(socket: TestSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SOCKET_MESSAGE_TIMEOUT')), 5_000);
    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      },
      { once: true }
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('SOCKET_ERROR'));
      },
      { once: true }
    );
  });
}

function cookieFrom(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(';', 1)[0] ?? '';
}
