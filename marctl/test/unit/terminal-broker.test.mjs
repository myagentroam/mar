import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import {
  decodeByteFrame,
  decodeTerminalMux,
  encodeTerminalMessage,
  encodeTerminalMux,
  TERMINAL_MUX
} from '@myagentroam/protocol/byte-frame';
import { startTerminalBroker } from '../../src/terminal-broker.mjs';
import { listenTerminalBroker } from '../../src/terminal-ipc.mjs';
import { TerminalBrokerClient } from '../../src/terminal-broker-client.mjs';

async function fixture(t, { admit = true } = {}) {
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(ws, 'listening');
  const config = {
    serverUrl: `http://127.0.0.1:${ws.address().port}`,
    nodeId: 'node',
    key: randomUUID()
  };
  const opened = [];
  const closed = [];
  let connections = 0;
  ws.on('connection', (socket, request) => {
    assert.equal(request.url, '/api/marctl/terminal-mux?node=node');
    assert.equal(request.headers.authorization, `Bearer ${config.key}`);
    connections++;
    if (admit) socket.send(encodeTerminalMux(TERMINAL_MUX.ready, 0));
    socket.on('message', (data, binary) => {
      assert.equal(binary, true);
      const { type, stream, payload } = decodeTerminalMux(data);
      if (type === TERMINAL_MUX.close) {
        closed.push(stream);
        return;
      }
      if (type === TERMINAL_MUX.open) {
        const { metadata } = decodeByteFrame(payload);
        opened.push({ stream, ...metadata });
        socket.send(
          encodeTerminalMux(
            TERMINAL_MUX.data,
            stream,
            encodeTerminalMessage({ type: 'attach', terminalId: metadata.ticket })
          )
        );
      } else socket.send(encodeTerminalMux(TERMINAL_MUX.data, stream, payload));
    });
  });
  t.after(async () => {
    for (const client of ws.clients) client.terminate();
    await new Promise((resolve) => ws.close(resolve));
  });
  return { ws, config, opened, closed, connections: () => connections };
}

test(
  'separate foreground processes attach through the same on-demand connection',
  { timeout: 12_000 },
  async (t) => {
    const f = await fixture(t);
    const entry = new URL('../../src/terminal-broker-client.mjs', import.meta.url).href;
    const run = (ticket) =>
      promisify(execFile)(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
    import { once } from 'node:events';
    import { TerminalBrokerClient } from ${JSON.stringify(entry)};
    const options = JSON.parse(process.env.TEST_BROKER_CONFIG);
    const endpoint = new TerminalBrokerClient(options, { terminalId: process.argv[1], ticket: process.argv[1] }, () => { throw Error('unexpected single relay'); });
    const [message] = await Promise.race([once(endpoint, 'message'), once(endpoint, 'close').then(() => { throw Error('disconnected'); })]);
    process.stdout.write(message);
    endpoint.close();
  `,
          ticket
        ],
        {
          timeout: 8_000,
          encoding: 'buffer',
          env: { ...process.env, TEST_BROKER_CONFIG: JSON.stringify(f.config) }
        }
      );
    const [ssh, computer] = await Promise.all([run('ssh'), run('computer')]);
    assert.equal(decodeByteFrame(ssh.stdout).metadata.terminalId, 'ssh');
    assert.equal(decodeByteFrame(computer.stdout).metadata.terminalId, 'computer');
    assert.equal(decodeByteFrame((await run('scp')).stdout).metadata.terminalId, 'scp');
    assert.equal(f.connections(), 1);
    assert.deepEqual(
      f.opened.map(({ stream }) => stream),
      [1, 2, 3]
    );
    assert.deepEqual(f.opened.map(({ ticket }) => ticket).sort(), ['computer', 'scp', 'ssh']);
  }
);

test(
  'an authenticated attachment waiting for admission prevents an idle shutdown',
  { timeout: 6_000 },
  async (t) => {
    const f = await fixture(t, { admit: false });
    const broker = await startTerminalBroker(f.config, { idleMs: 200 });
    t.after(() => broker.close());
    const accepted = once(f.ws, 'connection');
    const endpoint = new TerminalBrokerClient(
      f.config,
      { terminalId: 'pending', ticket: 'pending' },
      () => {
        throw Error('unexpected single relay');
      }
    );
    const attached = once(endpoint, 'message');
    const [wire] = await accepted;
    await delay(280);
    assert.equal(wire.readyState, wire.OPEN);
    assert.deepEqual(f.opened, []);
    wire.send(encodeTerminalMux(TERMINAL_MUX.ready, 0));
    assert.equal(decodeByteFrame((await attached)[0]).metadata.terminalId, 'pending');
    endpoint.close();
  }
);

test(
  'an unavailable pooled handshake falls back before OPEN but a dispatched stream is not replayed',
  { timeout: 8_000 },
  async (t) => {
    const f = await fixture(t);
    const { port } = f.ws.address();
    const broker = await startTerminalBroker(f.config);
    t.after(() => broker.close());
    const single = new EventEmitter();
    single.close = () => single.emit('close');
    let fallbackCalls = 0;
    const openSingle = () => {
      fallbackCalls++;
      queueMicrotask(() => single.emit('open'));
      return single;
    };
    const connect = (ticket) =>
      new TerminalBrokerClient(f.config, { terminalId: ticket, ticket }, openSingle);
    const dispatched = connect('dispatched');
    await once(dispatched, 'message');
    const lost = once(dispatched, 'close');
    for (const socket of f.ws.clients) socket.terminate();
    await lost;
    assert.equal(fallbackCalls, 0);
    assert.equal(f.opened.length, 1);

    // An HTTP upgrade alone is not admission: the Server can still refuse the pool.
    await new Promise((resolve) => f.ws.close(resolve));
    const rejected = new WebSocketServer({ host: '127.0.0.1', port });
    await once(rejected, 'listening');
    t.after(() => new Promise((resolve) => rejected.close(resolve)));
    const upgrading = once(rejected, 'connection');
    const beforeOpen = connect('not-dispatched');
    const fallback = once(beforeOpen, 'open');
    const [unadmitted] = await upgrading;
    let sentBeforeAdmission = 0;
    unadmitted.on('message', () => sentBeforeAdmission++);
    // Let the independent IPC handshake finish if the broker incorrectly relies on upgrade alone.
    await delay(100);
    unadmitted.close(4008, 'TERMINAL_RELAY_LIMIT_REACHED');
    await fallback;
    assert.equal(sentBeforeAdmission, 0);
    assert.equal(fallbackCalls, 1);
    beforeOpen.close();
  }
);

test(
  'keeps active streams past the idle deadline and expires after the last closes',
  { timeout: 6_000 },
  async (t) => {
    const f = await fixture(t);
    const broker = await startTerminalBroker(f.config, { idleMs: 150 });
    t.after(() => broker.close());
    const open = (ticket) =>
      new TerminalBrokerClient(f.config, { terminalId: ticket, ticket }, () => {
        throw Error('unexpected single relay');
      });
    const first = open('first');
    const second = open('second');
    await Promise.all([once(first, 'message'), once(second, 'message')]);
    const [wire] = f.ws.clients;
    const end = once(wire, 'close');
    first.close();
    await delay(220);
    assert.equal(f.connections(), 1);
    assert.equal(second.readyState, 1);
    assert.equal(f.closed.length, 1);
    const echo = once(second, 'message');
    const payload = encodeTerminalMessage({
      type: 'input',
      terminalId: 'second',
      data: Uint8Array.of(0, 255)
    });
    second.send(payload);
    assert.deepEqual((await echo)[0], Buffer.from(payload));
    second.close();
    await end;
    assert.equal(f.closed.length, 2);
  }
);

test(
  'reuses a single warm Direct peer for different operations without moving the active relay stream',
  { timeout: 6000 },
  async (t) => {
    const f = await fixture(t);
    let ready;
    const connected = new Promise((resolve) => {
      ready = resolve;
    });
    const attached = [];
    const closed = [];
    let directSetups = 0;
    let directCloses = 0;
    let lost = false;
    const replacement = Promise.withResolvers();
    const broker = await startTerminalBroker(f.config, {
      openDirect: () => {
        directSetups++;
        return directSetups === 1 ? connected : replacement.promise;
      }
    });
    t.after(() => broker.close());
    const open = (id, computer = false) =>
      new TerminalBrokerClient(f.config, { terminalId: id, ticket: id, computer });
    const relay = open('cold-relay');
    await once(relay, 'message');
    const direct = {
      get closed() {
        return lost;
      },
      attach: async ({ terminalId, computer }) => {
        attached.push([terminalId, computer]);
        return Object.assign(new EventEmitter(), {
          sendEncoded(raw) {
            this.emit('message', raw);
          },
          activate() {},
          close() {
            closed.push(terminalId);
          }
        });
      },
      close: () => directCloses++
    };
    ready(direct);
    const directSsh = open('ssh');
    await once(directSsh, 'message');
    directSsh.close();
    const computer = open('desktop', true);
    const scp = open('copy');
    await Promise.all([once(computer, 'message'), once(scp, 'message')]);
    assert.deepEqual(attached.sort(), [
      ['copy', false],
      ['desktop', true],
      ['ssh', false]
    ]);
    assert.deepEqual(closed, ['ssh']);
    assert.deepEqual(
      f.opened.map(({ ticket }) => ticket),
      ['cold-relay']
    );
    assert.equal(relay.readyState, 1);
    assert.equal(f.connections(), 1);
    assert.equal(directSetups, 1);
    assert.equal(directCloses, 0);
    lost = true;
    const recovering = open('while-recovering');
    await once(recovering, 'message');
    assert.equal(directSetups, 2);
    assert.equal(relay.readyState, 1);
    assert.deepEqual(
      f.opened.map(({ ticket }) => ticket),
      ['cold-relay', 'while-recovering']
    );
    replacement.resolve({ attach: direct.attach, close: direct.close });
    const recovered = open('recovered');
    await once(recovered, 'message');
    assert.deepEqual(attached.at(-1), ['recovered', false]);
    assert.equal(directSetups, 2);
    assert.equal(f.connections(), 1);
    broker.close();
    assert.equal(directCloses, 1);
  }
);

test(
  'reclaims an abandoned filesystem IPC socket but leaves live listeners and ordinary files alone',
  { skip: process.platform === 'win32', timeout: 6000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-ipc-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const address = join(directory, 'broker.sock');
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { createServer } from 'node:net'; createServer().listen(process.argv[1], () => console.log('ready'));",
        address
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    try {
      await once(child.stdout, 'data');
    } finally {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    assert.equal((await lstat(address)).isSocket(), true);
    const f = await fixture(t);
    const broker = await startTerminalBroker(f.config, { address });
    t.after(() => broker.close());
    const active = (await lstat(address)).ino;
    await assert.rejects(listenTerminalBroker(createServer(), address), { code: 'EADDRINUSE' });
    assert.equal((await lstat(address)).ino, active);
    const endpoint = new TerminalBrokerClient(
      f.config,
      { terminalId: 'ssh', ticket: 'ssh' },
      undefined,
      { address }
    );
    assert.equal(decodeByteFrame((await once(endpoint, 'message'))[0]).metadata.terminalId, 'ssh');
    endpoint.close();
    const file = join(directory, 'regular.sock');
    await writeFile(file, 'untouched');
    await assert.rejects(listenTerminalBroker(createServer(), file), { code: 'EADDRINUSE' });
    assert.equal((await lstat(file)).isFile(), true);
  }
);
