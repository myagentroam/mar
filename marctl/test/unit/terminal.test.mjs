import { decodeTerminalMessage, encodeTerminalMessage } from '@myagentroam/protocol/byte-frame';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { runTerminalSession } from '../../src/terminal.mjs';
import { TerminalRelaySender } from '../../src/terminal-relay-sender.mjs';

test('waits for the actual socket write before resolving or sending the next frame', async () => {
  const sent = [];
  const callbacks = [];
  const sender = new TerminalRelaySender({
    readyState: 1,
    send(value, callback) {
      sent.push(value);
      callbacks.push(callback);
    }
  });
  let completed = false;
  const first = sender.send(Buffer.from('first')).then(() => {
    completed = true;
  });
  const second = sender.send(Buffer.from('second'));
  first.catch(() => {});
  second.catch(() => {});
  try {
    await Promise.resolve();
    assert.equal(completed, false);
    assert.deepEqual(sent, [Buffer.from('first')]);
    callbacks.shift()();
    await first;
    assert.deepEqual(sent, [Buffer.from('first')]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, [Buffer.from('first'), Buffer.from('second')]);
    callbacks.shift()();
    await second;
  } finally {
    sender.close();
  }
});

test('yields between serial relay writes without a throughput timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent = [];
  const pending = [];
  const sender = new TerminalRelaySender(
    {
      readyState: 1,
      send(value, callback) {
        sent.push(value);
        callback();
      }
    },
    { onPendingChange: (keys) => pending.push([...keys]) }
  );
  const frame = Buffer.alloc(48 * 1024, 0xff);
  const first = sender.send(frame, 'first');
  const second = sender.send(frame, 'second');
  assert.equal(sent.length, 1);
  assert.deepEqual(pending.at(-1), ['second']);
  await Promise.all([first, second]);
  assert.equal(sent.length, 2);
  assert.deepEqual(pending.at(-1), []);
  let sentAtOtherOperation;
  setImmediate(() => {
    sentAtOtherOperation = sent.length;
  });
  for (let index = 0; index < 100; index++) await sender.send(frame);
  assert.ok(sentAtOtherOperation >= 2 && sentAtOtherOperation < 102);
  assert.equal(sent.length, 102);
  sender.close();
});

test('bounds congested relay queues and cancels pending sends on close or detach', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 300 * 1024,
    send(value, callback) {
      sent.push(value);
      callback();
    }
  };
  const sender = new TerminalRelaySender(socket);
  const cancelled = assert.rejects(
    sender.send(Buffer.from('stale'), 'stale'),
    /TERMINAL_ATTACH_INVALID/
  );
  sender.cancel('stale');
  await cancelled;
  const queued = sender.send(Buffer.alloc(2 * 1024 * 1024), 'active');
  await assert.rejects(sender.send(Buffer.from('overflow')), /TERMINAL_RELAY_BUFFER_EXCEEDED/);
  assert.equal(sent.length, 0);
  const closed = assert.rejects(queued, /TERMINAL_CONNECTION_LOST/);
  sender.close();
  await closed;
  socket.bufferedAmount = 0;
  t.mock.timers.tick(60_000);
  assert.equal(sent.length, 0);
  await assert.rejects(sender.send(Buffer.from('late')), /TERMINAL_CONNECTION_LOST/);
});

test('resumes a congested relay and propagates socket send failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 240 * 1024,
    send(value, callback) {
      sent.push(value);
      callback();
    }
  };
  const sender = new TerminalRelaySender(socket);
  const first = sender.send(Buffer.alloc(64 * 1024));
  const second = sender.send(Buffer.alloc(64 * 1024));
  t.mock.timers.tick(1000);
  assert.equal(sent.length, 0);
  socket.bufferedAmount = 0;
  t.mock.timers.tick(20);
  await first;
  assert.equal(sent.length, 1);
  await second;
  assert.equal(sent.length, 2);
  socket.send = () => {
    throw new Error('socket send failed');
  };
  const failure = assert.rejects(sender.send(Buffer.from('failure')), /socket send failed/);
  const tail = assert.rejects(sender.send(Buffer.from('tail')), /socket send failed/);
  await Promise.all([failure, tail]);
  sender.close();
});

class FakeSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;

  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
  }

  send(value, callback) {
    this.sent.push(decodeTerminalMessage(value));
    callback?.();
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
  }
}

class FakeStdin extends EventEmitter {
  constructor() {
    super();
    this.rawModes = [];
    this.paused = false;
  }

  setRawMode(value) {
    this.rawModes.push(value);
  }

  resume() {
    this.paused = false;
  }

  pause() {
    this.paused = true;
  }
}

class FakeStdout extends EventEmitter {
  constructor() {
    super();
    this.rows = 24;
    this.columns = 80;
    this.output = '';
  }

  write(value) {
    this.output += Buffer.from(value).toString();
  }
}

test('handles rejected asynchronous resize and close writes without leaking a terminal', async () => {
  const transport = new EventEmitter();
  const sent = [];
  let deleted = 0;
  transport.send = (raw) => {
    sent.push(raw.type);
    return Promise.reject(new Error('TERMINAL_CONNECTION_LOST'));
  };
  transport.close = () => {};
  await assert.rejects(
    runTerminalSession({
      client: {
        async createTerminal() {
          return 'terminal-1';
        },
        async deleteTerminal() {
          deleted += 1;
        }
      },
      nodeId: 'node-1',
      stdin: new FakeStdin(),
      stdout: new FakeStdout(),
      signal: new AbortController().signal,
      attach: async () => transport
    }),
    /terminal resize|终端尺寸/
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, ['resize', 'close']);
  assert.equal(deleted, 1);
});

test('bounds UTF-8 input frames and preserves terminal lifecycle', async () => {
  const sockets = [];
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const signals = new AbortController();
  const deleted = [];
  const client = {
    async createTerminal(input) {
      assert.deepEqual(input, { nodeId: 'node-1', rows: 24, cols: 80 });
      return 'terminal-1';
    },
    openTerminalEndpoint() {
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => {
        socket.readyState = FakeSocket.OPEN;
        socket.emit('open');
        socket.emit(
          'message',
          encodeTerminalMessage({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 }),
          true
        );
      });
      return socket;
    },
    async deleteTerminal(input) {
      deleted.push(input);
    }
  };

  const session = runTerminalSession({
    client,
    nodeId: 'node-1',
    stdin,
    stdout,
    signal: signals.signal
  });
  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit('data', 'hello');
  stdin.emit('data', '\u0003');
  await new Promise((resolve) => setImmediate(resolve));
  stdout.emit('resize');
  sockets[0].emit(
    'message',
    encodeTerminalMessage({
      type: 'output',
      terminalId: 'terminal-1',
      sequence: 1,
      data: Buffer.from('world')
    }),
    true
  );
  sockets[0].emit(
    'message',
    encodeTerminalMessage({ type: 'exit', terminalId: 'terminal-1', exitCode: 7 }),
    true
  );

  assert.equal(await session, 7);
  assert.equal(stdout.output, 'world');
  assert.deepEqual(sockets[0].sent, [
    { type: 'resize', terminalId: 'terminal-1', rows: 24, cols: 80 },
    { type: 'input', terminalId: 'terminal-1', data: Uint8Array.from(Buffer.from('hello')) },
    { type: 'input', terminalId: 'terminal-1', data: Uint8Array.of(3) },
    { type: 'resize', terminalId: 'terminal-1', rows: 24, cols: 80 },
    { type: 'close', terminalId: 'terminal-1' }
  ]);
  assert.deepEqual(deleted, [{ nodeId: 'node-1', terminalId: 'terminal-1' }]);
  assert.deepEqual(stdin.rawModes, [true, false]);
  assert.equal(stdin.paused, true);
});

test('waits for relay stdin writes while resize and interruption remain responsive', async () => {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const callbacks = [];
  const socket = new FakeSocket();
  const originalSend = socket.send.bind(socket);
  socket.send = (value, callback) => {
    originalSend(value);
    if (decodeTerminalMessage(value).type === 'input') callbacks.push(callback);
    else callback?.();
  };
  const client = {
    async createTerminal() {
      return 'terminal-1';
    },
    openTerminalEndpoint() {
      queueMicrotask(() => {
        socket.readyState = FakeSocket.OPEN;
        socket.emit('open');
        socket.emit(
          'message',
          encodeTerminalMessage({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 }),
          true
        );
      });
      return socket;
    },
    async deleteTerminal() {}
  };
  const signals = new AbortController();
  const session = runTerminalSession({
    client,
    nodeId: 'node-1',
    stdin,
    stdout,
    signal: signals.signal
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    stdin.emit('data', 'x'.repeat(64 * 1024));
    stdout.emit('resize');
    assert.equal(callbacks.length, 1);
    assert.equal(stdin.paused, true);
    assert.equal(socket.sent.at(-1).type, 'resize');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(socket.sent.filter((frame) => frame.type === 'input').length, 1);
    callbacks.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(socket.sent.filter((frame) => frame.type === 'input').length, 2);
    callbacks.shift()();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(stdin.paused, false);
    stdin.emit('data', 'pending');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stdin.paused, true);
    signals.abort('SIGINT');
    assert.equal(await session, 130);
    callbacks.shift()();
    await Promise.resolve();
    assert.equal(stdin.paused, true);
  } finally {
    signals.abort('SIGTERM');
    await session;
  }
});

test('delivers relay output and exit frames emitted in the ATTACHED handoff tick', async () => {
  const socket = new FakeSocket();
  const stdout = new FakeStdout();
  const client = {
    async createTerminal() {
      return 'terminal-1';
    },
    openTerminalEndpoint() {
      queueMicrotask(() => {
        socket.readyState = FakeSocket.OPEN;
        socket.emit('open');
        socket.emit(
          'message',
          encodeTerminalMessage({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 }),
          true
        );
        socket.emit(
          'message',
          encodeTerminalMessage({
            type: 'output',
            terminalId: 'terminal-1',
            sequence: 1,
            data: Buffer.from('relay output\n')
          }),
          true
        );
        socket.emit(
          'message',
          encodeTerminalMessage({ type: 'exit', terminalId: 'terminal-1', exitCode: 19 }),
          true
        );
      });
      return socket;
    },
    async deleteTerminal() {}
  };

  const result = await runTerminalSession({
    client,
    nodeId: 'node-1',
    command: 'printf relay',
    stdin: new EventEmitter(),
    stdout,
    signal: new AbortController().signal
  });

  assert.equal(result, 19);
  assert.equal(stdout.output, 'relay output\n');
});

test('runs one-shot commands without raw stdin and has no post-attach idle timeout', async () => {
  const stdin = new EventEmitter();
  stdin.paused = false;
  stdin.resume = () => {};
  stdin.pause = () => {
    stdin.paused = true;
  };
  const stdout = new FakeStdout();
  const signals = new AbortController();
  const socket = new FakeSocket();
  const deleted = [];
  const client = {
    async createTerminal(input) {
      assert.deepEqual(input, {
        nodeId: 'node-1',
        rows: 24,
        cols: 80,
        command: 'echo hello && date'
      });
      return 'terminal-1';
    },
    openTerminalEndpoint() {
      queueMicrotask(() => {
        socket.readyState = FakeSocket.OPEN;
        socket.emit('open');
        socket.emit(
          'message',
          encodeTerminalMessage({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 }),
          true
        );
      });
      return socket;
    },
    async deleteTerminal(input) {
      deleted.push(input);
    }
  };

  const session = runTerminalSession({
    client,
    nodeId: 'node-1',
    command: 'echo hello && date',
    stdin,
    stdout,
    signal: signals.signal,
    connectionTimeoutMs: 10
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 25));
  let settled = false;
  session.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  stdin.emit('data', 'input');
  socket.emit(
    'message',
    encodeTerminalMessage({
      type: 'output',
      terminalId: 'terminal-1',
      sequence: 1,
      data: Buffer.from('done\n')
    }),
    true
  );
  socket.emit(
    'message',
    encodeTerminalMessage({ type: 'exit', terminalId: 'terminal-1', exitCode: 23 }),
    true
  );

  assert.equal(await session, 23);
  assert.equal(stdout.output, 'done\n');
  assert.deepEqual(socket.sent, [
    { type: 'input', terminalId: 'terminal-1', data: Uint8Array.from(Buffer.from('input')) },
    { type: 'close', terminalId: 'terminal-1' }
  ]);
  assert.deepEqual(deleted, [{ nodeId: 'node-1', terminalId: 'terminal-1' }]);
  assert.equal(stdin.paused, true);
});

test('maps a null remote exit code to a non-success CLI status', async () => {
  const socket = new FakeSocket();
  const client = {
    async createTerminal() {
      return 'terminal-1';
    },
    openTerminalEndpoint() {
      queueMicrotask(() => {
        socket.readyState = FakeSocket.OPEN;
        socket.emit('open');
        socket.emit(
          'message',
          encodeTerminalMessage({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 }),
          true
        );
      });
      return socket;
    },
    async deleteTerminal() {}
  };

  const session = runTerminalSession({
    client,
    nodeId: 'node-1',
    command: 'unknown-status-command',
    stdin: new EventEmitter(),
    stdout: new FakeStdout(),
    signal: new AbortController().signal
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit(
    'message',
    encodeTerminalMessage({ type: 'exit', terminalId: 'terminal-1', exitCode: null }),
    true
  );
  assert.equal(await session, 1);
});

test('preserves a received exit code when terminal cleanup fails', async () => {
  const socket = new FakeSocket();
  const client = {
    async createTerminal() {
      return 'terminal-1';
    },
    openTerminalEndpoint() {
      queueMicrotask(() => {
        socket.readyState = FakeSocket.OPEN;
        socket.emit('open');
        socket.emit(
          'message',
          encodeTerminalMessage({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 }),
          true
        );
      });
      return socket;
    },
    async deleteTerminal() {
      throw new Error('cleanup unavailable');
    }
  };

  const session = runTerminalSession({
    client,
    nodeId: 'node-1',
    command: 'exit 23',
    stdin: new EventEmitter(),
    stdout: new FakeStdout(),
    signal: new AbortController().signal
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit(
    'message',
    encodeTerminalMessage({ type: 'exit', terminalId: 'terminal-1', exitCode: 23 }),
    true
  );
  assert.equal(await session, 23);
});

for (const [signalName, exitCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143]
]) {
  test(`closes the remote command once on ${signalName}`, async () => {
    const stdin = new EventEmitter();
    stdin.resume = () => {};
    stdin.pause = () => {};
    const stdout = new FakeStdout();
    const signals = new AbortController();
    const socket = new FakeSocket();
    const deleted = [];
    const client = {
      async createTerminal() {
        return 'terminal-1';
      },
      openTerminalEndpoint() {
        queueMicrotask(() => {
          socket.readyState = FakeSocket.OPEN;
          socket.emit('open');
          socket.emit(
            'message',
            encodeTerminalMessage({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 }),
            true
          );
        });
        return socket;
      },
      async deleteTerminal(input) {
        deleted.push(input);
      }
    };

    const session = runTerminalSession({
      client,
      nodeId: 'node-1',
      command: 'long-running-command',
      stdin,
      stdout,
      signal: signals.signal
    });
    await new Promise((resolve) => setImmediate(resolve));
    signals.abort(signalName);
    assert.equal(await session, exitCode);
    assert.deepEqual(socket.sent, [{ type: 'close', terminalId: 'terminal-1' }]);
    assert.deepEqual(deleted, [{ nodeId: 'node-1', terminalId: 'terminal-1' }]);
  });
}

test('does not recreate or re-run a command after relay disconnect', async () => {
  const socket = new FakeSocket();
  const signals = new AbortController();
  const deleted = [];
  let createCalls = 0;
  const client = {
    async createTerminal() {
      createCalls += 1;
      return 'terminal-1';
    },
    openTerminalEndpoint() {
      queueMicrotask(() => {
        socket.readyState = FakeSocket.OPEN;
        socket.emit('open');
        socket.emit(
          'message',
          encodeTerminalMessage({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 }),
          true
        );
      });
      return socket;
    },
    async deleteTerminal(input) {
      deleted.push(input);
    }
  };

  const session = runTerminalSession({
    client,
    nodeId: 'node-1',
    command: 'long-running-command',
    stdin: new EventEmitter(),
    stdout: new FakeStdout(),
    signal: signals.signal
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit('close');
  await assert.rejects(session, /terminal connection was lost/);
  assert.equal(createCalls, 1);
  assert.deepEqual(deleted, [{ nodeId: 'node-1', terminalId: 'terminal-1' }]);
});

test('cancellation during terminal creation cleans up the late terminal without attaching', async () => {
  const controller = new AbortController();
  let deleteCalls = 0;
  const result = await runTerminalSession({
    client: {
      async createTerminal() {
        controller.abort('SIGINT');
        return 'terminal-1';
      },
      async deleteTerminal({ terminalId }) {
        assert.equal(terminalId, 'terminal-1');
        deleteCalls += 1;
      }
    },
    nodeId: 'node-1',
    command: 'copy-worker',
    signal: controller.signal,
    attach: async () => assert.fail('cancelled command must not attach')
  });
  assert.equal(result, 130);
  assert.equal(deleteCalls, 1);
});

test('cancellation at relay attachment prevents a late attached callback', async () => {
  const controller = new AbortController();
  const socket = new FakeSocket();
  let attached = false;
  const client = {
    async createTerminal() {
      return 'terminal-1';
    },
    async deleteTerminal() {},
    openTerminalEndpoint() {
      queueMicrotask(() => {
        socket.readyState = 1;
        socket.emit('open');
        socket.emit(
          'message',
          encodeTerminalMessage({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 }),
          true
        );
        controller.abort('SIGINT');
      });
      return socket;
    }
  };
  const result = await runTerminalSession({
    client,
    nodeId: 'node-1',
    signal: controller.signal,
    attached: async () => {
      attached = true;
      return 0;
    }
  });
  assert.equal(result, 130);
  assert.equal(attached, false);
});

test('bounds connection setup without applying a runtime timeout', async () => {
  const socket = new FakeSocket();
  const deleted = [];
  const client = {
    async createTerminal() {
      return 'terminal-1';
    },
    openTerminalEndpoint() {
      return socket;
    },
    async deleteTerminal(input) {
      deleted.push(input);
    }
  };

  await assert.rejects(
    runTerminalSession({
      client,
      nodeId: 'node-1',
      stdin: new EventEmitter(),
      stdout: new FakeStdout(),
      signal: new AbortController().signal,
      connectionTimeoutMs: 5
    }),
    /could not be opened/
  );
  assert.deepEqual(deleted, [{ nodeId: 'node-1', terminalId: 'terminal-1' }]);
});
