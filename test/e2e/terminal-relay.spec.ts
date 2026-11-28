import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
// @ts-expect-error The production Server owns this runtime-only WebSocket client dependency.
import WsClient from '../../ee/server/node_modules/ws/wrapper.mjs';
import { decodeTerminalMessage, encodeTerminalMessage } from '../../packages/protocol/src/index.js';
import { testRelayPath } from './support/node-relay-fixture.js';
import { decodeNodeStreamFrame } from '../../packages/protocol/src/node-stream-wire.js';
import {
  readTerminalRecords,
  writeTerminalRecord
} from '../../packages/protocol/src/terminal-stream.js';
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

test('marctl executes and copies through isolated Server and Node, with real direct and relay terminals', async () => {
  test.skip(
    process.platform !== 'linux',
    'This journey requires the Linux native direct transport.'
  );
  test.setTimeout(120_000);
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  const target = resolvePlaywrightTestDatabase(`${runId}-marctl-${randomUUID()}`);
  await createPlaywrightTestDatabase(target);
  const directory = await mkdtemp(join(tmpdir(), 'marctl-real-transport-'));
  let app: Awaited<ReturnType<typeof createServerApp>>['app'] | undefined;
  let connector: NodeConnector | undefined;
  let closeRelay: (() => void) | undefined;
  const manager = new TerminalManager({
    platform: 'linux',
    cwd: directory,
    profiles: [{ id: 'default', label: 'sh', shell: '/bin/sh', args: [], isDefault: true }]
  });
  try {
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('TEST_PORT_UNAVAILABLE');
    const origin = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve()))
    );
    const udp = createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      udp.once('error', reject);
      udp.bind(0, '127.0.0.1', resolve);
    });
    const udpPort = udp.address().port;
    await new Promise<void>((resolve) => udp.close(() => resolve()));
    app = (
      await createServerApp({
        databaseUrl: target.databaseUrl,
        dataDirectory: join(directory, 'server'),
        secureCookies: false,
        publicOrigin: origin
      })
    ).app;
    let muxConnections = 0;
    let observedCliRelayCarriers = 0;
    let cliRelayStreams = 0;
    let closedPrivateCarriers = 0;
    let privateRelayStreams = 0;
    const connectedPath = join(directory, 'pooled-direct-ready');
    const directConnections: { transports: number; streams: string[] }[] = [];
    app.server.on('upgrade', (request) => {
      if (request.url?.startsWith('/api/relay/') && request.headers.authorization) muxConnections++;
    });
    let observingDirect = false;
    app.addHook('onRequest', async (request) => {
      if (
        observingDirect ||
        (request.url !== '/api/marctl/live' && !request.url.startsWith('/api/relay/'))
      )
        return;
      // The WebSocket server is decorated on the realtime route scope, not the root app.
      observingDirect = true;
      request.server.websocketServer.on('connection', (wire, upgrade) => {
        if (upgrade.url?.startsWith('/api/relay/') && upgrade.headers.authorization) {
          observedCliRelayCarriers++;
          const pooled = observedCliRelayCarriers === 1;
          if (!pooled) wire.once('close', () => closedPrivateCarriers++);
          wire.on('message', (raw, binary) => {
            if (binary && decodeNodeStreamFrame(raw).type === 'OPEN') {
              if (pooled) cliRelayStreams++;
              else privateRelayStreams++;
            }
          });
          return;
        }
        if (upgrade.url !== '/api/marctl/live') return;
        const stats = { transports: 0, streams: [] as string[] };
        directConnections.push(stats);
        wire.on('message', (raw, binary) => {
          if (binary) return;
          const frame = JSON.parse(raw.toString());
          if (frame.type === 'direct.prepare') stats.transports++;
          if (frame.type === 'terminal.direct.prepare')
            stats.streams.push(frame.transportSessionId);
        });
        if (directConnections.length === 1) {
          const send = wire.send.bind(wire) as typeof wire.send;
          wire.send = ((raw: string | Uint8Array, ...args: unknown[]) => {
            if (typeof raw === 'string' && JSON.parse(raw).type === 'direct.opened')
              void writeFile(connectedPath, 'ready');
            return Reflect.apply(send, wire, [raw, ...args]);
          }) as typeof wire.send;
        }
      });
    });
    await app.listen({ host: '127.0.0.1', port: address.port });
    expect(app.hasRoute({ method: 'GET', url: '/api/relay/:nodeId' })).toBe(true);
    for (const url of [
      '/api/node/terminal-connect',
      '/api/terminals/:terminalId/connect',
      '/api/marctl/terminals/:terminalId/connect',
      '/api/marctl/terminals/connect'
    ])
      expect(app.hasRoute({ method: 'GET', url })).toBe(false);
    const admin = await adminHeaders(app);
    const registration = await app.inject({
      method: 'POST',
      url: '/api/node-registration-tokens',
      headers: admin,
      payload: { displayName: 'marctl isolated Node' }
    });
    expect(registration.statusCode, registration.body).toBe(200);
    connector = new NodeConnector({
      configPath: join(directory, 'node.json'),
      config: {
        serverUrl: origin,
        dataDirectory: join(directory, 'node'),
        directTransfer: { udpPortRangeBegin: udpPort, udpPortRangeEnd: udpPort },
        allowedRoots: [directory],
        registrationToken: registration.json<{ token: string }>().token
      },
      terminalManager: manager,
      capabilities: unavailableCapabilities()
    });
    await connector.start();
    const nodes = async () =>
      (await app!.inject({ method: 'GET', url: '/api/nodes', headers: admin })).json<{
        nodes: { id: string; connected: boolean }[];
      }>().nodes;
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
    const ticketResponse = await app.inject({
      method: 'POST',
      url: `/api/terminals/${terminalId}/attach-ticket`,
      headers: admin,
      payload: { nodeId, afterSequence: 0 }
    });
    expect(ticketResponse.statusCode, ticketResponse.body).toBe(201);
    const socket = new WsClient(
      `${origin.replace('http', 'ws')}/api/relay/${encodeURIComponent(nodeId)}`,
      { headers: { cookie: admin.cookie, origin } }
    );
    closeRelay = () => socket.terminate();
    socket.on('error', () => socket.terminate());
    const relay = await testRelayPath(socket);
    closeRelay = relay.close;
    const grant = ticketResponse.json<{ ticket: string }>().ticket;
    const stream = await relay.openStream({ kind: 'terminal', grant }, AbortSignal.timeout(10_000));
    if (!stream) throw new Error('NODE_RELAY_UNAVAILABLE');
    const records = readTerminalRecords(stream);
    const attachment = await records.next();
    expect(decodeTerminalMessage(attachment.value)).toMatchObject({ type: 'attach', terminalId });
    await expect(
      relay.openStream({ kind: 'terminal', grant }, AbortSignal.timeout(10_000))
    ).rejects.toThrow('RESOURCE_DENIED');
    const drained = (async () => {
      while (!(await records.next()).done) {
        // Drain terminal output while the journey runs.
      }
    })().catch(() => {});

    const product = process.cwd();
    const entry = (file: string) => pathToFileURL(join(product, 'marctl', file)).href;
    const resultPath = join(directory, 'result.json');
    const source = join(directory, "source 'quoted' 字节.bin");
    const remote = join(directory, "remote 'quoted' 字节.bin");
    const copied = join(directory, 'copied.bin');
    const copiedWithoutPool = join(directory, 'copied-without-pool.bin');
    const starts = join(directory, 'starts.txt');
    const slowStdin = join(directory, 'slow-stdin.cjs');
    const bytes = Buffer.from(Array.from({ length: 384 * 1024 + 7 }, (_, index) => index % 256));
    await writeFile(source, bytes);
    await writeFile(
      slowStdin,
      `let size = 0;
setTimeout(() => {
  process.stdin.on('data', (chunk) => {
    if (chunk.some((byte) => byte !== 0xa5)) process.exit(2);
    size += chunk.length;
  });
  process.stdin.on('end', () => process.stdout.write(String(size)));
}, 150);`
    );
    const script = join(directory, 'journey.mjs');
    await writeFile(
      script,
      `
      import { execFile } from 'node:child_process';
      import { once } from 'node:events';
      import { promisify } from 'node:util';
      import { readFile, writeFile } from 'node:fs/promises';
      import { setTimeout as sleep } from 'node:timers/promises';
      import { createRequire } from 'node:module';
      import { MarctlClient } from ${JSON.stringify(entry('src/client.mjs'))};
      import { decodeTerminalMessage } from ${JSON.stringify(entry('node_modules/@myagentroam/protocol/dist/byte-frame.js'))};
      import { openDirectConnection } from ${JSON.stringify(entry('src/direct.mjs'))};
      import { connectTerminalBrokerRelay } from ${JSON.stringify(entry('src/terminal-broker-relay.mjs'))};
      const WebSocket = createRequire(${JSON.stringify(entry('package.json'))})('ws');
      const exec = promisify(execFile);
      const result = {};
      try {
        const node = ${JSON.stringify(nodeId)};
        const cli = ${JSON.stringify(join(product, 'marctl/bin/marssh.mjs'))};
        const scp = ${JSON.stringify(join(product, 'marctl/bin/marscp.mjs'))};
        const run = (bin, args) => exec(process.execPath, [bin, ...args], { timeout: 30000, maxBuffer: 1024 * 1024 });
        result.cli = (await run(cli, [node, ${JSON.stringify(`printf x >> ${JSON.stringify(starts)}; printf cli-ok`)}])).stdout;
        const deadline = Date.now() + 15000;
        while (!(await readFile(${JSON.stringify(connectedPath)}, 'utf8').catch(() => ''))) {
          if (Date.now() >= deadline) throw new Error('POOLED_DIRECT_NOT_READY');
          await sleep(30);
        }
        result.warm = (await run(cli, [node, 'printf warm'])).stdout;
        const largeInput = run(cli, [node, ${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(slowStdin)}`)}]);
        largeInput.child.stdin.on('error', () => {});
        largeInput.child.stdin.end(Buffer.alloc(6 * 1024 * 1024, 0xa5));
        result.slowStdin = (await largeInput).stdout;
        await run(scp, [${JSON.stringify(source)}, node + '://' + ${JSON.stringify(remote)}]);
        await run(scp, [node + '://' + ${JSON.stringify(remote)}, ${JSON.stringify(copied)}]);
        await run(scp, ['--no-reuse', node + '://' + ${JSON.stringify(remote)}, ${JSON.stringify(copiedWithoutPool)}]);
        result.afterPrivate = (await run(cli, [node, 'printf after-private'])).stdout;
        const single = new MarctlClient({ serverUrl: process.env.MAR_CTL_SERVER_URL, key: process.env.MAR_CTL_USER_TOKEN });
        const abandoned = await single.createTerminal({ nodeId: node, rows: 24, cols: 80, command: 'printf "single-ready:%s;" "$$"; exec sleep 300' });
        const ticket = await single.createAttachTicket({ nodeId: node, terminalId: abandoned });
        const wire = single.openTerminalEndpoint({ nodeId: node, terminalId: abandoned, ticket });
        try {
          result.abandonedPid = await new Promise((resolve, reject) => {
            let printed = '';
            wire.once('error', reject);
            wire.once('close', () => reject(new Error('SINGLE_TERMINAL_LOST')));
            wire.on('message', (raw) => {
              try {
                const frame = decodeTerminalMessage(raw);
                if (frame.type === 'error' || frame.type === 'exit') throw new Error('SINGLE_TERMINAL_FAILED');
                if (frame.type === 'output') printed += Buffer.from(frame.data).toString();
                const ready = /^single-ready:(\\d+);$/.exec(printed);
                if (ready) resolve(Number(ready[1]));
              } catch (error) { reject(error); }
            });
          });
        } finally {
          if (wire.readyState !== WebSocket.CLOSED) {
            const closed = once(wire, 'close');
            wire.close();
            await closed;
          }
        }
        result.abandoned = abandoned;
        const client = new MarctlClient({ serverUrl: process.env.MAR_CTL_SERVER_URL, key: process.env.MAR_CTL_USER_TOKEN, reuseTerminalConnections: true });
        try { await client.openComputer(node); }
        catch (error) { result.computer = error.code; }
        const relayPath = await connectTerminalBrokerRelay({ serverUrl: process.env.MAR_CTL_SERVER_URL, key: process.env.MAR_CTL_USER_TOKEN, nodeId: node, client }, AbortSignal.timeout(20000));
        const runOnPath = async (path, mode) => {
          const terminalId = await client.createTerminal({ nodeId: node, rows: 24, cols: 80, command: 'printf ' + mode });
          try {
            let output = '';
            let code;
            let end;
            const finished = new Promise(resolve => { end = resolve; });
            const stream = await path.openStream({ terminalId, onEnd: end, onFrame(raw) {
              const frame = decodeTerminalMessage(raw);
              if (frame.type === 'output') output += Buffer.from(frame.data).toString();
              if (frame.type === 'exit') code = frame.exitCode;
              if (frame.type === 'error') throw new Error(frame.code);
            } }, AbortSignal.timeout(20000));
            if (!stream) throw new Error('TERMINAL_STREAM_REQUIRED');
            stream.activate();
            await finished;
            result[mode] = { code, output };
          } finally { await client.deleteTerminal({ nodeId: node, terminalId }); }
        };
        try {
          await runOnPath(relayPath, 'relay');
          await runOnPath(relayPath, 'relayAgain');
        } finally { relayPath.close(); }
        const lifetime = AbortSignal.timeout(20000);
        const connection = await openDirectConnection({ client, WebSocketClass: WebSocket, nodeId: node, signal: lifetime });
        try { await runOnPath(await connection.openStreams(lifetime), 'direct'); }
        finally { connection.close(); }
      } catch (error) { result.error = String(error?.message ?? error); }
      await writeFile(${JSON.stringify(resultPath)}, JSON.stringify(result));
    `
    );
    await stream.write(
      writeTerminalRecord(
        encodeTerminalMessage({
          type: 'input',
          terminalId,
          data: new TextEncoder().encode(
            `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}\n`
          )
        })
      )
    );
    await expect
      .poll(
        async () =>
          readFile(resultPath, 'utf8').then(
            () => true,
            () => false
          ),
        { timeout: 90000 }
      )
      .toBe(true);
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    expect(result).toEqual({
      cli: 'cli-ok',
      warm: 'warm',
      slowStdin: String(6 * 1024 * 1024),
      afterPrivate: 'after-private',
      abandoned: expect.any(String),
      abandonedPid: expect.any(Number),
      computer: 'COMPUTER_REMOTE_DISABLED',
      relay: { code: 0, output: 'relay' },
      relayAgain: { code: 0, output: 'relayAgain' },
      direct: { code: 0, output: 'direct' }
    });
    await expect.poll(() => manager.get(result.abandoned).state).toBe('CLOSED');
    await expect
      .poll(() => {
        try {
          process.kill(result.abandonedPid, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
          throw error;
        }
      })
      .toBe(false);
    expect(muxConnections).toBe(4);
    expect(observedCliRelayCarriers).toBe(4);
    expect(privateRelayStreams).toBeGreaterThanOrEqual(2); // Two forced Relay streams on one carrier.
    expect(privateRelayStreams).toBeLessThanOrEqual(4);
    await expect.poll(() => closedPrivateCarriers).toBe(3);
    expect(cliRelayStreams).toBeLessThanOrEqual(1); // Only the initial cold command may use Relay.
    expect(directConnections[0]?.transports).toBe(1);
    expect(directConnections[0]?.streams.length).toBeGreaterThanOrEqual(4);
    expect(new Set(directConnections[0]?.streams).size).toBe(1);
    expect(await readFile(starts, 'utf8')).toBe('x');
    expect(await readFile(copied)).toEqual(bytes);
    expect(await readFile(copiedWithoutPool)).toEqual(bytes);
    expect(await readFile(remote)).toEqual(bytes);
    stream.close();
    await drained;
  } finally {
    closeRelay?.();
    try {
      await connector?.stop();
    } finally {
      try {
        await manager.shutdown();
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
  }
});

test('A real Terminal shell and foreground job survive Server restart and reattach without replaying input', async () => {
  test.skip(
    process.platform !== 'linux' && process.platform !== 'darwin',
    'This regression exercises the POSIX PTY lifecycle.'
  );
  // The journey includes an isolated MySQL schema bootstrap and two Server startups.
  test.setTimeout(180_000);
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  const target = resolvePlaywrightTestDatabase(`${runId}-terminal-restart-${randomUUID()}`);
  await createPlaywrightTestDatabase(target);
  const directory = await mkdtemp(join(tmpdir(), 'mar-terminal-server-restart-'));
  const statusPath = join(directory, 'status.json');
  const startsPath = join(directory, 'starts.txt');
  let app: Awaited<ReturnType<typeof createServerApp>>['app'] | undefined;
  let connector: NodeConnector | undefined;
  const sockets: TestSocket[] = [];
  let processIds: number[] = [];
  const manager = new TerminalManager({
    platform: process.platform === 'darwin' ? 'darwin' : 'linux',
    cwd: directory,
    profiles: [{ id: 'default', label: 'sh', shell: '/bin/sh', args: [], isDefault: true }]
  });
  const status = async (): Promise<{ pid: number; shellPid: number; tick: number }> =>
    JSON.parse(await readFile(statusPath, 'utf8'));
  const terminateFixtureProcess = (pid: number): void => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
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
    app = (await createServerApp(serverOptions)).app;
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
    const registeredWorkspace = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: admin,
      payload: { nodeId, path: directory }
    });
    expect(registeredWorkspace.statusCode, registeredWorkspace.body).toBe(201);
    const workspaceId = registeredWorkspace.json<{ workspace: { id: string } }>().workspace.id;
    const openedTerminal = await app.inject({
      method: 'POST',
      url: '/api/terminals',
      headers: admin,
      payload: { nodeId, workspaceId }
    });
    expect(openedTerminal.statusCode, openedTerminal.body).toBe(201);
    const terminalId = openedTerminal.json<{ terminal: { id: string } }>().terminal.id;
    const issue = async (
      options: { afterSequence?: number; readonly?: boolean; workspaceId?: string | undefined } = {}
    ) => {
      const response = await app!.inject({
        method: 'POST',
        url: `/api/terminals/${terminalId}/attach-ticket`,
        headers: admin,
        payload: { nodeId, workspaceId, ...options }
      });
      expect(response.statusCode).toBe(201);
      return response.json<{ ticket: string }>().ticket;
    };
    const dial = async (cookie = admin.cookie) => {
      const socket = new WsClient(
        `${baseUrl.replace('http', 'ws')}/api/relay/${encodeURIComponent(nodeId)}`,
        { headers: { cookie, origin: baseUrl } }
      );
      sockets.push(socket);
      socket.on('error', () => socket.terminate());
      return { socket, relay: await testRelayPath(socket) };
    };
    const open = async (relay: Awaited<ReturnType<typeof testRelayPath>>, ticket: string) => {
      const stream = await relay.openStream(
        { kind: 'terminal', grant: ticket },
        AbortSignal.timeout(10_000)
      );
      if (!stream) throw new Error('NODE_RELAY_UNAVAILABLE');
      return stream;
    };
    const attach = async (relay: Awaited<ReturnType<typeof testRelayPath>>, ticket: string) => {
      const stream = await open(relay, ticket);
      const frames: { type: string; sequence?: number; data?: Uint8Array }[] = [];
      void (async () => {
        for await (const record of readTerminalRecords(stream))
          frames.push(decodeTerminalMessage(record) as (typeof frames)[number]);
      })().catch(() => stream.close());
      await expect.poll(() => frames.some((frame) => frame.type === 'attach')).toBe(true);
      return { frames, stream };
    };
    await expect(dial('invalid-session=fixture')).rejects.toThrow('NODE_RELAY_UNAVAILABLE');
    const rejectedTakeover = await app.inject({
      method: 'POST',
      url: `/api/terminals/${terminalId}/attach-ticket`,
      headers: admin,
      payload: { nodeId, workspaceId, takeover: true }
    });
    expect(rejectedTakeover.statusCode).toBe(400);
    const initial = await dial();
    const ticket = await issue();
    const first = await attach(initial.relay, ticket);
    await expect(open(initial.relay, ticket)).rejects.toMatchObject({ code: 'RESOURCE_DENIED' });
    const wrongScope = await issue({ workspaceId: undefined });
    await expect(open(initial.relay, wrongScope)).rejects.toMatchObject({
      code: 'TERMINAL_WORKSPACE_MISMATCH'
    });
    const conflicting = async () => {
      const stream = await open(initial.relay, await issue());
      return readTerminalRecords(stream).next();
    };
    await expect(conflicting()).rejects.toMatchObject({ code: 'TERMINAL_ATTACH_CONFLICT' });
    const reader = await attach(initial.relay, await issue({ readonly: true }));
    const command = `const fs=require("node:fs");let tick=0;fs.appendFileSync(${JSON.stringify(startsPath)},"start\\n");setInterval(()=>{fs.writeFileSync(${JSON.stringify(statusPath + '.tmp')},JSON.stringify({pid:process.pid,shellPid:process.ppid,tick:++tick}));fs.renameSync(${JSON.stringify(statusPath + '.tmp')},${JSON.stringify(statusPath)});console.log("MAR_TICK "+process.pid+" "+tick)},100)`;
    // This is the only input frame: reconnect must never rerun the command.
    // Keep the interactive shell and its distinct foreground job alive across restart.
    await first.stream.write(
      writeTerminalRecord(
        encodeTerminalMessage({
          type: 'input',
          terminalId,
          data: new TextEncoder().encode(`${JSON.stringify(process.execPath)} -e '${command}'\n`)
        })
      )
    );
    await expect
      .poll(() =>
        first.frames
          .filter((frame) => frame.type === 'output')
          .map((frame) => Buffer.from(frame.data!).toString())
          .join('')
      )
      .toMatch(/MAR_TICK \d+ \d+/u);
    const before = await status();
    await expect.poll(() => reader.frames.some((frame) => frame.type === 'output')).toBe(true);
    processIds = [before.pid, before.shellPid];
    expect(before.shellPid).not.toBe(before.pid);
    expect(process.kill(before.shellPid, 0)).toBe(true);
    await expect
      .poll(() =>
        first.frames
          .filter((frame) => frame.type === 'output')
          .map((frame) => Buffer.from(frame.data!).toString())
          .join('')
      )
      .toContain(`MAR_TICK ${before.pid} `);
    const afterSequence = Math.max(...first.frames.map((frame) => frame.sequence ?? 0));
    const disconnected = closed(initial.socket as unknown as TestSocket);
    await app.shutdown();
    app = undefined;
    await disconnected;
    await expect.poll(async () => (await status()).tick).toBeGreaterThan(before.tick);
    expect((await status()).pid).toBe(before.pid);
    expect((await status()).shellPid).toBe(before.shellPid);
    expect(manager.get(terminalId).state).toBe('RUNNING');

    app = (await createServerApp(serverOptions)).app;
    await app.listen({ host: '127.0.0.1', port: Number(new URL(baseUrl).port) });
    await expect
      .poll(nodes, { timeout: 15_000 })
      .toEqual([expect.objectContaining({ id: nodeId, connected: true })]);
    const listed = await app.inject({
      method: 'GET',
      url: `/api/terminals?nodeId=${nodeId}&workspaceId=${workspaceId}`,
      headers: admin
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ terminals: [{ id: terminalId, state: 'RUNNING' }] });
    const resumed = await attach((await dial()).relay, await issue({ afterSequence }));
    const resumedAt = (await status()).tick;
    expect((await status()).shellPid).toBe(before.shellPid);
    await expect
      .poll(() => {
        const output = resumed.frames
          .filter((frame) => frame.type === 'output')
          .map((frame) => Buffer.from(frame.data!).toString())
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
      .poll(() =>
        processIds.map((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
            return false;
          }
        })
      )
      .toEqual([false, false]);
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
        shellPid: before.shellPid,
        beforeTick: before.tick,
        afterReconnectTick: resumedAt,
        afterSequence,
        inputFrames: 1,
        starts: 1,
        processReleased: true,
        processesReleased: { shell: true, foregroundJob: true },
        platform: process.platform
      }),
      contentType: 'application/json'
    });
  } finally {
    for (const socket of sockets) socket.close();
    try {
      try {
        await connector?.stop();
      } finally {
        // Baseline failures must not leak this fixture's own foreground job or shell.
        for (const pid of processIds) {
          terminateFixtureProcess(pid);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
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

async function adminHeaders(app: Awaited<ReturnType<typeof createServerApp>>['app']): Promise<{
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
  close(): void;
  addEventListener(type: 'error', listener: () => void, options?: { once?: boolean }): void;
  addEventListener(
    type: 'close',
    listener: (event: { readonly code: number; readonly reason: string }) => void,
    options?: { once?: boolean }
  ): void;
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

function cookieFrom(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(';', 1)[0] ?? '';
}
