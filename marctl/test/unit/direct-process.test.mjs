import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { MarctlClient } from '../../src/client.mjs';
import {
  DirectFallbackError,
  DirectUnsafeError,
  DirectRejectedError
} from '../../src/direct-errors.mjs';
import { openDirectTerminalProcess } from '../../src/direct-process.mjs';

class FakeChild extends EventEmitter {
  connected = true;
  sent = [];
  killed = false;

  send(message, callback) {
    this.sent.push(message);
    callback?.();
    return true;
  }

  kill() {
    this.killed = true;
    this.connected = false;
    this.emit('exit', null, 'SIGKILL');
  }

  receive(message) {
    this.emit('message', message);
  }
}

function fixture(options = {}) {
  const child = new FakeChild();
  let forkOptions;
  const opening = openDirectTerminalProcess({
    connection: { serverUrl: 'https://example.test', key: 'private-key' },
    nodeId: 'node-1',
    terminalId: 'terminal-1',
    manifest: { nodeGeneration: 'generation-1' },
    timeoutMs: 1000,
    ...options,
    forkImpl(file, args, config) {
      forkOptions = { file, args, config };
      return child;
    }
  });
  return {
    child,
    opening,
    get forkOptions() {
      return forkOptions;
    }
  };
}

test('releases a losing direct candidate without waiting for blocked native cleanup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const f = fixture({ signal: controller.signal });
  const rejected = assert.rejects(
    f.opening,
    (error) => error instanceof DirectFallbackError && error.code === 'DIRECT_RACE_CANCELLED'
  );
  controller.abort();
  await rejected;
  assert.ok(f.child.sent.some((message) => message.type === 'abort'));
  assert.equal(f.child.killed, false);
  t.mock.timers.tick(1000);
  assert.equal(f.child.killed, true);
});

test('keeps credentials off child arguments and resumes the shared preparation barrier', async () => {
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({ onPrepared: () => barrier });
  try {
    assert.deepEqual(f.forkOptions.args, []);
    assert.equal(JSON.stringify(f.forkOptions.config).includes('private-key'), false);
    assert.equal(f.child.sent[0].options.connection.key, 'private-key');
    f.child.receive({ type: 'callback', id: 1, event: 'prepared' });
    await Promise.resolve();
    assert.equal(
      f.child.sent.some((message) => message.type === 'callback.result'),
      false
    );
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      f.child.sent.some((message) => message.type === 'callback.result' && message.id === 1)
    );
    f.child.receive({ type: 'failure', name: 'DirectFallbackError', code: 'DIRECT_UNSUPPORTED' });
    await assert.rejects(f.opening, (error) => error.code === 'DIRECT_UNSUPPORTED');
  } finally {
    f.child.kill();
  }
});

test('buffers attachment handoff frames and acknowledges direct writes', async () => {
  const f = fixture();
  f.child.receive({ type: 'attached' });
  f.child.receive({ type: 'frame', frame: '{"type":"output","data":"tail"}' });
  const transport = await f.opening;
  const frames = [];
  transport.on('message', (frame) => frames.push(frame));
  assert.deepEqual(frames, []);
  transport.activate();
  assert.deepEqual(frames, ['{"type":"output","data":"tail"}']);
  let written = false;
  const writing = transport.send('input').then(() => {
    written = true;
  });
  await Promise.resolve();
  assert.equal(written, false);
  const send = f.child.sent.find((message) => message.type === 'send');
  f.child.receive({ type: 'send.result', id: send.id });
  await writing;
  assert.equal(written, true);
  transport.close();
  f.child.kill();
});

test('refuses fallback if the isolated process dies after permission to send OPEN', async () => {
  const f = fixture();
  const rejected = assert.rejects(f.opening, DirectUnsafeError);
  f.child.receive({ type: 'callback', id: 1, event: 'opening' });
  await new Promise((resolve) => setImmediate(resolve));
  f.child.kill();
  await rejected;
});

test('preserves a confirmed pre-OPEN fallback after permission to attempt attachment', async () => {
  const f = fixture();
  const rejected = assert.rejects(
    f.opening,
    (error) => error instanceof DirectFallbackError && error.code === 'TERMINAL_DIRECT_TIMEOUT'
  );
  f.child.receive({ type: 'callback', id: 1, event: 'opening' });
  await new Promise((resolve) => setImmediate(resolve));
  f.child.receive({
    type: 'failure',
    name: 'DirectFallbackError',
    code: 'TERMINAL_DIRECT_TIMEOUT'
  });
  await rejected;
  f.child.kill();
});

test('preserves a deterministic rejection across IPC before and after attachment', async () => {
  const before = fixture();
  const rejected = assert.rejects(
    before.opening,
    (error) => error instanceof DirectRejectedError && error.code === 'TERMINAL_NOT_AUTHORIZED'
  );
  before.child.receive({
    type: 'failure',
    name: 'DirectRejectedError',
    code: 'TERMINAL_NOT_AUTHORIZED'
  });
  await rejected;
  before.child.kill();

  const after = fixture();
  after.child.receive({ type: 'attached' });
  const transport = await after.opening;
  const errors = [];
  transport.on('error', (error) => errors.push(error));
  transport.activate();
  after.child.receive({ type: 'failure', code: 'TERMINAL_CLOSED' });
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof DirectRejectedError);
  assert.equal(errors[0].code, 'TERMINAL_CLOSED');
  after.child.kill();
});

test('fails outstanding writes and the active transport when its process exits', async () => {
  const f = fixture();
  f.child.receive({ type: 'attached' });
  const transport = await f.opening;
  const errors = [];
  transport.on('error', (error) => errors.push(error.message));
  transport.activate();
  const writing = assert.rejects(transport.send('input'), /TERMINAL_CONNECTION_LOST/);
  f.child.kill();
  await writing;
  assert.deepEqual(errors, ['TERMINAL_CONNECTION_LOST']);
});

test('fails setup immediately on IPC disconnect and preserves the OPEN safety boundary', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const opening of [false, true]) {
    const f = fixture();
    let result;
    f.opening.catch((error) => {
      result = error;
    });
    try {
      if (opening) {
        f.child.receive({ type: 'callback', id: 1, event: 'opening' });
        await new Promise((resolve) => setImmediate(resolve));
      }
      f.child.connected = false;
      f.child.emit('disconnect');
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(result instanceof (opening ? DirectUnsafeError : DirectFallbackError));
      assert.equal(f.child.killed, false);
      t.mock.timers.tick(1000);
      assert.equal(f.child.killed, true);
    } finally {
      f.child.kill();
    }
  }
});

test('fails active writes immediately on IPC disconnect and reaps the disconnected process', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.child.receive({ type: 'attached' });
  const transport = await f.opening;
  const errors = [];
  transport.on('error', (error) => errors.push(error.message));
  transport.activate();
  const writing = assert.rejects(transport.send('input'), /TERMINAL_CONNECTION_LOST/);
  try {
    f.child.connected = false;
    f.child.emit('disconnect');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(errors, ['TERMINAL_CONNECTION_LOST']);
    await writing;
    t.mock.timers.tick(1000);
    assert.equal(f.child.killed, true);
  } finally {
    transport.close();
    f.child.kill();
    await writing;
  }
});

test('preserves binary frame rejection metadata and the original terminal failure code', async () => {
  const f = fixture();
  f.child.receive({ type: 'attached' });
  f.child.receive({ type: 'frame', frame: 'not-a-text-frame', isBinary: true });
  const transport = await f.opening;
  const frames = [];
  const errors = [];
  transport.on('message', (frame, isBinary) => frames.push({ frame, isBinary }));
  transport.on('error', (error) => errors.push(error.message));
  transport.activate();
  assert.deepEqual(frames, [{ frame: 'not-a-text-frame', isBinary: true }]);
  f.child.receive({ type: 'failure', code: 'TERMINAL_REPLAY_GAP' });
  assert.deepEqual(errors, ['TERMINAL_REPLAY_GAP']);
  f.child.kill();
});

test('bounds IPC writes and closes a connection that exceeds its buffer', async () => {
  const f = fixture();
  f.child.receive({ type: 'attached' });
  const transport = await f.opening;
  try {
    const writing = assert.rejects(
      transport.send('x'.repeat(2 * 1024 * 1024)),
      /TERMINAL_CONNECTION_LOST/
    );
    await writing;
    assert.equal(f.child.killed, false);
  } finally {
    transport.close();
    f.child.kill();
  }
});

test('rejects failed native writes without retaining their acknowledgement slots', async () => {
  const f = fixture();
  f.child.receive({ type: 'attached' });
  const transport = await f.opening;
  try {
    const writing = assert.rejects(transport.send('input'), /TERMINAL_INPUT_FAILED/);
    const send = f.child.sent.find((message) => message.type === 'send');
    f.child.receive({ type: 'send.result', id: send.id, code: 'TERMINAL_INPUT_FAILED' });
    await writing;
    const next = transport.send('next');
    const nextSend = f.child.sent.filter((message) => message.type === 'send').at(-1);
    f.child.receive({ type: 'send.result', id: nextSend.id });
    await next;
  } finally {
    transport.close();
    f.child.kill();
  }
});

test(
  'keeps the parent responsive and reaps a process stuck in synchronous cleanup',
  { timeout: 5000 },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marctl-direct-cleanup-'));
    const entry = path.join(directory, 'blocking.mjs');
    await writeFile(
      entry,
      `
    process.on('message', (message) => {
      if (message.type === 'start') process.send({ type: 'callback', id: 1, event: 'prepared' });
      if (message.type === 'abort') {
        process.send({ type: 'blocking' }, () => {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
        });
      }
    });
  `
    );
    const controller = new AbortController();
    let child;
    let blocked;
    let exited;
    try {
      const opening = openDirectTerminalProcess({
        connection: { serverUrl: 'https://example.test', key: 'key' },
        nodeId: 'node-1',
        terminalId: 'terminal-1',
        signal: controller.signal,
        onPrepared: () => controller.abort(),
        forkImpl(_entry, args, config) {
          child = fork(entry, args, config);
          blocked = new Promise((resolve) =>
            child.on('message', (message) => {
              if (message.type === 'blocking') resolve();
            })
          );
          exited = new Promise((resolve) => child.once('exit', resolve));
          return child;
        }
      });
      await assert.rejects(opening, DirectFallbackError);
      await blocked;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(child.exitCode, null);
      await exited;
      assert.equal(child.signalCode, 'SIGKILL');
    } finally {
      child?.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'uses the isolated native runtime and cancels without ever authorizing a writer',
  { timeout: 10000 },
  async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((resolve) => server.once('listening', resolve));
    const messages = [];
    server.on('connection', (socket, request) => {
      assert.equal(request.headers.authorization, 'Bearer fixture-key');
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        messages.push(message.type);
        if (message.type === 'resume')
          socket.send(
            JSON.stringify({ type: 'workbench.ready', workbenchConnectionId: 'workbench-1' })
          );
        if (message.type === 'direct.prepare')
          socket.send(
            JSON.stringify({
              type: 'direct.prepared',
              requestId: message.requestId,
              directSessionId: 'transport-1',
              purpose: 'TRANSPORT'
            })
          );
        if (message.type === 'direct.cancel')
          socket.send(
            JSON.stringify({
              type: 'direct.closed',
              directSessionId: message.directSessionId
            })
          );
      });
    });
    const client = new MarctlClient({
      serverUrl: `http://127.0.0.1:${server.address().port}`,
      key: 'fixture-key'
    });
    const controller = new AbortController();
    try {
      await assert.rejects(
        client.openDirectTerminal({
          nodeId: 'node-1',
          terminalId: 'terminal-1',
          manifest: {
            nodeGeneration: 'generation-1',
            terminalDirect: { apiVersion: 1, transport: true }
          },
          signal: controller.signal,
          onPrepared: () => controller.abort()
        }),
        (error) => error.code === 'DIRECT_RACE_CANCELLED'
      );
      assert.ok(messages.includes('direct.prepare'));
      assert.equal(messages.includes('terminal.direct.prepare'), false);
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
  }
);

test(
  'hands off real native frames and keeps another direct connection alive during cleanup',
  { timeout: 10000 },
  async () => {
    const fixture = fork(new URL('../fixtures/direct-peer.mjs', import.meta.url), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: []
    });
    const exited = new Promise((resolve) => fixture.once('exit', resolve));
    const transports = [];
    const port = await new Promise((resolve, reject) => {
      fixture.once('message', (message) => resolve(message.port));
      fixture.once('error', reject);
      fixture.once('exit', () => reject(new Error('Direct peer fixture exited before readiness.')));
    });
    const client = new MarctlClient({
      serverUrl: `http://127.0.0.1:${port}`,
      key: 'fixture-key'
    });
    try {
      const open = async () => {
        const transport = await client.openDirectTerminal({
          nodeId: 'node-1',
          terminalId: 'terminal-1',
          manifest: {
            nodeGeneration: 'generation-1',
            terminalDirect: { apiVersion: 1, transport: true }
          }
        });
        transports.push(transport);
        const frames = [];
        transport.on('message', (raw) => frames.push(JSON.parse(String(raw))));
        const handoff = new Promise((resolve) =>
          transport.on('message', (raw) => {
            if (JSON.parse(String(raw)).data === 'handoff') resolve();
          })
        );
        transport.activate();
        await handoff;
        assert.equal(frames[0].data, 'handoff');
        return transport;
      };
      const first = await open();
      const second = await open();
      first.close();
      const echo = new Promise((resolve) =>
        second.on('message', (raw) => {
          if (JSON.parse(String(raw)).data === 'still-alive') resolve();
        })
      );
      await second.send(
        JSON.stringify({ type: 'input', terminalId: 'terminal-1', data: 'still-alive' })
      );
      await echo;
    } finally {
      for (const transport of transports) transport.close();
      fixture.send({ type: 'stop' });
      const kill = setTimeout(() => fixture.kill('SIGKILL'), 1000);
      await exited;
      clearTimeout(kill);
    }
  }
);
